/**
 * scanners/cursor.mjs —— Cursor 本地用量
 *
 * 两个 SQLite：
 *   1. ~/.cursor/ai-tracking/ai-code-tracking.db
 *        ai_code_hashes(model, timestamp, fileName) —— 只有「AI 生成过哪些代码」，
 *        没有 token。用它做一个附加指标（AI 代码文件数），不混进 token 口径。
 *   2. <appData>/Cursor/User/globalStorage/state.vscdb
 *        cursorDiskKV 里 key = "bubbleId:<composerId>:<bubbleId>"，
 *        value = {... "tokenCount":{"inputTokens":N,"outputTokens":M},
 *                  "createdAt":"2026-05-26T11:57:18.989Z" ...}
 *        cursorData 里 key = "composerData:<composerId>" 带 modelConfig / 工程信息。
 *
 * 用 Node 内置的 node:sqlite 只读打开，**不写、不改、不锁**用户数据。
 * 没有 node:sqlite（Node < 22.5）或文件被 Cursor 锁住时优雅降级。
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { walkFiles } from '../paths.mjs';
import { makeAccumulator, finalizeAccumulator, pushRecent } from './_shared.mjs';
import { addUsage, makeKey, localDay, bumpHours, emptyHours, toMillis, projectNameFromPath } from '../usage.mjs';

export const meta = {
  id: 'cursor',
  label: 'Cursor',
  granularity: 'per-message',
  fields: ['model', 'timestamp'],
  note: 'Cursor 只在本地记录 输入/输出，没有缓存字段；已生成部分为 0 的条目会被忽略。',
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
  for (const root of spec.paths ?? []) {
    if (!existsSync(root)) continue;
    // root 可能直接是 globalStorage，也可能是一个包含它的目录
    const candidates = walkFiles([root], { extensions: ['.db', '.vscdb'], maxFiles: 500, maxDepth: 4 });
    for (const file of candidates) {
      const name = file.path.toLowerCase();
      const kind = name.endsWith('state.vscdb') ? 'chat-db'
        : name.endsWith('ai-code-tracking.db') ? 'ai-tracking'
          : null;
      if (!kind) continue;
      items.push({
        id: `cursor:${kind}:${file.path}`,
        source: 'cursor',
        path: file.path,
        size: file.size,
        mtimeMs: file.mtimeMs,
        kind,
      });
    }
  }
  return items;
}

function readAll(db, sql) {
  try {
    return db.prepare(sql).all();
  } catch {
    return [];
  }
}

function modelFromComposerData(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const config = raw.modelConfig ?? {};
  return config.modelName || config.model || config.selectedModel || null;
}

function projectFromComposerData(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const uris = raw.workspaceUris ?? raw.workspaceFolders;
  if (Array.isArray(uris) && uris.length > 0) {
    const first = String(uris[0]).replace(/^file:\/\/\/?/, '');
    return projectNameFromPath(decodeURIComponent(first));
  }
  const selections = raw.context?.folderSelections;
  if (Array.isArray(selections) && selections.length > 0) {
    const first = selections[0];
    const path = typeof first === 'string' ? first : first?.path || first?.uri;
    if (path) return projectNameFromPath(String(path).replace(/^file:\/\/\/?/, ''));
  }
  const repos = raw.trackedGitRepos;
  if (Array.isArray(repos) && repos.length > 0) {
    const first = repos[0];
    const path = typeof first === 'string' ? first : first?.repoPath || first?.rootPath;
    if (path) return projectNameFromPath(String(path));
  }
  return null;
}

export async function parse(item) {
  const acc = makeAccumulator(emptyHours);
  acc.sessions = new Set();
  const extra = { codeHashes: 0, codeHashModels: {}, chatDb: false };

  const sqlite = await loadSqlite();
  if (!sqlite) {
    return { ...finalizeAccumulator(acc), extra, unavailable: 'node:sqlite 不可用（需要 Node >= 22.5）' };
  }

  let db;
  try {
    db = new sqlite.DatabaseSync(item.path, { readOnly: true });
  } catch (error) {
    return { ...finalizeAccumulator(acc), extra, unavailable: `无法打开（可能被 Cursor 占用）：${error.message}` };
  }

  try {
    if (item.kind === 'ai-tracking') {
      const rows = readAll(db, 'SELECT model, timestamp, fileName FROM ai_code_hashes');
      for (const row of rows) {
        const model = String(row.model || 'unknown');
        const ts = toMillis(row.timestamp);
        extra.codeHashes += 1;
        extra.codeHashModels[model] = (extra.codeHashModels[model] || 0) + 1;
        if (ts > 0) {
          acc.firstTs = acc.firstTs === 0 ? ts : Math.min(acc.firstTs, ts);
          acc.lastTs = Math.max(acc.lastTs, ts);
        }
      }
    } else if (item.kind === 'chat-db') {
      extra.chatDb = true;
      // 1) 先建 composer → 模型/项目 的映射
      const composers = readAll(db, "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'");
      const composerInfo = new Map();
      for (const row of composers) {
        let parsed;
        try {
          parsed = JSON.parse(typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf8'));
        } catch {
          continue;
        }
        const composerId = String(row.key).slice('composerData:'.length);
        composerInfo.set(composerId, {
          model: modelFromComposerData(parsed),
          project: projectFromComposerData(parsed),
          createdAt: toMillis(parsed.createdAt),
        });
      }

      // 2) 再扫气泡里的 tokenCount
      const bubbles = readAll(db, "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'");
      for (const row of bubbles) {
        let parsed;
        try {
          parsed = JSON.parse(typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf8'));
        } catch {
          continue;
        }
        const counts = parsed.tokenCount;
        const input = Number(counts?.inputTokens) || 0;
        const output = Number(counts?.outputTokens) || 0;
        if (input === 0 && output === 0) continue;
        const parts = String(row.key).split(':');
        const composerId = parts[1];
        const info = composerInfo.get(composerId) ?? {};
        const model = info.model || 'cursor-auto';
        const project = info.project || 'Cursor';
        const ts = toMillis(parsed.createdAt) || info.createdAt || 0;
        acc.sessions.add(composerId);
        addUsage(acc.buckets, makeKey(localDay(ts), 'cursor', 'cursor', model, project), {
          input, output, cacheRead: 0, cacheWrite: 0, reasoning: 0,
        });
        bumpHours(acc, ts, input + output);
        if (ts > 0) {
          acc.firstTs = acc.firstTs === 0 ? ts : Math.min(acc.firstTs, ts);
          acc.lastTs = Math.max(acc.lastTs, ts);
        }
        acc.events += 1;
        pushRecent(acc, {
          ts, source: 'cursor', provider: 'cursor', model, project,
          total: input + output, input, output, cacheRead: 0,
        });
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

export function statSafe(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

export { join };
