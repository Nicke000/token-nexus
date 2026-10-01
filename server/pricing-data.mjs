/**
 * pricing-data.mjs —— 由 tools/build-pricing.mjs 自动生成，请勿手改。
 * 数据源：tools/pricing/price-table.json   （as of 2026-09-30）
 * 重新生成：node tools/build-pricing.mjs
 *
 * 共 170 条规则。**数组顺序即优先级**：自上而下第一个匹配命中的生效，
 * 所以具体型号必须排在家族前缀之前，最后一条是 "*" 兜底（null 价 → 显示「未定价」）。
 */

export const PRICING_META = {
  "currency": "USD",
  "unit": "per 1M tokens",
  "pricesAsOf": "2026-09-30",
  "note": "USD per 1,000,000 tokens. cacheRead = cache-hit / cached-input price; cacheWrite = cache-write / cache-creation price. null means the vendor does not publish or does not charge that line item. Long-context tiers, batch discounts, off-peak rates and per-region uplifts are NOT folded in - each row note records them. CNY amounts are quoted inside row notes only; conversions there use 1 USD = 7.10 CNY, stated explicitly so it can be re-based. Rows are matched top-down and first hit wins, so the array order is significant: specific models precede family prefixes, which precede the * fallback.",
  "source": "tools/pricing/price-table.json"
};

