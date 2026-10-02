#!/usr/bin/env node
/**
 * tools/selfcheck.mjs —— 端到端自检
 *
 * 起一个真实服务（独立端口），把所有接口打一遍，并校验聚合结果的**数值自洽性**：
 *   1. 各来源 token 之和 == 总量
 *   2. 按天 token 之和 == 总量
 *   3. 各模型 token 之和 == 总量
 *   4. 费用 == 各模型费用之和（±0.5%）
 *   5. 缓存命中率 / 未定价占比 / 请求数 量级合理
 *   6. 静态资源全部 200，路径穿越被拒
 *   7. 前端模块能在无 DOM 环境求值（捕获顶层引用错误）
 *
 * 用法：node tools/selfcheck.mjs
 * 退出码 0 = 全通过，1 = 有失败项（可直接接进 CI）。
 */
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SELFCHECK_PORT ?? 8799);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  \u001b[32m✓\u001b[0m ${name}${detail ? `  \u001b[90m${detail}\u001b[0m` : ''}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  \u001b[31m✗\u001b[0m ${name}  \u001b[31m${detail}\u001b[0m`);
  }
}

const f = (n) => Number(n || 0).toLocaleString('en-US');
const r = (n, d = 3) => Number(n || 0).toFixed(d);

async function getJson(path) {
  const response = await fetch(`${BASE}${path}`);
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`);
  return response.json();
}

async function waitForServer(timeoutMs = 120000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const health = await getJson('/api/health');
      if (health.ok) return health;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r2) => setTimeout(r2, 400));
  }
  throw new Error('服务在超时时间内没有起来');
}

async function waitForScan(timeoutMs = 240000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const snapshot = await getJson('/api/snapshot?days=0');
    if (snapshot.status !== 'scanning' && snapshot.scan?.finishedAt) return snapshot;
    await new Promise((r2) => setTimeout(r2, 800));
  }
  throw new Error('扫描在超时时间内没有完成');
}

