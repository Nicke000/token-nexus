/**
 * scanners/generic.mjs —— 任意 JSONL 用量日志（开源友好 / 自建平台用）
 *
 * 用它可以不用改一行代码就接入：
 *   - 自己写的网关日志
 *   - LiteLLM / One-API / New-API 的调用日志
 *   - LangSmith / Helicone / 自建 Postgres 导出的 JSONL
 *   - 任何「一行一条记录、带用量字段」的文件
 *
 * 做法：递归（深度 ≤ 4）在对象里找用量块，字段名靠 usage.mjs 的 20+ 别名表匹配；
 * 时间/模型/供应商/项目也各有一组候选字段名。找不到用量字段的行直接丢弃。
 *
 * 用户只需在配置里加：
 *   "sources": { "generic": { "paths": ["D:/logs/litellm"] } }
 */
import { existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { walkFiles } from '../paths.mjs';
import {
  iterateFileLines, safeParse, makeAccumulator, finalizeAccumulator, pushRecent,
} from './_shared.mjs';
import {
  addUsage, makeKey, localDay, bumpHours, emptyHours, normalizeUsage,
  projectNameFromPath, toMillis,
} from '../usage.mjs';

export const meta = {
  id: 'generic',
  label: '自定义 JSONL',
  granularity: 'per-record',
  fields: ['provider', 'model', 'project'],
  note: '自动嗅探用量字段；需要在设置里指定目录。',
};

/**
 * 容器键**按可信度排序**，第一个命中即返回。
 * `usage` / `token_usage` 这类是各家 SDK 亲手写的用量块；
 * `metrics` 是最宽泛的（常混着延迟、重试次数等无关字段），所以放最后 ——
 * 否则 `{"metrics":{"inputTokens":5},"usage":{"inputTokens":1000}}` 会取到 5。
 */
const USAGE_CONTAINER_KEYS = [
  'usage', 'token_usage', 'tokenUsage', 'usage_metadata', 'usageMetadata',
  'usage_data', 'usageData', 'usage_stats', 'usageStats', 'tokens',
  'metrics',
];

const TS_KEYS = ['timestamp', 'time', 'ts', 'createdAt', 'created_at', 'date', 'datetime', 'requestTime', 'startTime', 'event_time'];
const MODEL_KEYS = ['model', 'model_name', 'modelName', 'model_id', 'modelId', 'responseModel', 'response_model', 'deployment'];
const PROVIDER_KEYS = ['provider', 'vendor', 'api_provider', 'apiProvider', 'platform', 'channel', 'api_base'];
const PROJECT_KEYS = ['cwd', 'project', 'projectName', 'project_name', 'workspace', 'directory', 'path', 'repo', 'app'];
const ID_KEYS = ['id', 'request_id', 'requestId', 'trace_id', 'traceId', 'uuid', 'call_id', 'callId'];

function firstString(source, keys) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

/** 在对象里找用量块；按容器键可信度顺序命中即返回，最后才退化成「对象自己就是用量块」。 */
export function findUsage(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 4) return null;
  // 1) 可信容器键（顺序即优先级）
  for (const key of USAGE_CONTAINER_KEYS) {
    const value = node[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const usage = normalizeUsage(value);
      if (usage) return usage;
    }
  }
  // 2) 对象本身就是摊平写法
  const flat = normalizeUsage(node);
  if (flat) return flat;
  // 3) 继续下钻，但只走一层容器，别把 prompt 正文里的字符串当成用量
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const found = findUsage(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

export function enumerate(spec) {
  const dirs = (spec.paths ?? []).filter((dir) => existsSync(dir));
  if (dirs.length === 0) return [];
  return walkFiles(dirs, { extensions: ['.jsonl', '.log', '.ndjson'], maxFiles: 200000 }).map((file) => ({
    id: `generic:${file.path}`,
    source: 'generic',
    path: file.path,
    size: file.size,
    mtimeMs: file.mtimeMs,
    label: basename(file.path),
  }));
}

export function parse(item) {
  const acc = makeAccumulator(emptyHours);
  const seen = new Set();
  const label = item.label ?? basename(item.path);
  // provider 兜底用**父目录名**而不是文件名：文件名常常是会话 id，
  // 拿它当供应商名字会产出「20260831-092149…turns.jsonl」这种脏数据。
  const container = basename(dirname(item.path)) || label;
  const projectLabel = label.replace(/\.(jsonl|log|ndjson)$/i, '');

  for (const line of iterateFileLines(item.path)) {
    if (!line.includes('{')) continue;
    const event = safeParse(line);
    if (!event || typeof event !== 'object') continue;
    const usage = findUsage(event);
    if (!usage) continue;

    const dedupe = firstString(event, ID_KEYS);
    if (dedupe) {
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
    }

    const tsRaw = firstString(event, TS_KEYS);
    const ts = toMillis(tsRaw ? (/^\d+$/.test(tsRaw) ? Number(tsRaw) : tsRaw) : 0);
    const model = firstString(event, MODEL_KEYS) || 'unknown';
    const provider = firstString(event, PROVIDER_KEYS) || container;
    const projectRaw = firstString(event, PROJECT_KEYS);
    const project = projectRaw ? projectNameFromPath(projectRaw) : projectLabel;

    addUsage(acc.buckets, makeKey(localDay(ts), 'generic', provider, model, project), usage);
    const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    bumpHours(acc, ts, total);
    if (ts > 0) {
      acc.firstTs = acc.firstTs === 0 ? ts : Math.min(acc.firstTs, ts);
      acc.lastTs = Math.max(acc.lastTs, ts);
    }
    acc.sessions.add(item.path);
    acc.events += 1;
    pushRecent(acc, {
      ts, source: 'generic', provider, model, project,
      total, input: usage.input, output: usage.output, cacheRead: usage.cacheRead,
    });
  }
  return finalizeAccumulator(acc);
}
