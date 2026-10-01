/**
 * app.js —— 主控：状态、渲染、扫描进度、交互
 */
import * as api from './api.js';
import { startField } from './background.js';
import {
  compact, full, money, pct, clock, timeAgo, duration, bytes, shortModel, shortDay, escapeHtml,
} from './format.js';
import {
  renderOdometer, renderTrend, renderHours, renderDonut, renderRank,
  renderHeatmap, renderFeed, renderMetrics, renderSources, gaugeMarkup,
} from './widgets.js';
import { mountSettings } from './settings.js';
import { renderModelField } from './modelfield.js';

const $ = (id) => document.getElementById(id);

const state = {
  config: null,
  sources: null,
  snapshot: null,
  trend: null,
  fingerprint: '',
  rendered: false,
  days: 30,
  activeSources: new Set(),
  scanning: false,
  serverBusy: false,
  quietScan: false,
  scanStartedAt: 0,
  statusHoldUntil: 0,
  totalFiles: 0,
  filesDone: 0,
  field: null,
  toastTimer: 0,
  renderTimer: 0,
  lastRenderError: null,
};

/* ────────────────────────── 工具 ────────────────────────── */

function toast(message, kind = 'info', ms = 3200) {
  const node = $('toast');
  node.textContent = message;
  node.dataset.kind = kind;
  node.classList.add('is-on');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => node.classList.remove('is-on'), ms);
}

function term(line, kind = '') {
  const node = $('terminal');
  const row = document.createElement('div');
  row.className = 'terminal__line';
  row.innerHTML = `<i>${clock()}</i><span class="${kind}">${escapeHtml(line)}</span>`;
  node.appendChild(row);
  while (node.childElementCount > 260) node.removeChild(node.firstChild);
  node.scrollTop = node.scrollHeight;
}

function setStatus(status, text) {
  const pill = $('statusPill');
  pill.dataset.state = status;
  $('statusText').textContent = text;
  // 扫描中让总量数字自己呼吸变色。
  // （原先是一条雷达扫掠光带，观感偏"加载条"，已经删掉。）
  document.body.classList.toggle('is-scanning', status === 'scanning');
}

/* ────────────────────────── 渲染 ────────────────────────── */

