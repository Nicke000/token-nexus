#!/usr/bin/env node
/**
 * tools/browser-check.mjs —— 真实无头浏览器验收
 *
 * 静态分析看不出「页面到底渲染成什么样」。这个脚本用 Chrome DevTools Protocol
 * 真开一个浏览器，把控制台报错、未捕获异常、加载失败的资源全抓下来，
 * 再断言关键模块真的渲染出了 DOM 节点，最后**截一张整页图**存到 .verify/。
 *
 * 零依赖：Node 22+ 自带全局 WebSocket，直接和 CDP 通信。
 *
 * 用法：
 *   node tools/browser-check.mjs                 # 自起服务 + 检查 + 截图
 *   node tools/browser-check.mjs --url http://127.0.0.1:8787   # 检查已在跑的服务
 *   node tools/browser-check.mjs --keep          # 保留浏览器窗口数据目录，便于排查
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '.verify');
const PORT = Number(process.env.BROWSER_CHECK_PORT ?? 8799);
const CDP_PORT = Number(process.env.BROWSER_CHECK_CDP_PORT ?? 9333);

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const externalUrl = argOf('--url', null);
const URL_APP = externalUrl ?? `http://127.0.0.1:${PORT}`;
const KEEP = argv.includes('--keep');
const HEADFUL = argv.includes('--headful');

let passed = 0;
const failures = [];
let consoleErrors = [];

const check = (name, ok, detail = '') => {
  if (ok) {
    passed += 1;
    console.log(`  \u001b[32m✓\u001b[0m ${name}${detail ? `  \u001b[90m${detail}\u001b[0m` : ''}`);
  } else {
    failures.push(name);
    console.log(`  \u001b[31m✗\u001b[0m ${name}  \u001b[31m${detail}\u001b[0m`);
  }
};

function parseColor(value) {
  const text = String(value ?? '').trim();
  if (text.startsWith('#')) {
    const hex = text.slice(1);
    if (hex.length === 6) {
      return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
    }
    if (hex.length === 3) return [...hex].map((c) => parseInt(c + c, 16));
  }
  const match = text.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (!match) return [255, 255, 255];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** 相对亮度（WCAG）。用来断言「浅色主题确实是浅的」而不是靠肉眼看。 */
function luminance(color) {
  const [r, g, b] = parseColor(color);
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** 对比度（WCAG），≥ 4.5:1 为正文 AA。 */
function contrast(foreground, background) {
  const a = luminance(foreground);
  const b = luminance(background);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** 两个颜色是否基本一致（容忍 ±6/255，因为浏览器可能做色彩空间转换）。 */
function colorClose(a, b, tolerance = 6) {
  const [r1, g1, b1] = parseColor(a);
  const [r2, g2, b2] = parseColor(b);
  return Math.abs(r1 - r2) <= tolerance && Math.abs(g1 - g2) <= tolerance && Math.abs(b1 - b2) <= tolerance;
}

function findBrowser() {  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean).map((path) => path.replace(/\\\\/g, '\\'));
  return candidates.find((path) => existsSync(path)) ?? null;
}

async function waitForHttp(url, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json().catch(() => ({}));
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`等待 ${url} 超时`);
}

/* ── 极简 CDP 客户端 ─────────────────────────────────────────── */

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve: res, reject: rej } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) rej(new Error(message.error.message));
        else res(message.result);
        return;
      }
      const list = this.handlers.get(message.method);
      if (list) for (const handler of list) handler(message.params);
    });
  }

  static async connect(wsUrl) {
    const socket = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      socket.addEventListener('open', res, { once: true });
      socket.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
    });
    return new Cdp(socket);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error(`${method} 超时`));
        }
      }, 30000);
    });
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }

  close() {
    try { this.socket.close(); } catch { /* 已关闭 */ }
  }
}

/* ── 主流程 ─────────────────────────────────────────────────── */