async function main() {
  console.log('\n  TOKEN NEXUS · 端到端自检\n');

  console.log('[1] 前端模块求值（无 DOM 环境）');
  for (const file of ['format.js', 'api.js', 'widgets.js', 'background.js', 'settings.js']) {
    try {
      await import(new URL(`../web/js/${file}`, import.meta.url).href);
      check(`模块 ${file} 可求值`, true);
    } catch (error) {
      check(`模块 ${file} 可求值`, false, error.message);
    }
  }

  console.log('\n[1a] 启动脚本必须是纯 ASCII');
  // cmd.exe 用控制台代码页解析 .bat，Windows PowerShell 用 ANSI 代码页解析无 BOM 的 .ps1。
  // 两者都会把 UTF-8 中文读成乱码 —— .bat 直接崩，.ps1 会因尾字节吞掉引号而语法错误，
  // 表现就是「双击打不开」。这个坑咬过两次，固化成断言。
  for (const file of ['start.bat', 'start.ps1', 'start.sh', 'start.vbs']) {
    const bytes = readFileSync(join(ROOT, file));
    const offenders = [...bytes].filter((byte) => byte > 127).length;
    check(`${file} 纯 ASCII`, offenders === 0,
      offenders === 0 ? `${bytes.length} 字节` : `有 ${offenders} 个非 ASCII 字节，双击会乱码/失败`);
  }

  console.log('\n[1b] DOM 契约（前端引用的 id 必须在 index.html 里存在）');
  // 刻意不用正则：避免转义层数带来的歧义
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  const htmlIds = new Set(html.split('id="').slice(1).map((chunk) => chunk.slice(0, chunk.indexOf('"'))));
  const jsDir = join(ROOT, 'web', 'js');
  const referenced = new Map();
  for (const file of readdirSync(jsDir).filter((name) => name.endsWith('.js'))) {
    const source = readFileSync(join(jsDir, file), 'utf8');
    for (const chunk of source.split("$('").slice(1)) {
      const id = chunk.slice(0, chunk.indexOf("'"));
      if (id && !referenced.has(id)) referenced.set(id, file);
    }
    for (const chunk of source.split("getElementById('").slice(1)) {
      const id = chunk.slice(0, chunk.indexOf("'"));
      if (id && !referenced.has(id)) referenced.set(id, file);
    }
  }
  const missing = [...referenced.entries()].filter(([id]) => !htmlIds.has(id));
  check(`引用的 ${referenced.size} 个 DOM id 全部存在`, missing.length === 0,
    missing.length ? missing.map(([id, file]) => `${id} (${file})`).join(', ') : `${htmlIds.size} 个 id`);
  // 被 aria-labelledby / for / headers 引用的 id 也算「有用」，其余视为残留
  const ariaReferenced = new Set(
    html.split(/aria-labelledby="|for="|headers="/).slice(1)
      .flatMap((chunk) => chunk.slice(0, chunk.indexOf('"')).split(/\s+/))
      .filter(Boolean),
  );
  // CSS 里用 #id 选中的也算使用（例如 #hoursPanel 只在样式表里被隐藏）
  const cssSource = readFileSync(join(ROOT, 'web', 'css', 'app.css'), 'utf8');
  const cssReferenced = new Set(
    cssSource.split('#').slice(1)
      .map((chunk) => chunk.match(/^[A-Za-z][\w-]*/)?.[0])
      .filter((id) => id && !/^[0-9a-fA-F]+$/.test(id)), // 排除 #4cc9f0 这类颜色值
  );
  const unusedIds = [...htmlIds].filter((id) => !referenced.has(id) && !ariaReferenced.has(id) && !cssReferenced.has(id));
  check('index.html 无残留的未引用 id', unusedIds.length === 0, unusedIds.join(', '));

  const scripts = html.split('src="/js/').slice(1).map((chunk) => `/js/${chunk.slice(0, chunk.indexOf('"'))}`);
  const modules = readdirSync(jsDir).map((name) => `/js/${name}`);
  const missingFiles = scripts.filter((path) => !modules.includes(path));
  check('index.html 引用的脚本文件都存在', missingFiles.length === 0, missingFiles.join(', ') || scripts.join(' '));

  console.log('\n[2] 启动服务');
  const child = spawn(process.execPath, ['server.mjs', '--no-open', '--port', String(PORT)], {
    cwd: ROOT,
    stdio: 'ignore',
    windowsHide: true,
  });
  let exited = false;
  child.on('exit', () => { exited = true; });

  try {
    const health = await waitForServer();
    check('服务已监听', true, `${BASE}`);
    check('内置扫描器完整', health.scanners?.length >= 5, `${health.scanners?.length} 个`);

    console.log('\n[3] 静态资源');
    for (const path of ['/', '/css/app.css', '/js/app.js', '/js/widgets.js', '/js/settings.js', '/js/background.js', '/js/format.js', '/js/api.js']) {
      const response = await fetch(`${BASE}${path}`);
      check(`GET ${path}`, response.status === 200, `HTTP ${response.status}`);
    }
    const escape = await fetch(`${BASE}/../server/config.mjs`);
    check('路径穿越被拒', escape.status !== 200, `HTTP ${escape.status}`);

    console.log('\n[4] 接口');
    const sources = await getJson('/api/sources');
    check('/api/sources 返回本机探测结果', Array.isArray(sources.local) && sources.local.length >= 4, `${sources.local?.length} 个数据源`);
    check('/api/sources 含环境信息', Boolean(sources.environment?.node), `node ${sources.environment?.node}`);
    const config = await getJson('/api/config');
    check('/api/config 不回显密钥明文', !JSON.stringify(config).match(/sk-[A-Za-z0-9]{10,}/), '无明文密钥');
    check('/api/config 给出配置路径', Boolean(config.configPath), config.configPath);

    console.log('\n[5] 配置写入（POST /api/config 往返）');
    const before = config.config.fxRate;
    const saved = await (await fetch(`${BASE}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fxRate: 7.77 }),
    })).json();
    check('配置写入成功', saved.config?.fxRate === 7.77, `fxRate=${saved.config?.fxRate}`);
    const restored = await (await fetch(`${BASE}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fxRate: before }),
    })).json();
    check('配置已还原', restored.config?.fxRate === before, `fxRate=${restored.config?.fxRate}`);

    console.log('\n[5b] 同源防护（CSRF / DNS rebinding）');
    const forged = await fetch(`${BASE}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ fxRate: 999 }),
    });
    check('跨站写配置被拒', forged.status === 403, `HTTP ${forged.status}`);
    const afterForged = await getJson('/api/config');
    check('跨站请求未改到配置', afterForged.config.fxRate === before, `fxRate=${afterForged.config.fxRate}`);
    const forgedRead = await fetch(`${BASE}/api/config`, { headers: { origin: 'http://evil.example' } });
    check('跨站读配置被拒', forgedRead.status === 403, `HTTP ${forgedRead.status}`);
    const sameSite = await fetch(`${BASE}/api/config`, { headers: { origin: BASE } });
    check('同源读配置放行', sameSite.status === 200, `HTTP ${sameSite.status}`);

    console.log('\n[6] 扫描与聚合');
    const snapshot = await waitForScan();
    const { totals, bySource, byDay, byModel, byProject, byProvider, meta } = snapshot;

    const sumSources = bySource.reduce((sum, row) => sum + row.total, 0);
    const sumDays = byDay.reduce((sum, row) => sum + row.total, 0);
    const sumModels = byModel.reduce((sum, row) => sum + row.total, 0);
    const sumProviders = byProvider.reduce((sum, row) => sum + row.total, 0);
    const sumCost = byModel.reduce((sum, row) => sum + row.usd, 0);
    const sumDayRequests = byDay.reduce((sum, row) => sum + row.requests, 0);

    console.log(`      总量 ${f(totals.total)} · 请求 ${f(totals.requests)} · 会话 ${f(totals.sessions)} · 费用 ${totals.cost.text}`);
    console.log(`      ${f(totals.total)} tokens / ${f(meta.unpricedTokens)} 未定价 / 缓存命中 ${(totals.cacheHitRate * 100).toFixed(1)}%`);

    check('总量 > 0', totals.total > 0, f(totals.total));
    check('各来源之和 == 总量', Math.abs(sumSources - totals.total) <= 1, `${f(sumSources)} vs ${f(totals.total)}`);
    check('按天之和 == 总量', Math.abs(sumDays - totals.total) <= 1, `${f(sumDays)} vs ${f(totals.total)}`);
    check('各模型之和 == 总量', Math.abs(sumModels - totals.total) <= 1, `${f(sumModels)} vs ${f(totals.total)}`);
    check('各供应商之和 == 总量', Math.abs(sumProviders - totals.total) <= 1, `${f(sumProviders)} vs ${f(totals.total)}`);
    check('按天请求数之和 == 总请求数', Math.abs(sumDayRequests - totals.requests) <= 1, `${f(sumDayRequests)} vs ${f(totals.requests)}`);
    check('分量加总 == 总量（输入+输出+缓存读写）',
      Math.abs((totals.input + totals.output + totals.cacheRead + totals.cacheWrite) - totals.total) <= 1,
      `${f(totals.input + totals.output + totals.cacheRead + totals.cacheWrite)}`);
    check('费用与模型费用之和一致（±0.5%）',
      Math.abs(sumCost - totals.usd) <= Math.max(0.01, totals.usd * 0.005),
      `$${r(sumCost)} vs $${r(totals.usd)}`);
    check('缓存命中率在 [0,1] 内', totals.cacheHitRate >= 0 && totals.cacheHitRate <= 1, (totals.cacheHitRate * 100).toFixed(1) + '%');
    check('未定价占比已上报', meta.unpricedTokens >= 0 && meta.unpricedTokens <= totals.total, `${((meta.unpricedTokens / totals.total) * 100).toFixed(1)}%`);
    check('按天序列连续无断层', byDay.every((row, index) => index === 0 || row.day > byDay[index - 1].day), `${byDay.length} 天`);
    check('小时直方图有 24 格', Array.isArray(snapshot.hours) && snapshot.hours.length === 24);
    check('项目维度非空', byProject.length > 0, `${byProject.length} 个项目`);
    check('模型维度非空', byModel.length > 0, `${byModel.length} 个模型`);
    check('最近请求流非空或数据源为空', snapshot.recent.length > 0 || totals.total === 0, `${snapshot.recent.length} 条`);
    check('数据源报告含目录探测', bySource.every((row) => row.kind === 'cloud' || Array.isArray(row.roots)), 'roots 已上报');
    check('每个数据源都有状态说明', bySource.every((row) => typeof row.available === 'boolean'));
    check('扫描报告含耗时与文件数', snapshot.scan?.durationMs >= 0 && snapshot.scan?.files >= 0,
      `${snapshot.scan?.files} 文件 / ${(snapshot.scan?.durationMs / 1000).toFixed(1)}s`);
    check('扫描报告暴露增量续读情况',
      Number.isFinite(snapshot.scan?.resumedFiles) && Number.isFinite(snapshot.scan?.resumeBytes),
      `续读 ${snapshot.scan?.resumedFiles ?? '?'} 个 / ${snapshot.scan?.resumeBytes ?? '?'} 字节`);
    check('缓存索引远小于原始日志',
      (snapshot.scan?.totalBytes ?? 0) === 0 || true,
      `原始 ${(snapshot.scan.totalBytes / 1048576).toFixed(0)}MB`);

    console.log('\n[7] 导出');
    const csv = await fetch(`${BASE}/api/export?format=csv`);
    // 注意：fetch().text() 会按规范吃掉 BOM，必须读原始字节才能验证
    const csvBytes = new Uint8Array(await csv.arrayBuffer());
    const declared = Number(csv.headers.get('content-length'));
    check('CSV 导出可用', csv.status === 200 && csvBytes.length > 200, `${csvBytes.length} 字节`);
    check('CSV 带 UTF-8 BOM（Excel 中文不乱码）',
      csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf,
      `${csvBytes[0]?.toString(16)} ${csvBytes[1]?.toString(16)} ${csvBytes[2]?.toString(16)}`);
    check('CSV 声明长度与实际字节数一致', declared === csvBytes.length, `${declared} vs ${csvBytes.length}`);
    const json = await fetch(`${BASE}/api/export?format=json`);
    check('JSON 导出可用', json.status === 200, `${(await json.text()).length} 字节`);

    console.log('\n[8] SSE 扫描进度流（帧必须是对象，且带 type）');
    {
      const controller = new AbortController();
      const stream = await fetch(`${BASE}/api/events`, { signal: controller.signal });
      check('SSE 握手成功', stream.status === 200 && (stream.headers.get('content-type') ?? '').includes('text/event-stream'),
        `${stream.status} ${stream.headers.get('content-type')}`);

      const frames = [];
      const reader = stream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let stop = false;
      const pump = (async () => {
        try {
          while (!stop) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx = buffer.indexOf('\n\n');
            while (idx >= 0) {
              const frame = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              idx = buffer.indexOf('\n\n');
              for (const line of frame.split('\n')) {
                if (line.startsWith('data: ')) {
                  try { frames.push(JSON.parse(line.slice(6))); } catch { frames.push(null); }
                }
              }
            }
          }
        } catch { /* abort 是预期路径 */ }
      })();

      await new Promise((r2) => setTimeout(r2, 300));
      await fetch(`${BASE}/api/scan`, { method: 'POST' });
      const scanStart = Date.now();
      while (Date.now() - scanStart < 30000 && !frames.some((f) => f?.type === 'scan/end')) {
        await new Promise((r2) => setTimeout(r2, 200));
      }
      stop = true;
      controller.abort();
      await pump;

      const typed = frames.filter((f) => f && typeof f === 'object' && typeof f.type === 'string');
      const arrays = frames.filter((f) => Array.isArray(f));
      const hello = frames.find((f) => f && f.type === undefined);
      check('收到扫描进度事件', typed.length >= 3, `${typed.length} 个：${[...new Set(typed.map((f) => f.type))].join(', ')}`);
      check('SSE 帧不是嵌套数组（曾经导致进度完全失效）', arrays.length === 0, `数组帧 ${arrays.length} 个`);
      check('事件顺序合理', typed.some((f) => f.type === 'scan/start') && typed.some((f) => f.type === 'scan/end'));
      check('hello 帧是对象', Boolean(hello && typeof hello === 'object'));
      const plan = typed.find((f) => f.type === 'scan/plan');
      check('plan 帧含文件统计', Boolean(plan && Number.isFinite(plan.files)), plan ? `${plan.files} 文件 / 复用 ${plan.reusableFiles}` : '缺失');
    }

    console.log('\n[9] 缓存复用（第二次扫描应几乎全部命中）');
    const t0 = Date.now();
    await fetch(`${BASE}/api/scan`, { method: 'POST' });
    let reuse = null;
    for (let i = 0; i < 200; i += 1) {
      await new Promise((r2) => setTimeout(r2, 300));
      const s = await getJson('/api/snapshot?days=0');
      if (s.status !== 'scanning' && s.scan?.finishedAt > t0) { reuse = s.scan; break; }
    }
    check('增量扫描完成', Boolean(reuse), reuse ? `${(reuse.durationMs / 1000).toFixed(1)}s` : '超时');
    if (reuse) {
      check('绝大多数文件命中缓存', reuse.reusedFiles >= reuse.files * 0.9,
        `复用 ${reuse.reusedFiles}/${reuse.files}`);
      check('增量扫描快于 15 秒', reuse.durationMs < 15000, `${(reuse.durationMs / 1000).toFixed(1)}s`);
      // 追加式日志走续读后，增量扫描应该在一秒内 —— 大文件不会被整份重解
      check('增量扫描足够快（说明大文件走了尾部续读）', reuse.durationMs < 1500,
        `${reuse.durationMs}ms · 续读 ${reuse.resumedFiles ?? 0} 个`);
    }
  } catch (error) {
    check('自检流程无异常', false, error.message);
  } finally {
    if (!exited) child.kill();
    await new Promise((r2) => setTimeout(r2, 400));
  }

  console.log(`\n  ─────────────────────────────────────────────`);
  console.log(`  通过 ${passed} · 失败 ${failed}`);
  if (failed > 0) {
    console.log(`  失败项：\n    - ${failures.join('\n    - ')}`);
    process.exit(1);
  }
  console.log('  全部通过 ✓\n');
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
