/**
 * scanners/codex.mjs —— Codex CLI rollout 会话
 *
 *   <root>/YYYY/MM/DD/rollout-<时间戳>-<uuid>.jsonl
 *
 * 关键事件：
 *   {"type":"session_meta","payload":{"id","cwd"}}
 *   {"type":"turn_context","payload":{"cwd","model"}}
 *   {"type":"event_msg","payload":{"type":"token_count","info":{
 *       "total_token_usage":{...},  ← 会话累计
 *       "last_token_usage":{...}    ← 本次请求增量
 *   }}}
 *
 * 只累加 last_token_usage（增量），缺了才用 total 的差分。用 total 直接求和会把
 * 同一次请求的前缀重复算 N 遍，量级能差出一个数量级。
 */
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { walkFiles } from '../paths.mjs';
import {
  iterateFileLines, safeParse, makeAccumulator, finalizeAccumulator, pushRecent,
} from './_shared.mjs';
import {
  addUsage, makeKey, localDay, bumpHours, emptyHours, normalizeUsage, projectNameFromPath,
  toMillis,
} from '../usage.mjs';

export const meta = {
  id: 'codex',
  label: 'Codex CLI',
  granularity: 'per-request',
  fields: ['model', 'project', 'session', 'reasoning'],
  note: '取 last_token_usage 增量；input 含 cached，已按 OpenAI 语义剥离。',
};

export function enumerate(spec) {
  const dirs = (spec.paths ?? []).filter((dir) => existsSync(dir));
  if (dirs.length === 0) return [];
  return walkFiles(dirs, { extensions: ['.jsonl'], maxFiles: 200000 }).map((file) => ({
    id: `codex:${file.path}`,
    source: 'codex',
    path: file.path,
    size: file.size,
    mtimeMs: file.mtimeMs,
  }));
}

function usageFromInfo(info) {
  if (!info || typeof info !== 'object') return null;
  const last = info.last_token_usage ?? info.lastTokenUsage ?? info.last_usage;
  if (last && normalizeUsage(last)) return { raw: last, incremental: true };
  const total = info.total_token_usage ?? info.totalTokenUsage;
  if (total) return { raw: total, incremental: false };
  // 有些版本直接把字段摊平在 info 上
  if (normalizeUsage(info)) return { raw: info, incremental: true };
  return null;
}

export function parse(item) {
  const acc = makeAccumulator(emptyHours);
  let project = '—';
  let model = 'unknown';
  let sessionId = basename(item.path).replace(/^rollout-/, '').replace(/\.jsonl$/, '');
  let previousTotal = null;

  for (const line of iterateFileLines(item.path)) {
    if (!line.includes('token') && !line.includes('cwd') && !line.includes('model')) continue;
    const event = safeParse(line);
    if (!event) {
      acc.skipped += 1;
      continue;
    }
    const payload = event.payload ?? event;
    const ts = toMillis(event.timestamp ?? payload.timestamp ?? event.time);

    if (event.type === 'session_meta' || payload.type === 'session_meta') {
      if (payload.id) sessionId = String(payload.id);
      if (payload.cwd) project = projectNameFromPath(payload.cwd);
      continue;
    }
    if (event.type === 'turn_context' || payload.type === 'turn_context') {
      if (payload.cwd) project = projectNameFromPath(payload.cwd);
      if (payload.model) model = String(payload.model);
      continue;
    }

    if (payload.type !== 'token_count') continue;
    const picked = usageFromInfo(payload.info ?? payload);
    if (!picked) continue;
    let usage = normalizeUsage(picked.raw, { semantics: 'inclusive' });
    if (!usage) continue;

    if (!picked.incremental) {
      // total_token_usage：与上一条做差分，避免重复累计
      const snapshot = {
        input: usage.input + usage.cacheRead,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        output: usage.output,
      };
      const key = ['input', 'cacheRead', 'cacheWrite', 'output'];
      if (previousTotal) {
        const delta = {};
        let positive = false;
        for (const field of key) {
          const value = Math.max(0, snapshot[field] - (previousTotal[field] ?? 0));
          delta[field] = value;
          if (value > 0) positive = true;
        }
        previousTotal = snapshot;
        if (!positive) continue;
        usage = { ...delta, reasoning: 0, total: delta.input + delta.cacheRead + delta.cacheWrite + delta.output };
      } else {
        previousTotal = snapshot;
      }
    }

    const day = localDay(ts);
    addUsage(acc.buckets, makeKey(day, 'codex', 'openai', model, project), usage);
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
      source: 'codex',
      provider: 'openai',
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