async function main() {
  console.log('\n  TOKEN NEXUS · 无头浏览器验收\n');

  const browser = findBrowser();
  if (!browser) {
    console.log('  没有找到 Chrome / Edge，跳过浏览器验收（不影响其它检查）');
    process.exit(0);
  }
  console.log(`  浏览器 ${browser.split(/[\\/]/).pop()}\n`);

  let server = null;
  if (!externalUrl) {
    console.log('  启动服务…');
    server = spawn(process.execPath, ['server.mjs', '--no-open', '--port', String(PORT)], {
      cwd: ROOT, stdio: 'ignore', windowsHide: true,
    });
    await waitForHttp(`${URL_APP}/api/health`, 60000);
    // 等首屏扫描完成（否则断言渲染时会撞上「扫描中」）
    const started = Date.now();
    while (Date.now() - started < 180000) {
      const snapshot = await fetch(`${URL_APP}/api/snapshot?days=30`).then((r) => r.json());
      if (snapshot.status !== 'scanning' && snapshot.scan?.finishedAt) break;
      await new Promise((r) => setTimeout(r, 600));
    }
    console.log('  服务就绪\n');
  }

  const profile = join(tmpdir(), `token-nexus-cdp-${Date.now()}`);
  mkdirSync(profile, { recursive: true });

  const child = spawn(browser, [
    ...(HEADFUL ? [] : ['--headless=new']),
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--hide-scrollbars',
    '--window-size=1680,2400',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  let cdp = null;
  try {
    const version = await waitForHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 30000);
    check('浏览器已启动（CDP 可用）', Boolean(version.webSocketDebuggerUrl), version['Browser'] ?? '');

    const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);

    cdp.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error' || params.type === 'warning') {
        const text = (params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ');
        consoleErrors.push(`[console.${params.type}] ${text}`);
      }
    });
    cdp.on('Runtime.exceptionThrown', (params) => {
      const detail = params.exceptionDetails;
      consoleErrors.push(`[uncaught] ${detail.exception?.description ?? detail.text} @ ${detail.url ?? ''}:${detail.lineNumber ?? ''}`);
    });
    cdp.on('Log.entryAdded', (params) => {
      if (params.entry.level === 'error') consoleErrors.push(`[log] ${params.entry.text} ${params.entry.url ?? ''}`);
    });
    cdp.on('Network.loadingFailed', (params) => {
      if (params.errorText !== 'net::ERR_ABORTED') consoleErrors.push(`[network] ${params.errorText} (${params.type})`);
    });

    await Promise.all([
      cdp.send('Runtime.enable'),
      cdp.send('Log.enable'),
      cdp.send('Network.enable'),
      cdp.send('Page.enable'),
    ]);

    const loaded = new Promise((res) => cdp.on('Page.loadEventFired', res));
    await cdp.send('Page.navigate', { url: `${URL_APP}/` });
    await Promise.race([loaded, new Promise((r) => setTimeout(r, 20000))]);

    // 等前端把真实数据渲染出来（而不是等固定时间）
    const waitFor = async (expression, label, timeoutMs = 30000) => {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const { result } = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
        if (result.value) return true;
        await new Promise((r) => setTimeout(r, 250));
      }
      return false;
    };

    // probe() 必须**先**声明：下面「首屏超时」的诊断分支要用它。
    // 曾经把它放在诊断分支之后，于是首屏一旦超时就抛
    // `Cannot access 'probe' before initialization`（TDZ），
    // 真正有用的诊断信息被这个二次异常盖掉，只剩一句看不懂的报错。
    const probe = async (expression) => {
      const { result } = await cdp.send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true,
      });
      return result.value;
    };

    const rendered = await waitFor(
      "document.querySelectorAll('.source').length > 0 && document.querySelectorAll('.odo-col').length > 5",
      'dashboard',
    );
    check('首屏渲染完成（未卡在开机动画）', rendered, rendered ? '' : '超时：.source / .odo-col 没出现');

    if (!rendered) {
      const diag = await probe(`JSON.stringify({
        lastRenderError: window.tokenNexus?.state?.lastRenderError ?? null,
        statusText: document.getElementById('statusText').textContent,
        toast: document.getElementById('toast').textContent,
        snapshotKeys: Object.keys(window.tokenNexus?.state?.snapshot ?? {}),
        totalsKeys: Object.keys(window.tokenNexus?.state?.snapshot?.totals ?? {}),
        hasMeta: Boolean(window.tokenNexus?.state?.snapshot?.meta),
        hasCost: Boolean(window.tokenNexus?.state?.snapshot?.totals?.cost),
      })`);
      console.log(`      \u001b[33m诊断：${diag}\u001b[0m`);
    }


    // 主题是**持久化配置**：上一轮跑到一半中断可能把页面留在浅色，
    // 后面的「数字是白字白辉光」「默认是深色主题」等断言就会连带失败。
    // 先归一成深色，让这批断言有确定的前提（浅色段落自己会显式切换）。
    await probe("document.documentElement.dataset.theme === 'dark' || document.getElementById('themeBtn').click()");
    await new Promise((r) => setTimeout(r, 1200));

    const counts = await probe(`JSON.stringify({
      odoDigits: document.querySelectorAll('.odo-col').length,
      sources: document.querySelectorAll('.source').length,
      metrics: document.querySelectorAll('.metric').length,
      ranks: document.querySelectorAll('.rank__row').length,
      heatCells: document.querySelectorAll('.heat__cell').length,
      heatCellWidth: Math.round(document.querySelector('.heat__cell')?.getBoundingClientRect().width ?? 0),
      feedRows: document.querySelectorAll('.feed__row').length,
      gauges: document.querySelectorAll('.gauge__value').length,
      gaugeWidths: [...document.querySelectorAll('.gauge svg')].map((s) => Math.round(s.getBoundingClientRect().width)),
      gaugeLabels: [...document.querySelectorAll('.gauge__label')].map((n) => n.textContent.trim()),
      donutSize: Math.round(document.querySelector('.donut svg')?.getBoundingClientRect().width ?? 0),
      trendSize: Math.round(document.querySelector('.trend-line')?.getBoundingClientRect().width ?? 0),
      hours: document.querySelectorAll('.hour__bar').length,
      donutSegs: document.querySelectorAll('.donut__seg').length,
      trendPaths: document.querySelectorAll('.trend-line').length,
      termLines: document.querySelectorAll('.terminal__line').length,
      bootHidden: document.getElementById('boot').classList.contains('is-done'),
      totalText: document.getElementById('odoTotal').dataset.value ?? document.getElementById('odoTotal').textContent.trim(),
      statusText: document.getElementById('statusText').textContent.trim(),
      toastText: document.getElementById('toast').textContent.trim(),
      costText: document.getElementById('costValue').textContent.trim(),
      todayCostText: document.getElementById('todayCostValue').textContent.trim(),
      todayText: document.getElementById('todayValue').textContent.trim(),
      todayNote: document.getElementById('todayNote').textContent.trim(),
      trendLen: (document.querySelector('.trend-line')?.getTotalLength?.() ?? 0),
    })`);
    const c = JSON.parse(counts);
    console.log('\n  渲染实测：');
    console.log(`      计数器位数 ${c.odoDigits} · 数据源卡 ${c.sources} · 指标 ${c.metrics} · 排行行 ${c.ranks}`);
    console.log(`      热力格 ${c.heatCells} · 实时流 ${c.feedRows} · 仪表 ${c.gauges} · 小时柱 ${c.hours} · 甜甜圈 ${c.donutSegs}`);
    console.log(`      总 token 显示 "${c.totalText}" · 今日用量 "${c.todayText}" · 总消费 "${c.costText}" · 今日消费 "${c.todayCostText}" · 趋势路径长 ${c.trendLen.toFixed(0)}\n`);

    check('开机动画已结束', c.bootHidden);
    check('巨型计数器已渲染', c.odoDigits >= 8, `${c.odoDigits} 位`);
    check('总量不是 0', /[1-9]/.test(c.totalText), `"${c.totalText}"`);
    check('今日用量已渲染（首页左）', /[0-9]/.test(c.todayText) && c.todayNote.length > 0,
      `"${c.todayText}" · "${c.todayNote}"`);
    check('费用已渲染', c.costText !== '—' && c.costText.length > 1, `"${c.costText}"`);
    check('今日消费已渲染（总消费下方）', c.todayCostText !== '—' && c.todayCostText.length > 1,
      `今日 "${c.todayCostText}"`);
    check('数据源卡片已渲染', c.sources >= 4, `${c.sources} 个`);
    check('指标条已渲染', c.metrics >= 6, `${c.metrics} 项`);
    check('模型/项目排行已渲染', c.ranks >= 10, `${c.ranks} 行`);
    check('热力图已渲染', c.heatCells >= 28, `${c.heatCells} 格`);
    check('热力图格子会按可用宽度放大（30 天只有 5 列时不该缩在角落）',
      c.heatCellWidth > 12, `${c.heatCellWidth}px`);
    check('仪表盘已渲染', c.gauges >= 4, `${c.gauges} 个`);
    // 光有元素不算数 —— 必须量出真实尺寸。曾经 SVG 少了外层包裹，元素在但宽度是 0。
    check('仪表盘有真实尺寸（不是塌成 0 宽）', c.gaugeWidths.length >= 4 && c.gaugeWidths.every((w) => w >= 60),
      `${c.gaugeWidths.join(' / ')} px`);
    check('仪表盘带标签（含输入占比）',
      c.gaugeLabels.length >= 4 && c.gaugeLabels.includes('输入占比'), c.gaugeLabels.join(' / '));
    check('甜甜圈有真实尺寸', c.donutSize >= 120, `${c.donutSize}px`);
    check('24 小时柱已渲染', c.hours === 24, `${c.hours} 根`);
    check('供应商甜甜圈已渲染', c.donutSegs >= 2, `${c.donutSegs} 段`);
    check('趋势折线已绘制且有长度', c.trendLen > 100, `${c.trendLen.toFixed(0)}px`);
    check('最近请求流已渲染', c.feedRows >= 5, `${c.feedRows} 条`);

    // 触发一次增量扫描，验证 SSE 遥测真的在推事件。
    // 先等服务端空闲：1 秒保鲜窗口下后台扫描几乎每秒都在跑，
    // 不等空闲就发请求会被服务端的 "if (!isScanning())" 拦掉，测试变flaky。
    await probe("(() => { const t = window.tokenNexus; return new Promise((r) => { const i = setInterval(() => { if (!t.state.serverBusy) { clearInterval(i); r(true); } }, 80); setTimeout(() => { clearInterval(i); r(false); }, 4000); }); })()");
    const termBefore = await probe("document.querySelectorAll('.terminal__line').length");
    await probe('window.tokenNexus.scan(false)');
    const scanDone = await waitFor(
      "document.querySelectorAll('.terminal__line').length >= 4 && document.getElementById('statusText').textContent.includes('就绪')",
      'scan-events', 60000,
    );
    const termAfter = await probe("document.querySelectorAll('.terminal__line').length");
    const lastTerm = await probe("document.querySelector('.terminal__line:last-child')?.textContent?.trim() ?? ''");
    check('SSE 遥测推送扫描事件到终端', scanDone && termAfter > termBefore,
      `${termBefore} → ${termAfter} 行 · 末行 "${lastTerm.slice(0, 70)}"`);

    console.log('');

    // 动画是否真的在动：比较两次采样
    const first = await probe("document.querySelector('.source__bar i').style.width");
    await new Promise((r) => setTimeout(r, 700));
    const widths = await probe("JSON.stringify([...document.querySelectorAll('.source__bar i')].map(n=>n.style.width))");
    check('数据源占比条已从 0 展开', JSON.parse(widths).some((w) => parseFloat(w) > 0), `${first} → ${widths.slice(0, 60)}`);

    // 交互：切时间范围 / 打开设置
    await probe("document.querySelector('#rangeSeg button[data-days=\"7\"]').click()");
    await new Promise((r) => setTimeout(r, 1200));
    const afterRange = await probe("document.getElementById('heroEyebrow').textContent");
    check('时间范围切换生效', afterRange.includes('7'), `"${afterRange}"`);
    await probe("document.querySelector('#rangeSeg button[data-days=\"30\"]').click()");
    await new Promise((r) => setTimeout(r, 1500));

    console.log('\n[hero] 居中构图与可读性');
    const layout = JSON.parse(await probe(`(() => {
      const box = (sel) => { const n = document.querySelector(sel); return n ? n.getBoundingClientRect() : null; };
      const hero = box('.hero');
      const odo = box('#odoTotal');
      const deck = box('.hero__deck');
      const size = (sel) => { const n = document.querySelector(sel); return n ? parseFloat(getComputedStyle(n).fontSize) : 0; };
      const root = getComputedStyle(document.documentElement);
      const panel = document.querySelector('.panel');
      return JSON.stringify({
        heroCenter: hero.x + hero.width / 2,
        odoCenter: odo.x + odo.width / 2,
        deckCenter: deck.x + deck.width / 2,
        odoWidth: odo.width,
        heroWidth: hero.width,
        totalFontSize: size('.hero__total'),
        metricSub: size('.metric__s'),
        sourceMeta: size('.source__meta'),
        feedRow: size('.feed__row'),
        axisLabel: size('svg .axis-label'),
        sourceValue: size('.source__value'),
        rankName: size('.rank__name b'),
        panelRadius: parseFloat(getComputedStyle(panel).borderTopLeftRadius),
        faint: root.getPropertyValue('--fg-faint').trim(),
        dim: root.getPropertyValue('--fg-dim').trim(),
        bodyReady: document.body.classList.contains('is-ready'),
        sourceAnimation: getComputedStyle(document.querySelector('.source')).animationName,
        heroTextFill: getComputedStyle(document.querySelector('.hero__total')).webkitTextFillColor,
        heroColor: getComputedStyle(document.querySelector('.hero__total')).color,
        heroTextShadow: getComputedStyle(document.querySelector('.hero__total')).textShadow,
        heroFilter: getComputedStyle(document.querySelector('.hero__total')).filter,
        digitColor: getComputedStyle(document.querySelector('.hero__total .odo-strip > span')).color,
        digitBg: getComputedStyle(document.querySelector('.hero__total .odo-strip > span')).backgroundImage,
      });
    })()`));
    console.log(`      英雄区中心 ${layout.heroCenter.toFixed(0)} · 数字中心 ${layout.odoCenter.toFixed(0)} · 底部条中心 ${layout.deckCenter.toFixed(0)}`);
    console.log(`      数字字号 ${layout.totalFontSize}px · 小字 ${layout.metricSub}/${layout.sourceMeta}/${layout.feedRow}/${layout.axisLabel}px · ${layout.faint} / ${layout.dim}`);
    check('巨型数字在英雄区正中', Math.abs(layout.odoCenter - layout.heroCenter) <= 3, `偏移 ${(layout.odoCenter - layout.heroCenter).toFixed(1)}px`);
    check('仪表与费用那一行也居中', Math.abs(layout.deckCenter - layout.heroCenter) <= 3, `偏移 ${(layout.deckCenter - layout.heroCenter).toFixed(1)}px`);
    check('数字足够大（视觉焦点）', layout.totalFontSize >= 90, `${layout.totalFontSize}px`);
    check('小字号不低于 12px 可读下限',
      Math.min(layout.metricSub, layout.sourceMeta, layout.feedRow, layout.axisLabel) >= 12,
      `${Math.min(layout.metricSub, layout.sourceMeta, layout.feedRow, layout.axisLabel)}px`);
    check('卡片主数据字号 ≥ 30px', layout.sourceValue >= 30, `${layout.sourceValue}px`);
    check('排行榜模型名字号 ≥ 16px', layout.rankName >= 16, `${layout.rankName}px`);
    check('圆角已应用（≥ 10px）', layout.panelRadius >= 10, `${layout.panelRadius}px`);
    check('次级文字颜色已提亮', layout.faint !== '' && layout.dim !== '', `faint=${layout.faint} dim=${layout.dim}`);
    // 5 秒轮询下若不抑制入场动画，整页会每 5 秒重新"长出来"一次
    check('首屏后不再重放入场动画',
      layout.bodyReady && layout.sourceAnimation === 'none',
      `is-ready=${layout.bodyReady} animation=${layout.sourceAnimation}`);
    // 曾经的严重回归：渐变文字 + text-fill-color:transparent 让暗色主题的巨型数字整个消失
    check('巨型数字真的可见（文字没有被填成透明）',
      !/rgba\(0,\s*0,\s*0,\s*0\)/.test(layout.heroTextFill) && layout.heroTextFill !== 'transparent',
      `text-fill=${layout.heroTextFill} color=${layout.heroColor}`);
    // 曾经的缺陷：text-shadow 被 .odo-col(overflow:hidden) 逐列裁切，数字后面露出矩形边框
    check('辉光用 drop-shadow（text-shadow 会被数字滚轮裁出方框）',
      layout.heroTextShadow === 'none' && /drop-shadow/.test(layout.heroFilter),
      `text-shadow=${layout.heroTextShadow} filter=${layout.heroFilter.slice(0, 48)}`);

    // 总量数字：纯白 + 白色辉光（三色渐变试过但观感不好，已按需求撤掉）
    check('总 token 是纯白字（不是渐变）',
      layout.digitBg === 'none' && /^rgb\(255,\s*255,\s*255\)$/.test(layout.digitColor),
      `color=${layout.digitColor} background-image=${layout.digitBg}`);
    check('总 token 带白色辉光', /\bdrop-shadow/.test(layout.heroFilter) && /255,\s*255,\s*255/.test(layout.heroFilter),
      layout.heroFilter.slice(0, 72));

    // ── 性能防线：这几个"看着差不多、实际很贵"的写法都踩过，固化成断言 ──
    // 它们都是同步读 computed style，不增加采样时间。
    const perfGuard = JSON.parse(await probe(`(() => {
      const cs = (sel) => { const n = document.querySelector(sel); return n ? getComputedStyle(n) : null; };
      const field = document.getElementById('field');
      const panel = cs('.panel');
      const body = cs('body');
      return JSON.stringify({
        grainBlend: cs('.grain') ? cs('.grain').mixBlendMode : 'none',
        panelBackdrop: panel.backdropFilter || panel.webkitBackdropFilter || 'none',
        topbarBackdrop: cs('.topbar').backdropFilter || cs('.topbar').webkitBackdropFilter || 'none',
        ghostShadow: cs('.model-ghost') ? cs('.model-ghost').textShadow : 'none',
        ghostWillChange: cs('.model-ghost') ? cs('.model-ghost').willChange : 'auto',
        fieldMask: cs('.modelfield') ? (cs('.modelfield').maskImage || cs('.modelfield').webkitMaskImage) : 'none',
        bodyGrain: /repeating-linear-gradient/.test(body.backgroundImage),
        canvasCssWidth: Math.round(field.getBoundingClientRect().width),
        canvasPixels: field.width,
        dpr: window.devicePixelRatio || 1,
        heroGlowShadows: (cs('.hero__total').filter.match(/drop-shadow/g) || []).length,
      });
    })()`));
    check('噪点不再用整屏混合模式（会让画布每帧重算全页）',
      perfGuard.grainBlend === 'none' && perfGuard.bodyGrain,
      `blend=${perfGuard.grainBlend} · 已改为 body 底纹=${perfGuard.bodyGrain}`);
    check('面板/顶栏没有 backdrop-filter（会在画布上每帧重采样）',
      perfGuard.panelBackdrop === 'none' && perfGuard.topbarBackdrop === 'none',
      `panel=${perfGuard.panelBackdrop} topbar=${perfGuard.topbarBackdrop}`);
    check('模型名场没有 mask / 名字发光 / will-change',
      perfGuard.fieldMask === 'none' && perfGuard.ghostShadow === 'none' && perfGuard.ghostWillChange !== 'transform',
      `mask=${perfGuard.fieldMask} shadow=${perfGuard.ghostShadow} will-change=${perfGuard.ghostWillChange}`);
    check('数字辉光只有一层近距离 drop-shadow（大范围靠静态径向光晕）',
      perfGuard.heroGlowShadows <= 1, `${perfGuard.heroGlowShadows} 层`);
    check('粒子画布按低分辨率绘制（氛围层不必满分辨率）',
      perfGuard.canvasPixels <= perfGuard.canvasCssWidth * perfGuard.dpr * 0.85,
      `画布 ${perfGuard.canvasPixels}px / 视口 ${perfGuard.canvasCssWidth}px (dpr ${perfGuard.dpr})`);

    console.log('\n[scan] 扫描中的视觉反馈（扫光与更新闪光都已移除）');
    const scanVisual = JSON.parse(await probe(`(() => {
      const el = document.querySelector('.hero__total');
      const digit = document.querySelector('.hero__total .odo-strip > span');
      // 关掉 0.45s 过渡再读，getComputedStyle 才会直接给目标值；
      // 同一个同步任务里读，页面的轮询也来不及插进来改 body class。
      el.style.transition = 'none';
      document.body.classList.remove('is-scanning', 'value-bumped');
      const beforeHero = getComputedStyle(el).animationName;
      const beforeDigit = getComputedStyle(digit).animationName;
      const idleFilter = getComputedStyle(el).filter;
      document.body.classList.add('is-scanning');
      const heroAnim = getComputedStyle(el).animationName;
      const digitAnim = getComputedStyle(digit).animationName;
      const duration = getComputedStyle(digit).animationDuration;
      const scanFilter = getComputedStyle(el).filter;
      document.body.classList.remove('is-scanning');
      const backToIdle = getComputedStyle(digit).animationName;
      const backFilter = getComputedStyle(el).filter;
      el.style.transition = '';
      return JSON.stringify({
        beforeHero, beforeDigit, heroAnim, digitAnim, duration,
        idleFilter, scanFilter, backToIdle, backFilter,
        radarGone: document.querySelector('.hero__scan') === null,
      });
    })()`));
    console.log(`      容器动画=${scanVisual.heroAnim}（应为 none） · 数字列动画=${scanVisual.digitAnim}(${scanVisual.duration})`);
    check('扫光已移除：扫描不再改变数字列动画',
      scanVisual.heroAnim === 'none' && scanVisual.digitAnim === scanVisual.beforeDigit,
      `容器=${scanVisual.heroAnim} 数字 ${scanVisual.beforeDigit}→${scanVisual.digitAnim}`);
    check('扫描时数字完全不变（光晕也不再提亮）',
      scanVisual.scanFilter === scanVisual.idleFilter && scanVisual.backFilter === scanVisual.idleFilter,
      `idle=scan ${scanVisual.scanFilter === scanVisual.idleFilter} · scan→idle 复原 ${scanVisual.backFilter === scanVisual.idleFilter}`);
    check('旧的雷达扫掠元素已删除', scanVisual.radarGone === true);

    // 扫描状态至少可见 0.9 秒（增量扫描常常只有 0.1s，状态灯一闪而过看不见）
    await probe("(() => { const t = window.tokenNexus; return new Promise((r) => { const i = setInterval(() => { if (!t.state.serverBusy) { clearInterval(i); r(true); } }, 80); setTimeout(() => { clearInterval(i); r(false); }, 3000); }); })()");
    await probe('window.tokenNexus.scan(false)');
    let sawScanning = false;
    let firstSeen = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 6000) {
      const on = await probe("document.body.classList.contains('is-scanning')");
      if (on) {
        if (!firstSeen) firstSeen = Date.now();
        sawScanning = true;
      } else if (sawScanning) {
        break;
      }
      await new Promise((r) => setTimeout(r, 60));
    }
    const held = sawScanning ? Date.now() - firstSeen : 0;
    console.log(`      实测：扫描状态持续 ${held}ms`);
    check('"扫描中"至少可见 0.9 秒（否则增量扫描一闪而过）', held >= 700, `${held}ms`);

    // 数字变化时不应该再有任何闪光反馈
    const bumpProbe = await probe(`(() => {
      const el = document.querySelector('.hero__total');
      el.style.transition = 'none';
      document.body.classList.remove('value-bumped');
      const idleFilter = getComputedStyle(el).filter;
      document.body.classList.add('value-bumped');
      const bumpFilter = getComputedStyle(el).filter;
      const bumpAnim = getComputedStyle(el).animationName;
      document.body.classList.remove('value-bumped');
      el.style.transition = '';
      return JSON.stringify({ idleFilter, bumpFilter, bumpAnim, flash: typeof window.tokenNexus.flash });
    })()`);
    const bumpInfo = JSON.parse(bumpProbe);
    check('数字变化不再闪光（value-bumped 那套高亮已删除）',
      bumpInfo.bumpFilter === bumpInfo.idleFilter && bumpInfo.bumpAnim === 'none' && bumpInfo.flash === 'undefined',
      `filter ${bumpInfo.bumpFilter === bumpInfo.idleFilter ? '无变化' : '变了'} · animation=${bumpInfo.bumpAnim} · flash=${bumpInfo.flash}`);

    console.log('\n[models] 背景模型名场');
    const ghosts = JSON.parse(await probe(`(async () => {
      const snapshot = await fetch('/api/snapshot?days=30').then((r) => r.json());
      const nodes = [...document.querySelectorAll('.model-ghost')];
      const xs = nodes.map((n) => parseFloat(n.style.getPropertyValue('--x')));
      const ys = nodes.map((n) => parseFloat(n.style.getPropertyValue('--y')));
      const scales = [...new Set(nodes.map((n) => n.style.getPropertyValue('--scale')))];
      const ghostColors = [...new Set(nodes.map((n) => n.style.getPropertyValue('--ghost-color')))];
      const paintedColors = [...new Set(nodes.map((n) => getComputedStyle(n).color))];
      return JSON.stringify({
        modelCount: snapshot.byModel.length,
        ghostCount: nodes.length,
        xRange: xs.length ? [Math.min(...xs), Math.max(...xs)] : null,
        yRange: ys.length ? [Math.min(...ys), Math.max(...ys)] : null,
        distinctScales: scales.length,
        ghostColorCount: ghostColors.length,
        paintedColorCount: paintedColors.length,
        maxAlpha: Math.max(...nodes.map((n) => parseFloat(n.style.getPropertyValue('--alpha'))), 0),
        animation: nodes[0] ? getComputedStyle(nodes[0]).animationName : 'none',
        fontFamily: nodes[0] ? getComputedStyle(nodes[0]).fontFamily : '',
        textTransform: nodes[0] ? getComputedStyle(nodes[0]).textTransform : '',
        renderedText: nodes.slice(0, 3).map((n) => n.textContent),
        background: nodes[0] ? getComputedStyle(nodes[0]).position : 'none',
      });
    })()`));
    console.log(`      模型 ${ghosts.modelCount} 个 → 背景元素 ${ghosts.ghostCount} 个 · 例：${ghosts.renderedText.join(' / ')}`);
    console.log(`      字体 ${ghosts.fontFamily.split(',')[0]} · 大小写 ${ghosts.textTransform}`);
    console.log(`      横坐标 ${ghosts.xRange?.[0].toFixed(0)}~${ghosts.xRange?.[1].toFixed(0)}% · 字号档位 ${ghosts.distinctScales} 种 · 最大透明度 ${ghosts.maxAlpha}`);
    check('一个模型对应一个背景元素', ghosts.ghostCount === ghosts.modelCount && ghosts.ghostCount > 0,
      `${ghosts.ghostCount} vs ${ghosts.modelCount}`);
    check('背景名整体大写', ghosts.textTransform === 'uppercase', ghosts.textTransform);
    check('背景名用了 Bahnschrift（不是等宽字体）', /Bahnschrift/i.test(ghosts.fontFamily),
      ghosts.fontFamily.split(',')[0]);
    check('背景名铺开不重叠堆在一角',
      ghosts.xRange && ghosts.xRange[0] < 40 && ghosts.xRange[1] > 55,
      `x ${ghosts.xRange?.[0].toFixed(0)}~${ghosts.xRange?.[1].toFixed(0)}%`);
    check('字号随用量分档', ghosts.distinctScales >= 3, `${ghosts.distinctScales} 档`);
    check('背景名足够淡（不干扰读数）', ghosts.maxAlpha <= 0.3, `最大 ${ghosts.maxAlpha}`);
    check('背景名在缓慢漂移', ghosts.animation === 'modelDrift', ghosts.animation);
    // 需求：背景里不同的模型名用不同的颜色
    check('不同模型名用不同颜色',
      ghosts.paintedColorCount >= Math.min(3, ghosts.modelCount) && ghosts.paintedColorCount === ghosts.ghostColorCount,
      `${ghosts.paintedColorCount} 种实际颜色 / ${ghosts.ghostColorCount} 个槽位 · ${ghosts.modelCount} 个模型`);

    // 英雄区在页面里的位置（后面拍特写用）
    const heroBox = JSON.parse(await probe(
      "(() => { const r = document.querySelector('.hero').getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y+window.scrollY,width:r.width,height:r.height}); })()",
    ));

    console.log('\n[poll] 自动刷新节奏');
    const apiCalls = [];
    cdp.on('Network.requestWillBeSent', (params) => {
      if (String(params.request?.url ?? '').includes('/api/snapshot')) apiCalls.push(Date.now());
    });
    await new Promise((r) => setTimeout(r, 12000));
    const span = apiCalls.length > 1 ? (apiCalls[apiCalls.length - 1] - apiCalls[0]) / (apiCalls.length - 1) : 0;
    console.log(`      12 秒内 /api/snapshot 请求 ${apiCalls.length} 次，平均间隔 ${Math.round(span)}ms`);
    check('轮询间隔约 1 秒（不是 30 秒，也不是 5 秒）',
      apiCalls.length >= 6 && span <= 1600, `${apiCalls.length} 次 / 平均 ${Math.round(span)}ms`);
    // 刚才这 12 秒里后台保鲜扫描跑了很多次（1 秒窗口）。
    // 如果 refresh() 用服务端状态覆盖了 state.scanning，按钮就会被这些后台扫描一直卡住 ——
    // 表现为点了「扫描」毫无反应。
    const btnState = JSON.parse(await probe(`JSON.stringify({
      scanning: window.tokenNexus.state.scanning,
      serverBusy: window.tokenNexus.state.serverBusy,
      disabled: document.getElementById('scanBtn').disabled,
      label: document.getElementById('scanBtn').textContent.trim(),
    })`));
    check('后台保鲜扫描不会卡住「扫描」按钮',
      btnState.scanning === false && btnState.disabled === false,
      `scanning=${btnState.scanning} serverBusy=${btnState.serverBusy} disabled=${btnState.disabled}`);

    console.log('\n[theme] 浅色 / 深色两套主题');
    const dark0 = JSON.parse(await probe(`(() => {
      const cs = getComputedStyle(document.body);
      return JSON.stringify({
        theme: document.documentElement.dataset.theme,
        bg: cs.backgroundColor,
        fieldDisplay: getComputedStyle(document.getElementById('field')).display,
        panelShadow: getComputedStyle(document.querySelector('.panel')).boxShadow,
        gaugeStroke: document.querySelector('.gauge__value')?.getAttribute('stroke') ?? '',
      });
    })()`));
    console.log(`      深色：bg=${dark0.bg} · 粒子场=${dark0.fieldDisplay} · 描边=${dark0.gaugeStroke}`);
    check('深色主题生效（默认值，浅色段之前已归一）', dark0.theme === 'dark', dark0.theme);
    check('深色背景是深色', luminance(dark0.bg) < 0.25, `${dark0.bg} (L=${luminance(dark0.bg).toFixed(3)})`);
    check('深色下粒子场可见', dark0.fieldDisplay !== 'none', dark0.fieldDisplay);
    check('仪表盘用渐变描边（不是纯色）', dark0.gaugeStroke.startsWith('url('), dark0.gaugeStroke);

    mkdirSync(OUT_DIR, { recursive: true });
    const darkShot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(join(OUT_DIR, 'dashboard-dark.png'), Buffer.from(darkShot.data, 'base64'));

    await probe("document.getElementById('themeBtn').click()");
    await new Promise((r) => setTimeout(r, 1400));
    const light = JSON.parse(await probe(`(() => {
      const cs = getComputedStyle(document.body);
      const hero = document.querySelector('.hero');
      return JSON.stringify({
        theme: document.documentElement.dataset.theme,
        bg: cs.backgroundColor,
        fg: getComputedStyle(document.body).color,
        fieldDisplay: getComputedStyle(document.getElementById('field')).display,
        panelBg: getComputedStyle(document.querySelector('.panel')).backgroundColor,
        panelShadow: getComputedStyle(document.querySelector('.panel')).boxShadow,
        heatCell: document.querySelector('.heat__cell')?.getBoundingClientRect().width ?? 0,
      });
    })()`));
    console.log(`      浅色：bg=${light.bg} · 文字=${light.fg} · 卡片=${light.panelBg} · 粒子场=${light.fieldDisplay}`);
    check('切到浅色主题', light.theme === 'light', light.theme);
    check('浅色背景是浅色', luminance(light.bg) > 0.85, `${light.bg} (L=${luminance(light.bg).toFixed(3)})`);
    check('浅色主题文字对比度足够', contrast(light.fg, light.bg) >= 7, `${contrast(light.fg, light.bg).toFixed(1)}:1`);
    check('浅色下自动关掉星空背景', light.fieldDisplay === 'none', light.fieldDisplay);
    check('浅色卡片用柔和投影（不是发光）', /rgba?\(16, 24, 40/.test(light.panelShadow), light.panelShadow.slice(0, 60));
    check('浅色下热力图仍有格子', light.heatCell >= 16, `${light.heatCell}px`);

    await new Promise((r) => setTimeout(r, 400));
    const lightShot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(join(OUT_DIR, 'dashboard-light.png'), Buffer.from(lightShot.data, 'base64'));
    check('已生成浅色主题截图', existsSync(join(OUT_DIR, 'dashboard-light.png')), 'dashboard-light.png');
    const lightHero = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: heroBox.x, y: heroBox.y, width: heroBox.width, height: heroBox.height, scale: 2 },
    });
    writeFileSync(join(OUT_DIR, 'hero-light.png'), Buffer.from(lightHero.data, 'base64'));

    await probe("document.getElementById('themeBtn').click()");
    await new Promise((r) => setTimeout(r, 1200));
    check('切回深色主题', await probe("document.documentElement.dataset.theme") === 'dark');

    console.log('\n[24h] 按小时视图（曾经的"单点趋势图"）');
    await probe("document.querySelector('#rangeSeg button[data-days=\"1\"]').click()");
    await new Promise((r) => setTimeout(r, 1800));
    const hourly = JSON.parse(await probe(`(() => {
      const line = document.querySelector('.trend-line');
      const grid = document.getElementById('trendGrid');
      const hoursPanel = document.getElementById('hoursPanel');
      return JSON.stringify({
        single: grid.classList.contains('grid--single'),
        title: document.getElementById('trendTitle').textContent.trim(),
        hoursPanelHidden: getComputedStyle(hoursPanel).display === 'none',
        hourBars: document.querySelectorAll('.hour__bar').length,
        xLabels: [...document.querySelectorAll('.axis-label')].map((n) => n.textContent).filter((t) => /^\\d{2}$/.test(t)).length,
        lineLen: line ? line.getTotalLength() : 0,
        dotCount: document.querySelectorAll('.trend-dot').length,
      });
    })()`));
    console.log(`      标题「${hourly.title}」· 单栏 ${hourly.single} · 时段刻度 ${hourly.xLabels} 个 · 折线长 ${hourly.lineLen.toFixed(0)}px`);
    check('24H 切换为每小时视图', hourly.single && hourly.title.includes('每小时'), `title="${hourly.title}"`);
    check('24H 下重复的面板已隐藏', hourly.hoursPanelHidden && hourly.hourBars === 0, `hour__bar=${hourly.hourBars}`);
    check('小时轴只出现整点刻度', hourly.xLabels >= 6 && hourly.xLabels <= 12, `${hourly.xLabels} 个`);
    check('折线有真实长度（不再是单点孤柱）', hourly.lineLen > 200, `${hourly.lineLen.toFixed(0)}px`);
    await probe("document.querySelector('#rangeSeg button[data-days=\"30\"]').click()");
    await new Promise((r) => setTimeout(r, 1500));

    // 热力图必须与 byDay 对齐（验证本地时区不会整体错一天）
    const tz = await probe('Intl.DateTimeFormat().resolvedOptions().timeZone');
    const accentNow = await probe("getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()");
    const heat = await probe(`(async () => {
      const snapshot = await fetch('/api/snapshot?days=30').then(r => r.json());
      const days = snapshot.byDay;
      const nonEmpty = days.filter(d => d.total > 0);
      if (nonEmpty.length === 0) return JSON.stringify({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone, empty: true });
      const maxDay = nonEmpty.reduce((a, b) => (b.total > a.total ? b : a));
      const cellOf = (day) => document.querySelector('.heat__cell[data-day="' + day + '"]');
      const maxCell = cellOf(maxDay.day);
      const zeroDay = days.find(d => d.total === 0);
      const zeroCell = zeroDay ? cellOf(zeroDay.day) : null;
      const topLevel = [...document.querySelectorAll('.heat__cell')].filter((n) => n.dataset.level === '4').length;
      return JSON.stringify({
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        total: days.length,
        withData: nonEmpty.length,
        missingCells: nonEmpty.filter(d => !cellOf(d.day)).length,
        maxDay: maxDay.day,
        maxLevel: maxCell?.dataset.level ?? null,
        maxColor: maxCell ? getComputedStyle(maxCell).backgroundColor : null,
        zeroDay: zeroDay ? zeroDay.day : null,
        zeroColor: zeroCell ? getComputedStyle(zeroCell).backgroundColor : null,
        topLevelCells: topLevel,
        axisInCells: days.filter(d => cellOf(d.day)).length,
      });
    })()`);
    const h = JSON.parse(heat);
    if (h.empty) {
      check('热力图日期对齐', true, '区间内无数据，跳过');
    } else {
      console.log(`      时区 ${h.tz} · 区间 ${h.total} 天（${h.withData} 天有数据）· 最高色阶格子 ${h.topLevelCells} 个`);
      check('热力图每个有数据的日期都有对应格子', h.missingCells === 0, `缺 ${h.missingCells} 个`);
      check('轴末端日期落在热力图里', h.axisInCells >= h.withData, `${h.axisInCells}/${h.total}`);
      check('峰值日是最深色阶', h.maxLevel === '4', `level=${h.maxLevel} ${h.maxColor}`);
      check('色阶颜色跟随主题强调色', colorClose(h.maxColor, accentNow), `${h.maxColor} vs accent ${accentNow}`);
      check('零用量日是空色阶', !h.zeroColor || h.zeroColor !== h.maxColor, `${h.zeroDay} → ${h.zeroColor}`);
    }

    await probe("document.getElementById('settingsBtn').click()");
    await new Promise((r) => setTimeout(r, 500));
    const drawer = await probe("JSON.stringify({open: document.getElementById('drawer').classList.contains('is-open'), panes: document.getElementById('drawerPanes').children.length, rows: document.querySelectorAll('#drawerPanes .field-row').length})");
    const d = JSON.parse(drawer);
    check('设置抽屉可打开', d.open && d.panes > 0, `面板 ${d.panes} 个 / 字段 ${d.rows} 条`);

    // 逐个页签都必须能渲染出内容（曾有一个页签因为 ReferenceError 永久空白）
    for (const tab of ['sources', 'pricing', 'api', 'about']) {
      await probe(`document.querySelector('#drawerTabs button[data-tab="${tab}"]').click()`);
      await new Promise((r) => setTimeout(r, 450));
      const info = await probe(`JSON.stringify({
        sections: document.getElementById('drawerPanes').children.length,
        text: document.getElementById('drawerPanes').textContent.trim().length,
        rows: document.querySelectorAll('#drawerPanes .field-row').length,
        areas: document.querySelectorAll('#drawerPanes textarea').length,
        priceRows: document.querySelectorAll('#drawerPanes table.price tbody tr').length,
      })`);
      const info2 = JSON.parse(info);
      check(`设置页签「${tab}」渲染出内容`, info2.sections > 0 && info2.text > 60,
        `文本 ${info2.text} 字 · 字段 ${info2.rows} · 输入区 ${info2.areas} · 价格行 ${info2.priceRows}`);
    }
    await probe("document.querySelector('#drawerTabs button[data-tab=\"off\"]')||0");
    await probe("document.querySelector('#drawer [data-close]').click()");
    await new Promise((r) => setTimeout(r, 400));

    // 截图（整页）
    mkdirSync(OUT_DIR, { recursive: true });
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const shotPath = join(OUT_DIR, 'dashboard.png');
    writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
    check('已生成整页截图', existsSync(shotPath), shotPath);

    // 英雄区特写（2 倍放大，用来看仪表盘/计数器的细节）
    if (heroBox.width > 0) {
      const heroShot = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: heroBox.x, y: heroBox.y, width: heroBox.width, height: heroBox.height, scale: 2 },
      });
      writeFileSync(join(OUT_DIR, 'hero.png'), Buffer.from(heroShot.data, 'base64'));
      check('已生成英雄区特写', existsSync(join(OUT_DIR, 'hero.png')), `hero.png (${Math.round(heroBox.width)}×${Math.round(heroBox.height)})`);
    }

    // 窄屏渲染（响应式）。
    // 注意用 mobile:false：mobile:true 会启用视觉视口缩放，innerWidth 反而不是 420。
    // 视口高度要够大，否则 clip 到 1500px 时超出视口的部分是没绘制过的黑块。
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 420, height: 1600, deviceScaleFactor: 1, mobile: false,
    });
    await new Promise((r) => setTimeout(r, 1200));
    const mobileWidth = await probe('window.innerWidth');
    const scrollWidth = await probe('document.documentElement.scrollWidth');
    const mobileMatched = await probe("matchMedia('(max-width: 620px)').matches");
    // 截图放在探测之后：captureBeyondViewport 会临时改视口，之后测量就不准了。
    // 只截首屏高度 —— 整页在 420px 宽下会长到 4000px+，既读不了也超图片尺寸上限。
    const mobile = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: 420, height: 1500, scale: 1 },
    });
    writeFileSync(join(OUT_DIR, 'dashboard-mobile.png'), Buffer.from(mobile.data, 'base64'));
    check('窄屏视口已生效', Math.abs(mobileWidth - 420) <= 10, `${mobileWidth}px`);
    check('窄屏命中响应式断点', mobileMatched === true, `max-width:620px → ${mobileMatched}`);
    const overflowers = await probe(`JSON.stringify(
      [...document.querySelectorAll('body *')]
        .filter((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.right > window.innerWidth + 2; })
        .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)
        .slice(0, 6)
        .map((n) => ({
          tag: n.tagName.toLowerCase(),
          cls: String(n.className ?? '').slice(0, 46),
          right: Math.round(n.getBoundingClientRect().right),
          width: Math.round(n.getBoundingClientRect().width),
        }))
    )`);
    if (scrollWidth > mobileWidth + 2) {
      console.log(`      \u001b[33m超宽元素：${overflowers}\u001b[0m`);
    }
    check('窄屏无横向溢出', scrollWidth <= mobileWidth + 2, `scrollWidth ${scrollWidth} vs ${mobileWidth}`);

    // 数字被裁切：横向不溢出也可能是卡片内部 overflow:hidden 把数字切掉了
    const clipped = await probe(`JSON.stringify(
      ['.metric__v', '.source__value', '.hero__total', '.rank__val'].flatMap((sel) =>
        [...document.querySelectorAll(sel)]
          .filter((n) => n.textContent.trim() !== '' && n.scrollWidth > n.clientWidth + 2)
          .map((n) => ({ sel, text: n.textContent.trim().slice(0, 16), need: n.scrollWidth, have: n.clientWidth }))
      ).slice(0, 5)
    )`);
    check('窄屏下数字没有被裁切', JSON.parse(clipped).length === 0, clipped);
    await cdp.send('Emulation.clearDeviceMetricsOverride');
  } catch (error) {
    check('浏览器验收流程无异常', false, error.message);
  } finally {
    // 无论流程是否中断，控制台报错都必须打出来 —— 它就是定位问题的关键线索
    console.log('\n  控制台报错：');
    if (consoleErrors.length === 0) {
      check('浏览器控制台无报错、无未捕获异常', true);
    } else {
      for (const error of consoleErrors.slice(0, 12)) console.log(`      \u001b[31m${error}\u001b[0m`);
      check('浏览器控制台无报错、无未捕获异常', false, `${consoleErrors.length} 条`);
    }
    cdp?.close();
    await killTree(child);
    if (server) await killTree(server);
    await new Promise((r) => setTimeout(r, 1200));
    if (!KEEP) {
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* Windows 上偶发占用 */ }
    }
  }

  console.log(`\n  ─────────────────────────────────────────────`);
  console.log(`  通过 ${passed} · 失败 ${failures.length}`);
  if (failures.length > 0) {
    console.log(`  失败项：\n    - ${failures.join('\n    - ')}`);
    process.exit(1);
  }
  console.log(`  截图：${OUT_DIR}\n`);
  process.exit(0);
}

/**
 * 结束一个子进程**连同它的整棵进程树**。
 *
 * Windows 上 child.kill() 只杀根进程：Chrome 会留下一堆子进程继续占着
 * CDP 端口（9333）空转，下一次验收就会连到那只僵尸浏览器上，
 * 表现为「首屏渲染超时」「Runtime.evaluate 超时」这类看不懂的失败。
 * 所以这里用 taskkill /T /F 收整棵树。
 */
async function killTree(proc) {
  if (!proc || !proc.pid) return;
  try {
    if (process.platform === 'win32') {
      await new Promise((resolve) => {
        const killer = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        killer.on('exit', resolve);
        killer.on('error', resolve);
        setTimeout(resolve, 8000);
      });
    } else {
      proc.kill('SIGTERM');
    }
  } catch {
    /* 已经退出了 */
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
