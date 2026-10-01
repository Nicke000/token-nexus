/**
 * scan.mjs —— 扫描编排：增量缓存 + worker 并行 + 实时进度
 *
 * 三个设计取舍值得说明：
 *
 * 1) **按文件缓存解析结果**，不是按文件缓存原始内容。
 *    解析产物是「bucket 表」——已经压成 (日期×来源×供应商×模型×项目) 的 token 计数，
 *    所以 1 GB 日志的缓存只有几 MB，第二次启动是秒开。
 *
 * 2) **缓存里存 token，不存钱**。
 *    价格表改了、汇率改了、模型别名改了，只要重算 aggregate 就行，永远不用重扫。
 *
 * 3) **worker 只做纯函数解析**。
 *    worker 不碰缓存、不写盘、不发事件；进度和落盘全在主线程，避免并发写坏缓存。
 */
import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CACHE_FILE, loadConfig, saveConfig } from './config.mjs';
import { sourceSpecs, environmentInfo } from './paths.mjs';
import { enumerateAll } from './scanners/index.mjs';
import { mergeBuckets, mergeHourHistogram, emptyHours } from './usage.mjs';

const CACHE_VERSION = 4;
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_URL = new URL('./worker.mjs', import.meta.url);

/**
 * 解析器版本 = 所有「会影响解析结果」的源码内容的哈希。
 *
 * 为什么不用手写的版本号：手写常量只在人记得改的时候才生效。
 * 改了某个扫描器的字段映射却忘了 bump，缓存会因为 mtime 没变而被永久复用 ——
 * 那是一种**永远不会自愈的错误数字**。用源码哈希就不可能忘。
 */
function computeCacheRevision() {
  const files = [
    'usage.mjs',
    'scanners/_shared.mjs',
    'scanners/index.mjs',
    'scanners/dsh.mjs',
    'scanners/codex.mjs',
    'scanners/claude-code.mjs',
    'scanners/cursor.mjs',
    'scanners/reasonix.mjs',
    'scanners/opencode.mjs',
    'scanners/vscode-ai.mjs',
    'scanners/generic.mjs',
  ];
  const hash = createHash('sha256');
  hash.update(`cache-v${CACHE_VERSION}`);
  for (const file of files) {
    try {
      hash.update(`\u0000${basename(file)}\u0000`);
      hash.update(readFileSync(join(HERE, file)));
    } catch {
      hash.update(`\u0000missing:${file}`);
    }
  }
  return hash.digest('hex').slice(0, 16);
}

const CACHE_REVISION = computeCacheRevision();

/** 内存态：按文件保存解析结果 + 最近一次扫描报告。 */
const state = {
  files: new Map(),
  report: null,
  errors: [],
  cacheLoaded: false,
  cacheDirty: false,
  cachePath: CACHE_FILE,
};

let scanning = null;
const subscribers = new Set();
let emitTimer = null;
let pendingEvents = [];

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/**
 * 推送进度事件。
 *
 * ⚠️ 参数既可以是单个事件，也可以是事件数组 —— 必须在这里拍平。
 * 早期版本直接 `pendingEvents.push(event)`，而调用方传的是数组，
 * 结果每个订阅者收到的是「数组套数组」，SSE 每帧发出去的是一个 JSON 数组，
 * 前端 `JSON.parse(...).type` 永远是 undefined，**整条扫描进度链路静默失效**。
 */
function emit(event) {
  if (Array.isArray(event)) pendingEvents.push(...event);
  else if (event) pendingEvents.push(event);
  if (pendingEvents.length === 0) return;
  if (emitTimer) return;
  emitTimer = setTimeout(() => {
    emitTimer = null;
    const batch = pendingEvents;
    pendingEvents = [];
    for (const fn of subscribers) {
      try {
        fn(batch);
      } catch {
        /* 单个订阅者出错不该拖垮扫描 */
      }
    }
  }, 60);
  // 注意：这里**不能** unref。CLI 模式（--scan-only）下没有任何其他活跃句柄，
  // unref 会让事件循环判定为空并提前退出，表现为 "unsettled top-level await"。
}

