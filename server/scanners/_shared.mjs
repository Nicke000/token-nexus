/**
 * scanners/_shared.mjs —— 扫描器共用的底层工具
 *
 * 最核心的一块是 **追加式 zstd 多帧解码**：
 * agent 的会话日志是「一个 JSONL 行一帧地往后 append」的，所以整个文件是
 * 成千上万个独立 zstd 帧首尾相接。Node 的 zstdDecompressSync 只认第一帧，
 * createZstdDecompress 遇到第二帧直接报 "Unknown frame descriptor"。
 *
 * ⚠️ 为什么不能靠「猜」帧边界：
 * 一开始的做法是找 zstd magic number 当候选边界、逐个试解压。看着可行，其实有坑 ——
 * 压缩数据内部**真的**会出现 `28 B5 2F FD` 这几个字节（不可压缩的字面量原样存储），
 * 而更致命的是：**一个被截断的帧前缀有时会解压"成功"并返回部分内容**。
 * 于是假边界被当成真帧、产出一段短内容，后续整段日志被静默丢弃。
 *
 * 现在的做法是**解析 zstd 帧头精确算出帧长度**（Frame_Header + Block 序列 + Checksum），
 * 和 magic 扫描无关，因此不会漏也不会重。magic 只用来在文件损坏时重新同步。
 */
import { zstdDecompressSync } from 'node:zlib';
import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export const ZSTD_AVAILABLE = typeof zstdDecompressSync === 'function';

export function findFrameStarts(buffer) {
  const starts = [];
  let at = buffer.indexOf(ZSTD_MAGIC, 0);
  while (at >= 0) {
    starts.push(at);
    at = buffer.indexOf(ZSTD_MAGIC, at + 4);
  }
  return starts;
}

const DICT_ID_SIZE = [0, 1, 2, 4];

/**
 * 精确计算从 `start` 开始的 zstd 帧长度（返回帧结束的绝对偏移）。
 *
 * 帧结构：Magic(4) + Frame_Header(2~14) + Blocks...
 *   Frame_Header_Descriptor:
 *     bit7-6 FCS_Field_Size  bit5 Single_Segment  bit2 Content_Checksum  bit1-0 DictID_Size
 *   Block_Header(3 bytes, little-endian): bit0 Last_Block, bit1-2 Block_Type, bit3-23 Block_Size
 *     Block_Type 0=Raw(帧内占 Block_Size 字节) 1=RLE(帧内只占 1 字节) 2=Compressed(占 Block_Size)
 *
 * @returns {number} 帧结束偏移；无法解析时返回 -1
 */
export function frameLength(buffer, start) {
  const size = buffer.length;
  if (start + 4 > size) return -1;
  if (buffer.readUInt32LE(start) !== 0xfd2fb528) {
    // zstd 可跳过帧（0x184D2A50~5F）：8 字节头 + 声明的长度
    if ((buffer.readUInt32LE(start) & 0xfffffff0) === 0x184d2a50) {
      if (start + 8 > size) return -1;
      const skip = buffer.readUInt32LE(start + 4);
      const end = start + 8 + skip;
      return end <= size ? end : -1;
    }
    return -1;
  }
  let offset = start + 4;
  if (offset >= size) return -1;

  const descriptor = buffer[offset];
  offset += 1;
  const fcsFlag = descriptor >> 6;
  const singleSegment = (descriptor >> 5) & 1;
  const hasChecksum = (descriptor >> 2) & 1;
  const dictIdFlag = descriptor & 3;

  if (singleSegment === 0) {
    if (offset >= size) return -1;
    offset += 1; // Window_Descriptor
  }
  offset += DICT_ID_SIZE[dictIdFlag];
  // FCS 字段：FCS_flag=0 时，仅当 Single_Segment=1 才有 1 字节
  const fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : [2, 4, 8][fcsFlag - 1];
  offset += fcsSize;
  if (offset > size) return -1;

  // 逐块走完
  for (let guard = 0; guard < 1_000_000; guard += 1) {
    if (offset + 3 > size) return -1;
    const header = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
    offset += 3;
    const lastBlock = header & 1;
    const blockType = (header >> 1) & 3;
    const blockSize = header >> 3;
    if (blockType === 3) return -1; // Reserved，说明这里不是合法的帧
    offset += blockType === 1 ? 1 : blockSize; // RLE 只占 1 字节
    if (offset > size) return -1;
    if (lastBlock) break;
  }
  if (hasChecksum) offset += 4;
  return offset <= size ? offset : -1;
}

