#!/usr/bin/env node
/**
 * server.mjs —— TOKEN NEXUS 本地服务
 *
 * 零依赖 HTTP 服务：
 *   - 托管 web/ 下的静态界面
 *   - /api/*    数据接口
 *   - /api/events  SSE 推送扫描进度（前端的雷达扫描动画就靠它）
 *
 * 只监听 127.0.0.1（可用 --host 改）。不读任何目录之外的路径，
 * 静态文件做了路径穿越防护。云连接器没配密钥就一个请求都不发。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { loadConfig, saveConfig, redact, mergeSecretPatch, ensureDirs, CONFIG_PATH, CACHE_DIR } from './server/config.mjs';
import { scan, subscribe, buildRaw, getReport, isScanning, cacheStats, clearCache } from './server/scan.mjs';
import { sourceSpecs, environmentInfo } from './server/paths.mjs';
import { listScanners } from './server/scanners/index.mjs';
import { aggregate } from './server/aggregate.mjs';
import { runConnectors, applyToRaw, connectorSpecs, syncRemotePricing, priceTableFor } from './server/connectors/index.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WEB_ROOT = resolve(HERE, 'web');

/* ────────────────────────── CLI ────────────────────────── */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const valueOf = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

ensureDirs();
const config = loadConfig();

if (flag('--help') || flag('-h')) {
  console.log(`TOKEN NEXUS · 全局 Token 观测台

用法：
  node server.mjs                    启动服务并打开浏览器
  node server.mjs --app              「小应用」模式：开一个没有地址栏的独立窗口（Chrome/Edge）
  node server.mjs --port 9000        指定端口
  node server.mjs --host 0.0.0.0     允许局域网访问（默认只监听本机）
  node server.mjs --no-open          不自动打开浏览器
  node server.mjs --scan-only        只在终端跑一次扫描并打印汇总
  node server.mjs --force            忽略缓存全量重扫
  node server.mjs --json             配合 --scan-only 输出 JSON

配置：${CONFIG_PATH}
缓存：${CACHE_DIR}`);
  process.exit(0);
}

if (flag('--scan-only')) {
  const force = flag('--force');
  const report = await scan({ force, reason: 'cli' });
  const connectors = await runConnectors(loadConfig(), { force });
  const raw = applyToRaw(buildRaw(), connectors);
  const snapshot = aggregate({
    raw,
    config: loadConfig(),
    report,
    priceTable: priceTableFor(loadConfig()),
    rangeDays: 0,
  });
  if (flag('--json')) {
    console.log(JSON.stringify(snapshot, null, 2));
  } else {
    printSummary(snapshot, report);
  }
  process.exit(0);
}

