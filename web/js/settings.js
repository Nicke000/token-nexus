/**
 * settings.js —— 设置抽屉
 * 五个页签：显示 / 数据源 / 价格表 / 云 API / 关于
 * 所有改动都写回 ~/.token-nexus/config.json（密钥永不回显明文）。
 */
import * as api from './api.js';
import { bytes, dateTime, timeAgo, full, compact } from './format.js';
const $ = (id) => document.getElementById(id);

const ctx = { state: null, refresh: () => {}, toast: () => {}, term: () => {} };
let current = null;

function row(label, desc, control, extraClass = '') {
  const node = document.createElement('div');
  node.className = `field-row ${extraClass}`;
  const text = document.createElement('label');
  text.innerHTML = `<span class="field-k">${label}</span>${desc ? `<span class="field-d">${desc}</span>` : ''}`;
  node.appendChild(text);
  if (control) node.appendChild(control);
  return node;
}

function switchControl(on, onChange) {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = `switch${on ? ' is-on' : ''}`;
  node.setAttribute('role', 'switch');
  node.setAttribute('aria-checked', String(on));
  node.addEventListener('click', () => {
    const next = !node.classList.contains('is-on');
    node.classList.toggle('is-on', next);
    node.setAttribute('aria-checked', String(next));
    onChange(next);
  });
  return node;
}

function inputControl(value, { type = 'text', width = '220px', placeholder = '', onCommit } = {}) {
  const node = document.createElement('input');
  node.type = type;
  node.value = value ?? '';
  node.placeholder = placeholder;
  node.style.width = width;
  if (type === 'number') node.style.width = '110px';
  node.addEventListener('change', () => onCommit?.(node.value));
  node.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { node.blur(); onCommit?.(node.value); }
  });
  return node;
}

async function save(patch, { note = '已保存', reloadForm = true } = {}) {
  try {
    const result = await api.saveConfig(patch);
    current = result.config;
    ctx.state.config = result.config;
    applyTheme(result.config);
    ctx.toast(note, 'ok');
    if (reloadForm) renderPanes();
    ctx.refresh({ silent: true });
    return true;
  } catch (error) {
    ctx.toast(`保存失败：${error.message}`, 'error');
    return false;
  }
}

function applyTheme(config) {
  // 只认 dark / light；老配置里的 nebula / violet 等一律归到 dark
  const theme = config?.ui?.theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  document.body.classList.toggle('no-particles', config?.ui?.particles === false);
  document.body.classList.toggle('no-motion', Boolean(config?.ui?.reducedMotion));
}

/* ────────────────────────── 各页签 ────────────────────────── */

