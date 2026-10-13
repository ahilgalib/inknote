// Ink geometry. Raw samples ([x,y,pressure,...]) are turned into a dense,
// smooth centre line (midpoint quadratic curves), and pen strokes are filled
// as a variable-width outline built from that line. The same function is used
// while drawing and after the stroke is committed, so nothing "jumps" on lift.

const cache = new WeakMap(); // item -> { path, bbox }

// Auto ink: the default black ink shows as white on dark paper and white ink
// shows as black on light paper (like Notability). Other colours never change.
const lumCache = new Map();
function lum(hex) {
  let v = lumCache.get(hex);
  if (v !== undefined) return v;
  const c = String(hex).replace('#', '');
  v = c.length >= 6 ? (parseInt(c.slice(0, 2), 16) * 299 + parseInt(c.slice(2, 4), 16) * 587 + parseInt(c.slice(4, 6), 16) * 114) / 1000 : -1;
  lumCache.set(hex, v);
  return v;
}
export const DARK_INK = '#f4f4f6';
export const LIGHT_INK = '#1d1d1f';
export function inkColor(color, dark) {
  const l = lum(color);
  if (l < 0) return color;
  if (dark && l < 64) return DARK_INK;
  if (!dark && l > 232) return LIGHT_INK;
  return color;
}

export const round2 = (v) => Math.round(v * 100) / 100;

// Study tape that is currently peeled back (tap a tape to show what is under it).
export const openTapes = new Set();

export function penRadius(size, p, style) {
  if (style === 'ball' || style === 'dash' || style === 'dot' || style === 'pencil') return size * (0.78 + 0.22 * p) / 2;
  return size * (0.32 + 0.95 * p) / 2;           // fountain: strong pressure response
}

// Dense samples [x, y, p, ...] along the smoothed centre line.
// openStart / openEnd are used for the pieces of a stroke that is still being
// written: a piece then starts / ends exactly on the midpoint where its
// neighbour ends / starts, so the pieces join into the same curve.
export function dense(pts, size = 2, openStart = false, openEnd = false) {
  const n = pts.length / 3;
  const out = [];
  if (!n) return out;
  if (n === 1) return [pts[0], pts[1], pts[2]];
  const step = Math.max(0.45, Math.min(2.2, size * 0.32));
  const line = (ax, ay, ap, bx, by, bp, first) => {
    const len = Math.hypot(bx - ax, by - ay);
    const k = Math.max(1, Math.ceil(len / step));
    for (let i = first ? 0 : 1; i <= k; i++) {
      const t = i / k;
      out.push(ax + (bx - ax) * t, ay + (by - ay) * t, ap + (bp - ap) * t);
    }
  };
  const quad = (ax, ay, ap, cx, cy, cp, bx, by, bp) => {
    const len = Math.hypot(cx - ax, cy - ay) + Math.hypot(bx - cx, by - cy);
    const k = Math.max(1, Math.ceil(len / step));
    for (let i = 1; i <= k; i++) {
      const t = i / k, u = 1 - t;
      out.push(u * u * ax + 2 * u * t * cx + t * t * bx, u * u * ay + 2 * u * t * cy + t * t * by, u * u * ap + 2 * u * t * cp + t * t * bp);
    }
  };
  const P = (i) => [pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]];
  const M = (i) => { const a = P(i - 1), b = P(i); return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]; };
  if (n === 2) { line(...P(0), ...P(1), true); return out; }
  if (openStart) out.push(...M(1)); else line(...P(0), ...M(1), true);
  for (let i = 1; i < n - 1; i++) quad(...M(i), ...P(i), ...M(i + 1));
  if (!openEnd) line(...M(n - 1), ...P(n - 1), false);
  return out;
}

// Filled outline for a pressure-sensitive pen stroke.
export function penPath(pts, size, style = 'fountain', openStart = false, openEnd = false) {
  const path = new Path2D();
  const d = dense(pts, size, openStart, openEnd);
  const m = d.length / 3;
  if (!m) return path;
  const R = (i) => Math.max(0.3, penRadius(size, d[i * 3 + 2], style));
  if (m === 1 || isDot(d)) {
    path.arc(d[0], d[1], R(0), 0, Math.PI * 2);
    return path;
  }
  const L = [], Rt = [];
  for (let i = 0; i < m; i++) {
    const a = Math.max(0, i - 2), b = Math.min(m - 1, i + 2);
    let dx = d[b * 3] - d[a * 3], dy = d[b * 3 + 1] - d[a * 3 + 1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) { dx = 1; dy = 0; } else { dx /= len; dy /= len; }
    let r = R(i);
    if (style === 'calli') r = Math.max(0.3, size * (0.12 + 1.05 * Math.abs(dx * 0.7071 + dy * 0.7071)) * (0.75 + 0.35 * d[i * 3 + 2]) / 2);
    const x = d[i * 3], y = d[i * 3 + 1];
    L.push(x - dy * r, y + dx * r);
    Rt.push(x + dy * r, y - dx * r);
  }
  path.moveTo(L[0], L[1]);
  for (let i = 2; i < L.length; i += 2) path.lineTo(L[i], L[i + 1]);
  // round end cap
  const ex = d[(m - 1) * 3], ey = d[(m - 1) * 3 + 1];
  const ea = Math.atan2(L[L.length - 1] - ey, L[L.length - 2] - ex);
  path.arc(ex, ey, R(m - 1), ea, ea - Math.PI, true);
  for (let i = Rt.length - 2; i >= 0; i -= 2) path.lineTo(Rt[i], Rt[i + 1]);
  // round start cap
  const sa = Math.atan2(Rt[1] - d[1], Rt[0] - d[0]);
  path.arc(d[0], d[1], R(0), sa, sa - Math.PI, true);
  path.closePath();
  return path;
}

