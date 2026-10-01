/** api.js —— 后端接口与 SSE 进度流 */

// 局域网模式下服务端会把访问令牌注入页面（window.__NEXUS_TOKEN__）；
// 本机模式下为 undefined，所有请求保持原样。
const TOKEN = typeof window === 'undefined' ? null : (window.__NEXUS_TOKEN__ ?? null);

export function withToken(path) {
  if (!TOKEN) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}token=${encodeURIComponent(TOKEN)}`;
}

async function request(path, options) {
  const response = await fetch(withToken(path), options);
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }
  return payload;
}

export function getSnapshot({ days = 30, sources = [] } = {}) {
  const params = new URLSearchParams();
  if (days > 0) params.set('days', String(days));
  if (sources.length > 0) params.set('sources', sources.join(','));
  const query = params.toString();
  return request(`/api/snapshot${query ? `?${query}` : ''}`);
}

export function startScan({ force = false } = {}) {
  return request(`/api/scan${force ? '?force=1' : ''}`, { method: 'POST' });
}

export function getConfig() {
  return request('/api/config');
}

export function saveConfig(patch) {
  return request('/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export function getSources() {
  return request('/api/sources');
}

export function syncPricing({ force = false } = {}) {
  return request(`/api/pricing/sync${force ? '?force=1' : ''}`, { method: 'POST' });
}

export function clearCache() {
  return request('/api/cache', { method: 'DELETE' });
}

export function health() {
  return request('/api/health');
}

/** 订阅扫描进度：返回关闭函数。断线自动重连（EventSource 自己会重试）。 */
export function connectEvents({ onEvent, onOpen, onError } = {}) {
  const source = new EventSource(withToken('/api/events'));
  source.onopen = () => onOpen?.();
  source.onerror = () => onError?.();
  source.onmessage = (message) => {
    try {
      const payload = JSON.parse(message.data);
      onEvent?.(payload);
    } catch {
      /* 心跳等非 JSON 帧忽略 */
    }
  };
  return () => source.close();
}