function render(snapshot) {
  state.snapshot = snapshot;
  const { totals, meta } = snapshot;

  // 英雄区
  $('heroEyebrow').textContent = state.days > 0 ? `最近 ${state.days} 天用量` : '累计总用量';
  // 数字变化时**不做任何闪光**（需求明确去掉"一变就亮一下"）
  renderOdometer($('odoTotal'), totals.total);

  // 今日（无论当前选的是哪个时间范围，都取「今天」这一天）
  // byDay 由服务端补齐到今天，所以区间里一定找得到今天这一行。
  const todayRow = snapshot.byDay.find((day) => day.day === localTodayKey()) ?? null;
  const todayTotal = todayRow?.total ?? 0;
  $('todayValue').textContent = todayTotal > 0 ? compact(todayTotal) : '0';
  $('todayNote').textContent = todayTotal > 0
    ? `${full(todayRow?.requests ?? 0)} 次请求 · 占区间 ${pct(todayTotal / (totals.total || 1), 1)}`
    : '今天还没有记录';

  const priceTable = snapshot.meta.priceTable ?? {};
  // 费用块：上面「总消费」（当前区间累计），下面「今日消费」
  $('costValue').textContent = money(totals.cost);
  $('todayCostValue').textContent = money(todayRow?.cost);
  const unpricedNote = meta.unpricedTokens > 0
    ? `其中 ${pct(meta.unpricedTokens / (totals.total || 1), 1)} 用量尚无单价`
    : '全部用量均已定价';
  $('costNote').innerHTML = `${priceTable.remote ? '实时同步价格表' : '内置价格表'} · 基准日 ${priceTable.asOf ?? '—'}<br>${unpricedNote}`;

  $('heroChips').innerHTML = [
    ['输入', compact(totals.input)],
    ['输出', compact(totals.output)],
    ['缓存读', compact(totals.cacheRead)],
    ['请求', full(totals.requests)],
    ['活跃天', `${meta.activeDays}`],
  ].map(([label, value]) => `<span class="chip"><i style="background:var(--accent)"></i>${label} <b>${value}</b></span>`).join('');

  $('gauges').innerHTML = [
    gaugeMarkup({
      value: totals.cacheHitRate, display: pct(totals.cacheHitRate, 0),
      caption: 'CACHE', label: '缓存命中率', gradient: 'cache',
    }),
    gaugeMarkup({
      value: totals.input / (totals.total || 1), display: pct(totals.input / (totals.total || 1), 1),
      caption: 'INPUT', label: '输入占比', gradient: 'input',
    }),
    // 输出占比本来就很小（agent 场景典型 0.3%），环相应小 —— 但必须与中间数字一致，
    // 不能为了"好看"去放大它。
    gaugeMarkup({
      value: totals.outputShare, display: pct(totals.outputShare, 1),
      caption: 'OUTPUT', label: '输出占比', gradient: 'output',
    }),
    gaugeMarkup({
      value: totals.pricedShare, display: pct(totals.pricedShare, 0),
      caption: 'PRICED', label: '已定价占比', gradient: 'priced',
    }),
  ].join('');

  // 指标条
  renderMetrics($('metrics'), [
    { key: '总 TOKEN', value: full(totals.total), sub: `${compact(totals.total)} tokens`, color: 'var(--accent)', ratio: 1 },
    { key: '输入（非缓存）', value: compact(totals.input), sub: pct(totals.input / (totals.total || 1)), color: 'var(--accent)', ratio: totals.input / (totals.total || 1) },
    { key: '输出', value: compact(totals.output), sub: pct(totals.outputShare), color: 'var(--accent-2)', ratio: totals.outputShare },
    { key: '缓存读', value: compact(totals.cacheRead), sub: pct(totals.cacheHitRate), color: 'var(--accent-3)', ratio: totals.cacheHitRate },
    { key: '请求数', value: full(totals.requests), sub: `平均 ${compact(totals.avgPerRequest, 0)} / 次`, color: 'var(--accent)', ratio: 1 },
    { key: '会话 / 项目', value: `${full(totals.sessions)} / ${full(totals.projects)}`, sub: `${totals.models} 个模型 · ${totals.providers} 个供应商`, color: 'var(--accent-2)', ratio: 1 },
    { key: '日均用量', value: compact(totals.avgPerDay), sub: `${meta.activeDays} 个活跃天`, color: 'var(--accent)', ratio: 1 },
    { key: '估算费用', value: money(totals.cost), sub: `每日 ${money({ text: cents(totals.usd / Math.max(1, meta.activeDays), totals.cost.currency) })}`, color: 'var(--accent-3)', ratio: totals.pricedShare },
  ]);

  // ── 趋势：24H 用逐小时，其余用逐日 ──
  // 24H 区间下 byDay 只有 1 个点，画出来就是一根孤柱（等于没有图），所以换成小时序列。
  const isHourly = state.days === 1;
  const hourTotal = snapshot.hours.reduce((sum, value) => sum + value, 0) || 1;
  const points = isHourly
    ? snapshot.hours.map((total, hour) => ({
      key: String(hour),
      label: String(hour).padStart(2, '0'),
      title: `${String(hour).padStart(2, '0')}:00 – ${String((hour + 1) % 24).padStart(2, '0')}:00`,
      total,
      share: total / hourTotal,
    }))
    : snapshot.byDay.map((day) => ({
      key: day.day,
      label: shortDay(day.day),
      title: day.day,
      total: day.total,
      input: day.input,
      output: day.output,
      cacheRead: day.cacheRead,
      requests: day.requests,
      cost: day.cost,
    }));
  state.trend = { points, hourly: isHourly };

  $('trendGrid').classList.toggle('grid--single', isHourly);
  $('trendTitle').textContent = isHourly ? '每小时用量' : '每日用量趋势';
  $('trendLegend').innerHTML = isHourly
    ? '<span><i style="background:var(--accent)"></i>逐小时总量</span>'
    : '<span><i style="background:var(--accent)"></i>每日总量</span><span><i style="background:rgba(167,139,250,.55)"></i>其中缓存读</span>';
  renderTrend($('trendChart'), points, { hourly: isHourly });

  const peakHour = snapshot.hours.indexOf(Math.max(...snapshot.hours));
  if (isHourly) {
    $('trendFoot').textContent = `${meta.range.from} · 24 个时段 · 峰值 ${String(peakHour).padStart(2, '0')}:00（${compact(snapshot.hours[peakHour])} tokens）· 按本机时区`;
  } else {
    const busiest = [...snapshot.byDay].sort((a, b) => b.total - a.total)[0];
    $('trendFoot').textContent = `${meta.range.from} → ${meta.range.to} · ${snapshot.byDay.length} 天（${meta.activeDays} 天有数据）`
      + (busiest ? ` · 峰值 ${busiest.day}：${full(busiest.total)} tokens` : '');
  }

  // 24H 时上面那张就是逐小时的，这块面板会完全重复 → 隐藏并清空 DOM（不只是视觉隐藏）
  if (isHourly) {
    $('hoursChart').innerHTML = '';
    $('hoursFoot').textContent = '';
  } else {
    renderHours($('hoursChart'), snapshot.hours);
    $('hoursFoot').textContent = `最活跃时段 ${String(peakHour).padStart(2, '0')}:00–${String((peakHour + 1) % 24).padStart(2, '0')}:00 · 按本机时区`;
  }

  // 数据源
  renderSources($('sourceGrid'), snapshot.bySource, {
    activeSources: state.activeSources,
    onToggle: (id) => {
      if (state.activeSources.has(id)) state.activeSources.delete(id);
      else state.activeSources.add(id);
      refresh();
    },
  });

  // 模型 / 供应商 / 项目
  const total = totals.total || 1;
  $('modelCount').textContent = `${snapshot.byModel.length} 个模型`;
  renderRank($('modelRank'), snapshot.byModel.map((row) => ({
    label: shortModel(row.model, 34),
    total: row.total,
    cost: row.cost,
    price: row.price,
    sub: `${row.provider} · ${row.requests} 请求 · 缓存 ${pct(row.cacheHitRate, 0)}`,
    _base: total,
  })), { limit: 12, accent: 'var(--accent)' });

  $('projectCount').textContent = `${snapshot.byProject.length} 个项目`;
  renderRank($('projectRank'), snapshot.byProject.map((row) => ({
    label: row.project,
    total: row.total,
    cost: row.cost,
    price: {},
    sub: `${row.models} 模型 · ${row.requests} 请求`,
    _base: total,
  })), { limit: 12, accent: 'var(--accent-2)' });

  renderDonut($('providerDonut'), $('providerLegend'), snapshot.byProvider);

  // 热力图
  renderHeatmap($('heatmap'), snapshot.byDay, $('heatScale'));
  $('heatFoot').textContent = `色阶按非零日的分位数分级 · 共 ${snapshot.byDay.length} 天 · 点击色块无交互，悬停看当天明细`;

  // 实时流
  renderFeed($('feed'), snapshot.recent);

  // 背景模型名场：一个模型一个，用量越大字号越大
  renderModelField($('modelfield'), snapshot.byModel);

  // 页脚
  const scan = snapshot.scan ?? {};
  $('colophonLeft').textContent = `TOKEN NEXUS · 数据全部在本机解析，不上传任何内容 · ${snapshot.environment?.platform ?? ''} node ${snapshot.environment?.node ?? ''}`;
  $('colophonRight').textContent = `上次扫描 ${timeAgo(scan.finishedAt)} · ${scan.files ?? 0} 文件 / ${bytes(scan.totalBytes ?? 0)} · 耗时 ${duration(scan.durationMs ?? 0)}`
    + (scan.reusedFiles ? ` · 复用缓存 ${scan.reusedFiles}` : '');

  $('scanCount').textContent = state.scanning ? '扫描中…' : `${scan.files ?? 0} 文件`;

  // 首屏才播入场动画；之后的重绘不再重放，否则 5 秒一次的轮询会让整页反复"长出来"
  document.body.classList.add('is-ready');

  // 未定价的模型**不弹提示**。它已经在成本注释里写了占比，模型排行里也有「未定价」标签，
  // 每次渲染都弹一次只会变成噪音。
}

