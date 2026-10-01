/**
 * widgets.js —— 全部可视化组件
 * 只用 DOM + 内联 SVG，零图表库。所有进场动画走 CSS class（is-in），
 * 数值更新走 transition，所以「刷新数据」不会闪一下重画。
 */
import { compact, full, money, pct, clockShort, bytes } from './format.js';

const NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * 进场动画只播一次。
 *
 * 组件每次 render 都是新建 DOM，如果无脑从 0 开始过渡，那么 30 秒一次的自动刷新
 * 会让所有条形反复"重新长出来"—— 看起来像闪了一下、而且数值没变。
 * 这里按 key 记住上一次的目标值：
 *   · 首次出现  → 0 → 目标（播进场动画）
 *   · 数值没变  → 直接落位（禁用过渡）
 *   · 数值变了  → 上一次 → 目标（平滑过渡）
 */
const barMemory = new Map();

function setBar(node, key, fraction, { vertical = false, min = 0 } = {}) {
  if (!node) return;
  const target = Math.max(min, Math.min(100, (Number(fraction) || 0) * 100));
  const previous = barMemory.get(key);
  barMemory.set(key, target);
  const apply = (value) => {
    if (vertical) node.style.height = `${value}%`;
    else node.style.width = `${value}%`;
  };
  if (previous === undefined) {
    apply(0);
    requestAnimationFrame(() => apply(target));
    return;
  }
  if (Math.abs(previous - target) < 0.05) {
    // 数值没变：落位但不播动画，避免每次刷新都重放
    node.style.transition = 'none';
    apply(target);
    void node.offsetWidth; // 强制一次样式重算，让 transition:none 生效
    node.style.transition = '';
    return;
  }
  apply(previous);
  requestAnimationFrame(() => apply(target));
}

/* ────────────────────────── 数字滚轮 ────────────────────────── */

/**
 * 巨型计数器。数字位数不变时复用同一批 DOM，靠 CSS transition 滚动进位，
 * 所以从 7,115,964,704 涨到 7,116,324,844 只会滚动变化的几位。
 *
 * 颜色与辉光全部交给 CSS（白字 + 恒定 drop-shadow）：数字本身不在这里上色，
 * 只负责换位与进位。
 *
 * @returns {boolean} 数值是否发生了变化（首次渲染返回 false）—— 目前仅作调试/断言用，
 *   数字变化**不触发任何闪光**
 */
export function renderOdometer(container, value) {
  const text = full(value);
  const rounded = Math.round(Number(value) || 0);
  const previous = container.dataset.value;
  const changed = Boolean(previous) && previous !== String(rounded);
  container.dataset.value = String(rounded); // 同时供无头测试断言
  const chars = [...text];
  // 用「数字/逗号」的形状指纹判断能否复用已有 DOM：位数或分组位置一变就重建。
  const shape = chars.map((char) => (char === ',' ? ',' : '#')).join('');
  const reusable = container.dataset.shape === shape
    && container.childElementCount === chars.length;

  if (!reusable) {
    clear(container);
    chars.forEach((char) => {
      if (char === ',') {
        const sep = document.createElement('span');
        sep.className = 'odo-sep';
        sep.textContent = ',';
        container.appendChild(sep);
        return;
      }
      const col = document.createElement('span');
      col.className = 'odo-col';
      const strip = document.createElement('span');
      strip.className = 'odo-strip';
      for (let d = 0; d <= 9; d += 1) {
        const digit = document.createElement('span');
        digit.textContent = String(d);
        strip.appendChild(digit);
      }
      col.appendChild(strip);
      container.appendChild(col);
    });
    container.dataset.shape = shape;
  }

  // 渐变切面那套（--g-total / --gflow / --gb）已随"白色发光"改版一起删掉：
  // 数字现在就是白字 + 恒定辉光，不需要按列切渐变，也省掉每次刷新的宽度测量。

  // 必须按「字符下标」对齐 children —— children 里**包含逗号分隔节点**，
  // 只数数字位会让索引错位，第一个逗号上取到的是文本节点，`.style` 为 undefined
  // 直接抛 TypeError，整个渲染就断在这里（曾经导致除英雄区外全空）。
  for (let index = 0; index < chars.length; index += 1) {
    if (chars[index] === ',') continue;
    const col = container.children[index];
    const strip = col?.firstElementChild;
    if (!strip) continue;
    strip.style.transform = `translateY(${-Number(chars[index])}em)`;
  }
  return changed;
}

