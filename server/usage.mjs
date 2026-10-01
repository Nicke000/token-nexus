/**
 * usage.mjs —— 用量事件的统一表示与聚合工具
 *
 * ── 全项目的「通用货币」是一张 bucket 表 ─────────────────────────────
 *   key   = 日期 \u0001 来源 \u0001 供应商 \u0001 模型 \u0001 项目
 *   value = [input, output, cacheRead, cacheWrite, reasoning, requests]
 *
 *   input      非缓存输入（真正跑了一遍 prefill 的部分）
 *   cacheRead  命中提示缓存的输入
 *   cacheWrite 写入提示缓存的输入
 *   output     输出
 *   reasoning  思维链 token（是 output 的**子集**，只做展示，不重复计入总量）
 *
 *   总 token = input + cacheRead + cacheWrite + output
 *
 * ── 为什么必须归一 ────────────────────────────────────────────────
 *   各家的「input」含义是不一样的，直接相加会算错：
 *     DSH / Anthropic / Claude Code : input **不含** cacheRead
 *       {"inputTokens":923,"cacheReadTokens":10752,"outputTokens":83,"totalTokens":11758}
 *       → 923 + 10752 + 83 = 11758 ✓
 *     OpenAI / Codex / Gemini       : input **含** cacheRead
 *       {"prompt_tokens":1500,"cached_tokens":1200,...} → 非缓存输入只有 300
 *
 * ── 为什么存 token 明细而不是直接存钱 ──────────────────────────────
 *   价格表随时会改（可以在界面里编辑），费用必须在**读取时**才算得出来。
 *   这就是「改一行单价，整站数字立刻变」能成立的原因。
 */

export const SEP = '\u0001';
export const BUCKET_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'requests'];

export function emptyBucket() {
  return [0, 0, 0, 0, 0, 0];
}

/** 总量口径：所有进入上下文窗口 + 输出的 token。 */
export function bucketTotal(bucket) {
  return bucket[0] + bucket[1] + bucket[2] + bucket[3];
}

/** 字段里混进控制字符会把 bucket key 的字段对齐冲掉（parseKey 会把模型读成项目）。 */
function sanitizeField(value) {
  const text = String(value ?? '');
  // eslint-disable-next-line no-control-regex
  const cleaned = text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return cleaned === '' ? 'unknown' : cleaned;
}

export function makeKey(day, source, provider, model, project) {
  return [
    sanitizeField(day),
    sanitizeField(source),
    sanitizeField(provider),
    sanitizeField(model),
    sanitizeField(project),
  ].join(SEP);
}

export function parseKey(key) {
  const parts = String(key).split(SEP);
  if (parts.length !== 5) return null;
  const [day, source, provider, model, project] = parts;
  return { day, source, provider, model, project };
}

export function addUsage(map, key, usage) {
  let bucket = map[key];
  if (!bucket) {
    bucket = emptyBucket();
    map[key] = bucket;
  }
  bucket[0] += usage.input || 0;
  bucket[1] += usage.output || 0;
  bucket[2] += usage.cacheRead || 0;
  bucket[3] += usage.cacheWrite || 0;
  bucket[4] += usage.reasoning || 0;
  bucket[5] += 1;
  return bucket;
}

export function mergeBuckets(target, source) {
  for (const [key, bucket] of Object.entries(source)) {
    const existing = target[key];
    if (!existing) {
      target[key] = bucket.slice();
      continue;
    }
    for (let i = 0; i < 6; i += 1) existing[i] += bucket[i];
  }
  return target;
}

export function mergeHourHistogram(target, source) {
  for (let i = 0; i < 24; i += 1) target[i] += source[i] || 0;
  return target;
}

export function emptyHours() {
  return new Array(24).fill(0);
}

/**
 * 累加「本机小时」直方图。
 * 同时按日期分桶存一份（hoursByDay），否则按天数过滤时无法把小时分布也筛掉 ——
 * 那会导致「最近 7 天」和「全部」显示出一模一样的 24 小时分布。
 */
export function bumpHours(acc, ts, total) {
  const hour = Number.isFinite(ts) && ts > 0 ? new Date(ts).getHours() : 0;
  acc.hours[hour] += total;
  if (Number.isFinite(ts) && ts > 0) {
    const day = localDay(ts);
    if (!acc.hoursByDay[day]) acc.hoursByDay[day] = emptyHours();
    acc.hoursByDay[day][hour] += total;
  }
}

const DAY_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** 本机时区的 YYYY-MM-DD —— 用户看到的「今天」就是他自己表上的今天。 */
export function localDay(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return '1970-01-01';
  return DAY_FORMATTER.format(new Date(ts));
}

export function localHour(ts) {
  return Number.isFinite(ts) && ts > 0 ? new Date(ts).getHours() : 0;
}

export function todayLocal() {
  return localDay(Date.now());
}