function cents(usd, currency) {
  const value = Number(usd) || 0;
  const symbol = currency === 'CNY' ? '¥' : '$';
  if (value >= 1) return `${symbol}${value.toFixed(2)}`;
  return `${symbol}${value.toFixed(4)}`;
}

/** 本机时区的今天（与 server/usage.mjs 的 localDay 口径一致）。 */
function localTodayKey() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/* ────────────────────────── 数据刷新 ────────────────────────── */

/**
 * 快照指纹：数据真的变了才重绘。
 *
 * 5 秒轮询下，如果每次都整块重建 DOM，会有两个很烦的副作用：
 *   1. 卡片/排行榜的入场动画每 5 秒重放一次；
 *   2. 实时流和排行榜的滚动位置被重置回顶部。
 * 所以指纹没变时只更新状态灯，不碰 DOM。
 */
function fingerprint(snapshot) {
  if (!snapshot) return '';
  return [
    snapshot.totals?.total ?? 0,
    snapshot.totals?.requests ?? 0,
    snapshot.scan?.finishedAt ?? 0,
    snapshot.byDay?.length ?? 0,
    snapshot.bySource?.length ?? 0,
    state.days,
    [...state.activeSources].sort().join(','),
  ].join('|');
}

async function refresh({ silent = false } = {}) {
  try {
    const snapshot = await api.getSnapshot({ days: state.days, sources: [...state.activeSources] });
    const next = fingerprint(snapshot);
    const changed = next !== state.fingerprint;
    state.fingerprint = next;

    if (changed || !state.rendered) {
      render(snapshot);
      state.rendered = true;
    } else {
      state.snapshot = snapshot; // 数据没变，但保留最新快照对象（供主题切换重绘用）
    }

    // 状态保持期内不要覆盖状态灯。
    // 否则 scan/end 之后紧接着的 refresh() 会立刻把"扫描中"打回"就绪"，
    // 最短可见时长就失效了（增量扫描本来只有 0.1 秒，等于完全看不见）。
    if (Date.now() >= state.statusHoldUntil) {
      if (snapshot.status === 'scanning') setStatus('scanning', '扫描中');
      else setStatus(snapshot.lastError ? 'error' : 'ready', snapshot.lastError ? '有错误' : '就绪');
    }

    // 注意：这里**不能**用服务端状态去覆盖 state.scanning。
    // 1 秒保鲜窗口下后台扫描几乎每秒都在跑，一旦被覆盖成 true，
    // 用户点「扫描」就会被误判成"已经在跑了"而静默跳过。
    // 服务端是否忙碌单独记一个字段，只用于展示。
    state.serverBusy = snapshot.status === 'scanning';
    $('scanBtn').disabled = state.scanning;
    return snapshot;
  } catch (error) {
    // 渲染过程中的异常也要暴露出来，否则界面会停在半渲染状态却毫无提示
    state.lastRenderError = `${error?.message ?? error}`;
    console.error('[render] 渲染失败：', error);
    setStatus('error', '渲染出错');
    if (!silent) toast(`渲染失败：${error.message}`, 'error', 8000);
    return null;
  }
}

