# 价格表怎么改

`price-table.json` 是**唯一数据源**，直接手改就行。

## 改完必做

```bash
node tools/build-pricing.mjs
```

它会生成 `server/pricing-data.mjs`（运行时直接 import，不依赖 fs 或 JSON import 断言）。
然后刷新界面即可 —— **不需要重扫日志**，因为缓存里存的是 token 数，费用是读取时才算的。

## 结构

```jsonc
{
  "pricesAsOf": "2026-09-30",
  "models": [
    {
      "match": ["gpt-5.6-terra"],      // 小写子串；文件里自上而下首个命中生效
      "label": "OpenAI GPT-5.6 Terra",
      "input": 2,                       // USD / 1M tokens
      "output": 12,
      "cacheRead": 0.2,                 // 缓存命中单价；null = 厂商不单独定价
      "cacheWrite": 2.5,                // 缓存写入单价；null 同上
      "vendor": "OpenAI",
      "confidence": "low",              // 可选：来源不够权威时标注
      "note": "长上下文档位、批量折扣等未折算的边界写这里"
    }
  ],
  "aliases": { "autodl": "DeepSeek" },  // 日志里的 provider 名 → 厂商
  "sources": ["https://..."]
}
```

## 三条硬规则

1. **数组顺序即优先级。** 具体型号必须排在家族前缀之前
   （`gpt-5.6-terra` → `gpt-5.6` → `gpt-5` → `gpt-`），最后一条是 `{"match": ["*"]}` 兜底。
2. **查不到就不写，不要猜。** 单价填 `null` 的条目会被当作「未定价」，
   界面会明确显示它占总量的比例。按 0 计算比不知道更糟 —— 那会让人误以为免费。
3. **`input` 的口径是「非缓存输入」。** 带缓存字段的平台在 `server/usage.mjs` 里已经归一过，
   这里填的单价与各平台官方定价页的对应关系是：`input` = 未命中缓存的那个价格，
   `cacheRead` = 缓存命中的价格。

## 覆盖优先级

内置表 < OpenRouter 实时同步 < 设置界面里的「自定义覆盖」。

第三方分发商（各类 API 中转）的折扣价无法自动获取，请用自定义覆盖填。