function paneDisplay() {
  const section = document.createElement('section');
  section.dataset.pane = 'display';

  section.appendChild(Object.assign(document.createElement('div'), {
    className: 'section-title', textContent: '单位与汇率',
  }));

  const currency = document.createElement('select');
  currency.innerHTML = '<option value="USD">美元 USD</option><option value="CNY">人民币 CNY</option>';
  currency.value = current?.displayCurrency ?? 'USD';
  currency.addEventListener('change', () => save({ displayCurrency: currency.value }, { note: '货币已切换' }));
  section.appendChild(row('展示货币', '费用按此货币显示（价格表原始单位是 USD）', currency));

  section.appendChild(row('汇率', '1 USD 兑多少 CNY，仅用于换算展示', inputControl(current?.fxRate ?? 7.15, {
    type: 'number', onCommit: (value) => save({ fxRate: Number(value) || 7.15 }, { note: '汇率已更新' }),
  })));

  section.appendChild(Object.assign(document.createElement('div'), {
    className: 'section-title', textContent: '外观与性能',
  }));

  const theme = document.createElement('select');
  theme.innerHTML = `
    <option value="dark">深色 · 赛博未来（霓虹辉光）</option>
    <option value="light">浅色 · 清爽专业（柔和投影）</option>`;
  theme.value = current?.ui?.theme === 'light' ? 'light' : 'dark';
  theme.addEventListener('change', () => {
    document.documentElement.dataset.theme = theme.value;
    ctx.state.field?.stop();
    if (theme.value === 'dark' && current?.ui?.particles !== false) {
      // 让 app.js 侧重新拉起粒子场：整页重渲染最省事，也不会留下半状态
      window.location.reload();
      return;
    }
    save({ ui: { theme: theme.value } }, { note: '主题已切换', reloadForm: false });
  });
  section.appendChild(row('配色主题', '深色为霓虹赛博风，浅色为干净印刷风', theme));

  section.appendChild(row('背景粒子场', '仅深色主题生效；关闭可显著降低 GPU 占用', switchControl(current?.ui?.particles !== false, (on) => {
    save({ ui: { particles: on } }, { note: on ? '粒子场已开启' : '粒子场已关闭', reloadForm: false });
    if (!on) ctx.state.field?.stop();
    else window.location.reload();
  })));

  section.appendChild(row('关闭动画', '勾选后所有过渡与粒子立即停止（无障碍）', switchControl(Boolean(current?.ui?.reducedMotion), (on) => save({ ui: { reducedMotion: on } }, { note: on ? '动画已关闭' : '动画已开启', reloadForm: false }))));

  section.appendChild(row('开机自检动画', '每次打开页面播放的启动序列', switchControl(current?.ui?.boot !== false, (on) => save({ ui: { boot: on } }, { note: '下次打开生效', reloadForm: false }))));

  section.appendChild(row('扫描并行度', 'worker 线程数；留空或 0 = 自动（CPU 核数-1，上限 8）', inputControl(current?.workers ?? 0, {
    type: 'number', onCommit: (value) => save({ workers: Number(value) || 0 }, { note: '并行度已更新' }),
  })));

  section.appendChild(row('前端刷新间隔', '毫秒。每这么久拉一次快照；数据没变不会重绘', inputControl(current?.refreshMs ?? 5000, {
    type: 'number', onCommit: (value) => save({ refreshMs: Math.max(1000, Number(value) || 5000) }, { note: '刷新间隔已更新（下次打开生效）', reloadForm: false }),
  })));

  section.appendChild(row('服务端保鲜窗口', '毫秒。超过此时长，下次读快照会在后台做一次增量重扫', inputControl(current?.cacheTtlMs ?? 5000, {
    type: 'number', onCommit: (value) => save({ cacheTtlMs: Math.max(1000, Number(value) || 5000) }, { note: '保鲜窗口已更新' }),
  })));

  section.appendChild(row('启动时打开浏览器', '双击 start.bat 时是否自动打开页面', switchControl(current?.openBrowser !== false, (on) => save({ openBrowser: on }, { note: '下次启动生效', reloadForm: false }))));

  return section;
}

function paneSources() {
  const section = document.createElement('section');
  section.dataset.pane = 'sources';
  section.appendChild(Object.assign(document.createElement('div'), {
    className: 'section-title', textContent: '本机数据源',
  }));
  section.appendChild(Object.assign(document.createElement('p'), {
    className: 'hint',
    innerHTML: '全部为自动发现，不写死任何人的路径。这里看到的目录就是当前实际探测到的结果（<code>●</code> 存在 / <code>○</code> 不存在）。要接入别的工具，把一个装 JSONL 的目录加到「自定义 JSONL」里即可。',
  }));

  for (const source of state_sources().local ?? []) {
    const card = document.createElement('div');
    card.style.margin = '14px 0 4px';

    const head = document.createElement('div');
    head.className = 'field-row';
    head.innerHTML = `<label><span class="field-k">${source.label}</span><span class="field-d">${source.description}</span></label>`;
    head.appendChild(switchControl(source.enabled !== false, (on) => save({ sources: { [source.id]: { enabled: on } } }, { note: `${source.label} 已${on ? '启用' : '停用'}`, reloadForm: false })));
    card.appendChild(head);

    const textarea = document.createElement('textarea');
    textarea.style.minHeight = '84px';
    textarea.value = (source.paths ?? []).join('\n');
    textarea.spellcheck = false;
    textarea.addEventListener('change', () => {
      const paths = textarea.value.split('\n').map((line) => line.trim()).filter(Boolean);
      save({ sources: { [source.id]: { paths } } }, { note: `${source.label} 路径已更新`, reloadForm: false });
    });
    card.appendChild(textarea);

    const status = document.createElement('div');
    status.className = 'hint';
    status.style.marginTop = '6px';
    status.innerHTML = (source.exists ?? []).map((entry) => `${entry.exists ? '●' : '○'} <code>${entry.path}</code>`).join('<br>');
    card.appendChild(status);

    section.appendChild(card);
  }
  return section;
}

