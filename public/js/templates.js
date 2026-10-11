// Paper sizes, colours, basic papers and detailed planner templates.
// Every template is drawn as vector graphics, so it stays sharp at any zoom
// and can be customised (accent colour, paper colour, heading text).

export const SIZES = {
  letter: { w: 816, h: 1056, label: 'Letter' },
  a4: { w: 794, h: 1123, label: 'A4' },
  a5: { w: 559, h: 794, label: 'A5' },
  letterL: { w: 1056, h: 816, label: 'Letter landscape' },
  a4L: { w: 1123, h: 794, label: 'A4 landscape' },
  wide: { w: 1280, h: 720, label: '16:9 slides' },
  square: { w: 900, h: 900, label: 'Square' },
};

export const PAPER_COLORS = [
  { id: '#ffffff', label: 'White' },
  { id: '#fbf6e6', label: 'Cream' },
  { id: '#fdf3ec', label: 'Peach' },
  { id: '#eef4fb', label: 'Blue' },
  { id: '#eef6ee', label: 'Green' },
  { id: '#f3eefb', label: 'Lilac' },
  { id: '#2b2d31', label: 'Slate' },
  { id: '#141416', label: 'Black' },
];

export const ACCENTS = ['#3f6fd1', '#7a3b2e', '#c4572e', '#2f8f5b', '#7b4fc9', '#d1416f', '#1d1d1f', '#0e8a9a'];

const F = {
  serif: '"Playfair Display", Georgia, "Times New Roman", serif',
  script: '"Kaushan Script", "Brush Script MT", "Segoe Script", cursive',
  sans: 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
};
export const TEMPLATE_FONTS = ['Playfair Display:wght@700', 'Kaushan Script', 'Inter:wght@400;600;700'];

export function isDarkPaper(color) {
  const c = (color || '#ffffff').replace('#', '');
  const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 < 110;
}

function hexA(hex, a) {
  const c = hex.replace('#', '');
  const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

// ---------------------------------------------------------------- papers ---

export const PAPERS = [
  { id: 'blank', label: 'Blank' },
  { id: 'lined', label: 'Lined' },
  { id: 'narrow', label: 'Narrow ruled' },
  { id: 'college', label: 'College ruled' },
  { id: 'grid', label: 'Grid' },
  { id: 'smallgrid', label: 'Fine grid' },
  { id: 'dots', label: 'Dots' },
  { id: 'cornell', label: 'Cornell' },
  { id: 'music', label: 'Music' },
  { id: 'isometric', label: 'Isometric' },
  { id: 'storyboard', label: 'Storyboard' },
  { id: 'todo', label: 'To-do list' },
];

function drawBasic(ctx, t, w, h, dark) {
  const line = dark ? 'rgba(255,255,255,0.14)' : 'rgba(60,100,170,0.22)';
  const strong = dark ? 'rgba(255,120,120,0.4)' : 'rgba(220,80,80,0.45)';
  ctx.lineWidth = 1;
  ctx.strokeStyle = line;
  ctx.fillStyle = line;
  const hl = (y, x0 = 0, x1 = w) => { ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); };
  const vl = (x, y0 = 0, y1 = h) => { ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke(); };
  if (t === 'lined' || t === 'narrow' || t === 'college') {
    const gap = t === 'lined' ? 34 : t === 'college' ? 28 : 24;
    for (let y = 96; y < h - 20; y += gap) hl(y);
    ctx.strokeStyle = strong;
    vl(Math.round(w * 0.11));
  } else if (t === 'grid' || t === 'smallgrid') {
    const gap = t === 'grid' ? 30 : 15;
    for (let y = gap; y < h; y += gap) hl(y);
    for (let x = gap; x < w; x += gap) vl(x);
  } else if (t === 'dots') {
    const gap = 26;
    ctx.fillStyle = dark ? 'rgba(255,255,255,0.3)' : 'rgba(40,60,90,0.32)';
    for (let y = gap; y < h; y += gap) for (let x = gap; x < w; x += gap) { ctx.beginPath(); ctx.arc(x, y, 1.3, 0, 7); ctx.fill(); }
  } else if (t === 'cornell') {
    const gap = 32, cue = Math.round(w * 0.28), sum = h - Math.round(h * 0.2);
    for (let y = 110; y < sum; y += gap) hl(y);
    ctx.strokeStyle = strong; ctx.lineWidth = 1.5;
    hl(90); vl(cue, 90, sum); hl(sum);
  } else if (t === 'music') {
    const g = 9, block = g * 4 + 50;
    for (let y = 80; y + g * 4 < h - 40; y += block) for (let i = 0; i < 5; i++) hl(y + i * g, 50, w - 50);
  } else if (t === 'isometric') {
    const s = 30, hh = s * Math.sqrt(3) / 2;
    ctx.fillStyle = dark ? 'rgba(255,255,255,0.3)' : 'rgba(40,60,90,0.35)';
    for (let r = 0, y = 15; y < h; r++, y += hh) for (let x = (r % 2 ? s / 2 : 0) + 10; x < w; x += s) { ctx.beginPath(); ctx.arc(x, y, 1.2, 0, 7); ctx.fill(); }
  } else if (t === 'storyboard') {
    const cols = w > h ? 3 : 2, rows = w > h ? 2 : 3, m = 40, gx = 28;
    const cw = (w - m * 2 - gx * (cols - 1)) / cols, ch = (h - m * 2) / rows - 60;
    ctx.strokeStyle = dark ? 'rgba(255,255,255,0.35)' : 'rgba(30,30,30,0.45)';
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x = m + c * (cw + gx), y = m + r * (ch + 60);
      ctx.strokeRect(x, y, cw, ch);
      ctx.strokeStyle = line; hl(y + ch + 22, x, x + cw); hl(y + ch + 44, x, x + cw);
      ctx.strokeStyle = dark ? 'rgba(255,255,255,0.35)' : 'rgba(30,30,30,0.45)';
    }
  } else if (t === 'todo') {
    for (let y = 110; y < h - 40; y += 40) {
      hl(y, 90, w - 50);
      ctx.strokeRect(54, y - 24, 18, 18);
    }
  }
}