/* ────────────────────────── 缓存读写 ────────────────────────── */

/** 缓存里的一条 bucket 必须是 6 个有限数字的数组；否则丢弃该文件缓存。 */
function validBucket(bucket) {
  if (!Array.isArray(bucket) || bucket.length !== 6) return false;
  for (const value of bucket) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  }
  return true;
}

function validResult(result) {
  if (!result || typeof result !== 'object') return false;
  if (!result.buckets || typeof result.buckets !== 'object') return false;
  for (const [key, bucket] of Object.entries(result.buckets)) {
    if (!validBucket(bucket)) return false;
    if (key.split('\u0001').length !== 5) return false;
  }
  if (result.hours !== undefined && (!Array.isArray(result.hours) || result.hours.length !== 24)) return false;
  // 增量续读信息：要么完全没有，要么成对且类型正确
  const hasResume = result.parsedBytes !== undefined || result.resumeState !== undefined;
  if (hasResume) {
    if (!Number.isFinite(result.parsedBytes) || result.parsedBytes < 0) return false;
    if (!result.resumeState || typeof result.resumeState !== 'object') return false;
  }
  return true;
}

function loadCache() {
  if (state.cacheLoaded) return;
  state.cacheLoaded = true;
  if (!existsSync(state.cachePath)) return;
  try {
    const parsed = JSON.parse(readFileSync(state.cachePath, 'utf8'));
    // revision 不一致 = 解析逻辑变过，整份缓存作废（宁可重扫，也不能沿用旧口径）
    if (parsed?.version !== CACHE_VERSION || parsed?.revision !== CACHE_REVISION) {
      console.log('[scan] 解析器已变更，缓存作废，将全量重扫');
      return;
    }
    let dropped = 0;
    for (const entry of parsed.files ?? []) {
      // 缓存文件是纯本地数据，但仍要当作不可信输入校验：
      // 一条坏 bucket 会让 mergeBuckets 抛异常，或让总量变成 NaN 而毫无提示。
      if (!entry || typeof entry.path !== 'string' || !validResult(entry.result)) {
        dropped += 1;
        continue;
      }
      state.files.set(entry.path, entry);
    }
    if (dropped > 0) {
      console.warn(`[scan] 缓存里有 ${dropped} 条损坏记录，已丢弃`);
      state.cacheDirty = true;
    }
  } catch (error) {
    console.warn(`[scan] 缓存损坏，将全量重扫：${error.message}`);
  }
}

