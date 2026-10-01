/**
 * scanners/opencode.mjs —— OpenCode 用量
 *
 * 数据在 SQLite：`~/.local/share/opencode/opencode.db`（Windows 在 `%LOCALAPPDATA%`）。
 *
 * 主路径读 `message` 表，每行 `data` 是一段 JSON：
 *   {"role":"assistant","modelID":"deepseek-v4-flash-free","providerID":"opencode",
 *    "path":{"cwd":"E:\\AIhuabu"},"time":{"created":1787077554996},
 *    "tokens":{"total":10339,"input":10271,"output":48,"reasoning":20,
 *              "cache":{"write":0,"read":0}}}
 *
 * 口径实测：它们的 `total = input + output + reasoning`，说明
 *   · `input` **不含**缓存读（cache.read 是独立字段）→ 与我们的 input 一致；
 *   · `reasoning` 是**独立计入** total 的，不是 output 的子集 →
 *     折算成我们的口径时 output 要加上 reasoning（我们的 total 不含 reasoning）。
 *
 * 兜底：若 `message` 为空，退回读 `session` 表的聚合列
 *   （tokens_input / tokens_output / tokens_reasoning / tokens_cache_read / tokens_cache_write）。
 * 全程只读打开，绝不写入。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { walkFiles } from '../paths.mjs';
import { makeAccumulator, finalizeAccumulator, pushRecent } from './_shared.mjs';
import { addUsage, makeKey, localDay, bumpHours, emptyHours, projectNameFromPath } from '../usage.mjs';

export const meta = {
  id: 'opencode',
  label: 'OpenCode',
  granularity: 'per-message',
  fields: ['provider', 'model', 'project'],
  note: '读 SQLite 的 message 表，逐条带 model / cwd / 缓存读写。',
};

let sqliteModule = null;
let sqliteTried = false;

async function loadSqlite() {
  if (sqliteTried) return sqliteModule;
  sqliteTried = true;
  try {
    sqliteModule = await import('node:sqlite');
  } catch {
    sqliteModule = null;
  }
  return sqliteModule;
}

export async function enumerate(spec) {
  const items = [];
  const seen = new Set();
  for (const root of spec.paths ?? []) {
    if (!existsSync(root)) continue;
    const files = walkFiles([root], { extensions: ['.db'], maxFiles: 100, maxDepth: 3 });
    for (const file of files) {
      if (!/opencode/i.test(file.path)) continue;
      const key = file.path.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        id: `opencode:${file.path}`,
        source: 'opencode',
        path: file.path,
        size: file.size,
        mtimeMs: file.mtimeMs,
      });
    }
  }
  return items;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function usageFromTokens(tokens) {
  if (!tokens || typeof tokens !== 'object') return null;
  const input = num(tokens.input);
  const cacheRead = num(tokens.cache?.read);
  const cacheWrite = num(tokens.cache?.write);
  const reasoning = num(tokens.reasoning);
  // 它们的 total 把 reasoning 单独计入 → 折算成我们的口径时补进 output
  const output = num(tokens.output) + reasoning;
  if (input + cacheRead + cacheWrite + output === 0) return null;
  return { input, output, cacheRead, cacheWrite, reasoning };
}

export async function parse(item) {
  const acc = makeAccumulator(emptyHours);
  const extra = { messages: 0, sessions: 0, mode: 'message' };
  const sqlite = await loadSqlite();
  if (!sqlite) {
    return { ...finalizeAccumulator(acc), extra, unavailable: 'node:sqlite 不可用（需要 Node >= 22.5）' };
  }

  let db;
  try {
    db = new sqlite.DatabaseSync(item.path, { readOnly: true });
  } catch (error) {
    return { ...finalizeAccumulator(acc), extra, unavailable: `无法打开（可能正被 OpenCode 占用）：${error.message}` };
  }

  const readAll = (sql) => {
    try {
      return db.prepare(sql).all();
    } catch {
      return [];
    }
  };

  try {
    // 会话表提供项目目录兜底
    const sessions = new Map();
    for (const row of readAll('SELECT id, directory FROM session')) {
      sessions.set(String(row.id), row.directory || null);
    }
    extra.sessions = sessions.size;

    let handled = 0;
    for (const row of readAll('SELECT session_id, data FROM message')) {
      let data;
      try {
        data = JSON.parse(String(row.data));
      } catch {
        continue;
      }
      const usage = usageFromTokens(data.tokens);
      if (!usage) continue;
      const ts = Number(data.time?.created) || 0;
      const provider = String(data.providerID || 'opencode');
      const model = String(data.modelID || 'unknown');
      const cwd = data.path?.cwd || sessions.get(String(row.session_id)) || null;
      const project = cwd ? projectNameFromPath(cwd) : 'OpenCode';

      const day = localDay(ts);
      addUsage(acc.buckets, makeKey(day, 'opencode', provider, model, project), usage);
      bumpHours(acc, ts, usage.input + usage.output + usage.cacheRead + usage.cacheWrite);
      if (ts > 0) {
        acc.firstTs = acc.firstTs === 0 ? ts : Math.min(acc.firstTs, ts);
        acc.lastTs = Math.max(acc.lastTs, ts);
      }
      acc.sessions.add(String(row.session_id));
      acc.events += 1;
      handled += 1;
      pushRecent(acc, {
        ts,
        source: 'opencode',
        provider,
        model,
        project,
        total: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
      });
    }
    extra.messages = handled;

    // 兜底：message 表没数据时用 session 的聚合列（粒度是整会话）
    if (handled === 0) {
      extra.mode = 'session';
      for (const row of readAll(`SELECT id, directory, tokens_input, tokens_output, tokens_reasoning,
        tokens_cache_read, tokens_cache_write, time_created, time_updated, model FROM session`)) {
        const usage = usageFromTokens({
          input: row.tokens_input,
          output: row.tokens_output,
          reasoning: row.tokens_reasoning,
          cache: { read: row.tokens_cache_read, write: row.tokens_cache_write },
        });
        if (!usage) continue;
        let model = 'unknown';
        let provider = 'opencode';
        try {
          const parsed = JSON.parse(String(row.model));
          model = parsed?.id ?? model;
          provider = parsed?.providerID ?? provider;
        } catch {
          if (row.model) model = String(row.model);
        }
        const ts = Number(row.time_updated || row.time_created) || 0;
        const project = row.directory ? projectNameFromPath(row.directory) : 'OpenCode';
        addUsage(acc.buckets, makeKey(localDay(ts), 'opencode', provider, model, project), usage);
        bumpHours(acc, ts, usage.input + usage.output + usage.cacheRead + usage.cacheWrite);
        if (ts > 0) {
          acc.firstTs = acc.firstTs === 0 ? ts : Math.min(acc.firstTs, ts);
          acc.lastTs = Math.max(acc.lastTs, ts);
        }
        acc.sessions.add(String(row.id));
        acc.events += 1;
      }
    }
  } finally {
    try {
      db.close();
    } catch {
      /* 忽略关闭失败 */
    }
  }

  return { ...finalizeAccumulator(acc), extra };
}

export { join };