// Smooth centre line (highlighter, dashed pen).
export function smoothLine(pts, size, openStart = false, openEnd = false) {
  const path = new Path2D();
  const d = dense(pts, size, openStart, openEnd);
  if (!d.length) return path;
  path.moveTo(d[0], d[1]);
  if (d.length === 3) { path.lineTo(d[0] + 0.01, d[1]); return path; }
  for (let i = 3; i < d.length; i += 3) path.lineTo(d[i], d[i + 1]);
  return path;
}

// Straight-segment path (recognised shapes keep their corners).
export function polyPath(pts, closed) {
  const path = new Path2D();
  if (!pts.length) return path;
  path.moveTo(pts[0], pts[1]);
  for (let i = 3; i < pts.length; i += 3) path.lineTo(pts[i], pts[i + 1]);
  if (closed) path.closePath();
  return path;
}

function isDot(d) {
  const x = d[0], y = d[1];
  for (let i = 3; i < d.length; i += 3) if (Math.abs(d[i] - x) > 0.8 || Math.abs(d[i + 1] - y) > 0.8) return false;
  return true;
}

export function strokeBBox(pts, pad = 0) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i], y = pts[i + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
}

// Bounding box of any item (rotation aware for images/text).
export function itemBBox(it) {
  if (it.type === 'stroke') {
    let c = cache.get(it);
    if (!c || !c.bbox) { c = c || {}; c.bbox = strokeBBox(it.pts, it.size); cache.set(it, c); }
    return c.bbox;
  }
  const w = it.w, h = it.type === 'text' ? (it.h || it.size * 1.4) : it.h;
  if (!it.rot) return { x: it.x, y: it.y, w, h };
  const cx = it.x + w / 2, cy = it.y + h / 2, c = Math.abs(Math.cos(it.rot)), s = Math.abs(Math.sin(it.rot));
  const W = w * c + h * s, H = w * s + h * c;
  return { x: cx - W / 2, y: cy - H / 2, w: W, h: H };
}

export function invalidate(it) { cache.delete(it); }

function getPath(it) {
  let c = cache.get(it);
  if (!c) { c = {}; cache.set(it, c); }
  if (!c.path) {
    if (it.shape) c.path = polyPath(it.pts, it.closed);
    else if (it.tool === 'hl' || it.tool === 'tape' || it.style === 'dash' || it.style === 'dot') c.path = smoothLine(it.pts, it.size);
    else c.path = penPath(it.pts, it.size, it.style);
  }
  return c.path;
}

// Draw a stroke item onto ctx (already transformed to page space).
export function drawStroke(ctx, it, alpha = 1, path) {
  path = path || getPath(it);
  ctx.save();
  if (it.tool === 'tape') {
    const open = openTapes.has(it.id);
    ctx.globalAlpha = alpha * (open ? 0.9 : 1);
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    if (open) {
      ctx.strokeStyle = it.color;
      ctx.lineWidth = Math.max(1, it.size * 0.07);
      ctx.setLineDash([it.size * 0.3, it.size * 0.25]);
      ctx.stroke(path);
    } else {
      ctx.strokeStyle = it.color;
      ctx.lineWidth = it.size;
      ctx.stroke(path);
      ctx.globalAlpha = alpha * 0.18;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = it.size * 0.34;
      ctx.setLineDash([it.size * 0.18, it.size * 0.5]);
      ctx.stroke(path);
    }
  } else if (it.tool === 'hl') {
    ctx.globalAlpha = 0.36 * alpha;
    if (!ctx.__dark) ctx.globalCompositeOperation = 'multiply';
    ctx.strokeStyle = it.color;
    ctx.lineWidth = it.size;
    ctx.lineCap = it.closed ? 'butt' : 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(path);
  } else if (it.tool === 'laser') {
    ctx.globalAlpha = alpha;
    ctx.shadowColor = it.color;
    ctx.shadowBlur = 10;
    ctx.strokeStyle = it.color;
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(path);
  } else if (it.shape || it.style === 'dash' || it.style === 'dot') {
    const col = inkColor(it.color, ctx.__dark);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(0.6, it.size * (it.style === 'dot' ? 1.1 : 0.8));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (it.style === 'dash') ctx.setLineDash([it.size * 2.6, it.size * 2.2]);
    else if (it.style === 'dot') ctx.setLineDash([0.01, it.size * 2.4]);
    ctx.stroke(path);
    if (it.fill) { ctx.setLineDash([]); ctx.globalAlpha = alpha * 0.22; ctx.fillStyle = col; ctx.fill(path); }
  } else if (it.style === 'pencil') {
    ctx.globalAlpha = alpha * 0.92;
    ctx.fillStyle = pencilPattern(inkColor(it.color, ctx.__dark));
    ctx.fill(path);
  } else {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = inkColor(it.color, ctx.__dark);
    ctx.fill(path);
  }
  ctx.restore();
}

