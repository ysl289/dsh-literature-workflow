/* 知识卡片关系网 —— 渲染与交互
   读图三条约定（其余一律不加）：
   1. 点 = 一张卡，大小 = 关系条数，颜色 = 书架
   2. 线 = 一条关系，箭头指向被提到的卡，颜色 = 关系类型
   3. 虚线 = 并列关系（互补/对立），实线 = 结构关系（前置/应用于/上位/下位）
*/
const G = /*__DATA__*/null;
const IS3D = G.mode === '3d';
const TAU = Math.PI * 2;

const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const stage = document.getElementById('stage');
const statusEl = document.getElementById('status');
const panel = document.getElementById('panel');
const legendEl = document.getElementById('legend');
const typesEl = document.getElementById('types');
const COLORS = G.colors || {};

const TYPE_COLORS = {
  '前置': '#ba7517', '应用于': '#185fa5', '上位': '#534ab7',
  '下位': '#7f77dd', '互补': '#1d9e75', '对立': '#e24b4a', '相关': '#8f8574',
};
const SOFT = {'互补': 1, '对立': 1, '相关': 1};
// 左栏一行里的极短释义，让人不用打开说明就知道这类关系在说什么
const TYPE_GLOSS = {
  '前置': '依赖', '应用于': '被用', '上位': '从属',
  '下位': '包含', '互补': '并列', '对立': '相斥', '相关': '相关',
};
// 右侧清单：从「这张卡」的立场说一句白话
const OUT_GLOSS = {
  '前置': '它以对方为前提', '应用于': '它被用在对方那里',
  '上位': '它归在对方门下', '下位': '它把对方收在门下',
  '互补': '它与对方互为侧面', '对立': '它与对方互相反驳', '相关': '它与对方有关',
};
const IN_GLOSS = {
  '前置': '对方以它为前提', '应用于': '对方把它用上了',
  '上位': '对方归在它门下', '下位': '对方把它收在门下',
  '互补': '对方与它互为侧面', '对立': '对方与它互相反驳', '相关': '对方与它有关',
};
const INVERSE = { '前置': '应用于', '应用于': '前置', '上位': '下位', '下位': '上位' };

function typeColor(t) { return TYPE_COLORS[t] || '#8f8574'; }
function hexA(hex, a) {
  const h = String(hex || '#8f8574').replace('#', '');
  const n = h.length === 3 ? h.split('').map(function (c) { return c + c; }).join('') : h;
  const r = parseInt(n.slice(0, 2), 16) || 0;
  const g = parseInt(n.slice(2, 4), 16) || 0;
  const b = parseInt(n.slice(4, 6), 16) || 0;
  return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
}

/* ---------------------------------------------------------------- 数据 */
const nodes = G.nodes.map(function (n) {
  return {
    id: n.id, zh: n.zh, en: n.en, shelf: n.shelf, form: n.form, status: n.status,
    conf: n.conf, school: n.school, tags: n.tags, def: n.def, src: n.src, shot: !!n.shot,
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, deg: 0, out: 0, inc: 0,
    sx: 0, sy: 0, s: 1, depth: 0, r: 10,
  };
});
const byId = {};
nodes.forEach(function (n) { byId[n.id] = n; });
const edges = G.edges.filter(function (e) { return byId[e.s] && byId[e.t]; });
edges.forEach(function (e, i) {
  byId[e.s].deg++; byId[e.s].out++;
  byId[e.t].deg++; byId[e.t].inc++;
  e.phase = (i * 0.37) % 1;
});
nodes.forEach(function (n) { n.r = 10 + Math.min(n.deg, 8) * 2.5; });

