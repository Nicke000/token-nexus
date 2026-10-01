/**
 * config.mjs —— 配置读写
 *
 * 配置放用户目录（~/.token-nexus/config.json），不放仓库里，这样：
 *   1. 开源仓库永远不含真实 API 密钥；
 *   2. 升级/移动项目目录不会丢配置；
 *   3. 可以用 TOKEN_NEXUS_CONFIG 环境变量指到别处（容器/PORTABLE 场景）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export const CONFIG_DIR =
  process.env.TOKEN_NEXUS_HOME || join(homedir(), '.token-nexus');
export const CONFIG_PATH = process.env.TOKEN_NEXUS_CONFIG || join(CONFIG_DIR, 'config.json');
export const CACHE_DIR = join(CONFIG_DIR, 'cache');
export const CACHE_FILE = join(CACHE_DIR, 'index-v1.json');

/**
 * 配置结构版本。
 *
 * 为什么要它：saveConfig 会把「合并后的完整配置」落盘，于是**每一个默认值都会被固化**。
 * 之后调整默认值（比如刷新间隔从 60s 改到 1s）对已有配置的用户完全无效 ——
 * 他们的文件里写着旧值，看起来像"改了没用"。所以需要迁移：
 * 如果某个字段还等于**旧默认值**（说明用户从没动过它），就跟随新默认值；
 * 用户显式改过（值不等于任何旧默认值）则原样保留。
 */
const SCHEMA_VERSION = 2;

const DEFAULT_MIGRATIONS = [
  {
    version: 1,
    apply: (cfg) => {
      // 增量续读上线前：轮询 5s、保鲜窗口 60s（中间还短暂用过 5s）
      if (cfg.refreshMs === 5000) cfg.refreshMs = DEFAULT_CONFIG.refreshMs;
      if (cfg.cacheTtlMs === 60000 || cfg.cacheTtlMs === 5000) cfg.cacheTtlMs = DEFAULT_CONFIG.cacheTtlMs;
    },
  },
];

export function migrateConfig(fileConfig) {
  const from = Number(fileConfig?.schemaVersion) || 1;
  if (!fileConfig || from >= SCHEMA_VERSION) return fileConfig ?? {};
  const next = { ...fileConfig };
  for (const step of DEFAULT_MIGRATIONS) {
    if (from <= step.version) step.apply(next);
  }
  next.schemaVersion = SCHEMA_VERSION;
  return next;
}

export const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  port: 8787,
  host: '127.0.0.1',
  openBrowser: true,
  /** 展示货币：auto = 按价格表原始币种（USD），可切 CNY */
  displayCurrency: 'USD',
  /** 1 USD 兑多少 CNY，仅用于换算展示 */
  fxRate: 7.15,
  /**
   * 服务端新鲜度窗口：超过这个时长，下次读快照会在后台做一次增量重扫。
   * 追加式日志走「只读新增尾巴」，所以 1 秒的窗口成本极低（实测 ~30ms）。
   */
  cacheTtlMs: 1000,
  /** 前端轮询间隔：每这么久拉一次 /api/snapshot（数据没变不会重绘） */
  refreshMs: 1000,
  /** 首次全量扫描的 worker 线程数；0 = 自动（CPU 核数 - 1，上限 8） */
  workers: 0,
  /** 只统计最近 N 天（0 = 全部） */
  windowDays: 0,
  sources: {},
  pricing: {
    /** { "<模型名子串>": { input, output, cacheRead, cacheWrite, vendor, label } } */
    overrides: {},
    disabled: [],
  },
  api: {
    openai: { enabled: false, adminKey: '', organization: '', baseUrl: 'https://api.openai.com' },
    anthropic: { enabled: false, adminKey: '', baseUrl: 'https://api.anthropic.com' },
    openrouter: { enabled: false, apiKey: '', baseUrl: 'https://openrouter.ai/api' },
    deepseek: { enabled: false, apiKey: '', baseUrl: 'https://api.deepseek.com' },
  },
  ui: {
    boot: true,
    particles: true,
    reducedMotion: false,
    /** 主题：dark = 赛博霓虹（默认）/ light = 清爽印刷风 */
    theme: 'dark',
  },
});

const SECRET_KEYS = new Set(['adminKey', 'apiKey', 'key', 'token', 'secret']);
/** JSON.parse 会生成 `__proto__` 这种自有属性，合并时必须跳过，否则会改到结果的原型。 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || UNSAFE_KEYS.has(key)) continue;
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

let cached = null;

export function loadConfig({ reload = false } = {}) {
  if (cached && !reload) return cached;
  let fileConfig = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      fileConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    } catch (error) {
      console.warn(`[config] ${CONFIG_PATH} 解析失败，改用默认配置：${error.message}`);
      fileConfig = {};
    }
  }
  cached = deepMerge(DEFAULT_CONFIG, migrateConfig(fileConfig));
  return cached;
}

export function saveConfig(patch) {
  const next = deepMerge(loadConfig(), patch ?? {});
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  const tmp = `${CONFIG_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  renameSync(tmp, CONFIG_PATH);
  cached = next;
  return next;
}

/** 把配置里的密钥替换成 hasXxx 标记，前端永不接触明文。 */
export function redact(config) {
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk);
    if (!isPlainObject(value)) return value;
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (SECRET_KEYS.has(key) && typeof val === 'string') {
        if (key in out) continue;
        out[key.replace(/Key$|^key$/, '') + 'KeySet'] = val.length > 0;
        // 保留一个可辨认的尾部，方便用户确认自己填的是哪一把
        out[key.replace(/Key$|^key$/, '') + 'KeyHint'] = val.length >= 4 ? `····${val.slice(-4)}` : '';
        continue;
      }
      out[key] = walk(val);
    }
    return out;
  };
  return walk(config);
}

/** 保存时：值为空串 / null 表示「不改动已有密钥」，`__clear__` 表示清空。 */
export function mergeSecretPatch(patch) {
  const current = loadConfig();
  const walk = (patchValue, baseValue) => {
    if (!isPlainObject(patchValue)) return patchValue;
    const out = {};
    for (const [key, val] of Object.entries(patchValue)) {
      if (SECRET_KEYS.has(key) && typeof val === 'string') {
        if (val === '__clear__') out[key] = '';
        else if (val === '') out[key] = baseValue?.[key] ?? '';
        else out[key] = val;
        continue;
      }
      out[key] = isPlainObject(val) && isPlainObject(baseValue?.[key]) ? walk(val, baseValue[key]) : val;
    }
    return out;
  };
  return walk(patch ?? {}, current);
}

export function ensureDirs() {
  mkdirSync(CONFIG_DIR, { recursive: true });
  mkdirSync(CACHE_DIR, { recursive: true });
}
