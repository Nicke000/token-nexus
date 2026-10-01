/**
 * pricing.mjs —— 价格表与费用计算
 *
 * 四层覆盖（后者压前者）：
 *   1. BUILTIN      server/pricing-data.mjs —— 由 tools/pricing/price-table.json 编译而来，
 *                   每条都带出处与置信度；查不到就不编，宁可显示「未定价」
 *   2. REMOTE       OpenRouter /api/v1/models 拉回来的实时价格（几百个模型，免密钥）
 *   3. overrides    用户在界面里自己填的
 *
 * 匹配顺序：归一化精确 id → 自上而下首个命中（**数组顺序即优先级**）→ 未定价。
 *
 * 费用公式（USD）：
 *   cost = (input*p_in + cacheRead*p_cacheRead + cacheWrite*p_cacheWrite + output*p_out) / 1e6
 *
 * 两条硬规则，都是为了不骗人：
 *   · 缓存读单价缺失时退回 p_in（「假设没有缓存折扣」的上界），并标记 cacheEstimated。
 *     agent 场景 cacheRead 常占 90%+，按 0 算会让费用少一个数量级。
 *   · 单价为 null 的「路由占位」条目（azure/、bedrock/、vertex/）一律当**未定价**，
 *     绝不按 0 计算 —— 否则会显示「已定价但免费」，比不知道更糟。
 */
import {
  PRICING_META, PRICING_MODELS, PRICING_ALIASES, PRICING_SOURCES,
} from './pricing-data.mjs';

export const PRICING_UNIT = 1_000_000;

export const BUILTIN = {
  ...PRICING_META,
  aliases: PRICING_ALIASES,
  models: PRICING_MODELS,
  sources: PRICING_SOURCES,
  revision: PRICING_META.pricesAsOf ?? 'unknown',
  note: PRICING_META.note
    || '内置基线价格表；可在设置里编辑，或一键同步 OpenRouter 实时价。',
};

export { PRICING_SOURCES };

function normalizeModelId(value) {
  return String(value ?? '')
    .toLowerCase()
    .trim()
    .replace(/^[a-z0-9_.-]+\//, '')            // 去掉 "vendor/" 前缀（openrouter 等）
    .replace(/:(free|beta|extended|nitro|online|floor|thinking)$/i, '')
    .replace(/[\s]+/g, '-')
    .replace(/-+$/, '');
}

/**
 * 建立价格表。remote 是 OpenRouter 同步回来的条目（可为空）。
 */
export function buildPriceTable({ config, remote = null } = {}) {
  const entries = [];
  const push = (entry, layer) => {
    if (!entry || !Array.isArray(entry.match) || entry.match.length === 0) return;
    entries.push({ ...entry, layer });
  };

  for (const model of BUILTIN.models) push(model, 'builtin');
  if (remote?.models) {
    for (const model of remote.models) push(model, 'remote');
  }

  const overrides = config?.pricing?.overrides ?? {};
  for (const [key, value] of Object.entries(overrides)) {
    if (value?.disabled) continue;
    const matches = Array.isArray(value.match) && value.match.length > 0 ? value.match : [key];
    push({ ...value, match: matches, label: value.label || key }, 'override');
  }

  const disabled = new Set((config?.pricing?.disabled ?? []).map(normalizeModelId));

  // 只按「层」排序 —— Array#sort 是稳定排序，因此同层内保留原数组顺序，
  // 而内置表里的顺序是有意义的（具体型号排在家族前缀之前）。
  const layerRank = { override: 0, remote: 1, builtin: 2 };
  const indexed = entries.map((entry, index) => ({ entry, index }));
  indexed.sort((a, b) => {
    const rank = (layerRank[a.entry.layer] ?? 9) - (layerRank[b.entry.layer] ?? 9);
    return rank !== 0 ? rank : a.index - b.index;
  });

  const table = { entries: [], exact: new Map(), aliases: { ...BUILTIN.aliases }, meta: BUILTIN };

  for (const { entry } of indexed) {
    const normalizedMatches = entry.match
      .map((m) => normalizeModelId(m))
      .filter((m) => m !== '' && m !== '*' && m !== '-');
    if (normalizedMatches.length === 0) continue;
    if (disabled.has(normalizeModelId(entry.label ?? ''))) continue;
    const prepared = { ...entry, normalizedMatches };
    table.entries.push(prepared);
    for (const match of normalizedMatches) {
      if (!table.exact.has(match)) table.exact.set(match, prepared);
    }
  }

  table.remoteMeta = remote
    ? { fetchedAt: remote.fetchedAt, count: remote.models?.length ?? 0, source: remote.source }
    : null;
  return table;
}

/** 判定一条价格条目是否真的能算钱。 */
function usable(entry) {
  if (!entry) return false;
  const has = (value) => value !== null && value !== undefined;
  return has(entry.input) || has(entry.output);
}

/** 给一个模型名找价格条目。 */
export function priceFor(model, provider, table) {
  const id = normalizeModelId(model);
  if (id === '') return null;

  const direct = table.exact.get(id);
  if (usable(direct)) return direct;

  // 自上而下首个命中：顺序即优先级
  for (const entry of table.entries) {
    for (const match of entry.normalizedMatches) {
      if (match.length >= 3 && id.includes(match) && usable(entry)) return entry;
    }
  }
  return null;
}

export function costOf(usage, price) {
  if (!usable(price)) return { usd: 0, priced: false, cacheEstimated: false };
  const has = (value) => value !== null && value !== undefined;
  const pIn = has(price.input) ? Number(price.input) : 0;
  const pOut = has(price.output) ? Number(price.output) : 0;
  const pCacheRead = has(price.cacheRead) ? Number(price.cacheRead) : pIn;
  const pCacheWrite = has(price.cacheWrite) ? Number(price.cacheWrite) : pIn;
  const cacheEstimated = !has(price.cacheRead) && usage.cacheRead > 0;
  const usd = (
    usage.input * pIn
    + usage.cacheRead * pCacheRead
    + usage.cacheWrite * pCacheWrite
    + usage.output * pOut
  ) / PRICING_UNIT;
  return { usd, priced: true, cacheEstimated, pIn, pOut, pCacheRead, pCacheWrite };
}

export function formatMoney(usd, config) {
  const currency = config?.displayCurrency === 'CNY' ? 'CNY' : 'USD';
  const rate = currency === 'CNY' ? Number(config?.fxRate) || 7.15 : 1;
  const value = usd * rate;
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 0 : abs >= 100 ? 1 : abs >= 1 ? 2 : abs >= 0.01 ? 3 : 4;
  return {
    currency,
    value,
    rate,
    text: `${currency === 'CNY' ? '¥' : '$'}${value.toFixed(digits)}`,
  };
}

export { normalizeModelId };