const shelfNames = Object.keys(COLORS).filter(function (s) {
  return nodes.some(function (n) { return n.shelf === s; });
});
const typeNames = (function () {
  const seen = {};
  edges.forEach(function (e) { seen[e.label] = (seen[e.label] || 0) + 1; });
  const order = Object.keys(TYPE_COLORS);
  return Object.keys(seen).sort(function (a, b) {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
})();
const isolated = nodes.filter(function (n) { return n.deg === 0; });

/* ---------------------------------------------------------------- 状态 */
const activeShelves = new Set(shelfNames);
const activeTypes = new Set(typeNames);
let showLabels = true, showTerr = !IS3D;
const view = {k: 1, x: 0, y: 0};
const cam = {yaw: 0.62, pitch: -0.3, zoom: 1, ox: 0, oy: 0, auto: false};
let alpha = 1, dragging = null, rotating = null, panning = null;
let clock = 0;
let hover = null, sel = null, moved = 0, raf = null;
let fitPass = 2;   // 自动取景两次：先框住，停稳后再微调一次
const FOCAL = 1150;

let W = 0, H = 0, dpr = 1;

function visible(n) { return !!n && activeShelves.has(n.shelf); }
function edgeShown(e) {
  return activeTypes.has(e.label) && visible(byId[e.s]) && visible(byId[e.t]);
}

function resize() {
  dpr = window.devicePixelRatio || 1;
  W = cv.clientWidth; H = cv.clientHeight;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  draw();
}

/* ---------------------------------------------------------------- 布局 */
function seed() {
  fitPass = 2;
  const groups = {};
  nodes.forEach(function (n) { (groups[n.shelf] = groups[n.shelf] || []).push(n); });
  const keys = Object.keys(groups);
  keys.forEach(function (s, si) {
    const g = groups[s];
    g.forEach(function (n, i) {
      const u = (i + 0.5) / g.length;
      if (IS3D) {
        const phi = (si / keys.length) * TAU + u * 1.3;
        const th = Math.acos(1 - 2 * u) * 0.9 + 0.2;
        const R = 380;
        n.x = Math.sin(th) * Math.cos(phi) * R;
        n.y = Math.cos(th) * R * 0.85;
        n.z = Math.sin(th) * Math.sin(phi) * R;
      } else {
        const a = (si / keys.length) * TAU - Math.PI / 2 + (u - 0.5) * 0.55;
        n.x = Math.cos(a) * Math.min(W, H) * 0.3;
        n.y = Math.sin(a) * Math.min(W, H) * 0.3;
        n.z = 0;
      }
      n.vx = 0; n.vy = 0; n.vz = 0;
    });
  });
  alpha = 1;
  wake(1);
}

function step() {
  // 力只在全部节点之间算，与「现在显示哪几架」无关：
  // 筛选只改可见性，绝不重排——否则你点一下书架，整张图的方位就变了，越看越糊涂
  const act = nodes;
  const REP = IS3D ? 330000 : 5600;
  const REST = IS3D ? 190 : 176;
  const SPR = 0.013, GRAV = IS3D ? 0.0035 : 0.006, DAMP = 0.87;
  const COH = IS3D ? 0.012 : 0.011;

  for (let i = 0; i < act.length; i++) {
    for (let j = i + 1; j < act.length; j++) {
      const a = act[i], b = act[j];
      let dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      let d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; dz = Math.random() - 0.5; d2 = 1; }
      const d = Math.sqrt(d2);
      const f = REP / d2 * alpha;
      const ux = dx / d, uy = dy / d, uz = dz / d;
      a.vx -= ux * f; a.vy -= uy * f; a.vz -= uz * f;
      b.vx += ux * f; b.vy += uy * f; b.vz += uz * f;
    }
  }
  edges.forEach(function (e) {
    const a = byId[e.s], b = byId[e.t];
    if (!visible(a) || !visible(b)) return;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const f = (d - REST) * SPR * alpha;
    const ux = dx / d, uy = dy / d, uz = dz / d;
    a.vx += ux * f; a.vy += uy * f; a.vz += uz * f;
    b.vx -= ux * f; b.vy -= uy * f; b.vz -= uz * f;
  });

  // 同书架互吸：让「书架」在图上真成一片地，而不是靠颜色去猜
  const cent = {};
  act.forEach(function (n) {
    const c = cent[n.shelf] || (cent[n.shelf] = {x: 0, y: 0, z: 0, n: 0});
    c.x += n.x; c.y += n.y; c.z += n.z; c.n++;
  });
  Object.keys(cent).forEach(function (k) {
    const c = cent[k]; c.x /= c.n; c.y /= c.n; c.z /= c.n;
  });
  act.forEach(function (n) {
    if (n === dragging) return;
    const c = cent[n.shelf];
    n.vx += (c.x - n.x) * COH * alpha;
    n.vy += (c.y - n.y) * COH * alpha;
    n.vz += (c.z - n.z) * COH * alpha;
  });

  act.forEach(function (n) {
    if (n === dragging) return;
    if (IS3D) {
      n.vx -= n.x * GRAV * alpha;
      n.vy -= n.y * GRAV * alpha;
      n.vz -= n.z * GRAV * alpha;
    } else {
      n.vx += (W / 2 - n.x) * GRAV * alpha;
      n.vy += (H / 2 - n.y) * GRAV * alpha;
    }
    n.vx *= DAMP; n.vy *= DAMP; n.vz *= DAMP;
    n.x += n.vx; n.y += n.vy; n.z += n.vz;
  });
  alpha *= 0.977;
  if (alpha < 0.015) alpha = 0.015;
}

function project(n) {
  if (!IS3D) {
    n.sx = n.x * view.k + view.x;
    n.sy = n.y * view.k + view.y;
    n.s = view.k;
    n.depth = 0;
    return;
  }
  const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
  const x1 = n.x * cy - n.z * sy;
  const z1 = n.x * sy + n.z * cy;
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const y2 = n.y * cp - z1 * sp;
  const z2 = n.y * sp + z1 * cp;
  const s = (FOCAL / Math.max(240, FOCAL + z2)) * cam.zoom;
  n.sx = W / 2 + cam.ox + x1 * s;
  n.sy = H / 2 + cam.oy + y2 * s;
  n.s = s;
  n.depth = z2;
}

/* ---------------------------------------------------------------- 书架领域 */
// 围住一堆点的最小凸多边形（Jarvis 步进）。点数很少，O(nh) 完全够用，
// 而且三点共线也不会像单调链那样丢顶点。
function hull(pts) {
  if (pts.length < 3) return pts.slice();
  const cross = function (o, a, b) {
    return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  };
  const d2 = function (a, b) {
    return (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y);
  };
  let start = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].x < pts[start].x || (pts[i].x === pts[start].x && pts[i].y < pts[start].y)) start = i;
  }
  const out = [];
  let cur = start;
  for (let guard = 0; guard <= pts.length; guard++) {
    out.push(pts[cur]);
    let next = (cur + 1) % pts.length;
    for (let i = 0; i < pts.length; i++) {
      if (i === cur) continue;
      const cr = cross(pts[cur], pts[next], pts[i]);
      if (cr < 0 || (cr === 0 && d2(pts[cur], pts[i]) > d2(pts[cur], pts[next]))) next = i;
    }
    cur = next;
    if (cur === start) break;
  }
  return out;
}

