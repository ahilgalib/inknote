// "Draw and hold" shape recognition: a rough stroke becomes a clean
// line, arrow-free polyline, triangle, rectangle/polygon, circle or ellipse.

function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  let maxD = 0, idx = 0;
  const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
  const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / len;
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD > eps) {
    const a = rdp(pts.slice(0, idx + 1), eps);
    const b = rdp(pts.slice(idx), eps);
    return a.slice(0, -1).concat(b);
  }
  return [pts[0], pts[pts.length - 1]];
}

const flat = (arr, p = 0.5) => arr.flatMap(([x, y]) => [x, y, p]);

export function recognize(raw) {
  const P = [];
  for (let i = 0; i < raw.length; i += 3) P.push([raw[i], raw[i + 1]]);
  if (P.length < 4) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, pathLen = 0;
  for (let i = 0; i < P.length; i++) {
    const [x, y] = P[i];
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    if (i) pathLen += Math.hypot(x - P[i - 1][0], y - P[i - 1][1]);
  }
  const w = x1 - x0, hgt = y1 - y0, diag = Math.hypot(w, hgt);
  if (diag < 12) return null;
  const [sx, sy] = P[0], [ex, ey] = P[P.length - 1];
  const gap = Math.hypot(ex - sx, ey - sy);
  const closed = gap < diag * 0.22;

  if (!closed) {
    // straight line?
    if (Math.hypot(ex - sx, ey - sy) / pathLen > 0.9) {
      let [ax, ay, bx, by] = [sx, sy, ex, ey];
      // snap to horizontal / vertical / 45°
      const ang = Math.atan2(by - ay, bx - ax);
      const snap = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
      if (Math.abs(ang - snap) < 0.09) {
        const L = Math.hypot(bx - ax, by - ay);
        bx = ax + Math.cos(snap) * L; by = ay + Math.sin(snap) * L;
      }
      return { pts: flat([[ax, ay], [bx, by]]), closed: false };
    }
    const simp = rdp(P, diag * 0.06);
    if (simp.length <= 5) return { pts: flat(simp), closed: false };
    return null;
  }

  // closed: polygon or ellipse
  // RDP needs distinct end points, so split the loop at the point farthest from the start
  let far = 0, fd = 0;
  P.forEach(([x, y], i) => { const d = Math.hypot(x - sx, y - sy); if (d > fd) { fd = d; far = i; } });
  const eps = diag * 0.07;
  const half1 = rdp(P.slice(0, far + 1), eps);
  const half2 = rdp(P.slice(far).concat([P[0]]), eps);
  let corners = half1.concat(half2.slice(1, -1));
  // merge near-duplicate corners
  corners = corners.filter((c, i) => {
    const n = corners[(i + 1) % corners.length];
    return Math.hypot(c[0] - n[0], c[1] - n[1]) > diag * 0.08;
  });

  // ellipse fit quality
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = w / 2 || 1, ry = hgt / 2 || 1;
  let err = 0;
  for (const [x, y] of P) err += Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1);
  err /= P.length;

  if ((corners.length === 3 || corners.length === 4) && err > 0.09) {
    if (corners.length === 4 && isRectish(corners)) {
      return { pts: flat([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]), closed: true };
    }
    return { pts: flat(corners), closed: true };
  }
  if (err < 0.2 || corners.length > 5) {
    let rX = rx, rY = ry;
    if (Math.abs(rx - ry) / Math.max(rx, ry) < 0.12) rX = rY = (rx + ry) / 2; // snap to circle
    const pts = [];
    const N = 72;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      pts.push([cx + Math.cos(a) * rX, cy + Math.sin(a) * rY]);
    }
    return { pts: flat(pts), closed: true };
  }
  if (corners.length >= 3) return { pts: flat(corners), closed: true };
  return null;
}

function isRectish(c) {
  for (let i = 0; i < 4; i++) {
    const a = c[(i + 3) % 4], b = c[i], d = c[(i + 1) % 4];
    const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [d[0] - b[0], d[1] - b[1]];
    const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2));
    if (Math.abs(cos) > 0.3) return false;
  }
  // roughly axis-aligned?
  const ang = Math.atan2(c[1][1] - c[0][1], c[1][0] - c[0][0]);
  const mod = Math.abs(((ang % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2));
  return mod < 0.2 || mod > Math.PI / 2 - 0.2;
}