function panePricing() {
  const section = document.createElement('section');
  section.dataset.pane = 'pricing';

  section.appendChild(Object.assign(document.createElement('div'), {
    className: 'section-title', textContent: '价格表',
  }));
  const snapshot = ctx.state.snapshot;
  const table = snapshot?.meta?.priceTable;
  section.appendChild(Object.assign(document.createElement('p'), {
    className: 'hint',
    innerHTML: `内置 <code>${table?.revision ?? '?'}</code> 个供应商／型号规则，基准日 <code>2026-09-30</code>。`
      + (table?.remote
        ? `已同步 OpenRouter 实时价：<b>${table.remote.count}</b> 个模型（${timeAgo(table.remote.fetchedAt)}）。`
        : '尚未同步 OpenRouter 实时价。')
      + '<br>改价格<strong>不需要重扫日志</strong> —— 缓存里存的是 token 数，费用是读取时算的。',
  }));

  const actions = document.createElement('div');
  actions.className = 'drawer__actions';

  const syncBtn = document.createElement('button');
  syncBtn.className = 'btn';
  syncBtn.textContent = '同步 OpenRouter 实时价';
  syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true;
    syncBtn.textContent = '同步中…';
    try {
      const result = await api.syncPricing({ force: true });
      ctx.toast(`已同步 ${result.models} 个模型价格`, 'ok');
      ctx.state.snapshot = null;
      ctx.refresh({ silent: true }).then(renderPanes);
    } catch (error) {
      ctx.toast(`同步失败：${error.message}`, 'error', 6000);
    } finally {
      syncBtn.disabled = false;
      syncBtn.textContent = '同步 OpenRouter 实时价';
    }
  });
  actions.appendChild(syncBtn);

  const exportCsv = document.createElement('a');
  exportCsv.className = 'btn';
  exportCsv.href = api.withToken('/api/export?format=csv');
  exportCsv.textContent = '导出 CSV';
  actions.appendChild(exportCsv);

  const exportJson = document.createElement('a');
  exportJson.className = 'btn';
  exportJson.href = api.withToken('/api/export?format=json');
  exportJson.textContent = '导出 JSON';
  actions.appendChild(exportJson);

  section.appendChild(actions);

  // 覆盖表
  section.appendChild(Object.assign(document.createElement('div'), {
    className: 'section-title', textContent: '自定义覆盖（最高优先级）',
  }));
  section.appendChild(Object.assign(document.createElement('p'), {
    className: 'hint',
    innerHTML: 'JSON：键是匹配子串（不区分大小写），值可以是 <code>{input,output,cacheRead,cacheWrite,label}</code> 或 <code>{disabled:true}</code>。'
      + '单价单位 = USD / 100 万 tokens。填 <code>null</code> 表示该条不计价。',
  }));

  const editor = document.createElement('textarea');
  editor.value = JSON.stringify(current?.pricing?.overrides ?? {}, null, 2);
  editor.spellcheck = false;
  editor.addEventListener('change', () => {
    try {
      const parsed = JSON.parse(editor.value || '{}');
      save({ pricing: { overrides: parsed } }, { note: '价格覆盖已保存', reloadForm: false });
    } catch (error) {
      ctx.toast(`JSON 格式错误：${error.message}`, 'error', 6000);
    }
  });
  section.appendChild(editor);

  // 实际用到的模型及其生效价格
  section.appendChild(Object.assign(document.createElement('div'), {
    className: 'section-title', textContent: '日志里实际出现的模型与生效单价',
  }));

  const wrap = document.createElement('div');
  wrap.style.maxHeight = '320px';
  wrap.style.overflow = 'auto';
  wrap.style.border = '1px solid var(--line)';
  wrap.style.borderRadius = 'var(--radius)';

  const rows = snapshot?.byModel ?? [];
  if (rows.length === 0) {
    wrap.innerHTML = '<div class="empty">还没有扫描到模型数据</div>';
  } else {
    const tableEl = document.createElement('table');
    tableEl.className = 'price';
    tableEl.innerHTML = `
      <thead><tr><th>模型</th><th class="num">输入</th><th class="num">输出</th><th class="num">缓存读</th><th>来源</th></tr></thead>
      <tbody>${rows.map((row) => {
        const price = row.price;
        const layer = price?.layer === 'override' ? '自定义' : price?.layer === 'remote' ? '实时' : price ? '内置' : '未定价';
        const flag = price?.confidence === 'low' ? ' (低置信)' : '';
        return `<tr title="${row.provider} · ${full(row.total)} tokens · ${row.cost.text}">
          <td>${row.model}</td>
          <td class="num">${price?.input ?? '—'}</td>
          <td class="num">${price?.output ?? '—'}</td>
          <td class="num">${price?.cacheRead ?? '—'}</td>
          <td>${layer}${flag}</td>
        </tr>`;
      }).join('')}</tbody>`;
    wrap.appendChild(tableEl);
  }
  section.appendChild(wrap);

  section.appendChild(Object.assign(document.createElement('div'), {
    className: 'section-title', textContent: '价格表出处',
  }));
  section.appendChild(Object.assign(document.createElement('p'), {
    className: 'hint',
    innerHTML: '完整来源清单见仓库里的 <code>tools/pricing/price-table.json</code> 的 <code>sources</code> 字段；'
      + '改完跑 <code>node tools/build-pricing.mjs</code> 重新生成运行时表。'
      + '<br>注意：长上下文档位、批量折扣、DeepSeek 的错峰半价、Gemini 的限时特价都<strong>没有</strong>折算进去，每条规则的 note 里写了。',
  }));

  return section;
}