// Grainy fill that looks like graphite / coloured pencil.
const pencilPatterns = new Map();
let patternCtx;
function pencilPattern(color) {
  let p = pencilPatterns.get(color);
  if (p) return p;
  const c = document.createElement('canvas');
  c.width = c.height = 48;
  const x = c.getContext('2d');
  x.fillStyle = color;
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 48 * 48 * 0.62; i++) {
    x.globalAlpha = 0.35 + rnd() * 0.65;
    x.fillRect(Math.floor(rnd() * 48), Math.floor(rnd() * 48), 1, 1);
  }
  patternCtx = patternCtx || document.createElement('canvas').getContext('2d');
  p = patternCtx.createPattern(c, 'repeat');
  pencilPatterns.set(color, p);
  return p;
}

// Live (uncached) version used while the pen is down.
const CHUNK = 40; // points per finished piece of a stroke being written

function piecePath(it, pts, openStart, openEnd) {
  return it.tool === 'hl' || it.tool === 'laser' || it.tool === 'tape'
    ? smoothLine(pts, it.size, openStart, openEnd)
    : penPath(pts, it.size, it.style, openStart, openEnd);
}

// While the pen is down only the newest few points are recomputed each frame:
// finished pieces are kept in it.live (a growing Path2D), so a long stroke
// costs the same per frame as a short one. `extra` are points drawn at the tip
// but not stored (the latest raw / predicted pen position).
export function drawLiveStroke(ctx, it, extra) {
  let path;
  if (it.shape) path = polyPath(it.pts, it.closed);
  else if (it.style === 'dash' || it.style === 'dot') path = smoothLine(extra ? it.pts.concat(extra) : it.pts, it.size);
  else {
    const P = it.pts, n = P.length / 3;
    const st = it.live || (it.live = { path: new Path2D(), end: 0 });
    while (n - st.end > CHUNK + 3) {
      const s = st.end ? st.end - 1 : 0, e = (st.end || 0) + CHUNK;
      st.path.addPath(piecePath(it, P.slice(s * 3, (e + 1) * 3), st.end > 0, true));
      st.end = e;
    }
    let tail = st.end ? P.slice((st.end - 1) * 3) : P;
    if (extra && extra.length) tail = tail.concat(extra);
    const tp = st.end && tail.length < 9 ? null : piecePath(it, tail, st.end > 0, false);
    path = new Path2D(st.path);
    if (tp) path.addPath(tp);
  }
  drawStroke(ctx, it, it.alpha ?? 1, path);
}

// ---- hit testing ---------------------------------------------------------

export function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Distance between segment a-b and segment c-d.
function segSeg(ax, ay, bx, by, cx, cy, dx, dy) {
  // proper intersection?
  const o = (px, py, qx, qy, rx, ry) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  if (o(ax, ay, bx, by, cx, cy) * o(ax, ay, bx, by, dx, dy) < 0 && o(cx, cy, dx, dy, ax, ay) * o(cx, cy, dx, dy, bx, by) < 0) return 0;
  return Math.min(distSeg(ax, ay, cx, cy, dx, dy), distSeg(bx, by, cx, cy, dx, dy), distSeg(cx, cy, ax, ay, bx, by), distSeg(dx, dy, ax, ay, bx, by));
}

export function strokeHit(it, x, y, r) { return strokeHitSegment(it, x, y, x, y, r); }

