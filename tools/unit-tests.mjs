#!/usr/bin/env node
/**
 * tools/unit-tests.mjs —— 纯单元测试（零依赖，node:test 都不用）
 *
 * 重点覆盖两处「一旦写错就会静默算错数」的地方：
 *   1. 追加式 zstd 多帧解码（含压缩数据内部出现假 magic 的情况）
 *   2. 各家 usage 字段的语义归一（input 含不含 cacheRead）
 */
import { zstdCompressSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { writeFileSync, appendFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
  normalizeUsage, inferCacheSemantics, localDay, toMillis, projectNameFromPath,
  estimateTokensFromText, dayOffset, daysBetween, addUsage, makeKey, parseKey, bucketTotal,
  mergeBuckets, bumpHours, emptyHours,
} from '../server/usage.mjs';
import { normalizeModelId, buildPriceTable, priceFor, costOf } from '../server/pricing.mjs';
import { findFrameStarts, decodeZstdFrames, iterateZstdLines, iterateFileLines } from '../server/scanners/_shared.mjs';
import { findUsage } from '../server/scanners/generic.mjs';
import { parse as parseDsh } from '../server/scanners/dsh.mjs';
import { parse as parseReasonix } from '../server/scanners/reasonix.mjs';
import { parse as parseOpencode } from '../server/scanners/opencode.mjs';
import { parse as parseVscodeAi } from '../server/scanners/vscode-ai.mjs';
import { migrateConfig } from '../server/config.mjs';

let passed = 0;
const failures = [];

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    passed += 1;
  } else {
    failures.push(`${name}\n      实际 ${a}\n      期望 ${b}`);
  }
}

function ok(name, condition, detail = '') {
  if (condition) passed += 1;
  else failures.push(`${name}${detail ? ` (${detail})` : ''}`);
}

/* ─────────────── 1. 追加式 zstd 多帧解码 ─────────────── */

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const frames = [
  Buffer.from('{"type":"session","cwd":"E:\\\\proj"}\n'),
  Buffer.from(`${Array.from({ length: 40 }, (_, i) => `{"type":"event","seq":${i}}`).join('\n')}\n`),
  // 故意让「不可压缩数据里出现 zstd magic」——制造假帧边界，验证回溯合并
  Buffer.concat([randomBytes(48), MAGIC, randomBytes(48), Buffer.from('\n')]),
  Buffer.from('{"type":"assistant/message","data":{"usage":{"inputTokens":10}}}\n'),
];
const concatenated = Buffer.concat(frames.map((payload) => zstdCompressSync(payload)));

eq('findFrameStarts 至少找到 4 个候选（含假边界）', findFrameStarts(concatenated).length >= 4, true);
const rejoined = Buffer.concat([...decodeZstdFrames(concatenated)]).toString('utf8');
eq('多帧拼接解码结果与原文完全一致（含假 magic 边界）',
  rejoined === Buffer.concat(frames).toString('utf8'), true);

const lines = [...iterateZstdLines(concatenated)].filter((line) => line.trim() !== '');
// 二进制载荷里可能随机出现 0x0A，因此按「能解析成 JSON 的行」来计数才稳定
const jsonLines = lines.filter((line) => {
  try { JSON.parse(line); return true; } catch { return false; }
});
eq('按行遍历跨帧拼接正确（JSON 行数）', jsonLines.length, 42);
eq('第一行是会话头', jsonLines[0].startsWith('{"type":"session"'), true);
eq('最后一行是 usage 事件', jsonLines[jsonLines.length - 1].includes('assistant/message'), true);
eq('40 条事件一条不少', jsonLines.filter((line) => line.includes('"type":"event"')).length, 40);
// 注：那一帧是刻意塞进去的随机二进制（不是合法 UTF-8），出现 U+FFFD 是正确行为；
// 「合法 UTF-8 不被破坏」由上面的跨帧 / 跨分片用例保证。

// 半行跨帧：一个 JSON 被切成两帧
const splitFrames = Buffer.concat([
  zstdCompressSync(Buffer.from('{"type":"event","seq":')),
  zstdCompressSync(Buffer.from('7}\n')),
]);
eq('跨帧半行能正确拼回', [...iterateZstdLines(splitFrames)], ['{"type":"event","seq":7}']);