function paneApi() {
  const section = document.createElement('section');
  section.dataset.pane = 'api';

  section.appendChild(Object.assign(document.createElement('p'), {
    className: 'hint',
    innerHTML: '云连接器是<strong>可选补充</strong>：不填密钥就完全跳过，一个网络请求都不发，软件仍然 100% 可用（本机日志已经是最细的来源）。'
      + '<br>密钥只存在 <code>~/.token-nexus/config.json</code>，不会回显、不会入库。',
  }));

  const connectors = ctx.state.snapshot?.connectors?.available?.length
    ? ctx.state.snapshot.connectors.available
    : (ctx.state.sources?.cloud ?? []);
  const apiConfig = current?.api ?? {};

  for (const spec of connectors) {
    const key = spec.id.replace('-api', '');
    const conf = apiConfig[key] ?? {};
    const card = document.createElement('div');
    card.style.margin = '16px 0 6px';

    const head = document.createElement('div');
    head.className = 'field-row';
    head.innerHTML = `<label><span class="field-k">${spec.label}</span><span class="field-d">${spec.description}</span></label>`;
    head.appendChild(switchControl(Boolean(conf.enabled), (on) => save({ api: { [key]: { enabled: on } } }, { note: `${spec.label} 已${on ? '启用' : '停用'}`, reloadForm: false })));
    card.appendChild(head);

    const secretKey = key === 'openai' || key === 'anthropic' ? 'adminKey' : 'apiKey';
    card.appendChild(row('密钥', `当前：${conf[secretKey.replace(/Key$/, '') + 'KeySet'] ? `已设置 ${conf[secretKey.replace(/Key$/, '') + 'KeyHint'] ?? ''}` : '未设置'}（留空 = 不改动）`,
      inputControl('', { type: 'password', width: '240px', placeholder: '粘贴新密钥以覆盖', onCommit: (value) => save({ api: { [key]: { [secretKey]: value } } }, { note: `${spec.label} 密钥已更新`, reloadForm: true }) })));

    card.appendChild(row('接口地址', '自建反代 / 代理时改这里', inputControl(conf.baseUrl ?? '', {
      width: '240px', onCommit: (value) => save({ api: { [key]: { baseUrl: value } } }, { note: '地址已更新', reloadForm: false }),
    })));

    if (key === 'openai') {
      card.appendChild(row('组织 ID', '可选，多组织账号时需要', inputControl(conf.organization ?? '', {
        width: '240px', onCommit: (value) => save({ api: { openai: { organization: value } } }, { note: '组织已更新', reloadForm: false }),
      })));
    }

    if (spec.docs) {
      const link = document.createElement('p');
      link.className = 'hint';
      link.innerHTML = `接口文档：<a href="${spec.docs}" target="_blank" rel="noreferrer noopener">${spec.docs}</a>`;
      card.appendChild(link);
    }
    section.appendChild(card);
  }

  const warnings = ctx.state.snapshot?.connectors?.warnings ?? [];
  if (warnings.length > 0) {
    const box = document.createElement('div');
    box.className = 'section-title';
    box.textContent = '连接器提示';
    section.appendChild(box);
    section.appendChild(Object.assign(document.createElement('p'), {
      className: 'hint', innerHTML: warnings.map((text) => `· ${text}`).join('<br>'),
    }));
  }

  return section;
}