// Does the eraser path a→b (radius r) touch the stroke?
export function strokeHitSegment(it, ax, ay, bx, by, r) {
  const b = itemBBox(it);
  const pad = r + 2;
  if (Math.max(ax, bx) < b.x - pad || Math.min(ax, bx) > b.x + b.w + pad || Math.max(ay, by) < b.y - pad || Math.min(ay, by) > b.y + b.h + pad) return false;
  const p = it.pts, tol = r + (it.tool === 'hl' || it.tool === 'tape' ? it.size / 2 : it.size * 0.45);
  if (p.length === 3) return distSeg(p[0], p[1], ax, ay, bx, by) <= tol;
  const n = p.length;
  for (let i = 0; i < n - 3; i += 3) {
    if (segSeg(p[i], p[i + 1], p[i + 3], p[i + 4], ax, ay, bx, by) <= tol) return true;
  }
  if (it.closed && segSeg(p[n - 3], p[n - 2], p[0], p[1], ax, ay, bx, by) <= tol) return true;
  return false;
}

// Insert extra points so no gap is longer than `step`.
function densify(p, closed, step) {
  const src = closed ? p.concat(p.slice(0, 3)) : p;
  const out = [];
  for (let i = 0; i < src.length - 3; i += 3) {
    const ax = src[i], ay = src[i + 1], bx = src[i + 3], by = src[i + 4];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 0; k < n; k++) out.push(round2(ax + (bx - ax) * k / n), round2(ay + (by - ay) * k / n), src[i + 2] + (src[i + 5] - src[i + 2]) * k / n);
  }
  out.push(src[src.length - 3], src[src.length - 2], src[src.length - 1]);
  return out;
}

// Precise eraser: cut away the part of the stroke under the eraser path.
// Returns the surviving pieces (arrays of points).
export function splitStroke(it, ax, ay, bx, by, r) {
  const p = densify(it.pts, it.closed, 1.2);
  const parts = [];
  let cur = [];
  const tol = r + (it.tool === 'hl' ? it.size / 2 : it.size * 0.35);
  for (let i = 0; i < p.length; i += 3) {
    if (distSeg(p[i], p[i + 1], ax, ay, bx, by) <= tol) {
      if (cur.length >= 6) parts.push(cur);
      cur = [];
    } else cur.push(p[i], p[i + 1], p[i + 2]);
  }
  if (cur.length >= 6) parts.push(cur);
  return parts.map(simplifyFlat);
}

// Drop points that add nothing (keeps stored strokes small after densify).
function simplifyFlat(p) {
  if (p.length <= 9) return p;
  const out = [p[0], p[1], p[2]];
  for (let i = 3; i < p.length - 3; i += 3) {
    const lx = out[out.length - 3], ly = out[out.length - 2];
    if (Math.hypot(p[i] - lx, p[i + 1] - ly) >= 1.6) out.push(p[i], p[i + 1], p[i + 2]);
  }
  out.push(p[p.length - 3], p[p.length - 2], p[p.length - 1]);
  return out;
}

export function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i], yi = poly[i + 1], xj = poly[j], yj = poly[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Does the lasso polygon capture this item?
export function lassoHit(it, poly) {
  if (it.type === 'stroke') {
    const p = it.pts;
    let inside = 0, total = 0;
    const step = Math.max(3, Math.floor(p.length / 3 / 40) * 3);
    for (let i = 0; i < p.length; i += step) { total++; if (pointInPoly(p[i], p[i + 1], poly)) inside++; }
    return inside / total >= 0.55;
  }
  const b = itemBBox(it);
  return pointInPoly(b.x + b.w / 2, b.y + b.h / 2, poly);
}

// Move / scale (about ox,oy) / rotate (about cx,cy) an item in place.
export function transformItem(it, { dx = 0, dy = 0, k = 1, ox = 0, oy = 0, rot = 0, cx = 0, cy = 0 } = {}) {
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const tf = (x, y) => {
    x = ox + (x - ox) * k + dx;
    y = oy + (y - oy) * k + dy;
    if (rot) { const rx = x - cx, ry = y - cy; x = cx + rx * cos - ry * sin; y = cy + rx * sin + ry * cos; }
    return [x, y];
  };
  if (it.type === 'stroke') {
    const p = it.pts;
    for (let i = 0; i < p.length; i += 3) {
      const [x, y] = tf(p[i], p[i + 1]);
      p[i] = round2(x); p[i + 1] = round2(y);
    }
    if (k !== 1) it.size = Math.max(0.4, round2(it.size * k));
  } else {
    const h0 = it.type === 'text' ? (it.h || it.size * 1.4) : it.h;
    const [ncx, ncy] = tf(it.x + it.w / 2, it.y + h0 / 2);
    it.w = Math.max(8, it.w * k);
    if (it.type === 'text') { it.size = Math.max(4, it.size * k); it.h = h0 * k; }
    else it.h = Math.max(8, it.h * k);
    const nh = it.type === 'text' ? it.h : it.h;
    it.x = ncx - it.w / 2;
    it.y = ncy - nh / 2;
    if (rot) it.rot = ((it.rot || 0) + rot) % (Math.PI * 2);
  }
  invalidate(it);
}
