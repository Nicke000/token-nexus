/**
 * connectors/openrouter.mjs —— OpenRouter 额度 / 活动 / 实时价格表
 *
 * 三件事：
 *  1. /api/v1/credits      总充值 / 总消耗（任意 key 可读）
 *  2. /api/v1/activity     按天按模型的用量明细（需要 Provisioning key）
 *  3. /api/v1/models       数百个模型的**当前实时单价**（免密钥）
 *
 * 第 3 点很关键：本机的日志里常有 gpt-5.6-luna 这种内置表没有的模型，
 * 与其瞎猜单价，不如从 OpenRouter 把真实价格同步下来。
 */
import { fetchJson, dayRange } from './_http.mjs';
import { addUsage, makeKey, localDay, emptyHours } from '../usage.mjs';

export const meta = {
  id: 'openrouter-api',
  label: 'OpenRouter',
  kind: 'cloud',
  vendor: 'OpenRouter',
  accent: '#f472b6',
  description: '额度总览 + 按天活动明细；同时提供实时价格表同步（免密钥）。',
  requiresKey: 'api.openrouter.apiKey',
  docs: 'https://openrouter.ai/docs/api-reference/overview',
};

export function isConfigured(config) {
  const api = config?.api?.openrouter ?? {};
  return Boolean(api.enabled && api.apiKey);
}

export async function fetchUsage(config) {
  const api = config.api.openrouter;
  const base = (api.baseUrl || 'https://openrouter.ai/api').replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${api.apiKey}` };
  const buckets = {};
  const hours = emptyHours();
  const warnings = [];
  const info = {};
  let events = 0;
  let firstTs = 0;
  let lastTs = 0;

  // 1) 额度
  try {
    const credits = await fetchJson(`${base}/v1/credits`, { headers });
    const data = credits?.data ?? credits;
    info.credits = {
      totalCredits: Number(data?.total_credits ?? 0),
      totalUsage: Number(data?.total_usage ?? 0),
      remaining: Number(data?.total_credits ?? 0) - Number(data?.total_usage ?? 0),
    };
  } catch (error) {
    warnings.push(`额度读取失败：${error.message}`);
  }

  // 2) 按天活动明细（Provisioning key 才有权限）
  const { from, to } = dayRange(30);
  for (let cursor = new Date(`${from}T00:00:00Z`); cursor <= new Date(`${to}T00:00:00Z`); cursor = new Date(cursor.getTime() + 86400000)) {
    const date = cursor.toISOString().slice(0, 10);
    try {
      const activity = await fetchJson(`${base}/v1/activity?date=${date}`, { headers });
      for (const row of activity?.data ?? []) {
        const input = Number(row.prompt_tokens ?? row.tokens_prompt ?? 0);
        const output = Number(row.completion_tokens ?? row.tokens_completion ?? 0);
        const cacheRead = Number(row.cached_tokens ?? 0);
        if (input + output + cacheRead === 0) continue;
        const model = String(row.model ?? 'unknown');
        const provider = String(row.provider_name ?? 'openrouter');
        const ts = Date.parse(date) || 0;
        if (ts > 0) {
          firstTs = firstTs === 0 ? ts : Math.min(firstTs, ts);
          lastTs = Math.max(lastTs, ts);
        }
        addUsage(buckets, makeKey(date, 'openrouter-api', provider, model, 'OpenRouter'), {
          input: Math.max(0, input - cacheRead),
          output,
          cacheRead,
          cacheWrite: 0,
          reasoning: 0,
        });
        events += Number(row.requests ?? 1);
      }
    } catch (error) {
      if (error.status === 403 || error.status === 401) {
        warnings.push('活动明细需要 Provisioning key（普通 key 只能读额度，属正常现象）');
        break;
      }
      warnings.push(`${date} 活动明细读取失败：${error.message}`);
      break;
    }
  }

  return { buckets, hours, recent: [], firstTs, lastTs, events, sessions: 0, warnings, info };
}

/**
 * 拉取实时价格表。
 * OpenRouter 的 pricing 单位是 USD/token 的字符串，要 ×1e6 变成 USD/1M tokens。
 */
export async function syncPricingModels(config) {
  const base = (config?.api?.openrouter?.baseUrl || 'https://openrouter.ai/api').replace(/\/+$/, '');
  const payload = await fetchJson(`${base}/v1/models`, { timeoutMs: 30000 });
  const toPerMillion = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed * 1_000_000 : null;
  };
  const models = [];
  for (const row of payload?.data ?? []) {
    const id = String(row.id ?? '').toLowerCase();
    if (id === '') continue;
    const pricing = row.pricing ?? {};
    const input = toPerMillion(pricing.prompt);
    const output = toPerMillion(pricing.completion);
    if (input === null && output === null) continue;
    models.push({
      match: [id, id.includes('/') ? id.split('/').slice(1).join('/') : id],
      label: row.name ?? id,
      vendor: id.includes('/') ? id.split('/')[0] : 'OpenRouter',
      input: input ?? 0,
      output: output ?? 0,
      cacheRead: toPerMillion(pricing.input_cache_read),
      cacheWrite: toPerMillion(pricing.input_cache_write),
      confidence: 'high',
      source: 'https://openrouter.ai/api/v1/models',
    });
  }
  return { models, fetchedAt: Date.now(), source: 'https://openrouter.ai/api/v1/models' };
}