// ---------------------------------------------------------------- planners ---

const DAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

function kit(ctx, T) {
  const k = {
    text(str, x, y, { size = 11, font = 'sans', weight = 400, color = T.ink, align = 'left', italic = false } = {}) {
      ctx.font = `${italic ? 'italic ' : ''}${weight} ${size}px ${F[font]}`;
      ctx.fillStyle = color;
      ctx.textAlign = align;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(str, x, y);
    },
    label(str, x, y, opts = {}) {
      ctx.save();
      try { ctx.letterSpacing = '1.4px'; } catch {}
      k.text(str.toUpperCase(), x, y, { size: 8.5, weight: 700, color: T.label, ...opts });
      ctx.restore();
    },
    title(str, x, y, opts = {}) {
      if (T.style === 'script') k.text(str, x, y, { size: 38, font: 'script', color: T.accent, ...opts });
      else k.text(str, x, y, { size: 24, font: 'serif', weight: 700, color: T.ink, ...opts });
    },
    line(x1, y1, x2, y2, color = T.line, width = 1) {
      ctx.strokeStyle = color; ctx.lineWidth = width;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    },
    rect(x, y, w, h, { stroke = T.line, fill = null, width = 1, radius = 0 } = {}) {
      ctx.beginPath();
      if (radius && ctx.roundRect) ctx.roundRect(x, y, w, h, radius); else ctx.rect(x, y, w, h);
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = width; ctx.stroke(); }
    },
    ruled(x, y, w, h, gap = 26, color = T.line) { for (let yy = y + gap; yy <= y + h + 0.5; yy += gap) k.line(x, yy, x + w, yy, color); },
    header(str, x, y, w) { k.label(str, x, y); k.line(x, y + 7, x + w, y + 7, T.accent, 1.4); },
    field(label, x, y, x2) { k.text(label, x, y, { size: 9.5, color: T.label }); const lw = k.measure(label, { size: 9.5 }) + 6; k.line(x + lw, y + 2, x2, y + 2, T.line); },
    measure(str, { size = 11, font = 'sans', weight = 400 } = {}) { ctx.font = `${weight} ${size}px ${F[font]}`; return ctx.measureText(str).width; },
    days(x, y) {
      DAYS.forEach((d, i) => {
        ctx.beginPath(); ctx.arc(x + i * 19, y, 7.5, 0, 7); ctx.strokeStyle = T.accent; ctx.lineWidth = 0.9; ctx.stroke();
        k.text(d, x + i * 19, y + 3, { size: 7.5, weight: 600, color: T.accent, align: 'center' });
      });
    },
    check(x, y, s = 11) { k.rect(x, y, s, s, { stroke: T.accent, radius: 2 }); },
    checklist(x, y, w, h, gap = 26) {
      for (let yy = y + gap; yy <= y + h + 0.5; yy += gap) { k.check(x, yy - 14); k.line(x + 20, yy, x + w, yy); }
    },
    table(x, y, cols, rows, rowH, w) {
      const total = cols.reduce((a, c) => a + c[1], 0);
      k.rect(x, y, w, rowH * (rows + 1), { stroke: T.accent });
      k.rect(x, y, w, rowH, { stroke: null, fill: T.soft });
      let cx = x;
      cols.forEach(([name, part], i) => {
        k.label(name, cx + 6, y + rowH / 2 + 3);
        cx += (part / total) * w;
        if (i < cols.length - 1) k.line(cx, y, cx, y + rowH * (rows + 1), T.accent);
      });
      for (let r = 1; r <= rows; r++) k.line(x, y + rowH * r, x + w, y + rowH * r, r === 1 ? T.accent : T.line);
    },
    blob(x, y, r, color) {
      const g = ctx.createRadialGradient(x, y, r * 0.1, x, y, r);
      g.addColorStop(0, color); g.addColorStop(1, hexA('#ffffff', 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    },
    dotsIn(x, y, w, h, gap = 16) {
      ctx.fillStyle = T.line;
      for (let yy = y + gap; yy < y + h; yy += gap) for (let xx = x + gap; xx < x + w; xx += gap) { ctx.beginPath(); ctx.arc(xx, yy, 1, 0, 7); ctx.fill(); }
    },
    grid(x, y, w, h, cols, rows, color = T.line) {
      for (let c = 0; c <= cols; c++) k.line(x + (w * c) / cols, y, x + (w * c) / cols, y + h, color);
      for (let r = 0; r <= rows; r++) k.line(x, y + (h * r) / rows, x + w, y + (h * r) / rows, color);
    },
  };
  return k;
}

// Each planner draws in a 816-wide coordinate space; H is the scaled height.
export const PLANNERS = [
  { id: 'assignment', label: 'Assignment Planner', theme: 'blue', draw(k, H, T) {
    const M = 48;
    k.title(T.title || 'Assignment Planner', M, 78);
    k.header('Details', M, 120, 330);
    k.field('Assignment:', M, 150, M + 330);
    k.line(M, 178, M + 330, 178);
    k.field('Start date:', M, 206, M + 160); k.field('Due:', M + 175, 206, M + 330);
    k.header('Resources', M, 250, 330);
    k.ruled(M, 262, 330, 230);
    k.header('Tasks', M, 530, 330);
    k.checklist(M, 542, 330, H - 600);
    k.label('Free space', 420, 120); k.text('(for sketches, notes, brainstorming)', 490, 120, { size: 8, color: T.label });
    k.rect(420, 132, 348, H - 180, { stroke: T.accent, width: 1.2 });
    k.dotsIn(420, 132, 348, H - 180, 18);
    k.text('Add text, ink, or images!', 436, 158, { size: 11, color: T.muted });
  } },
  { id: 'dailyGoals', label: 'Daily Goals', theme: 'warm', draw(k, H, T) {
    const M = 48;
    k.blob(700, 70, 170, T.blob);
    k.title(T.title || 'Daily Goals', M, 92);
    k.field('Date:', 600, 70, 768); k.days(612, 96);
    const box = (y, h, lbl) => { k.rect(M, y, 720, h, { stroke: T.accent, width: 1.1 }); k.text('◆  ' + lbl, M + 12, y + 22, { size: 10, weight: 600, color: T.accent }); };
    const h3 = (H - 170) / 3;
    box(130, h3 - 14, 'Morning intentions:');
    box(130 + h3, h3 - 14, 'Midday affirmations:');
    box(130 + h3 * 2, h3 - 14, 'Evening reflection:');
  } },
  { id: 'gratitude', label: 'Daily Gratitude', theme: 'warm', draw(k, H, T) {
    const M = 48;
    k.blob(720, 60, 160, T.blob);
    k.title(T.title || 'Daily Gratitude', M, 92);
    k.field('Date:', 600, 70, 768); k.days(612, 96);
    const half = (H - 160) / 2;
    k.text('♥  Gratitude:', M, 150, { size: 10, weight: 600, color: T.accent });
    k.text('what are you thankful for?', M + 82, 150, { size: 9, color: T.label });
    k.ruled(M, 160, 400, half - 40, 28, T.lineWarm);
    k.rect(470, 132, 298, half - 10, { stroke: T.accent });
    k.text('Draw what makes you thankful', 482, 152, { size: 9.5, color: T.muted });
    const y2 = 140 + half;
    k.text('✿  Accomplishments:', M, y2 + 10, { size: 10, weight: 600, color: T.accent });
    k.text('what did you achieve (big or small)?', M + 128, y2 + 10, { size: 9, color: T.label });
    k.ruled(M, y2 + 20, 400, half - 60, 28, T.lineWarm);
    k.rect(470, y2 - 8, 298, half - 30, { stroke: T.accent });
    k.text('Draw an achievement', 482, y2 + 12, { size: 9.5, color: T.muted });
  } },
  { id: 'health', label: 'Daily Health Tracker', theme: 'green', draw(k, H, T) {
    const M = 48;
    const o = { size: 20, weight: 700 };
    const parts = [['DAILY ', T.ink], ['HEALTH', T.accent], [' TRACKER', T.ink]];
    let tx = 408 - parts.reduce((a, [p]) => a + k.measure(p, o), 0) / 2;
    for (const [p, c] of parts) { k.text(p, tx, 72, { ...o, color: c }); tx += k.measure(p, o); }
    k.text('/        /', 408, 98, { size: 11, color: T.label, align: 'center' });
    k.line(M, 112, 768, 112);
    const top = 128, rowH = (H - top - 40) / 7, cols = [['Meals', '#e6f6ea'], ['Movement', '#fde9dc'], ['Water', '#e3f8fb']];
    const x0 = M + 30, cw = (720 - 30) / 3;
    cols.forEach(([name, fill], i) => {
      k.rect(x0 + i * cw, top, cw, rowH * 7, { stroke: null, fill });
      k.label(name, x0 + i * cw + cw / 2, top + 18, { align: 'center' });
    });
    ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].forEach((d, i) => {
      k.rect(M, top + i * rowH, 30, rowH, { stroke: null, fill: T.soft });
      k.label(d, M + 15, top + i * rowH + rowH / 2 + 3, { align: 'center' });
      k.line(M, top + (i + 1) * rowH, 768, top + (i + 1) * rowH, '#ffffff', 2);
    });
    for (let i = 1; i < 3; i++) k.line(x0 + i * cw, top, x0 + i * cw, top + rowH * 7, '#ffffff', 2);
  } },
  { id: 'itinerary', label: 'Daily Itinerary', theme: 'blue', draw(k, H, T) {
    const M = 48;
    k.title(T.title || 'Daily Itinerary', M, 74);
    k.field('Destination:', 520, 70, 768);
    const half = (H - 120) / 2;
    [0, 1].forEach((i) => {
      const y = 104 + i * half;
      k.field('Date', M, y, M + 200);
      k.table(M, y + 16, [['Time', 1], ['Location', 2], ['Details', 2.4]], Math.floor((half - 70) / 30), 30, 720);
    });
  } },
  { id: 'journal', label: 'Daily Journal', theme: 'warm', draw(k, H, T) {
    const M = 48;
    k.blob(690, 80, 200, T.blob);
    k.title(T.title || 'Daily Journal', M, 92);
    k.field('Date:', 600, 70, 768); k.days(612, 96);
    k.ruled(M, 130, 720, H - 180, 28, T.lineWarm);
  } },
  { id: 'plannerDark', label: 'Daily Planner (Dark)', theme: 'dark', draw: (k, H, T) => dailyPlanner(k, H, T) },
  { id: 'plannerLight', label: 'Daily Planner (Light)', theme: 'blue', draw: (k, H, T) => dailyPlanner(k, H, T) },
  { id: 'tasks', label: 'Daily Tasks', theme: 'warm', draw(k, H, T) {
    const M = 48;
    k.blob(700, 70, 170, T.blob);
    k.title(T.title || 'Daily Tasks', M, 92);
    k.field('Date:', 600, 70, 768); k.days(612, 96);
    const bh = (H - 200) * 0.45;
    k.rect(M, 130, 720, bh, { stroke: null, fill: T.soft, radius: 6 });
    k.text('1. Brain dump', 408, 154, { size: 11, weight: 600, color: T.accent, align: 'center' });
    k.text('what is on your mind?', 408, 170, { size: 9, color: T.label, align: 'center' });
    const y2 = 150 + bh;
    k.text('2. Prioritize', 408, y2 + 10, { size: 11, weight: 600, color: T.accent, align: 'center' });
    k.label('Must do', M, y2 + 40); k.checklist(M, y2 + 46, 350, (H - y2 - 100) * 0.55);
    k.label('Nice to do', 418, y2 + 40); k.checklist(418, y2 + 46, 350, (H - y2 - 100) * 0.55);
    const y3 = y2 + 70 + (H - y2 - 100) * 0.55;
    k.text('3. Notes', 408, y3, { size: 11, weight: 600, color: T.accent, align: 'center' });
    k.ruled(M, y3 + 6, 720, H - y3 - 50, 26, T.lineWarm);
  } },
  { id: 'finance', label: 'Finance Planner', theme: 'blue', draw(k, H, T) {
    const M = 48;
    k.title(T.title || 'Monthly Finance Tracker', M, 74);
    k.field('Month:', 560, 70, 768);
    const lw = 400, rx = M + lw + 24, rw = 768 - rx;
    const fix = Math.floor((H * 0.42) / 26);
    k.label('Fixed expenses', M, 110);
    k.table(M, 118, [['Date', 1], ['Pay to', 2], ['Amount', 1.3]], fix, 26, lw);
    let y = 118 + 26 * (fix + 1);
    k.field('Total', M + 6, y + 18, M + lw);
    k.label('Variable expenses', M, y + 50);
    const vr = Math.floor((H - y - 140) / 26);
    k.table(M, y + 58, [['Date', 1], ['Description', 2], ['Amount', 1.3]], vr, 26, lw);
    k.field('Total', M + 6, y + 58 + 26 * (vr + 1) + 18, M + lw);
    k.label('Income', rx, 110);
    const ir = Math.floor((H * 0.3) / 26);
    k.table(rx, 118, [['Date', 1], ['Source', 1.6], ['Amount', 1.3]], ir, 26, rw);
    let y2 = 118 + 26 * (ir + 1);
    k.field('Total', rx + 6, y2 + 18, rx + rw);
    k.label('Savings', rx, y2 + 50);
    const sr = Math.floor((H - y2 - 140) / 26);
    k.table(rx, y2 + 58, [['For', 2], ['Amount', 1.2]], sr, 26, rw);
  } },
  { id: 'flashcard', label: 'Flashcard Deck', theme: 'warm', draw(k, H, T) {
    const M = 40;
    k.ruled(0, 20, 816, H - 30, 30, T.lineWarm);
    k.rect(M, 70, 300, H * 0.42, { stroke: T.ink, fill: hexA(T.accent, 0.28), width: 1.4 });
    k.text('[ image ]', M + 150, 70 + H * 0.21, { size: 14, color: T.muted, align: 'center', italic: true });
    k.label('Term', 380, 92);
    k.title(T.title || 'Term', 380, 140, { size: 34 });
    k.line(380, 156, 776, 156, T.accent, 2);
    k.label('Definition', 380, 196);
    k.label('Example / notes', M, 110 + H * 0.42);
    k.rect(736, H - 70, 40, 30, { stroke: null, fill: hexA(T.accent, 0.3), radius: 3 });
    k.text('#', 756, H - 50, { size: 13, weight: 700, color: T.ink, align: 'center' });
  } },
  { id: 'goal', label: 'Goal Setting', theme: 'blue', draw(k, H, T) {
    const M = 48;
    k.title(T.title || 'Goal Setting', M, 74);
    k.field('Target date:', 560, 70, 768);
    k.rect(M, 104, 330, 220, { stroke: null, fill: T.soft });
    k.label('My goal', M + 12, 122);
    k.label('Why?', M, 360); k.line(M, 367, M + 330, 367, T.accent, 1.4);
    k.ruled(M, 370, 330, 260, 26);
    k.label('Milestones', M, 670); k.line(M, 677, M + 330, 677, T.accent, 1.4);
    k.checklist(M, 680, 330, H - 740);
    k.label('Action steps', 420, 104 + 8); k.line(420, 119, 768, 119, T.accent, 1.4);
    k.line(452, 119, 452, H - 50, T.line);
    k.ruled(420, 122, 348, H - 172, 26);
  } },
  { id: 'habit', label: 'Habit Tracker', theme: 'warm', draw(k, H, T, ctx) {
    const M = 48;
    k.blob(700, 70, 180, T.blob);
    k.title(T.title || 'Habit Tracker', M, 92);
    k.field('Month:', 560, 80, 768);
    k.label('Daily habits', M, 150);
    for (let i = 1; i <= 8; i++) { k.text(i + '.', M, 150 + i * 30, { size: 10, color: T.accent }); k.line(M + 16, 152 + i * 30, M + 260, 152 + i * 30, T.lineWarm); }
    // radial tracker: 8 rings × 31 days
    const cx = 408, cy = H - 70, r0 = 70, r1 = Math.min(380, cy - 440);
    ctx.strokeStyle = T.lineWarm; ctx.lineWidth = 1;
    for (let i = 0; i <= 8; i++) { const r = r0 + ((r1 - r0) * i) / 8; ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI, 0); ctx.stroke(); }
    for (let d = 0; d <= 31; d++) {
      const a = Math.PI + (Math.PI * d) / 31;
      ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); ctx.stroke();
      if (d < 31) { const am = Math.PI + (Math.PI * (d + 0.5)) / 31; k.text(String(d + 1), cx + Math.cos(am) * (r1 + 12), cy + Math.sin(am) * (r1 + 12) + 3, { size: 7.5, color: T.accent, align: 'center' }); }
    }
    for (let i = 0; i < 8; i++) { const r = r0 + ((r1 - r0) * (i + 0.5)) / 8; k.text(String(i + 1), cx - r, cy + 14, { size: 8, color: T.accent, align: 'center' }); }
  } },
  { id: 'mindmap', label: 'Mind Map', theme: 'blue', draw(k, H, T) {
    const M = 48;
    k.title(T.title || 'Mind Map', M, 74);
    k.field('Topic:', 520, 70, 768);
    const bw = 170, bh = 110, cx = 408, cy = H * 0.58;
    const box = (x, y, w, h, lbl) => { k.rect(x, y, w, h, { stroke: T.accent, fill: T.paper }); k.rect(x, y, w, 20, { stroke: T.accent, fill: T.soft }); if (lbl) k.label(lbl, x + w / 2, y + 14, { align: 'center' }); };
    const nodes = [[M + 10, 120], [cx - bw / 2, 120], [768 - bw - 10, 120], [M + 10, cy - 30], [768 - bw - 10, cy - 30], [M + 10, H - 190], [768 - bw - 10, H - 190]];
    nodes.forEach(([x, y]) => k.line(x + bw / 2, y + bh / 2, cx, cy + 35, T.accent, 1.2));
    box(cx - 120, cy, 240, 80, 'Main topic');
    nodes.forEach(([x, y]) => box(x, y, bw, bh, 'Sub-topic'));
  } },
  { id: 'monthly', label: 'Monthly Planner', theme: 'blue', draw(k, H, T) {
    const M = 40;
    k.title(T.title || 'Monthly Planner', M, 70);
    k.field('Month:', 560, 66, 776);
    const top = 96, w = 816 - M * 2, cw = w / 7, rh = (H - top - 50) / 6;
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach((d, i) => k.label(d, M + i * cw + cw / 2, top + 14, { align: 'center' }));
    k.line(M, top + 24, M + w, top + 24, T.accent, 1.4);
    k.grid(M, top + 24, w, rh * 6, 7, 6);
  } },
  { id: 'selfcare', label: 'Self Care Checklist', theme: 'warm', draw(k, H, T, ctx) {
    const M = 48;
    k.blob(720, 70, 170, T.blob);
    k.blob(700, H - 120, 160, T.blob);
    k.title(T.title || 'Self Care Checklist', M, 92);
    k.field('Date:', 600, 70, 768); k.days(612, 96);
    k.rect(M, 124, 720, 76, { stroke: null, fill: T.soft, radius: 6 });
    const cols = ['Mood', 'Weather', 'Meals', 'Water intake'];
    cols.forEach((c, i) => {
      const x = M + i * 180;
      k.text(c, x + 90, 146, { size: 10, weight: 600, color: T.accent, align: 'center' });
      const n = i === 3 ? 8 : i === 2 ? 3 : 4;
      for (let j = 0; j < n; j++) { ctx.beginPath(); ctx.arc(x + 90 - ((n - 1) * 18) / 2 + j * 18, 176, 6.5, 0, 7); ctx.strokeStyle = T.accent; ctx.lineWidth = 0.9; ctx.stroke(); }
    });
    const qs = [
      ['Did you interact with people today?', 'YES  NO'], ['If you did, how full is your social battery?', 'NEARLY FULL · HALF · DRAINED'],
      ['How much time did you spend on your phone?', ''], ['Did you exercise?', 'YES  NO'], ['If you did, for how long?', ''],
      ['What was your activity?', ''], ['Did you take a nap?', 'YES  NO'], ['How is your appetite?', 'GOOD · FINE · BAD'],
      ['What made you smile today?', ''], ['One kind thing you did for yourself:', ''],
    ];
    let y = 236;
    const gap = Math.min(64, (H - 290) / qs.length);
    qs.forEach(([q, opts]) => {
      k.text('✦', M, y, { size: 10, color: T.accent });
      k.text(q, M + 16, y, { size: 10.5, color: T.ink });
      if (opts) k.text(opts, 768, y, { size: 8.5, weight: 600, color: T.accent, align: 'right' });
      k.line(M + 16, y + gap * 0.55, 768, y + gap * 0.55, T.lineWarm);
      y += gap;
    });
  } },
  { id: 'semester', label: 'Semester Overview', theme: 'blue', draw(k, H, T) {
    const M = 40;
    k.title(T.title || 'Semester Overview', M, 70);
    k.field('Start date:', 470, 66, 610); k.field('End date:', 625, 66, 776);
    k.label('Weekly breakdown', M, 108); k.line(M, 115, M + 200, 115, T.accent, 1.4);
    const rows = 16, rh = (H - 170) / rows;
    for (let i = 0; i < rows; i++) { k.text(String(i + 1).padStart(2, '0'), M, 118 + rh * (i + 1) - 6, { size: 8.5, color: T.label }); k.line(M, 118 + rh * (i + 1), M + 200, 118 + rh * (i + 1)); }
    const gx = 270, gw = 776 - gx;
    k.label('My schedule', gx, 108);
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], hours = 14, hh = (H - 190) / hours, cw = (gw - 30) / 7;
    k.rect(gx, 118, gw, 22 + hh * hours, { stroke: T.accent });
    days.forEach((d, i) => k.label(d, gx + 30 + i * cw + cw / 2, 133, { align: 'center' }));
    k.line(gx, 140, gx + gw, 140, T.accent);
    for (let i = 0; i < hours; i++) { k.text(String(7 + i).padStart(2, '0'), gx + 6, 140 + hh * i + 14, { size: 8.5, color: T.label }); k.line(gx, 140 + hh * (i + 1), gx + gw, 140 + hh * (i + 1)); }
    for (let i = 0; i <= 7; i++) k.line(gx + 30 + i * cw, 118, gx + 30 + i * cw, 140 + hh * hours);
  } },
  { id: 'sleep', label: 'Sleep Journal', theme: 'warm', draw(k, H, T, ctx) {
    const M = 48;
    k.blob(700, 70, 180, T.blob);
    k.title(T.title || 'Sleep Journal', M, 92);
    k.field('Date:', 600, 70, 768); k.days(612, 96);
    k.field('☾  Bed time:', M, 140, 320); k.field('☀  Wake up:', 350, 140, 640);
    const qs = ['Did you stick to your typical sleep schedule?   YES  NO', 'How did you sleep?   GREAT · FINE · BAD', 'Describe your sleep scenario:'];
    let y = 186;
    qs.forEach((q) => { k.text('◆  ' + q, M, y, { size: 10.5 }); y += 34; });
    k.ruled(M + 16, y - 24, 540, 210, 26, T.lineWarm);
    y += 210;
    ['Did you look at your phone or TV before bed?   YES  NO', 'Did you drink anything before bed?   YES  NO', 'Did you wake up in the middle of the night?   YES  NO', 'Dreams I remember:'].forEach((q) => { k.text('◆  ' + q, M, y, { size: 10.5 }); y += 34; });
    k.ruled(M + 16, y - 24, 540, Math.max(60, H - y - 40), 26, T.lineWarm);
    k.rect(640, 170, 128, H - 220, { stroke: null, fill: T.soft, radius: 8 });
    k.text('Hours', 704, 194, { size: 10, weight: 600, color: T.accent, align: 'center' });
    const n = 12, gap = (H - 270) / n;
    for (let i = 0; i < n; i++) { ctx.beginPath(); ctx.arc(704, 220 + i * gap, 9, 0, 7); ctx.strokeStyle = T.accent; ctx.lineWidth = 0.9; ctx.stroke(); k.text(String(i + 1), 704, 224 + i * gap, { size: 8, color: T.accent, align: 'center' }); }
  } },
  { id: 'travelJournal', label: 'Travel Journal', theme: 'blue', draw(k, H, T) {
    const M = 48;
    k.title(T.title || 'Travel Journal', M, 74);
    k.field('Location:', 420, 70, 590); k.field('Dates:', 605, 70, 768);
    const bh = H * 0.62;
    k.rect(M, 100, 720, bh, { stroke: T.line, width: 1.2 });
    k.text('Photos, tickets, sketches…', M + 360, 100 + bh / 2, { size: 11, color: T.muted, align: 'center', italic: true });
    k.grid(M, 120 + bh, 720, H - bh - 160, 36, Math.round((H - bh - 160) / 20));
  } },
  { id: 'travelPlanner', label: 'Travel Planner', theme: 'blue', draw(k, H, T) {
    const M = 48;
    k.title(T.title || 'Travel Planner', M, 74);
    k.field('Destination:', 420, 70, 620); k.field('Dates:', 632, 70, 768);
    const kv = (x, y, w, title, rows) => {
      k.label(title, x, y);
      k.rect(x, y + 8, w, rows.length * 28, { stroke: T.accent });
      rows.forEach((r, i) => {
        k.rect(x, y + 8 + i * 28, 110, 28, { stroke: null, fill: T.soft });
        k.label(r, x + 8, y + 26 + i * 28);
        if (i) k.line(x, y + 8 + i * 28, x + w, y + 8 + i * 28);
      });
      k.line(x + 110, y + 8, x + 110, y + 8 + rows.length * 28, T.accent);
      return y + 8 + rows.length * 28;
    };
    const yl = kv(M, 108, 350, 'Flight', ['Airline', 'Confirmation', 'Flight no.', 'Depart', 'Arrive', 'Flight no.', 'Depart', 'Arrive']);
    let yr = kv(418, 108, 350, 'Lodging', ['Name', 'Location', 'Dates', 'Check in / out']);
    yr = kv(418, yr + 30, 350, 'Car', ['Company', 'Confirmation', 'Pick up / return']);
    const y3 = Math.max(yl, yr) + 40;
    k.header('Packing checklist', M, y3, 350); k.checklist(M, y3 + 12, 350, H - y3 - 60);
    k.header('Before I leave to-do list', 418, y3, 350); k.checklist(418, y3 + 12, 350, H - y3 - 60);
  } },
  { id: 'twoColumn', label: 'Two Column Note', theme: 'blue', draw(k, H, T) {
    const M = 48;
    k.ruled(M, 60, 340, H - 110, 28);
    k.ruled(428, 60, 340, H - 110, 28);
  } },
  { id: 'weekly', label: 'Weekly Planner', theme: 'blue', draw(k, H, T) {
    const M = 48;
    k.title(T.title || 'Weekly Planner', M, 74);
    k.field('Week of:', 560, 70, 768);
    const half = (H - 160) / 2;
    k.header('To do', M, 112, 300); k.line(M + 280, 119, M + 280, 112 + half, T.line);
    k.ruled(M, 120, 300, half - 20, 26);
    k.header('Assignments / to study', M, 140 + half, 300); k.line(M + 280, 147 + half, M + 280, H - 50, T.line);
    k.ruled(M, 148 + half, 300, half - 40, 26);
    k.label('Schedule', 380, 112);
    const days = ['M', 'T', 'W', 'T', 'F', 'S', 'S'], rh = (H - 170) / 7;
    k.rect(380, 120, 388, rh * 7, { stroke: T.accent });
    days.forEach((d, i) => {
      k.rect(380, 120 + i * rh, 26, rh, { stroke: null, fill: T.soft });
      k.label(d, 393, 120 + i * rh + rh / 2 + 3, { align: 'center' });
      if (i) k.line(380, 120 + i * rh, 768, 120 + i * rh, T.accent);
    });
    k.line(406, 120, 406, 120 + rh * 7, T.accent);
  } },
  { id: 'meeting', label: 'Meeting Notes', theme: 'blue', draw(k, H, T) {
    const M = 48;
    k.title(T.title || 'Meeting Notes', M, 74);
    k.field('Date:', 470, 70, 610); k.field('Time:', 625, 70, 768);
    k.field('Attendees:', M, 112, 768);
    k.header('Agenda', M, 150, 330); k.checklist(M, 160, 330, 160);
    k.header('Action items', 438, 150, 330); k.checklist(438, 160, 330, 160);
    k.header('Notes', M, 360, 720); k.ruled(M, 370, 720, H - 420, 26);
  } },
  { id: 'lecture', label: 'Lecture Notes', theme: 'blue', draw(k, H, T) {
    const M = 48;
    k.title(T.title || 'Lecture Notes', M, 74);
    k.field('Course:', 430, 70, 600); k.field('Date:', 612, 70, 768);
    k.field('Topic:', M, 108, 768);
    const cue = 230, sum = H - 170;
    k.label('Key ideas', M, 146); k.label('Notes', cue + 16, 146);
    k.line(M, 152, 768, 152, T.accent, 1.4);
    k.line(cue, 152, cue, sum, T.accent, 1.2);
    k.ruled(cue + 10, 152, 768 - cue - 10, sum - 160, 26);
    k.line(M, sum, 768, sum, T.accent, 1.4);
    k.label('Summary', M, sum + 22);
    k.ruled(M, sum + 26, 720, H - sum - 70, 26);
  } },
];

