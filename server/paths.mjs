/**
 * paths.mjs —— 跨平台数据源自动发现
 *
 * 设计原则（决定这个项目能不能开源给别人用）：
 *   - 只依赖 os.homedir() / 环境变量 / 平台默认目录，绝不写死任何人的路径。
 *   - 每个数据源都先「探测候选根目录」，再判断存在性，最后统计体量。
 *   - 用户可以在配置里追加自定义根目录或整段禁用某个源。
 *   - 每台机器的结果都不同 → 探测结果会原样回传给前端展示，方便用户确认「它到底读到了什么」。
 */
import { existsSync, statSync, readdirSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { join, basename } from 'node:path';

export const IS_WIN = platform() === 'win32';
export const IS_MAC = platform() === 'darwin';
export const HOME = homedir();

/** 各平台的应用数据目录候选（Electron / VS Code 系应用把数据放这里）。 */
export function appDataDirs(appName) {
  const list = [];
  if (IS_WIN) {
    if (process.env.APPDATA) list.push(join(process.env.APPDATA, appName));
    if (process.env.LOCALAPPDATA) list.push(join(process.env.LOCALAPPDATA, appName));
  } else if (IS_MAC) {
    list.push(join(HOME, 'Library', 'Application Support', appName));
  } else {
    const xdg = process.env.XDG_CONFIG_HOME || join(HOME, '.config');
    list.push(join(xdg, appName));
    list.push(join(xdg, appName.toLowerCase()));
  }
  return list;
}

function unique(paths) {
  const seen = new Set();
  const out = [];
  for (const p of paths) {
    if (typeof p !== 'string' || p === '') continue;
    const norm = p.replace(/[\\/]+$/, '');
    const key = IS_WIN ? norm.toLowerCase() : norm;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(norm);
  }
  return out;
}

function dirSize(dir, budgetMs = 400) {
  // 只做大致的体量统计（用于「这个东西有多大」的展示），限量避免在巨型目录上卡死。
  const started = Date.now();
  let files = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    if (Date.now() - started > budgetMs) break;
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        files += 1;
        try {
          bytes += statSync(full).size;
        } catch {
          /* 文件刚好被删了，忽略 */
        }
      }
    }
  }
  return { files, bytes };
}

/**
 * 探测一个数据源。
 * @param {{roots:string[], marker?:string, extensions?:string[], sizeBudget?:number}} spec
 */
export function probeRoots(spec) {
  const roots = unique(spec.roots ?? []);
  const found = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let stat;
    try {
      stat = statSync(root);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const size = spec.measureSize === false ? { files: 0, bytes: 0 } : dirSize(root);
    found.push({ path: root, files: size.files, bytes: size.bytes });
  }
  return found;
}