export function dayOffset(day, delta) {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

export function daysBetween(from, to) {
  const parse = (day) => {
    const [y, m, d] = day.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((parse(to) - parse(from)) / 86400000);
}

export function shortDay(day) {
  return day.slice(5);
}

function num(value) {
  if (value === undefined || value === null) return 0;
  const n = typeof value === 'string' ? Number(value.replace(/[,_\s]/g, '')) : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const INPUT_KEYS = [
  'inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens',
  'promptTokenCount', 'prompt_token_count', 'inputTokenCount', 'input_token_count',
  'context_tokens', 'n_context_tokens_total',
];
const OUTPUT_KEYS = [
  'outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens',
  'candidatesTokenCount', 'candidates_token_count', 'outputTokenCount',
  'n_generated_tokens_total', 'generated_tokens',
];
/** 「input 里已经含了缓存」的字段名 —— 用来推断语义。 */
const INCLUSIVE_HINT_KEYS = [
  'prompt_tokens', 'promptTokens', 'promptTokenCount', 'prompt_token_count',
  'cached_input_tokens', 'cachedInputTokens', 'cached_tokens', 'cachedTokens',
  'prompt_cache_hit_tokens', 'promptCacheHitTokens', 'cachedContentTokenCount',
];
const CACHE_READ_KEYS = [
  'cacheReadTokens', 'cacheRead', 'cache_read_tokens',
  'cache_read_input_tokens', 'cacheReadInputTokens', 'cache_read_input_token_count',
  'cached_input_tokens', 'cachedInputTokens', 'cached_tokens', 'cachedTokens',
  'prompt_cache_hit_tokens', 'promptCacheHitTokens', 'cachedContentTokenCount',
];
const CACHE_WRITE_KEYS = [
  'cacheWriteTokens', 'cacheWrite', 'cache_creation_tokens', 'cache_creation',
  'cache_creation_input_tokens', 'cacheCreationInputTokens', 'cache_write_input_tokens',
  'prompt_cache_miss_tokens', 'promptCacheMissTokens',
];
const REASONING_KEYS = [
  'reasoningTokens', 'reasoning_tokens', 'reasoning_output_tokens',
  'thoughtsTokenCount', 'thoughts_token_count',
];

function pick(source, names) {
  for (const name of names) {
    const value = source[name];
    if (value !== undefined && value !== null) return value;
  }
  const details = source.completion_tokens_details || source.completionTokensDetails
    || source.output_tokens_details || source.outputTokensDetails;
  if (details && typeof details === 'object') {
    for (const name of names) {
      if (details[name] !== undefined && details[name] !== null) return details[name];
    }
  }
  const promptDetails = source.prompt_tokens_details || source.promptTokensDetails
    || source.input_tokens_details;
  if (promptDetails && typeof promptDetails === 'object') {
    for (const name of names) {
      if (promptDetails[name] !== undefined && promptDetails[name] !== null) return promptDetails[name];
    }
  }
  return undefined;
}

/**
 * 推断「input 是否已包含 cacheRead」。
 * @returns {'inclusive'|'exclusive'}
 */
export function inferCacheSemantics(raw) {
  if (!raw || typeof raw !== 'object') return 'exclusive';
  for (const key of INCLUSIVE_HINT_KEYS) {
    if (raw[key] !== undefined && raw[key] !== null) return 'inclusive';
  }
  return 'exclusive';
}

/**
 * 把各家五花八门的字段名归一成统一用量。
 * 这一个函数让 generic 扫描器能直接吃 20+ 种日志格式，也让 4 个云平台 API 共用一套解析。
 *
 * @param {object} raw 原始 usage 对象
 * @param {{semantics?:'inclusive'|'exclusive'|'auto'}} options
 */
export function normalizeUsage(raw, { semantics = 'auto' } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const mode = semantics === 'auto' ? inferCacheSemantics(raw) : semantics;

  const rawInput = num(pick(raw, INPUT_KEYS));
  const output = num(pick(raw, OUTPUT_KEYS));
  const cacheRead = num(pick(raw, CACHE_READ_KEYS));
  const cacheWrite = num(pick(raw, CACHE_WRITE_KEYS));
  const reasoning = num(pick(raw, REASONING_KEYS));
  const declaredTotal = num(pick(raw, ['totalTokens', 'total_tokens', 'totalTokenCount', 'total_token_count']));

  // 只给了 total 的日志（有些网关只记 total_tokens）也必须算数 ——
  // 早期版本在这里直接 return null，等于静默丢弃，且不计入 skipped，完全看不见。
  if (rawInput === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && declaredTotal === 0) {
    return null;
  }

  // inclusive 语义下把缓存从 input 里剥出来，避免重复计入总量
  let input = rawInput;
  if (mode === 'inclusive' && cacheRead > 0) {
    input = Math.max(0, rawInput - cacheRead);
  }

  // 对数：日志声明的总数可能大于已知分项（有些网关只记总数，或只记总数+缓存）。
  // 差额一律算作非缓存输入，绝不能让它凭空消失。
  let total = declaredTotal;
  let computed = input + cacheRead + cacheWrite + output;
  if (total === 0) total = computed;
  if (total > computed) {
    input += total - computed;
    computed = total;
  }
  return { input, output, cacheRead, cacheWrite, reasoning, total: Math.max(total, computed) };
}

/** 把 UTC 秒/毫秒/ISO 串统一成毫秒时间戳。 */
export function toMillis(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return fallback;
    if (value < 1e11) return Math.round(value * 1000); // 秒
    return Math.round(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return fallback;
    if (/^\d+$/.test(trimmed)) return toMillis(Number(trimmed), fallback);
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

/** 把绝对路径压成一个可读的项目名（跨平台，最多保留两级）。 */
export function projectNameFromPath(input) {
  if (!input || typeof input !== 'string') return '—';
  const cleaned = input.replace(/[\\/]+$/, '');
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  if (parts.length === 0) return '—';
  return parts.length === 1 ? parts[0] : parts.slice(-2).join('/');
}

/** 粗略 token 估算：没有 usage 字段时的最后手段（混合中英文按 3.6 字符/token）。 */
export function estimateTokensFromText(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g) || []).length;
  const rest = text.length - cjk;
  return Math.round(cjk / 1.6 + rest / 4);
}

export function scaleUsage(usage, factor) {
  return {
    input: Math.round(usage.input * factor),
    output: Math.round(usage.output * factor),
    cacheRead: Math.round(usage.cacheRead * factor),
    cacheWrite: Math.round(usage.cacheWrite * factor),
    reasoning: Math.round(usage.reasoning * factor),
  };
}