function scheduleRefresh() {
  clearTimeout(state.renderTimer);
  state.renderTimer = setTimeout(() => refresh({ silent: true }), 220);
}

/* ────────────────────────── 扫描 ────────────────────────── */

async function triggerScan(force = true) {
  if (state.scanning) {
    toast('扫描已经在跑了', 'info');
    return;
  }
  state.scanning = true;
  setStatus('scanning', '扫描中');
  $('scanBtn').disabled = true;
  term(`SCAN REQUEST force=${force}`, 'terminal__hi');
  try {
    await api.startScan({ force });
  } catch (error) {
    state.scanning = false;
    $('scanBtn').disabled = false;
    toast(`无法启动扫描：${error.message}`, 'error');
  }
}

function onScanEvent(event) {
  switch (event.type) {
    case 'scan/start':
      state.totalFiles = 0;
      state.filesDone = 0;
      // 后台保鲜扫描（TTL 到期触发的）不抢状态灯、不刷终端 —— 否则 5 秒一次会把遥测面板刷满
      state.quietScan = event.reason === 'ttl';
      if (state.quietScan) break;
      state.scanning = true;
      state.scanStartedAt = Date.now();
      setStatus('scanning', '扫描中');
      $('scanBtn').disabled = true;
      term(`SCAN START reason=${event.reason}`, 'terminal__hi');
      break;
    case 'scan/plan':
      state.totalFiles = event.files;
      state.filesDone = event.reusableFiles ?? 0;
      if (state.quietScan && event.dirtyFiles === 0) break;
      term(`PLAN ${event.files} 文件（重扫 ${event.dirtyFiles} / 复用 ${event.reusableFiles}${event.resumableFiles ? ` / 续读 ${event.resumableFiles}` : ''}）· ${bytes(event.totalBytes)} · ${event.workers} workers`);
      if (event.dirtyFiles === 0) term('全部命中缓存，零解析', 'terminal__ok');
      else if (event.resumableFiles > 0) term(`其中 ${event.resumableFiles} 个只需读新增的 ${bytes(event.resumeBytes)}，不再重解整个文件`, 'terminal__ok');
      for (const error of event.enumerationErrors ?? []) term(`枚举警告 ${error.source}: ${error.error}`, 'terminal__warn');
      break;
    case 'scan/file': {
      state.filesDone = event.done;
      const short = String(event.path).split(/[\\/]/).slice(-2).join('/');
      const kind = event.events > 0 ? 'terminal__ok' : '';
      const mode = event.resumed ? 'TAIL' : 'READ';
      term(`${mode} ${short} 读 ${bytes(event.bytesRead ?? event.size)} → ${event.events} 事件 · ${compact(event.tokens)} tokens · ${duration(event.ms)}`, kind);
      $('scanCount').textContent = `${event.done}/${event.total} · ${pct(event.done / (event.total || 1), 0)}`;
      break;
    }
    case 'scan/note':
      term(event.message, 'terminal__warn');
      break;
    case 'scan/end': {
      state.scanning = false;
      $('scanBtn').disabled = false;
      // 后台保鲜且没有任何文件变化时不打日志（常见情况：日志没动）
      if (!state.quietScan || event.parsedFiles > 0) {
        term(`SCAN DONE ${event.files} 文件（解析 ${event.parsedFiles} / 复用 ${event.reusedFiles}）· ${duration(event.durationMs)}`, 'terminal__hi');
      }
      const wasQuiet = state.quietScan;
      state.quietScan = false;
      refresh({ silent: true });
      // 增量扫描常常只要 0.1 秒，"扫描中"会一闪而过、呼吸动画根本看不清。
      // 手动扫描的最短可见时间兜到 900ms，让状态变化真的能被感知。
      const elapsed = Date.now() - (state.scanStartedAt || 0);
      const hold = wasQuiet ? 0 : Math.max(0, 900 - elapsed);
      state.statusHoldUntil = Date.now() + hold;
      setTimeout(() => {
        state.statusHoldUntil = 0;
        setStatus('ready', '就绪');
      }, hold);
      break;
    }
    default:
      break;
  }
}

