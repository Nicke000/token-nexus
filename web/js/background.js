/**
 * background.js —— 背景粒子场
 * 纯 canvas，无依赖。粒子缓慢漂移 + 邻近连线 + 底部扫描网格，
 * 页面隐藏时自动停帧（省电），prefers-reduced-motion 时整体禁用。
 */
export function startField(canvas, { enabled = true } = {}) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!enabled || reduced) {
    canvas.style.display = 'none';
    return { stop() {} };
  }

  const ctx = canvas.getContext('2d', { alpha: true });
  let width = 0;
  let height = 0;
  let dpr = 1;
  let particles = [];
  let raf = 0;
  let running = true;
  let pointer = { x: -1e4, y: -1e4 };
  let frameTick = 0;
  let gridLayer = null;

  const COLORS = ['76, 201, 240', '167, 139, 250', '52, 211, 153'];

  function resize() {
    // 后备缓冲区按 0.7 倍分辨率绘制，再由 CSS 铺满视口：
    // 这是氛围层（.55 不透明度 + 模糊般的星点），放大看不出来，
    // 但整屏像素少了 ~50%，而"每帧都在重绘一整屏"正是它最贵的地方。
    const scale = Math.min(window.devicePixelRatio || 1, 1.5) * 0.7;
    dpr = scale;
    // 注意：clientWidth / clientHeight 是**只读**的，赋值会抛 TypeError
    // （曾经这一行让整个 init() 提前中断 → 整页白屏）。canvas 的 CSS 尺寸由
    // position:fixed; inset:0 负责，这里只负责后备缓冲区的像素尺寸。
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.max(1, Math.floor(width * scale));
    canvas.height = Math.max(1, Math.floor(height * scale));
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    // 粒子数上限从 96 降到 64：连线是 O(n²)，点本身也吃填充率
    const target = Math.round(Math.min(64, Math.max(24, (width * height) / 34000)));
    particles = new Array(target).fill(0).map(() => ({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.16,
      vy: (Math.random() - 0.5) * 0.16,
      r: Math.random() * 1.5 + 0.5,
      c: COLORS[Math.floor(Math.random() * COLORS.length)],
      p: Math.random() * Math.PI * 2,
    }));
    // 网格只在尺寸变化时重建一次
    gridLayer = buildGridLayer();
  }

  /**
   * 背景网格是**静态**的：一次性画进离屏画布，之后每帧只 blit 一次。
   * 原来每帧要 stroke 20 条横线 + 50 多条透视射线 —— 上百次描边，是这一层最贵的部分。
   * 代价是网格不再横向缓缓漂移（原来 5px/s，眼睛基本看不出），换掉是划算的。
   */
  function buildGridLayer() {
    const off = document.createElement('canvas');
    off.width = Math.max(1, Math.floor(width * dpr));
    off.height = Math.max(1, Math.floor(height * dpr));
    const g = off.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const spacing = 46;
    const y0 = height * 0.62;
    g.strokeStyle = 'rgba(76, 201, 240, 0.055)';
    g.lineWidth = 1;
    g.beginPath();
    for (let y = y0; y < height; y += spacing) {
      g.moveTo(0, y);
      g.lineTo(width, y);
    }
    const vanish = { x: width / 2, y: y0 - 120 };
    for (let x = -width; x < width * 2; x += spacing * 2) {
      g.moveTo(vanish.x, vanish.y);
      g.lineTo(x, height);
    }
    g.stroke();
    return off;
  }

  function frame() {
    if (!running) return;
    // 氛围层每 3 帧画一次（约 20fps）：粒子每帧只走 0.16px，肉眼完全看不出差别，
    // 但这一层每帧都在变 —— 它一帧不变，页面就不用为它重新合成一整屏。
    frameTick = (frameTick + 1) % 3;
    if (frameTick !== 0) {
      raf = requestAnimationFrame(frame);
      return;
    }
    ctx.clearRect(0, 0, width, height);
    if (gridLayer) ctx.drawImage(gridLayer, 0, 0, width, height);

    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.p += 0.01;
      if (p.x < -20) p.x = width + 20;
      if (p.x > width + 20) p.x = -20;
      if (p.y < -20) p.y = height + 20;
      if (p.y > height + 20) p.y = -20;
    }

    // 星点：按「颜色 + 是否靠近指针」分组，每组一次路径一次 fill。
    // 原来每颗粒子都是独立的 beginPath/arc/fill —— 64 次填充变成最多 6 次。
    const groups = new Map();
    for (const p of particles) {
      const dx = p.x - pointer.x;
      const dy = p.y - pointer.y;
      const near = dx * dx + dy * dy < 22000;
      const key = `${p.c}|${near ? 1 : 0}`;
      let group = groups.get(key);
      if (!group) {
        group = { color: p.c, near, list: [] };
        groups.set(key, group);
      }
      group.list.push(p);
    }
    for (const group of groups.values()) {
      const grow = group.near ? 0.6 : 0;
      ctx.fillStyle = `rgba(${group.color}, ${group.near ? 0.85 : 0.42})`;
      ctx.beginPath();
      for (const p of group.list) {
        const r = p.r + grow;
        ctx.moveTo(p.x + r, p.y);
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      }
      ctx.fill();
    }

    // 邻近连线：O(n²)，但按「颜色 × 透明度档」归并后只有十几次 stroke，
    // 而不是每条线都 stroke 一次（这是原来这一层最大的开销）。
    const BUCKETS = 4;
    const links = new Map();
    for (let i = 0; i < particles.length; i += 1) {
      const a = particles[i];
      for (let j = i + 1; j < particles.length; j += 1) {
        const b = particles[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dist = dx * dx + dy * dy;
        if (dist > 20000) continue;
        const bucket = Math.min(BUCKETS - 1, Math.floor(((1 - dist / 20000)) * BUCKETS));
        const key = `${a.c}|${bucket}`;
        let path = links.get(key);
        if (!path) {
          path = { color: a.c, alpha: ((bucket + 0.5) / BUCKETS) * 0.14, segs: [] };
          links.set(key, path);
        }
        path.segs.push([a.x, a.y, b.x, b.y]);
      }
    }
    ctx.lineWidth = 0.6;
    for (const path of links.values()) {
      ctx.strokeStyle = `rgba(${path.color}, ${path.alpha})`;
      ctx.beginPath();
      for (const [x1, y1, x2, y2] of path.segs) {
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
      }
      ctx.stroke();
    }

    // 鼠标附近的短促脉冲
    if (pointer.x > -1000) {
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(76, 201, 240, 0.22)';
      ctx.lineWidth = 1;
      ctx.arc(pointer.x, pointer.y, 26 + Math.sin(Date.now() / 420) * 4, 0, Math.PI * 2);
      ctx.stroke();
    }

    raf = requestAnimationFrame(frame);
  }

  function onPointerMove(event) {
    pointer = { x: event.clientX, y: event.clientY };
  }
  function onPointerLeave() {
    pointer = { x: -1e4, y: -1e4 };
  }
  function onVisibility() {
    const shouldRun = !document.hidden;
    if (shouldRun && !running) {
      running = true;
      raf = requestAnimationFrame(frame);
    } else if (!shouldRun && running) {
      running = false;
      cancelAnimationFrame(raf);
    }
  }

  let resizeTimer = 0;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 180);
  };

  resize();
  raf = requestAnimationFrame(frame);
  window.addEventListener('resize', onResize);
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('pointerleave', onPointerLeave);
  document.addEventListener('visibilitychange', onVisibility);

  return {
    stop() {
      running = false;
      cancelAnimationFrame(raf);
      clearTimeout(resizeTimer);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerleave', onPointerLeave);
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
