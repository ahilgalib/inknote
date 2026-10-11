// Page rendering shared by the editor, thumbnails and export.
import { drawPaper, isDarkPaper } from './templates.js';
import { drawStroke, itemBBox } from './ink.js';
import { assetURL } from './db.js';
import { loadImage } from './util.js';
import { fontStack } from './fonts.js';

export function fontFor(it) {
  return `${it.italic ? 'italic ' : ''}${it.bold ? 700 : 400} ${it.size}px ${fontStack(it.font)}`;
}

export function wrapText(ctx, text, maxW) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    if (!para) { lines.push(''); continue; }
    const words = para.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const test = line + w;
      if (ctx.measureText(test).width > maxW && line.trim()) {
        lines.push(line.trimEnd());
        line = w.trimStart();
        while (ctx.measureText(line).width > maxW && line.length > 1) {
          let i = line.length;
          while (i > 1 && ctx.measureText(line.slice(0, i)).width > maxW) i--;
          lines.push(line.slice(0, i));
          line = line.slice(i);
        }
      } else line = test;
    }
    lines.push(line);
  }
  return lines;
}

let measureCtx;
export function measureText(it) {
  measureCtx = measureCtx || document.createElement('canvas').getContext('2d');
  measureCtx.font = fontFor(it);
  return Math.max(1, wrapText(measureCtx, it.text, it.w).length) * it.size * 1.3;
}

function rotated(ctx, it, h, fn) {
  if (!it.rot) return fn();
  ctx.save();
  const cx = it.x + it.w / 2, cy = it.y + h / 2;
  ctx.translate(cx, cy); ctx.rotate(it.rot); ctx.translate(-cx, -cy);
  fn();
  ctx.restore();
}

export function drawText(ctx, it, alpha = 1) {
  ctx.save();
  ctx.font = fontFor(it);
  const lines = wrapText(ctx, it.text, it.w);
  const lh = it.size * 1.3;
  it.h = Math.max(1, lines.length) * lh;
  rotated(ctx, it, it.h, () => {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = it.color;
    ctx.textBaseline = 'top';
    const align = it.align || 'left';
    ctx.textAlign = align;
    const x = align === 'center' ? it.x + it.w / 2 : align === 'right' ? it.x + it.w : it.x;
    lines.forEach((l, i) => {
      ctx.fillText(l, x, it.y + i * lh + it.size * 0.12);
      if (it.underline && l) {
        const w = ctx.measureText(l).width, x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
        ctx.fillRect(x0, it.y + i * lh + it.size * 1.12, w, Math.max(1, it.size / 16));
      }
    });
  });
  ctx.restore();
}

export function drawImageItem(ctx, it, img) {
  rotated(ctx, it, it.h, () => {
    if (img) ctx.drawImage(img, it.x, it.y, it.w, it.h);
    else { ctx.fillStyle = 'rgba(128,128,128,0.15)'; ctx.fillRect(it.x, it.y, it.w, it.h); }
  });
}

function intersects(b, c) {
  return !c || !(b.x > c.x + c.w || b.x + b.w < c.x || b.y > c.y + c.h || b.y + b.h < c.y);
}

// Draw a full page into ctx (ctx already transformed to page space).
// opts: images (Map assetId -> img), hidden (Set of ids), alpha (fn item -> alpha), cull (rect)
export function drawPage(ctx, page, opts = {}) {
  const { images = new Map(), hidden, alpha, cull } = opts;
  const bg = page.bg ? images.get(page.bg) : null;
  drawPaper(ctx, page, bg || null);
  if (page.bg && !bg) { ctx.fillStyle = 'rgba(0,0,0,0.03)'; ctx.fillRect(0, 0, page.w, page.h); }
  drawItems(ctx, page, page.items, { images, hidden, alpha, cull });
}

export function drawItems(ctx, page, items, { images = new Map(), hidden, alpha, cull } = {}) {
  ctx.__dark = isDarkPaper(page.color) && !page.bg;
  const vis = (it) => !(hidden && hidden.has(it.id)) && intersects(itemBBox(it), cull);
  // images below ink, highlighter below pen, text on top
  for (const it of items) if (it.type === 'image' && vis(it)) drawImageItem(ctx, it, images.get(it.asset));
  for (const it of items) if (it.type === 'stroke' && it.tool === 'hl' && vis(it)) drawStroke(ctx, it, alpha ? alpha(it) : 1);
  for (const it of items) if (it.type === 'stroke' && it.tool !== 'hl' && vis(it)) drawStroke(ctx, it, alpha ? alpha(it) : 1);
  for (const it of items) if (it.type === 'text' && vis(it)) drawText(ctx, it, alpha ? alpha(it) : 1);
  ctx.__dark = false;
}

// Load every image a page needs into a Map.
export async function loadPageImages(page, map = new Map()) {
  const ids = new Set();
  if (page.bg) ids.add(page.bg);
  for (const it of page.items) if (it.type === 'image') ids.add(it.asset);
  await Promise.all([...ids].map(async (id) => {
    if (map.has(id)) return;
    const url = await assetURL(id);
    if (url) { try { map.set(id, await loadImage(url)); } catch {} }
  }));
  return map;
}

// Render a page to a fresh canvas at the given scale.
export async function renderPageCanvas(page, scale) {
  const images = await loadPageImages(page);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(page.w * scale));
  c.height = Math.max(1, Math.round(page.h * scale));
  const ctx = c.getContext('2d');
  ctx.scale(scale, scale);
  drawPage(ctx, page, { images });
  return c;
}