// 损坏文件不能抛异常
let threw = false;
try {
  [...decodeZstdFrames(Buffer.from('not a zstd stream at all'))];
} catch { threw = true; }
eq('非 zstd 数据不抛异常', threw, false);

/* ─────────────── 1b. 多字节字符被切在边界上 ─────────────── */

// UTF-8 字符跨 zstd 帧
const splitChar = Buffer.concat([
  zstdCompressSync(Buffer.from('{"text":"临时')),
  zstdCompressSync(Buffer.from('目录"}\n')),
]);
eq('多字节字符跨帧不被替换成 U+FFFD',
  [...iterateZstdLines(splitChar)], ['{"text":"临时目录"}']);

// UTF-8 字符跨 4 MiB 读分片（这是真实存在过的静默数据损坏）
const CHUNK = 4 << 20;
const boundaryFile = join(tmpdir(), `nexus-utf8-${Date.now()}.jsonl`);
const prefix = Buffer.from('a'.repeat(CHUNK - 1));
const payload = Buffer.concat([prefix, Buffer.from('中文测试', 'utf8'), Buffer.from('\n'), Buffer.from('{"tail":1}\n')]);
writeFileSync(boundaryFile, payload);
try {
  const lines = [...iterateFileLines(boundaryFile)];
  eq('跨 4MiB 分片的多字节字符完好', lines[0]?.includes('中文测试'), true);
  eq('跨分片的行没有替换字符', lines[0]?.includes('\uFFFD'), false);
  eq('分片边界后的行也完整', lines[1], '{"tail":1}');
} finally {
  rmSync(boundaryFile, { force: true });
}

/* ─────────────── 2. usage 语义归一 ─────────────── */

eq('DSH：input 不含 cacheRead', (() => {
  const u = normalizeUsage({ inputTokens: 923, cacheReadTokens: 10752, outputTokens: 83, totalTokens: 11758 });
  return [u.input, u.cacheRead, u.output, u.total];
})(), [923, 10752, 83, 11758]);

eq('OpenAI：prompt_tokens 含 cached，需剥离', (() => {
  const u = normalizeUsage({ prompt_tokens: 1500, cached_tokens: 1200, completion_tokens: 40, total_tokens: 1540 });
  return [u.input, u.cacheRead, u.output];
})(), [300, 1200, 40]);

eq('Anthropic：input 不含缓存，cache_write 单列', (() => {
  const u = normalizeUsage({
    input_tokens: 100, cache_read_input_tokens: 5000,
    cache_creation_input_tokens: 2000, output_tokens: 50,
  });
  return [u.input, u.cacheRead, u.cacheWrite, u.output];
})(), [100, 5000, 2000, 50]);

eq('Codex：input_tokens 含 cached_input_tokens', (() => {
  const u = normalizeUsage({ input_tokens: 800, cached_input_tokens: 600, output_tokens: 20 });
  return [u.input, u.cacheRead, u.output];
})(), [200, 600, 20]);

eq('Gemini：promptTokenCount 含 cachedContentTokenCount', (() => {
  const u = normalizeUsage({ promptTokenCount: 1000, cachedContentTokenCount: 900, candidatesTokenCount: 30 });
  return [u.input, u.cacheRead, u.output];
})(), [100, 900, 30]);

eq('全零 usage 返回 null', normalizeUsage({ inputTokens: 0, outputTokens: 0 }), null);
eq('非对象返回 null', normalizeUsage(null), null);
eq('只给 totalTokens 的日志不能被丢弃', (() => {
  const u = normalizeUsage({ total_tokens: 500 });
  return u ? [u.input, u.output, u.total] : null;
})(), [500, 0, 500]);
eq('只给 totalTokens 且带缓存时反推输入', (() => {
  const u = normalizeUsage({ total_tokens: 1000, cached_tokens: 400 });
  return u ? [u.input, u.cacheRead, u.total] : null;
})(), [600, 400, 1000]);
eq('语义推断', [
  inferCacheSemantics({ prompt_tokens: 1 }),
  inferCacheSemantics({ promptTokenCount: 1 }),
  inferCacheSemantics({ cached_input_tokens: 1 }),
  inferCacheSemantics({ inputTokens: 1 }),
], ['inclusive', 'inclusive', 'inclusive', 'exclusive']);