/* ────────────────────────── 主题色读取 ────────────────────────── */

/** 从 CSS 变量取当前主题色（SVG 的 stop-color / 内联样式没法直接用 var()）。 */
function cssColor(name, fallback = '#35d6ff') {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return raw || fallback;
}

function isDarkTheme() {
  return (document.documentElement.dataset.theme ?? 'dark') === 'dark';
}

function toRgb(color) {
  const hex = String(color).trim().replace('#', '');
  if (hex.length === 6) {
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }
  if (hex.length === 3) return [...hex].map((c) => parseInt(c + c, 16));
  const match = String(color).match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (match) return [Number(match[1]), Number(match[2]), Number(match[3])];
  return [53, 214, 255];
}

function rgba(color, alpha) {
  const [r, g, b] = toRgb(color);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/* ────────────────────────── 环形仪表 ────────────────────────── */

const GAUGE_R = 42;
const GAUGE_C = 2 * Math.PI * GAUGE_R;
let gaugeSeq = 0;

/**
 * 渐变配色（按设计规格）：
 *   cache  青绿 → 翠绿    input  琥珀 → 橙
 *   output 霓虹紫 → 品红   priced 电光蓝 → 青
 */
const GAUGE_GRADIENTS = {
  cache: ['#2dd4bf', '#34d399'],
  input: ['#fbbf24', '#fb923c'],
  output: ['#b06bff', '#f472b6'],
  priced: ['#38bdf8', '#22d3ee'],
};

/**
 * 环形仪表。
 * 外层 `.gauge` 包裹是**必须的** —— SVG 的宽高由 CSS `.gauge svg` 决定，
 * 少了这层，内联 SVG 在 flex 容器里没有固有尺寸，会塌成 0 宽（元素存在但看不见）。
 */
export function gaugeMarkup({ value = 0, display = '—', caption = '', label = '', gradient = 'cache' }) {
  const safe = Math.max(0, Math.min(1, Number(value) || 0));
  const [from, to] = GAUGE_GRADIENTS[gradient] ?? GAUGE_GRADIENTS.cache;
  const id = `gaugeGrad${gaugeSeq}`;
  gaugeSeq += 1;
  return `
    <div class="gauge">
      <svg viewBox="0 0 104 104" role="img" aria-label="${label || caption} ${display}">
        <defs>
          <linearGradient id="${id}" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="${from}"/>
            <stop offset="100%" stop-color="${to}"/>
          </linearGradient>
        </defs>
        <circle class="gauge__track" cx="52" cy="52" r="${GAUGE_R}" fill="none" stroke-width="8"/>
        <circle class="gauge__value" cx="52" cy="52" r="${GAUGE_R}" fill="none" stroke="url(#${id})" stroke-width="8"
                stroke-linecap="round" stroke-dasharray="${GAUGE_C.toFixed(2)}"
                stroke-dashoffset="${(GAUGE_C * (1 - safe)).toFixed(2)}"/>
        <g transform="rotate(90 52 52)">
          <text class="gauge__num" x="52" y="53" text-anchor="middle" dominant-baseline="middle">${display}</text>
          <text class="gauge__cap" x="52" y="72" text-anchor="middle">${caption}</text>
        </g>
      </svg>
      <div class="gauge__label">${label || caption}</div>
    </div>`;
}

/* ────────────────────────── 趋势（日 / 小时通用） ────────────────────────── */

/**
 * 用量趋势图。
 *
 * @param {Array<{key:string,label:string,total:number,cacheRead?:number,input?:number,
 *                output?:number,requests?:number,cost?:object}>} points
 * @param {{hourly?:boolean}} options hourly=true 时 x 轴按小时显示（24H 视图用）
 *
 * 一个实现覆盖两种视图：24H 时 byDay 只有一个点，画出来就是孤零零一根柱子，
 * 所以小时间隔的区间改用逐小时数据 —— 同一个图表函数，只是喂进去的序列不同。
 */
export function renderTrend(container, points, { hourly = false } = {}) {
  container.innerHTML = '';
  if (!points || points.length === 0) {
    container.innerHTML = '<div class="empty">所选区间内没有数据</div>';
    return;
  }
  if (container._tooltip) container._tooltip.remove();

  const width = Math.max(360, container.clientWidth || 720);
  const height = hourly ? 230 : 250;
  const pad = { top: 18, right: 16, bottom: 28, left: 58 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  const maxTotal = Math.max(1, ...points.map((p) => p.total));
  const maxCache = Math.max(0, ...points.map((p) => p.cacheRead ?? 0));
  const showBars = maxCache > 0;
  const scale = niceMax(Math.max(maxTotal, maxCache));

  const x = (index) => pad.left + (points.length === 1 ? innerW / 2 : (index / (points.length - 1)) * innerW);
  const y = (value) => pad.top + innerH - (value / scale) * innerH;

  const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img' });
  svg.setAttribute('aria-label', hourly ? '每小时 token 用量' : '每日 token 用量趋势');

  const defs = svgEl('defs');
  const accent = cssColor('--accent');
  const gradient = svgEl('linearGradient', { id: 'trendFill', x1: '0', y1: '0', x2: '0', y2: '1' });
  gradient.appendChild(svgEl('stop', { offset: '0%', 'stop-color': accent, 'stop-opacity': isDarkTheme() ? '0.34' : '0.22' }));
  gradient.appendChild(svgEl('stop', { offset: '100%', 'stop-color': accent, 'stop-opacity': '0.01' }));
  defs.appendChild(gradient);
  svg.appendChild(defs);

  // 横向网格 + 刻度
  const ticks = 4;
  for (let i = 0; i <= ticks; i += 1) {
    const value = (scale / ticks) * i;
    const py = y(value);
    svg.appendChild(svgEl('line', { class: 'grid-line', x1: pad.left, y1: py, x2: width - pad.right, y2: py }));
    const label = svgEl('text', { class: 'axis-label', x: pad.left - 10, y: py + 3.5, 'text-anchor': 'end' });
    label.textContent = compact(value, 1);
    svg.appendChild(label);
  }

  // 缓存读柱（是每日总量的一部分，所以不会误导；24H 没有明细就不画）
  if (showBars) {
    const barW = Math.max(2, Math.min(16, (innerW / points.length) * 0.55));
    points.forEach((point, index) => {
      const cacheRead = point.cacheRead ?? 0;
      if (cacheRead <= 0) return;
      const barHeight = Math.max(1, (cacheRead / scale) * innerH);
      svg.appendChild(svgEl('rect', {
        class: 'trend-bar',
        x: x(index) - barW / 2,
        y: pad.top + innerH - barHeight,
        width: barW,
        height: barHeight,
        rx: 1.5,
      }));
    });
  }

  // 面积 + 折线
  const coords = points.map((point, index) => `${x(index).toFixed(1)},${y(point.total).toFixed(1)}`);
  const baseline = (pad.top + innerH).toFixed(1);
  const areaPath = `M ${x(0).toFixed(1)},${baseline} L ${coords.join(' L ')} L ${x(points.length - 1).toFixed(1)},${baseline} Z`;
  const linePath = coords.length === 1 ? `M ${coords[0]} L ${coords[0]}` : `M ${coords.join(' L ')}`;

  const area = svgEl('path', { class: 'trend-area', d: areaPath });
  const line = svgEl('path', { class: 'trend-line', d: linePath });
  svg.appendChild(area);
  svg.appendChild(line);

  // 单点序列：折线画不出形，补一个实心点，避免看起来像空白
  if (points.length === 1) {
    svg.appendChild(svgEl('circle', { class: 'trend-dot', cx: x(0), cy: y(points[0].total), r: 5 }));
  }

  // X 轴标签
  const labelStep = hourly ? 3 : Math.max(1, Math.ceil(points.length / 8));
  points.forEach((point, index) => {
    const isLast = index === points.length - 1;
    if (index % labelStep !== 0 && !isLast) return;
    if (hourly && isLast && index % labelStep !== 0) return; // 小时轴太挤时略过末位
    const label = svgEl('text', {
      class: 'axis-label', x: x(index), y: height - 9, 'text-anchor': 'middle',
    });
    label.textContent = point.label;
    svg.appendChild(label);
  });

  // 悬停
  const hoverLine = svgEl('line', { class: 'hover-line', y1: pad.top, y2: pad.top + innerH });
  const hoverDot = svgEl('circle', { class: 'hover-dot', r: 4 });
  svg.appendChild(hoverLine);
  svg.appendChild(hoverDot);

  const tooltip = document.createElement('div');
  tooltip.className = 'tooltip';
  container.appendChild(svg);
  container.appendChild(tooltip);
  container._tooltip = tooltip;

  const overlay = svgEl('rect', {
    x: pad.left, y: pad.top, width: innerW, height: innerH, fill: 'transparent', style: 'cursor:crosshair',
  });
  svg.appendChild(overlay);

  overlay.addEventListener('mousemove', (event) => {
    const rect = svg.getBoundingClientRect();
    const scaleX = width / rect.width;
    const localX = (event.clientX - rect.left) * scaleX;
    const ratio = (localX - pad.left) / (innerW || 1);
    const index = Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1))));
    const point = points[index];
    const px = x(index);
    const py = y(point.total);
    hoverLine.setAttribute('x1', px);
    hoverLine.setAttribute('x2', px);
    hoverLine.style.opacity = '0.55';
    hoverDot.setAttribute('cx', px);
    hoverDot.setAttribute('cy', py);
    hoverDot.style.opacity = '1';

    const lines = [point.title ?? point.label];
    lines.push(`总 <b>${full(point.total)}</b>`);
    if (point.input !== undefined) {
      lines.push(`输入 ${compact(point.input)} · 输出 ${compact(point.output)}`);
      lines.push(`缓存读 ${compact(point.cacheRead ?? 0)}`);
      lines.push(`请求 ${full(point.requests ?? 0)} · ${money(point.cost)}`);
    } else {
      lines.push(`占比 ${pct(point.share ?? 0, 1)}`);
    }
    tooltip.innerHTML = lines.join('<br>');

    // tooltip 是 SVG 的 HTML 兄弟节点，必须用容器的 CSS 像素坐标，
    // 不能用 SVG 用户坐标（会被 viewBox 缩放/偏移带歪）。
    const containerRect = container.getBoundingClientRect();
    tooltip.style.left = `${event.clientX - containerRect.left}px`;
    tooltip.style.top = `${event.clientY - containerRect.top}px`;
    tooltip.classList.add('is-on');
  });
  overlay.addEventListener('mouseleave', () => {
    hoverLine.style.opacity = '0';
    hoverDot.style.opacity = '0';
    tooltip.classList.remove('is-on');
  });

  requestAnimationFrame(() => {
    const length = line.getTotalLength();
    line.style.setProperty('--len', length.toFixed(1));
    area.classList.add('is-in');
    line.classList.add('is-in');
  });
}