// 闭合的 Catmull-Rom（转成三次贝塞尔）：曲线**穿过**每一个控制点，
// 不像 Chaikin 那样把尖角削掉一大块，领域框才真的框得住边上的卡。
function pathClosed(pts) {
  const n = pts.length;
  ctx.beginPath();
  if (n < 3) {
    if (n) { ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[n - 1].x, pts[n - 1].y); }
    return;
  }
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i];
    const p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    ctx.bezierCurveTo(
      p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6,
      p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6,
      p2.x, p2.y);
  }
  ctx.closePath();
}

function territoryPath(group, pad) {
  // 半径跟着卡片走：领域框必须真的绕过每张卡，不能从大圆点中间穿过去
  const pts = group.map(function (n) {
    return {x: n.sx, y: n.sy, r: Math.max(6, n.r * n.s)};
  });
  let cx = 0, cy = 0;
  pts.forEach(function (p) { cx += p.x; cy += p.y; });
  cx /= pts.length; cy /= pts.length;

  if (pts.length === 1) {
    const rr = pts[0].r + pad;
    const ring = [];
    for (let i = 0; i < 20; i++) {
      const a = i / 20 * TAU;
      ring.push({x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr});
    }
    return {pts: ring, cx: cx, cy: cy, at: {x: cx, y: cy - rr - 12}};
  }

  let h;
  if (pts.length === 2) {
    // 两张卡：围成一个胶囊，比圆更贴「一排两张」的实情
    const a = pts[0], b = pts[1];
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
    const ux = dx / d, uy = dy / d, nx = -uy, ny = ux;
    const N = 8;
    h = [];
    for (let i = 0; i <= N; i++) {
      const phi = i / N * Math.PI, rr = b.r + pad;
      h.push({x: b.x + rr * (Math.cos(phi) * nx + Math.sin(phi) * ux),
              y: b.y + rr * (Math.cos(phi) * ny + Math.sin(phi) * uy)});
    }
    for (let i = 0; i <= N; i++) {
      const phi = i / N * Math.PI, rr = a.r + pad;
      h.push({x: a.x - rr * (Math.cos(phi) * nx + Math.sin(phi) * ux),
              y: a.y - rr * (Math.cos(phi) * ny + Math.sin(phi) * uy)});
    }
  } else {
    h = hull(pts).map(function (p) {
      const dx = p.x - cx, dy = p.y - cy, d = Math.hypot(dx, dy) || 1;
      const out = p.r + pad;
      return {x: p.x + dx / d * out, y: p.y + dy / d * out};
    });
  }
  // 标签放在地块上沿正中：卡片名一律在圆点下方，所以这里不会撞车
  let x0 = 1e9, y0 = 1e9, x1 = -1e9;
  h.forEach(function (q) {
    x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x);
  });
  return {pts: h, cx: cx, cy: cy, at: {x: (x0 + x1) / 2, y: y0 - 12}};
}

function drawTerritories(hi) {
  const groups = {};
  nodes.forEach(function (n) {
    if (!visible(n)) return;
    (groups[n.shelf] = groups[n.shelf] || []).push(n);
  });
  Object.keys(groups).forEach(function (s) {
    const g = groups[s];
    const tint = COLORS[s] || '#8f8574';
    // 选中某张卡时，和它无关的地块退到背景里去
    const dim = hi && !g.some(function (n) { return hi.has(n.id); });
    const a = dim ? 0.34 : 1;
    const t = territoryPath(g, 30);
    pathClosed(t.pts);
    ctx.fillStyle = hexA(tint, 0.055 * a);
    ctx.fill();
    ctx.setLineDash([2, 5]);
    ctx.strokeStyle = hexA(tint, 0.30 * a);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);

    // 领域名压在地块左上角，垫一层纸色小牌，线从这儿过也不会糊成一团
    const label = s + '  ' + g.length;
    ctx.font = '600 10.5px "Noto Sans SC","PingFang SC",system-ui,sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(label).width;
    const bx = t.at.x - tw / 2 - 5, by = t.at.y - 8, bw = tw + 10, bh = 16, r = 3;
    ctx.beginPath();
    ctx.moveTo(bx + r, by);
    ctx.arcTo(bx + bw, by, bx + bw, by + bh, r);
    ctx.arcTo(bx + bw, by + bh, bx, by + bh, r);
    ctx.arcTo(bx, by + bh, bx, by, r);
    ctx.arcTo(bx, by, bx + bw, by, r);
    ctx.closePath();
    ctx.fillStyle = hexA('#fbf8f1', 0.88 * a);
    ctx.fill();
    ctx.fillStyle = hexA(tint, 0.95 * a);
    ctx.fillText(label, t.at.x, t.at.y);
  });
}

/* ---------------------------------------------------------------- 绘制 */
function neighbors(id) {
  const s = new Set([id]);
  edges.forEach(function (e) {
    if (e.s === id) s.add(e.t);
    if (e.t === id) s.add(e.s);
  });
  return s;
}