function dailyPlanner(k, H, T) {
  const M = 48;
  k.title(T.title || 'Daily Planner', M, 74, { size: 20 });
  k.text('/', 560, 74, { size: 11, color: T.label });
  DAYS.forEach((d, i) => k.text(d, 640 + i * 18, 74, { size: 9, weight: 700, color: T.ink }));
  k.line(560, 82, 768, 82, T.accent);
  k.label('Schedule', M, 112); k.line(M, 118, M + 330, 118, T.accent, 1.4);
  const hours = 20, rh = (H - 170) / hours;
  for (let i = 0; i < hours; i++) {
    const y = 118 + rh * (i + 1);
    k.text(String(((5 + i) % 24) || 24).padStart(2, '0'), M, y - rh / 2 + 4, { size: 8.5, weight: 600, color: T.label });
    k.line(M, y, M + 330, y);
  }
  k.line(M + 24, 118, M + 24, 118 + rh * hours, T.line);
  k.label('Goal / inspiration', 418, 112); k.line(418, 118, 768, 118, T.accent, 1.4);
  k.ruled(418, 118, 350, 104, 26);
  k.label('Top priorities', 418, 262); k.line(418, 268, 768, 268, T.accent, 1.4);
  for (let i = 1; i <= 4; i++) { k.text('0' + i, 418, 268 + i * 28 - 8, { size: 8.5, weight: 600, color: T.label }); k.line(418, 268 + i * 28, 768, 268 + i * 28); }
  k.line(442, 268, 442, 268 + 4 * 28, T.line);
  k.label('Other tasks', 418, 420); k.line(418, 426, 768, 426, T.accent, 1.4);
  k.ruled(418, 426, 350, H - 476, 26);
  k.line(742, 426, 742, H - 50, T.line);
}

