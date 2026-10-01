/**
 * worker.mjs —— 解析 worker 线程入口
 *
 * 1 GB 的会话日志要解 17 万个 zstd 帧，单线程要跑 1~2 分钟。
 * 按文件切给多个 worker，能把首扫压到几十秒；之后走增量缓存，基本是秒开。
 */
import { parentPort } from 'node:worker_threads';
import { parseItem } from './scanners/index.mjs';

if (parentPort) {
  parentPort.on('message', async (item) => {
    const started = Date.now();
    try {
      const result = await parseItem(item);
      parentPort.postMessage({ id: item.id, ok: true, result, ms: Date.now() - started });
    } catch (error) {
      parentPort.postMessage({
        id: item.id,
        ok: false,
        error: error?.message ?? String(error),
        ms: Date.now() - started,
      });
    }
  });
}