/* ─────────────── 3. 时间与路径 ─────────────── */

eq('toMillis 秒级', toMillis(1790594570), 1790594570000);
eq('toMillis 毫秒级不变', toMillis(1790594570197), 1790594570197);
eq('toMillis ISO', toMillis('2026-09-30T00:00:00Z'), Date.parse('2026-09-30T00:00:00Z'));
eq('toMillis 非法值走兜底', toMillis('乱七八糟', 42), 42);
eq('projectNameFromPath 保留两级', projectNameFromPath('E:\\moreai'), 'E:/moreai');
eq('projectNameFromPath 深层取尾两级', projectNameFromPath('/Users/x/proj/sub'), 'proj/sub');
eq('projectNameFromPath 去掉尾分隔符', projectNameFromPath('E:\\moreai\\'), 'E:/moreai');
eq('dayOffset 跨月', dayOffset('2026-09-01', -1), '2026-08-31');
eq('dayOffset 跨年', dayOffset('2026-01-01', -1), '2025-12-31');
eq('daysBetween', daysBetween('2026-08-01', '2026-09-01'), 31);
ok('localDay 与本地时区一致', /^\d{4}-\d{2}-\d{2}$/.test(localDay(Date.now())));
eq('estimateTokensFromText 英文', estimateTokensFromText('a'.repeat(400)), 100);
eq('estimateTokensFromText 中文', estimateTokensFromText('中'.repeat(16)), 10);

/* ─────────────── 4. bucket 累加 ─────────────── */

const buckets = {};
const key = makeKey('2026-09-30', 'dsh', 'p', 'm', 'proj');
addUsage(buckets, key, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5 });
addUsage(buckets, key, { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 50 });
eq('bucket 累加（requests 计次）', buckets[key], [11, 22, 33, 44, 55, 2]);
eq('总量口径 = input+output+cacheRead+cacheWrite', bucketTotal(buckets[key]), 110);
const merged = mergeBuckets({}, buckets);
eq('mergeBuckets 深拷贝而非引用', merged[key] === buckets[key], false);
eq('mergeBuckets 数值正确', merged[key], [11, 22, 33, 44, 55, 2]);

// key 里混进控制字符会把字段对齐冲掉
const dirtyKey = makeKey('2026-09-30', 'dsh', 'p', 'evil\u0001model', 'proj');
eq('key 里的控制字符被清理（字段仍是 5 段）', parseKey(dirtyKey)?.model, 'evil model');
eq('字段缺失时补 unknown', parseKey(makeKey('2026-09-30', 'dsh', '', '', ''))?.model, 'unknown');
eq('段数不对的 key 返回 null', parseKey('a\u0001b'), null);

// 按天分桶的小时直方图（区间过滤要靠它）
const acc = { hours: emptyHours(), hoursByDay: {} };
const ts1 = new Date(2026, 8, 29, 10, 0, 0).getTime();
const ts2 = new Date(2026, 8, 29, 10, 30, 0).getTime();
bumpHours(acc, ts1, 100);
bumpHours(acc, ts2, 50);
eq('小时直方图累加', acc.hours[10], 150);
eq('按天分桶的小时直方图', Object.values(acc.hoursByDay)[0][10], 150);
eq('按天分桶用本地日期键', Object.keys(acc.hoursByDay), ['2026-09-29']);

/* ─────────────── 4b. generic 嗅探的取值作用域 ─────────────── */

eq('metrics 不能压过真正的 usage 块', (() => {
  const u = findUsage({ metrics: { inputTokens: 5, pending: 1 }, usage: { inputTokens: 1000, outputTokens: 200 } });
  return [u.input, u.output];
})(), [1000, 200]);

eq('摊平的对象自己就是用量块', (() => {
  const u = findUsage({ input_tokens: 7, output_tokens: 3 });
  return [u.input, u.output];
})(), [7, 3]);