const THEMES = {
  blue: { paper: '#ffffff', ink: '#1d1f24', accent: '#3f6fd1', label: '#3d4250', line: '#c9d3e6', muted: '#8a90a0', soft: '#edf2fc' },
  warm: { paper: '#fdf8f1', ink: '#4a2a22', accent: '#7a3b2e', label: '#9a6a5c', line: '#ead9c9', lineWarm: '#efc8b0', muted: '#b08a7c', soft: '#fbe6db', blob: 'rgba(250,196,160,0.45)', style: 'script' },
  green: { paper: '#ffffff', ink: '#2b3a33', accent: '#2f8f5b', label: '#55655c', line: '#d5e2da', muted: '#8a9a90', soft: '#eef5f0' },
  dark: { paper: '#141416', ink: '#f4f4f6', accent: '#5b86e5', label: '#c9ccd6', line: '#3a3d46', muted: '#80848f', soft: '#1f2229' },
};

export function plannerById(id) { return PLANNERS.find((p) => p.id === id); }

// Resolve the colours for a planner, applying the user's customisation.
function themeFor(planner, page) {
  const base = THEMES[planner.theme] || THEMES.blue;
  const opts = page.tpl || {};
  const T = { ...base, lineWarm: base.lineWarm || base.line, blob: base.blob || 'rgba(0,0,0,0)', title: opts.title || '' };
  if (opts.accent) {
    T.accent = opts.accent;
    if (planner.theme === 'warm') { T.soft = hexA(opts.accent, 0.12); T.lineWarm = hexA(opts.accent, 0.35); T.blob = hexA(opts.accent, 0.18); }
    else T.soft = hexA(opts.accent, 0.1);
  }
  const dark = isDarkPaper(page.color || base.paper);
  if (dark && planner.theme !== 'dark') Object.assign(T, { ink: '#f4f4f6', label: '#c9ccd6', line: 'rgba(255,255,255,0.18)', lineWarm: 'rgba(255,255,255,0.2)', muted: '#9a9ca6', soft: 'rgba(255,255,255,0.06)' });
  T.paper = page.color || base.paper;
  return T;
}

