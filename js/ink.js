// Ink geometry: turns raw pointer samples into smooth, pressure-sensitive
// outlines (similar in spirit to perfect-freehand), plus hit-testing helpers.

const cache = new WeakMap(); // item -> { path, bbox }

// Pen outline radius for a sample.
function radius(size, p) {
  return size * (0.28 + 0.72 * p) / 2 + 0.25;
}

// Light smoothing of raw points ([x,y,p,...]) to remove jitter.
export function streamline(pts, t = 0.45) {
  if (pts.length <= 6) return pts.slice();
  const out = [pts[0], pts[1], pts[2]];
  let px = pts[0], py = pts[1];
  for (let i = 3; i < pts.length; i += 3) {
    px = px + (pts[i] - px) * (1 - t);
    py = py + (pts[i + 1] - py) * (1 - t);
    out.push(px, py, pts[i + 2]);
  }
  // keep the true end point so strokes reach where the pen lifted
  const n = pts.length;
  out.push(pts[n - 3], pts[n - 2], pts[n - 1]);
  return out;
}

// Build a filled outline Path2D for a variable-width pen stroke.
export function penPath(pts, size) {
  const path = new Path2D();
  const n = pts.length / 3;
  if (n === 0) return path;
  if (n === 1 || isDot(pts)) {
    path.arc(pts[0], pts[1], radius(size, pts[2]), 0, Math.PI * 2);
    return path;
  }
  // resample: drop points closer than ~0.6px to keep outline clean
  const xs = [], ys = [], rs = [];
  let lx = Infinity, ly = Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i], y = pts[i + 1];
    if (i > 0 && i < pts.length - 3 && Math.hypot(x - lx, y - ly) < 0.6) continue;
    xs.push(x); ys.push(y); rs.push(radius(size, pts[i + 2]));
    lx = x; ly = y;
  }
  const m = xs.length;
  if (m < 2) { path.arc(xs[0], ys[0], rs[0], 0, Math.PI * 2); return path; }
  // taper start a little for a natural look
  const left = [], right = [];
  for (let i = 0; i < m; i++) {
    const a = Math.max(0, i - 1), b = Math.min(m - 1, i + 1);
    let dx = xs[b] - xs[a], dy = ys[b] - ys[a];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const r = rs[i];
    left.push(xs[i] - dy * r, ys[i] + dx * r);
    right.push(xs[i] + dy * r, ys[i] - dx * r);
  }
  // left side forward
  path.moveTo(left[0], left[1]);
  for (let i = 2; i < left.length - 2; i += 2) {
    const mx = (left[i] + left[i + 2]) / 2, my = (left[i + 1] + left[i + 3]) / 2;
    path.quadraticCurveTo(left[i], left[i + 1], mx, my);
  }
  path.lineTo(left[left.length - 2], left[left.length - 1]);
  // round end cap
  const ex = xs[m - 1], ey = ys[m - 1];
  const ea = Math.atan2(left[left.length - 1] - ey, left[left.length - 2] - ex);
  path.arc(ex, ey, rs[m - 1], ea, ea - Math.PI, true);
  // right side backward
  for (let i = right.length - 4; i >= 2; i -= 2) {
    const mx = (right[i] + right[i - 2]) / 2, my = (right[i + 1] + right[i - 1]) / 2;
    path.quadraticCurveTo(right[i], right[i + 1], mx, my);
  }
  path.lineTo(right[0], right[1]);
  // round start cap
  const sa = Math.atan2(right[1] - ys[0], right[0] - xs[0]);
  path.arc(xs[0], ys[0], rs[0], sa, sa - Math.PI, true);
  path.closePath();
  return path;
}

// Centre-line path (used for highlighter and shapes).
export function linePath(pts, closed = false) {
  const path = new Path2D();
  const n = pts.length;
  if (!n) return path;
  path.moveTo(pts[0], pts[1]);
  if (n === 3) { path.lineTo(pts[0] + 0.01, pts[1]); return path; }
  if (n <= 9) {
    for (let i = 3; i < n; i += 3) path.lineTo(pts[i], pts[i + 1]);
  } else {
    for (let i = 3; i < n - 3; i += 3) {
      const mx = (pts[i] + pts[i + 3]) / 2, my = (pts[i + 1] + pts[i + 4]) / 2;
      path.quadraticCurveTo(pts[i], pts[i + 1], mx, my);
    }
    path.lineTo(pts[n - 3], pts[n - 2]);
  }
  if (closed) path.closePath();
  return path;
}