eq('嵌套在 data 下的用量也能找到', (() => {
  const u = findUsage({ data: { result: { usage: { prompt_tokens: 20, completion_tokens: 4 } } } });
  return [u.input, u.output];
})(), [20, 4]);

eq('无用量字段的对象返回 null', findUsage({ message: 'hello', count: 3 }), null);

/* ─────────────── 5. 价格匹配 ─────────────── */

const table = buildPriceTable({ config: {} });
eq('DeepSeek V4.1 Flash 归一化', normalizeModelId('deepseek/deepseek-v4-flash'), 'deepseek-v4-flash');
ok('DeepSeek 家族可定价', Boolean(priceFor('deepseek-v4-flash', 'yunshu', table)));
ok('带 provider 前缀的模型可定价', Boolean(priceFor('deepseek/deepseek-v4-flash', 'openrouter', table)));
ok('带 ":free" 后缀可定价', Boolean(priceFor('deepseek-v4-flash:free', 'x', table)));
ok('未收录模型返回未定价而不是 0', priceFor('totally-unknown-model-9000', 'x', table) === null);

eq('费用公式（含缓存读单价）', (() => {
  const price = { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: null };
  const cost = costOf({ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 }, price);
  return Number(cost.usd.toFixed(4));
})(), Number((0.3 + 1.2 + 0.006).toFixed(4)));

eq('缓存读单价缺失时退回 input 单价（不是按 0）', (() => {
  const cost = costOf({ input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 }, { input: 2, output: 0, cacheRead: null });
  return [Number(cost.usd.toFixed(6)), cost.cacheEstimated];
})(), [2, true]);

eq('null 价的「路由占位」视为未定价', costOf({ input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }, { input: null, output: null }).priced, false);

eq('用户覆盖优先级最高', (() => {
  const custom = buildPriceTable({
    config: { pricing: { overrides: { 'deepseek-v4-flash': { input: 9, output: 9, cacheRead: 9, label: '我的价' } } } },
  });
  return priceFor('deepseek-v4-flash', 'x', custom).layer;
})(), 'override');

/* ─────────────── 6. DSH 增量续读（只读新增尾巴）的等价性 ─────────────── */

const dshRoot = join(tmpdir(), `nexus-dsh-${Date.now()}`);
const dshDir = join(dshRoot, '--E-tmp-proj--', 'session-test');
mkdirSync(dshDir, { recursive: true });
const dshFile = join(dshDir, 'session.v3.jsonl.zstd');

const sessionHeader = JSON.stringify({
  type: 'session', version: 0, id: 'session-test', createdAt: 1790000000000, cwd: 'E:\\tmp\\proj',
});
const usageLine = (seq) => JSON.stringify({
  type: 'assistant/message',
  seq,
  time: 1790000000000 + seq * 1000,
  data: {
    usage: { inputTokens: 10 + seq, outputTokens: seq, cacheReadTokens: 100, totalTokens: 110 + 2 * seq },
    message: { source: { provider: 'provider-x', model: 'model-y' } },
  },
});
const framesFor = (lines) => Buffer.concat(lines.map((line) => zstdCompressSync(Buffer.from(`${line}\n`))));