/**
 * 逐帧解码拼接式 zstd 流。
 * @returns {Generator<Buffer>} 每一帧的原始字节（**不在这里做 utf8 解码** ——
 *   交给 StringDecoder 处理，否则跨帧的多字节字符会被替换成 U+FFFD）
 */
export function* decodeZstdFrames(buffer) {
  if (buffer.length === 0) return;
  if (!ZSTD_AVAILABLE) return;

  let offset = 0;
  let frames = 0;
  while (offset < buffer.length) {
    const end = frameLength(buffer, offset);
    if (end < 0) {
      // 损坏或不是拼接流：找下一个 magic 重新同步
      const next = buffer.indexOf(ZSTD_MAGIC, offset + 1);
      if (next < 0) break;
      offset = next;
      continue;
    }
    let decoded = null;
    try {
      decoded = zstdDecompressSync(buffer.subarray(offset, end));
    } catch {
      // 按帧头算出来的长度却解不开：退一步，重新同步
      const next = buffer.indexOf(ZSTD_MAGIC, offset + 1);
      if (next < 0) break;
      offset = next;
      continue;
    }
    frames += 1;
    yield decoded;
    offset = end;
  }

  if (frames === 0) {
    // 整个文件只有一帧且帧头解析失败时的最后手段
    try {
      yield zstdDecompressSync(buffer);
    } catch {
      /* 损坏文件静默跳过 */
    }
  }
}

/**
 * 逐帧解码拼接式 zstd 流，并**报告每帧的字节范围**。
 *
 * 这是「追加式日志增量解析」的基础：只要记住上一轮消费到哪个字节，
 * 下一轮就只解新追加的那几帧 —— 而不是把 17MB 的会话文件整份重解一遍。
 *
 * @returns {Generator<{start:number,end:number,data:Buffer}>}
 */
export function* decodeZstdFramesFrom(buffer, start = 0) {
  if (!ZSTD_AVAILABLE) return;
  let offset = start;
  while (offset < buffer.length) {
    const end = frameLength(buffer, offset);
    if (end < 0) return; // 尾巴不完整（或损坏）：就此停住，由调用方决定是否退回全量解析
    let decoded;
    try {
      decoded = zstdDecompressSync(buffer.subarray(offset, end));
    } catch {
      return;
    }
    yield { start: offset, end, data: decoded };
    offset = end;
  }
}

/** 只读文件的 [offset, EOF) 部分。追加式日志的增量读取就靠它。 */
export function readFileBufferFrom(path, offset) {
  const stat = statSync(path);
  if (offset <= 0) return readFileSync(path);
  if (offset >= stat.size) return Buffer.alloc(0);
  const fd = openSync(path, 'r');
  try {
    const total = stat.size - offset;
    const out = Buffer.allocUnsafe(total);
    let filled = 0;
    // readSync 对大块读取可能短读，必须循环到填满
    while (filled < total) {
      const got = readSync(fd, out, filled, total - filled, offset + filled);
      if (got <= 0) break;
      filled += got;
    }
    return filled === total ? out : out.subarray(0, filled);
  } finally {
    closeSync(fd);
  }
}

const EMPTY_BUFFER = Buffer.alloc(0);

/**
 * 把一个字节块拆成「完整的 UTF-8 文本」+「不完整的尾巴字节」。
 * 增量解析时尾巴必须留到下一轮 —— 否则多字节字符会被切成 U+FFFD。
 *
 * @returns {{text: Buffer, pending: Buffer}}
 */
export function splitUtf8(buffer) {
  let cut = buffer.length;
  let back = 0;
  while (cut > 0 && back < 4) {
    const byte = buffer[cut - 1];
    if ((byte & 0x80) === 0) break; // ASCII 结尾，必然完整
    if ((byte & 0xc0) === 0x80) { cut -= 1; back += 1; continue; } // 续字节，继续往前找
    const need = (byte & 0xe0) === 0xc0 ? 2 : (byte & 0xf0) === 0xe0 ? 3 : 4;
    if (buffer.length - (cut - 1) >= need) break; // 起始字节 + 后续字节都齐了
    return { text: buffer.subarray(0, cut - 1), pending: Buffer.from(buffer.subarray(cut - 1)) };
  }
  return { text: buffer, pending: EMPTY_BUFFER };
}

