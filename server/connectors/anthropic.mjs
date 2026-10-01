/**
 * connectors/anthropic.mjs —— Anthropic 官方用量报表
 *
 * GET /v1/organizations/usage_report/messages?starting_at=..&bucket_width=1d&group_by[]=model
 * 需要 Admin key（sk-ant-admin...），请求头 x-api-key + anthropic-version。
 *
 * Anthropic 的 input_tokens **不含**缓存，字段名是
 *   uncached_input_tokens / cache_read_input_tokens / cache_creation_input_tokens
 * 正好就是我们的 bucket 口径，直接映射。
 */
import { fetchJson, dayRange } from './_http.mjs';
import { addUsage, makeKey, localDay, emptyHours } from '../usage.mjs';

export const meta = {
  id: 'anthropic-api',
  label: 'Anthropic 平台 API',
  kind: 'cloud',
  vendor: 'Anthropic',
  accent: '#d8b4fe',
  description: 'Admin API 官方用量报表：uncached / cache_read / cache_creation 三段分明。',
  requiresKey: 'api.anthropic.adminKey',
  docs: 'https://docs.anthropic.com/en/api/admin-api/usage-cost/get-messages-usage-report',
};

export function isConfigured(config) {
  const api = config?.api?.anthropic ?? {};
  return Boolean(api.enabled && api.adminKey);
}

export async function fetchUsage(config) {
  const api = config.api.anthropic;
  const base = (api.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
  const { from } = dayRange(config.__connectorDays ?? 90);
  const headers = {
    'x-api-key': api.adminKey,
    'anthropic-version': '2023-06-01',
  };

  const buckets = {};
  const hours = emptyHours();
  const warnings = [];
  let firstTs = 0;
  let lastTs = 0;
  let events = 0;

  const url = `${base}/v1/organizations/usage_report/messages?starting_at=${from}T00:00:00Z`
    + '&bucket_width=1d&limit=180&group_by[]=model';
  const payload = await fetchJson(url, { headers });

  for (const bucket of payload?.data ?? []) {
    const ts = Date.parse(bucket.starting_at ?? '') || 0;
    const day = ts > 0 ? localDay(ts) : localDay(Date.now());
    if (ts > 0) {
      firstTs = firstTs === 0 ? ts : Math.min(firstTs, ts);
      lastTs = Math.max(lastTs, ts);
    }
    for (const row of bucket.results ?? []) {
      const usage = {
        input: row.uncached_input_tokens ?? row.input_tokens ?? 0,
        output: row.output_tokens ?? 0,
        cacheRead: row.cache_read_input_tokens ?? 0,
        cacheWrite: row.cache_creation_input_tokens ?? 0,
        reasoning: 0,
      };
      if (usage.input + usage.output + usage.cacheRead + usage.cacheWrite === 0) continue;
      const model = row.model ?? 'unknown';
      addUsage(buckets, makeKey(day, 'anthropic-api', 'anthropic', model, 'Anthropic 平台'), usage);
      events += 1;
    }
  }

  return { buckets, hours, recent: [], firstTs, lastTs, events, sessions: 0, warnings };
}