/* ────────────────────────── 开机自检 ────────────────────────── */

async function boot() {
  const lines = $('bootLines');
  const bar = $('bootBar');
  const push = (html) => {
    const row = document.createElement('div');
    row.innerHTML = html;
    lines.appendChild(row);
    while (lines.childElementCount > 8) lines.removeChild(lines.firstChild);
  };

  const bootEnabled = state.config?.ui?.boot !== false;
  if (!bootEnabled) {
    $('boot').classList.add('is-done');
    document.body.classList.remove('booting');
    return;
  }

  const started = Date.now();
  const steps = [];
  steps.push(['NEXUS KERNEL v1.0.0 · 冷启动', '']);
  steps.push([`运行时 <b>node ${state.sources?.environment?.node ?? ''}</b> · ${state.sources?.environment?.platform ?? ''}/${state.sources?.environment?.arch ?? ''}`, '']);
  steps.push([`配置 <b>${escapeHtml(state.configPath ?? '')}</b>`, '']);
  const localCount = state.sources?.local?.filter((row) => row.exists.some((p) => p.exists)).length ?? 0;
  steps.push([`探测数据源 <b>${localCount}</b> / ${state.sources?.local?.length ?? 0} 个可用`, '']);
  steps.push([`缓存索引 <b>${state.health?.cache?.entries ?? 0}</b> 文件 · ${bytes(state.health?.cache?.cacheBytes ?? 0)}`, '']);
  steps.push(['装载价格表 <b>OK</b>', '']);
  steps.push(['就绪', '']);

  for (let i = 0; i < steps.length; i += 1) {
    push(steps[i][0]);
    bar.style.width = `${((i + 1) / steps.length) * 100}%`;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, 130 - (Date.now() - started) / steps.length / 3)));
  }
  await new Promise((resolve) => setTimeout(resolve, 180));
  $('boot').classList.add('is-done');
  document.body.classList.remove('booting');
}