/** 递归收集文件；带扩展名过滤 + 数量上限保护。 */
export function walkFiles(dirs, { extensions = null, maxFiles = 200000, maxDepth = 12, sinceMs = 0 } = {}) {
  const out = [];
  const seen = new Set();
  const stack = dirs.map((dir) => ({ dir, depth: 0 }));
  while (stack.length) {
    if (out.length >= maxFiles) break;
    const { dir, depth } = stack.pop();
    if (depth > maxDepth) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (extensions && !extensions.some((ext) => entry.name.endsWith(ext))) continue;
      const key = IS_WIN ? full.toLowerCase() : full;
      if (seen.has(key)) continue;
      seen.add(key);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (sinceMs && stat.mtimeMs < sinceMs) continue;
      out.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  return out;
}

/**
 * VSCode 系应用（它们的扩展把数据放在 <appData>/<App>/User/globalStorage）。
 * AI 编程扩展（Cline / Roo / Kilo 等）的 tasks 都在这里。
 */
const VSCODE_FAMILY = [
  'Code', 'Code - Insiders', 'VSCodium', 'Cursor', 'Windsurf', 'Trae', 'Void', 'PearAI', 'Kiro',
];

/**
 * 其他常见 AI 工具的默认数据目录。
 *
 * 这一份清单是为了「能适配就适配」——**装了就用，没装就跳过**（不存在直接忽略，
 * 一次网络请求都不发）。它喂给 generic 扫描器，靠字段别名表自动嗅探用量，
 * 所以哪怕是从未见过的工具，只要日志里有 usage/prompt_tokens 之类的字段就能被读到。
 *
 * 注意：**不能**把已经有专用扫描器的目录（dsh / codex / claude-code / cursor /
 * reasonix / opencode / vscode-ai）放进来，否则同一份数据会被算两遍。
 */
const OTHER_AI_TOOL_DIRS = (() => {
  const list = [
    // Continue
    join(HOME, '.continue'),
    join(HOME, '.continue', 'sessions'),
    // Aider
    join(HOME, '.aider'),
    // Gemini CLI / Qwen Code / iFlow / CodeBuddy
    join(HOME, '.gemini'),
    join(HOME, '.qwen'),
    join(HOME, '.iflow'),
    join(HOME, '.codebuddy'),
    // Trae（字节的 AI IDE）
    join(HOME, '.trae'),
    // Zed / Tabby / Codeium-Windsurf
    join(HOME, '.zed'),
    join(HOME, '.tabby'),
    join(HOME, '.codeium'),
    // Amp / Goose / Crush / OpenCode 的配置目录（数据目录已由 opencode 扫描器负责）
    join(HOME, '.config', 'goose'),
    join(HOME, '.local', 'share', 'amp'),
    join(HOME, '.local', 'share', 'crush'),
  ];
  // 各 VSCode 系应用的扩展存储：Continue / Copilot / 其他 AI 扩展可能把日志放这里
  for (const app of VSCODE_FAMILY) {
    for (const dir of appDataDirs(app)) {
      list.push(join(dir, 'User', 'globalStorage'));
      list.push(join(dir, 'logs'));
    }
  }
  if (process.env.APPDATA) {
    list.push(join(process.env.APPDATA, 'Trae', 'logs'));
  }
  // 说明：**故意不**把 reasonix / dsh / codex 等已有专用扫描器的目录放进来。
  // 它们的会话文件里可能也散落着用量，通用嗅探会重复计数，
  // 而且 provider 会退化成文件名，产生脏数据。
  return list;
})();

/**
 * 数据源清单。每个条目 = 一个扫描器 + 它的候选根目录。
 * `scanner` 对应 server/scanners/<scanner>.mjs，新增数据源只要往这里加一条 + 写一个扫描器。
 */
export function sourceSpecs(config = {}) {
  const overrides = config.sources ?? {};
  const merge = (id, candidateDirs) => {
    const o = overrides[id] ?? {};
    const extra = Array.isArray(o.paths) ? o.paths : [];
    return { paths: unique([...extra, ...candidateDirs]), enabled: o.enabled !== false };
  };

  const specs = [
    {
      id: 'dsh',
      label: 'DeepSeek Harness',
      scanner: 'dsh',
      kind: 'local',
      vendor: 'DeepSeek',
      accent: '#4cc9f0',
      description: 'DSH / Codex 系 agent 的会话日志（追加式 zstd 帧），含逐条 usage 明细。',
      ...merge('dsh', [
        join(HOME, '.dsh', 'sessions'),
        join(HOME, '.config', 'dsh', 'sessions'),
        ...appDataDirs('dsh').map((d) => join(d, 'sessions')),
      ]),
      extensions: ['.zstd'],
      env: { DSH_SESSIONS_DIR: process.env.DSH_SESSIONS_DIR },
    },
    {
      id: 'codex',
      label: 'Codex CLI',
      scanner: 'codex',
      kind: 'local',
      vendor: 'OpenAI',
      accent: '#7ee787',
      description: 'Codex CLI 的 rollout 会话（JSONL），取 last_token_usage 增量。',
      ...merge('codex', [
        join(HOME, '.codex', 'sessions'),
        join(HOME, '.config', 'codex', 'sessions'),
        ...appDataDirs('codex').map((d) => join(d, 'sessions')),
      ]),
      extensions: ['.jsonl'],
      env: { CODEX_HOME: process.env.CODEX_HOME ? join(process.env.CODEX_HOME, 'sessions') : null },
    },
    {
      id: 'claude-code',
      label: 'Claude Code',
      scanner: 'claude-code',
      kind: 'local',
      vendor: 'Anthropic',
      accent: '#d2a8ff',
      description: 'Claude Code 会话 JSONL，按 message.id + requestId 去重，含缓存读写明细。',
      ...merge('claude-code', [
        join(HOME, '.claude', 'projects'),
        join(HOME, '.config', 'claude', 'projects'),
        ...appDataDirs('Claude').map((d) => join(d, 'projects')),
      ]),
      extensions: ['.jsonl'],
      env: { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, 'projects') : null },
    },
    {
      id: 'cursor',
      label: 'Cursor',
      scanner: 'cursor',
      kind: 'local',
      vendor: 'Cursor',
      accent: '#ffb86c',
      description: 'Cursor 的 AI 代码追踪库与聊天库（SQLite），读取逐条 tokenCount。',
      ...merge('cursor', unique([
        join(HOME, '.cursor', 'ai-tracking'),
        ...appDataDirs('Cursor').map((d) => join(d, 'User', 'globalStorage')),
        ...(process.env.XDG_CONFIG_HOME ? [join(process.env.XDG_CONFIG_HOME, 'Cursor', 'User', 'globalStorage')] : []),
      ])),
      extensions: ['.db', '.vscdb'],
      env: null,
    },
    {
      id: 'reasonix',
      label: 'Reasonix',
      scanner: 'reasonix',
      kind: 'local',
      vendor: 'DeepSeek',
      accent: '#f59e0b',
      description: 'Reasonix 桌面端的按天用量统计（一行一次请求，含缓存命中/未命中拆分）。',
      ...merge('reasonix', [
        ...appDataDirs('reasonix').map((d) => join(d, 'stats')),
        join(HOME, '.reasonix', 'stats'),
        join(HOME, '.config', 'reasonix', 'stats'),
      ]),
      extensions: ['.jsonl'],
      env: null,
    },
    {
      id: 'opencode',
      label: 'OpenCode',
      scanner: 'opencode',
      kind: 'local',
      vendor: 'OpenCode',
      accent: '#22d3ee',
      description: '读 OpenCode 的 SQLite，逐条消息带 model / cwd / 缓存读写。',
      ...merge('opencode', [
        join(HOME, '.local', 'share', 'opencode'),
        ...appDataDirs('opencode'),
        join(HOME, 'Library', 'Application Support', 'opencode'),
      ]),
      extensions: ['.db'],
      env: null,
    },
    {
      id: 'vscode-ai',
      label: 'Cline / Roo / Kilo',
      scanner: 'vscode-ai',
      kind: 'local',
      vendor: 'VSCode 扩展',
      accent: '#a3e635',
      description: 'VSCode 系 AI 编程扩展的 tasks 目录（Cline / Roo Code / Kilo Code 及各种分支）。',
      ...merge('vscode-ai', VSCODE_FAMILY.flatMap((app) => appDataDirs(app).map((d) => join(d, 'User', 'globalStorage')))),
      extensions: ['.json'],
      env: null,
    },
    {
      id: 'generic',
      label: '其他 AI 工具（自动嗅探）',
      scanner: 'generic',
      kind: 'local',
      vendor: '自建 / 其他',
      accent: '#ff79c6',
      description: '对一批常见 AI 工具的数据目录做用量字段自动嗅探（装了就用，没装就跳过），也可自己加目录。',
      ...merge('generic', OTHER_AI_TOOL_DIRS),
      extensions: ['.jsonl', '.log', '.ndjson'],
      env: null,
    },
  ];

  return specs;
}

/** 供 /api/sources 与前端「环境信息」面板使用。 */
export function environmentInfo() {
  return {
    platform: platform(),
    arch: process.arch,
    node: process.version,
    home: HOME,
    cwd: process.cwd(),
    tmp: tmpdir(),
    user: basename(HOME),
  };
}
