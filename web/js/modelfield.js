/**
 * modelfield.js —— 模型名背景场
 *
 * 把「实际用到的每个模型」在背景里各飘一个名字：一个模型一个元素，多个模型多个元素。
 * 用量越大的模型字号越大，所以背景本身就反映了用量结构 —— 一眼能看出主力模型。
 *
 * 设计约束：
 *   · 位置 / 漂移 / 延迟全部由模型名的哈希决定 —— 重绘时不会乱跳（不能用 Math.random）；
 *   · 抖动网格铺开，避免十几个名字挤成一团；
 *   · 每个模型一个颜色（--ghost-0 ~ --ghost-9，按排行轮换，前十个绝不重色），
 *     颜色变量本身分深/浅两套主题，所以 .model-ghost 的 var() 引用会自动跟着主题换色；
 *   · 透明度压到 0.05~0.12，它是氛围不是内容，绝不能影响读数；
 *   · 纯 CSS 动画，没有 rAF 循环，所以不占主线程。
 */

/** 背景配色数量，必须与 app.css 里的 --ghost-N 定义数量一致。 */
const GHOST_COLORS = 10;

/** FNV-1a 哈希 → [0,1)。同一个模型名永远得到同一组参数。 */
function hashUnit(text, salt = '') {
  let h = 2166136261;
  const source = `${text}${salt}`;
  for (let i = 0; i < source.length; i += 1) {
    h ^= source.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/** 展示名去掉常见的厂商前缀，背景里更干净 */
function displayName(model) {
  const text = String(model ?? '').trim();
  if (text === '') return 'unknown';
  return text.replace(/^[a-z0-9_.-]+\//i, '');
}

export function renderModelField(container, models) {
  if (!container) return;
  const rows = (models ?? []).filter((row) => row?.model);
  const signature = rows.map((row) => row.model).join('|');
  if (container.dataset.signature === signature) return; // 模型集合没变就不重建
  container.dataset.signature = signature;
  container.innerHTML = '';
  if (rows.length === 0) return;

  // 上限只是为了防止极端情况刷屏；正常十个二十个模型全部都会显示
  const shown = rows.slice(0, 40);
  const maxTotal = Math.max(...shown.map((row) => row.total || 0), 1);

  // 抖动网格：保证铺得开又不重叠得太厉害
  const columns = Math.ceil(Math.sqrt(shown.length));
  const rowsCount = Math.ceil(shown.length / columns);

  shown.forEach((row, index) => {
    const name = row.model;
    const share = (row.total || 0) / maxTotal;

    const column = index % columns;
    const line = Math.floor(index / columns);
    const x = ((column + 0.08 + hashUnit(name, 'x') * 0.78) / columns) * 100;
    const y = ((line + 0.12 + hashUnit(name, 'y') * 0.7) / rowsCount) * 100;

    const node = document.createElement('span');
    node.className = 'model-ghost';
    node.textContent = displayName(name);
    node.style.setProperty('--x', `${x.toFixed(2)}%`);
    node.style.setProperty('--y', `${y.toFixed(2)}%`);
    // 每个模型一个颜色：按用量排行轮换调色板。写到 --ghost-color 里的是一层
    // var() 引用，配色本体在 CSS 里按主题定义 —— 切主题不需要重绘背景场。
    node.style.setProperty('--ghost-color', `var(--ghost-${index % GHOST_COLORS})`);
    // 用量占比映射到字号：1.0 ~ 3.2 倍（15px → 最大 48px）
    node.style.setProperty('--scale', (1 + Math.sqrt(share) * 2.2).toFixed(2));
    // 越大的模型越显眼，但要压在"看得见但不抢读数"的区间
    node.style.setProperty('--alpha', (0.09 + Math.sqrt(share) * 0.13).toFixed(3));
    node.style.setProperty('--dur', `${(22 + hashUnit(name, 'd') * 22).toFixed(1)}s`);
    node.style.setProperty('--delay', `${(-hashUnit(name, 'l') * 26).toFixed(1)}s`);
    node.style.setProperty('--dx', `${((hashUnit(name, 'dx') - 0.5) * 190).toFixed(0)}px`);
    node.style.setProperty('--dy', `${((hashUnit(name, 'dy') - 0.5) * 130).toFixed(0)}px`);
    node.title = `${name} · ${(row.total || 0).toLocaleString('en-US')} tokens`;
    container.appendChild(node);
  });
}

export function clearModelField(container) {
  if (!container) return;
  container.innerHTML = '';
  container.dataset.signature = '';
}