export const PRICING_MODELS = [
  {
    "match": [
      "deepseek-flash",
      "deepseek-v4-flash-vision-exp",
      "deepseek-v4-flash",
      "deepseek-v4.1-flash",
      "deepseek-v4.1"
    ],
    "label": "DeepSeek V4.1 Flash (ex V4 Flash)",
    "vendor": "DeepSeek",
    "input": 0.3,
    "output": 1.2,
    "cacheRead": 0.006,
    "cacheWrite": null,
    "note": "Official PEAK USD list per 1M. Off-peak is half: $0.15 in / $0.60 out / $0.003 cache-hit. Legacy ids deepseek-v4-flash and deepseek-v4-flash-vision-exp are retired but still accepted, served by DeepSeek-V4.1-Flash at the Flash price."
  },
  {
    "match": [
      "deepseek-v4-pro"
    ],
    "label": "DeepSeek V4 Pro",
    "vendor": "DeepSeek",
    "input": 1.32,
    "output": 3.96,
    "cacheRead": 0.044,
    "cacheWrite": null,
    "note": "Official PEAK USD list for DeepSeek-V4-Pro-0813. Off-peak is half: $0.66 in / $1.98 out / $0.022 cache-hit."
  },
  {
    "match": [
      "deepseek-chat",
      "deepseek-reasoner",
      "deepseek-v3"
    ],
    "label": "DeepSeek V3 / Chat (legacy id)",
    "vendor": "DeepSeek",
    "input": 0.28,
    "output": 0.42,
    "cacheRead": 0.028,
    "cacheWrite": null,
    "confidence": "low",
    "note": "Legacy ids. Official V3.x USD list was $0.28 in / $0.42 out / $0.028 cache-hit. DeepSeek now states that retired names are served by V4.1 Flash at Flash pricing, so real bills may be higher than this row. Check your own logs."
  },
  {
    "match": [
      "deepseek-r1"
    ],
    "label": "DeepSeek R1",
    "vendor": "DeepSeek",
    "input": 0.55,
    "output": 2.19,
    "cacheRead": 0.14,
    "cacheWrite": null,
    "confidence": "low",
    "note": "Third-party hosted blended price; R1 is no longer on DeepSeek first-party current price page."
  },
  {
    "match": [
      "deepseek"
    ],
    "label": "DeepSeek (unlisted model)",
    "vendor": "DeepSeek",
    "input": null,
    "output": null,
    "cacheRead": null,
    "cacheWrite": null
  },
  {
    "match": [
      "gpt-6.1-sol"
    ],
    "label": "OpenAI GPT-6.1 Sol",
    "vendor": "OpenAI",
    "input": 2,
    "output": 10,
    "cacheRead": 0.1,
    "cacheWrite": 2.5
  },
  {
    "match": [
      "gpt-6-astra"
    ],
    "label": "OpenAI GPT-6 Astra",
    "vendor": "OpenAI",
    "input": 10,
    "output": 50,
    "cacheRead": 1,
    "cacheWrite": 12.5
  },
  {
    "match": [
      "gpt-6-luna"
    ],
    "label": "OpenAI GPT-6 Luna",
    "vendor": "OpenAI",
    "input": 0.1,
    "output": 0.5,
    "cacheRead": 0.01,
    "cacheWrite": 0.125
  },
  {
    "match": [
      "gpt-6-sol"
    ],
    "label": "OpenAI GPT-6 Sol",
    "vendor": "OpenAI",
    "input": 2,
    "output": 10,
    "cacheRead": 0.2,
    "cacheWrite": 2.5
  },
  {
    "match": [
      "gpt-5.6-sol"
    ],
    "label": "OpenAI GPT-5.6 Sol",
    "vendor": "OpenAI",
    "input": 4,
    "output": 20,
    "cacheRead": 0.4,
    "cacheWrite": 5,
    "note": "Short-context band (input <=272K). Above 272K input per request: $8.00 in / $30.00 out. Sol promotional pricing holds at least through 2026-11-21."
  },
  {
    "match": [
      "gpt-5.6-terra"
    ],
    "label": "OpenAI GPT-5.6 Terra",
    "vendor": "OpenAI",
    "input": 2,
    "output": 12,
    "cacheRead": 0.2,
    "cacheWrite": 2.5,
    "note": "Short-context band (input <=272K). Above 272K input per request: $4.00 in / $18.00 out."
  },
  {
    "match": [
      "gpt-5.6-luna"
    ],
    "label": "OpenAI GPT-5.6 Luna",
    "vendor": "OpenAI",
    "input": 0.2,
    "output": 1.2,
    "cacheRead": 0.02,
    "cacheWrite": 0.25,
    "note": "Short-context band (input <=272K). Above 272K input per request: $0.40 in / $1.80 out. Cut 80% on 2026-07-30."
  },
  {
    "match": [
      "gpt-5.6"
    ],
    "label": "OpenAI GPT-5.6 (family alias)",
    "vendor": "OpenAI",
    "input": 4,
    "output": 20,
    "cacheRead": 0.4,
    "cacheWrite": 5,
    "confidence": "low",
    "note": "Bare family alias; resolves to the Sol tier in the sources checked. Prefer the Sol/Terra/Luna rows."
  },
  {
    "match": [
      "gpt-5.5"
    ],
    "label": "OpenAI GPT-5.5",
    "vendor": "OpenAI",
    "input": 5,
    "output": 30,
    "cacheRead": 0.5,
    "cacheWrite": null,
    "note": "Short-context band. Above 272K input per request: $10.00 in / $45.00 out."
  },
  {
    "match": [
      "gpt-5.4"
    ],
    "label": "OpenAI GPT-5.4",
    "vendor": "OpenAI",
    "input": 2.5,
    "output": 15,
    "cacheRead": 0.25,
    "cacheWrite": 3.125,
    "note": "cacheWrite derived at the documented 1.25x uncached-input premium."
  },
  {
    "match": [
      "gpt-5.3"
    ],
    "label": "OpenAI GPT-5.3 (Codex generation)",
    "vendor": "OpenAI",
    "input": 1.75,
    "output": 14,
    "cacheRead": 0.175,
    "cacheWrite": null
  },
  {
    "match": [
      "gpt-5.2"
    ],
    "label": "OpenAI GPT-5.2",
    "vendor": "OpenAI",
    "input": 1.75,
    "output": 14,
    "cacheRead": 0.175,
    "cacheWrite": null
  },
  {
    "match": [
      "gpt-5.1"
    ],
    "label": "OpenAI GPT-5.1",
    "vendor": "OpenAI",
    "input": 1.25,
    "output": 10,
    "cacheRead": 0.125,
    "cacheWrite": null
  },
  {
    "match": [
      "gpt-5-mini"
    ],
    "label": "OpenAI GPT-5 mini",
    "vendor": "OpenAI",
    "input": 0.25,
    "output": 2,
    "cacheRead": 0.025,
    "cacheWrite": null
  },
  {
    "match": [
      "gpt-5-nano"
    ],
    "label": "OpenAI GPT-5 nano",
    "vendor": "OpenAI",
    "input": 0.05,
    "output": 0.4,
    "cacheRead": 0.005,
    "cacheWrite": null
  },
  {
    "match": [
      "gpt-5-pro"
    ],
    "label": "OpenAI GPT-5 Pro",
    "vendor": "OpenAI",
    "input": 15,
    "output": 120,
    "cacheRead": null,
    "cacheWrite": null
  },
  {
    "match": [
      "gpt-5"
    ],
    "label": "OpenAI GPT-5",
    "vendor": "OpenAI",
    "input": 1.25,
    "output": 10,
    "cacheRead": 0.125,
    "cacheWrite": null
  },
  {
    "match": [
      "gpt-4.1-mini"
    ],
    "label": "OpenAI GPT-4.1 mini",
    "vendor": "OpenAI",
    "input": 0.4,
    "output": 1.6,
    "cacheRead": 0.1,
    "cacheWrite": null
  },
  {
    "match": [
      "gpt-4.1-nano"
    ],
    "label": "OpenAI GPT-4.1 nano",
    "vendor": "OpenAI",
    "input": 0.1,
    "output": 0.4,
    "cacheRead": 0.025,
    "cacheWrite": null
  },
  {
    "match": [
      "gpt-4.1"
    ],
    "label": "OpenAI GPT-4.1",
    "vendor": "OpenAI",
    "input": 2,
    "output": 8,
    "cacheRead": 0.5,
    "cacheWrite": null
  },
  {
    "match": [
      "gpt-4o-mini"
    ],
    "label": "OpenAI GPT-4o mini",
    "vendor": "OpenAI",
    "input": 0.15,
    "output": 0.6,
    "cacheRead": 0.075,
    "cacheWrite": null
  },
  {
    "match": [
      "gpt-4o"
    ],
    "label": "OpenAI GPT-4o",
    "vendor": "OpenAI",
    "input": 2.5,
    "output": 10,
    "cacheRead": 1.25,
    "cacheWrite": null
  },
  {
    "match": [
      "gpt-4-turbo",
      "gpt-4-"
    ],
    "label": "OpenAI GPT-4 Turbo",
    "vendor": "OpenAI",
    "input": 10,
    "output": 30,
    "cacheRead": null,
    "cacheWrite": null
  },
  {
    "match": [
      "gpt-3.5"
    ],
    "label": "OpenAI GPT-3.5 Turbo",
    "vendor": "OpenAI",
    "input": 0.5,
    "output": 1.5,
    "cacheRead": null,
    "cacheWrite": null
  },
  {
    "match": [
      "o4-mini"
    ],
    "label": "OpenAI o4-mini",
    "vendor": "OpenAI",
    "input": 1.1,
    "output": 4.4,
    "cacheRead": 0.275,
    "cacheWrite": null
  },
  {
    "match": [
      "o3-pro"
    ],
    "label": "OpenAI o3-pro",
    "vendor": "OpenAI",
    "input": 20,
    "output": 80,
    "cacheRead": null,
    "cacheWrite": null
  },
  {
    "match": [
      "o3-mini"
    ],
    "label": "OpenAI o3-mini",
    "vendor": "OpenAI",
    "input": 1.1,
    "output": 4.4,
    "cacheRead": 0.55,
    "cacheWrite": null
  },
  {
    "match": [
      "o3"
    ],
    "label": "OpenAI o3",
    "vendor": "OpenAI",
    "input": 2,
    "output": 8,
    "cacheRead": 0.5,
    "cacheWrite": null
  },
  {
    "match": [
      "o1-pro"
    ],
    "label": "OpenAI o1-pro",
    "vendor": "OpenAI",
    "input": 150,
    "output": 600,
    "cacheRead": null,
    "cacheWrite": null
  },
  {
    "match": [
      "o1"
    ],
    "label": "OpenAI o1",
    "vendor": "OpenAI",
    "input": 15,
    "output": 60,
    "cacheRead": 7.5,
    "cacheWrite": null
  },
  {
    "match": [
      "gpt-oss-120b"
    ],
    "label": "OpenAI gpt-oss-120b (hosted)",
    "vendor": "OpenAI",
    "input": 0.15,
    "output": 0.6,
    "cacheRead": 0.075,
    "cacheWrite": null,
    "confidence": "low",
    "note": "Open weights; hosted-inference list (Groq/Together/OpenRouter are all at or near this)."
  },
  {
    "match": [
      "gpt-oss-20b"
    ],
    "label": "OpenAI gpt-oss-20b (hosted)",
    "vendor": "OpenAI",
    "input": 0.075,
    "output": 0.3,
    "cacheRead": 0.0375,
    "cacheWrite": null,
    "confidence": "low",
    "note": "Open weights; hosted-inference list price."
  },
  {
    "match": [
      "gpt-"
    ],
    "label": "OpenAI (unlisted GPT model)",
    "vendor": "OpenAI",
    "input": null,
    "output": null,
    "cacheRead": null,
    "cacheWrite": null
  },
  {
    "match": [
      "claude-opus-5.5"
    ],
    "label": "Claude Opus 5.5",
    "vendor": "Anthropic",
    "input": 4,
    "output": 20,
    "cacheRead": 0.2,
    "cacheWrite": 5
  },
  {
    "match": [
      "claude-opus-5"
    ],
    "label": "Claude Opus 5",
    "vendor": "Anthropic",
    "input": 5,
    "output": 25,
    "cacheRead": 0.5,
    "cacheWrite": 6.25
  },
  {
    "match": [
      "claude-opus-4-8",
      "claude-opus-4.8"
    ],
    "label": "Claude Opus 4.8",
    "vendor": "Anthropic",
    "input": 5,
    "output": 25,
    "cacheRead": 0.5,
    "cacheWrite": 6.25
  },
  {
    "match": [
      "claude-opus-4-7",
      "claude-opus-4.7"
    ],
    "label": "Claude Opus 4.7",
    "vendor": "Anthropic",
    "input": 5,
    "output": 25,
    "cacheRead": 0.5,
    "cacheWrite": 6.25
  },
  {
    "match": [
      "claude-opus-4-6",
      "claude-opus-4.6"
    ],
    "label": "Claude Opus 4.6",
    "vendor": "Anthropic",
    "input": 5,
    "output": 25,
    "cacheRead": 0.5,
    "cacheWrite": 6.25
  },
  {
    "match": [
      "claude-opus-4-5",
      "claude-opus-4.5",
      "claude-opus-4-1",
      "claude-opus-4.1"
    ],
    "label": "Claude Opus 4.5 / 4.1",
    "vendor": "Anthropic",
    "input": 5,
    "output": 25,
    "cacheRead": 0.5,
    "cacheWrite": 6.25,
    "note": "Opus 4.1 launched at $15/$75 and was later repriced onto the $5/$25 line. If your logs predate Opus 4.5, expect the old rate."
  },
  {
    "match": [
      "claude-sonnet-5.5"
    ],
    "label": "Claude Sonnet 5.5",
    "vendor": "Anthropic",
    "input": 2,
    "output": 10,
    "cacheRead": 0.2,
    "cacheWrite": 2.5
  },
  {
    "match": [
      "claude-sonnet-5"
    ],
    "label": "Claude Sonnet 5",
    "vendor": "Anthropic",
    "input": 2,
    "output": 10,
    "cacheRead": 0.2,
    "cacheWrite": 2.5
  },
  {
    "match": [
      "claude-sonnet-4-6",
      "claude-sonnet-4.6"
    ],
    "label": "Claude Sonnet 4.6",
    "vendor": "Anthropic",
    "input": 3,
    "output": 15,
    "cacheRead": 0.3,
    "cacheWrite": 3.75
  },
  {
    "match": [
      "claude-sonnet-4-5",
      "claude-sonnet-4.5",
      "claude-sonnet-4"
    ],
    "label": "Claude Sonnet 4.5 / 4",
    "vendor": "Anthropic",
    "input": 3,
    "output": 15,
    "cacheRead": 0.3,
    "cacheWrite": 3.75
  },
  {
    "match": [
      "claude-haiku-4-5",
      "claude-haiku-4.5"
    ],
    "label": "Claude Haiku 4.5",
    "vendor": "Anthropic",
    "input": 1,
    "output": 5,
    "cacheRead": 0.1,
    "cacheWrite": 1.25
  },
  {
    "match": [
      "claude-fable-5.1",
      "claude-fable-5-1"
    ],
    "label": "Claude Fable 5.1",
    "vendor": "Anthropic",
    "input": 10,
    "output": 50,
    "cacheRead": 0.25,
    "cacheWrite": 12.5
  },
  {
    "match": [
      "claude-fable-5"
    ],
    "label": "Claude Fable 5",
    "vendor": "Anthropic",
    "input": 10,
    "output": 50,
    "cacheRead": 1,
    "cacheWrite": 12.5
  },
  {
    "match": [
      "claude-mythos"
    ],
    "label": "Claude Mythos",
    "vendor": "Anthropic",
    "input": 10,
    "output": 50,
    "cacheRead": 1,
    "cacheWrite": 12.5,
    "confidence": "low",
    "note": "Family listing. The preview snapshot has been quoted at $27.50/$137.50 by aggregators, so this row may understate real spend."
  },
  {
    "match": [
      "claude-3-5-haiku"
    ],
    "label": "Claude 3.5 Haiku",
    "vendor": "Anthropic",
    "input": 0.8,
    "output": 4,
    "cacheRead": 0.08,
    "cacheWrite": 1
  },
  {
    "match": [
      "claude-3-5-sonnet",
      "claude-3-7-sonnet"
    ],
    "label": "Claude 3.5 / 3.7 Sonnet",
    "vendor": "Anthropic",
    "input": 3,
    "output": 15,
    "cacheRead": 0.3,
    "cacheWrite": 3.75
  },
  {
    "match": [
      "claude-opus",
      "claude-sonnet",
      "claude-haiku"
    ],
    "label": "Claude (unlisted tier)",
    "vendor": "Anthropic",
    "input": null,
    "output": null,
    "cacheRead": null,
    "cacheWrite": null
  },
  {
    "match": [
      "gemini-3.8-flash"
    ],
    "label": "Gemini 3.8 Flash",
    "vendor": "Google",
    "input": 0.75,
    "output": 3.75,
    "cacheRead": 0.075,
    "cacheWrite": null,
    "note": "Introductory rate through 2026-12-31; doubles to $1.50 / $7.50 on 2027-01-01. Thinking tokens bill at the output rate. Cache STORAGE is billed separately (~$0.50 per 1M tokens per hour), which is why cacheWrite is null."
  },
  {
    "match": [
      "gemini-3.7-flash"
    ],
    "label": "Gemini 3.7 Flash",
    "vendor": "Google",
    "input": 0.75,
    "output": 3.75,
    "cacheRead": 0.075,
    "cacheWrite": null,
    "note": "Introductory rate through 2026-12-31; doubles on 2027-01-01."
  },
  {
    "match": [
      "gemini-3.6-flash"
    ],
    "label": "Gemini 3.6 Flash",
    "vendor": "Google",
    "input": 0.75,
    "output": 3.75,
    "cacheRead": 0.075,
    "cacheWrite": null,
    "note": "Introductory rate through 2026-12-31; doubles on 2027-01-01."
  },
  {
    "match": [
      "gemini-3.5-flash-lite"
    ],
    "label": "Gemini 3.5 Flash-Lite",
    "vendor": "Google",
    "input": 0.3,
    "output": 2.5,
    "cacheRead": 0.03,
    "cacheWrite": null
  },
  {
    "match": [
      "gemini-3.5-flash"
    ],
    "label": "Gemini 3.5 Flash",
    "vendor": "Google",
    "input": 1.5,
    "output": 9,
    "cacheRead": 0.15,
    "cacheWrite": null,
    "confidence": "low",
    "note": "Some trackers list a $0.30/$2.50 promotional rate for a 3.5 Flash snapshot; the current-generation rate is the one recorded here."
  },
  {
    "match": [
      "gemini-3.1-flash-lite"
    ],
    "label": "Gemini 3.1 Flash-Lite",
    "vendor": "Google",
    "input": 0.25,
    "output": 1.5,
    "cacheRead": 0.025,
    "cacheWrite": null
  },
  {
    "match": [
      "gemini-3.1-pro"
    ],
    "label": "Gemini 3.1 Pro",
    "vendor": "Google",
    "input": 2,
    "output": 12,
    "cacheRead": 0.2,
    "cacheWrite": null
  },
  {
    "match": [
      "gemini-3-flash"
    ],
    "label": "Gemini 3 Flash",
    "vendor": "Google",
    "input": 0.5,
    "output": 3,
    "cacheRead": 0.05,
    "cacheWrite": null
  },
  {
    "match": [
      "gemini-3-pro"
    ],
    "label": "Gemini 3 Pro",
    "vendor": "Google",
    "input": 1.6,
    "output": 9.6,
    "cacheRead": 0.16,
    "cacheWrite": null,
    "confidence": "low",
    "note": "Superseded by Gemini 3.1 Pro pricing; retained for older logs."
  },
  {
    "match": [
      "gemini-2.5-flash-lite"
    ],
    "label": "Gemini 2.5 Flash-Lite",
    "vendor": "Google",
    "input": 0.1,
    "output": 0.4,
    "cacheRead": 0.01,
    "cacheWrite": null
  },
  {
    "match": [
      "gemini-2.5-flash"
    ],
    "label": "Gemini 2.5 Flash",
    "vendor": "Google",
    "input": 0.3,
    "output": 2.5,
    "cacheRead": 0.03,
    "cacheWrite": null
  },
  {
    "match": [
      "gemini-2.5-pro"
    ],
    "label": "Gemini 2.5 Pro",
    "vendor": "Google",
    "input": 1.25,
    "output": 10,
    "cacheRead": 0.125,
    "cacheWrite": null
  },
  {
    "match": [
      "gemini-1.5",
      "gemini-2.0"
    ],
    "label": "Gemini (legacy generation)",
    "vendor": "Google",
    "input": null,
    "output": null,
    "cacheRead": null,
    "cacheWrite": null,
    "confidence": "low",
    "note": "Legacy rows not verified against the current price page."
  },
  {
    "match": [
      "gemini",
      "gemma"
    ],
    "label": "Gemini / Gemma (unlisted model)",
    "vendor": "Google",
    "input": null,
    "output": null,
    "cacheRead": null,
    "cacheWrite": null
  },
  {
    "match": [
      "qwen3.8-max"
    ],
    "label": "Qwen3.8 Max",
    "vendor": "Alibaba Qwen",
    "input": 2,
    "output": 6,
    "cacheRead": 0.25,
    "cacheWrite": 2.5,
    "note": "Official Model Studio International list (Singapore/HK), 0 < tokens <= 1M. China-region list is $1.65 / $4.951; China-region qwen3.8-max-prime is $3.301 / $9.902."
  },
  {
    "match": [
      "qwen3.7-max"
    ],
    "label": "Qwen3.7 Max",
    "vendor": "Alibaba Qwen",
    "input": 2.5,
    "output": 7.5,
    "cacheRead": 0.5,
    "cacheWrite": 3.125,
    "note": "Official International list (Singapore/HK), 0 < tokens <= 1M. China-region list is $1.65 / $4.951. Cache-hit is about 10% of input per Alibaba caching rules."
  },
  {
    "match": [
      "qwen3.6-max"
    ],
    "label": "Qwen3.6 Max Preview",
    "vendor": "Alibaba Qwen",
    "input": 1.3,
    "output": 7.8,
    "cacheRead": 0.13,
    "cacheWrite": 1.625,
    "note": "Official International tier 0 < tokens <= 128K; 128K-256K is $2.00 / $12.00."
  },
  {
    "match": [
      "qwen3-max"
    ],
    "label": "Qwen3 Max",
    "vendor": "Alibaba Qwen",
    "input": 1.2,
    "output": 6,
    "cacheRead": 0.12,
    "cacheWrite": 1.5,
    "note": "Official International tiered list, tier 0 < tokens <= 32K. 32K-128K is $2.40/$12.00; 128K-256K is $3.00/$15.00. Non-3 qwen-max is $1.60/$6.40."
  },
  {
    "match": [
      "qwen3.8-flash"
    ],
    "label": "Qwen3.8 Flash",
    "vendor": "Alibaba Qwen",
    "input": 0.15,
    "output": 0.47,
    "cacheRead": 0.016,
    "cacheWrite": 0.2
  },
  {
    "match": [
      "qwen3.7-flash"
    ],
    "label": "Qwen3.7 Flash",
    "vendor": "Alibaba Qwen",
    "input": 0.03,
    "output": 0.13,
    "cacheRead": 0.006,
    "cacheWrite": 0.038
  },
  {
    "match": [
      "qwen3.7-plus"
    ],
    "label": "Qwen3.7 Plus",
    "vendor": "Alibaba Qwen",
    "input": 0.4,
    "output": 1.6,
    "cacheRead": 0.04,
    "cacheWrite": 0.5,
    "confidence": "low",
    "note": "Global/HK list is $0.276 in / $1.101 out with night discounts; $0.40/$1.60 is the US/international tier. Regional pricing differs - verify per region."
  },
  {
    "match": [
      "qwen3.6-plus"
    ],
    "label": "Qwen3.6 Plus",
    "vendor": "Alibaba Qwen",
    "input": 0.5,
    "output": 3,
    "cacheRead": 0.05,
    "cacheWrite": 0.625
  },
  {
    "match": [
      "qwen3.6-flash"
    ],
    "label": "Qwen3.6 Flash",
    "vendor": "Alibaba Qwen",
    "input": 0.1875,
    "output": 1.125,
    "cacheRead": null,
    "cacheWrite": 0.234375
  },
  {
    "match": [
      "qwen3-coder-plus"
    ],
    "label": "Qwen3 Coder Plus",
    "vendor": "Alibaba Qwen",
    "input": 1,
    "output": 5,
    "cacheRead": 0.2,
    "cacheWrite": 1.25
  },
  {
    "match": [
      "qwen3-coder-flash"
    ],
    "label": "Qwen3 Coder Flash",
    "vendor": "Alibaba Qwen",
    "input": 0.3,
    "output": 1.5,
    "cacheRead": 0.06,
    "cacheWrite": 0.375
  },
  {
    "match": [
      "qwen3-coder-next"
    ],
    "label": "Qwen3 Coder Next",
    "vendor": "Alibaba Qwen",
    "input": 0.2,
    "output": 1.5,
    "cacheRead": null,
    "cacheWrite": null,
    "confidence": "low",
    "note": "Aggregator-listed (OpenRouter/Together); the Alibaba first-party list differs."
  },
  {
    "match": [
      "qwen3-coder"
    ],
    "label": "Qwen3 Coder 480B A35B",
    "vendor": "Alibaba Qwen",
    "input": 0.3,
    "output": 1,
    "cacheRead": 0.1,
    "cacheWrite": null,
    "confidence": "low",
    "note": "Open weights; this is the OpenRouter/public-endpoint list, not an Alibaba-hosted rate."
  },
  {
    "match": [
      "qwen3.5-plus"
    ],
    "label": "Qwen3.5 Plus",
    "vendor": "Alibaba Qwen",
    "input": 0.4,
    "output": 2.4,
    "cacheRead": null,
    "cacheWrite": null
  },
  {
    "match": [
      "qwen3.5-flash"
    ],
    "label": "Qwen3.5 Flash",
    "vendor": "Alibaba Qwen",
    "input": 0.1,
    "output": 0.4,
    "cacheRead": 0.01,
    "cacheWrite": 0.125
  },
  {
    "match": [
      "qwen3.5"
    ],
    "label": "Qwen3.5 (open weight, hosted)",
    "vendor": "Alibaba Qwen",
    "input": 0.26,
    "output": 2.08,
    "cacheRead": null,
    "cacheWrite": null,
    "confidence": "low",
    "note": "122B-A10B tier on OpenRouter; the smaller 3.5 models are far cheaper. Self-hosted Qwen has no vendor price."
  },
  {
    "match": [
      "qwen3-next"
    ],
    "label": "Qwen3 Next 80B A3B",
    "vendor": "Alibaba Qwen",
    "input": 0.1,
    "output": 1.1,
    "cacheRead": 0.07,
    "cacheWrite": null,
    "confidence": "low",
    "note": "Open weights; OpenRouter list."
  },
  {
    "match": [
      "qwen3-235b"
    ],
    "label": "Qwen3 235B A22B",
    "vendor": "Alibaba Qwen",
    "input": 0.0875,
    "output": 0.35,
    "cacheRead": 0.0175,
    "cacheWrite": null,
    "confidence": "low",
    "note": "Open weights (2507 instruct); OpenRouter list."
  },
  {
    "match": [
      "qwen3-32b",
      "qwen3-30b",
      "qwen3-14b",
      "qwen3-8b"
    ],
    "label": "Qwen3 small open weights (hosted)",
    "vendor": "Alibaba Qwen",
    "input": 0.08,
    "output": 0.28,
    "cacheRead": null,
    "cacheWrite": null,
    "confidence": "low",
    "note": "Open weights; hosted list varies widely by provider."
  },
  {
    "match": [
      "qwen-plus",
      "qwen-flash",
      "qwen-turbo"
    ],
    "label": "Qwen Plus / Flash / Turbo",
    "vendor": "Alibaba Qwen",
    "input": 0.115,
    "output": 0.287,
    "cacheRead": null,
    "cacheWrite": null,
    "confidence": "low",
    "note": "Official Global tier 0 < tokens <= 128K for qwen-plus; thinking-mode output is higher ($1.147). qwen-turbo is $0.05/$0.20."
  },
  {
    "match": [
      "qwq",
      "qvq"
    ],
    "label": "QwQ / QVQ (reasoning)",
    "vendor": "Alibaba Qwen",
    "input": 0.8,
    "output": 2.4,
    "cacheRead": null,
    "cacheWrite": null,
    "confidence": "low",
    "note": "QwQ Plus list; OpenRouter QwQ is $1.20/$1.20. Not confirmed on Alibaba current page."
  },
  {
    "match": [
      "qwen"
    ],
    "label": "Qwen (unlisted model)",
    "vendor": "Alibaba Qwen",
    "input": null,
    "output": null,
    "cacheRead": null,
    "cacheWrite": null
  },
  {
    "match": [
      "glm-5.3-flashx"
    ],
    "label": "GLM-5.3-FlashX",
    "vendor": "Zhipu GLM",
    "input": 0.37,
    "output": 1.25,
    "cacheRead": 0.075,
    "cacheWrite": null
  },
  {
    "match": [
      "glm-5.3-flash"
    ],
    "label": "GLM-5.3-Flash",
    "vendor": "Zhipu GLM",
    "input": 0.15,
    "output": 0.5,
    "cacheRead": 0.03,
    "cacheWrite": null
  },
  {
    "match": [
      "glm-5.3-prime"
    ],
    "label": "GLM-5.3 Prime",
    "vendor": "Zhipu GLM",
    "input": 2.8,
    "output": 8.8,
    "cacheRead": 0.56,
    "cacheWrite": null,
    "confidence": "low",
    "note": "Aggregator (OpenRouter) list; not on Z.AI own pricing page."
  },
  {
    "match": [
      "glm-5.3"
    ],
    "label": "GLM-5.3",
    "vendor": "Zhipu GLM",
    "input": 1.4,
    "output": 4.4,
    "cacheRead": 0.26,
    "cacheWrite": null
  },
  {
    "match": [
      "glm-5.2"
    ],
    "label": "GLM-5.2",
    "vendor": "Zhipu GLM",
    "input": 1.4,
    "output": 4.4,
    "cacheRead": 0.26,
    "cacheWrite": null
  },
  {
    "match": [
      "glm-5.1"
    ],
    "label": "GLM-5.1",
    "vendor": "Zhipu GLM",
    "input": 1.4,
    "output": 4.4,
    "cacheRead": 0.26,
    "cacheWrite": null
  },
  {
    "match": [
      "glm-5-turbo",
      "glm-5v-turbo"
    ],
    "label": "GLM-5 Turbo / 5V Turbo",
    "vendor": "Zhipu GLM",
    "input": 1.2,
    "output": 4,
    "cacheRead": 0.24,
    "cacheWrite": null,
    "confidence": "low",
    "note": "Aggregator list; models.dev quotes GLM-5V-Turbo at $5.00/$22.00, so treat this row as uncertain."
  },
  {
    "match": [
      "glm-5"
    ],
    "label": "GLM-5",
    "vendor": "Zhipu GLM",
    "input": 1,
    "output": 3.2,
    "cacheRead": 0.2,
    "cacheWrite": null
  },
  {
    "match": [
      "glm-4.7-flashx"
    ],
    "label": "GLM-4.7-FlashX",
    "vendor": "Zhipu GLM",
    "input": 0.07,
    "output": 0.4,
    "cacheRead": 0.01,
    "cacheWrite": null
  },
  {
    "match": [
      "glm-4.7-flash"
    ],
    "label": "GLM-4.7-Flash (free tier)",
    "vendor": "Zhipu GLM",
    "input": 0,
    "output": 0,
    "cacheRead": 0,
    "cacheWrite": null,
    "note": "Z.AI lists this as Free on the official pricing page. A 0 here means genuinely $0, not unknown."
  },
  {
    "match": [
      "glm-4.7"
    ],
    "label": "GLM-4.7",
    "vendor": "Zhipu GLM",
    "input": 0.6,
    "output": 2.2,
    "cacheRead": 0.11,
    "cacheWrite": null
  },
  {
    "match": [
      "glm-4.6v"
    ],
    "label": "GLM-4.6V",
    "vendor": "Zhipu GLM",
    "input": 0.3,
    "output": 0.9,
    "cacheRead": 0.055,
    "cacheWrite": null
  },
  {
    "match": [
      "glm-4.6"
    ],
    "label": "GLM-4.6",
    "vendor": "Zhipu GLM",
    "input": 0.6,
    "output": 2.2,
    "cacheRead": 0.11,
    "cacheWrite": null
  },
  {
    "match": [
      "glm-4.5-airx"
    ],
    "label": "GLM-4.5-AirX",
    "vendor": "Zhipu GLM",
    "input": 1.1,
    "output": 4.5,
    "cacheRead": 0.22,
    "cacheWrite": null
  },
  {
    "match": [
      "glm-4.5-air"
    ],
    "label": "GLM-4.5-Air",
    "vendor": "Zhipu GLM",
    "input": 0.2,
    "output": 1.1,
    "cacheRead": 0.03,
    "cacheWrite": null
  },
  {
    "match": [
      "glm-4.5-x"
    ],
    "label": "GLM-4.5-X",
    "vendor": "Zhipu GLM",
    "input": 2.2,
    "output": 8.9,
    "cacheRead": 0.45,
    "cacheWrite": null
  },
  {
    "match": [
      "glm-4.5v"
    ],
    "label": "GLM-4.5V",
    "vendor": "Zhipu GLM",
    "input": 0.6,
    "output": 1.8,
    "cacheRead": 0.11,
    "cacheWrite": null
  },
  {
    "match": [
      "glm-4.5"
    ],
    "label": "GLM-4.5",
    "vendor": "Zhipu GLM",
    "input": 0.6,
    "output": 2.2,
    "cacheRead": 0.11,
    "cacheWrite": null
  },
  {
    "match": [
      "glm-4.5-flash",
      "glm-4.6v-flash"
    ],
    "label": "GLM free tier (4.5 / 4.6V Flash)",
    "vendor": "Zhipu GLM",
    "input": 0,
    "output": 0,
    "cacheRead": 0,
    "cacheWrite": null,
    "note": "Z.AI lists these as Free on the official pricing page."
  },
  {
    "match": [
      "glm-4"
    ],
    "label": "GLM-4 (legacy)",
    "vendor": "Zhipu GLM",
    "input": 0.1,
    "output": 0.1,
    "cacheRead": null,
    "cacheWrite": null,
    "confidence": "low",
    "note": "GLM-4-32B-0414-128K is $0.10 flat on Z.AI page."
  },
  {
    "match": [
      "glm",
      "zai",
      "z-ai",
      "chatglm"
    ],
    "label": "GLM / Z.AI (unlisted model)",
    "vendor": "Zhipu GLM",
    "input": null,
    "output": null,
    "cacheRead": null,
    "cacheWrite": null
  },
  {
    "match": [
      "kimi-k3"
    ],
    "label": "Kimi K3",
    "vendor": "Moonshot Kimi",
    "input": 3,
    "output": 15,
    "cacheRead": 0.3,
    "cacheWrite": 3,
    "note": "Official USD. CNY list: CNY 20.00 input / CNY 100.00 output / CNY 2.00 cache-hit / CNY 20.00 cache-write at 5min TTL (CNY 40.00 at 1h TTL). At 1 USD = 7.1 CNY those are about $2.82 / $14.08 / $0.28 / $2.82. cacheWrite records the 5min TTL rate."
  },
  {
    "match": [
      "kimi-k2.7-code-highspeed"
    ],
    "label": "Kimi K2.7 Code HighSpeed",
    "vendor": "Moonshot Kimi",
    "input": 1.9,
    "output": 8,
    "cacheRead": 0.38,
    "cacheWrite": null,
    "note": "Official USD. CNY list: CNY 13.00 input / CNY 54.00 output / CNY 2.60 cache-hit (about $1.83 / $7.61 / $0.37)."
  },
  {
    "match": [
      "kimi-k2.7-code"
    ],
    "label": "Kimi K2.7 Code",
    "vendor": "Moonshot Kimi",
    "input": 0.95,
    "output": 4,
    "cacheRead": 0.19,
    "cacheWrite": null,
    "note": "Official USD. CNY list: CNY 6.50 input / CNY 27.00 output / CNY 1.30 cache-hit (about $0.92 / $3.80 / $0.18)."
  },
  {
    "match": [
      "kimi-k2.6"
    ],
    "label": "Kimi K2.6",
    "vendor": "Moonshot Kimi",
    "input": 0.95,
    "output": 4,
    "cacheRead": 0.16,
    "cacheWrite": null,
    "note": "Official USD. CNY list: CNY 6.50 input / CNY 27.00 output / CNY 1.10 cache-hit (about $0.92 / $3.80 / $0.15)."
  },
  {
    "match": [
      "kimi-k2.5"
    ],
    "label": "Kimi K2.5",
    "vendor": "Moonshot Kimi",
    "input": 0.6,
    "output": 3,
    "cacheRead": 0.1,
    "cacheWrite": null,
    "confidence": "low",
    "note": "Aggregator list (OpenRouter/Novita); no longer on Moonshot current official table."
  },
  {
    "match": [
      "kimi-k2-thinking",
      "kimi-k2-instruct",
      "kimi-k2-0905",
      "kimi-k2"
    ],
    "label": "Kimi K2 (base / thinking)",
    "vendor": "Moonshot Kimi",
    "input": 0.6,
    "output": 2.5,
    "cacheRead": 0.15,
    "cacheWrite": null,
    "confidence": "low",
    "note": "Aggregator list; officially superseded by K2.5 and later."
  },
  {
    "match": [
      "kimi"
    ],
    "label": "Kimi / Moonshot (unlisted model)",
    "vendor": "Moonshot Kimi",
    "input": null,
    "output": null,
    "cacheRead": null,
    "cacheWrite": null
  },
  {
    "match": [
      "grok-4.7"
    ],
    "label": "Grok 4.7",
    "vendor": "xAI",
    "input": 2,
    "output": 6,
    "cacheRead": 0.5,
    "cacheWrite": null
  },
  {
    "match": [
      "grok-4.6"
    ],
    "label": "Grok 4.6",
    "vendor": "xAI",
    "input": 2,
    "output": 6,
    "cacheRead": 0.5,
    "cacheWrite": null
  },
  {
    "match": [
      "grok-4.5"
    ],
    "label": "Grok 4.5",
    "vendor": "xAI",
    "input": 2,
    "output": 6,
    "cacheRead": 0.3,
    "cacheWrite": null
  },
  {
    "match": [
      "grok-4.3"
    ],
    "label": "Grok 4.3",
    "vendor": "xAI",
    "input": 1.25,
    "output": 2.5,
    "cacheRead": 0.2,
    "cacheWrite": null
  },
  {
    "match": [
      "grok-4.20",
      "grok-4-20"
    ],
    "label": "Grok 4.20",
    "vendor": "xAI",
    "input": 1.25,
    "output": 2.5,
    "cacheRead": 0.2,
    "cacheWrite": null,
    "confidence": "low",
    "note": "OpenRouter and LiteLLM list $1.25/$2.50; models.dev lists $2.00/$6.00 for the 4.20 snapshot. Conflict unresolved - verify in the xAI console."
  },
  {
    "match": [
      "grok-build"
    ],
    "label": "Grok Build 0.1",
    "vendor": "xAI",
    "input": 1,
    "output": 2,
    "cacheRead": 0.2,
    "cacheWrite": null
  },
  {
    "match": [
      "grok-code-fast"
    ],
    "label": "Grok Code Fast 1",
    "vendor": "xAI",
    "input": 1,
    "output": 2,
    "cacheRead": 0.2,
    "cacheWrite": null
  },
  {
    "match": [
      "grok-4-fast",
      "grok-4.1-fast"
    ],
    "label": "Grok 4 Fast / 4.1 Fast",
    "vendor": "xAI",
    "input": 0.2,
    "output": 0.5,
    "cacheRead": 0.05,
    "cacheWrite": null
  },
  {
    "match": [
      "grok-4"
    ],
    "label": "Grok 4",
    "vendor": "xAI",
    "input": 3,
    "output": 15,
    "cacheRead": 0.75,
    "cacheWrite": null
  },
  {
    "match": [
      "grok-3-mini"
    ],
    "label": "Grok 3 Mini",
    "vendor": "xAI",
    "input": 0.3,
    "output": 0.5,
    "cacheRead": 0.075,
    "cacheWrite": null
  },
  {
    "match": [
      "grok-3"
    ],
    "label": "Grok 3",
    "vendor": "xAI",
    "input": 3,
    "output": 15,
    "cacheRead": 0.75,
    "cacheWrite": null
  },
  {
    "match": [
      "grok",
      "x-ai"
    ],
    "label": "Grok / xAI (unlisted model)",
    "vendor": "xAI",
    "input": null,
    "output": null,
    "cacheRead": null,
    "cacheWrite": null
  },
  {
    "match": [
      "mistral-medium-3.5",
      "mistral-medium-2604",
      "mistral-medium-3-5"
    ],
    "label": "Mistral Medium 3.5",
    "vendor": "Mistral",
    "input": 1.5,
    "output": 7.5,
    "cacheRead": 0.15,
    "cacheWrite": null
  },
  {
    "match": [
      "codestral-2508",
      "codestral-latest",
      "codestral"
    ],
    "label": "Codestral",
    "vendor": "Mistral",
    "input": 0.3,
    "output": 0.9,
    "cacheRead": 0.03,
    "cacheWrite": null,
    "note": "Placed before the broad Mistral rows so the bare token codestral is not swallowed by the catch-all."
  },
  {
    "match": [
      "devstral-latest",
      "devstral-medium",
      "devstral-small",
      "devstral-2512",
      "devstral"
    ],
    "label": "Devstral",
    "vendor": "Mistral",
    "input": 0.4,
    "output": 2,
    "cacheRead": 0.04,
    "cacheWrite": null
  },
  {
    "match": [
      "pixtral-large"
    ],
    "label": "Pixtral Large",
    "vendor": "Mistral",
    "input": 2,
    "output": 6,
    "cacheRead": 0.2,
    "cacheWrite": null
  },
  {
    "match": [
      "pixtral"
    ],
    "label": "Pixtral 12B",
    "vendor": "Mistral",
    "input": 0.15,
    "output": 0.15,
    "cacheRead": null,
    "cacheWrite": null
  },
  {
    "match": [
      "ministral-3-14b",
      "ministral-14b"
    ],
    "label": "Ministral 3 14B",
    "vendor": "Mistral",
    "input": 0.2,
    "output": 0.2,
    "cacheRead": 0.02,
    "cacheWrite": null
  },
  {
    "match": [
      "ministral-3-8b",
      "ministral-8b"
    ],
    "label": "Ministral 3 8B",
    "vendor": "Mistral",
    "input": 0.15,
    "output": 0.15,
    "cacheRead": 0.015,
    "cacheWrite": null
  },
  {
    "match": [
      "ministral-3-3b",
      "ministral-3b"
    ],
    "label": "Ministral 3 3B",
    "vendor": "Mistral",
    "input": 0.1,
    "output": 0.1,
    "cacheRead": 0.01,
    "cacheWrite": null
  },
  {
    "match": [
      "voxtral"
    ],
    "label": "Voxtral Small",
    "vendor": "Mistral",
    "input": 0.1,
    "output": 0.3,
    "cacheRead": 0.01,
    "cacheWrite": null
  },
  {
    "match": [
      "mistral-large-3",
      "mistral-large-2512"
    ],
    "label": "Mistral Large 3",
    "vendor": "Mistral",
    "input": 0.5,
    "output": 1.5,
    "cacheRead": 0.05,
    "cacheWrite": null
  },
  {
    "match": [
      "mistral-large"
    ],
    "label": "Mistral Large 2.x",
    "vendor": "Mistral",
    "input": 2,
    "output": 6,
    "cacheRead": 0.2,
    "cacheWrite": null,
    "note": "Legacy Large (2407/2411) list is $2/$6; Large 3 (2512) is $0.50/$1.50."
  },
  {
    "match": [
      "mistral-medium"
    ],
    "label": "Mistral Medium 3 / 3.1",
    "vendor": "Mistral",
    "input": 0.4,
    "output": 2,
    "cacheRead": 0.04,
    "cacheWrite": null
  },
  {
    "match": [
      "mistral-small-4",
      "mistral-small-2603"
    ],
    "label": "Mistral Small 4",
    "vendor": "Mistral",
    "input": 0.15,
    "output": 0.6,
    "cacheRead": 0.015,
    "cacheWrite": null
  },
  {
    "match": [
      "mistral-small"
    ],
    "label": "Mistral Small 3.x",
    "vendor": "Mistral",
    "input": 0.1,
    "output": 0.3,
    "cacheRead": null,
    "cacheWrite": null
  },
  {
    "match": [
      "magistral-medium"
    ],
    "label": "Magistral Medium",
    "vendor": "Mistral",
    "input": 1.5,
    "output": 7.5,
    "cacheRead": 0.15,
    "cacheWrite": null,
    "confidence": "low",
    "note": "LiteLLM carries $1.50/$7.50 inherited from Medium 3.5; an older Magistral Medium list was $2/$5."
  },
  {
    "match": [
      "magistral-small"
    ],
    "label": "Magistral Small",
    "vendor": "Mistral",
    "input": 0.15,
    "output": 0.6,
    "cacheRead": 0.015,
    "cacheWrite": null,
    "confidence": "low",
    "note": "Inferred from the Small 3 line; not verified on Mistral current price page."
  },
  {
    "match": [
      "mistral-nemo",
      "open-mistral-nemo"
    ],
    "label": "Mistral Nemo",
    "vendor": "Mistral",
    "input": 0.15,
    "output": 0.15,
    "cacheRead": null,
    "cacheWrite": null
  },
  {
    "match": [
      "mixtral-8x22b",
      "open-mixtral-8x22b"
    ],
    "label": "Mixtral 8x22B",
    "vendor": "Mistral",
    "input": 2,
    "output": 6,
    "cacheRead": 0.2,
    "cacheWrite": null
  },
  {
    "match": [
      "mixtral-8x7b",
      "open-mixtral-8x7b"
    ],
    "label": "Mixtral 8x7B",
    "vendor": "Mistral",
    "input": 0.7,
    "output": 0.7,
    "cacheRead": null,
    "cacheWrite": null
  },
  {
    "match": [
      "open-mistral-7b",
      "mistral-7b"
    ],
    "label": "Mistral 7B",
    "vendor": "Mistral",
    "input": 0.25,
    "output": 0.25,
    "cacheRead": null,
    "cacheWrite": null
  },
  {
    "match": [
      "mistral",
      "mixtral"
    ],
    "label": "Mistral (unlisted model)",
    "vendor": "Mistral",
    "input": null,
    "output": null,
    "cacheRead": null,
    "cacheWrite": null
  },
  {
    "match": [
      "muse-spark-1.3-contributor"
    ],
    "label": "Meta Muse Spark 1.3 Contributor",
    "vendor": "Meta",
    "input": 0.1,
    "output": 0.2,
    "cacheRead": 0.002,
    "cacheWrite": null
  },
  {
    "match": [
      "muse-spark-1.3"
    ],
    "label": "Meta Muse Spark 1.3",
    "vendor": "Meta",
    "input": 1.25,
    "output": 4.25,
    "cacheRead": 0.15,
    "cacheWrite": null
  },
  {
    "match": [
      "muse-spark-1.2-contributor"
    ],
    "label": "Meta Muse Spark 1.2 Contributor",
    "vendor": "Meta",
    "input": 0.1,
    "output": 0.2,
    "cacheRead": 0.002,
    "cacheWrite": null
  },
  {
    "match": [
      "muse-spark-1.2"
    ],
    "label": "Meta Muse Spark 1.2",
    "vendor": "Meta",
    "input": 1.25,
    "output": 4.25,
    "cacheRead": 0.15,
    "cacheWrite": null
  },
  {
    "match": [
      "muse-spark-1.1"
    ],
    "label": "Meta Muse Spark 1.1",
    "vendor": "Meta",
    "input": 1.25,
    "output": 4.25,
    "cacheRead": 0.15,
    "cacheWrite": null
  },
  {
    "match": [
      "muse-"
    ],
    "label": "Meta Muse (unlisted)",
    "vendor": "Meta",
    "input": null,
    "output": null,
    "cacheRead": null,
    "cacheWrite": null
  },
  {
    "match": [
      "llama-4-maverick"
    ],
    "label": "Llama 4 Maverick (hosted)",
    "vendor": "Meta",
    "input": 0.2,
    "output": 0.8,
    "cacheRead": null,
    "cacheWrite": null,
    "confidence": "low",
    "note": "Open weights, no first-party API. OpenRouter list; Together ($0.27/$0.85) and Novita differ."
  },
  {
    "match": [
      "llama-4-scout"
    ],
    "label": "Llama 4 Scout (hosted)",
    "vendor": "Meta",
    "input": 0.1,
    "output": 0.3,
    "cacheRead": null,
    "cacheWrite": null,
    "confidence": "low",
    "note": "Open weights, no first-party API. OpenRouter list."
  },
  {
    "match": [
      "llama-3.3-70b"
    ],
    "label": "Llama 3.3 70B (hosted)",
    "vendor": "Meta",
    "input": 0.59,
    "output": 0.79,
    "cacheRead": null,
    "cacheWrite": null,
    "confidence": "low",
    "note": "Open weights. Groq list $0.59/$0.79, OpenRouter $0.10/$0.32, Together $1.04 flat. Provider-dependent."
  },
  {
    "match": [
      "llama-3.1-405b",
      "llama-3-405b"
    ],
    "label": "Llama 3.1 405B (hosted)",
    "vendor": "Meta",
    "input": 3,
    "output": 3,
    "cacheRead": null,
    "cacheWrite": null,
    "confidence": "low",
    "note": "Open weights; approximate hosted floor."
  },
  {
    "match": [
      "llama-3.1-8b",
      "llama-3-8b",
      "llama-3.2-1b",
      "llama-3.2-3b"
    ],
    "label": "Llama 3.x small (hosted)",
    "vendor": "Meta",
    "input": 0.05,
    "output": 0.08,
    "cacheRead": null,
    "cacheWrite": null,
    "confidence": "low",
    "note": "Open weights; Groq/OpenRouter small-model list."
  },
  {
    "match": [
      "llama-guard"
    ],
    "label": "Llama Guard (hosted)",
    "vendor": "Meta",
    "input": 0.2,
    "output": 0.2,
    "cacheRead": null,
    "cacheWrite": null,
    "confidence": "low",
    "note": "Open weights; safety classifier."
  },
  {
    "match": [
      "llama",
      "meta-llama"
    ],
    "label": "Meta Llama (unlisted, open weights)",
    "vendor": "Meta",
    "input": null,
    "output": null,
    "cacheRead": null,
    "cacheWrite": null
  },
  {
    "match": [
      "openrouter/"
    ],
    "label": "OpenRouter route (unpriced here)",
    "vendor": "OpenRouter",
    "input": null,
    "output": null,
    "cacheRead": null,
    "cacheWrite": null,
    "note": "OpenRouter routes at roughly provider list; look up the underlying model row above. Route-level terms and BYOK markups vary."
  },
  {
    "match": [
      "azure/"
    ],
    "label": "Azure OpenAI route (unpriced here)",
    "vendor": "Microsoft Azure",
    "input": null,
    "output": null,
    "cacheRead": null,
    "cacheWrite": null,
    "note": "Azure list is typically about 10% above OpenAI direct, with regional uplifts (EU around +10%)."
  },
  {
    "match": [
      "bedrock/"
    ],
    "label": "Amazon Bedrock route (unpriced here)",
    "vendor": "Amazon Bedrock",
    "input": null,
    "output": null,
    "cacheRead": null,
    "cacheWrite": null,
    "note": "Bedrock list varies by region and is often 10-20% above the Anthropic/OpenAI first-party rate."
  },
  {
    "match": [
      "vertex/"
    ],
    "label": "Google Vertex AI route (unpriced here)",
    "vendor": "Google Vertex AI",
    "input": null,
    "output": null,
    "cacheRead": null,
    "cacheWrite": null,
    "note": "Vertex list matches the Gemini developer API for the same model in most regions."
  },
  {
    "match": [
      "*"
    ],
    "label": "Unpriced / unknown model",
    "vendor": "Unknown",
    "input": null,
    "output": null,
    "cacheRead": null,
    "cacheWrite": null,
    "note": "Catch-all. Renders as unpriced instead of a wrong number. Add an explicit row above to price it."
  }
];