function printSummary(snapshot, report) {
  const { totals } = snapshot;
  const n = (value) => Number(value || 0).toLocaleString('en-US');
  console.log('');
  console.log('  TOKEN NEXUS · 全局 Token 观测台');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  总 token      ${n(totals.total)}`);
  console.log(`  输入 / 输出   ${n(totals.input)} / ${n(totals.output)}`);
  console.log(`  缓存 读 / 写  ${n(totals.cacheRead)} / ${n(totals.cacheWrite)}`);
  console.log(`  请求数        ${n(totals.requests)}`);
  console.log(`  会话 / 项目   ${n(totals.sessions)} / ${n(totals.projects)}`);
  console.log(`  估算费用      ${totals.cost.text}  (${totals.cost.currency})`);
  console.log(`  缓存命中率    ${(totals.cacheHitRate * 100).toFixed(1)}%`);
  console.log('  ─────────────────────────────────────────────');
  for (const source of snapshot.bySource) {
    if (source.total === 0 && source.detectedFiles === 0) continue;
    console.log(`  ${source.label.padEnd(20)} ${n(source.total).padStart(16)}  ${String(source.cost.text).padStart(12)}  ${source.detectedFiles} 文件`);
  }
  if (snapshot.meta.unpriced.length > 0) {
    console.log('  ─────────────────────────────────────────────');
    console.log(`  未定价模型 ${snapshot.meta.unpriced.length} 个（占总 token ${(snapshot.meta.unpricedTokens / (totals.total || 1) * 100).toFixed(1)}%）：`);
    for (const row of snapshot.meta.unpriced.slice(0, 8)) {
      console.log(`    · ${row.provider}/${row.model}`);
    }
  }
  console.log(`  耗时 ${(report.durationMs / 1000).toFixed(1)}s · 文件 ${report.files}（重扫 ${report.parsedFiles} / 复用 ${report.reusedFiles}）`);
  console.log('');
}

/* ────────────────────────── 状态 ────────────────────────── */

// 快照按查询键缓存（days+sources）：之前用一个全局变量，两个并发请求会互相覆盖
const snapshotCache = new Map();
let lastError = null;
const MAX_SNAPSHOT_CACHE = 8;

function snapshotQuery(searchParams) {
  const days = Number(searchParams.get('days') ?? '0') || 0;
  const sources = (searchParams.get('sources') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return { days, sources, key: `${days}|${sources.join(',')}` };
}

async function getSnapshot(query, { recompute = false } = {}) {
  const cfg = loadConfig();
  if (!recompute && snapshotCache.has(query.key)) return snapshotCache.get(query.key);
  const connectors = await runConnectors(cfg, { days: query.days > 0 ? Math.max(query.days, 30) : 90 });
  const raw = applyToRaw(buildRaw({ sources: query.sources }), connectors);

  // 把云连接器也塞进 report.sources，聚合层才能在数据源列表里如实呈现它们
  const baseReport = getReport() ?? { sources: [] };
  const connectorRows = connectorSpecs().map((spec) => ({
    id: spec.id,
    label: spec.label,
    kind: 'cloud',
    vendor: spec.vendor,
    accent: spec.accent,
    description: spec.description,
    enabled: connectors.configured.includes(spec.id),
    roots: [],
    files: connectors.perSource?.[spec.id] ? 1 : 0,
    bytes: 0,
    events: connectors.perSource?.[spec.id]?.events ?? 0,
    sessions: connectors.perSource?.[spec.id]?.sessions ?? 0,
    tokens: 0,
    parsedMs: 0,
    errors: connectors.errors.filter((row) => row.source === spec.id).length,
    requiresKey: spec.requiresKey,
    docs: spec.docs,
    configured: connectors.configured.includes(spec.id),
  }));
  const report = { ...baseReport, sources: [...(baseReport.sources ?? []), ...connectorRows] };

  const snapshot = aggregate({
    raw,
    config: cfg,
    report,
    priceTable: priceTableFor(cfg),
    rangeDays: query.days,
    sources: query.sources,
  });
  snapshot.connectors = {
    configured: connectorSpecs().filter((spec) => connectors.configured.includes(spec.id)),
    available: connectorSpecs(),
    cached: connectors.cached,
    ranAt: connectors.ranAt,
    warnings: connectors.warnings,
    errors: connectors.errors,
    // 本地日志与云连接器是**纯叠加**关系：同一次请求两边都记的话会被算两遍。
    // 这里主动提示，而不是让用户对着翻倍的数字发懵。
    overlap: detectOverlap(raw, connectors),
  };
  if (snapshotCache.size >= MAX_SNAPSHOT_CACHE) {
    snapshotCache.delete(snapshotCache.keys().next().value);
  }
  snapshotCache.set(query.key, snapshot);
  return snapshot;
}

/** 检测「同一个厂商既读本地日志又接了云 API」的重复计数风险。 */
function detectOverlap(raw, connectors) {
  const pairs = [
    { vendor: 'openai', connector: 'openai-api', local: ['codex'] },
    { vendor: 'anthropic', connector: 'anthropic-api', local: ['claude-code'] },
  ];
  const warnings = [];
  for (const pair of pairs) {
    if (!connectors.configured.includes(pair.connector)) continue;
    for (const localId of pair.local) {
      const local = raw.perSource?.[localId];
      const tokens = Object.values(local?.buckets ?? {}).reduce(
        (sum, bucket) => sum + bucket[0] + bucket[1] + bucket[2] + bucket[3], 0,
      );
      if (tokens > 0) {
        warnings.push({
          connector: pair.connector,
          local: localId,
          tokens,
          message: `「${pair.connector}」与本地「${localId}」可能记录同一次请求 —— 已同时计入，总量和费用可能被重复计算。`,
        });
      }
    }
  }
  return warnings;
}

/**
 * 后台保鲜：新会话日志是随时在写的，所以每次读快照都检查一次缓存年龄。
 * 超期就 fire-and-forget 地起一次增量扫描（不阻塞本次响应），扫完前端会收到
 * scan/end 事件并自动重取。
 */
function ensureFresh(reason) {
  if (isScanning()) return;
  const cfg = loadConfig();
  const report = getReport();
  const age = report ? Date.now() - report.finishedAt : Infinity;
  // 自适应退避：窗口至少是「上次扫描耗时的 3 倍」，避免"扫描比间隔还慢"导致 CPU 满转。
  // 但必须封顶 —— 否则第一次全量扫描（30 秒级）会把窗口推到两分钟，
  // 表现为"刚启动完就不更新了"。封顶后下一次增量续读只要几十毫秒，立刻回到 1 秒节奏。
  const base = Math.max(1000, Number(cfg.cacheTtlMs) || 1000);
  const ttl = Math.min(Math.max(base, Math.round((report?.durationMs ?? 0) * 3)), 10000);
  if (report && age <= ttl) return;
  scan({ reason })
    .then(() => {
      snapshotCache.clear();
    })
    .catch((error) => {
      lastError = error.message;
      console.error(`[scan] 后台刷新失败：${error.message}`);
    });
}

/** 写接口的同源校验：只接受不带 Origin（命令行/curl）或同源的请求。 */
function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true; // 非浏览器请求
  try {
    const host = request.headers.host;
    const url = new URL(origin);
    return url.host === host;
  } catch {
    return false;
  }
}

/* ────────────────────────── HTTP 工具 ────────────────────────── */

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

async function readBody(request, limit = 1 << 20) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

async function serveStatic(request, response, pathname) {
  const relative = pathname === '/' ? 'index.html' : normalize(decodeURIComponent(pathname)).replace(/^[\\/]+/, '');
  const target = resolve(WEB_ROOT, relative);
  if (!target.startsWith(WEB_ROOT + sep) && target !== WEB_ROOT) {
    response.writeHead(403).end('forbidden');
    return;
  }
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not a file');
    let body = await readFile(target);
    // 局域网模式下把访问令牌注入页面，前端 API 调用会自动带上
    if (ACCESS_TOKEN && target.endsWith('index.html')) {
      body = Buffer.from(
        body.toString('utf8').replace(
          '<script type="module" src="/js/app.js">',
          `<script>window.__NEXUS_TOKEN__=${JSON.stringify(ACCESS_TOKEN)};</script>\n<script type="module" src="/js/app.js">`,
        ),
        'utf8',
      );
    }
    response.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-cache',
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('404');
  }
}

function toCsv(snapshot) {
  const rows = [['dimension', 'key', 'provider', 'model', 'project', 'source', 'input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total', 'requests', 'costUsd']];
  const line = (dimension, key, entry) => {
    rows.push([
      dimension, key, entry.provider ?? '', entry.model ?? '', entry.project ?? '',
      entry.id ?? entry.sources?.join('|') ?? '',
      entry.input, entry.output, entry.cacheRead, entry.cacheWrite, entry.reasoning,
      entry.total, entry.requests, entry.usd,
    ]);
  };
  for (const entry of snapshot.byModel) line('model', entry.model, entry);
  for (const entry of snapshot.byProject) line('project', entry.project, entry);
  for (const entry of snapshot.byProvider) line('provider', entry.name, entry);
  for (const entry of snapshot.bySource) line('source', entry.label, entry);
  for (const entry of snapshot.byDay) line('day', entry.day, entry);
  return rows.map((row) => row.map((cell) => {
    const text = String(cell ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(',')).join('\n');
}

/* ────────────────────────── 路由 ────────────────────────── */

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;

  try {
    // 局域网模式：所有 /api/* 都要带令牌
    if (ACCESS_TOKEN && pathname.startsWith('/api/')) {
      const provided = tokenFrom(request, url);
      if (provided !== ACCESS_TOKEN) {
        sendJson(response, 401, { error: '缺少或错误的访问令牌；请使用启动时打印的带 token 的地址打开' });
        return;
      }
    }

    // 写操作 + 配置读接口做同源校验：防止恶意网页通过 CSRF / DNS rebinding 读写本机配置
    const mutating = (request.method !== 'GET' && pathname.startsWith('/api/'))
      || pathname === '/api/config';
    if (mutating && !sameOrigin(request)) {
      sendJson(response, 403, { error: '拒绝跨站请求（Origin 与 Host 不一致）' });
      return;
    }

    if (pathname === '/api/health') {
      sendJson(response, 200, {
        ok: true,
        scanning: isScanning(),
        lastError,
        cache: cacheStats(),
        scanners: listScanners(),
      });
      return;
    }

    if (pathname === '/api/events') {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      response.write(`event: hello\ndata: ${JSON.stringify({ scanning: isScanning() })}\n\n`);
      const unsubscribe = subscribe((events) => {
        for (const event of events) {
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      });
      const heartbeat = setInterval(() => response.write(': ping\n\n'), 15000);
      heartbeat.unref?.();
      request.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
      return;
    }

    if (pathname === '/api/scan') {
      const force = url.searchParams.get('force') === '1';
      if (!isScanning()) {
        scan({ force, reason: force ? 'force' : 'api' })
          .then(() => {
            snapshotCache.clear();
          })
          .catch((error) => {
            lastError = error.message;
          });
      }
      sendJson(response, 202, { ok: true, scanning: true, force });
      return;
    }

    if (pathname === '/api/snapshot') {
      const query = snapshotQuery(url.searchParams);
      ensureFresh('ttl');
      const snapshot = await getSnapshot(query);
      sendJson(response, 200, {
        ...snapshot,
        status: isScanning() ? 'scanning' : 'idle',
        lastError,
      });
      return;
    }

    if (pathname === '/api/sources') {
      const specs = sourceSpecs(loadConfig());
      sendJson(response, 200, {
        local: specs.map((spec) => ({
          id: spec.id,
          label: spec.label,
          kind: spec.kind,
          vendor: spec.vendor,
          accent: spec.accent,
          description: spec.description,
          enabled: spec.enabled,
          paths: spec.paths,
          exists: spec.paths.map((path) => ({ path, exists: existsSync(path) })),
        })),
        cloud: connectorSpecs().map((spec) => ({
          ...spec,
          configured: false,
        })),
        environment: environmentInfo(),
      });
      return;
    }

    if (pathname === '/api/config' && request.method === 'GET') {
      sendJson(response, 200, { config: redact(loadConfig()), configPath: CONFIG_PATH, cacheDir: CACHE_DIR });
      return;
    }

    if (pathname === '/api/config' && request.method === 'POST') {
      const patch = await readBody(request);
      const merged = mergeSecretPatch(patch);
      const saved = saveConfig(merged);
      snapshotCache.clear();
      sendJson(response, 200, { ok: true, config: redact(saved) });
      return;
    }

    if (pathname === '/api/pricing/sync' && request.method === 'POST') {
      try {
        const result = await syncRemotePricing(loadConfig(), { force: url.searchParams.get('force') === '1' });
        snapshotCache.clear();
        sendJson(response, 200, { ok: true, models: result.models.length, fetchedAt: result.fetchedAt, cached: result.cached });
      } catch (error) {
        sendJson(response, 502, { ok: false, error: error.message });
      }
      return;
    }

    if (pathname === '/api/cache' && request.method === 'DELETE') {
      clearCache();
      snapshotCache.clear();
      sendJson(response, 200, { ok: true });
      return;
    }

    if (pathname === '/api/export') {
      const query = snapshotQuery(url.searchParams);
      const snapshot = await getSnapshot(query);
      const format = url.searchParams.get('format') ?? 'json';
      if (format === 'csv') {
        // BOM 必须算进 Content-Length，否则声明长度与实际不符，客户端可能截断尾部
        const body = `\uFEFF${toCsv(snapshot)}`;
        response.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="token-nexus-${new Date().toISOString().slice(0, 10)}.csv"`,
          'content-length': Buffer.byteLength(body, 'utf8'),
        });
        response.end(body);
      } else {
        const body = JSON.stringify(snapshot, null, 2);
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="token-nexus-${new Date().toISOString().slice(0, 10)}.json"`,
          'content-length': Buffer.byteLength(body),
        });
        response.end(body);
      }
      return;
    }

    if (pathname.startsWith('/api/')) {
      sendJson(response, 404, { error: 'unknown endpoint' });
      return;
    }

    await serveStatic(request, response, pathname);
  } catch (error) {
    lastError = error.message;
    if (!response.headersSent) sendJson(response, 500, { error: error.message });
    else response.end();
  }
});

const PORT = Number(valueOf('--port', config.port)) || 8787;
/** 用户显式指定了 --port 就尊重它，不做自动换端口 */
const EXPLICIT_PORT = argv.includes('--port');
let portRetries = 0;
const HOST = valueOf('--host', config.host) || '127.0.0.1';
const IS_LOOPBACK = ['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1'].includes(HOST);
/**
 * 绑定到非本机地址时强制要求访问令牌。
 * 没有令牌的话，同一局域网里任何人都能读 /api/sources（会泄露用户名与完整目录清单）、
 * 拉 /api/export，甚至用一个不带 Origin 的 curl 改写配置。
 */
const ACCESS_TOKEN = IS_LOOPBACK ? null : randomBytes(16).toString('hex');
const hostForUrl = (port) => `http://${IS_LOOPBACK ? HOST : '127.0.0.1'}:${port}`;

function tokenFrom(request, url) {
  return url.searchParams.get('token')
    ?? request.headers['x-nexus-token']
    ?? null;
}

server.on('error', (error) => {
  // 端口被占用是「打不开」最常见的原因之一。与其让用户读报错，不如自动试下一个端口 ——
  // 反正真正的地址会在下面打印出来并自动打开。显式传 --port 时不自动换（用户是故意的）。
  if (error.code === 'EADDRINUSE' && !EXPLICIT_PORT && portRetries < 5) {
    portRetries += 1;
    const next = PORT + portRetries;
    console.warn(`  [!] 端口 ${next - 1} 已被占用，自动改试 ${next}…`);
    setTimeout(() => server.listen(next, HOST), 80);
    return;
  }
  if (error.code === 'EADDRINUSE') {
    console.error('');
    console.error(`  [x] 端口 ${PORT} 已被占用${EXPLICIT_PORT ? '' : '（自动试过后面 5 个端口也都被占了）'}。`);
    console.error('');
    console.error('      可能已经有一个 TOKEN NEXUS 在跑 —— 先看看浏览器里 127.0.0.1:' + PORT);
    console.error('      或者手动换一个端口：');
    console.error('');
    console.error(`          node server.mjs --port ${PORT + 100}`);
    console.error('');
  } else if (error.code === 'EACCES') {
    console.error(`\n  [x] 没有权限监听 ${HOST}:${PORT}。换个高位端口试试：node server.mjs --port 8899\n`);
  } else {
    console.error(`\n  [x] 服务启动失败：${error.message}\n`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  // 用真实生效的端口（可能因为被占用而自动换过）
  const actual = server.address().port;
  const url = hostForUrl(actual);
  const fullUrl = ACCESS_TOKEN ? `${url}/?token=${ACCESS_TOKEN}` : url;

  console.log('');
  console.log('  ╔══════════════════════════════════════════════════╗');
  console.log('  ║   T O K E N   N E X U S                          ║');
  console.log('  ║   全局 Token 观测台                              ║');
  console.log('  ╚══════════════════════════════════════════════════╝');
  if (ACCESS_TOKEN) {
    console.log(`   监听 ${HOST}:${actual}（局域网可访问）`);
    console.log('   ⚠ 已启用访问令牌，请用下面这个完整地址打开：');
  }
  console.log(`   → ${fullUrl}`);
  console.log(`   配置 ${CONFIG_PATH}`);
  console.log('');

  // 启动就预热：首屏不用等用户点「扫描」
  scan({ reason: 'startup' })
    .then((report) => {
      console.log(`  [scan] ${report.files} 个文件 · 解析 ${report.parsedFiles} · 复用 ${report.reusedFiles} · 用时 ${(report.durationMs / 1000).toFixed(1)}s`);
      snapshotCache.clear();
    })
    .catch((error) => console.error(`  [scan] 失败：${error.message}`));

  if (!flag('--no-open') && config.openBrowser !== false) {
    openBrowser(fullUrl, { asApp: flag('--app') });
  }
});

/** 找一个 Chromium 内核浏览器（用来开 --app 窗口）。找不到就退回默认浏览器。 */
function findChromium() {
  if (process.platform !== 'win32') return null;
  const pf = process.env['PROGRAMFILES'];
  const pf86 = process.env['PROGRAMFILES(X86)'];
  return [
    pf && join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    pf86 && join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    pf86 && join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    pf && join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean).find((path) => existsSync(path)) ?? null;
}

function openBrowser(url, { asApp = false } = {}) {
  const platform = process.platform;
  try {
    // 小应用模式：独立窗口 + 没有地址栏，观感接近桌面程序。
    // 用的是系统里已有的 Chrome / Edge，不额外打包任何东西。
    if (asApp) {
      const exe = findChromium();
      if (exe) {
        const child = spawn(exe, [`--app=${url}`, '--window-size=1600,1000', '--no-first-run'], {
          detached: true, stdio: 'ignore',
        });
        child.on('error', () => {});
        child.unref();
        return;
      }
    }
    const command = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open';
    const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* 桌面环境缺失时忽略 */
  }
}

process.on('SIGINT', () => {
  console.log('\n  已退出。');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
});

export { server };