try {
  writeFileSync(dshFile, Buffer.concat([
    zstdCompressSync(Buffer.from(`${sessionHeader}\n`)),
    framesFor([1, 2, 3].map(usageLine)),
  ]));
  const first = parseDsh({ path: dshFile, workspace: '--E-tmp-proj--' });

  // 追加 3 条，然后用「续读」解析
  appendFileSync(dshFile, framesFor([4, 5, 6].map(usageLine)));
  const resumed = parseDsh({
    path: dshFile,
    workspace: '--E-tmp-proj--',
    resume: { parsedBytes: first.parsedBytes, state: first.resumeState, base: first },
  });
  const full = parseDsh({ path: dshFile, workspace: '--E-tmp-proj--' });

  eq('续读：bucket 与全量解析完全一致', resumed.buckets, full.buckets);
  eq('续读：小时直方图一致', resumed.hours, full.hours);
  eq('续读：按天小时直方图一致', resumed.hoursByDay, full.hoursByDay);
  eq('续读：事件计数一致', resumed.events, full.events);
  eq('续读：时间范围一致', [resumed.firstTs, resumed.lastTs], [full.firstTs, full.lastTs]);
  eq('续读：项目名沿用上一轮（没有重新读文件头）', Object.keys(resumed.buckets)[0].split('\u0001')[4], 'tmp/proj');
  ok('续读确实只读了新增字节', resumed.parsedBytes === full.parsedBytes && first.parsedBytes < resumed.parsedBytes);

  // 文件被截断重写 → 偏移失配，必须自动退回全量解析，绝不能沿用旧数据
  writeFileSync(dshFile, Buffer.concat([
    zstdCompressSync(Buffer.from(`${sessionHeader}\n`)),
    framesFor([1, 2].map(usageLine)),
  ]));
  const afterRewrite = parseDsh({
    path: dshFile,
    workspace: '--E-tmp-proj--',
    resume: { parsedBytes: full.parsedBytes, state: full.resumeState, base: full },
  });
  const expected = parseDsh({ path: dshFile, workspace: '--E-tmp-proj--' });
  eq('偏移失效时自动退回全量解析', afterRewrite.events, expected.events);
  eq('退回全量后数据正确（没有沿用旧的 6 条）', afterRewrite.events, 2);

  // 多字节字符被切在帧边界：会话头里的中文路径也必须拼回来
  const cjkFile = join(dshDir, 'session-cjk.v3.jsonl.zstd');
  const cjkBytes = Buffer.from(`${JSON.stringify({
    type: 'session', version: 0, id: 'cjk', cwd: 'E:\\中文目录\\项目', createdAt: 1790000000000,
  })}\n`, 'utf8');
  // 精确切在「中」的三个字节中间（+1），确保跨帧的是不完整的多字节字符
  const cut = cjkBytes.indexOf(Buffer.from('中', 'utf8')) + 1;
  writeFileSync(cjkFile, Buffer.concat([
    zstdCompressSync(cjkBytes.subarray(0, cut)),
    zstdCompressSync(cjkBytes.subarray(cut)),
  ]));
  const cjk = parseDsh({ path: cjkFile, workspace: '--E-cjk--' });
  ok('会话头里的中文项目名跨帧后完好', cjk.resumeState.project === '中文目录/项目', `实际 ${cjk.resumeState.project}`);
} finally {
  rmSync(dshRoot, { recursive: true, force: true });
}

/* ─────────────── 7. 配置迁移（旧默认值不能把新默认值锁死） ─────────────── */

// saveConfig 会把合并后的完整配置落盘，于是默认值全被固化。迁移必须能区分
// 「用户从没动过的旧默认值」和「用户显式改过的值」。
eq('旧默认值跟随新默认值', (() => {
  const out = migrateConfig({ refreshMs: 5000, cacheTtlMs: 60000 });
  return [out.refreshMs, out.cacheTtlMs, out.schemaVersion];
})(), [1000, 1000, 2]);

eq('中间版本的默认值也一并迁移', (() => {
  const out = migrateConfig({ refreshMs: 5000, cacheTtlMs: 5000 });
  return [out.refreshMs, out.cacheTtlMs];
})(), [1000, 1000]);

eq('用户显式改过的值不被覆盖', (() => {
  const out = migrateConfig({ refreshMs: 2500, cacheTtlMs: 30000, fxRate: 9.99 });
  return [out.refreshMs, out.cacheTtlMs, out.fxRate];
})(), [2500, 30000, 9.99]);

eq('已是当前版本则原样返回（不再重复迁移）', (() => {
  const out = migrateConfig({ schemaVersion: 2, refreshMs: 5000 });
  return [out.refreshMs, out.schemaVersion];
})(), [5000, 2]);

eq('空配置安全', migrateConfig(null), {});

/* ─────────────── 8. 新增数据源：Reasonix / OpenCode / Cline 族 ─────────────── */

