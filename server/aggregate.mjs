/**
 * aggregate.mjs —— 原始 bucket 表 → 前端要的快照
 *
 * 唯一一次遍历 bucket 表，同时产出所有维度的汇总（总量 / 来源 / 供应商 / 模型 /
 * 项目 / 按天 / 按小时），顺带把费用算掉。价格按 (provider, model) 记忆化，
 * 所以几万个 bucket 也只做几百次匹配。
 *
 * 区间过滤（最近 N 天）也在这里做：bucket 的 key 第一位就是日期字符串，
 * 字典序比较即可，不用解析时间。
 */
import { parseKey, dayOffset, todayLocal, daysBetween, emptyHours } from './usage.mjs';
import { buildPriceTable, priceFor, costOf, formatMoney } from './pricing.mjs';

const SEP = '\u0001';

function blank() {
  return {
    total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
    requests: 0, usd: 0, pricedTokens: 0, unpricedTokens: 0,
  };
}

function addTo(target, usage, cost) {
  const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  target.total += total;
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
  target.reasoning += usage.reasoning;
  target.requests += usage.requests;
  target.usd += cost.usd;
  if (cost.priced) target.pricedTokens += total;
  else target.unpricedTokens += total;
  return target;
}

function bucketUsage(bucket) {
  return {
    input: bucket[0], output: bucket[1], cacheRead: bucket[2],
    cacheWrite: bucket[3], reasoning: bucket[4], requests: bucket[5],
  };
}

/** 价格记忆化：同一个 (provider|model) 只匹配一次。 */
function makePricer(table) {
  const cache = new Map();
  return (provider, model, usage) => {
    const key = `${provider}${SEP}${model}`;
    let price = cache.get(key);
    if (price === undefined) {
      price = priceFor(model, provider, table);
      cache.set(key, price);
    }
    return { price, cost: costOf(usage, price) };
  };
}

function finishGroup(entry, shareBase, config) {
  entry.share = shareBase > 0 ? entry.total / shareBase : 0;
  entry.cost = formatMoney(entry.usd, config);
  entry.usd = Number(entry.usd.toFixed(6));
  entry.cacheHitRate = entry.total > 0 ? entry.cacheRead / entry.total : 0;
  return entry;
}

