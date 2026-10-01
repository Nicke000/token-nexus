/**
 * scanners/vscode-ai.mjs —— VSCode 系 AI 编程扩展（Cline / Roo Code / Kilo Code 及各种分支）
 *
 * 目录结构（各分支一致）：
 *   <globalStorage>/<扩展 id>/tasks/<taskId>/
 *     task_metadata.json   { files_in_context, model_usage:[{ts, model_id, model_provider_id, mode,
 *                            tokensIn, tokensOut, cacheReads, cacheWrites, cost}], environment_history }
 *     ui_messages.json     [{ ts, type, say:"api_req_started"|"api_req_finished", text:"<JSON 字符串>" }]
 *
 * 用量可能出现在两处，且不同分支/版本只写其中一处：
 *   · model_usage[]      —— 每个模型一段，含 tokensIn/tokensOut/cacheReads/cacheWrites/cost
 *   · ui_messages 的 api_req_* 条目 text 里的 JSON —— 每次请求一段
 *
 * 去重策略：**优先 model_usage**；只有当它完全没有 token 时才去解析 ui_messages。
 * 这样既不会漏，也不会把同一次请求算两遍。
 *
 * 实测（Cline 算力版）：model_usage 只记了「用了哪个模型」，token 全是 0 —— 这时候
 * 不产生任何 bucket，只把「检测到 N 个任务」记在 extra 里，界面照实显示。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { makeAccumulator, finalizeAccumulator, pushRecent } from './_shared.mjs';
import { addUsage, makeKey, localDay, bumpHours, emptyHours, projectNameFromPath, toMillis } from '../usage.mjs';

export const meta = {
  id: 'vscode-ai',
  label: 'Cline / Roo / Kilo',
  granularity: 'per-request',
  fields: ['provider', 'model'],
  note: '读取 tasks 下的 model_usage 与 api_req_* 记录；两者都优先使用前者避免重复计数。',
};

/** 只认这些名字形态的扩展目录，避免把别的扩展的 tasks 目录误当成本工具的 */
const EXTENSION_PATTERN = /cline|roo-|roo_|roocode|kilo/i;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function enumerate(spec) {
  const items = [];
  const seen = new Set();

  const addTask = (taskDir, extension) => {
    const uiMessages = join(taskDir, 'ui_messages.json');
    const metadata = join(taskDir, 'task_metadata.json');
    const hasUi = existsSync(uiMessages);
    const hasMeta = existsSync(metadata);
    if (!hasUi && !hasMeta) return;
    const key = taskDir.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    let size = 0;
    let mtimeMs = 0;
    for (const file of [uiMessages, metadata]) {
      try {
        const stat = statSync(file);
        size += stat.size;
        mtimeMs = Math.max(mtimeMs, stat.mtimeMs);
      } catch {
        /* 文件可能在读取间隙被删掉 */
      }
    }
    items.push({
      id: `vscode-ai:${taskDir}`,
      source: 'vscode-ai',
      path: taskDir,
      size,
      mtimeMs,
      extension,
      uiMessagesPath: hasUi ? uiMessages : null,
      metadataPath: hasMeta ? metadata : null,
    });
  };

  for (const root of spec.paths ?? []) {
    if (!existsSync(root)) continue;
    // root 可能是 globalStorage（下面若干扩展目录），也可能直接是某个扩展目录
    const candidates = [{ dir: root, name: basename(root) }];
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) candidates.push({ dir: join(root, entry.name), name: entry.name });
      }
    } catch {
      /* 目录不可读就跳过 */
    }

    for (const candidate of candidates) {
      if (!EXTENSION_PATTERN.test(candidate.name)) continue;
      const tasksDir = join(candidate.dir, 'tasks');
      if (!existsSync(tasksDir)) continue;
      let tasks;
      try {
        tasks = readdirSync(tasksDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const task of tasks) {
        if (task.isDirectory()) addTask(join(tasksDir, task.name), candidate.name);
      }
    }
  }
  return items;
}

/** 从 ui_messages 的 api_req_* 条目里抠用量 */
function usageFromUiMessages(messages) {
  const rows = [];
  for (const message of messages) {
    const say = String(message?.say ?? '');
    if (say !== 'api_req_started' && say !== 'api_req_finished') continue;
    let payload = message.text;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        continue;
      }
    }
    if (!payload || typeof payload !== 'object') continue;
    const tokensIn = num(payload.tokensIn);
    const tokensOut = num(payload.tokensOut);
    const cacheReads = num(payload.cacheReads);
    const cacheWrites = num(payload.cacheWrites);
    if (tokensIn + tokensOut + cacheReads + cacheWrites === 0) continue;
    rows.push({
      ts: toMillis(message.ts),
      input: Math.max(0, tokensIn - cacheReads), // Cline 的 tokensIn 含缓存读
      output: tokensOut,
      cacheRead: cacheReads,
      cacheWrite: cacheWrites,
      model: payload.modelId || payload.model || null,
      // 刻意不在这里兜底 provider：交给调用方决定（它才知道 model_usage 里有没有模型可归因）
      provider: payload.modelProviderId || payload.provider || null,
      cost: Number(payload.cost) || 0,
    });
  }
  return rows;
}