export function plannerPaperColor(id) { const p = plannerById(id); return p ? (THEMES[p.theme] || THEMES.blue).paper : '#ffffff'; }

// ------------------------------------------------------------- drawing ---

// Draw the paper of a page into ctx (page space, origin at page top-left).
export function drawPaper(ctx, page, bgImage) {
  const { w, h } = page;
  ctx.fillStyle = page.color || '#ffffff';
  ctx.fillRect(0, 0, w, h);
  if (bgImage) { ctx.drawImage(bgImage, 0, 0, w, h); return; }
  const t = page.template || 'blank';
  ctx.save();
  const planner = plannerById(t);
  if (planner) {
    const s = w / 816;
    ctx.scale(s, s);
    const T = themeFor(planner, page);
    planner.draw(kit(ctx, T), h / s, T, ctx);
  } else drawBasic(ctx, t, w, h, isDarkPaper(page.color));
  ctx.restore();
}

export function templateLabel(id) {
  return (plannerById(id) || PAPERS.find((p) => p.id === id) || { label: id }).label;
}

// Preview canvas for pickers. Previews are cached (planners are expensive to
// draw), so switching templates and reopening pickers stays instant.
const previewCache = new Map();
if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', () => previewCache.clear());
export function templatePreview(id, { color, tpl, w = 816, h = 1056, width = 180 } = {}) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const col = color || (plannerById(id) ? plannerPaperColor(id) : '#ffffff');
  const key = [id, col, tpl ? JSON.stringify(tpl) : '', w, h, width, dpr].join('|');
  let src = previewCache.get(key);
  if (!src) {
    src = document.createElement('canvas');
    const scale = width / w;
    src.width = Math.round(w * scale * dpr); src.height = Math.round(h * scale * dpr);
    const ctx = src.getContext('2d');
    ctx.scale(scale * dpr, scale * dpr);
    drawPaper(ctx, { w, h, template: id, color: col, tpl });
    previewCache.set(key, src);
    if (previewCache.size > 160) previewCache.delete(previewCache.keys().next().value);
  }
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}