function arrowHead(x, y, ux, uy, size, color) {
  const w = size * 0.44;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - ux * size - uy * w, y - uy * size + ux * w);
  ctx.lineTo(x - ux * size + uy * w, y - uy * size - ux * w);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function draw() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const act = nodes.filter(visible);
  act.forEach(project);

  let sMin = 1e9, sMax = -1e9;
  act.forEach(function (n) { sMin = Math.min(sMin, n.s); sMax = Math.max(sMax, n.s); });
  const near = function (n) {
    if (!IS3D || sMax - sMin < 1e-6) return 1;
    return 0.34 + 0.66 * ((n.s - sMin) / (sMax - sMin));
  };

  const active = sel || hover;
  const hi = active ? neighbors(active) : null;

  if (showTerr && !IS3D) drawTerritories(hi);

  const es = edges.filter(edgeShown);
  if (IS3D) {
    es.sort(function (p, q) {
      return (byId[q.s].depth + byId[q.t].depth) - (byId[p.s].depth + byId[p.t].depth);
    });
  }
  const keyOf = function (e) { return e.s < e.t ? e.s + '|' + e.t : e.t + '|' + e.s; };
  const tally = {};
  es.forEach(function (e) { const k = keyOf(e); tally[k] = (tally[k] || 0) + 1; });

  es.forEach(function (e) {
    const a = byId[e.s], b = byId[e.t];
    const strong = active && (e.s === active || e.t === active);
    const dim = hi && !strong;
    const dep = IS3D ? (near(a) + near(b)) / 2 : 1;
    const tint = typeColor(e.label);
    const two = tally[keyOf(e)] > 1;

    // 法线固定按「小 id → 大 id」算，避免反向边两次取反后算出同一条线
    const loNode = e.s < e.t ? a : b, hiNode = e.s < e.t ? b : a;
    const cdx = hiNode.sx - loNode.sx, cdy = hiNode.sy - loNode.sy;
    const clen = Math.hypot(cdx, cdy) || 1;
    const cnx = -cdy / clen, cny = cdx / clen;
    const sgn = e.s < e.t ? 1 : -1;

    const OFF = two ? 13 : 0;
    const ox = cnx * OFF * sgn, oy = cny * OFF * sgn;
    const ra = Math.max(5, a.r * a.s) + 2, rb = Math.max(5, b.r * b.s) + 2;
    const ax0 = a.sx + ox, ay0 = a.sy + oy, ax1 = b.sx + ox, ay1 = b.sy + oy;
    const ldx = ax1 - ax0, ldy = ay1 - ay0, llen = Math.hypot(ldx, ldy) || 1;
    const ux = ldx / llen, uy = ldy / llen;
    const sx0 = ax0 + ux * ra, sy0 = ay0 + uy * ra;
    const sx1 = ax1 - ux * rb, sy1 = ay1 - uy * rb;

    ctx.beginPath();
    ctx.strokeStyle = tint;
    ctx.globalAlpha = strong ? 0.95 : dim ? 0.07 : 0.36 + 0.2 * dep;
    ctx.lineWidth = strong ? 2.4 : 1.4;
    ctx.lineCap = 'round';
    if (SOFT[e.label]) ctx.setLineDash([5, 4]);
    ctx.moveTo(sx0, sy0);
    ctx.lineTo(sx1, sy1);
    ctx.stroke();
    ctx.setLineDash([]);

    // 箭头：方向不靠动画猜，静态就在那儿
    ctx.globalAlpha = strong ? 0.95 : dim ? 0.09 : 0.45 + 0.2 * dep;
    arrowHead(sx1, sy1, ux, uy, strong ? 10 : 7.5, tint);
    ctx.globalAlpha = 1;

    // 一个光点沿边游向目标，只是让方向更抢眼
    const baseAlpha = dim ? 0.10 : 1;
    const scale3d = IS3D ? Math.max(0.7, Math.min(1.25, (a.s + b.s) / 2)) : 1;
    const n = strong ? 2 : 1;
    for (let k = 0; k < n; k++) {
      const t = (clock * 0.16 + e.phase + k * 0.5) % 1;
      const fade = Math.min(1, Math.min(t, 1 - t) * 5);
      if (fade <= 0) continue;
      const hx = sx0 + (sx1 - sx0) * t, hy = sy0 + (sy1 - sy0) * t;
      ctx.globalAlpha = baseAlpha * fade * 0.85;
      ctx.beginPath();
      ctx.arc(hx, hy, 2.3 * scale3d, 0, TAU);
      ctx.fillStyle = tint;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    if (strong || (showLabels && view.k > 2.4)) {
      const mx = (sx0 + sx1) / 2 - uy * 10;
      const my = (sy0 + sy1) / 2 + ux * 10;
      const label = strong && active
        ? ((e.s === active ? '→ ' : '← ') + e.label)
        : e.label;
      ctx.font = '10px "JetBrains Mono",ui-monospace,monospace';
      const w = ctx.measureText(label).width;
      ctx.fillStyle = hexA('#fffdf8', 0.94);
      ctx.fillRect(mx - w / 2 - 4, my - 7, w + 8, 14);
      ctx.fillStyle = tint;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, mx, my);
    }
  });

  const ns = act.slice();
  if (IS3D) ns.sort(function (p, q) { return q.depth - p.depth; });
  ns.forEach(function (n) {
    const dim = hi && !hi.has(n.id);
    const dep = near(n);
    const rr = Math.max(4, n.r * n.s);
    ctx.globalAlpha = dim ? 0.16 : 1;
    // 纸色底盘：让线和箭头止于卡片边缘，不穿进圆里
    ctx.beginPath();
    ctx.arc(n.sx, n.sy, rr + 1.6, 0, TAU);
    ctx.fillStyle = hexA('#fbf8f1', 0.9);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(n.sx, n.sy, rr, 0, TAU);
    ctx.fillStyle = COLORS[n.shelf] || '#8f8574';
    ctx.fill();
    ctx.lineWidth = n.id === sel ? 2.6 : 1.6;
    ctx.strokeStyle = n.id === sel ? '#1c1a17'
      : 'rgba(251,248,241,' + (0.5 + 0.45 * dep).toFixed(2) + ')';
    ctx.stroke();
    if (!n.deg) {
      // 孤立卡：虚线外圈，一眼看出「还没挂关系」
      ctx.beginPath();
      ctx.arc(n.sx, n.sy, rr + 5.5, 0, TAU);
      ctx.setLineDash([2.5, 3]);
      ctx.strokeStyle = hexA('#c9622f', 0.75);
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;
  });

  if (showLabels) {
    const boxes = [];
    const bySize = act.slice().sort(function (p, q) {
      return (q.deg - p.deg) || (q.s - p.s);
    });
    bySize.forEach(function (n) {
      const isFocus = (hi && hi.has(n.id)) || n.id === sel;
      const dim = hi && !hi.has(n.id);
      const rr = Math.max(4, n.r * n.s);
      const fs = IS3D ? 11.5 : 12;
      ctx.font = '500 ' + fs + 'px "Noto Sans SC","PingFang SC",system-ui,sans-serif';
      const label = n.zh.length > 13 ? n.zh.slice(0, 12) + '…' : n.zh;
      const w = ctx.measureText(label).width;
      const by = n.sy + rr + 6;
      const box = {x: n.sx - w / 2 - 3, y: by, w: w + 6, h: fs + 4};
      const clash = boxes.some(function (b) {
        return !(box.x > b.x + b.w || box.x + box.w < b.x ||
                 box.y > b.y + b.h || box.y + box.h < b.y);
      });
      if (clash && !isFocus) return;
      boxes.push(box);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.lineWidth = 4;
      ctx.strokeStyle = hexA('#fbf8f1', dim ? 0.5 : 0.95);
      ctx.strokeText(label, n.sx, by);
      ctx.fillStyle = dim ? 'rgba(51,46,39,.3)'
        : IS3D ? 'rgba(51,46,39,' + (0.4 + 0.6 * near(n)).toFixed(2) + ')' : '#332e27';
      ctx.fillText(label, n.sx, by);
    });
  }
}