export const PRICING_ALIASES = {
  "autodl": "DeepSeek",
  "deepseek": "DeepSeek",
  "deepseek-official": "DeepSeek",
  "deepseek_api": "DeepSeek",
  "siliconflow": "DeepSeek",
  "volcengine": "DeepSeek",
  "ark": "DeepSeek",
  "aliyun": "Alibaba Qwen",
  "aliyun-dashscope": "Alibaba Qwen",
  "dashscope": "Alibaba Qwen",
  "bailian": "Alibaba Qwen",
  "modelstudio": "Alibaba Qwen",
  "model-studio": "Alibaba Qwen",
  "qwen": "Alibaba Qwen",
  "zai": "Zhipu GLM",
  "z-ai": "Zhipu GLM",
  "zhipu": "Zhipu GLM",
  "bigmodel": "Zhipu GLM",
  "moonshot": "Moonshot Kimi",
  "kimi": "Moonshot Kimi",
  "xai": "xAI",
  "grok": "xAI",
  "mistral": "Mistral",
  "mistralai": "Mistral",
  "meta": "Meta",
  "llama": "Meta",
  "meta-llama": "Meta",
  "openai": "OpenAI",
  "azure": "Microsoft Azure",
  "azure-openai": "Microsoft Azure",
  "azure_openai": "Microsoft Azure",
  "anthropic": "Anthropic",
  "claude": "Anthropic",
  "bedrock": "Amazon Bedrock",
  "aws-bedrock": "Amazon Bedrock",
  "aws_bedrock": "Amazon Bedrock",
  "google": "Google",
  "gemini": "Google",
  "vertex": "Google Vertex AI",
  "vertexai": "Google Vertex AI",
  "vertex-ai": "Google Vertex AI",
  "google-vertex": "Google Vertex AI",
  "openrouter": "OpenRouter",
  "open-router": "OpenRouter",
  "or": "OpenRouter",
  "groq": "Groq",
  "together": "Together AI",
  "togetherai": "Together AI",
  "fireworks": "Fireworks AI",
  "fireworks-ai": "Fireworks AI",
  "deepinfra": "DeepInfra",
  "novita": "Novita AI",
  "ollama": "Local / self-hosted",
  "lmstudio": "Local / self-hosted",
  "lm-studio": "Local / self-hosted",
  "vllm": "Local / self-hosted",
  "local": "Local / self-hosted"
};

export const PRICING_SOURCES = [
  "https://api-docs.deepseek.com/quick_start/pricing/",
  "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/",
  "https://developers.openai.com/api/docs/pricing",
  "https://claude.com/pricing#api",
  "https://platform.claude.com/docs/en/docs/about-claude/pricing",
  "https://ai.google.dev/gemini-api/docs/pricing",
  "https://blog.google/innovation-and-ai/models-and-research/gemini-models/3-8-flash-and-3-8-flash-cyber/",
  "https://apidog.com/blog/gemini-3-8-flash-pricing/",
  "https://www.alibabacloud.com/help/en/model-studio/model-pricing",
  "https://docs.z.ai/guides/overview/pricing",
  "https://platform.kimi.ai/docs/pricing/chat",
  "https://platform.kimi.com/docs/pricing/chat",
  "https://docs.x.ai/docs/models",
  "https://docs.mistral.ai/getting-started/models/models_overview/",
  "https://openrouter.ai/api/v1/models",
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
  "https://models.dev/api.json",
  "https://www.modellix.ai/blog/gpt-5-6-pricing/",
  "https://aws.amazon.com/bedrock/pricing/"
];
