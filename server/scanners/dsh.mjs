/**
 * scanners/dsh.mjs —— DeepSeek Harness 会话日志
 *
 * 目录结构（DSH / Codex 系 agent 的通用约定）：
 *   <root>/<workspace-slug>/<session-id>/session.v3.jsonl.zstd   ← 新格式，优先
 *   <root>/<workspace-slug>/<session-id>/session.jsonl.zstd      ← 旧格式，兜底
 *
 * 两种格式里 `assistant/message` 事件的 usage 与 token 总量**完全一致**，
 * 但 v3 体量只有旧格式的 1/4（旧格式还把流式 chunk 也逐帧存了一遍）。
 * 所以：有 v3 就读 v3，没有才退回旧格式，绝不双读。
 *
 * 单条事件长这样：
 *   {"type":"assistant/message","seq":17,"time":1790594570197,"data":{
 *      "message":{"source":{"provider":"autodl","model":"DeepSeek-V4.1-Flash"}},
 *      "usage":{"inputTokens":11634,"outputTokens":159,"totalTokens":11793}}}
 */
import { existsSync, readdirSync, statSync } from 'node:fs';import { join, basename } from 'node:path';
import {
  safeParse, makeAccumulator, finalizeAccumulator, pushRecent,
  readFileBufferFrom, decodeZstdFramesFrom, splitUtf8, frameLength,
} from './_shared.mjs';
import {
  addUsage, makeKey, localDay, bumpHours, emptyHours, normalizeUsage, projectNameFromPath,
} from '../usage.mjs';

export const meta = {
  id: 'dsh',
  label: 'DeepSeek Harness',
  granularity: 'per-request',
  fields: ['provider', 'model', 'project', 'session', 'reasoning'],
  note: '逐条 assistant/message 的 usage 明细，最精确的来源。',
};

const V3_NAME = 'session.v3.jsonl.zstd';
const LEGACY_NAME = 'session.jsonl.zstd';