function loop() {
  clock = performance.now() / 1000;
  if (IS3D && cam.auto && !dragging && !rotating) cam.yaw += 0.0016;
  step();
  draw();
  // 取景两拍：alpha 掉到 .05 先框一次（马上能看），彻底停稳再微调一次
  if (fitPass && alpha < (fitPass === 2 ? 0.05 : 0.0155)) { fitPass--; fit(); }
  const busy = alpha > 0.016 || dragging || rotating || (IS3D && cam.auto) || edges.length > 0;
  if (busy) raf = requestAnimationFrame(loop);
  else { raf = null; draw(); }
}

function wake(a) {
  alpha = Math.max(alpha, a || 0.4);
  if (!raf) raf = requestAnimationFrame(loop);
}

/* ---------------------------------------------------------------- 视角 */
function fit() {
  if (IS3D) {
    cam.yaw = 0.62; cam.pitch = -0.3; cam.zoom = 1; cam.ox = 0; cam.oy = 0;
    // 先按 1 倍投影量一次包围盒，折算成刚好装得下的缩放，再把画面挪回正中
    const act = nodes.filter(visible);
    const box = function () {
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      act.forEach(project);
      act.forEach(function (n) {
        x0 = Math.min(x0, n.sx); y0 = Math.min(y0, n.sy);
        x1 = Math.max(x1, n.sx); y1 = Math.max(y1, n.sy);
      });
      return {x0: x0, y0: y0, x1: x1, y1: y1};
    };
    if (act.length) {
      let b = box();
      const k = Math.min((W - 220) / Math.max(1, b.x1 - b.x0), (H - 190) / Math.max(1, b.y1 - b.y0));
      cam.zoom = Math.max(0.45, Math.min(1.9, k));
      b = box();
      // b 是屏幕坐标，所以要把「内容中心」搬到「画布中心」的差值补上
      cam.ox = W / 2 - (b.x0 + b.x1) / 2;
      cam.oy = H / 2 - (b.y0 + b.y1) / 2;
      box();
    }
    wake(0.05);
    return;
  }
  const act = nodes.filter(visible);
  if (!act.length) return;
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  act.forEach(function (n) {
    x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y);
  });
  const padL = 78, padR = panel.classList.contains('on') ? 420 : 78;
  const padT = 92, padB = 88;   // 上方留出领域名，下方留出卡片名
  const k = Math.min((W - padL - padR) / Math.max(1, x1 - x0),
                     (H - padT - padB) / Math.max(1, y1 - y0), 2.4);
  view.k = Math.max(0.2, Math.min(2.2, k));
  view.x = padL + (W - padL - padR) / 2 - ((x0 + x1) / 2) * view.k;
  view.y = padT + (H - padT - padB) / 2 - ((y0 + y1) / 2) * view.k;
  draw();
}

function focusNode(id) {
  const n = byId[id];
  if (!n || IS3D) return;
  const padR = panel.classList.contains('on') ? 430 : 0;
  view.x = (W - padR) / 2 - n.x * view.k;
  view.y = H / 2 - n.y * view.k;
  wake(0.05);
}

/* ---------------------------------------------------------------- 交互 */
function screenPos(ev) {
  const r = cv.getBoundingClientRect();
  return {x: ev.clientX - r.left, y: ev.clientY - r.top};
}