function paneAbout() {
  const section = document.createElement('section');
  section.dataset.pane = 'about';
  const snapshot = ctx.state.snapshot;
  const scan = snapshot?.scan;
  const env = snapshot?.environment ?? ctx.state.sources?.environment ?? {};

  const facts = [
    ['平台', `${env.platform ?? '?'} · ${env.arch ?? '?'}`],
    ['Node', env.node ?? '?'],
    ['本机用户目录', env.home ?? '?'],
    ['配置文件', ctx.state.configPath ?? '?'],
    ['缓存目录', ctx.state.health?.cache?.path ?? '?'],
    ['缓存条目', `${ctx.state.health?.cache?.entries ?? 0} 个文件 · 索引 ${bytes(ctx.state.health?.cache?.cacheBytes ?? 0)}`],
    ['上次扫描', scan ? `${dateTime(scan.finishedAt)}（${timeAgo(scan.finishedAt)}）` : '—'],
    ['扫描耗时', scan ? `${(scan.durationMs / 1000).toFixed(1)}s（解析 ${scan.parsedFiles} / 复用 ${scan.reusedFiles}）` : '—'],
    ['worker', scan ? `${scan.workerCount} 个（${scan.usedWorkers ? '多线程' : '单线程退化'}）` : '—'],
    ['数据量', scan ? `${scan.files} 文件 · ${bytes(scan.totalBytes)} 原始日志` : '—'],
  ];

  const list = document.createElement('div');
  list.innerHTML = facts.map(([key, value]) => row(key, String(value), null).outerHTML).join('');
  section.appendChild(list);

  const actions = document.createElement('div');
  actions.className = 'drawer__actions';

  const clearBtn = document.createElement('button');
  clearBtn.className = 'btn';
  clearBtn.textContent = '清空解析缓存';
  clearBtn.addEventListener('click', async () => {
    if (!window.confirm('清空缓存后，下次扫描需要重新解析全部日志（首扫约 30 秒）。继续？')) return;
    try {
      await api.clearCache();
      ctx.toast('缓存已清空，下次扫描将全量重解析', 'ok');
      ctx.state.snapshot = null;
      ctx.refresh({ silent: true }).then(renderPanes);
    } catch (error) {
      ctx.toast(`清空失败：${error.message}`, 'error');
    }
  });
  actions.appendChild(clearBtn);

  const rescan = document.createElement('button');
  rescan.className = 'btn btn--primary';
  rescan.textContent = '忽略缓存全量重扫';
  rescan.addEventListener('click', async () => {
    actions.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      await api.startScan({ force: true });
      ctx.toast('已启动全量重扫，进度见左侧「扫描遥测」', 'ok', 5000);
      close();
    } catch (error) {
      ctx.toast(`启动失败：${error.message}`, 'error');
    } finally {
      actions.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    }
  });
  actions.appendChild(rescan);
  section.appendChild(actions);

  section.appendChild(Object.assign(document.createElement('div'), {
    className: 'section-title', textContent: '隐私',
  }));
  section.appendChild(Object.assign(document.createElement('p'), {
    className: 'hint',
    innerHTML: '所有解析都在本机完成，服务只监听 <code>127.0.0.1</code>。'
      + '本软件不发送任何日志内容；只有在你主动配置了云 API 密钥并启用后，才会向对应厂商的官方接口请求用量汇总。'
      + '<br>Cursor 数据库以只读方式打开，不做任何写入。',
  }));

  return section;
}

/* ────────────────────────── 抽屉装配 ────────────────────────── */

function state_sources() {
  return ctx.state.sources ?? { local: [], cloud: [] };
}

const PANES = {
  display: paneDisplay,
  sources: paneSources,
  pricing: panePricing,
  api: paneApi,
  about: paneAbout,
};

let activeTab = 'display';

function renderPanes() {
  const host = $('drawerPanes');
  const pane = PANES[activeTab]();
  pane.classList.add('is-active');
  host.innerHTML = '';
  host.appendChild(pane);
}

function open() {
  $('drawer').classList.add('is-open');
  $('drawer').setAttribute('aria-hidden', 'false');
  renderPanes();
}

function close() {
  $('drawer').classList.remove('is-open');
  $('drawer').setAttribute('aria-hidden', 'true');
}

export const mountSettings = {
  open,
  close,
  setup(context) {
    Object.assign(ctx, context);
    $('drawer').addEventListener('click', (event) => {
      if (event.target.closest('[data-close]')) close();
    });
    $('drawerTabs').addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      for (const sibling of $('drawerTabs').children) sibling.classList.remove('is-active');
      button.classList.add('is-active');
      activeTab = button.dataset.tab;
      renderPanes();
    });
  },
  apply(config) {
    current = config;
    applyTheme(config);
  },
  refresh: renderPanes,
};