function niceMax(value) {
  if (value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const normalized = value / base;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * base;
}

/* ────────────────────────── 24 小时分布 ────────────────────────── */

export function renderHours(container, hours) {
  container.innerHTML = '';
  const max = Math.max(1, ...hours);
  for (let hour = 0; hour < 24; hour += 1) {
    const value = hours[hour] ?? 0;
    const cell = document.createElement('div');
    cell.className = 'hour';
    cell.title = `${String(hour).padStart(2, '0')}:00 — ${full(value)} tokens`;
    const bar = document.createElement('div');
    bar.className = 'hour__bar';
    bar.style.height = '2px';
    const label = document.createElement('span');
    label.className = 'hour__k';
    label.textContent = hour % 3 === 0 ? String(hour).padStart(2, '0') : '';
    cell.appendChild(bar);
    cell.appendChild(label);
    container.appendChild(cell);
    setBar(bar, `hour:${hour}`, value / max, { vertical: true, min: 1 });
  }
}

/* ────────────────────────── 供应商甜甜圈 ────────────────────────── */

/** 两套配色：深色用霓虹，浅色用饱和但不刺眼的印刷色。 */
const DONUT_COLORS_DARK = [
  '#35d6ff', '#b06bff', '#34e2a4', '#fbbf24', '#fb7185',
  '#38bdf8', '#c084fc', '#4ade80', '#facc15', '#f472b6',
];
const DONUT_COLORS_LIGHT = [
  '#0d9488', '#7c3aed', '#059669', '#d97706', '#e11d48',
  '#0284c7', '#9333ea', '#16a34a', '#ca8a04', '#db2777',
];

export function renderDonut(container, legendEl, rows) {
  clear(container);
  const DONUT_COLORS = isDarkTheme() ? DONUT_COLORS_DARK : DONUT_COLORS_LIGHT;
  const top = rows.slice(0, 8);
  const restTotal = rows.slice(8).reduce((sum, row) => sum + row.total, 0);
  const segments = top.map((row, index) => ({
    label: row.name,
    value: row.total,
    cost: row.cost,
    color: DONUT_COLORS[index % DONUT_COLORS.length],
  }));
  if (restTotal > 0) segments.push({ label: '其他', value: restTotal, color: isDarkTheme() ? '#55647c' : '#94a3b8' });

  const total = segments.reduce((sum, segment) => sum + segment.value, 0) || 1;
  const r = 82;
  const circumference = 2 * Math.PI * r;
  const svg = svgEl('svg', { viewBox: '0 0 216 216', role: 'img' });
  svg.setAttribute('aria-label', '按供应商的 token 占比');

  let offset = 0;
  for (const segment of segments) {
    const length = (segment.value / total) * circumference;
    const circle = svgEl('circle', {
      class: 'donut__seg',
      cx: 108, cy: 108, r,
      fill: 'none',
      stroke: segment.color,
      'stroke-width': 20,
      'stroke-dasharray': `0 ${circumference}`,
      'stroke-dashoffset': -offset,
    });
    const title = svgEl('title');
    title.textContent = `${segment.label} — ${full(segment.value)} (${pct(segment.value / total)})`;
    circle.appendChild(title);
    svg.appendChild(circle);
    const target = `${length} ${circumference - length}`;
    requestAnimationFrame(() => {
      circle.setAttribute('stroke-dasharray', target);
    });
    offset += length;
  }

  const center = document.createElement('div');
  center.className = 'donut__center';
  center.innerHTML = `<div class="donut__num">${segments.length}</div><div class="donut__cap">PROVIDERS</div>`;

  container.appendChild(svg);
  container.appendChild(center);

  if (legendEl) {
    legendEl.innerHTML = segments.map((segment) => (
      `<span><i style="background:${segment.color}"></i>${segment.label} ${pct(segment.value / total, 1)}</span>`
    )).join('');
  }
}

/* ────────────────────────── 排行榜 ────────────────────────── */

export function renderRank(container, rows, { limit = 12, accent = 'var(--accent)' } = {}) {
  clear(container);
  if (rows.length === 0) {
    container.innerHTML = '<div class="empty">没有数据</div>';
    return;
  }
  const max = Math.max(...rows.map((row) => row.total)) || 1;
  rows.slice(0, limit).forEach((row, index) => {
    const node = document.createElement('div');
    node.className = 'rank__row';
    node.style.setProperty('--i', `${Math.min(index * 22, 400)}ms`);

    const tags = [];
    if (!row.price) tags.push('<span class="tag tag--warn">未定价</span>');
    else if (row.price.confidence === 'low') tags.push('<span class="tag tag--warn">低置信</span>');
    if (row.price?.layer === 'override') tags.push('<span class="tag tag--accent">自定义价</span>');
    if (row.price?.layer === 'remote') tags.push('<span class="tag tag--accent">实时价</span>');

    node.innerHTML = `
      <span class="rank__idx">${String(index + 1).padStart(2, '0')}</span>
      <span class="rank__name">
        <b title="${escapeAttr(row.label ?? row.model ?? row.name ?? row.project)}">${row.label ?? row.model ?? row.name ?? row.project}</b>
        <span class="rank__sub">${row.sub ?? ''} ${tags.join(' ')}</span>
        <span class="rank__track"><span class="rank__fill" style="width:0;background:${accent}"></span></span>
      </span>
      <span class="rank__val">${compact(row.total)}<br><span class="rank__cost">${pct(row.total / (row._base ?? max * 1), 1)}</span></span>
      <span class="rank__cost">${money(row.cost)}</span>`;
    container.appendChild(node);
    setBar(node.querySelector('.rank__fill'), `rank:${row.label ?? row.model}`, row.total / max, { min: 1 });
  });
}

function escapeAttr(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ────────────────────────── 热力图 ────────────────────────── */

export function renderHeatmap(container, byDay, scaleEl) {
  clear(container);
  if (!byDay || byDay.length === 0) {
    container.innerHTML = '<div class="empty">没有数据</div>';
    return;
  }

  const map = new Map(byDay.map((d) => [d.day, d]));
  const last = new Date(`${byDay[byDay.length - 1].day}T00:00:00`);
  const first = new Date(`${byDay[0].day}T00:00:00`);

  // 对齐到「周一」起点
  const end = new Date(last);
  end.setDate(end.getDate() + ((7 - ((end.getDay() + 6) % 7) - 1 + 7) % 7));
  const start = new Date(first);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));

  const totalDays = Math.round((end - start) / 86400000) + 1;
  const weeks = Math.min(53, Math.ceil(totalDays / 7));

  // 格子大小按可用宽度自适应：30 天只有几列时，固定尺寸会让整块面板空出一大片。
  // 下限从 12px 提到 16px —— 设计规格要求「更大的格子」。
  const CELL_GAP = 5;
  const available = Math.max(260, (container.clientWidth || 900) - 40);
  const accent = cssColor('--accent');
  const dark = isDarkTheme();
  const cell = Math.max(16, Math.min(34, Math.floor(available / weeks) - CELL_GAP));
  container.style.setProperty('--cell', `${cell}px`);
  container.style.setProperty('--cell-gap', `${CELL_GAP}px`);
  const columnWidth = cell + CELL_GAP;

  const values = byDay.map((d) => d.total);
  const max = Math.max(1, ...values);
  const sorted = [...values].filter((v) => v > 0).sort((a, b) => a - b);
  const quartile = (q) => sorted.length === 0 ? max : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  const thresholds = [quartile(0.25), quartile(0.5), quartile(0.75)];
  // 色阶由当前主题的强调色推出，浅色 / 深色各自都是协调的渐变
  const levels = [
    'transparent',
    rgba(accent, dark ? 0.26 : 0.20),
    rgba(accent, dark ? 0.48 : 0.42),
    rgba(accent, dark ? 0.72 : 0.68),
    accent,
  ];
  const levelOf = (value) => {
    if (value <= 0) return 0;
    if (value <= thresholds[0]) return 1;
    if (value <= thresholds[1]) return 2;
    if (value <= thresholds[2]) return 3;
    return 4;
  };

  const dayLabels = document.createElement('div');
  dayLabels.className = 'heat__days';
  dayLabels.innerHTML = '<span>一</span><span></span><span>三</span><span></span><span>五</span><span></span><span>日</span>';

  const body = document.createElement('div');
  body.className = 'heat__body';

  const monthRow = document.createElement('div');
  monthRow.className = 'heat__monthRow';
  const cols = document.createElement('div');
  cols.className = 'heat__cols';

  // 月份标签：先按「这一周属于哪个月」聚合，再按每周 12px 格 + 3px 间隙定宽。
  // 之前是新建标签时给 width:0、之后只给最后一个标签加宽，导致第一个月永远看不见。
  const monthSpans = [];
  for (let week = 0; week < weeks; week += 1) {
    const month = date0Month(start, week);
    const tail = monthSpans[monthSpans.length - 1];
    if (tail && tail.month === month) tail.weeks += 1;
    else monthSpans.push({ month, weeks: 1 });
  }
  for (const span of monthSpans) {
    const label = document.createElement('span');
    label.className = 'heat__month';
    label.textContent = `${span.month}月`;
    label.style.width = `${span.weeks * columnWidth}px`;
    monthRow.appendChild(label);
  }

  for (let week = 0; week < weeks; week += 1) {
    const column = document.createElement('div');
    column.className = 'heat__week';
    for (let day = 0; day < 7; day += 1) {
      const date = new Date(start);
      date.setDate(date.getDate() + week * 7 + day);
      // 必须用**本地**年月日拼 key：byDay[].day 是服务端按本机时区算出的 YYYY-MM-DD，
      // 而 toISOString() 会先转 UTC —— 在东八区会让整个热力图错开一天。
      const key = localDateKey(date);
      const entry = map.get(key);
      const cell = document.createElement('div');
      cell.className = 'heat__cell';
      cell.dataset.day = key;
      if (date < first || date > last) {
        cell.style.opacity = '0.3';
      }
      const value = entry?.total ?? 0;
      const level = levelOf(value);
      cell.dataset.level = String(level);
      // level 0 不写内联背景，留给 CSS 的 --track，避免格子「消失」
      if (level > 0) cell.style.background = levels[level];
      // 最高色阶在暗色下加一点辉光，符合「细胞发光」的规格
      if (dark && level === 4) cell.style.boxShadow = `0 0 12px ${rgba(accent, 0.55)}`;
      cell.title = `${key} — ${full(value)} tokens${entry ? ` · ${money(entry.cost)} · ${full(entry.requests)} 次请求` : ''}`;
      column.appendChild(cell);
    }
    cols.appendChild(column);
  }

  body.appendChild(monthRow);
  body.appendChild(cols);
  container.appendChild(dayLabels);
  container.appendChild(body);

  if (scaleEl) {
    scaleEl.innerHTML = `少 ${levels.map((color) => `<i style="background:${color}"></i>`).join('')} 多`;
  }
}