function pick(p) {
  let best = null, bd = 1e9;
  nodes.forEach(function (n) {
    if (!visible(n)) return;
    const d = Math.hypot(n.sx - p.x, n.sy - p.y);
    if (d < Math.max(8, n.r * n.s) + 4 && d < bd) { bd = d; best = n; }
  });
  return best;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c];
  });
}

function setStatus(n) {
  if (!n) {
    statusEl.innerHTML = IS3D
      ? '拖动空白处旋转 · 滚轮缩放 · 点卡片看关系'
      : '拖动空白处平移 · 滚轮缩放 · 点卡片看关系';
    return;
  }
  statusEl.innerHTML = '<b>' + esc(n.zh) + '</b><span class="sep">/</span>' +
    esc(n.shelf) + '<span class="sep">/</span>' + n.deg + ' 条关系' +
    (n.deg ? '（出 ' + n.out + ' · 入 ' + n.inc + '）' : '');
}

cv.addEventListener('mousedown', function (ev) {
  fitPass = 0;
  const p = screenPos(ev);
  const n = pick(p);
  moved = 0;
  if (n) {
    dragging = n;
    n.vx = 0; n.vy = 0; n.vz = 0;
  } else if (IS3D) {
    rotating = {x: ev.clientX, y: ev.clientY, yaw: cam.yaw, pitch: cam.pitch};
    cv.classList.add('grabbing');
  } else {
    panning = {x: ev.clientX - view.x, y: ev.clientY - view.y};
    cv.classList.add('grabbing');
  }
});

cv.addEventListener('mousemove', function (ev) {
  const p = screenPos(ev);
  if (dragging) {
    moved += 1;
    if (IS3D) {
      const dx = (p.x - dragging.sx) / Math.max(0.2, dragging.s);
      const dy = (p.y - dragging.sy) / Math.max(0.2, dragging.s);
      const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
      dragging.x += dx * cy;
      dragging.z -= dx * sy;
      dragging.y += dy;
    } else {
      dragging.x = (p.x - view.x) / view.k;
      dragging.y = (p.y - view.y) / view.k;
    }
    dragging.vx = 0; dragging.vy = 0; dragging.vz = 0;
    wake(0.5);
    return;
  }
  if (rotating) {
    moved += 1;
    cam.yaw = rotating.yaw + (ev.clientX - rotating.x) * 0.008;
    cam.pitch = Math.max(-1.35, Math.min(1.35, rotating.pitch + (ev.clientY - rotating.y) * 0.008));
    wake(0.05);
    return;
  }
  if (panning) {
    view.x = ev.clientX - panning.x;
    view.y = ev.clientY - panning.y;
    draw();
    return;
  }
  const n = pick(p);
  if ((n && n.id) !== (hover && hover.id)) {
    hover = n;
    setStatus(n);
    cv.style.cursor = n ? 'pointer' : 'grab';
    draw();
  }
});

window.addEventListener('mouseup', function () {
  if (dragging && moved < 4) selectCard(dragging.id);
  dragging = null;
  rotating = null;
  panning = null;
  cv.classList.remove('grabbing');
});

cv.addEventListener('mouseleave', function () {
  hover = null;
  setStatus(null);
  cv.style.cursor = 'grab';
  draw();
});

cv.addEventListener('wheel', function (ev) {
  ev.preventDefault();
  if (IS3D) {
    cam.zoom = Math.max(0.4, Math.min(2.8, cam.zoom * (ev.deltaY < 0 ? 1.1 : 0.91)));
    wake(0.05);
    return;
  }
  const r = cv.getBoundingClientRect();
  const mx = ev.clientX - r.left, my = ev.clientY - r.top;
  const k0 = view.k;
  const k1 = Math.max(0.35, Math.min(2.6, k0 * (ev.deltaY < 0 ? 1.12 : 0.89)));
  view.x = mx - (mx - view.x) * (k1 / k0);
  view.y = my - (my - view.y) * (k1 / k0);
  view.k = k1;
  draw();
}, {passive: false});

/* ---------------------------------------------------------------- 右侧清单 */
function el(tag, cls, text) {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (text != null) d.textContent = text;
  return d;
}

function mdInto(box, text) {
  String(text || '').split(/(\*\*[^*]+\*\*)/).forEach(function (seg) {
    if (/^\*\*[^*]+\*\*$/.test(seg)) box.appendChild(el('b', null, seg.slice(2, -2)));
    else if (seg) box.appendChild(document.createTextNode(seg));
  });
  return box;
}

// 按「对方那张卡」归并：8 张卡之间只有 7 组关系，不该列成 14 行
function pairGroups(id) {
  const m = new Map();
  edges.forEach(function (e) {
    let other = null, dir = null;
    if (e.s === id) { other = e.t; dir = 'out'; }
    else if (e.t === id) { other = e.s; dir = 'in'; }
    else return;
    let g = m.get(other);
    if (!g) { g = {id: other, out: [], inc: [], notes: []}; m.set(other, g); }
    (dir === 'out' ? g.out : g.inc).push(e);
    if (e.note) g.notes.push(e.note);
  });
  const arr = [];
  m.forEach(function (g) { arr.push(g); });
  arr.sort(function (p, q) {
    return (q.out.length + q.inc.length) - (p.out.length + p.inc.length);
  });
  return arr;
}

