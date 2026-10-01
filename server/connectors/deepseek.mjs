/**
 * connectors/deepseek.mjs —— DeepSeek 账户余额
 *
 * DeepSeek 官方目前**没有**公开的用量历史接口，只有：
 *   GET /user/balance  →  { is_available, balance_infos: [{currency, total_balance, ...}] }
 *
 * 所以这里只产出「余额信息」，不产出 token 桶 —— 绝不为了凑数拿余额反推用量。
 * DeepSeek 的 token 用量请走 dsh 扫描器（本地会话日志里有逐条 usage）。
 */
import { fetchJson } from './_http.mjs';
import { emptyHours } from '../usage.mjs';

export const meta = {
  id: 'deepseek-api',
  label: 'DeepSeek 余额',
  kind: 'cloud',
  vendor: 'DeepSeek',
  accent: '#38bdf8',
  description: '官方余额查询。DeepSeek 无用量历史接口，token 数据请以本地会话日志为准。',
  requiresKey: 'api.deepseek.apiKey',
  docs: 'https://api-docs.deepseek.com/api/get-user-balance',
};

export function isConfigured(config) {
  const api = config?.api?.deepseek ?? {};
  return Boolean(api.enabled && api.apiKey);
}

export async function fetchUsage(config) {
  const api = config.api.deepseek;
  const base = (api.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const warnings = [];
  const info = {};
  try {
    const payload = await fetchJson(`${base}/user/balance`, {
      headers: { authorization: `Bearer ${api.apiKey}` },
    });
    info.balance = {
      available: Boolean(payload?.is_available),
      balances: (payload?.balance_infos ?? []).map((row) => ({
        currency: row.currency,
        total: Number(row.total_balance ?? 0),
        granted: Number(row.granted_balance ?? 0),
        toppedUp: Number(row.topped_up_balance ?? 0),
      })),
    };
  } catch (error) {
    warnings.push(`余额读取失败：${error.message}`);
  }
  return { buckets: {}, hours: emptyHours(), recent: [], firstTs: 0, lastTs: 0, events: 0, sessions: 0, warnings, info };
}
