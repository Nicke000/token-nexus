#!/usr/bin/env node
/**
 * tools/build-pricing.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * 把 tools/pricing/price-table.json（人可读、可手改的价格表）
 * 编译成 server/pricing-data.mjs（运行时直接 import，不依赖 fs / JSON import 断言）。
 *
 * 用法：
 *   node tools/build-pricing.mjs
 *
 * 改价格的正确流程：
 *   1. 编辑 tools/pricing/price-table.json
 *   2. 跑本脚本
 *   3. 刷新界面 —— **不用重扫日志**（缓存里存的是 token，不是钱）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SOURCE = join(HERE, 'pricing', 'price-table.json');
const TARGET = join(ROOT, 'server', 'pricing-data.mjs');

const table = JSON.parse(readFileSync(SOURCE, 'utf8'));

if (!Array.isArray(table.models) || table.models.length === 0) {
  console.error('price-table.json 里没有 models');
  process.exit(1);
}

// 顺序是**语义的一部分**（自上而下首个命中生效），所以原样保留数组顺序。
const rows = table.models.map((row) => {
  const clean = {
    match: row.match,
    label: row.label,
    vendor: row.vendor,
    input: row.input ?? null,
    output: row.output ?? null,
    cacheRead: row.cacheRead ?? null,
    cacheWrite: row.cacheWrite ?? null,
  };
  if (row.confidence) clean.confidence = row.confidence;
  if (row.note) clean.note = row.note;
  return clean;
});

const banner = `/**
 * pricing-data.mjs —— 由 tools/build-pricing.mjs 自动生成，请勿手改。
 * 数据源：tools/pricing/price-table.json   （as of ${table.pricesAsOf ?? 'unknown'}）
 * 重新生成：node tools/build-pricing.mjs
 *
 * 共 ${rows.length} 条规则。**数组顺序即优先级**：自上而下第一个匹配命中的生效，
 * 所以具体型号必须排在家族前缀之前，最后一条是 "*" 兜底（null 价 → 显示「未定价」）。
 */
`;

const body = `${banner}
export const PRICING_META = ${JSON.stringify({
  currency: table.currency ?? 'USD',
  unit: table.unit ?? 'per 1M tokens',
  pricesAsOf: table.pricesAsOf ?? null,
  note: table.note ?? '',
  source: 'tools/pricing/price-table.json',
}, null, 2)};

export const PRICING_MODELS = ${JSON.stringify(rows, null, 2)};

export const PRICING_ALIASES = ${JSON.stringify(table.aliases ?? {}, null, 2)};

export const PRICING_SOURCES = ${JSON.stringify(table.sources ?? [], null, 2)};
`;

writeFileSync(TARGET, body, 'utf8');

const withPrice = rows.filter((row) => row.input !== null || row.output !== null).length;
const low = rows.filter((row) => row.confidence === 'low').length;
console.log(`✓ ${TARGET}`);
console.log(`  ${rows.length} 条规则（${withPrice} 条带价格，${low} 条低置信度）`);
console.log(`  价格基准日 ${table.pricesAsOf ?? '未知'} · 供应商别名 ${Object.keys(table.aliases ?? {}).length} 条`);