const newRoot = join(tmpdir(), `nexus-sources-${Date.now()}`);
try {
  // ── Reasonix：一行一次请求，cache_miss/cache_hit 直接对应我们的口径 ──
  const statsDir = join(newRoot, 'reasonix', 'stats');
  mkdirSync(statsDir, { recursive: true });
  const statsFile = join(statsDir, '2026-08-07.jsonl');
  writeFileSync(statsFile, [
    JSON.stringify({
      ts: '2026-08-07T21:21:42.824+08:00', model: 'deepseek/deepseek-v4-flash', source: 'desktop',
      prompt: 328412, completion: 833, reasoning: 489, cache_hit: 512, cache_miss: 327900,
      total: 329245, requests: 1,
    }),
    JSON.stringify({
      ts: '2026-08-07T22:00:00.000+08:00', model: 'uu/gpt-5.6-luna', source: 'desktop',
      prompt: 100, completion: 20, reasoning: 0, cache_hit: 40, cache_miss: 60, total: 120, requests: 1,
    }),
  ].join('\n'));
  const rx = parseReasonix({ path: statsFile, label: '2026-08-07' });
  const rxBuckets = Object.entries(rx.buckets).sort((a, b) => b[1][0] - a[1][0]);
  eq('Reasonix：新鲜输入取 cache_miss，缓存读取 cache_hit', [rxBuckets[0][1][0], rxBuckets[0][1][2], rxBuckets[0][1][1]], [327900, 512, 833]);
  eq('Reasonix：模型拆成 供应商/模型', rxBuckets[0][0].split('\u0001').slice(2, 4), ['deepseek', 'deepseek-v4-flash']);
  eq('Reasonix：两条请求都记上', rx.events, 2);
  eq('Reasonix：总量 = 新鲜 + 缓存 + 输出', rxBuckets.reduce((sum, [, b]) => sum + b[0] + b[1] + b[2], 0), 327900 + 512 + 833 + 60 + 40 + 20);

  // ── OpenCode：SQLite，reasoning 单独计入 total，折算时补进 output ──
  const sqliteMod = await import('node:sqlite').catch(() => null);
  if (sqliteMod) {
    const dbPath = join(newRoot, 'opencode', 'opencode.db');
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new sqliteMod.DatabaseSync(dbPath);
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, model TEXT, time_created INTEGER, time_updated INTEGER)');
    db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)');
    db.prepare('INSERT INTO session VALUES (?,?,?,?,?)').run('ses_1', 'E:\\AIhuabu', null, 1000, 2000);
    db.prepare('INSERT INTO message VALUES (?,?,?)').run('msg_1', 'ses_1', JSON.stringify({
      role: 'assistant', modelID: 'deepseek-v4-flash-free', providerID: 'opencode',
      path: { cwd: 'E:\\AIhuabu' }, time: { created: 1787077554996 },
      tokens: { total: 10339, input: 10271, output: 48, reasoning: 20, cache: { write: 0, read: 5000 } },
    }));
    db.prepare('INSERT INTO message VALUES (?,?,?)').run('msg_2', 'ses_1', JSON.stringify({
      role: 'user', time: { created: 1787077554996 }, tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    }));
    db.close();

    const oc = await parseOpencode({ path: dbPath });
    const ocBucket = Object.values(oc.buckets)[0];
    eq('OpenCode：input/cacheRead 分别读取，reasoning 补进 output',
      [ocBucket[0], ocBucket[2], ocBucket[1], ocBucket[4]], [10271, 5000, 68, 20]);
    eq('OpenCode：项目名来自 cwd', Object.keys(oc.buckets)[0].split('\u0001')[4], 'E:/AIhuabu');
    eq('OpenCode：零 token 的消息被忽略', oc.events, 1);
  } else {
    ok('OpenCode：node:sqlite 不可用，跳过', true, 'Node 版本过低');
  }

  // ── Cline 族：model_usage 有 token 时优先用它（避免与 ui_messages 重复）──
  const makeTask = (name, metadata, uiMessages) => {
    const dir = join(newRoot, 'vscode', 'tasks', name);
    mkdirSync(dir, { recursive: true });
    if (metadata) writeFileSync(join(dir, 'task_metadata.json'), JSON.stringify(metadata));
    if (uiMessages) writeFileSync(join(dir, 'ui_messages.json'), JSON.stringify(uiMessages));
    return dir;
  };

  const taskA = makeTask('1750000000000', {
    model_usage: [
      { ts: 1750000000000, model_id: 'deepseek-v4-pro', model_provider_id: 'openai', tokensIn: 1000, tokensOut: 100, cacheReads: 400, cacheWrites: 50 },
    ],
  }, [
    { ts: 1750000000000, say: 'api_req_started', text: JSON.stringify({ tokensIn: 999999, tokensOut: 999999, cacheReads: 0, cacheWrites: 0 }) },
  ]);
  const clineA = parseVscodeAi({ path: taskA, extension: 'shengsuan-cloud.cline-shengsuan', metadataPath: join(taskA, 'task_metadata.json'), uiMessagesPath: join(taskA, 'ui_messages.json') });
  const clineABucket = Object.values(clineA.buckets)[0];
  eq('Cline：model_usage 有 token 时优先用它',
    [clineABucket[0], clineABucket[1], clineABucket[2], clineABucket[3]], [600, 100, 400, 50]);
  eq('Cline：不会把 ui_messages 的同一批请求再加一遍', clineA.events, 1);

  // ── Cline 族：model_usage 只有模型名（无 token）+ ui_messages 有 token → 归因到唯一模型 ──
  const taskB = makeTask('1750000001000', {
    model_usage: [{ ts: 1750000001000, model_id: 'glm-5.1', model_provider_id: 'zhipu', mode: 'act' }],
  }, [
    { ts: 1750000001000, say: 'api_req_started', text: JSON.stringify({ tokensIn: 500, tokensOut: 60, cacheReads: 100, cacheWrites: 200 }) },
  ]);
  const clineB = parseVscodeAi({ path: taskB, extension: 'x-cline', metadataPath: join(taskB, 'task_metadata.json'), uiMessagesPath: join(taskB, 'ui_messages.json') });
  eq('Cline：单模型任务能把 token 归因（不再一律 unknown）',
    Object.keys(clineB.buckets)[0].split('\u0001').slice(2, 4), ['zhipu', 'glm-5.1']);
  eq('Cline：cacheWrites 也计入总量',
    Object.values(clineB.buckets)[0].slice(0, 4), [400, 60, 100, 200]);

  // ── Cline 族：多模型任务无法判断归属 → 保持 unknown，不猜 ──
  const taskC = makeTask('1750000002000', {
    model_usage: [
      { ts: 1750000002000, model_id: 'model-a', model_provider_id: 'p1' },
      { ts: 1750000002000, model_id: 'model-b', model_provider_id: 'p2' },
    ],
  }, [
    { ts: 1750000002000, say: 'api_req_finished', text: JSON.stringify({ tokensIn: 10, tokensOut: 5 }) },
  ]);
  const clineC = parseVscodeAi({ path: taskC, extension: 'x-roo', metadataPath: join(taskC, 'task_metadata.json'), uiMessagesPath: join(taskC, 'ui_messages.json') });
  eq('Cline：多模型任务保持 unknown（不猜归属）',
    Object.keys(clineC.buckets)[0].split('\u0001')[3], 'unknown');

  // ── Cline 族：两边都没有 token → 不产生 bucket，只如实记录检测结果 ──
  const taskD = makeTask('1750000003000', { model_usage: [{ ts: 1750000003000, model_id: 'x', model_provider_id: 'y' }] }, []);
  const clineD = parseVscodeAi({ path: taskD, extension: 'x-kilo', metadataPath: join(taskD, 'task_metadata.json'), uiMessagesPath: null });
  eq('Cline：没有 token 记录时不编数字', Object.keys(clineD.buckets).length, 0);
  eq('Cline：但仍记录检测到的任务数与模型', [clineD.extra.tasks, clineD.extra.models.length], [1, 1]);
} finally {
  rmSync(newRoot, { recursive: true, force: true });
}

/* ─────────────── 结果 ─────────────── */

console.log('');
if (failures.length === 0) {
  console.log(`  ✓ ${passed} 项断言全部通过\n`);
  process.exit(0);
}
for (const failure of failures) console.log(`  ✗ ${failure}`);
console.log(`\n  通过 ${passed} · 失败 ${failures.length}\n`);
process.exit(1);
