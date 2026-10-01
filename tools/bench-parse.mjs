#!/usr/bin/env node
/**
 * tools/bench-parse.mjs —— 增量续读的对照基准
 *
 * 全量解析 vs 增量续读，跑真实的会话日志（复制到临时目录，绝不碰原始文件）。
 * 这是「刷新频率能提到 1 秒」这件事的证据：17MB 的活跃会话全量重解要 2 秒出头，
 * 而日志通常只追加几百字节 —— 续读只要 1 毫秒。
 *
 * 用法：
 *   node tools/bench-parse.mjs                      # 自动挑最大的 session.v3.jsonl.zstd
 *   node tools/bench-parse.mjs <某个日志文件路径>
 */
import {
  copyFileSync, appendFileSync, statSync, mkdtempSync, rmSync, readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { zstdCompressSync } from 'node:zlib';
import { parse as parseDsh } from '../server/scanners/dsh.mjs';

/** 自动找最大的 v3 会话日志 */
function findLargestSession() {
  const root = join(homedir(), '.dsh', 'sessions');
  let best = null;
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name === 'session.v3.jsonl.zstd') {
        const size = statSync(full).size;
        if (!best || size > best.size) best = { path: full, size };
      }
    }
  };
  walk(root, 0);
  return best?.path ?? null;
}

const source = process.argv[2] || findLargestSession();
if (!source) {
  console.error('找不到会话日志；请显式传入路径：node tools/bench-parse.mjs <文件>');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'nexus-bench-'));
const target = join(dir, 'session.v3.jsonl.zstd');
copyFileSync(source, target);
const sizeMB = (statSync(target).size / 1048576).toFixed(1);

const time = (label, fn) => {
  const started = performance.now();
  const out = fn();
  const ms = performance.now() - started;
  console.log(`  ${label.padEnd(26)} ${ms.toFixed(1).padStart(8)} ms`);
  return { out, ms };
};

console.log('');
console.log(`  源文件：${source}`);
console.log(`  大小：${sizeMB} MB（副本，原文件不动）`);
console.log('');

const full = time('全量解析（旧做法）', () => parseDsh({ path: target, workspace: '--bench--' }));

// 追加 3 条真实形态的新事件，模拟「日志又写了几行」
const extra = [1, 2, 3].map((i) => JSON.stringify({
  type: 'assistant/message',
  seq: 900000 + i,
  time: Date.now() + i * 1000,
  data: {
    usage: { inputTokens: 1200, outputTokens: 40, cacheReadTokens: 9000, totalTokens: 10240 },
    message: { source: { provider: 'bench', model: 'bench-model' } },
  },
}));
appendFileSync(target, Buffer.concat(extra.map((line) => zstdCompressSync(Buffer.from(`${line}\n`)))));

const appended = statSync(target).size - full.out.parsedBytes;
const resumed = time('增量续读（新做法）', () => parseDsh({
  path: target,
  workspace: '--bench--',
  resume: { parsedBytes: full.out.parsedBytes, state: full.out.resumeState, base: full.out },
}));

const reference = parseDsh({ path: target, workspace: '--bench--' });
const same = JSON.stringify(reference.buckets) === JSON.stringify(resumed.out.buckets);

console.log(`\n  本次只新增了 ${appended} 字节，却要重解 ${sizeMB} MB`);
console.log(`  加速比：${(full.ms / resumed.ms).toFixed(0)}×   结果一致性：${same ? '一致 ✓' : '不一致 ✗'}`);
console.log(`  事件数：全量 ${reference.events} / 续读 ${resumed.out.events}\n`);

rmSync(dir, { recursive: true, force: true });
process.exit(same ? 0 : 1);
