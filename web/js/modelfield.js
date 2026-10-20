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

  // 数字正后方那片椭圆属于「读数区」：模型名不许进去，否则会被误读成
  // 「数字漏墨」（深色、浅色主题都实测出现了）。用重算坐标而不是 mask-image ——
  // 保持 app.css 里「零每帧滤镜」的既定取舍。
  const BLOCK = { cx: 0.5, cy: 0.42, rx: 0.34, ry: 0.2 };
  const blocked = (px, py) => {
    const dx = (px / 100 - BLOCK.cx) / BLOCK.rx;
    const dy = (py / 100 - BLOCK.cy) / BLOCK.ry;
    return dx * dx + dy * dy < 1;
  };

  shown.forEach((row, index) => {
    const name = row.model;
    const share = (row.total || 0) / maxTotal;

    const column = index % columns;
    const line = Math.floor(index / columns);
    const x = ((column + 0.08 + hashUnit(name, 'x') * 0.78) / columns) * 100;
    let y = ((line + 0.12 + hashUnit(name, 'y') * 0.7) / rowsCount) * 100;

    // 命中禁布区先在行带内重试（确定性，不引入 Math.random）。
    // 中间那几行的整条行带都落在数字上，重试也出不来 —— 这时抬到数字上方那片空白带。
    // 无论如何都**不丢弃**这个模型：「一个模型对应一个背景元素」是要守住的承诺。
    for (let attempt = 0; attempt < 4 && blocked(x, y); attempt += 1) {
      y = ((line + 0.55 + hashUnit(name, `y${attempt}`) * 0.42) / rowsCount) * 100;
    }
    if (blocked(x, y)) y = 2 + hashUnit(name, 'top') * 16;

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
    // （上限从 0.22 收到 0.16：原值让背景名在数字旁边已经开始抢注意力了）
    node.style.setProperty('--alpha', (0.07 + Math.sqrt(share) * 0.09).toFixed(3));
    node.style.setProperty('--dur', `${(22 + hashUnit(name, 'd') * 22).toFixed(1)}s`);
    node.style.setProperty('--delay', `${(-hashUnit(name, 'l') * 26).toFixed(1)}s`);
    node.style.setProperty('--dx', `${((hashUnit(name, 'dx') - 0.5) * 190).toFixed(0)}px`);
    node.style.setProperty('--dy', `${((hashUnit(name, 'dy') - 0.5) * 130).toFixed(0)}px`);
    // 不设 title：.modelfield 是 pointer-events: none，原生 tooltip 永远不会出现
    container.appendChild(node);
  });

  // 落位后再按**真实盒子**避让一次。锚点在左上角、名字往右延伸，只判断锚点是不够的：
  // 锚点落在禁布区之外的长名字（DEEPSEEK-V4.1-FLASH）照样会从右边一路伸到数字上。
  // 只在模型集合变化时跑一次（上面有 signature 短路），不是每帧。
  requestAnimationFrame(() => {
    const hero = container.closest('.hero');
    const digits = document.getElementById('odoTotal');
    if (!hero || !digits) return;
    const zone = digits.getBoundingClientRect();
    const box = hero.getBoundingClientRect();
    if (!zone.height || !box.height) return;
    for (const node of container.children) {
      const rect = node.getBoundingClientRect();
      const overlaps = rect.right > zone.left - 40 && rect.left < zone.right + 40
        && rect.bottom > zone.top - 10 && rect.top < zone.bottom + 10;
      if (!overlaps) continue;
      // 挪到数字与指标 chip 之间那条空白带，并压住字号上限，保证不压到上下两行
      const top = ((zone.bottom + 10 - box.top) / box.height) * 100;
      node.style.setProperty('--y', `${top.toFixed(1)}%`);
      if (Number(node.style.getPropertyValue('--scale')) > 1.6) {
        node.style.setProperty('--scale', '1.6');
      }
    }
  });
}

export function clearModelField(container) {
  if (!container) return;
  container.innerHTML = '';
  container.dataset.signature = '';
}
