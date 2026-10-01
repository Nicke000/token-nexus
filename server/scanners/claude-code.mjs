/**
 * scanners/claude-code.mjs —— Claude Code 会话
 *
 *   <root>/<编码后的 cwd>/<sessionId>.jsonl
 *
 * 行形态：
 *   {"type":"assistant","sessionId":"...","cwd":"/Users/x/proj","timestamp":"2026-..",
 *    "requestId":"req_..","message":{"id":"msg_..","model":"claude-sonnet-4-5",
 *      "usage":{"input_tokens":4,"cache_creation_input_tokens":1234,
 *               "cache_read_input_tokens":5678,"output_tokens":89}}}
 *
 * 坑：Claude Code 是「一个内容块一行」，同一条 assistant 消息会被写多行，
 * 每行都带**完整** usage。不去重就会把同一次请求算 N 遍（N 常是 2~6）。
 * 去重键取 message.id（退化到 requestId）。
 */
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { walkFiles } from '../paths.mjs';
import {
  iterateFileLines, safeParse, makeAccumulator, finalizeAccumulator, pushRecent,
} from './_shared.mjs';
import {
  addUsage, makeKey, localDay, bumpHours, emptyHours, normalizeUsage, projectNameFromPath, toMillis,
} from '../usage.mjs';

export const meta = {
  id: 'claude-code',
  label: 'Claude Code',
  granularity: 'per-request',
  fields: ['model', 'project', 'session'],
  note: '按 message.id 去重；cache_creation / cache_read 分开统计。',
};

export function enumerate(spec) {
  const dirs = (spec.paths ?? []).filter((dir) => existsSync(dir));
  if (dirs.length === 0) return [];
  return walkFiles(dirs, { extensions: ['.jsonl'], maxFiles: 200000 }).map((file) => ({
    id: `claude-code:${file.path}`,
    source: 'claude-code',
    path: file.path,
    size: file.size,
    mtimeMs: file.mtimeMs,
  }));
}

export function parse(item) {
  const acc = makeAccumulator(emptyHours);
  const seen = new Set();
  let project = '—';
  let sessionId = basename(item.path).replace(/\.jsonl$/, '');
  let lastModel = 'claude';

  for (const line of iterateFileLines(item.path)) {
    if (!line.includes('"usage"')) continue;
    const event = safeParse(line);
    if (!event) {
      acc.skipped += 1;
      continue;
    }
    const message = event.message;
    if (!message || typeof message !== 'object') continue;
    const usage = normalizeUsage(message.usage, { semantics: 'exclusive' });
    if (!usage) continue;

    const dedupeKey = message.id || event.requestId || event.uuid;
    if (dedupeKey) {
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
    }
    if (typeof event.cwd === 'string' && event.cwd !== '') project = projectNameFromPath(event.cwd);
    if (typeof event.sessionId === 'string') sessionId = event.sessionId;
    const model = String(message.model || lastModel);
    lastModel = model;

    const ts = toMillis(event.timestamp);
    const day = localDay(ts);
    addUsage(acc.buckets, makeKey(day, 'claude-code', 'anthropic', model, project), usage);
    const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    bumpHours(acc, ts, total);
    if (ts > 0) {
      acc.firstTs = acc.firstTs === 0 ? ts : Math.min(acc.firstTs, ts);
      acc.lastTs = Math.max(acc.lastTs, ts);
    }
    acc.sessions.add(sessionId);
    acc.events += 1;
    pushRecent(acc, {
      ts,
      source: 'claude-code',
      provider: 'anthropic',
      model,
      project,
      total,
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
    });
  }
  return finalizeAccumulator(acc);
}