function date0Month(start, week) {
  const date = new Date(start);
  date.setDate(date.getDate() + week * 7);
  return date.getMonth() + 1;
}

/** 本机时区的 YYYY-MM-DD（与 server/usage.mjs 的 localDay 口径一致）。 */
function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/* ────────────────────────── 实时流 ────────────────────────── */

export function renderFeed(container, recent) {
  clear(container);
  if (!recent || recent.length === 0) {
    container.innerHTML = '<div class="empty">暂无记录</div>';
    return;
  }
  recent.slice(0, 40).forEach((row, index) => {
    const node = document.createElement('div');
    node.className = 'feed__row';
    node.style.animationDelay = `${Math.min(index * 14, 320)}ms`;
    node.innerHTML = `
      <span class="feed__t">${row.ts ? clockShort(row.ts) : '--:--'}</span>
      <span class="feed__m"><b>${escapeAttr(row.model)}</b> · ${escapeAttr(row.project)} · ${escapeAttr(row.provider)}</span>
      <span class="feed__v">${compact(row.total)}</span>`;
    container.appendChild(node);
  });
}

/* ────────────────────────── 指标条 ────────────────────────── */

export function renderMetrics(container, items) {
  clear(container);
  items.forEach((item) => {
    const node = document.createElement('div');
    node.className = 'metric';
    node.innerHTML = `
      <div class="metric__k">${item.key}</div>
      <div class="metric__v">${item.value}</div>
      <div class="metric__s">${item.sub ?? ''}</div>
      <div class="metric__bar" style="width:0;background:${item.color ?? 'var(--accent)'}"></div>`;
    container.appendChild(node);
    setBar(node.querySelector('.metric__bar'), `metric:${item.key}`, item.ratio ?? 1, { min: 2 });
  });
}

