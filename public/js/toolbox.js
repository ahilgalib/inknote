// Notability-style toolbox for the editor: Zoom window, Tape, Ruler, Laser,
// stickers, sticky notes, find in note, eyedropper, favourite pens, bookmarks.
// These are mixed into Editor.prototype (they use the editor's state).
import { h, clamp, toast } from './util.js';
import { icons } from './icons.js';
import { drawPage } from './render.js';
import { drawLiveStroke, strokeHit, openTapes, itemBBox } from './ink.js';
import { settings, saveSettings, fingerDraws } from './settings.js';
import { popover, closePopover, menu } from './ui.js';
import { isDarkPaper } from './templates.js';

const EMOJI = ['⭐', '✅', '❌', '❗', '❓', '💡', '📌', '📎', '📝', '📚', '🎯', '🔥', '❤️', '👍', '👏', '🙌', '😀', '😂', '😍', '🤔', '😎', '🥳', '😴', '😱',
  '🎉', '🏆', '🧠', '⏰', '📅', '✏️', '🖊️', '🔬', '🧪', '🧮', '💻', '🌍', '🌱', '☀️', '🌙', '⚡', '🍎', '☕', '🎵', '🚀', '✈️', '🏠', '💰', '🔑',
  '➡️', '⬅️', '⬆️', '⬇️', '✔️', '➕', '➖', '💯', '🆗', '🆕', '⚠️', '🔴', '🟢', '🔵'];
const STICKY = ['#fff3a0', '#ffd6e0', '#cdeffd', '#d6f5c9', '#ffe1bf', '#e5dcff'];
export const STICKY_COLORS = STICKY;

// Study timer shared by every open note (keeps running when you switch notes).
let studyTimer = null; // { end, label, total }

function beep() {
  try {
    const A = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.25, 0.5].forEach((t) => {
      const o = A.createOscillator(), g = A.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(A.destination);
      g.gain.setValueAtTime(0.0001, A.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.25, A.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, A.currentTime + t + 0.2);
      o.start(A.currentTime + t); o.stop(A.currentTime + t + 0.22);
    });
  } catch {}
}

function roundRect(ctx, x, y, w, hh, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, hh, r); else ctx.rect(x, y, w, hh);
}