function isDot(pts) {
  const x = pts[0], y = pts[1];
  for (let i = 3; i < pts.length; i += 3) if (Math.abs(pts[i] - x) > 1 || Math.abs(pts[i + 1] - y) > 1) return false;
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

export function itemBBox(it) {
  if (it.type === 'stroke') {
    let c = cache.get(it);
    if (!c || !c.bbox) { c = c || {}; c.bbox = strokeBBox(it.pts, it.size); cache.set(it, c); }
    return c.bbox;
  }
  if (it.type === 'text') return { x: it.x, y: it.y, w: it.w, h: it.h || it.size * 1.4 };
  return { x: it.x, y: it.y, w: it.w, h: it.h };
}

export function invalidate(it) { cache.delete(it); }

function getPath(it) {
  let c = cache.get(it);
  if (!c) { c = {}; cache.set(it, c); }
  if (!c.path) {
    if (it.tool === 'hl' || it.shape) c.path = linePath(it.pts, it.closed);
    else c.path = penPath(it.pts, it.size);
  }
  return c.path;
}

// Draw a stroke item onto ctx (already transformed to page space).
export function drawStroke(ctx, it, alpha = 1) {
  const path = getPath(it);
  ctx.save();
  if (it.tool === 'hl') {
    ctx.globalAlpha = 0.38 * alpha;
    if (!ctx.__dark) ctx.globalCompositeOperation = 'multiply';
    ctx.strokeStyle = it.color;
    ctx.lineWidth = it.size;
    ctx.lineCap = it.closed ? 'butt' : 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(path);
  } else if (it.shape) {
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = it.color;
    ctx.lineWidth = it.size * 0.75;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(path);
    if (it.fill) { ctx.globalAlpha = alpha * 0.25; ctx.fillStyle = it.color; ctx.fill(path); }
  } else {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = it.color;
    ctx.fill(path);
  }
  ctx.restore();
}

// ---- hit testing ---------------------------------------------------------

function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function strokeHit(it, x, y, r) {
  const b = itemBBox(it);
  if (x < b.x - r || x > b.x + b.w + r || y < b.y - r || y > b.y + b.h + r) return false;
  const p = it.pts, tol = r + it.size / 2;
  if (p.length === 3) return Math.hypot(p[0] - x, p[1] - y) <= tol;
  for (let i = 0; i < p.length - 3; i += 3) {
    if (distSeg(x, y, p[i], p[i + 1], p[i + 3], p[i + 4]) <= tol) return true;
  }
  if (it.closed) {
    const n = p.length;
    if (distSeg(x, y, p[n - 3], p[n - 2], p[0], p[1]) <= tol) return true;
  }
  return false;
}

// Segment-vs-stroke test so a fast eraser swipe doesn't skip strokes.
export function strokeHitSegment(it, ax, ay, bx, by, r) {
  const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / Math.max(1, r * 0.7)));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    if (strokeHit(it, ax + (bx - ax) * t, ay + (by - ay) * t, r)) return true;
  }
  return false;
}

// Insert extra points so no gap is longer than `step` (needed before splitting
// shapes, which only store their corners).
function densify(p, closed, step) {
  const src = closed ? p.concat(p.slice(0, 3)) : p;
  const out = [];
  for (let i = 0; i < src.length - 3; i += 3) {
    const ax = src[i], ay = src[i + 1], bx = src[i + 3], by = src[i + 4];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 0; k < n; k++) out.push(ax + (bx - ax) * k / n, ay + (by - ay) * k / n, src[i + 2]);
  }
  out.push(src[src.length - 3], src[src.length - 2], src[src.length - 1]);
  return out;
}

// Split a stroke where the eraser segment (a→b, radius r) touches it.
// Returns an array of point arrays (the surviving pieces).
export function splitStroke(it, ax, ay, bx, by, r) {
  const p = (it.shape || it.closed) ? densify(it.pts, it.closed, 3) : it.pts;
  const parts = [];
  let cur = [];
  const tol = r + it.size * 0.3;
  for (let i = 0; i < p.length; i += 3) {
    if (distSeg(p[i], p[i + 1], ax, ay, bx, by) <= tol) {
      if (cur.length >= 6) parts.push(cur);
      cur = [];
    } else cur.push(p[i], p[i + 1], p[i + 2]);
  }
  if (cur.length >= 6) parts.push(cur);
  return parts;
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
    return inside / total >= 0.6;
  }
  const b = itemBBox(it);
  return pointInPoly(b.x + b.w / 2, b.y + b.h / 2, poly);
}

// Transform stroke points: scale about (ox,oy) then translate.
export function transformItem(it, dx, dy, sx = 1, sy = 1, ox = 0, oy = 0) {
  if (it.type === 'stroke') {
    const p = it.pts;
    const k = Math.sqrt(Math.abs(sx * sy));
    for (let i = 0; i < p.length; i += 3) {
      p[i] = round2(ox + (p[i] - ox) * sx + dx);
      p[i + 1] = round2(oy + (p[i + 1] - oy) * sy + dy);
    }
    if (k !== 1) it.size = Math.max(0.5, it.size * k);
  } else {
    it.x = ox + (it.x - ox) * sx + dx;
    it.y = oy + (it.y - oy) * sy + dy;
    it.w = Math.max(10, it.w * sx);
    if (it.type === 'text') { it.size = Math.max(6, it.size * Math.sqrt(sx * sy)); it.h = undefined; }
    else it.h = Math.max(10, it.h * sy);
  }
  invalidate(it);
}

export const round2 = (v) => Math.round(v * 100) / 100;
