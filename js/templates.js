// Paper templates, colours and sizes.

export const SIZES = {
  letter: { w: 816, h: 1056, label: 'Letter' },
  a4: { w: 794, h: 1123, label: 'A4' },
  a5: { w: 559, h: 794, label: 'A5' },
  wide: { w: 1280, h: 720, label: '16:9' },
  square: { w: 900, h: 900, label: 'Square' },
};

export const PAPER_COLORS = [
  { id: '#ffffff', label: 'White' },
  { id: '#fbf6e6', label: 'Cream' },
  { id: '#eef4fb', label: 'Blue' },
  { id: '#eef6ee', label: 'Green' },
  { id: '#2b2d31', label: 'Slate' },
  { id: '#151618', label: 'Black' },
];

export const TEMPLATES = [
  { id: 'blank', label: 'Blank' },
  { id: 'lined', label: 'Lined' },
  { id: 'narrow', label: 'Narrow' },
  { id: 'grid', label: 'Grid' },
  { id: 'smallgrid', label: 'Fine grid' },
  { id: 'dots', label: 'Dots' },
  { id: 'cornell', label: 'Cornell' },
  { id: 'music', label: 'Music' },
];

export function isDarkPaper(color) {
  const c = (color || '#ffffff').replace('#', '');
  const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 < 110;
}

// Draw the paper of a page into ctx (page space, origin at page top-left).
export function drawPaper(ctx, page, bgImage) {
  const { w, h } = page;
  ctx.fillStyle = page.color || '#ffffff';
  ctx.fillRect(0, 0, w, h);
  if (bgImage) {
    ctx.drawImage(bgImage, 0, 0, w, h);
    return;
  }
  const dark = isDarkPaper(page.color);
  const line = dark ? 'rgba(255,255,255,0.13)' : 'rgba(60,100,170,0.20)';
  const strong = dark ? 'rgba(255,120,120,0.35)' : 'rgba(220,80,80,0.45)';
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = line;
  ctx.fillStyle = line;
  const t = page.template || 'blank';
  const hline = (y, x0 = 0, x1 = w) => { ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); };
  const vline = (x, y0 = 0, y1 = h) => { ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke(); };

  if (t === 'lined' || t === 'narrow') {
    const gap = t === 'lined' ? 34 : 26;
    for (let y = 96; y < h - 20; y += gap) hline(y);
    ctx.strokeStyle = strong;
    vline(Math.round(w * 0.11));
  } else if (t === 'grid' || t === 'smallgrid') {
    const gap = t === 'grid' ? 30 : 15;
    for (let y = gap; y < h; y += gap) hline(y);
    for (let x = gap; x < w; x += gap) vline(x);
  } else if (t === 'dots') {
    const gap = 26;
    ctx.fillStyle = dark ? 'rgba(255,255,255,0.28)' : 'rgba(40,60,90,0.32)';
    for (let y = gap; y < h; y += gap) for (let x = gap; x < w; x += gap) {
      ctx.beginPath(); ctx.arc(x, y, 1.3, 0, Math.PI * 2); ctx.fill();
    }
  } else if (t === 'cornell') {
    const gap = 32, cue = Math.round(w * 0.28), sum = h - Math.round(h * 0.2);
    for (let y = 110; y < sum; y += gap) hline(y);
    ctx.strokeStyle = strong;
    ctx.lineWidth = 1.5;
    hline(90);
    vline(cue, 90, sum);
    hline(sum);
  } else if (t === 'music') {
    const staffGap = 9, block = staffGap * 4 + 50;
    for (let y = 80; y + staffGap * 4 < h - 40; y += block) {
      for (let i = 0; i < 5; i++) hline(y + i * staffGap, 50, w - 50);
    }
  }
  ctx.restore();
}

// Small swatch preview used in the paper picker.
export function templatePreview(id, color = '#ffffff') {
  const c = document.createElement('canvas');
  const scale = 0.12;
  c.width = 816 * scale * 2; c.height = 1056 * scale * 2;
  const ctx = c.getContext('2d');
  ctx.scale(scale * 2, scale * 2);
  drawPaper(ctx, { w: 816, h: 1056, template: id, color });
  return c;
}