export const toolboxMethods = {
  toolboxMenu(anchor) {
    const tile = (icon, label, sub, fn, on) => h('button', { class: 'tb-tile' + (on ? ' on' : ''), onClick: () => { closePopover(); fn(); } },
      h('span', { class: 'tb-ico', html: icons[icon] }), h('b', {}, label), h('small', {}, sub));
    popover(anchor, h('div', { class: 'toolbox-pop' },
      h('h4', {}, 'Toolbox'),
      h('div', { class: 'tb-tiles' },
        tile('zoom', 'Zoom', 'Write big, it lands small', () => this.toggleZoom(), !!this.zoom),
        tile('tape', 'Tape', 'Cover answers, tap to peek', () => this.setTool('tape'), this.tool === 'tape'),
        tile('ruler', 'Ruler', 'Straight lines at any angle', () => this.toggleRuler(), !!this.ruler),
        tile('laser', 'Laser', 'Point things out', () => this.setTool('laser'), this.tool === 'laser'),
        tile('sparkle', 'Stickers', 'Emoji stickers', () => this.stickerPicker(anchor)),
        tile('note', 'Sticky note', 'A coloured note card', () => this.addSticky()),
        tile('search', 'Find', 'Search this note', () => this.findPanel()),
        tile('nCalc', 'Calculator', 'Basic & scientific', () => this.toggleCalculator(), !!this.calc),
        tile('dropper', 'Eyedropper', 'Pick a colour from the page', () => this.startEyedropper()),
        tile('timer', 'Study timer', 'Focus sessions & breaks', () => this.timerMenu(anchor)),
        tile('check2', 'Tape quiz', 'Reveal answers one by one', () => this.startQuiz()),
        tile('pages', 'Side by side', 'Open another note next to this one', () => this.splitMenu(anchor)),
        tile('lock', this.meta.locked ? 'Unlock' : 'Lock note', 'Read-only, no accidental edits', () => this.toggleLock(), !!this.meta.locked))), { className: 'wide' });
  },

  // ------------------------------------------------------------ ruler ----

  toggleRuler() {
    if (this.ruler) { this.ruler = null; this.requestLive(); return; }
    const c = this.screenToDoc(this.vw / 2, this.vh * 0.45);
    this.ruler = { x: c.x, y: c.y, a: 0, len: Math.min(this.vw * 0.8, 900) / this.cam.s, w: 66 / this.cam.s };
    toast('Drag the ruler with a finger · turn it with a round handle · draw along its edge', 3200);
    this.requestLive();
  },

  rulerGeom() { const a = this.ruler.a, ux = Math.cos(a), uy = Math.sin(a); return { ux, uy, nx: -uy, ny: ux }; },

  rulerHit(sx, sy) {
    const R = this.ruler;
    if (!R) return null;
    const d = this.screenToDoc(sx, sy), { ux, uy, nx, ny } = this.rulerGeom();
    const rx = d.x - R.x, ry = d.y - R.y, along = rx * ux + ry * uy, across = rx * nx + ry * ny;
    const knob = R.len / 2 - R.w * 0.6;
    if (Math.abs(across) < R.w / 2 && Math.abs(Math.abs(along) - knob) < R.w * 0.55) return 'rot';
    if (Math.abs(along) <= R.len / 2 && Math.abs(across) <= R.w / 2) return 'move';
    return null;
  },

  startRulerDrag(mode, p) {
    const R = this.ruler, d = this.screenToDoc(p.sx, p.sy);
    this.rulerDrag = { mode, x0: R.x, y0: R.y, a0: R.a, d0: d, ang0: Math.atan2(d.y - R.y, d.x - R.x) };
  },

  moveRulerDrag(p) {
    const R = this.ruler, D = this.rulerDrag, d = this.screenToDoc(p.sx, p.sy);
    if (!R || !D) return;
    if (D.mode === 'move') { R.x = D.x0 + d.x - D.d0.x; R.y = D.y0 + d.y - D.d0.y; }
    else {
      let a = D.a0 + Math.atan2(d.y - R.y, d.x - R.x) - D.ang0;
      const deg = a * 180 / Math.PI, snap = Math.round(deg / 15) * 15;
      if (Math.abs(deg - snap) < 1.6) a = snap * Math.PI / 180;
      R.a = a;
    }
    this.requestLive();
  },

  // The ruler edge a stroke starting at (dx, dy) should follow, if any.
  rulerEdgeFor(dx, dy, size) {
    const R = this.ruler;
    if (!R) return null;
    const { ux, uy, nx, ny } = this.rulerGeom();
    const rx = dx - R.x, ry = dy - R.y, along = rx * ux + ry * uy, across = rx * nx + ry * ny;
    if (Math.abs(along) > R.len / 2 + 12 / this.cam.s) return null;
    const off = R.w / 2 + size / 2 + 0.5 / this.cam.s, near = 36 / this.cam.s;
    for (const sg of [1, -1]) if (Math.abs(across - sg * off) < near) return { ox: R.x + nx * sg * off, oy: R.y + ny * sg * off, ux, uy };
    return null;
  },

  snapToEdge(E, x, y) { const t = (x - E.ox) * E.ux + (y - E.oy) * E.uy; return { x: E.ox + E.ux * t, y: E.oy + E.uy * t }; },

  drawRuler(ctx) {
    const R = this.ruler;
    if (!R) return;
    const s = this.cam.s, dpr = this.dpr;
    ctx.save();
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * this.cam.x, dpr * this.cam.y);
    ctx.translate(R.x, R.y);
    ctx.rotate(R.a);
    const L = R.len, W = R.w;
    ctx.shadowColor = 'rgba(0,0,0,0.25)';
    ctx.shadowBlur = 10 * dpr;
    ctx.fillStyle = 'rgba(246,248,252,0.82)';
    roundRect(ctx, -L / 2, -W / 2, L, W, 8 / s);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = 'rgba(50,60,80,0.5)';
    ctx.lineWidth = 1 / s;
    ctx.stroke();
    ctx.beginPath();
    const step = 10;
    for (let x = -Math.floor(L / 2 / step) * step, i = 0; x <= L / 2; x += step, i++) {
      const big = Math.round(x / step) % 5 === 0;
      const tl = (big ? 14 : 7) / s;
      ctx.moveTo(x, -W / 2); ctx.lineTo(x, -W / 2 + tl);
      ctx.moveTo(x, W / 2); ctx.lineTo(x, W / 2 - tl);
    }
    ctx.strokeStyle = 'rgba(50,60,80,0.55)';
    ctx.stroke();
    const knob = L / 2 - W * 0.6;
    for (const kx of [-knob, knob]) {
      ctx.beginPath(); ctx.arc(kx, 0, W * 0.24, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(79,107,237,0.9)'; ctx.fill();
    }
    let deg = Math.round(((R.a * 180 / Math.PI) % 360 + 360) % 360);
    if (deg > 180) deg -= 360;
    ctx.fillStyle = '#2b3550';
    ctx.font = `700 ${15 / s}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(Math.abs(deg) + '°', 0, 0);
    ctx.restore();
  },

  // ------------------------------------------------------------- zoom -----

  toggleZoom() {
    if (this.zoom) { this.zoom.el.remove(); this.zoom = null; this.requestRender(); return; }
    const o = this.lay[this.currentIndex()];
    const cv = h('canvas', { class: 'zoom-cv' });
    const btn = (icon, title, fn, cls = '') => h('button', { class: 'icon-btn sm ' + cls, title, 'aria-label': title, html: icons[icon], onClick: (e) => { e.stopPropagation(); fn(); } });
    this.zoomAutoBtn = h('button', { class: 'chip sm', onClick: () => { Z.auto = !Z.auto; this.zoomAutoBtn.classList.toggle('on', Z.auto); } }, 'Auto-advance');
    const bar = h('div', { class: 'zoom-bar' },
      btn('left', 'Move left', () => this.zoomMove(-0.5)),
      btn('right', 'Move right', () => this.zoomMove(0.5)),
      btn('enter', 'Next line', () => this.zoomReturn()),
      this.zoomAutoBtn,
      h('div', { class: 'grow' }),
      btn('close', 'Close zoom', () => this.toggleZoom()));
    const el = h('div', { class: 'zoom-panel' }, bar, cv);
    this.stage.append(el);
    const d = this.screenToDoc(this.vw / 2, this.vh * 0.2);
    const Z = this.zoom = { el, cv, ctx: cv.getContext('2d'), o, w: o.page.w * 0.36, x: 0, y: 0, margin: Math.min(80, o.page.w * 0.1), auto: true, cache: null };
    Z.x = Z.margin;
    Z.y = clamp(d.y - o.y, 10, o.page.h - 60);
    this.zoomAutoBtn.classList.add('on');
    cv.addEventListener('pointerdown', (e) => this.zoomDown(e));
    cv.addEventListener('pointermove', (e) => this.zoomMoveEv(e));
    cv.addEventListener('pointerup', (e) => this.zoomUp(e));
    cv.addEventListener('pointercancel', (e) => this.zoomUp(e, true));
    cv.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    cv.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
    if (!['pen', 'hl', 'eraser', 'tape'].includes(this.tool)) this.setTool('pen');
    requestAnimationFrame(() => this.layoutZoom());
    toast('Write in the zoom window — it lands inside the blue box', 3000);
  },

  layoutZoom() {
    const Z = this.zoom;
    if (!Z) return;
    const r = Z.cv.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = this.dpr;
    Z.cw = r.width; Z.ch = r.height;
    Z.cv.width = Math.round(r.width * dpr); Z.cv.height = Math.round(r.height * dpr);
    Z.k = Z.cw / Z.w;
    Z.h = Z.ch / Z.k;
    Z.y = clamp(Z.y, 0, Math.max(0, Z.o.page.h - Z.h));
    Z.cache = null;
    this.zoomVisible();
    this.requestLive();
  },

  zoomChanged() { const Z = this.zoom; Z.cache = null; this.zoomVisible(); this.requestLive(); },

  zoomMove(f) {
    const Z = this.zoom;
    Z.x = clamp(Z.x + Z.w * f, 0, Math.max(0, Z.o.page.w - Z.w));
    this.zoomChanged();
  },

  zoomReturn() {
    const Z = this.zoom;
    Z.x = Z.margin;
    Z.y += Z.h * 0.6;
    if (Z.y + Z.h > Z.o.page.h) {
      const i = this.lay.indexOf(Z.o);
      if (i < this.lay.length - 1) { Z.o = this.lay[i + 1]; Z.y = 20; }
      else Z.y = Math.max(0, Z.o.page.h - Z.h);
    }
    this.zoomChanged();
  },

  // keep the blue box on screen, above the zoom panel
  zoomVisible() {
    const Z = this.zoom, s = this.cam.s;
    const panelH = Z.el.offsetHeight || 0;
    const top = this.cam.y + (Z.o.y + Z.y) * s, bottom = top + Z.h * s;
    const maxBottom = this.vh - panelH - 16;
    if (top < 10) this.cam.y += 10 - top + 30;
    else if (bottom > maxBottom) this.cam.y -= bottom - maxBottom + 30;
    this.clampCam();
    this.requestRender();
  },

  zoomPoint(e) {
    const Z = this.zoom, r = Z.cv.getBoundingClientRect();
    const dx = Z.o.x + Z.x + (e.clientX - r.left) / Z.k, dy = Z.o.y + Z.y + (e.clientY - r.top) / Z.k;
    return { x: this.cam.x + dx * this.cam.s, y: this.cam.y + dy * this.cam.s };
  },

  zoomDown(e) {
    e.preventDefault();
    closePopover();
    const Z = this.zoom;
    if (!Z) return;
    try { Z.cv.setPointerCapture(e.pointerId); } catch {}
    if (e.pointerType === 'touch' && (this.penActive || !fingerDraws())) {
      Z.pan = { id: e.pointerId, x0: e.clientX, y0: e.clientY, bx: Z.x, by: Z.y };
      return;
    }
    if (this.zp) return;
    if (this.meta.locked) { toast('This note is locked'); return; }
    if (!['pen', 'hl', 'eraser', 'tape'].includes(this.tool)) this.setTool('pen');
    if (e.pointerType === 'pen') { this.penActive = true; this.eraserOverride = !!(e.buttons & 32) || e.button === 5; }
    const s = this.zoomPoint(e);
    const p = { id: e.pointerId, type: e.pointerType, sx: s.x, sy: s.y, x0: s.x, y0: s.y, t0: performance.now(), role: 'draw', zoom: true };
    this.zp = p;
    this.startTool(p, e);
    this.requestLive();
  },

  zoomMoveEv(e) {
    const Z = this.zoom;
    if (!Z) return;
    if (Z.pan && Z.pan.id === e.pointerId) {
      Z.x = clamp(Z.pan.bx - (e.clientX - Z.pan.x0) / Z.k, 0, Math.max(0, Z.o.page.w - Z.w));
      Z.y = clamp(Z.pan.by - (e.clientY - Z.pan.y0) / Z.k, 0, Math.max(0, Z.o.page.h - Z.h));
      Z.margin = Z.x;
      Z.cache = null;
      this.requestLive();
      return;
    }
    const p = this.zp;
    if (!p || p.id !== e.pointerId) return;
    e.preventDefault();
    let evs = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    if (!evs || !evs.length) evs = [e];
    for (const ev of evs) { const s = this.zoomPoint(ev); p.sx = s.x; p.sy = s.y; this.moveTool(p, ev); }
    this.requestLive();
  },

  zoomUp(e, cancelled) {
    const Z = this.zoom;
    if (!Z) return;
    if (Z.pan && Z.pan.id === e.pointerId) { Z.pan = null; this.zoomVisible(); return; }
    const p = this.zp;
    if (!p || p.id !== e.pointerId) return;
    this.zp = null;
    if (e.pointerType === 'pen') this.penActive = false;
    const before = this.lastStroke;
    this.endTool(p, cancelled);
    const it = this.lastStroke;
    // auto-advance: writing near the right edge of the box moves it along
    if (Z.auto && it && it !== before && this.tool !== 'eraser') {
      const b = itemBBox(it);
      if (b.x + b.w > Z.x + Z.w * 0.8) {
        if (Z.x + Z.w * 1.5 > Z.o.page.w) this.zoomReturn(); else this.zoomMove(0.55);
      }
    }
    this.requestLive();
  },

  drawZoom() {
    const Z = this.zoom;
    if (!Z || !Z.k) return;
    const dpr = this.dpr, k = Z.k, page = Z.o.page;
    if (!Z.cache) {
      const c = Z.cache = Z.cache || document.createElement('canvas');
      c.width = Z.cv.width; c.height = Z.cv.height;
      const x = c.getContext('2d');
      x.fillStyle = getComputedStyle(this.stage).backgroundColor || '#ddd';
      x.fillRect(0, 0, c.width, c.height);
      x.setTransform(dpr * k, 0, 0, dpr * k, -Z.x * k * dpr, -Z.y * k * dpr);
      x.save();
      x.beginPath(); x.rect(0, 0, page.w, page.h); x.clip();
      drawPage(x, page, { images: this.images, hidden: this.hidden, cull: { x: Z.x - 30, y: Z.y - 30, w: Z.w + 60, h: Z.h + 60 } });
      x.restore();
    }
    const ctx = Z.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(Z.cache, 0, 0);
    ctx.setTransform(dpr * k, 0, 0, dpr * k, -Z.x * k * dpr, -Z.y * k * dpr);
    // advance zone and writing line
    ctx.fillStyle = 'rgba(79,107,237,0.06)';
    ctx.fillRect(Z.x + Z.w * 0.8, Z.y, Z.w * 0.2, Z.h);
    const L = this.live;
    if (L && L.o === Z.o) {
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, page.w, page.h); ctx.clip();
      ctx.__dark = isDarkPaper(page.color) && !page.bg;
      drawLiveStroke(ctx, { type: 'stroke', tool: L.tool, style: L.style, color: L.color, size: L.size, pts: L.pts, shape: L.shape, closed: L.closed });
      ctx.__dark = false;
      ctx.restore();
    }
  },

  drawZoomBox(ctx) {
    const Z = this.zoom;
    if (!Z || !Z.h) return;
    this.pageTransform(ctx, Z.o);
    const s = this.cam.s;
    ctx.save();
    ctx.lineWidth = 2 / s;
    ctx.strokeStyle = '#4f6bed';
    ctx.fillStyle = 'rgba(79,107,237,0.07)';
    ctx.fillRect(Z.x, Z.y, Z.w, Z.h);
    ctx.strokeRect(Z.x, Z.y, Z.w, Z.h);
    ctx.setLineDash([4 / s, 4 / s]);
    ctx.beginPath(); ctx.moveTo(Z.margin, Z.y - 6 / s); ctx.lineTo(Z.margin, Z.y + Z.h + 6 / s); ctx.stroke();
    ctx.restore();
  },

  zoomBoxHit(sx, sy) {
    const Z = this.zoom;
    if (!Z || !Z.h) return false;
    const d = this.screenToDoc(sx, sy), x = d.x - Z.o.x, y = d.y - Z.o.y;
    return x >= Z.x && x <= Z.x + Z.w && y >= Z.y && y <= Z.y + Z.h;
  },

  // ------------------------------------------------------------- tape -----

  tapeAt(o, x, y) {
    const r = 8 / this.cam.s;
    for (let i = o.page.items.length - 1; i >= 0; i--) {
      const it = o.page.items[i];
      if (it.type === 'stroke' && it.tool === 'tape' && strokeHit(it, x, y, r)) return it;
    }
    return null;
  },

  toggleTape(o, it) {
    if (openTapes.has(it.id)) openTapes.delete(it.id); else openTapes.add(it.id);
    this.markDirty(o.page);
  },

  setAllTapes(open) {
    for (const p of this.pages) for (const it of p.items) if (it.tool === 'tape') { if (open) openTapes.add(it.id); else openTapes.delete(it.id); }
    this.markAllDirty();
  },

  // --------------------------------------------------- stickers & notes ---

  stickerPicker(anchor) {
    popover(anchor || this.optsEl, h('div', { class: 'emoji-pop' }, h('h4', {}, 'Stickers'),
      h('div', { class: 'emoji-grid' }, EMOJI.map((e) => h('button', { class: 'emoji', onClick: () => { closePopover(); this.insertEmoji(e); } }, e)))), { className: 'wide' });
  },

  async insertEmoji(e) {
    const c = document.createElement('canvas');
    c.width = c.height = 240;
    const x = c.getContext('2d');
    x.font = '190px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText(e, 120, 132);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    if (blob) this.insertImages([new File([blob], 'sticker.png', { type: 'image/png' })], null, { sticker: true, width: 110 });
  },

  addSticky() {
    if (this.meta.locked) { toast('This note is locked'); return; }
    const d = this.screenToDoc(this.vw / 2 - 120, this.vh * 0.3);
    const o = this.pageAt(d.x, d.y) || this.lay[this.currentIndex()];
    this.setTool('text');
    const item = this.newTextItem(o, d.x - o.x, d.y - o.y, '');
    Object.assign(item, { bg: STICKY[0], w: 230, color: '#1d1d1f' });
    item.x = clamp(item.x, 12, o.page.w - item.w - 12);
    this.editText(o, item, true);
  },

  // -------------------------------------------------------------- find ----

  findPanel() {
    const input = h('input', { class: 'input', type: 'search', placeholder: 'Find in this note', 'aria-label': 'Find in this note' });
    const list = h('div', { class: 'find-list' });
    const run = () => {
      const q = input.value.trim().toLowerCase();
      list.innerHTML = '';
      if (!q) { list.append(h('p', { class: 'muted small' }, 'Searches typed text, sticky notes, audio names and transcripts.')); return; }
      const hits = [];
      this.pages.forEach((p, i) => {
        for (const it of p.items) {
          const t = it.type === 'text' ? it.text : it.type === 'audio' ? it.label : '';
          if (t && t.toLowerCase().includes(q)) hits.push({ i, it, text: t });
        }
        if (p.tpl && p.tpl.title && p.tpl.title.toLowerCase().includes(q)) hits.push({ i, text: p.tpl.title });
      });
      for (const r of this.body.recordings) {
        for (const l of r.transcript || []) if (l.text.toLowerCase().includes(q)) hits.push({ rec: r, t: l.t, text: l.text });
      }
      if (!hits.length) { list.append(h('p', { class: 'muted small' }, 'No matches')); return; }
      for (const r of hits.slice(0, 60)) {
        const at = r.text.toLowerCase().indexOf(q), from = Math.max(0, at - 30);
        const snip = (from ? '…' : '') + r.text.slice(from, at + q.length + 50);
        list.append(h('button', { class: 'find-row', onClick: () => {
          closePopover();
          if (r.rec) { this.renderAudioBar(r.rec.id); this.seekTo(r.t); return; }
          this.scrollToPage(r.i);
          if (r.it) {
            const o = this.lay[r.i], b = itemBBox(r.it);
            this.cam.y = Math.min(this.cam.y, this.vh * 0.35 - (o.y + b.y) * this.cam.s);
            this.clampCam();
            this.select(o, [r.it.id]);
            this.requestRender();
          }
        } }, h('span', { class: 'find-pg' }, r.rec ? '🎙' : 'p' + (r.i + 1)), h('span', {}, snip)));
      }
    };
    input.addEventListener('input', run);
    popover(this.findAnchor || this.optsEl, h('div', { class: 'find-pop' }, input, list), { className: 'wide' });
    run();
    setTimeout(() => input.focus(), 30);
  },

  // --------------------------------------------------------- eyedropper ---

  startEyedropper() {
    this.eyedrop = true;
    this.liveCv.style.cursor = 'crosshair';
    toast('Tap any colour on the page', 2600);
  },

  pickColorAt(pos) {
    this.eyedrop = false;
    this.liveCv.style.cursor = '';
    let px;
    try { px = this.mctx.getImageData(Math.round(pos.x * this.dpr), Math.round(pos.y * this.dpr), 1, 1).data; } catch { return; }
    const hex = '#' + [px[0], px[1], px[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
    const t = ['pen', 'hl', 'text', 'tape'].includes(this.tool) ? this.tool : 'pen';
    const cfg = settings.tools[t];
    cfg.colors[cfg.color] = hex;
    saveSettings();
    if (this.tool !== t) this.setTool(t); else this.renderToolbar();
    toast('Colour picked');
  },

  // ---------------------------------------------- favourite pens (presets) --

  renderPresets(el) {
    el.innerHTML = '';
    const list = settings.presets || [];
    list.forEach((pr, i) => {
      const b = h('button', { class: 'preset', title: 'Favourite pen — long-press to remove', 'aria-label': 'Favourite pen ' + (i + 1) },
        h('span', { class: 'preset-dot ' + pr.tool, style: { background: pr.color, width: Math.min(20, 6 + pr.size * (pr.tool === 'pen' ? 2.2 : 0.4)) + 'px', height: Math.min(20, 6 + pr.size * (pr.tool === 'pen' ? 2.2 : 0.4)) + 'px' } }));
      let lp = null;
      const remove = () => menu(b, [{ label: 'Remove favourite', icon: 'trash', danger: true, onClick: () => { list.splice(i, 1); saveSettings(); this.renderToolbar(); } }]);
      b.addEventListener('pointerdown', () => { lp = setTimeout(() => { lp = 'fired'; remove(); }, 550); });
      b.addEventListener('pointerup', () => clearTimeout(lp));
      b.addEventListener('pointerleave', () => clearTimeout(lp));
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); remove(); });
      b.addEventListener('click', () => { if (lp === 'fired') { lp = null; return; } this.applyPreset(pr); });
      const cur = settings.tools[pr.tool];
      if (this.tool === pr.tool && cur.colors[cur.color] === pr.color && Math.abs(cur.sizes[cur.size] - pr.size) < 0.01 && (pr.tool !== 'pen' || (cur.style || 'fountain') === (pr.style || 'fountain'))) b.classList.add('on');
      el.append(b);
    });
    if (['pen', 'hl', 'tape'].includes(this.tool) && list.length < 10) {
      el.append(h('button', { class: 'preset add', title: 'Save this pen as a favourite', 'aria-label': 'Save favourite pen', html: icons.star, onClick: () => {
        const c = settings.tools[this.tool];
        list.push({ tool: this.tool, color: c.colors[c.color], size: c.sizes[c.size], style: this.tool === 'pen' ? c.style : undefined });
        settings.presets = list;
        saveSettings();
        this.renderToolbar();
        toast('Saved to favourites');
      } }));
    }
  },

  applyPreset(pr) {
    const cfg = settings.tools[pr.tool];
    let ci = cfg.colors.indexOf(pr.color);
    if (ci < 0) { ci = cfg.color; cfg.colors[ci] = pr.color; }
    cfg.color = ci;
    let si = cfg.sizes.findIndex((v) => Math.abs(v - pr.size) < 0.01);
    if (si < 0) { si = cfg.size; cfg.sizes[si] = pr.size; }
    cfg.size = si;
    if (pr.tool === 'pen' && pr.style) cfg.style = pr.style;
    saveSettings();
    this.setTool(pr.tool);
  },

  // ---------------------------------------------------------- bookmarks ---

  toggleBookmark(i = this.currentIndex()) {
    const p = this.pages[i];
    p.bookmark = !p.bookmark || undefined;
    if (!p.bookmark) delete p.bookmark;
    this.changed();
    this.flashIndicator(p.bookmark ? 'Page bookmarked' : 'Bookmark removed');
    if (!this.pagesPanel.hidden) this.renderPagesPanel();
  },

  // --------------------------------------------------------- study timer --

  timerMenu(anchor) {
    const start = (min, label) => { studyTimer = { end: Date.now() + min * 60000, label, total: min * 60000 }; this.renderTimer(); toast(`${label} · ${min} min`); };
    menu(anchor, [
      { label: 'Focus 25 min', icon: 'timer', onClick: () => start(25, 'Focus') },
      { label: 'Focus 50 min', icon: 'timer', onClick: () => start(50, 'Focus') },
      { label: 'Short break 5 min', icon: 'timer', onClick: () => start(5, 'Break') },
      { label: 'Long break 15 min', icon: 'timer', onClick: () => start(15, 'Break') },
      { label: 'Custom…', icon: 'timer', onClick: async () => {
        const { promptDialog } = await import('./ui.js');
        const v = parseFloat(await promptDialog('Timer (minutes)', '30', { ok: 'Start' }));
        if (v > 0 && v < 600) start(v, 'Timer');
      } },
      studyTimer ? '-' : null,
      studyTimer ? { label: 'Stop timer', icon: 'stop', danger: true, onClick: () => { studyTimer = null; this.renderTimer(); } } : null,
    ]);
  },

  renderTimer() {
    const B = this.timerBtn;
    if (!B) return;
    if (!studyTimer) { B.classList.remove('running'); B.innerHTML = icons.timer; return; }
    const left = studyTimer.end - Date.now();
    if (left <= 0) {
      const lbl = studyTimer.label;
      studyTimer = null;
      B.classList.remove('running');
      B.innerHTML = icons.timer;
      beep();
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
      toast(lbl === 'Break' ? 'Break is over — back to work!' : 'Time is up — take a break! 🎉', 5000);
      return;
    }
    const m = Math.floor(left / 60000), sec = Math.floor(left / 1000) % 60;
    B.classList.add('running');
    B.classList.toggle('break', studyTimer.label === 'Break');
    B.innerHTML = icons.timer;
    B.append(h('span', {}, `${m}:${String(sec).padStart(2, '0')}`));
  },

  // ------------------------------------------------------ tape quiz mode ---

  startQuiz() {
    const list = [];
    this.pages.forEach((p, i) => p.items.filter((it) => it.tool === 'tape').map((it) => ({ i, it, b: itemBBox(it) }))
      .sort((a, b) => a.b.y - b.b.y || a.b.x - b.b.x).forEach((x) => list.push(x)));
    if (!list.length) { toast('Draw some tape over answers first'); return; }
    this.setAllTapes(false);
    this.quiz = { list, i: 0, shown: false };
    if (this.quizBar) this.quizBar.remove();
    this.quizLabel = h('span', { class: 'quiz-label' });
    this.quizBar = h('div', { class: 'quiz-bar' }, this.quizLabel,
      h('button', { class: 'btn primary', onClick: () => this.quizReveal() }, 'Reveal'),
      h('button', { class: 'btn', onClick: () => this.quizStep(1) }, 'Next ›'),
      h('button', { class: 'icon-btn sm', 'aria-label': 'End quiz', html: icons.close, onClick: () => this.endQuiz() }));
    this.stage.append(this.quizBar);
    this.quizStep(0);
  },

  quizStep(d) {
    const Q = this.quiz;
    Q.i = Math.max(0, Math.min(Q.list.length - 1, Q.i + d));
    if (d > 0 && Q.i === Q.list.length - 1 && Q.shown) { toast('That was the last one — well done!'); }
    Q.shown = false;
    const { i, b } = Q.list[Q.i], o = this.lay[i];
    if (!o) return;
    this.cam.y = this.vh * 0.4 - (o.y + b.y + b.h / 2) * this.cam.s;
    this.clampCam();
    this.quizLabel.textContent = `Question ${Q.i + 1} of ${Q.list.length}`;
    this.flashTape = Q.list[Q.i].it.id;
    this.requestRender();
  },

  quizReveal() {
    const Q = this.quiz;
    const { it, i } = Q.list[Q.i];
    openTapes.add(it.id);
    Q.shown = true;
    this.markDirty(this.lay[i].page);
  },

  endQuiz() {
    this.quiz = null;
    this.flashTape = null;
    if (this.quizBar) { this.quizBar.remove(); this.quizBar = null; }
    this.requestRender();
  },

  // -------------------------------------------------------------- tips ----

  showTips(anchor) {
    const tips = [
      ['pen', 'Tap a tool twice for its options: pen styles (fountain, ballpoint, calligraphy, pencil, dashed, dotted), eraser modes…'],
      ['star', 'Save pens you love with ★ — they stay in the toolbar.'],
      ['toolbox', 'Toolbox: Zoom window, Tape, Ruler, Laser, Stickers, Sticky notes, Find, Eyedropper.'],
      ['image', 'Tap a picture for options (sticker, crop, rotate, flip). Drag to move, corners to resize.'],
      ['lasso', 'Lasso anything to move, resize, rotate, recolour or copy it — even to another page.'],
      ['moon', 'Moon button: dark pages. Black ink turns white automatically.'],
      ['hand', 'Two-finger tap = undo · three-finger tap = redo · pinch = zoom.'],
      ['cloud', 'Works offline. Sign in to sync with all your devices.'],
    ];
    popover(anchor || this.optsEl, h('div', { class: 'tips-pop' }, h('h4', {}, 'Quick tips'),
      tips.map(([ic, t]) => h('div', { class: 'tip' }, h('span', { html: icons[ic] }), h('p', {}, t))),
      h('button', { class: 'btn primary block', onClick: () => { closePopover(); settings.tipsSeen = true; saveSettings(); } }, 'Got it')), { className: 'wide' });
  },
};
