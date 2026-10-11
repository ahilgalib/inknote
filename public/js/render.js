// Page rendering shared by the editor, thumbnails and export.
import { drawPaper, isDarkPaper } from './templates.js';
import { drawStroke, itemBBox, inkColor } from './ink.js';
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
    if (it.bg) {
      const pad = Math.max(8, it.size * 0.6);
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.22)';
      ctx.shadowBlur = 10;
      ctx.shadowOffsetY = 3;
      ctx.fillStyle = it.bg;
      ctx.fillRect(it.x - pad, it.y - pad, it.w + pad * 2, it.h + pad * 2);
      ctx.restore();
    }
    ctx.fillStyle = inkColor(it.color, it.bg ? false : ctx.__dark);
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

// Source rectangle of an image item (crop is stored as fractions 0..1).
function srcRect(img, crop) {
  const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
  if (!crop) return [0, 0, W, H];
  return [crop.x * W, crop.y * H, Math.max(1, crop.w * W), Math.max(1, crop.h * H)];
}

// Die-cut sticker: a white outline that follows the picture's shape (or a
// rounded white border for photos) with a soft shadow, like a real sticker.
const stickers = new WeakMap(); // img -> Map(cropKey -> { canvas, pad })
export function stickerFor(img, crop) {
  let m = stickers.get(img);
  if (!m) { m = new Map(); stickers.set(img, m); }
  const key = crop ? [crop.x, crop.y, crop.w, crop.h].map((v) => v.toFixed(4)).join(',') : '';
  let st = m.get(key);
  if (st) return st;
  const [sx, sy, sw, sh] = srcRect(img, crop);
  const k = Math.min(1, 900 / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * k)), hh = Math.max(1, Math.round(sh * k));
  const b = Math.max(4, Math.round(Math.max(w, hh) * 0.028));
  const pad = b * 3;
  const W = w + pad * 2, H = hh + pad * 2;
  const sil = document.createElement('canvas');
  sil.width = W; sil.height = H;
  const s = sil.getContext('2d');
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    s.drawImage(img, sx, sy, sw, sh, pad + Math.cos(a) * b, pad + Math.sin(a) * b, w, hh);
  }
  s.drawImage(img, sx, sy, sw, sh, pad, pad, w, hh);
  s.globalCompositeOperation = 'source-in';
  s.fillStyle = '#ffffff';
  s.fillRect(0, 0, W, H);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.shadowColor = 'rgba(0,0,0,0.28)';
  ctx.shadowBlur = b * 1.6;
  ctx.shadowOffsetY = b * 0.5;
  ctx.drawImage(sil, 0, 0);
  ctx.shadowColor = 'transparent';
  ctx.drawImage(img, sx, sy, sw, sh, pad, pad, w, hh);
  sil.width = sil.height = 0;
  st = { canvas: c, pad: pad / w };
  m.set(key, st);
  return st;
}

export function drawImageItem(ctx, it, img) {
  rotated(ctx, it, it.h, () => {
    if (it.flip) { ctx.translate(it.x * 2 + it.w, 0); ctx.scale(-1, 1); }
    if (!img) { ctx.fillStyle = 'rgba(128,128,128,0.15)'; ctx.fillRect(it.x, it.y, it.w, it.h); return; }
    if (it.sticker) {
      const st = stickerFor(img, it.crop);
      const f = it.w * st.pad;
      ctx.drawImage(st.canvas, it.x - f, it.y - f, it.w + f * 2, it.h + f * 2);
      return;
    }
    const [sx, sy, sw, sh] = srcRect(img, it.crop);
    ctx.drawImage(img, sx, sy, sw, sh, it.x, it.y, it.w, it.h);
  });
}

// Audio clip placed on the page: tap it to play the recording.
export function drawAudioItem(ctx, it, dark) {
  rotated(ctx, it, it.h, () => {
    const r = it.h / 2;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.18)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = dark ? '#2a3150' : '#eaf0ff';
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(it.x, it.y, it.w, it.h, r) : ctx.rect(it.x, it.y, it.w, it.h);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#3b6cf6';
    ctx.beginPath(); ctx.arc(it.x + r, it.y + r, r * 0.72, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    const cx = it.x + r + r * 0.08, cy = it.y + r, t = r * 0.3;
    ctx.beginPath(); ctx.moveTo(cx - t * 0.7, cy - t); ctx.lineTo(cx + t, cy); ctx.lineTo(cx - t * 0.7, cy + t); ctx.closePath(); ctx.fill();
    ctx.fillStyle = dark ? '#e8ecff' : '#1d2b55';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = `600 ${Math.round(it.h * 0.32)}px Inter, system-ui, sans-serif`;
    const label = it.label || 'Audio';
    const maxW = it.w - it.h - r * 0.6;
    let text = label;
    while (text.length > 1 && ctx.measureText(text).width > maxW) text = text.slice(0, -1);
    if (text !== label) text = text.slice(0, -1) + '…';
    ctx.fillText(text, it.x + it.h + 2, it.y + r - (it.dur ? it.h * 0.12 : 0));
    if (it.dur) {
      ctx.globalAlpha = 0.7;
      ctx.font = `${Math.round(it.h * 0.24)}px Inter, system-ui, sans-serif`;
      const m = Math.floor(it.dur / 60), sec = Math.floor(it.dur % 60);
      ctx.fillText(`${m}:${String(sec).padStart(2, '0')}`, it.x + it.h + 2, it.y + r + it.h * 0.2);
      ctx.globalAlpha = 1;
    }
  });
}

// Bounding box including decorations (sticker border, shadows).
export function visualBBox(it) {
  const b = itemBBox(it);
  if (it.type === 'image' && it.sticker) { const p = Math.max(b.w, b.h) * 0.1 + 4; return { x: b.x - p, y: b.y - p, w: b.w + p * 2, h: b.h + p * 2 }; }
  if (it.type === 'audio') return { x: b.x - 8, y: b.y - 6, w: b.w + 16, h: b.h + 14 };
  if (it.type === 'text' && it.bg) { const p = Math.max(8, it.size * 0.6) + 14; return { x: b.x - p, y: b.y - p, w: b.w + p * 2, h: b.h + p * 2 }; }
  return b;
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
  const dark = ctx.__dark;
  const vis = (it) => !(hidden && hidden.has(it.id)) && intersects(visualBBox(it), cull);
  // images & audio clips below ink, highlighter below pen, text on top
  for (const it of items) {
    if (it.type === 'image' && vis(it)) drawImageItem(ctx, it, images.get(it.asset));
    else if (it.type === 'audio' && vis(it)) drawAudioItem(ctx, it, dark);
  }
  for (const it of items) if (it.type === 'stroke' && it.tool === 'hl' && vis(it)) drawStroke(ctx, it, alpha ? alpha(it) : 1);
  for (const it of items) if (it.type === 'stroke' && it.tool !== 'hl' && it.tool !== 'tape' && vis(it)) drawStroke(ctx, it, alpha ? alpha(it) : 1);
  for (const it of items) if (it.type === 'text' && vis(it)) drawText(ctx, it, alpha ? alpha(it) : 1);
  // study tape covers everything under it
  for (const it of items) if (it.type === 'stroke' && it.tool === 'tape' && vis(it)) drawStroke(ctx, it, alpha ? alpha(it) : 1);
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
