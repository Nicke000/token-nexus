/**
 * connectors/openai.mjs —— OpenAI 平台用量 / 成本
 *
 * GET /v1/organization/usage/completions?bucket_width=1d&group_by[]=model
 * GET /v1/organization/costs?bucket_width=1d
 *
 * 需要 **Admin key**（sk-admin-...），普通项目 key 调不通这个接口。
 * 注意：openai 的 input_tokens 已包含 cached，所以这里用 inclusive 语义归一。
 */
import { fetchJson, dayRange } from './_http.mjs';
import { addUsage, makeKey, localDay, emptyHours, normalizeUsage } from '../usage.mjs';

export const meta = {
  id: 'openai-api',
  label: 'OpenAI 平台 API',
  kind: 'cloud',
  vendor: 'OpenAI',
  accent: '#4ade80',
  description: 'Admin API 官方用量：按模型/按天聚合，含 cached input 明细与官方成本。',
  requiresKey: 'api.openai.adminKey',
  docs: 'https://platform.openai.com/docs/api-reference/usage',
};

export function isConfigured(config) {
  const api = config?.api?.openai ?? {};
  return Boolean(api.enabled && api.adminKey);
}

export async function fetchUsage(config) {
  const api = config.api.openai;
  const base = (api.baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
  const { from, to } = dayRange(config.__connectorDays ?? 90);
  const headers = { authorization: `Bearer ${api.adminKey}` };
  if (api.organization) headers['OpenAI-Organization'] = api.organization;

  const buckets = {};
  const hours = emptyHours();
  const recent = [];
  const warnings = [];
  let firstTs = 0;
  let lastTs = 0;
  let events = 0;
  let costUsd = null;

  // ── 用量 ───────────────────────────────────────────────────
  const url = `${base}/v1/organization/usage/completions?start_time=${Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000)}`
    + `&end_time=${Math.floor(Date.parse(`${to}T23:59:59Z`) / 1000)}`
    + '&bucket_width=1d&limit=180&group_by[]=model';
  const usage = await fetchJson(url, { headers });
  for (const bucket of usage?.data ?? []) {
    const ts = (bucket.start_time ?? 0) * 1000;
    const day = bucket.start_time ? localDay(ts) : localDay(Date.now());
    if (ts > 0) {
      firstTs = firstTs === 0 ? ts : Math.min(firstTs, ts);
      lastTs = Math.max(lastTs, ts);
    }
    for (const row of bucket.results ?? []) {
      const tokens = row.input_tokens ?? 0;
      const cached = row.input_cached_tokens ?? 0;
      const raw = {
        prompt_tokens: tokens,
        cached_tokens: cached,
        completion_tokens: row.output_tokens ?? 0,
        total_tokens: tokens + (row.output_tokens ?? 0),
      };
      const normalized = normalizeUsage(raw, { semantics: 'inclusive' });
      if (!normalized) continue;
      const requests = row.num_model_requests ?? 0;
      addUsage(buckets, makeKey(day, 'openai-api', 'openai', row.model ?? 'unknown', 'OpenAI 平台'), {
        ...normalized,
        reasoning: row.output_tokens_details?.reasoning_tokens ?? 0,
      });
      // 请求数用官方值覆盖（bucket 里的 requests 是自增 1，不准）
      const key = makeKey(day, 'openai-api', 'openai', row.model ?? 'unknown', 'OpenAI 平台');
      if (requests > 0) buckets[key][5] += Math.max(0, requests - 1);
      events += requests || 1;
    }
  }

  // ── 官方成本（比本地价格表更权威，用作交叉校验） ────────────
  try {
    const costUrl = `${base}/v1/organization/costs?start_time=${Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000)}`
      + '&limit=180&bucket_width=1d';
    const costs = await fetchJson(costUrl, { headers });
    let sum = 0;
    for (const bucket of costs?.data ?? []) {
      for (const row of bucket.results ?? []) {
        const amount = row.amount?.value;
        if (typeof amount === 'number') sum += amount;
      }
    }
    costUsd = sum;
  } catch (error) {
    warnings.push(`成本接口读取失败（用量不受影响）：${error.message}`);
  }

  return { buckets, hours, recent, firstTs, lastTs, events, sessions: 0, costUsd, warnings };
}