/**
 * 按行遍历（自动跨帧拼接半行），避免把整个会话文本一次性读进内存。
 * 用**同一个** StringDecoder 贯穿所有帧：多字节 UTF-8 字符被切在帧边界时，
 * decoder 会把不完整字节留到下一次 write，而不是变成 U+FFFD。
 */
export function* iterateZstdLines(buffer) {
  const decoder = new StringDecoder('utf8');
  let carry = '';
  for (const bytes of decodeZstdFrames(buffer)) {
    if (bytes.length === 0) continue;
    carry += decoder.write(bytes);
    let idx = carry.indexOf('\n');
    while (idx >= 0) {
      const line = carry.slice(0, idx);
      if (line.length > 0) yield line;
      carry = carry.slice(idx + 1);
      idx = carry.indexOf('\n');
    }
  }
  carry += decoder.end();
  if (carry.trim().length > 0) yield carry;
}

/**
 * 流式按行读普通文本文件（超大 JSONL 不占内存）。
 *
 * 关键点：每个 4 MiB 分片**不能**单独 toString('utf8')。多字节字符被切在分片边界时，
 * 两次解码都会得到 U+FFFD，而 JSON 仍然能 parse 成功 —— 于是路径/模型名被静默损坏，
 * 同一个项目裂成多个 bucket。用 StringDecoder 把不完整字节留到下一片即可。
 */
export function* iterateFileLines(path, { chunkBytes = 4 << 20 } = {}) {
  const size = statSync(path).size;
  if (size === 0) return;
  const fd = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(chunkBytes);
  const decoder = new StringDecoder('utf8');
  let carry = '';
  try {
    let position = 0;
    while (position < size) {
      const readBytes = readSync(fd, buffer, 0, Math.min(chunkBytes, size - position), position);
      if (readBytes <= 0) break;
      position += readBytes;
      carry += decoder.write(buffer.subarray(0, readBytes));
      let idx = carry.indexOf('\n');
      while (idx >= 0) {
        const line = carry.slice(0, idx);
        if (line.length > 0) yield line;
        carry = carry.slice(idx + 1);
        idx = carry.indexOf('\n');
      }
    }
    carry += decoder.end();
    if (carry.trim().length > 0) yield carry;
  } finally {
    closeSync(fd);
  }
}

export function readFileBuffer(path, maxBytes = 0) {
  if (maxBytes <= 0) return readFileSync(path);
  const stat = statSync(path);
  if (stat.size <= maxBytes) return readFileSync(path);
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    readSync(fd, buf, 0, maxBytes, stat.size - maxBytes);
    return buf;
  } finally {
    closeSync(fd);
  }
}

export function safeParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * 所有扫描器的统一输出累加器 —— 聚合层只认这一种形状。
 * 注意 `sessions` 用 Set，序列化前必须转成数字。
 */
export function makeAccumulator(emptyHours) {
  return {
    buckets: {},
    hours: emptyHours(),
    /** { 'YYYY-MM-DD': number[24] } —— 让小时分布也能按日期区间过滤 */
    hoursByDay: {},
    recent: [],
    firstTs: 0,
    lastTs: 0,
    sessions: new Set(),
    events: 0,
    skipped: 0,
  };
}

export function pushRecent(acc, entry, limit = 14) {
  acc.recent.push(entry);
  if (acc.recent.length > limit) acc.recent.splice(0, acc.recent.length - limit);
}

export function finalizeAccumulator(acc) {
  return {
    buckets: acc.buckets,
    hours: acc.hours,
    hoursByDay: acc.hoursByDay ?? {},
    recent: acc.recent,
    firstTs: acc.firstTs,
    lastTs: acc.lastTs,
    sessions: acc.sessions instanceof Set ? acc.sessions.size : Number(acc.sessions) || 0,
    events: acc.events,
    skipped: acc.skipped,
  };
}
