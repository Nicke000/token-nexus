/**
 * scanners/reasonix.mjs —— Reasonix（本地 agent 桌面端）用量统计
 *
 * 数据在 `%APPDATA%/reasonix/stats/YYYY-MM-DD.jsonl`，**一行就是一次请求**：
 *
 *   {"ts":"2026-08-07T21:21:42.824+08:00","model":"deepseek/deepseek-v4-flash",
 *    "source":"desktop","prompt":328412,"completion":833,"reasoning":489,
 *    "cache_hit":512,"cache_miss":327900,"total":329245,"requests":1}
 *
 * 字段语义实测：
 *   cache_miss + cache_hit = prompt        （新鲜输入 + 缓存读 = 全部提示）
 *   prompt + completion    = total
 * 所以与我们的口径一一对应，不需要任何猜测：
 *   input = cache_miss   cacheRead = cache_hit   output = completion
 *
 * 注意：Reasonix 只在这些按天统计文件里记 token，会话事件流
 * （projects/<proj>/sessions/*.events.jsonl）里没有结构化用量，不要去那边找。
 */
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { walkFiles } from '../paths.mjs';
import {
  iterateFileLines, safeParse, makeAccumulator, finalizeAccumulator, pushRecent,
} from './_shared.mjs';
import { addUsage, makeKey, localDay, bumpHours, emptyHours, toMillis } from '../usage.mjs';

export const meta = {
  id: 'reasonix',
  label: 'Reasonix',
  granularity: 'per-request',
  fields: ['provider', 'model'],
  note: '逐条请求的完整用量（含缓存命中/未命中拆分），直接对应我们的口径。',
};

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** "deepseek/deepseek-v4-flash" → { provider:'deepseek', model:'deepseek-v4-flash' } */
function splitModel(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return { provider: 'reasonix', model: 'unknown' };
  const slash = text.indexOf('/');
  if (slash < 0) return { provider: 'reasonix', model: text };
  return { provider: text.slice(0, slash) || 'reasonix', model: text.slice(slash + 1) || 'unknown' };
}

export function enumerate(spec) {
  const dirs = (spec.paths ?? []).filter((dir) => existsSync(dir));
  if (dirs.length === 0) return [];
  return walkFiles(dirs, { extensions: ['.jsonl'], maxFiles: 20000, maxDepth: 3 })
    .filter((file) => !basename(file.path).startsWith('.'))
    .map((file) => ({
      id: `reasonix:${file.path}`,
      source: 'reasonix',
      path: file.path,
      size: file.size,
      mtimeMs: file.mtimeMs,
      label: basename(file.path).replace(/\.jsonl$/, ''),
    }));
}

export function parse(item) {
  const acc = makeAccumulator(emptyHours);
  const label = item.label ?? basename(item.path);

  for (const line of iterateFileLines(item.path)) {
    if (!line.includes('"prompt"') && !line.includes('"cache_miss"')) continue;
    const row = safeParse(line);
    if (!row || typeof row !== 'object') continue;

    const cacheMiss = num(row.cache_miss);
    const cacheHit = num(row.cache_hit);
    const completion = num(row.completion);
    const reasoning = num(row.reasoning);
    // 兼容少数只有 prompt/total 的记录：把 prompt - cache_hit 当作新鲜输入
    const prompt = num(row.prompt);
    const input = cacheMiss > 0 ? cacheMiss : Math.max(0, prompt - cacheHit);
    if (input + cacheHit + completion === 0) continue;

    const { provider, model } = splitModel(row.model);
    const ts = toMillis(row.ts);
    const day = localDay(ts);
    const requests = Math.max(1, num(row.requests));

    // project：统计文件里没有项目维度，用来源（desktop / cli）标识，避免伪造
    const project = String(row.source ?? 'reasonix') === 'desktop' ? 'Reasonix' : `Reasonix/${row.source}`;

    const usage = { input, output: completion, cacheRead: cacheHit, cacheWrite: 0, reasoning };
    addUsage(acc.buckets, makeKey(day, 'reasonix', provider, model, project), usage);
    if (requests > 1) {
      // requests 字段偶尔会聚合多条，补记次数
      acc.buckets[makeKey(day, 'reasonix', provider, model, project)][5] += requests - 1;
    }
    bumpHours(acc, ts, input + cacheHit + completion);
    if (ts > 0) {
      acc.firstTs = acc.firstTs === 0 ? ts : Math.min(acc.firstTs, ts);
      acc.lastTs = Math.max(acc.lastTs, ts);
    }
    acc.sessions.add(label);
    acc.events += requests;
    pushRecent(acc, {
      ts,
      source: 'reasonix',
      provider,
      model,
      project,
      total: input + cacheHit + completion,
      input,
      output: completion,
      cacheRead: cacheHit,
    });
  }
  return finalizeAccumulator(acc);
}