function openPanel(n) {
  panel.innerHTML = '';
  const close = el('button', 'close', '×');
  close.title = '关闭（Esc）';
  close.onclick = function () { selectCard(null); };
  panel.appendChild(close);

  panel.appendChild(el('div', 'k', n.id + ' · ' + n.shelf + ' · ' + n.form));
  panel.appendChild(el('h2', null, n.zh));
  if (n.en) panel.appendChild(el('div', 'en', n.en));

  const meta = el('div', 'meta');
  [n.status, n.conf ? '证据 ' + n.conf : '', n.school, n.src ? '出处 ' + n.src + ' 条' : '']
    .filter(Boolean).forEach(function (x) { meta.appendChild(el('span', null, x)); });
  if (meta.childNodes.length) panel.appendChild(meta);

  if (n.def) panel.appendChild(mdInto(el('div', 'def'), n.def));

  // 关系网是入口，不是终点：能直接翻到这张卡的卡片图。
  // 但被插件用 srcdoc 嵌进来时没有 base URL，相对路径打不开，就不给这个入口
  // （面板里本来就有「卡片图」页签）。
  if (n.shot && location.protocol !== 'about:') {
    const a = el('a', 'shotlink', '看这张卡');
    a.href = 'rendered/' + encodeURIComponent(n.id) + '.html';
    a.target = '_blank';
    a.rel = 'noopener';
    a.title = '打开 rendered/' + n.id + '.html';
    panel.appendChild(a);
  }

  const groups = pairGroups(n.id);
  const h3 = el('h3', null, '与它相连 · ' + groups.length + ' 张卡');
  h3.appendChild(el('em', null, '出 ' + n.out + ' / 入 ' + n.inc));
  panel.appendChild(h3);

  if (!groups.length) {
    panel.appendChild(el('div', 'empty',
      '这张卡还没挂关系。孤立卡在检索里几乎找不到，建议至少连一条：它依赖谁，或者谁在用它。'));
    return;
  }

  groups.forEach(function (g) {
    const other = byId[g.id];
    if (!other) return;
    const btn = el('button', 'pair');

    const h = el('div', 'pair-h');
    const dot = el('i');
    dot.style.background = COLORS[other.shelf] || '#8f8574';
    h.appendChild(dot);
    h.appendChild(el('b', null, other.zh));
    h.appendChild(el('em', null, other.shelf));
    btn.appendChild(h);

    const chips = el('div', 'chips');
    g.out.forEach(function (e) {
      const c = el('span', 'ch');
      const i = el('i'); i.style.background = typeColor(e.label);
      c.appendChild(i);
      c.appendChild(document.createTextNode('它 → ' + e.label));
      c.title = OUT_GLOSS[e.label] || e.label;
      chips.appendChild(c);
    });
    g.inc.forEach(function (e) {
      const c = el('span', 'ch');
      const i = el('i'); i.style.background = typeColor(e.label);
      c.appendChild(i);
      c.appendChild(document.createTextNode('← ' + e.label));
      c.title = IN_GLOSS[e.label] || e.label;
      chips.appendChild(c);
    });
    btn.appendChild(chips);

    if (g.out.length && g.inc.length) {
      const both = el('div', 'both', '双向声明');
      both.title = '两张卡各自写了对方。前置与应用于、上位与下位常是同一件事的两面。';
      btn.appendChild(both);
    }

    if (g.notes.length) {
      const uniq = [];
      g.notes.forEach(function (x) { if (uniq.indexOf(x) < 0) uniq.push(x); });
      btn.appendChild(mdInto(el('div', 'why'), uniq.join(' ／ ')));
    }

    btn.onclick = function () { selectCard(other.id); focusNode(other.id); };
    panel.appendChild(btn);
  });
}

function selectCard(id) {
  sel = id;
  if (id && byId[id]) {
    openPanel(byId[id]);
    panel.classList.add('on');
    if (!IS3D) {
      const n = byId[id];
      const sx = n.x * view.k + view.x, sy = n.y * view.k + view.y;
      if (sx > W - 430 || sx < 70 || sy < 70 || sy > H - 70) focusNode(id);
    }
  } else {
    panel.classList.remove('on');
  }
  draw();
}

/* ---------------------------------------------------------------- 左栏 */
function row(dotEl, name, gloss, count, on, onclick) {
  const b = el('button', 'row' + (on ? '' : ' off'));
  b.appendChild(dotEl);
  b.appendChild(el('span', 'nm', name));
  if (gloss) b.appendChild(el('span', 'gl', gloss));
  b.appendChild(el('span', 'ct', count));
  b.title = name + (gloss ? ' · ' + gloss : '') + '（点击只看这一类，Shift 点击叠加）';
  b.onclick = function (ev) { onclick(ev); };
  return b;
}