/* ────────────────────────── 数据源卡片 ────────────────────────── */

export function renderSources(container, sources, { activeSources, onToggle }) {
  clear(container);
  sources.forEach((source, index) => {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'source';
    node.style.setProperty('--src-accent', source.accent || 'var(--accent)');
    node.style.setProperty('--i', `${Math.min(index * 45, 420)}ms`);
    if (!source.enabled) node.classList.add('is-off');
    if (activeSources.size > 0) {
      node.classList.toggle('is-active', activeSources.has(source.id));
      if (!activeSources.has(source.id)) node.classList.add('is-dim');
    }

    const detected = source.detectedFiles ?? 0;
    const extra = source.extra ?? {};
    const notes = [];
    if (!source.enabled) notes.push('已在设置中关闭');
    else if (detected === 0) notes.push('未检测到本地数据');
    else if (source.total === 0) notes.push('已读取文件，但其中没有 token 记录');
    if (extra.codeHashes > 0 && source.total === 0) {
      notes.push(`检测到 ${full(extra.codeHashes)} 条 AI 代码记录（${Object.keys(extra.codeHashModels ?? {}).length} 个模型），但 Cursor 已不再本地写入 tokenCount`);
    }
    if (source.errors > 0) notes.push(`${source.errors} 个文件读取失败`);
    for (const warning of source.warnings ?? []) notes.push(warning);

    const share = `${pct(source.share ?? 0, 1)}`;
    node.innerHTML = `
      <div class="source__top">
        <span class="source__dot"></span>
        <span class="source__name">${source.label}</span>
        <span class="source__kind">${source.kind === 'cloud' ? 'CLOUD' : 'LOCAL'}</span>
      </div>
      <div class="source__value">${compact(source.total)}</div>
      <div class="source__unit">TOKENS · 占比 ${share}</div>
      <div class="source__bar"><i style="width:0"></i></div>
      <div class="source__meta">
        <span><b>${full(source.requests)}</b> 请求</span>
        <span><b>${full(source.sessions)}</b> 会话</span>
        <span><b>${detected}</b> 文件</span>
        <span><b>${bytes(source.detectedBytes)}</b></span>
        <span><b>${money(source.cost)}</b></span>
        <span>缓存 <b>${pct(source.cacheHitRate ?? 0, 0)}</b></span>
      </div>
      ${source.roots?.length ? `<div class="source__path" title="${escapeAttr(source.roots.map((r) => `${r.exists ? '✓' : '✗'} ${r.path}`).join('\n'))}">${source.roots.map((r) => `${r.exists ? '●' : '○'} ${r.path}`).join('   ')}</div>` : ''}
      ${notes.length ? `<div class="source__off">${notes.join(' · ')}</div>` : ''}`;

    node.addEventListener('click', () => onToggle(source.id));
    container.appendChild(node);
    setBar(node.querySelector('.source__bar i'), `source:${source.id}`, source.share ?? 0, {
      min: source.total > 0 ? 1.5 : 0,
    });
  });
}
