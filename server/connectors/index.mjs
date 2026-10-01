/**
 * connectors/index.mjs —— 云平台连接器注册表 + 磁盘缓存
 *
 * 本地日志是主力，云连接器是补充：
 *   - 没配密钥 → 完全跳过，一次网络请求都不发（离线可用）
 *   - 配了密钥 → 结果按 15 分钟落盘缓存，避免每次刷新都打人家 API
 *
 * 连接器输出与扫描器完全同构（同一套 bucket 表），所以聚合层不需要知道
 * 「这条数据是本地读来的还是从云上拉的」。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE_DIR, loadConfig } from '../config.mjs';
import { emptyHours, mergeBuckets, mergeHourHistogram } from '../usage.mjs';
import { buildPriceTable } from '../pricing.mjs';

import * as openai from './openai.mjs';
import * as anthropic from './anthropic.mjs';
import * as openrouter from './openrouter.mjs';
import * as deepseek from './deepseek.mjs';

export const CONNECTORS = {
  'openai-api': openai,
  'anthropic-api': anthropic,
  'openrouter-api': openrouter,
  'deepseek-api': deepseek,
};

const USAGE_CACHE = join(CACHE_DIR, 'connectors.json');
const PRICING_CACHE = join(CACHE_DIR, 'pricing-remote.json');
const USAGE_TTL = 15 * 60 * 1000;
const PRICING_TTL = 24 * 60 * 60 * 1000;

export function connectorSpecs() {
  return Object.entries(CONNECTORS).map(([id, mod]) => ({
    id,
    label: mod.meta.label,
    kind: 'cloud',
    vendor: mod.meta.vendor,
    accent: mod.meta.accent ?? '#8b98a5',
    description: mod.meta.description,
    requiresKey: mod.meta.requiresKey,
    docs: mod.meta.docs,
  }));
}

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  mkdirSync(CACHE_DIR, { recursive: true });
  try {
    writeFileSync(path, JSON.stringify(value), 'utf8');
  } catch {
    /* 缓存写不了不影响功能 */
  }
}

function emptyResult() {
  return {
    buckets: {},
    hours: emptyHours(),
    recent: [],
    firstTs: 0,
    lastTs: 0,
    events: 0,
    sessions: 0,
    perSource: {},
    info: {},
    warnings: [],
    errors: [],
    ranAt: 0,
    configured: [],
    cached: false,
  };
}

/**
 * 跑一遍所有「已配置」的连接器。
 * @param {{force?:boolean, days?:number}} options
 */
export async function runConnectors(config = loadConfig(), { force = false, days = 90 } = {}) {
  const result = emptyResult();
  const cachedAll = readJson(USAGE_CACHE) ?? {};
  const fresh = !force && Date.now() - (cachedAll.ranAt ?? 0) < USAGE_TTL;

  if (fresh) {
    Object.assign(result, cachedAll, { cached: true });
    if (!result.hours || result.hours.length !== 24) result.hours = emptyHours();
    return result;
  }

  for (const [id, mod] of Object.entries(CONNECTORS)) {
    let configured = false;
    try {
      configured = mod.isConfigured(config);
    } catch {
      configured = false;
    }
    if (!configured) continue;
    result.configured.push(id);
    try {
      const payload = await mod.fetchUsage({ ...config, __connectorDays: days });
      result.perSource[id] = {
        buckets: payload.buckets ?? {},
        hours: payload.hours ?? emptyHours(),
        events: payload.events ?? 0,
        sessions: payload.sessions ?? 0,
        firstTs: payload.firstTs ?? 0,
        lastTs: payload.lastTs ?? 0,
        costUsd: payload.costUsd ?? null,
        info: payload.info ?? {},
        warnings: payload.warnings ?? [],
      };
      mergeBuckets(result.buckets, payload.buckets ?? {});
      mergeHourHistogram(result.hours, payload.hours ?? emptyHours());
      result.events += payload.events ?? 0;
      result.warnings.push(...(payload.warnings ?? []).map((text) => `${mod.meta.label}：${text}`));
      if (payload.firstTs) result.firstTs = result.firstTs === 0 ? payload.firstTs : Math.min(result.firstTs, payload.firstTs);
      if (payload.lastTs) result.lastTs = Math.max(result.lastTs, payload.lastTs);
      if (payload.info) result.info[id] = payload.info;
    } catch (error) {
      result.errors.push({ source: id, error: error.message });
    }
  }

  result.ranAt = Date.now();
  result.cached = false;
  if (result.configured.length > 0) writeJson(USAGE_CACHE, result);
  return result;
}

/** 把连接器结果并进 scan.buildRaw() 的产物里。 */
export function applyToRaw(raw, external) {
  if (!external) return raw;
  mergeBuckets(raw.buckets, external.buckets ?? {});
  mergeHourIntoTarget(raw, external);
  raw.events += external.events ?? 0;
  if (external.firstTs) raw.firstTs = raw.firstTs === 0 ? external.firstTs : Math.min(raw.firstTs, external.firstTs);
  if (external.lastTs) raw.lastTs = Math.max(raw.lastTs, external.lastTs);
  for (const [id, payload] of Object.entries(external.perSource ?? {})) {
    raw.perSource[id] = {
      buckets: payload.buckets ?? {},
      hours: payload.hours ?? emptyHours(),
      events: payload.events ?? 0,
      sessions: payload.sessions ?? 0,
      files: 0,
      bytes: 0,
    };
  }
  raw.external = {
    configured: external.configured ?? [],
    cached: Boolean(external.cached),
    ranAt: external.ranAt ?? 0,
    warnings: external.warnings ?? [],
    errors: external.errors ?? [],
    info: external.info ?? {},
  };
  return raw;
}

function mergeHourIntoTarget(raw, external) {
  for (let i = 0; i < 24; i += 1) raw.hours[i] += external.hours?.[i] ?? 0;
}

/* ─────────────────── 实时价格表（OpenRouter） ─────────────────── */

let remotePricing = null;

export function getRemotePricing() {
  if (remotePricing) return remotePricing;
  const cached = readJson(PRICING_CACHE);
  if (cached && Date.now() - (cached.fetchedAt ?? 0) < PRICING_TTL) {
    remotePricing = cached;
    return remotePricing;
  }
  return cached ?? null;
}

export async function syncRemotePricing(config = loadConfig(), { force = false } = {}) {
  const cached = readJson(PRICING_CACHE);
  if (!force && cached && Date.now() - (cached.fetchedAt ?? 0) < PRICING_TTL) {
    remotePricing = cached;
    return { ...cached, cached: true };
  }
  const data = await openrouter.syncPricingModels(config);
  remotePricing = data;
  writeJson(PRICING_CACHE, data);
  return { ...data, cached: false };
}

/** 统一入口：聚合层拿价格表。 */
export function priceTableFor(config) {
  return buildPriceTable({ config, remote: getRemotePricing() });
}