/* ────────────────────────── 主题 ────────────────────────── */

const THEME_ICONS = {
  // 月亮 = 当前是深色（点击切到浅色）；太阳 = 当前是浅色
  dark: '<path d="M15.5 11.5A6 6 0 0 1 8.5 4.5a6 6 0 1 0 7 7Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
  light: '<circle cx="10" cy="10" r="3.6" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M10 1.6v2.2M10 16.2v2.2M18.4 10h-2.2M3.8 10H1.6M16 4l-1.6 1.6M5.6 14.4 4 16M16 16l-1.6-1.6M5.6 5.6 4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
};

function applyTheme(theme, { persist = false } = {}) {
  const next = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  const icon = $('themeIcon');
  if (icon) icon.innerHTML = THEME_ICONS[next];
  // 浅色的干净背景不要星空；深色才开粒子场。
  // **必须先 stop 旧的那条 rAF 循环再新建**：不然每调用一次 applyTheme
  // （开机一次 + 每次切主题）就会多一条整屏重绘的粒子循环叠在同一个画布上 ——
  // 以前开机就有两条，切几次主题能叠到四五条，是最实在的掉帧来源之一。
  state.field?.stop();
  if (next === 'dark' && !document.body.classList.contains('no-particles')) {
    state.field = startField($('field'), { enabled: true });
  }
  if (persist) {
    api.saveConfig({ ui: { theme: next } })
      .then(() => toast(`已切换到${next === 'light' ? '浅色' : '深色'}主题`, 'ok', 1800))
      .catch((error) => toast(`主题保存失败：${error.message}`, 'error'));
  }
}

/* ────────────────────────── 初始化 ────────────────────────── */