function saveCache() {
  if (!state.cacheDirty) return;
  mkdirSync(dirname(state.cachePath), { recursive: true });
  const files = [...state.files.values()];
  const payload = { version: CACHE_VERSION, revision: CACHE_REVISION, savedAt: Date.now(), files };
  // 每个进程用自己的临时文件名：两个实例同时跑时，共用同一个 .tmp 会互相覆盖
  const tmp = `${state.cachePath}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    renameSync(tmp, state.cachePath);
    state.cacheDirty = false;
  } catch (error) {
    console.warn(`[scan] 缓存写入失败：${error.message}`);
    try { rmSync(tmp, { force: true }); } catch { /* 清理失败无所谓 */ }
  }
}

export function clearCache() {
  state.files.clear();
  state.cacheDirty = true;
  state.report = null;
  saveCache();
}

export function cacheStats() {
  let bytes = 0;
  let entries = 0;
  for (const entry of state.files.values()) {
    entries += 1;
    bytes += entry.size ?? 0;
  }
  let onDisk = 0;
  try {
    onDisk = statSync(state.cachePath).size;
  } catch {
    onDisk = 0;
  }
  return { entries, sourceBytes: bytes, cacheBytes: onDisk, path: state.cachePath };
}

/* ────────────────────────── worker 池 ────────────────────────── */

class WorkerPool {
  constructor(size, url) {
    this.size = size;
    this.workers = [];
    this.idle = [];
    this.busy = new Map();
    this.queue = [];
    this.dead = false;
    for (let i = 0; i < size; i += 1) {
      try {
        const worker = new Worker(url);
        worker.on('message', (message) => this.onMessage(worker, message));
        worker.on('error', (error) => this.onError(worker, error));
        // 必须监听 exit：worker 异常死亡（OOM / 原生崩溃）既不会触发 'error'，
        // 也不会再有 'message'。少了这个监听，在飞的任务 promise 永不 settle，
        // await Promise.all 就永久挂住，整个应用会卡在「扫描中」再也出不来。
        worker.on('exit', (code) => this.onError(worker, new Error(`worker 退出，code=${code}`)));
        // 同样不能 unref：worker 必须在扫描期间把事件循环撑住，扫描结束会 terminate
        this.workers.push(worker);
        this.idle.push(worker);
      } catch {
        this.dead = true;
        break;
      }
    }
    if (this.workers.length === 0) this.dead = true;
  }

  run(item) {
    if (this.dead) return null;
    return new Promise((resolve, reject) => {
      this.queue.push({ item, resolve, reject });
      this.dispatch();
    });
  }

  dispatch() {
    while (this.queue.length > 0 && this.idle.length > 0) {
      const worker = this.idle.pop();
      const job = this.queue.shift();
      this.busy.set(worker, job);
      worker.postMessage(job.item);
    }
  }

  onMessage(worker, message) {
    const job = this.busy.get(worker);
    if (!job) return;
    this.busy.delete(worker);
    this.idle.push(worker);
    if (message.ok) job.resolve(message);
    else job.reject(new Error(message.error));
    this.dispatch();
  }

  onError(worker, error) {
    // 'error' 与 'exit' 都会走到这里，同一根 worker 只处理一次
    if (!this.workers.includes(worker)) return;
    const job = this.busy.get(worker);
    this.busy.delete(worker);
    this.workers = this.workers.filter((w) => w !== worker);
    this.idle = this.idle.filter((w) => w !== worker);
    if (this.workers.length === 0) {
      this.dead = true;
      // 池子空了：把排队的任务全部拒掉，绝不让任何 promise 悬着
      for (const queued of this.queue.splice(0)) {
        queued.reject(new Error('没有可用的 worker'));
      }
    }
    if (job) job.reject(error);
    this.dispatch();
  }

  async destroy() {
    const closing = this.workers.map((worker) => worker.terminate().catch(() => {}));
    this.workers = [];
    this.idle = [];
    for (const queued of this.queue.splice(0)) {
      queued.reject(new Error('扫描已取消'));
    }
    await Promise.all(closing);
  }
}

function workerCount(config) {
  const configured = Number(config.workers) || 0;
  if (configured > 0) return Math.min(configured, 16);
  return Math.max(1, Math.min(8, cpus().length - 1));
}

/* ────────────────────────── 主扫描流程 ────────────────────────── */

export function isScanning() {
  return scanning !== null;
}

export async function scan({ force = false, reason = 'manual' } = {}) {
  if (scanning) return scanning;
  scanning = doScan({ force, reason }).finally(() => {
    scanning = null;
  });
  return scanning;
}

async function doScan({ force, reason }) {
  const config = loadConfig();
  loadCache();
  const startedAt = Date.now();
  const specs = sourceSpecs(config);
  const environment = environmentInfo();

  emit([{ type: 'scan/start', reason, at: startedAt, force }]);

  // 1) 枚举
  const enumeration = await enumerateAll(specs, config);
  const items = [];
  const seenIds = new Set();
  for (const item of enumeration.items) {
    if (seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    items.push(item);
  }

  // 2) 分流：命中缓存直接复用；只是「变大了」的追加式日志走增量续读
  const dirty = [];
  let reused = 0;
  let reusedBytes = 0;
  let resumable = 0;
  let resumeBytes = 0;
  for (const item of items) {
    const cached = state.files.get(item.path);
    const fresh = !force
      && cached
      && cached.size === item.size
      && cached.mtimeMs === item.mtimeMs
      && cached.source === item.source;
    if (fresh) {
      reused += 1;
      reusedBytes += item.size;
      // 刷新元信息（sourceId 可能因配置变化而不同）
      cached.sourceId = item.sourceId;
      cached.accent = item.accent;
      continue;
    }

    // 追加式日志的增量续读：文件只是变大了，就只读新增的尾巴。
    // 这是把刷新频率提上去的关键 —— 否则日志每写一行都要把 17MB 会话整份重解（实测 0.5s）。
    const resume = cached?.result?.resumeState;
    const parsedBytes = cached?.result?.parsedBytes;
    const canResume = !force
      && cached
      && cached.source === item.source
      && resume
      && Number.isFinite(parsedBytes)
      && parsedBytes > 0
      && item.size > parsedBytes;
    if (canResume) {
      item.resume = {
        parsedBytes,
        state: resume,
        base: {
          buckets: cached.result.buckets,
          hours: cached.result.hours,
          hoursByDay: cached.result.hoursByDay,
          recent: cached.result.recent,
          firstTs: cached.result.firstTs,
          lastTs: cached.result.lastTs,
          events: cached.result.events,
        },
      };
      resumable += 1;
      resumeBytes += item.size - parsedBytes;
    }
    dirty.push(item);
  }

  const totalBytes = items.reduce((sum, item) => sum + item.size, 0);
  const dirtyBytes = dirty.reduce((sum, item) => {
    const resume = item.resume;
    return sum + (resume ? item.size - resume.parsedBytes : item.size);
  }, 0);
  emit([{
    type: 'scan/plan',
    at: Date.now(),
    files: items.length,
    dirtyFiles: dirty.length,
    reusableFiles: reused,
    resumableFiles: resumable,
    resumeBytes,
    totalBytes,
    dirtyBytes,
    reusedBytes,
    workers: workerCount(config),
    enumerationErrors: enumeration.errors,
  }]);

  // 3) 解析脏文件
  const ttl = Math.max(items.length, 1);
  let done = Math.max(reused, 0);
  const failures = [...enumeration.errors];
  let fileResults = new Map();
  const pool = dirty.length > 0 ? new WorkerPool(workerCount(config), WORKER_URL) : null;

  const recordResult = (item, message) => {
    const result = message.result;
    result.sourceId = item.sourceId;
    result.path = item.path;
    result.size = item.size;
    result.mtimeMs = item.mtimeMs;
    result.source = item.source;
    result.parsedMs = message.ms ?? 0;
    state.files.set(item.path, {
      path: item.path,
      source: item.source,
      sourceId: item.sourceId,
      size: item.size,
      mtimeMs: item.mtimeMs,
      parsedMs: result.parsedMs,
      result,
    });
    state.cacheDirty = true;
    fileResults.set(item.path, result);
    done += 1;
    emit([{
      type: 'scan/file',
      at: Date.now(),
      path: item.path,
      source: item.source,
      sourceId: item.sourceId,
      size: item.size,
      ms: result.parsedMs,
      events: result.events,
      resumed: Boolean(item.resume),
      bytesRead: item.resume ? item.size - item.resume.parsedBytes : item.size,
      tokens: bucketTotalOf(result.buckets),
      done,
      total: ttl,
      bytesDone: result.size,
      bytesTotal: totalBytes,
    }]);
  };

  if (pool && !pool.dead) {
    const queue = dirty.slice();
    const runners = [];
    const runnerCount = Math.min(pool.size, queue.length);
    for (let i = 0; i < runnerCount; i += 1) {
      runners.push((async () => {
        while (queue.length > 0) {
          const item = queue.shift();
          try {
            const message = await pool.run(item);
            if (!message) break;
            recordResult(item, message);
          } catch (error) {
            failures.push({ source: item.source, path: item.path, error: error.message });
            done += 1;
          }
        }
      })());
    }
    await Promise.all(runners);
    await pool.destroy();
  } else if (dirty.length > 0) {
    // 退化路径：环境不允许 worker（某些受限沙箱）时单线程跑，功能不打折
    emit([{ type: 'scan/note', message: 'worker 线程不可用，已切换为单线程解析（会更慢）' }]);
    const { parseItem } = await import('./scanners/index.mjs');
    for (const item of dirty) {
      const at = Date.now();
      try {
        const result = await parseItem(item);
        recordResult(item, { result, ms: Date.now() - at });
      } catch (error) {
        failures.push({ source: item.source, path: item.path, error: error.message });
        done += 1;
      }
    }
  }

  // 4) 清理已消失文件的缓存
  const alivePaths = new Set(items.map((item) => item.path));
  for (const path of [...state.files.keys()]) {
    if (!alivePaths.has(path)) {
      state.files.delete(path);
      state.cacheDirty = true;
    }
  }

  saveCache();

  // 5) 汇总扫描报告
  const fileReports = [];
  for (const item of items) {
    const entry = state.files.get(item.path);
    if (!entry) {
      fileReports.push({ path: item.path, source: item.source, sourceId: item.sourceId, status: 'error' });
      continue;
    }
    fileReports.push({
      path: item.path,
      name: item.path.split(/[\\/]/).pop(),
      source: item.source,
      sourceId: item.sourceId,
      size: item.size,
      mtimeMs: item.mtimeMs,
      parsedMs: entry.result?.parsedMs ?? entry.parsedMs ?? 0,
      events: entry.result?.events ?? 0,
      sessions: entry.result?.sessions ?? 0,
      tokens: bucketTotalOf(entry.result?.buckets),
      reused: !fileResults.has(item.path),
    });
  }

  const bySourceReport = new Map();
  for (const file of fileReports) {
    const bucket = bySourceReport.get(file.sourceId) ?? {
      id: file.sourceId,
      files: 0,
      bytes: 0,
      events: 0,
      sessions: 0,
      tokens: 0,
      parsedMs: 0,
      errors: 0,
    };
    bucket.files += 1;
    bucket.bytes += file.size ?? 0;
    bucket.events += file.events ?? 0;
    bucket.sessions += file.sessions ?? 0;
    bucket.tokens += file.tokens ?? 0;
    bucket.parsedMs += file.parsedMs ?? 0;
    if (file.status === 'error') bucket.errors += 1;
    bySourceReport.set(file.sourceId, bucket);
  }

  const specsReport = specs.map((spec) => {
    const stat = bySourceReport.get(spec.id) ?? { files: 0, bytes: 0, events: 0, sessions: 0, tokens: 0, parsedMs: 0, errors: 0 };
    const roots = (spec.paths ?? []).map((path) => ({ path, exists: existsSync(path), configured: (config.sources?.[spec.id]?.paths ?? []).includes(path) }));
    return {
      id: spec.id,
      label: spec.label,
      scanner: spec.scanner,
      kind: spec.kind,
      vendor: spec.vendor,
      accent: spec.accent,
      description: spec.description,
      enabled: spec.enabled !== false,
      note: (config.sources?.[spec.id]?.note) ?? '',
      roots,
      ...stat,
    };
  });

  const finishedAt = Date.now();
  state.report = {
    reason,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    files: items.length,
    parsedFiles: dirty.length,
    resumedFiles: resumable,
    resumeBytes,
    reusedFiles: reused,
    totalBytes,
    parsedBytes: dirtyBytes,
    reusedBytes,
    workerCount: workerCount(config),
    usedWorkers: Boolean(pool && !pool.dead),
    sources: specsReport,
    fileList: fileReports
      .sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0))
      .slice(0, 400),
    errors: failures.slice(0, 50),
    environment,
    bySource: Object.fromEntries([...bySourceReport.entries()].map(([id, value]) => [id, value])),
  };

  emit([{ type: 'scan/end', at: finishedAt, durationMs: state.report.durationMs, files: items.length, parsedFiles: dirty.length, resumedFiles: resumable, reusedFiles: reused }]);
  return state.report;
}

function bucketTotalOf(buckets) {
  if (!buckets) return 0;
  let total = 0;
  for (const bucket of Object.values(buckets)) total += bucket[0] + bucket[1] + bucket[2] + bucket[3];
  return total;
}

/* ────────────────────────── 取原始聚合 ────────────────────────── */

/**
 * 把按文件缓存的 bucket 表合并成一份原始聚合。
 * @param {{sources?: string[]}} options sources = 只统计这些来源（空 = 全部）
 */
export function buildRaw({ sources = null } = {}) {
  const filter = sources && sources.length > 0 ? new Set(sources) : null;
  const merged = {
    buckets: {},
    hours: emptyHours(),
    hoursByDay: {},
    recent: [],
    events: 0,
    sessions: 0,
    firstTs: 0,
    lastTs: 0,
    extra: {},
    perSource: {},
    files: 0,
    bytes: 0,
  };

  const mergeHoursByDay = (target, source) => {
    for (const [day, hours] of Object.entries(source ?? {})) {
      if (!target[day]) target[day] = emptyHours();
      mergeHourHistogram(target[day], hours);
    }
  };

  for (const entry of state.files.values()) {
    if (filter && !filter.has(entry.sourceId)) continue;
    const result = entry.result;
    if (!result) continue;
    merged.files += 1;
    merged.bytes += entry.size ?? 0;
    mergeBuckets(merged.buckets, result.buckets ?? {});
    mergeHourHistogram(merged.hours, result.hours ?? emptyHours());
    mergeHoursByDay(merged.hoursByDay, result.hoursByDay);
    merged.events += result.events ?? 0;
    merged.sessions += result.sessions ?? 0;
    if (result.firstTs) merged.firstTs = merged.firstTs === 0 ? result.firstTs : Math.min(merged.firstTs, result.firstTs);
    if (result.lastTs) merged.lastTs = Math.max(merged.lastTs, result.lastTs);
    merged.recent.push(...(result.recent ?? []));
    if (result.extra) {
      merged.extra[entry.sourceId] ??= {};
      for (const [key, value] of Object.entries(result.extra)) {
        if (typeof value === 'number') {
          merged.extra[entry.sourceId][key] = (merged.extra[entry.sourceId][key] ?? 0) + value;
        } else {
          merged.extra[entry.sourceId][key] = value;
        }
      }
    }
    let bucket = merged.perSource[entry.sourceId];
    if (!bucket) {
      bucket = { buckets: {}, hours: emptyHours(), hoursByDay: {}, events: 0, sessions: 0, files: 0, bytes: 0 };
      merged.perSource[entry.sourceId] = bucket;
    }
    mergeBuckets(bucket.buckets, result.buckets ?? {});
    mergeHourHistogram(bucket.hours, result.hours ?? emptyHours());
    mergeHoursByDay(bucket.hoursByDay, result.hoursByDay);
    bucket.events += result.events ?? 0;
    bucket.sessions += result.sessions ?? 0;
    bucket.files += 1;
    bucket.bytes += entry.size ?? 0;
  }

  merged.recent.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  merged.recent = merged.recent.slice(0, 240);
  return merged;
}

export function getReport() {
  return state.report;
}

export function isCacheLoaded() {
  loadCache();
  return state.files.size > 0;
}

export { loadCache, saveCache, join, saveConfig };