function buildRail() {
  const sCount = {};
  nodes.forEach(function (n) { sCount[n.shelf] = (sCount[n.shelf] || 0) + 1; });
  legendEl.innerHTML = '';
  shelfNames.forEach(function (s) {
    const dot = el('i', 'dot');
    dot.style.background = COLORS[s] || '#8f8574';
    const b = row(dot, s, '', sCount[s], true, function (ev) {
      if (ev.shiftKey) {
        if (activeShelves.has(s)) activeShelves.delete(s); else activeShelves.add(s);
        if (!activeShelves.size) activeShelves.add(s);
      } else if (activeShelves.size === 1 && activeShelves.has(s)) {
        shelfNames.forEach(function (x) { activeShelves.add(x); });
      } else {
        activeShelves.clear(); activeShelves.add(s);
      }
      syncRail(); fit(); wake(0.5);
    });
    b.dataset.shelf = s;
    legendEl.appendChild(b);
  });

  typesEl.innerHTML = '';
  typeNames.forEach(function (t) {
    const bar = el('i', 'bar' + (SOFT[t] ? ' dash' : ''));
    bar.style.borderTopColor = typeColor(t);
    const b = row(bar, t, TYPE_GLOSS[t] || '', edges.filter(function (e) { return e.label === t; }).length, true,
      function (ev) {
        if (ev.shiftKey) {
          if (activeTypes.has(t)) activeTypes.delete(t); else activeTypes.add(t);
          if (!activeTypes.size) activeTypes.add(t);
        } else if (activeTypes.size === 1 && activeTypes.has(t)) {
          typeNames.forEach(function (x) { activeTypes.add(x); });
        } else {
          activeTypes.clear(); activeTypes.add(t);
        }
        syncRail(); draw();
      });
    b.dataset.type = t;
    typesEl.appendChild(b);
  });
  // 空库时不要留一排空标题
  if (!shelfNames.length && legendEl.parentNode) legendEl.parentNode.style.display = 'none';
  if (!typeNames.length && typesEl.parentNode) typesEl.parentNode.style.display = 'none';
}

function syncRail() {
  Array.prototype.forEach.call(legendEl.children, function (b) {
    b.classList.toggle('off', !activeShelves.has(b.dataset.shelf));
  });
  Array.prototype.forEach.call(typesEl.children, function (b) {
    b.classList.toggle('off', !activeTypes.has(b.dataset.type));
  });
}

function buildStat() {
  const box = document.getElementById('stat');
  if (!box) return;
  const shelves = shelfNames.filter(function (s) {
    return nodes.some(function (n) { return n.shelf === s; });
  }).length;
  let html = '<b>' + nodes.length + '</b> 张卡 · <b>' + shelves + '</b> 架 · <b>' +
    edges.length + '</b> 条关系';
  if (isolated.length) {
    html += '<br><span style="color:#c9622f">孤立 ' + isolated.length +
      ' 张</span>（还没挂关系）';
  }
  box.innerHTML = html;
}

/* ---------------------------------------------------------------- 说明 */
const helpEl = document.getElementById('help');
function openHelp() { helpEl.classList.add('on'); }
function closeHelp() { helpEl.classList.remove('on'); }
document.getElementById('b-help').onclick = openHelp;
document.getElementById('help-x').onclick = closeHelp;
helpEl.addEventListener('click', function (ev) { if (ev.target === helpEl) closeHelp(); });

(function fillTypes() {
  const box = document.getElementById('help-types');
  if (!box) return;
  typeNames.forEach(function (t) {
    const chip = el('div', 'tchip');
    const dot = el('i');
    dot.style.background = typeColor(t);
    chip.appendChild(dot);
    chip.appendChild(document.createTextNode(t));
    const u = el('u', null, OUT_GLOSS[t] || '');
    chip.appendChild(u);
    box.appendChild(chip);
  });
})();

document.getElementById('b-fit').onclick = fit;
document.getElementById('b-reset').onclick = function () { seed(); };
document.getElementById('b-all-shelf').onclick = function () {
  shelfNames.forEach(function (s) { activeShelves.add(s); });
  syncRail(); fit(); wake(0.4);
};
document.getElementById('b-all-type').onclick = function () {
  typeNames.forEach(function (t) { activeTypes.add(t); });
  syncRail(); draw();
};

const cLabel = document.getElementById('c-label');
if (cLabel) {
  cLabel.checked = showLabels;
  cLabel.onchange = function () { showLabels = cLabel.checked; draw(); };
}
const cTerr = document.getElementById('c-terr');
if (cTerr) {
  if (IS3D) {
    const r = cTerr.closest('.sw');
    if (r) r.style.display = 'none';
  } else {
    cTerr.checked = showTerr;
    cTerr.onchange = function () { showTerr = cTerr.checked; draw(); };
  }
}

// 3D 版多一个「自动旋转」——默认关，转起来就没法读了
const cAuto = document.getElementById('c-auto');
if (cAuto) {
  cAuto.checked = cam.auto;
  cAuto.onchange = function () { cam.auto = cAuto.checked; wake(0.05); };
}

// 全屏：图放大到整块屏幕，取景重新算一遍
const bFs = document.getElementById('b-fs');
if (bFs) {
  bFs.onclick = function () {
    if (document.fullscreenElement) {
      if (document.exitFullscreen) document.exitFullscreen();
    } else if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(function () {});
    }
  };
  document.addEventListener('fullscreenchange', function () {
    var on = !!document.fullscreenElement;
    bFs.textContent = on ? '退出全屏' : '全屏';
    setTimeout(function () { resize(); fit(); }, 140);
  });
}

document.addEventListener('keydown', function (ev) {
  if (ev.key === 'Escape') {
    if (helpEl.classList.contains('on')) closeHelp();
    else selectCard(null);
  }
});
window.addEventListener('resize', resize);

/* ---------------------------------------------------------------- 启动 */
// 被插件面板嵌进 iframe 时收掉自带的标题栏（面板顶上已经有了）
try {
  if (window.self !== window.top) document.body.classList.add('embedded');
} catch (e) {
  document.body.classList.add('embedded');
}

buildRail();
buildStat();
setStatus(null);
resize();
if (nodes.length) seed();
else {
  statusEl.classList.add('empty');
  statusEl.innerHTML = '这个库里还没有卡片。先收录几张（<code>kcard.py ingest</code>），' +
    '关系网就会长出来。';
}