async function init() {
  // 这里**不**先 startField：applyTheme() 会按主题和 particles 配置决定要不要开，
  // 先开一次再在 applyTheme 里重开就会叠出第二条 rAF 循环（每条都整屏重绘）。
  state.field = { stop() {} };

  // 时间范围
  $('rangeSeg').addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    for (const sibling of $('rangeSeg').children) sibling.classList.remove('is-active');
    button.classList.add('is-active');
    state.days = Number(button.dataset.days);
    refresh();
  });

  $('themeBtn').addEventListener('click', () => {
    const next = (document.documentElement.dataset.theme ?? 'dark') === 'dark' ? 'light' : 'dark';
    applyTheme(next, { persist: true });
    // 主题色变了，图表里的渐变色阶需要重画
    if (state.snapshot) {
      render(state.snapshot);
    }
  });

  $('scanBtn').addEventListener('click', () => triggerScan(true));
  $('settingsBtn').addEventListener('click', () => mountSettings.open());

  // 先拿配置/健康信息（开机动画要用真实数字），再拉快照
  const [config, sources, health] = await Promise.all([
    api.getConfig().catch(() => null),
    api.getSources().catch(() => null),
    api.health().catch(() => null),
  ]);
  state.config = config?.config ?? null;
  state.configPath = config?.configPath ?? '';
  state.sources = sources;
  state.health = health;

  if (state.config?.ui?.particles === false) {
    document.body.classList.add('no-particles');
    state.field?.stop();
  }
  if (state.config?.ui?.reducedMotion) document.body.classList.add('no-motion');
  // 先判粒子再定主题：applyTheme 会按主题决定要不要开星空
  applyTheme(state.config?.ui?.theme ?? 'dark');

  // 配置里的 windowDays 决定默认时间范围（0 = 全部）
  const defaultDays = Number(state.config?.windowDays);
  if (Number.isFinite(defaultDays) && defaultDays >= 0) {
    state.days = defaultDays;
    for (const button of $('rangeSeg').children) {
      button.classList.toggle('is-active', Number(button.dataset.days) === defaultDays);
    }
  }

  mountSettings.setup({ state, refresh, toast, term });
  mountSettings.apply(config?.config);

  await boot();

  await refresh();
  term('NEXUS 控制台就绪，等待遥测…', 'terminal__ok');

  // 调试句柄：在浏览器控制台里可以直接看 state / 手动重刷，方便排查
  window.tokenNexus = {
    state,
    refresh,
    scan: triggerScan,
    get snapshot() { return state.snapshot; },
  };

  api.connectEvents({
    onEvent: onScanEvent,
    onOpen: () => term('SSE 遥测通道已连接', 'terminal__ok'),
    onError: () => { /* EventSource 会自己重连 */ },
  });

  setInterval(() => { $('clockPill').textContent = clock(); }, 1000);
  $('clockPill').textContent = clock();

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.trend) renderTrend($('trendChart'), state.trend.points, { hourly: state.trend.hourly });
      if (state.snapshot) renderHeatmap($('heatmap'), state.snapshot.byDay, $('heatScale'));
    }, 220);
  });

  // 定期静默刷新（新会话随时在写日志）。间隔由配置决定，默认 5 秒。
  const pollMs = Math.max(1000, Number(state.config?.refreshMs) || 5000);
  setInterval(() => { if (!state.scanning) refresh({ silent: true }); }, pollMs);
  term(`自动刷新间隔 ${pollMs / 1000}s · 服务端保鲜窗口 ${Math.round((Number(state.config?.cacheTtlMs) || 5000) / 1000)}s`, 'terminal__ok');

  document.addEventListener('keydown', (event) => {
    if (event.key === 'r' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      triggerScan(false);
    }
    if (event.key === 'Escape') mountSettings.close();
  });
}

init().catch((error) => {
  console.error(error);
  document.body.classList.remove('booting');
  $('boot')?.classList.add('is-done');
  toast(`初始化失败：${error.message}`, 'error', 8000);
});

export { state, refresh, toast, term };