export function parse(item) {
  const acc = makeAccumulator(emptyHours);
  const extra = { tasks: 1, requests: 0, models: [], mode: 'none', extension: item.extension ?? '' };
  const taskId = basename(item.path);
  const dirTs = /^\d{10,13}$/.test(taskId) ? Number(taskId) : 0;

  // 项目名：task_metadata 的 environment_history 里有 workspace 信息
  let project = 'Cline';
  const metadata = item.metadataPath ? readJson(item.metadataPath) : null;
  if (metadata) {
    const history = metadata.environment_history;
    const first = Array.isArray(history) ? history[0] : null;
    const cwd = first?.cwd || first?.workspace || first?.workspacePath;
    if (typeof cwd === 'string' && cwd !== '') project = projectNameFromPath(cwd);
  }

  const collected = [];

  // 1) 优先 model_usage（它才是逐模型的聚合，且不会与 ui_messages 重复）
  const modelUsage = Array.isArray(metadata?.model_usage) ? metadata.model_usage : [];
  for (const row of modelUsage) {
    const tokensIn = num(row.tokensIn);
    const tokensOut = num(row.tokensOut);
    const cacheReads = num(row.cacheReads);
    const cacheWrites = num(row.cacheWrites);
    if (tokensIn + tokensOut + cacheReads + cacheWrites === 0) continue;
    const model = String(row.model_id || 'unknown');
    if (!extra.models.includes(model)) extra.models.push(model);
    collected.push({
      key: `${row.ts ?? dirTs}|${model}`,
      ts: toMillis(row.ts, dirTs),
      input: Math.max(0, tokensIn - cacheReads),
      output: tokensOut,
      cacheRead: cacheReads,
      cacheWrite: cacheWrites,
      model,
      provider: String(row.model_provider_id || 'cline'),
    });
  }

  // 2) model_usage 没有 token 时，才去解析 ui_messages，避免重复计数
  if (collected.length === 0 && item.uiMessagesPath) {
    // 归因修复：model_usage 常常只记「用了哪个模型」而不记 token，
    // 而 api_req_started 里又只有 token 没有模型。若该任务自始至终只用一个模型，
    // 就把这些 token 归到它头上（可定价）；多个模型则无法判断，保持 unknown —— 不猜。
    const distinctModels = [...new Set(modelUsage.map((row) => row.model_id).filter(Boolean))];
    const fallbackModel = distinctModels.length === 1 ? String(distinctModels[0]) : null;
    const fallbackProvider = distinctModels.length === 1
      ? String(modelUsage.find((row) => row.model_id)?.model_provider_id || 'cline')
      : 'cline';

    const messages = readJson(item.uiMessagesPath);
    if (Array.isArray(messages)) {
      for (const [index, row] of usageFromUiMessages(messages).entries()) {
        const model = String(row.model || fallbackModel || 'unknown');
        const provider = String(row.provider || (row.model || fallbackModel ? fallbackProvider : 'cline'));
        if (!extra.models.includes(model)) extra.models.push(model);
        collected.push({ ...row, provider, key: `${row.ts}|${index}`, model });
      }
    }
  }

  if (collected.length > 0) {
    extra.mode = 'tokens';
    const seen = new Set();
    for (const row of collected) {
      if (seen.has(row.key)) continue;
      seen.add(row.key);
      const ts = row.ts || dirTs;
      const usage = {
        input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite, reasoning: 0,
      };
      addUsage(acc.buckets, makeKey(localDay(ts), 'vscode-ai', row.provider, row.model, project), usage);
      bumpHours(acc, ts, row.input + row.output + row.cacheRead + row.cacheWrite);
      if (ts > 0) {
        acc.firstTs = acc.firstTs === 0 ? ts : Math.min(acc.firstTs, ts);
        acc.lastTs = Math.max(acc.lastTs, ts);
      }
      extra.requests += 1;
      acc.events += 1;
      pushRecent(acc, {
        ts,
        source: 'vscode-ai',
        provider: row.provider,
        model: row.model,
        project,
        total: row.input + row.output + row.cacheRead + row.cacheWrite,
        input: row.input,
        output: row.output,
        cacheRead: row.cacheRead,
      });
    }
  } else {
    // 检测到了任务，但这个分支/版本没记 token —— 如实记录，不编数字
    extra.requests = Array.isArray(modelUsage) ? modelUsage.length : 0;
    for (const row of modelUsage) {
      const model = String(row.model_id || '').trim();
      if (model && !extra.models.includes(model)) extra.models.push(model);
    }
  }

  acc.sessions.add(taskId);
  return { ...finalizeAccumulator(acc), extra };
}