export function aggregate({ raw, config, report, priceTable, rangeDays = 0, sources = null }) {
  const table = priceTable ?? buildPriceTable({ config });
  const pricer = makePricer(table);

  const totals = blank();
  const bySource = new Map();
  const byProvider = new Map();
  const byModel = new Map();
  const byProject = new Map();
  const byDay = new Map();
  const byDaySource = new Map();
  const hours = emptyHours();

  const today = todayLocal();
  const cutoff = rangeDays > 0 ? dayOffset(today, -(rangeDays - 1)) : null;

  const sourceMeta = new Map((report?.sources ?? []).map((s) => [s.id, s]));

  for (const [key, bucket] of Object.entries(raw.buckets)) {
    const parsed = parseKey(key);
    if (!parsed) continue; // 字段对不齐的 key（极端情况）直接跳过，不能算成某个模型
    if (cutoff && parsed.day < cutoff) continue;
    const usage = bucketUsage(bucket);
    const { price, cost } = pricer(parsed.provider, parsed.model, usage);
    addTo(totals, usage, cost);

    let src = bySource.get(parsed.source);
    if (!src) {
      const meta = sourceMeta.get(parsed.source);
      src = {
        id: parsed.source,
        label: meta?.label ?? parsed.source,
        accent: meta?.accent ?? '#8b98a5',
        vendor: meta?.vendor ?? '',
        ...blank(),
        models: new Set(),
        projects: new Set(),
      };
      bySource.set(parsed.source, src);
    }
    addTo(src, usage, cost);
    src.models.add(parsed.model);
    src.projects.add(parsed.project);

    let prov = byProvider.get(parsed.provider);
    if (!prov) {
      prov = { name: parsed.provider, ...blank(), models: new Set(), sources: new Set() };
      byProvider.set(parsed.provider, prov);
    }
    addTo(prov, usage, cost);
    prov.models.add(parsed.model);
    prov.sources.add(parsed.source);

    const modelKey = `${parsed.provider}${SEP}${parsed.model}`;
    let mod = byModel.get(modelKey);
    if (!mod) {
      mod = {
        model: parsed.model,
        provider: parsed.provider,
        ...blank(),
        sources: new Set(),
        projects: new Set(),
        price: price
          ? {
            label: price.label ?? parsed.model,
            vendor: price.vendor ?? '',
            input: price.input ?? null,
            output: price.output ?? null,
            cacheRead: price.cacheRead ?? null,
            cacheWrite: price.cacheWrite ?? null,
            layer: price.layer,
            confidence: price.confidence ?? null,
          }
          : null,
      };
      byModel.set(modelKey, mod);
    }
    addTo(mod, usage, cost);
    mod.sources.add(parsed.source);
    mod.projects.add(parsed.project);

    let proj = byProject.get(parsed.project);
    if (!proj) {
      proj = { project: parsed.project, ...blank(), models: new Set(), sources: new Set(), firstDay: parsed.day, lastDay: parsed.day };
      byProject.set(parsed.project, proj);
    }
    addTo(proj, usage, cost);
    proj.models.add(parsed.model);
    proj.sources.add(parsed.source);
    if (parsed.day < proj.firstDay) proj.firstDay = parsed.day;
    if (parsed.day > proj.lastDay) proj.lastDay = parsed.day;

    let day = byDay.get(parsed.day);
    if (!day) {
      day = { day: parsed.day, ...blank() };
      byDay.set(parsed.day, day);
    }
    addTo(day, usage, cost);

    const daySourceKey = `${parsed.day}${SEP}${parsed.source}`;
    let ds = byDaySource.get(daySourceKey);
    if (!ds) {
      ds = { day: parsed.day, source: parsed.source, total: 0, usd: 0 };
      byDaySource.set(daySourceKey, ds);
    }
    ds.total += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    ds.usd += cost.usd;
  }

  // 小时分布同样要跟着日期过滤走，否则「最近 7 天」和「全部」会长得一模一样
  if (cutoff) {
    for (const [day, dayHours] of Object.entries(raw.hoursByDay ?? {})) {
      if (day < cutoff) continue;
      for (let i = 0; i < 24; i += 1) hours[i] += dayHours[i] ?? 0;
    }
  } else {
    for (let i = 0; i < 24; i += 1) hours[i] = raw.hours?.[i] ?? 0;
  }

  // ── 补齐连续日期轴，图表不能断 ────────────────────────────────
  const dayKeys = [...byDay.keys()].sort();
  let axisFrom = cutoff ?? (dayKeys[0] ?? today);
  let axisTo = today;
  if (dayKeys.length > 0) {
    if (!cutoff) axisFrom = dayKeys[0];
    axisTo = dayKeys[dayKeys.length - 1] > today ? dayKeys[dayKeys.length - 1] : today;
  }
  const span = Math.max(0, daysBetween(axisFrom, axisTo)) + 1;
  // 超过一年就不逐日补齐了，避免图表被稀释
  const cap = 400;
  const dayList = [];
  if (span <= cap) {
    for (let i = 0; i < span; i += 1) {
      const day = dayOffset(axisFrom, i);
      const entry = byDay.get(day);
      dayList.push(entry
        ? finishGroup({ ...entry }, 0, config)
        : finishGroup({ day, ...blank() }, 0, config));
    }
  } else {
    for (const day of dayKeys) dayList.push(finishGroup({ ...byDay.get(day) }, 0, config));
  }

  const maxDayTotal = dayList.reduce((max, d) => Math.max(max, d.total), 0);

  // ── 各维度收尾与排序 ─────────────────────────────────────────
  const sourceList = [...bySource.values()].map((entry) => {
    const meta = sourceMeta.get(entry.id);
    const reportRow = meta ?? {};
    return finishGroup({
      ...entry,
      models: entry.models.size,
      projects: [...entry.projects].length,
      enabled: meta?.enabled ?? true,
      kind: meta?.kind ?? 'local',
      description: meta?.description ?? '',
      note: meta?.note ?? '',
      roots: meta?.roots ?? [],
      detectedFiles: reportRow.files ?? 0,
      detectedBytes: reportRow.bytes ?? 0,
      errors: reportRow.errors ?? 0,
      available: (reportRow.files ?? 0) > 0,
      extra: raw.extra?.[entry.id] ?? null,
      warnings: (raw.external?.warnings ?? []).filter((text) => meta?.label && text.startsWith(meta.label)),
    }, totals.total, config);
  }).sort((a, b) => b.total - a.total);

  // 没有数据的来源也要出现在列表里（让用户看到「这个源我扫了但没数据」）
  for (const spec of report?.sources ?? []) {
    if (sourceList.some((entry) => entry.id === spec.id)) continue;
    sourceList.push(finishGroup({
      id: spec.id, label: spec.label, accent: spec.accent, vendor: spec.vendor,
      ...blank(), models: 0, projects: 0, enabled: spec.enabled,
      kind: spec.kind ?? 'local',
      description: spec.description, note: spec.note, roots: spec.roots ?? [],
      detectedFiles: spec.files ?? 0, detectedBytes: spec.bytes ?? 0,
      errors: spec.errors ?? 0, available: (spec.files ?? 0) > 0,
      extra: raw.extra?.[spec.id] ?? null,
      warnings: (raw.external?.warnings ?? []).filter((text) => spec.label && text.startsWith(spec.label)),
    }, totals.total, config));
  }

  const providerList = [...byProvider.values()]
    .map((entry) => finishGroup({ ...entry, models: entry.models.size, sources: [...entry.sources] }, totals.total, config))
    .sort((a, b) => b.total - a.total);

  const modelList = [...byModel.values()]
    .map((entry) => finishGroup({
      ...entry,
      sources: [...entry.sources],
      projects: [...entry.projects].length,
    }, totals.total, config))
    .sort((a, b) => b.total - a.total);

  const projectList = [...byProject.values()]
    .map((entry) => finishGroup({ ...entry, models: entry.models.size, sources: [...entry.sources] }, totals.total, config))
    .sort((a, b) => b.total - a.total);

  // ── 未定价的模型：必须明确告诉用户，而不是静默按 0 算 ────────
  const unpriced = modelList
    .filter((entry) => !entry.price && entry.total > 0)
    .map((entry) => ({
      model: entry.model,
      provider: entry.provider,
      total: entry.total,
      share: entry.share,
      requests: entry.requests,
    }));

  const dates = dayList.map((d) => d.day);
  const meta = {
    range: {
      from: dates[0] ?? today,
      to: dates[dates.length - 1] ?? today,
      days: dates.length,
      filteredDays: rangeDays,
    },
    activeDays: dayList.filter((d) => d.total > 0).length,
    firstTs: raw.firstTs ?? 0,
    lastTs: raw.lastTs ?? 0,
    priceTable: {
      revision: table.entries.length,
      asOf: table.meta?.pricesAsOf ?? null,
      currency: table.meta?.currency ?? 'USD',
      remote: table.remoteMeta,
      overrides: Object.keys(config?.pricing?.overrides ?? {}).length,
    },
    unpriced,
    unpricedTokens: totals.unpricedTokens,
  };

  totals.cost = formatMoney(totals.usd, config);
  totals.usd = Number(totals.usd.toFixed(6));
  totals.projects = projectList.length;
  totals.models = modelList.length;
  totals.providers = providerList.length;
  totals.sessions = raw.sessions ?? 0;
  totals.files = raw.files ?? 0;
  totals.bytes = raw.bytes ?? 0;
  totals.cacheHitRate = totals.total > 0 ? totals.cacheRead / totals.total : 0;
  totals.outputShare = totals.total > 0 ? totals.output / totals.total : 0;
  totals.cachedShare = totals.total > 0 ? (totals.cacheRead + totals.cacheWrite) / totals.total : 0;
  totals.avgPerRequest = totals.requests > 0 ? totals.total / totals.requests : 0;
  totals.avgPerDay = meta.activeDays > 0 ? totals.total / meta.activeDays : 0;
  totals.costPerRequest = totals.requests > 0 ? totals.usd / totals.requests : 0;
  totals.pricedShare = totals.total > 0 ? totals.pricedTokens / totals.total : 0;

  return {
    generatedAt: Date.now(),
    totals,
    bySource: sourceList,
    // 刻意**不截断**：一旦 slice，ΣbyModel / ΣbyProject 就不再等于 totals.total，
    // 自检的不变量会失效，用户看到的维度之和也会和总数对不上。
    // 展示层（前端 renderRank 的 limit）负责限制行数。
    byProvider: providerList,
    byModel: modelList,
    byProject: projectList,
    byDay: dayList,
    byDaySource: [...byDaySource.values()].map((entry) => ({ ...entry, usd: Number(entry.usd.toFixed(6)) })),
    hours,
    maxDayTotal,
    recent: (raw.recent ?? []).slice(0, 120),
    extra: raw.extra ?? {},
    meta,
    scan: report
      ? {
        reason: report.reason,
        startedAt: report.startedAt,
        finishedAt: report.finishedAt,
        durationMs: report.durationMs,
        files: report.files,
        parsedFiles: report.parsedFiles,
        resumedFiles: report.resumedFiles ?? 0,
        resumeBytes: report.resumeBytes ?? 0,
        reusedFiles: report.reusedFiles,
        totalBytes: report.totalBytes,
        parsedBytes: report.parsedBytes,
        workerCount: report.workerCount,
        usedWorkers: report.usedWorkers,
        errors: report.errors,
      }
      : null,
    sourcesReport: report?.sources ?? [],
    environment: report?.environment ?? null,
  };
}

export { buildPriceTable, priceFor, formatMoney };
