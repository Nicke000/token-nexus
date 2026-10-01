/** format.js —— 数字 / 时间 / 单位格式化 */

const UNITS = [
  { limit: 1e12, suffix: 'T' },
  { limit: 1e9, suffix: 'B' },
  { limit: 1e6, suffix: 'M' },
  { limit: 1e3, suffix: 'K' },
];

/** 7,113,169,111 → "7.11B" */
export function compact(value, digits = 2) {
  const n = Number(value) || 0;
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  for (const unit of UNITS) {
    if (abs >= unit.limit) {
      const scaled = abs / unit.limit;
      const d = scaled >= 100 ? Math.min(1, digits) : digits;
      return `${sign}${scaled.toFixed(d)}${unit.suffix}`;
    }
  }
  return `${sign}${abs < 10 && !Number.isInteger(abs) ? abs.toFixed(1) : Math.round(abs)}`;
}

/** 精确分组："7,113,169,111" */
export function full(value) {
  return Math.round(Number(value) || 0).toLocaleString('en-US');
}

export function pct(value, digits = 1) {
  return `${((Number(value) || 0) * 100).toFixed(digits)}%`;
}

export function money(cost) {
  if (!cost) return '—';
  return cost.text ?? '—';
}

export function bytes(value) {
  const n = Number(value) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  let scaled = n;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  return `${scaled.toFixed(scaled >= 100 || index === 0 ? 0 : 1)}${units[index]}`;
}

const pad = (n) => String(n).padStart(2, '0');

export function clock(date = new Date()) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function clockShort(ts) {
  if (!ts) return '--:--';
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function dateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function timeAgo(ts) {
  if (!ts) return '从未';
  const delta = Date.now() - ts;
  if (delta < 0) return '刚刚';
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

export function duration(ms) {
  const value = Number(ms) || 0;
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60000) return `${(value / 1000).toFixed(1)}s`;
  return `${Math.floor(value / 60000)}m${Math.round((value % 60000) / 1000)}s`;
}

export function shortDay(day) {
  return String(day ?? '').slice(5);
}

/** 模型名太长时保留辨识度高的尾部 */
export function shortModel(model, max = 30) {
  const text = String(model ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, max - 8)}…${text.slice(-7)}`;
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** 稳定的短哈希 → 用于给没有配色的实体生成固定颜色 */
export function hashHue(text) {
  let hash = 0;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i += 1) hash = (hash * 31 + s.charCodeAt(i)) % 360000;
  return hash % 360;
}

export function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}
