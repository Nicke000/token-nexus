/**
 * connectors/_http.mjs —— 连接器共用的 JSON 请求
 * 零依赖：直接用 Node 内置 fetch（Node 18+），带超时和错误归一。
 */
export async function fetchJson(url, { headers = {}, method = 'GET', body = null, timeoutMs = 25000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const detail = parsed?.error?.message || parsed?.message || text.slice(0, 240) || response.statusText;
      const error = new Error(`HTTP ${response.status} ${detail}`);
      error.status = response.status;
      error.payload = parsed;
      throw error;
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

export function dayRange(days) {
  const to = new Date();
  const from = new Date(Date.now() - (days - 1) * 86400000);
  const iso = (date) => date.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to) };
}