/** 枚举出所有待解析的会话日志（会话目录里 v3 优先、旧格式兜底）。 */
export function enumerate(spec) {
  const items = [];
  for (const root of spec.paths ?? []) {
    if (!existsSync(root)) continue;
    let workspaces;
    try {
      workspaces = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const workspace of workspaces) {
      if (!workspace.isDirectory()) continue;
      const wsDir = join(root, workspace.name);
      let sessions;
      try {
        sessions = readdirSync(wsDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const session of sessions) {
        if (!session.isDirectory()) continue;
        const sessionDir = join(wsDir, session.name);
        const candidates = [join(sessionDir, V3_NAME), join(sessionDir, LEGACY_NAME)];
        const chosen = candidates.find((p) => existsSync(p));
        if (!chosen) continue;
        let stat;
        try {
          stat = statSync(chosen);
        } catch {
          continue;
        }
        if (stat.size === 0) continue;
        items.push({
          id: `dsh:${chosen}`,
          source: 'dsh',
          path: chosen,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          workspace: workspace.name,
          format: basename(chosen) === V3_NAME ? 'v3' : 'legacy',
        });
      }
    }
  }
  return items;
}

/**
 * 解析一个会话日志。注意：运行在 worker 线程里，不能用闭包里的外部状态。
 *
 * ── 增量（只读新增尾巴）────────────────────────────────────────────────
 * 会话日志是**追加式**的：新事件只是往文件尾追几帧。不记住进度的话，日志每动一次
 * 就要把整个 17MB 文件重解一遍（实测 0.5 秒），刷新频率根本提不上去。
 *
 * 所以把「上一轮消费到哪个字节」以及解析中途的上下文（project / provider / model /
 * 半行尾巴 / 半个 UTF-8 字符）一起存进缓存。下一轮从该偏移继续，只解新增的帧。
 *
 * 安全性：如果续读位置解不出合法帧（文件被重写、被截断、偏移对不上），
 * 自动退回全量解析 —— 宁可慢一次，也绝不静默漏数据。
 */
export function parse(item) {
  const resume = item.resume ?? null;
  const acc = makeAccumulator(emptyHours);

  // 把上一轮的累计结果装回来（深拷贝，绝不能污染缓存里的对象）
  if (resume?.base) {
    for (const [key, bucket] of Object.entries(resume.base.buckets ?? {})) {
      acc.buckets[key] = bucket.slice();
    }
    for (let i = 0; i < 24; i += 1) acc.hours[i] = resume.base.hours?.[i] ?? 0;
    for (const [day, hours] of Object.entries(resume.base.hoursByDay ?? {})) {
      acc.hoursByDay[day] = hours.slice();
    }
    acc.recent = (resume.base.recent ?? []).map((row) => ({ ...row }));
    acc.firstTs = resume.base.firstTs ?? 0;
    acc.lastTs = resume.base.lastTs ?? 0;
    acc.events = resume.base.events ?? 0;
  }

  const state = {
    project: resume?.state?.project ?? projectNameFromPath(decodeWorkspaceSlug(item.workspace)),
    sessionId: resume?.state?.sessionId ?? basename(item.path),
    provider: resume?.state?.provider ?? 'unknown',
    model: resume?.state?.model ?? 'unknown',
    headerSeen: resume?.state?.headerSeen ?? false,
    /** 上一轮结尾的半行（已消费字节对应的文本，必须带到下一轮） */
    lineTail: resume?.state?.lineTail ?? '',
    /** 上一轮结尾的不完整 UTF-8 字节（最多 3 字节） */
    byteTail: resume?.state?.byteTail ?? '',
  };

  const startOffset = resume?.parsedBytes ?? 0;
  let buffer;
  try {
    buffer = readFileBufferFrom(item.path, startOffset);
  } catch {
    return finalizeAccumulator(acc);
  }

  if (resume) {
    // 文件被截断 / 重写过（变小了）→ 续读偏移已经不可信，必须全量重来
    let size = 0;
    try {
      size = statSync(item.path).size;
    } catch {
      /* 读不到就当作失配处理 */
    }
    if (startOffset > size) return parse({ ...item, resume: null });
    // 续读位置解不出合法帧 → 偏移失配，同样退回全量。
    // 宁可慢一次，也绝不静默漏数据。
    if (buffer.length > 0 && frameLength(buffer, 0) < 0) return parse({ ...item, resume: null });
  }

  let consumed = startOffset;
  let lineTail = state.lineTail;
  let byteTail = state.byteTail ? Buffer.from(state.byteTail, 'base64') : Buffer.alloc(0);

  for (const frame of decodeZstdFramesFrom(buffer, 0)) {
    // 帧与帧之间可能切开一个多字节字符，用字节尾巴把它接上
    const combined = byteTail.length > 0 ? Buffer.concat([byteTail, frame.data]) : frame.data;
    const { text, pending } = splitUtf8(combined);
    byteTail = pending;

    let carry = lineTail + text.toString('utf8');
    lineTail = '';
    let index = carry.indexOf('\n');
    while (index >= 0) {
      const line = carry.slice(0, index);
      carry = carry.slice(index + 1);
      if (line.length > 0) handleLine(line, acc, state);
      index = carry.indexOf('\n');
    }
    lineTail = carry;
    consumed = startOffset + frame.end;
  }

  // 消费到的会话
  if (state.sessionId) acc.sessions.add(state.sessionId);

  return {
    ...finalizeAccumulator(acc),
    parsedBytes: consumed,
    resumeState: {
      ...state,
      lineTail,
      byteTail: byteTail.length > 0 ? byteTail.toString('base64') : '',
    },
  };
}

/** 处理一行日志。抽出来是为了让全量与增量两条路径共用同一套逻辑。 */
function handleLine(line, acc, state) {
  // 快速路径：95% 的行跟用量无关，先做廉价子串判断再 JSON.parse
  const interesting = line.includes('"assistant/message"')
    || line.includes('"request/header"')
    || line.startsWith('{"type":"session"');
  if (!interesting) return;
  const event = safeParse(line);
  if (!event) {
    acc.skipped += 1;
    return;
  }
  const data = event.data ?? {};

  if (event.type === 'session') {
    // 会话头的字段在**顶层**，不在 data 里：
    //   {"type":"session","version":0,"id":"...","createdAt":...,"cwd":"E:\\moreai",...}
    // 早期版本按 data.cwd 读，永远读不到，于是项目名一直是用目录名硬解出来的
    // 乱码（E:/DS-434-65F6-2 这种）。现在优先取真实 cwd。
    const cwd = typeof event.cwd === 'string' ? event.cwd : data.cwd;
    if (typeof cwd === 'string' && cwd !== '') state.project = projectNameFromPath(cwd);
    const id = event.id ?? data.id;
    if (typeof id === 'string' && id !== '') state.sessionId = id;
    state.headerSeen = true;
    const created = Number(event.createdAt ?? data.createdAt) || 0;
    if (created > 0) {
      acc.firstTs = acc.firstTs === 0 ? created : Math.min(acc.firstTs, created);
      acc.lastTs = Math.max(acc.lastTs, created);
    }
    return;
  }

  if (event.type === 'request/header') {
    // 逐条 usage 不一定带 provider/model，用最近的请求头兜底
    const config = data.header?.config ?? {};
    if (config.provider) state.provider = String(config.provider);
    if (config.model) state.model = String(config.model);
    return;
  }

  if (event.type === 'assistant/message') {
    const usage = normalizeUsage(data.usage, { semantics: 'exclusive' });
    if (!usage) return;
    const source = data.message?.source ?? {};
    const rowProvider = String(source.provider || state.provider || 'unknown');
    const rowModel = String(source.model || state.model || 'unknown');
    const ts = Number(event.time) || 0;
    const day = localDay(ts);
    addUsage(acc.buckets, makeKey(day, 'dsh', rowProvider, rowModel, state.project), usage);
    bumpHours(acc, ts, usage.input + usage.output + usage.cacheRead + usage.cacheWrite);
    if (ts > 0) {
      acc.firstTs = acc.firstTs === 0 ? ts : Math.min(acc.firstTs, ts);
      acc.lastTs = Math.max(acc.lastTs, ts);
    }
    acc.events += 1;
    pushRecent(acc, {
      ts,
      source: 'dsh',
      provider: rowProvider,
      model: rowModel,
      project: state.project,
      total: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
    });
  }
}

/**
 * DSH 把工作目录编码成目录名：`C:\work\demo` → `--C-work-demo--`，
 * 其中非 ASCII 字符按 UTF-16 码元写成 `~XXXX`（`临` → `~4E34`）。
 * 反解只是为了在拿不到 session 头（旧/损坏文件）时给个像样的项目名：
 * 只能还原盘符和这些码元，中间的分隔符已经丢失，还原不回真正的 `\`。
 */
function decodeWorkspaceSlug(slug) {
  if (!slug) return '—';
  let text = slug;
  if (text.startsWith('--')) text = text.slice(2);
  if (text.endsWith('--')) text = text.slice(0, -2);
  const parts = text.split('-').filter(Boolean).map((part) => {
    if (!part.startsWith('~')) return part;
    const hex = part.slice(1);
    if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return part;
    return String.fromCharCode(parseInt(hex, 16));
  });
  const joined = parts.join('-');
  return joined.replace(/^([A-Za-z])(?::?)(?=\\|$)/, '$1:').replace(/^([A-Za-z])-(?=[^\\/]*$)/, '$1:\\');
}
