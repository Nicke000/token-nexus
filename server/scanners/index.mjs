/**
 * scanners/index.mjs —— 扫描器注册表
 *
 * 新增一个数据源只需要两步：
 *   1. 在本目录写一个 <id>.mjs，导出 meta / enumerate / parse；
 *   2. 在下面 SCANNERS 里加一行，并在 paths.mjs 的 sourceSpecs() 里加上候选目录。
 * 前端、缓存、聚合、进度上报全部自动适配。
 */
import * as dsh from './dsh.mjs';
import * as codex from './codex.mjs';
import * as claudeCode from './claude-code.mjs';
import * as cursor from './cursor.mjs';
import * as reasonix from './reasonix.mjs';
import * as opencode from './opencode.mjs';
import * as vscodeAi from './vscode-ai.mjs';
import * as generic from './generic.mjs';

export const SCANNERS = {
  dsh,
  codex,
  'claude-code': claudeCode,
  cursor,
  reasonix,
  opencode,
  'vscode-ai': vscodeAi,
  generic,
};

export function getScanner(id) {
  return SCANNERS[id] ?? null;
}

export function listScanners() {
  return Object.entries(SCANNERS).map(([id, mod]) => ({
    id,
    label: mod.meta?.label ?? id,
    granularity: mod.meta?.granularity ?? 'unknown',
    fields: mod.meta?.fields ?? [],
    note: mod.meta?.note ?? '',
  }));
}

/** 串行枚举全部数据源的待解析文件（目录遍历很快，不需要并行）。 */
export async function enumerateAll(specs, config) {
  const out = [];
  const errors = [];
  for (const spec of specs) {
    if (spec.enabled === false) continue;
    const scanner = getScanner(spec.scanner);
    if (!scanner) {
      errors.push({ source: spec.id, error: `没有名为 ${spec.scanner} 的扫描器` });
      continue;
    }
    try {
      const items = await scanner.enumerate(spec, config);
      for (const item of items) {
        item.sourceId = spec.id;
        item.accent = spec.accent;
        out.push(item);
      }
    } catch (error) {
      errors.push({ source: spec.id, error: error.message });
    }
  }
  return { items: out, errors };
}

export async function parseItem(item) {
  const scanner = getScanner(item.source);
  if (!scanner) throw new Error(`未知扫描器：${item.source}`);
  return scanner.parse(item);
}
