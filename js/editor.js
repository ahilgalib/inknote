// The note editor: infinite vertical page canvas, Apple Pencil / touch / mouse
// input, tools, undo, audio recording with synced ink replay.
import { h, uid, clamp, debounce, toast, fmtTime, pickFile, saveFile, safeName, loadImage } from './util.js';
import { icons } from './icons.js';
import { settings, saveSettings, fingerDraws } from './settings.js';
import { drawStroke, itemBBox, invalidate, strokeHit, strokeHitSegment, splitStroke, lassoHit, transformItem, round2 } from './ink.js';
import { recognize } from './shapes.js';
import { drawPage, drawText, measureText, FONTS, renderPageCanvas } from './render.js';
import { TEMPLATES, PAPER_COLORS, SIZES, templatePreview, isDarkPaper } from './templates.js';
import { putAsset, assetURL } from './db.js';
import { saveNote, makeThumb, newPage, exportNotePDF, exportNoteFile, pdfToPages } from './notes.js';
import { popover, menu, closePopover, confirmDialog, progressDialog } from './ui.js';

const GAP = 28;          // space between pages (doc px)
const TOP = 20;          // space above first page (screen px)
const CAP = 2600;        // max cache bitmap size (px, longest side)
// cached page bitmaps kept in memory (iOS Safari has a tight total canvas budget)
const MAX_CACHE = matchMedia('(pointer: coarse)').matches ? 4 : 6;
const HOLD_MS = 550;     // draw-and-hold → shape
let clipboard = null;    // shared between notes

const TOOL_LIST = [
  ['pen', 'Pen', 'P'], ['hl', 'Highlighter', 'H'], ['eraser', 'Eraser', 'E'],
  ['lasso', 'Lasso', 'L'], ['text', 'Text', 'T'], ['hand', 'Scroll', 'Space'],
];
const TOOL_ICON = { pen: 'pen', hl: 'highlighter', eraser: 'eraser', lasso: 'lasso', text: 'text', hand: 'hand' };

export class Editor {
  constructor(meta, body, { onExit }) {
    this.meta = meta;
    this.body = body;
    this.pages = body.pages;
    body.recordings = body.recordings || [];
    this.onExit = onExit;
    this.tool = 'pen';
    this.undoStack = [];
    this.redoStack = [];
    this.images = new Map();
    this.imgLoading = new Set();
    this.caches = new Map();
    this.cam = { s: 1, x: 0, y: 0 };
    this.pointers = new Map();
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.hidden = null;
    this.selection = null;
    this.lastThumb = 0;
    let zc = 0;
    for (const p of this.pages) for (const it of p.items) zc = Math.max(zc, it.z || 0);
    body.zc = Math.max(body.zc || 0, zc);
    this.save = debounce(() => this.persist(), 800);
    this.build();
    this.layoutPages();
  }

  // ---------------------------------------------------------------- DOM ----

  build() {
    const btn = (icon, title, onClick, cls = '') => h('button', { class: 'icon-btn ' + cls, title, 'aria-label': title, onClick, html: icons[icon] });

    this.titleInput = h('input', { class: 'title-input', value: this.meta.title, spellcheck: 'false', 'aria-label': 'Note title' });
    this.titleInput.addEventListener('input', () => { this.meta.title = this.titleInput.value || 'Untitled note'; this.changed(); });
    this.titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.titleInput.blur(); });

    this.recBtn = btn('mic', 'Record audio', () => this.toggleRecord(), 'rec-btn');
    this.recTime = h('span', { class: 'rec-time' });
    this.recBtn.append(this.recTime);

    const topbar = h('header', { class: 'ed-top' },
      btn('back', 'Back to library', () => this.exit()),
      this.titleInput,
      h('div', { class: 'grow' }),
      this.recBtn,
      btn('pages', 'Pages', () => this.togglePagesPanel()),
      btn('paper', 'Paper', (e) => this.paperMenu(e.currentTarget)),
      btn('share', 'Export', (e) => this.exportMenu(e.currentTarget)),
      btn('more', 'More', (e) => this.moreMenu(e.currentTarget)));

    this.toolBtns = {};
    const tools = h('div', { class: 'tb-group tools' }, TOOL_LIST.map(([id, label, key]) => {
      const b = h('button', { class: 'tool-btn', title: `${label} (${key})`, 'aria-label': label, onClick: () => this.setTool(id), html: icons[TOOL_ICON[id]] });
      this.toolBtns[id] = b;
      return b;
    }), h('button', { class: 'tool-btn', title: 'Insert image', 'aria-label': 'Insert image', onClick: () => this.pickImages(), html: icons.image }));

    this.undoBtn = btn('undo', 'Undo (Ctrl+Z)', () => this.undo());
    this.redoBtn = btn('redo', 'Redo (Ctrl+Shift+Z)', () => this.redo());
    this.optsEl = h('div', { class: 'tb-group opts' });
    this.colorInput = h('input', { type: 'color', class: 'hidden-color' });
    const toolbar = h('div', { class: 'ed-toolbar' },
      h('div', { class: 'tb-group' }, this.undoBtn, this.redoBtn),
      h('div', { class: 'tb-sep' }), tools, h('div', { class: 'tb-sep' }), this.optsEl, this.colorInput);

    this.main = h('canvas', { class: 'cv-main' });
    this.liveCv = h('canvas', { class: 'cv-live' });
    this.mctx = this.main.getContext('2d');
    this.lctx = this.liveCv.getContext('2d');
    this.textarea = h('textarea', { class: 'text-edit', hidden: true, spellcheck: 'true', autocapitalize: 'sentences' });
    this.textarea.addEventListener('input', () => this.sizeTextarea());
    this.textarea.addEventListener('blur', () => setTimeout(() => this.commitText(), 0));
    this.textarea.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.textarea.blur(); e.stopPropagation(); });
    this.selMenu = h('div', { class: 'sel-menu', hidden: true });
    this.pageInd = h('div', { class: 'page-ind' });
    this.addPageFab = h('button', { class: 'fab', title: 'Add page', 'aria-label': 'Add page', html: icons.plus, onClick: () => this.addPage() });
    this.stage = h('div', { class: 'stage' }, this.main, this.liveCv, this.textarea, this.selMenu, this.pageInd, this.addPageFab);

    this.audioBar = h('div', { class: 'audio-bar', hidden: true });
    this.pagesPanel = h('aside', { class: 'pages-panel', hidden: true });

    this.el = h('div', { class: 'editor' }, topbar, toolbar,
      h('div', { class: 'ed-body' }, this.stage, this.pagesPanel), this.audioBar);

    // input
    const cv = this.liveCv;
    cv.addEventListener('pointerdown', (e) => this.onDown(e));
    cv.addEventListener('pointermove', (e) => this.onMove(e));
    cv.addEventListener('pointerup', (e) => this.onUp(e));
    cv.addEventListener('pointercancel', (e) => this.onUp(e, true));
    cv.addEventListener('pointerleave', (e) => { if (!this.pointers.has(e.pointerId) && this.hover) { this.hover = null; this.requestLive(); } });
    cv.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    // iOS: stop scrolling, magnifier, text selection and double-tap zoom on the canvas
    cv.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    cv.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
    cv.addEventListener('dblclick', (e) => e.preventDefault());

    this.onKey = (e) => this.handleKey(e);
    this.onKeyUp = (e) => { if (e.code === 'Space') this.spaceDown = false; };
    this.onVis = () => { if (document.visibilityState === 'hidden') this.save.flush(); };
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKeyUp);
    document.addEventListener('visibilitychange', this.onVis);
    window.addEventListener('pagehide', this.onVis);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.stage);

    this.renderToolbar();
    this.renderAudioBar();
  }

  mount(parent) {
    parent.append(this.el);
    this.resize();
  }

  resize() {
    const r = this.stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const prevW = this.vw;
    this.vw = r.width; this.vh = r.height;
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    for (const c of [this.main, this.liveCv]) {
      c.width = Math.round(this.vw * this.dpr);
      c.height = Math.round(this.vh * this.dpr);
      c.style.width = this.vw + 'px';
      c.style.height = this.vh + 'px';
    }
    if (!this.inited) { this.inited = true; this.fitWidth(true); }
    else if (prevW && Math.abs(prevW - this.vw) > 40) this.fitWidth(false);
    else this.clampCam();
    this.requestRender();
  }

  // ------------------------------------------------------------- layout ---

  layoutPages() {
    let y = 0;
    this.maxW = 0;
    this.lay = this.pages.map((page) => {
      const o = { page, x: -page.w / 2, y };
      y += page.h + GAP;
      this.maxW = Math.max(this.maxW, page.w);
      return o;
    });
    this.totalH = Math.max(0, y - GAP);
    this.layById = new Map(this.lay.map((o) => [o.page.id, o]));
  }

  fitScale() {
    const margin = this.vw < 600 ? 6 : 28;
    return clamp((this.vw - margin * 2) / this.maxW, 0.1, 4);
  }

  fitWidth(toTop) {
    const cy = toTop ? null : this.screenToDoc(this.vw / 2, this.vh / 2).y;
    this.cam.s = this.fitScale();
    this.cam.x = this.vw / 2;
    this.cam.y = toTop ? TOP : this.vh / 2 - cy * this.cam.s;
    this.clampCam();
    this.requestRender();
  }

  clampCam() {
    const { cam } = this;
    cam.s = clamp(cam.s, 0.12, 10);
    const s = cam.s, half = (this.maxW / 2) * s;
    if (half * 2 + 24 <= this.vw) cam.x = this.vw / 2;
    else cam.x = clamp(cam.x, this.vw - half - 12, half + 12);
    const maxY = TOP;
    const minY = Math.min(TOP, this.vh - this.totalH * s - 90);
    cam.y = clamp(cam.y, minY, maxY);
  }

  screenToDoc(sx, sy) { return { x: (sx - this.cam.x) / this.cam.s, y: (sy - this.cam.y) / this.cam.s }; }

  pageAt(dx, dy, slack = 0) {
    for (const o of this.lay) {
      if (dx >= o.x - slack && dx <= o.x + o.page.w + slack && dy >= o.y - slack && dy <= o.y + o.page.h + slack) return o;
    }
    return null;
  }

  currentIndex() {
    const cy = this.screenToDoc(this.vw / 2, this.vh * 0.4).y;
    let best = 0, bd = Infinity;
    this.lay.forEach((o, i) => {
      const d = cy < o.y ? o.y - cy : cy > o.y + o.page.h ? cy - o.y - o.page.h : 0;
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  visiblePages() {
    const a = this.screenToDoc(0, 0), b = this.screenToDoc(this.vw, this.vh);
    return this.lay.filter((o) => o.y < b.y && o.y + o.page.h > a.y && o.x < b.x && o.x + o.page.w > a.x);
  }

  pageById(id) { const o = this.layById.get(id); return o ? o.page : null; }

  scrollToPage(i) {
    const o = this.lay[i];
    if (!o) return;
    this.cam.y = TOP - o.y * this.cam.s;
    this.clampCam();
    this.requestRender();
    this.flashIndicator();
  }

  // ------------------------------------------------------------ render ----

  requestRender() { this.needMain = true; this.schedule(); }
  requestLive() { this.needLive = true; this.schedule(); }
  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      const m = this.needMain, l = this.needLive;
      this.needMain = this.needLive = false;
      if (m) this.renderFrame();
      if (m || l) this.drawLive();
    });
  }

  targetScale(page) {
    return Math.min(this.cam.s * this.dpr, CAP / Math.max(page.w, page.h));
  }

  alphaFn() {
    const pb = this.playback;
    if (!pb) return undefined;
    return (it) => (it.rec === pb.rec && it.t > pb.ms ? 0.16 : 1);
  }

  renderFrame() {
    if (!this.vw) return;
    const ctx = this.mctx, dpr = this.dpr, { s, x, y } = this.cam;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.main.width, this.main.height);
    const vis = this.visiblePages();
    let budget = 2, pending = false;
    for (const o of vis) {
      const sx = x + o.x * s, sy = y + o.y * s, sw = o.page.w * s, sh = o.page.h * s;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = 'rgba(0,0,0,0.10)';
      ctx.fillRect(sx + 1, sy + 2, sw, sh);
      this.ensureImages(o.page);
      const want = this.targetScale(o.page);
      if (s * dpr > want * 1.02 && !this.interacting) { this.drawVector(ctx, o); continue; }
      let c = this.caches.get(o.page.id);
      const stale = c && (c.dirty || (!this.interacting && Math.abs(c.scale - want) / want > 0.12));
      if (!c || stale) {
        if (budget > 0) {
          budget--;
          c = this.renderCache(o.page, want, c);
          if (!c) { this.drawVector(ctx, o); continue; }
        } else pending = true;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (c) {
        c.used = performance.now();
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(c.canvas, sx * dpr, sy * dpr, sw * dpr, sh * dpr);
      } else {
        ctx.fillStyle = o.page.color || '#fff';
        ctx.fillRect(sx * dpr, sy * dpr, sw * dpr, sh * dpr);
      }
    }
    if (pending) this.requestRender();
    this.evictCaches(vis);
    this.positionOverlays();
  }

  drawVector(ctx, o) {
    const { s, x, y } = this.cam, dpr = this.dpr;
    ctx.save();
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (x + o.x * s), dpr * (y + o.y * s));
    ctx.beginPath();
    ctx.rect(0, 0, o.page.w, o.page.h);
    ctx.clip();
    const a = this.screenToDoc(0, 0);
    const cull = { x: a.x - o.x - 20, y: a.y - o.y - 20, w: this.vw / s + 40, h: this.vh / s + 40 };
    drawPage(ctx, o.page, { images: this.images, hidden: this.hidden, alpha: this.alphaFn(), cull });
    ctx.restore();
  }

  renderCache(page, scale, c) {
    const w = Math.max(1, Math.round(page.w * scale)), hh = Math.max(1, Math.round(page.h * scale));
    if (!c) c = { canvas: document.createElement('canvas') };
    if (c.canvas.width !== w || c.canvas.height !== hh) { c.canvas.width = w; c.canvas.height = hh; }
    let ctx = c.canvas.getContext('2d');
    if (!ctx) {
      // out of canvas memory: drop every other cache and try once more
      for (const [id, o] of this.caches) if (o !== c) { o.canvas.width = o.canvas.height = 0; this.caches.delete(id); }
      ctx = c.canvas.getContext('2d');
      if (!ctx) return null;
    }
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    drawPage(ctx, page, { images: this.images, hidden: this.hidden, alpha: this.alphaFn() });
    c.scale = scale;
    c.dirty = false;
    c.used = performance.now();
    this.caches.set(page.id, c);
    return c;
  }

  evictCaches(vis) {
    if (this.caches.size <= MAX_CACHE) return;
    const visIds = new Set(vis.map((o) => o.page.id));
    const list = [...this.caches.entries()].filter(([id]) => !visIds.has(id)).sort((a, b) => a[1].used - b[1].used);
    while (this.caches.size > MAX_CACHE && list.length) {
      const [id, c] = list.shift();
      c.canvas.width = c.canvas.height = 0;
      this.caches.delete(id);
    }
  }

  markDirty(page) {
    const c = page && this.caches.get(page.id);
    if (c) c.dirty = true;
    this.requestRender();
  }

  markAllDirty() { for (const c of this.caches.values()) c.dirty = true; this.requestRender(); }

  // Draw a freshly committed stroke straight onto the cached bitmap.
  paintOnCache(page, item) {
    const c = this.caches.get(page.id);
    if (c && !c.dirty && !this.playback) {
      const ctx = c.canvas.getContext('2d');
      ctx.setTransform(c.scale, 0, 0, c.scale, 0, 0);
      ctx.__dark = isDarkPaper(page.color) && !page.bg;
      drawStroke(ctx, item);
      ctx.__dark = false;
    } else if (c) c.dirty = true;
    this.requestRender();
  }

  ensureImages(page) {
    const ids = [];
    if (page.bg) ids.push(page.bg);
    for (const it of page.items) if (it.type === 'image') ids.push(it.asset);
    for (const id of ids) {
      if (this.images.has(id) || this.imgLoading.has(id)) continue;
      this.imgLoading.add(id);
      assetURL(id).then((url) => url && loadImage(url)).then((img) => {
        this.imgLoading.delete(id);
        if (!img) return;
        this.images.set(id, img);
        this.trimImages();
        for (const o of this.lay) if (o.page.bg === id || o.page.items.some((i) => i.asset === id)) this.markDirty(o.page);
      }).catch(() => this.imgLoading.delete(id));
    }
  }

  // Keep decoded PDF backgrounds in check on big documents.
  trimImages() {
    if (this.images.size <= 24) return;
    const keep = new Set();
    for (const o of this.visiblePages()) { if (o.page.bg) keep.add(o.page.bg); o.page.items.forEach((i) => i.asset && keep.add(i.asset)); }
    for (const id of this.images.keys()) {
      if (this.images.size <= 16) break;
      if (!keep.has(id)) this.images.delete(id);
    }
  }

  pageTransform(ctx, o) {
    const { s, x, y } = this.cam, dpr = this.dpr;
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (x + o.x * s), dpr * (y + o.y * s));
  }

  drawLive() {
    const ctx = this.lctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.liveCv.width, this.liveCv.height);
    const L = this.live;
    if (L) {
      this.pageTransform(ctx, L.o);
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, L.o.page.w, L.o.page.h); ctx.clip();
      const pts = L.pred && !L.shape ? L.pts.concat(L.pred) : L.pts;
      ctx.__dark = isDarkPaper(L.o.page.color) && !L.o.page.bg;
      drawStroke(ctx, { type: 'stroke', tool: L.tool, color: L.color, size: L.size, pts, shape: L.shape, closed: L.closed });
      ctx.__dark = false;
      ctx.restore();
    }
    if (this.lasso) {
      this.pageTransform(ctx, this.lasso.o);
      const p = this.lasso.pts;
      ctx.beginPath();
      ctx.moveTo(p[0], p[1]);
      for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
      ctx.lineWidth = 1.5 / this.cam.s;
      ctx.setLineDash([6 / this.cam.s, 5 / this.cam.s]);
      ctx.strokeStyle = '#4f6bed';
      ctx.stroke();
      ctx.fillStyle = 'rgba(79,107,237,0.06)';
      ctx.fill();
      ctx.setLineDash([]);
    }
    const sel = this.selection;
    if (sel) {
      const d = this.drag;
      this.pageTransform(ctx, sel.o);
      if (d) {
        ctx.save();
        if (d.mode === 'move') ctx.translate(d.dx, d.dy);
        else { ctx.translate(d.ox, d.oy); ctx.scale(d.k, d.k); ctx.translate(-d.ox, -d.oy); }
        this.drawItems(ctx, sel.o.page, sel.o.page.items.filter((i) => sel.ids.has(i.id)));
        ctx.restore();
      }
      const b = this.selBox();
      if (b) {
        const s = this.cam.s;
        ctx.lineWidth = 1.5 / s;
        ctx.setLineDash([6 / s, 4 / s]);
        ctx.strokeStyle = '#4f6bed';
        ctx.strokeRect(b.x, b.y, b.w, b.h);
        ctx.setLineDash([]);
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(b.x + b.w, b.y + b.h, 9 / s, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = 2 / s;
        ctx.stroke();
      }
    }
    if (this.hover && (this.tool === 'eraser')) {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.beginPath();
      ctx.arc(this.hover.x, this.hover.y, this.eraserRadius() * this.cam.s, 0, Math.PI * 2);
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = 'rgba(120,120,120,0.9)';
      ctx.stroke();
    }
  }

  drawItems(ctx, page, items) {
    ctx.__dark = isDarkPaper(page.color) && !page.bg;
    for (const it of items) {
      if (it.type === 'image') { const img = this.images.get(it.asset); if (img) ctx.drawImage(img, it.x, it.y, it.w, it.h); }
      else if (it.type === 'stroke') drawStroke(ctx, it);
      else if (it.type === 'text') drawText(ctx, it);
    }
    ctx.__dark = false;
  }

  positionOverlays() {
    this.positionSelMenu();
    if (this.textEdit) this.placeTextarea();
  }

  flashIndicator(text) {
    const i = this.currentIndex();
    this.pageInd.textContent = text || `${i + 1} / ${this.pages.length}`;
    this.pageInd.classList.add('show');
    clearTimeout(this.indTimer);
    this.indTimer = setTimeout(() => this.pageInd.classList.remove('show'), 900);
  }

  setInteracting(on) {
    clearTimeout(this.idleTimer);
    if (on) { this.interacting = true; return; }
    this.idleTimer = setTimeout(() => { this.interacting = false; this.requestRender(); }, 140);
  }

  // ------------------------------------------------------------- input ----

  localPos(e) {
    const r = this.liveCv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  onDown(e) {
    e.preventDefault();
    closePopover();
    try { this.liveCv.setPointerCapture(e.pointerId); } catch {}
    const pos = this.localPos(e);
    const p = { id: e.pointerId, type: e.pointerType, sx: pos.x, sy: pos.y, x0: pos.x, y0: pos.y, t0: performance.now(), role: null };

    if (e.pointerType === 'pen' && !settings.penSeen) {
      settings.penSeen = true;
      saveSettings();
      if (settings.fingerDraw === 'auto') toast('Pencil detected — fingers now scroll & zoom (change in Settings)', 3200);
    }

    if (e.pointerType === 'touch') {
      if (this.penActive) return; // palm rejection
      this.pointers.set(p.id, p);
      const touches = [...this.pointers.values()].filter((q) => q.type === 'touch' && q.role !== 'ignore');
      if (touches.length === 1 && fingerDraws() && this.tool !== 'hand') {
        p.role = 'draw';
        this.startTool(p, e);
        return;
      }
      for (const q of touches) {
        if (q.role === 'draw') {
          if (p.t0 - q.t0 < 260) { this.cancelTool(q); q.role = 'gesture'; }
          else { p.role = 'ignore'; return; }
        }
      }
      p.role = 'gesture';
      this.beginGesture();
      return;
    }

    // pen / mouse
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
    this.pointers.set(p.id, p);
    if (e.pointerType === 'pen') {
      this.penActive = true;
      this.stopInertia();
      for (const q of this.pointers.values()) if (q.type === 'touch') { if (q.role === 'draw') this.cancelTool(q); q.role = 'ignore'; }
      this.gesture = null;
    }
    if (this.tool === 'hand' || this.spaceDown || e.button === 1) {
      p.role = 'gesture';
      this.beginGesture();
    } else {
      p.role = 'draw';
      this.startTool(p, e);
    }
  }

  onMove(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) {
      if ((e.pointerType === 'pen' || e.pointerType === 'mouse') && this.tool === 'eraser') {
        this.hover = this.localPos(e);
        this.requestLive();
      }
      return;
    }
    e.preventDefault();
    if (p.role === 'gesture') {
      const pos = this.localPos(e);
      p.sx = pos.x; p.sy = pos.y;
      this.moveGesture();
      return;
    }
    if (p.role !== 'draw') return;
    let evs = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    if (!evs || !evs.length) evs = [e];
    for (const ev of evs) {
      const pos = this.localPos(ev);
      p.sx = pos.x; p.sy = pos.y;
      this.moveTool(p, ev);
    }
    if (this.live && !this.live.shape && e.getPredictedEvents) {
      const pred = e.getPredictedEvents();
      const L = this.live;
      L.pred = [];
      for (const ev of pred.slice(0, 2)) {
        const pos = this.localPos(ev);
        const d = this.screenToDoc(pos.x, pos.y);
        L.pred.push(d.x - L.o.x, d.y - L.o.y, L.lastP);
      }
    }
    if (this.tool === 'eraser') this.hover = { x: p.sx, y: p.sy };
    this.requestLive();
  }

  onUp(e, cancelled = false) {
    const p = this.pointers.get(e.pointerId);
    if (e.pointerType === 'pen') { this.penActive = false; this.hover = null; }
    if (!p) return;
    this.pointers.delete(e.pointerId);
    if (p.role === 'gesture') this.endGesture(p);
    else if (p.role === 'draw') this.endTool(p, cancelled && p.type === 'touch');
    if (e.pointerType === 'touch' && this.tool === 'eraser') this.hover = null;
    this.requestLive();
  }

  // ---- pan / pinch ----

  gesturePointers() { return [...this.pointers.values()].filter((q) => q.role === 'gesture'); }

  beginGesture() {
    this.stopInertia();
    const g = this.gesturePointers();
    if (!g.length) { this.gesture = null; return; }
    const cx = g.reduce((a, q) => a + q.sx, 0) / g.length;
    const cy = g.reduce((a, q) => a + q.sy, 0) / g.length;
    const dist = g.length > 1 ? Math.hypot(g[0].sx - g[1].sx, g[0].sy - g[1].sy) : 0;
    const prev = this.gesture;
    this.gesture = {
      n: g.length, cx, cy, dist,
      s0: this.cam.s, x0: this.cam.x, y0: this.cam.y,
      anchor: this.screenToDoc(cx, cy),
      t0: prev ? prev.t0 : performance.now(),
      maxN: Math.max(prev ? prev.maxN : 0, g.length),
      moved: prev ? prev.moved : false,
      samples: [],
    };
    this.setInteracting(true);
  }

  moveGesture() {
    const G = this.gesture;
    if (!G) return;
    const g = this.gesturePointers();
    if (g.length !== G.n) { this.beginGesture(); return; }
    const cx = g.reduce((a, q) => a + q.sx, 0) / g.length;
    const cy = g.reduce((a, q) => a + q.sy, 0) / g.length;
    if (!G.moved && Math.hypot(cx - G.cx, cy - G.cy) < 6 && (g.length < 2 || Math.abs(Math.hypot(g[0].sx - g[1].sx, g[0].sy - g[1].sy) - G.dist) < 8)) return;
    G.moved = true;
    if (g.length >= 2) {
      const dist = Math.hypot(g[0].sx - g[1].sx, g[0].sy - g[1].sy);
      this.cam.s = clamp(G.s0 * dist / (G.dist || 1), 0.12, 10);
      this.cam.x = cx - G.anchor.x * this.cam.s;
      this.cam.y = cy - G.anchor.y * this.cam.s;
      this.flashIndicator(Math.round(this.cam.s / this.fitScale() * 100) + '%');
    } else {
      this.cam.x = G.x0 + (cx - G.cx);
      this.cam.y = G.y0 + (cy - G.cy);
      G.samples.push({ t: performance.now(), x: cx, y: cy });
      if (G.samples.length > 6) G.samples.shift();
      this.flashIndicator();
    }
    this.clampCam();
    this.requestRender();
  }

  endGesture(p) {
    const G = this.gesture;
    const remaining = this.gesturePointers();
    if (remaining.length) { this.beginGesture(); return; }
    this.gesture = null;
    if (!G) { this.setInteracting(false); return; }
    const dt = performance.now() - G.t0;
    if (!G.moved && dt < 320 && p.type === 'touch' && settings.twoFingerUndo) {
      if (G.maxN === 2) { this.undo(); this.flashIndicator('Undo'); }
      else if (G.maxN === 3) { this.redo(); this.flashIndicator('Redo'); }
    }
    // inertia for one-finger flicks
    const sm = G.samples;
    if (G.moved && G.n === 1 && sm.length >= 2) {
      const a = sm[0], b = sm[sm.length - 1];
      const t = b.t - a.t;
      if (t > 0 && performance.now() - b.t < 60) {
        let vx = (b.x - a.x) / t, vy = (b.y - a.y) / t;
        if (Math.hypot(vx, vy) > 0.25) { this.startInertia(vx * 16, vy * 16); return; }
      }
    }
    this.setInteracting(false);
  }

  startInertia(vx, vy) {
    this.stopInertia();
    const step = () => {
      vx *= 0.94; vy *= 0.94;
      this.cam.x += vx; this.cam.y += vy;
      this.clampCam();
      this.requestRender();
      if (Math.hypot(vx, vy) > 0.3) this.inertia = requestAnimationFrame(step);
      else { this.inertia = 0; this.setInteracting(false); }
    };
    this.inertia = requestAnimationFrame(step);
  }

  stopInertia() { if (this.inertia) { cancelAnimationFrame(this.inertia); this.inertia = 0; } }

  onWheel(e) {
    e.preventDefault();
    this.stopInertia();
    this.setInteracting(true);
    const pos = this.localPos(e);
    let dx = e.deltaX, dy = e.deltaY;
    if (e.deltaMode === 1) { dx *= 16; dy *= 16; }
    if (e.ctrlKey || e.metaKey) {
      this.zoomAt(pos.x, pos.y, this.cam.s * Math.exp(-dy * 0.01));
      this.flashIndicator(Math.round(this.cam.s / this.fitScale() * 100) + '%');
    } else {
      if (e.shiftKey && !dx) { dx = dy; dy = 0; }
      this.cam.x -= dx; this.cam.y -= dy;
      this.clampCam();
      this.flashIndicator();
    }
    this.requestRender();
    this.setInteracting(false);
  }

  zoomAt(sx, sy, s) {
    const d = this.screenToDoc(sx, sy);
    this.cam.s = clamp(s, 0.12, 10);
    this.cam.x = sx - d.x * this.cam.s;
    this.cam.y = sy - d.y * this.cam.s;
    this.clampCam();
    this.requestRender();
  }

  // ---- tools ----

  toolCfg(t = this.tool) { return settings.tools[t]; }
  currentColor(t = this.tool) { const c = this.toolCfg(t); return c.colors[c.color]; }
  currentSize(t = this.tool) { const c = this.toolCfg(t); return c.sizes[c.size]; }
  eraserRadius() { return this.currentSize('eraser') / 2 / this.cam.s; }

  startTool(p, e) {
    const d = this.screenToDoc(p.sx, p.sy);
    const t = this.tool;
    if (this.textEdit && t !== 'text') this.commitText();
    if (t === 'pen' || t === 'hl') {
      const o = this.pageAt(d.x, d.y);
      if (!o) { p.role = 'none'; return; }
      if (this.selection) this.clearSelection();
      const lx = d.x - o.x, ly = d.y - o.y;
      const pr = this.pressure(e, null);
      this.live = {
        o, pid: p.id, tool: t, color: this.currentColor(t), size: this.currentSize(t),
        pts: [round2(lx), round2(ly), pr], lastP: pr, lastT: e.timeStamp, last: { x: lx, y: ly },
        raw: { x: lx, y: ly }, holdRef: { x: p.sx, y: p.sy }, startT: performance.now(), shape: false,
        pen: e.pointerType === 'pen',
      };
      this.armHold();
      this.requestLive();
    } else if (t === 'eraser') {
      const o = this.pageAt(d.x, d.y, 30);
      if (!o) { p.role = 'none'; return; }
      if (this.selection) this.clearSelection();
      this.erase = { o, removed: new Map(), added: new Map(), last: { x: d.x - o.x, y: d.y - o.y } };
      this.eraseSeg(d.x - o.x, d.y - o.y);
      this.hover = { x: p.sx, y: p.sy };
    } else if (t === 'lasso') {
      if (this.selection) {
        const hit = this.selHit(p.sx, p.sy);
        if (hit) { this.startDrag(hit, p); return; }
        this.clearSelection();
      }
      const o = this.pageAt(d.x, d.y, 40);
      if (!o) { p.role = 'none'; return; }
      this.lasso = { o, pts: [d.x - o.x, d.y - o.y] };
    } else if (t === 'text') {
      // handled on pointer-up so the keyboard can open (iOS needs a user gesture)
    }
  }

  moveTool(p, ev) {
    const d = this.screenToDoc(p.sx, p.sy);
    const L = this.live;
    if (L) {
      if (L.shape) return;
      const lx = d.x - L.o.x, ly = d.y - L.o.y;
      const minStep = 0.4 / this.cam.s;
      if (Math.hypot(lx - L.raw.x, ly - L.raw.y) < minStep) return;
      L.raw = { x: lx, y: ly };
      const pr = this.pressure(ev, L);
      // light exponential smoothing; more when zoomed out / using fingers
      const k = L.tool === 'hl' ? 0.5 : (L.pen ? 0.62 : 0.5);
      const sx = L.last.x + (lx - L.last.x) * k, sy = L.last.y + (ly - L.last.y) * k;
      L.last = { x: sx, y: sy };
      L.pts.push(round2(sx), round2(sy), Math.round(pr * 1000) / 1000);
      L.lastP = pr;
      if (Math.hypot(p.sx - L.holdRef.x, p.sy - L.holdRef.y) > 5) {
        L.holdRef = { x: p.sx, y: p.sy };
        this.armHold();
      }
      return;
    }
    if (this.erase) {
      const E = this.erase;
      const lx = d.x - E.o.x, ly = d.y - E.o.y;
      this.eraseSeg(lx, ly);
      return;
    }
    if (this.drag) { this.updateDrag(p); return; }
    if (this.lasso) {
      const o = this.lasso.o, pts = this.lasso.pts;
      const lx = d.x - o.x, ly = d.y - o.y;
      if (Math.hypot(lx - pts[pts.length - 2], ly - pts[pts.length - 1]) > 2 / this.cam.s) pts.push(lx, ly);
    }
  }

  endTool(p, cancelled) {
    if (this.live && this.live.pid === p.id) {
      clearTimeout(this.holdTimer);
      if (cancelled) this.live = null;
      else this.commitStroke(p);
    } else if (this.erase) this.finishErase();
    else if (this.drag) this.endDrag();
    else if (this.lasso) this.finishLasso(p);
    else if (this.tool === 'text' && !cancelled) this.textTap(p);
    this.requestLive();
  }

  cancelTool(p) {
    if (this.live && this.live.pid === p.id) { clearTimeout(this.holdTimer); this.live = null; }
    else if (this.erase) this.finishErase();
    else if (this.drag) this.endDrag();
    else if (this.lasso) this.lasso = null;
    p.role = 'none';
    this.requestLive();
  }

  pressure(ev, L) {
    if (ev.pointerType === 'pen') {
      if (!settings.pressure) return 0.5;
      let pr = ev.pressure;
      if (!pr) pr = L ? L.lastP : 0.4;
      return clamp(Math.pow(pr, 0.8), 0.04, 1);
    }
    if (!settings.pressure || !L) return 0.55;
    // simulate pressure from speed for mouse / finger
    const dt = Math.max(1, ev.timeStamp - L.lastT);
    L.lastT = ev.timeStamp;
    const v = Math.hypot(ev.movementX || 0, ev.movementY || 0) / dt;
    const target = clamp(0.7 - v * 0.12, 0.35, 0.7);
    return L.lastP + (target - L.lastP) * 0.25;
  }

  armHold() {
    clearTimeout(this.holdTimer);
    if (!settings.shapeHold) return;
    this.holdTimer = setTimeout(() => {
      const L = this.live;
      if (!L || L.shape || L.pts.length < 18) return;
      const shape = recognize(L.pts);
      if (!shape) return;
      L.shape = true;
      L.closed = shape.closed;
      L.pts = shape.pts.map(round2);
      L.pred = null;
      this.requestLive();
      if (navigator.vibrate) navigator.vibrate(10);
    }, HOLD_MS);
  }

  commitStroke(p) {
    const L = this.live;
    this.live = null;
    const tap = Math.hypot(p.sx - p.x0, p.sy - p.y0) < 6 && performance.now() - p.t0 < 350;
    if (this.playback && tap && this.seekToStrokeAt(L.o, L.pts[0], L.pts[1])) { this.requestLive(); return; }
    let pts = L.pts;
    if (!L.shape && L.raw && pts.length > 3) pts = pts.concat([round2(L.raw.x), round2(L.raw.y), L.lastP]);
    const item = { id: uid(), type: 'stroke', tool: L.tool, color: L.color, size: L.size, pts, z: ++this.body.zc };
    if (L.shape) { item.shape = true; if (L.closed) item.closed = true; }
    if (this.rec) { item.rec = this.rec.id; item.t = Math.round(L.startT - this.rec.start); }
    const page = L.o.page;
    page.items.push(item);
    this.pushOp({ kind: 'items', page: page.id, add: [structuredClone(item)], remove: [] });
    this.paintOnCache(page, item);
    if (settings.autoAddPage && page === this.pages[this.pages.length - 1] && !page.bg) {
      const b = itemBBox(item);
      if (b.y + b.h > page.h * 0.82) this.addPage(this.pages.length - 1, true);
    }
  }

  // ---- eraser ----

  eraseSeg(lx, ly) {
    const E = this.erase;
    const page = E.o.page;
    const r = this.eraserRadius();
    const ax = E.last.x, ay = E.last.y;
    E.last = { x: lx, y: ly };
    const partial = this.toolCfg('eraser').mode === 'partial';
    let changed = false;
    for (let i = page.items.length - 1; i >= 0; i--) {
      const it = page.items[i];
      if (it.type !== 'stroke') continue;
      if (!strokeHitSegment(it, ax, ay, lx, ly, r)) continue;
      changed = true;
      page.items.splice(i, 1);
      if (E.added.has(it.id)) E.added.delete(it.id);
      else E.removed.set(it.id, structuredClone(it));
      if (partial) {
        const parts = splitStroke(it, ax, ay, lx, ly, r);
        for (const pts of parts) {
          const n = { ...it, id: uid(), pts };
          delete n.closed;
          page.items.splice(i, 0, n);
          E.added.set(n.id, n);
        }
      }
    }
    if (changed) this.markDirty(page);
  }

  finishErase() {
    const E = this.erase;
    this.erase = null;
    if (!E.removed.size && !E.added.size) return;
    this.pushOp({ kind: 'items', page: E.o.page.id, remove: [...E.removed.values()], add: [...E.added.values()].map((i) => structuredClone(i)) });
  }

  // ---- lasso & selection ----

  finishLasso(p) {
    const L = this.lasso;
    this.lasso = null;
    const page = L.o.page;
    let ids;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < L.pts.length; i += 2) {
      x0 = Math.min(x0, L.pts[i]); x1 = Math.max(x1, L.pts[i]);
      y0 = Math.min(y0, L.pts[i + 1]); y1 = Math.max(y1, L.pts[i + 1]);
    }
    if (L.pts.length < 8 || Math.max(x1 - x0, y1 - y0) * this.cam.s < 10) {
      // tap: pick the top item under the finger/pen
      const [x, y] = L.pts;
      const r = 8 / this.cam.s;
      const hit = [...page.items].reverse().find((it) => {
        if (it.type === 'stroke') return strokeHit(it, x, y, r);
        const b = itemBBox(it);
        return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
      });
      ids = hit ? [hit.id] : [];
    } else {
      ids = page.items.filter((it) => lassoHit(it, L.pts)).map((i) => i.id);
    }
    if (ids.length) this.select(L.o, ids);
    else this.requestLive();
  }

  select(o, ids) {
    if (this.tool !== 'lasso') this.setTool('lasso', true);
    this.selection = { o, ids: new Set(ids) };
    this.showSelMenu();
    this.requestLive();
  }

  clearSelection() {
    this.selection = null;
    this.selMenu.hidden = true;
    this.requestLive();
  }

  selItems() {
    const s = this.selection;
    return s ? s.o.page.items.filter((i) => s.ids.has(i.id)) : [];
  }

  selBox() {
    const items = this.selItems();
    if (!items.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const it of items) {
      const b = itemBBox(it);
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
    }
    let b = { x: x0 - 6, y: y0 - 6, w: x1 - x0 + 12, h: y1 - y0 + 12 };
    const d = this.drag;
    if (d) {
      if (d.mode === 'move') b = { ...b, x: b.x + d.dx, y: b.y + d.dy };
      else b = { x: d.ox + (b.x - d.ox) * d.k, y: d.oy + (b.y - d.oy) * d.k, w: b.w * d.k, h: b.h * d.k };
    }
    return b;
  }

  selScreenBox() {
    const b = this.selBox();
    if (!b) return null;
    const o = this.selection.o, { s, x, y } = this.cam;
    return { x: x + (o.x + b.x) * s, y: y + (o.y + b.y) * s, w: b.w * s, h: b.h * s };
  }

  selHit(sx, sy) {
    const r = this.selScreenBox();
    if (!r) return null;
    if (Math.hypot(sx - (r.x + r.w), sy - (r.y + r.h)) < 26) return 'scale';
    if (sx >= r.x - 10 && sx <= r.x + r.w + 10 && sy >= r.y - 10 && sy <= r.y + r.h + 10) return 'move';
    return null;
  }

  startDrag(mode, p) {
    const b = this.selBox();
    this.drag = { mode, sx0: p.sx, sy0: p.sy, dx: 0, dy: 0, k: 1, ox: b.x + 6, oy: b.y + 6, bw: b.w, bh: b.h };
    this.hidden = new Set(this.selection.ids);
    this.markDirty(this.selection.o.page);
    this.selMenu.hidden = true;
  }

  updateDrag(p) {
    const d = this.drag, s = this.cam.s;
    if (d.mode === 'move') { d.dx = (p.sx - d.sx0) / s; d.dy = (p.sy - d.sy0) / s; }
    else {
      const ddx = (p.sx - d.sx0) / s, ddy = (p.sy - d.sy0) / s;
      d.k = clamp((d.bw + d.bh + ddx + ddy) / (d.bw + d.bh), 0.1, 20);
    }
  }

  endDrag() {
    const d = this.drag;
    this.drag = null;
    this.hidden = null;
    const page = this.selection.o.page;
    const moved = d.mode === 'move' ? Math.hypot(d.dx, d.dy) > 0.5 : Math.abs(d.k - 1) > 0.005;
    if (moved) {
      const items = this.selItems();
      const before = items.map((i) => structuredClone(i));
      for (const it of items) {
        if (d.mode === 'move') transformItem(it, d.dx, d.dy);
        else transformItem(it, 0, 0, d.k, d.k, d.ox, d.oy);
      }
      this.pushOp({ kind: 'items', page: page.id, remove: before, add: items.map((i) => structuredClone(i)) });
    }
    this.markDirty(page);
    this.showSelMenu();
  }

  showSelMenu() {
    const m = this.selMenu;
    m.innerHTML = '';
    const b = (icon, label, fn, cls = '') => h('button', { class: 'sel-btn ' + cls, title: label, 'aria-label': label, onClick: (e) => { e.stopPropagation(); fn(); }, html: icons[icon] });
    const colors = settings.tools.pen.colors.map((c) => h('button', {
      class: 'swatch sm', style: { background: c }, title: 'Recolour', 'aria-label': 'Recolour',
      onClick: () => this.recolorSelection(c),
    }));
    m.append(
      h('div', { class: 'sel-colors' }, colors),
      b('duplicate', 'Duplicate', () => this.duplicateSelection()),
      b('copy', 'Copy', () => this.copySelection()),
      b('cut', 'Cut', () => { this.copySelection(); this.deleteSelection(); }),
      b('trash', 'Delete', () => this.deleteSelection(), 'danger'));
    m.hidden = false;
    this.positionSelMenu();
  }

  positionSelMenu() {
    if (!this.selection || this.selMenu.hidden) return;
    const r = this.selScreenBox();
    if (!r) return;
    const mw = this.selMenu.offsetWidth, mh = this.selMenu.offsetHeight;
    let left = clamp(r.x + r.w / 2 - mw / 2, 6, this.vw - mw - 6);
    let top = r.y - mh - 12;
    if (top < 6) top = Math.min(this.vh - mh - 6, r.y + r.h + 16);
    this.selMenu.style.transform = `translate(${left}px, ${top}px)`;
  }

  recolorSelection(color) {
    const items = this.selItems().filter((i) => i.type !== 'image');
    if (!items.length) return;
    const before = items.map((i) => structuredClone(i));
    items.forEach((i) => { i.color = color; invalidate(i); });
    this.pushOp({ kind: 'items', page: this.selection.o.page.id, remove: before, add: items.map((i) => structuredClone(i)) });
    this.markDirty(this.selection.o.page);
  }

  deleteSelection() {
    const items = this.selItems();
    if (!items.length) return;
    const page = this.selection.o.page;
    page.items = page.items.filter((i) => !this.selection.ids.has(i.id));
    this.pushOp({ kind: 'items', page: page.id, remove: items.map((i) => structuredClone(i)), add: [] });
    this.clearSelection();
    this.markDirty(page);
  }

  copySelection() {
    const items = this.selItems();
    if (!items.length) return;
    clipboard = items.map((i) => structuredClone(i));
    toast(items.length === 1 ? 'Copied' : `Copied ${items.length} items`);
    this.renderToolbar();
  }

  duplicateSelection() {
    const items = this.selItems();
    this.insertItems(this.selection.o, items.map((i) => structuredClone(i)), 20);
  }

  paste() {
    if (!clipboard) return;
    const o = this.lay[this.currentIndex()];
    this.insertItems(o, clipboard.map((i) => structuredClone(i)), 20);
  }

  insertItems(o, items, offset = 0) {
    const page = o.page;
    for (const it of items) {
      it.id = uid();
      it.z = ++this.body.zc;
      delete it.rec; delete it.t;
      if (offset) transformItem(it, offset, offset);
      page.items.push(it);
    }
    this.pushOp({ kind: 'items', page: page.id, add: items.map((i) => structuredClone(i)), remove: [] });
    this.markDirty(page);
    this.select(o, items.map((i) => i.id));
  }

  // ---- text ----

  textTap(p) {
    const d = this.screenToDoc(p.sx, p.sy);
    if (Math.hypot(p.sx - p.x0, p.sy - p.y0) > 10) return;
    if (this.textEdit) { this.commitText(); return; }
    const o = this.pageAt(d.x, d.y);
    if (!o) return;
    const lx = d.x - o.x, ly = d.y - o.y;
    const existing = [...o.page.items].reverse().find((it) => {
      if (it.type !== 'text') return false;
      const b = itemBBox(it);
      return lx >= b.x - 6 && lx <= b.x + b.w + 6 && ly >= b.y - 6 && ly <= b.y + b.h + 6;
    });
    if (existing) { this.editText(o, existing, false); return; }
    const cfg = this.toolCfg('text');
    const size = cfg.sizes[cfg.size];
    const x = clamp(lx, 8, o.page.w - 60);
    const item = {
      id: uid(), type: 'text', x, y: Math.max(4, ly - size * 0.65),
      w: Math.max(80, Math.min(420, o.page.w - x - 24)), text: '', size, color: cfg.colors[cfg.color], font: cfg.font, z: ++this.body.zc,
    };
    this.editText(o, item, true);
  }

  editText(o, item, isNew) {
    this.textEdit = { o, item, isNew, before: isNew ? null : structuredClone(item) };
    if (!isNew) { this.hidden = new Set([item.id]); this.markDirty(o.page); }
    const ta = this.textarea;
    ta.value = item.text;
    ta.hidden = false;
    this.placeTextarea();
    ta.focus({ preventScroll: true });
    const len = ta.value.length;
    ta.setSelectionRange(len, len);
  }

  placeTextarea() {
    const { o, item } = this.textEdit, { s, x, y } = this.cam;
    const ta = this.textarea;
    ta.style.left = (x + (o.x + item.x) * s) + 'px';
    ta.style.top = (y + (o.y + item.y) * s) + 'px';
    ta.style.width = (item.w * s + 4) + 'px';
    ta.style.fontSize = (item.size * s) + 'px';
    ta.style.fontFamily = FONTS[item.font] || FONTS.sans;
    ta.style.color = item.color;
    this.sizeTextarea();
  }

  sizeTextarea() {
    const ta = this.textarea;
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }

  commitText() {
    const te = this.textEdit;
    if (!te) return;
    this.textEdit = null;
    const ta = this.textarea;
    ta.hidden = true;
    if (document.activeElement === ta) ta.blur();
    this.hidden = null;
    const page = te.o.page, item = te.item;
    const text = ta.value.replace(/\s+$/, '');
    if (te.isNew) {
      if (text) {
        item.text = text;
        item.h = measureText(item);
        page.items.push(item);
        this.pushOp({ kind: 'items', page: page.id, add: [structuredClone(item)], remove: [] });
      }
    } else if (!text) {
      page.items = page.items.filter((i) => i.id !== item.id);
      this.pushOp({ kind: 'items', page: page.id, remove: [te.before], add: [] });
    } else if (text !== te.before.text) {
      item.text = text;
      item.h = measureText(item);
      this.pushOp({ kind: 'items', page: page.id, remove: [te.before], add: [structuredClone(item)] });
    }
    this.markDirty(page);
  }

  // ---- images ----

  async pickImages() {
    const files = await pickFile('image/*', true);
    if (files.length) this.insertImages(files);
  }

  async insertImages(files) {
    const o = this.lay[this.currentIndex()];
    const page = o.page;
    const added = [];
    for (const f of files) {
      try {
        const blob = await downscale(f, 2200);
        const id = await putAsset(uid(), blob);
        const img = await loadImage(await assetURL(id));
        this.images.set(id, img);
        const ratio = img.naturalHeight / img.naturalWidth;
        let w = Math.min(img.naturalWidth, page.w * 0.6);
        let hh = w * ratio;
        if (hh > page.h * 0.6) { hh = page.h * 0.6; w = hh / ratio; }
        const vc = this.screenToDoc(this.vw / 2, this.vh / 2);
        const off = added.length * 24;
        const item = {
          id: uid(), type: 'image', asset: id, w, h: hh, z: ++this.body.zc,
          x: clamp((page.w - w) / 2 + off, 0, page.w - w),
          y: clamp(vc.y - o.y - hh / 2 + off, 0, Math.max(0, page.h - hh)),
        };
        page.items.push(item);
        added.push(item);
      } catch (e) { toast('Could not open that image'); }
    }
    if (!added.length) return;
    this.pushOp({ kind: 'items', page: page.id, add: added.map((i) => structuredClone(i)), remove: [] });
    this.markDirty(page);
    this.select(o, added.map((i) => i.id));
  }

  // ---- undo ----

  pushOp(op) {
    this.undoStack.push(op);
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack.length = 0;
    this.updateUndo();
    this.changed();
  }

  applyOp(op, dir) {
    if (op.kind === 'items') {
      const page = this.pageById(op.page);
      if (!page) return;
      const rem = dir > 0 ? op.remove : op.add;
      const add = dir > 0 ? op.add : op.remove;
      const ids = new Set(rem.map((i) => i.id));
      page.items = page.items.filter((i) => !ids.has(i.id));
      for (const a of add) page.items.push(structuredClone(a));
      page.items.sort((a, b) => a.z - b.z);
      this.markDirty(page);
      this.scrollIntoViewIfNeeded(page);
    } else if (op.kind === 'pages') {
      const list = dir > 0 ? op.after : op.before;
      this.pages.length = 0;
      this.pages.push(...list);
      this.pagesChanged();
    } else if (op.kind === 'props') {
      for (const c of op.changes) {
        const page = this.pageById(c.id);
        if (page) Object.assign(page, dir > 0 ? c.after : c.before);
      }
      this.pagesChanged();
    }
  }

  scrollIntoViewIfNeeded(page) {
    if (this.visiblePages().some((o) => o.page === page)) return;
    const i = this.pages.indexOf(page);
    if (i >= 0) this.scrollToPage(i);
  }

  undo() {
    if (this.textEdit) this.commitText();
    const op = this.undoStack.pop();
    if (!op) return;
    this.clearSelection();
    this.applyOp(op, -1);
    this.redoStack.push(op);
    this.updateUndo();
    this.changed();
  }

  redo() {
    const op = this.redoStack.pop();
    if (!op) return;
    this.clearSelection();
    this.applyOp(op, 1);
    this.undoStack.push(op);
    this.updateUndo();
    this.changed();
  }

  updateUndo() {
    this.undoBtn.disabled = !this.undoStack.length;
    this.redoBtn.disabled = !this.redoStack.length;
  }

  // ---- pages ----

  pagesChanged() {
    this.layoutPages();
    const ids = new Set(this.pages.map((p) => p.id));
    for (const [id, c] of this.caches) if (!ids.has(id)) { c.canvas.width = c.canvas.height = 0; this.caches.delete(id); }
    this.markAllDirty();
    this.clampCam();
    if (!this.pagesPanel.hidden) this.renderPagesPanel();
  }

  pagesOp(mutate) {
    const before = this.pages.slice();
    mutate();
    const after = this.pages.slice();
    this.pushOp({ kind: 'pages', before, after });
    this.pagesChanged();
  }

  addPage(afterIndex = this.currentIndex(), silent = false) {
    const ref = this.pages[afterIndex] || this.pages[this.pages.length - 1];
    const p = newPage(ref && !ref.bg ? { w: ref.w, h: ref.h, template: ref.template, color: ref.color } : {});
    this.pagesOp(() => this.pages.splice(afterIndex + 1, 0, p));
    if (!silent) { this.scrollToPage(afterIndex + 1); toast('Page added'); }
  }

  duplicatePage(i = this.currentIndex()) {
    const src = this.pages[i];
    const p = structuredClone(src);
    p.id = uid();
    for (const it of p.items) it.id = uid();
    this.pagesOp(() => this.pages.splice(i + 1, 0, p));
    this.scrollToPage(i + 1);
  }

  async deletePage(i = this.currentIndex()) {
    if (this.pages.length === 1) {
      if (!this.pages[0].items.length) return;
      if (!(await confirmDialog('Clear this page?', 'It is the only page. You can undo this.', { ok: 'Clear' }))) return;
      const page = this.pages[0];
      this.pushOp({ kind: 'items', page: page.id, remove: page.items.map((x) => structuredClone(x)), add: [] });
      page.items = [];
      this.markDirty(page);
      return;
    }
    this.clearSelection();
    this.pagesOp(() => this.pages.splice(i, 1));
    toast('Page deleted — undo to restore');
  }

  movePage(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= this.pages.length) return;
    this.pagesOp(() => { const [p] = this.pages.splice(i, 1); this.pages.splice(j, 0, p); });
    this.scrollToPage(j);
  }

  togglePagesPanel() {
    this.pagesPanel.hidden = !this.pagesPanel.hidden;
    if (!this.pagesPanel.hidden) this.renderPagesPanel();
    requestAnimationFrame(() => this.resize());
  }

  renderPagesPanel() {
    const P = this.pagesPanel;
    P.innerHTML = '';
    const cur = this.currentIndex();
    const act = (icon, label, fn) => h('button', { class: 'icon-btn sm', title: label, 'aria-label': label, html: icons[icon], onClick: fn });
    P.append(h('div', { class: 'pp-head' },
      h('strong', {}, `Pages (${this.pages.length})`),
      h('div', { class: 'grow' }),
      act('close', 'Close', () => this.togglePagesPanel())));
    const list = h('div', { class: 'pp-list' });
    this.pages.forEach((page, i) => {
      const thumb = h('div', { class: 'pp-thumb' + (i === cur ? ' current' : ''), style: { aspectRatio: `${page.w} / ${page.h}` } });
      renderPageCanvas(page, 150 / page.w).then((c) => thumb.append(c));
      list.append(h('div', { class: 'pp-item' },
        h('button', { class: 'pp-open', onClick: () => { this.scrollToPage(i); this.renderPagesPanel(); } }, thumb, h('span', { class: 'pp-num' }, String(i + 1))),
        h('div', { class: 'pp-actions' },
          act('up', 'Move up', () => this.movePage(i, -1)),
          act('down', 'Move down', () => this.movePage(i, 1)),
          act('duplicate', 'Duplicate page', () => this.duplicatePage(i)),
          act('trash', 'Delete page', () => this.deletePage(i)))));
    });
    P.append(list, h('button', { class: 'btn block', onClick: () => this.addPage(this.pages.length - 1) }, '+ Add page'));
  }

  // ---- menus ----

  paperMenu(anchor) {
    const i = this.currentIndex();
    const page = this.pages[i];
    let scope = 'all';
    const apply = (props) => {
      const targets = scope === 'all' ? this.pages.filter((p) => !p.bg || !('template' in props)) : [page];
      const changes = targets.map((p) => ({ id: p.id, before: pick(p, Object.keys(props)), after: { ...props } }));
      targets.forEach((p) => Object.assign(p, props));
      this.pushOp({ kind: 'props', changes });
      this.pagesChanged();
      if ('template' in props) settings.defaultTemplate = props.template;
      if ('color' in props) settings.defaultColor = props.color;
      saveSettings();
      this.paperMenu(anchor);
    };
    const scopeSeg = h('div', { class: 'seg' },
      ['all', 'page'].map((v) => h('button', { class: v === scope ? 'on' : '', onClick: (e) => { scope = v; [...e.currentTarget.parentNode.children].forEach((b) => b.classList.toggle('on', b === e.currentTarget)); } }, v === 'all' ? 'All pages' : 'This page')));
    const tpl = h('div', { class: 'tpl-grid' }, TEMPLATES.map((t) => {
      const c = templatePreview(t.id, page.color);
      return h('button', { class: 'tpl' + (page.template === t.id ? ' on' : ''), onClick: () => apply({ template: t.id }) }, c, h('span', {}, t.label));
    }));
    const colors = h('div', { class: 'row wrap' }, PAPER_COLORS.map((c) => h('button', {
      class: 'swatch' + (page.color === c.id ? ' on' : ''), title: c.label, 'aria-label': c.label, style: { background: c.id },
      onClick: () => apply({ color: c.id }),
    })));
    const sizes = h('div', { class: 'row wrap' }, Object.entries(SIZES).map(([id, sz]) => h('button', {
      class: 'chip' + (page.w === sz.w && page.h === sz.h ? ' on' : ''), onClick: () => apply({ w: sz.w, h: sz.h }),
    }, sz.label)));
    popover(anchor, h('div', { class: 'paper-pop' },
      scopeSeg, h('h4', {}, 'Template'), tpl, h('h4', {}, 'Colour'), colors, h('h4', {}, 'Size'), sizes), { className: 'wide' });
  }

  exportMenu(anchor) {
    menu(anchor, [
      { label: 'Export as PDF', icon: 'pdf', onClick: () => this.exportPDF() },
      { label: 'Export this page as image', icon: 'image', onClick: () => this.exportPNG() },
      { label: 'Export note file (.json)', icon: 'download', onClick: () => { this.save.flush(); exportNoteFile(this.meta); } },
    ]);
  }

  moreMenu(anchor) {
    const fd = settings.fingerDraw;
    menu(anchor, [
      { label: 'Insert PDF pages…', icon: 'pdf', onClick: () => this.insertPDF() },
      { label: 'Insert image…', icon: 'image', onClick: () => this.pickImages() },
      { label: 'Add page', icon: 'plus', onClick: () => this.addPage() },
      { label: 'Fit to width', icon: 'zoomFit', onClick: () => this.fitWidth(false) },
      '-',
      { label: 'Draw with finger: Auto', checked: fd === 'auto', onClick: () => this.setFinger('auto') },
      { label: 'Draw with finger: On', checked: fd === 'on', onClick: () => this.setFinger('on') },
      { label: 'Draw with finger: Off', checked: fd === 'off', onClick: () => this.setFinger('off') },
      '-',
      { label: 'Delete this page', icon: 'trash', danger: true, onClick: () => this.deletePage() },
    ]);
  }

  setFinger(v) {
    settings.fingerDraw = v;
    saveSettings();
    toast(fingerDraws() ? 'Fingers draw · two fingers scroll' : 'Fingers scroll · Pencil draws');
  }

  async exportPDF() {
    this.commitText();
    const pd = progressDialog('Exporting PDF…');
    try { await exportNotePDF(this.meta, this.body, (f) => pd.set(f)); }
    catch (e) { toast('Export failed: ' + e.message); }
    pd.close();
  }

  async exportPNG() {
    const page = this.pages[this.currentIndex()];
    const c = await renderPageCanvas(page, 2);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    await saveFile(blob, `${safeName(this.meta.title)} - page ${this.currentIndex() + 1}.png`);
  }

  async insertPDF() {
    const [file] = await pickFile('application/pdf,.pdf');
    if (!file) return;
    const pd = progressDialog('Importing PDF…');
    try {
      const pages = await pdfToPages(file, (i, n) => pd.set(i / n, `Page ${i} of ${n}`));
      const at = this.currentIndex();
      const replaceBlank = this.pages.length === 1 && !this.pages[0].items.length && !this.pages[0].bg;
      this.pagesOp(() => {
        if (replaceBlank) this.pages.splice(0, 1, ...pages);
        else this.pages.splice(at + 1, 0, ...pages);
      });
      this.fitWidth(false);
      this.scrollToPage(replaceBlank ? 0 : at + 1);
    } catch (e) { toast(e.message || 'Could not import PDF'); }
    pd.close();
  }

  // ---- toolbar ----

  setTool(t, keepSelection = false) {
    if (this.textEdit) this.commitText();
    if (!keepSelection && this.selection) this.clearSelection();
    if (this.tool === t && (t === 'pen' || t === 'hl' || t === 'eraser' || t === 'text')) {
      // second tap: nothing extra, options are always visible
    }
    this.tool = t;
    this.hover = null;
    this.renderToolbar();
    this.requestLive();
  }

  renderToolbar() {
    for (const [id, b] of Object.entries(this.toolBtns)) b.classList.toggle('on', id === this.tool);
    const O = this.optsEl;
    O.innerHTML = '';
    const t = this.tool;
    const cfg = settings.tools[t];
    if (t === 'pen' || t === 'hl' || t === 'text') {
      cfg.colors.forEach((c, i) => {
        const sw = h('button', { class: 'swatch' + (i === cfg.color ? ' on' : ''), style: { background: c }, title: i === cfg.color ? 'Tap again to change colour' : 'Colour', 'aria-label': 'Colour ' + (i + 1) });
        sw.addEventListener('click', () => {
          if (i === cfg.color) {
            this.colorInput.value = c;
            this.colorInput.oninput = () => { cfg.colors[i] = this.colorInput.value; saveSettings(); this.renderToolbar(); };
            this.colorInput.click();
          } else { cfg.color = i; saveSettings(); this.renderToolbar(); }
        });
        O.append(sw);
      });
      O.append(h('div', { class: 'tb-sep sm' }));
      cfg.sizes.forEach((sz, i) => {
        const dot = t === 'text' ? h('span', { class: 'size-txt', style: { fontSize: (10 + i * 4) + 'px' } }, 'A')
          : h('span', { class: 'size-dot', style: { width: Math.min(20, 3 + (t === 'hl' ? sz / 2 : sz * 2.2)) + 'px', height: Math.min(20, 3 + (t === 'hl' ? sz / 2 : sz * 2.2)) + 'px', background: cfg.colors[cfg.color] } });
        O.append(h('button', { class: 'size-btn' + (i === cfg.size ? ' on' : ''), title: 'Size', 'aria-label': 'Size ' + (i + 1), onClick: () => { cfg.size = i; saveSettings(); this.renderToolbar(); } }, dot));
      });
      if (t === 'text') {
        O.append(h('button', { class: 'chip', onClick: (e) => menu(e.currentTarget, Object.keys(FONTS).map((f) => ({ label: f[0].toUpperCase() + f.slice(1), checked: cfg.font === f, onClick: () => { cfg.font = f; saveSettings(); } }))) }, 'Font'));
      }
    } else if (t === 'eraser') {
      O.append(h('div', { class: 'seg' },
        h('button', { class: cfg.mode === 'stroke' ? 'on' : '', onClick: () => { cfg.mode = 'stroke'; saveSettings(); this.renderToolbar(); } }, 'Whole stroke'),
        h('button', { class: cfg.mode === 'partial' ? 'on' : '', onClick: () => { cfg.mode = 'partial'; saveSettings(); this.renderToolbar(); } }, 'Precise')));
      cfg.sizes.forEach((sz, i) => O.append(h('button', { class: 'size-btn' + (i === cfg.size ? ' on' : ''), 'aria-label': 'Eraser size ' + (i + 1), onClick: () => { cfg.size = i; saveSettings(); this.renderToolbar(); } },
        h('span', { class: 'size-ring', style: { width: (6 + i * 6) + 'px', height: (6 + i * 6) + 'px' } }))));
    } else if (t === 'lasso') {
      O.append(h('span', { class: 'hint' }, 'Circle items to select · tap an image or text'));
      if (clipboard) O.append(h('button', { class: 'chip', onClick: () => this.paste() }, h('span', { html: icons.paste }), 'Paste'));
    } else if (t === 'hand') {
      O.append(h('span', { class: 'hint' }, 'Drag to scroll · pinch to zoom'));
    }
    this.updateUndo();
  }

  handleKey(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); this.redo(); return; }
    if (mod && k === 'c') { this.copySelection(); return; }
    if (mod && k === 'x') { this.copySelection(); this.deleteSelection(); return; }
    if (mod && k === 'v') { e.preventDefault(); this.paste(); return; }
    if (mod && k === 'd') { e.preventDefault(); if (this.selection) this.duplicateSelection(); return; }
    if (mod && (k === '=' || k === '+')) { e.preventDefault(); this.zoomAt(this.vw / 2, this.vh / 2, this.cam.s * 1.2); return; }
    if (mod && k === '-') { e.preventDefault(); this.zoomAt(this.vw / 2, this.vh / 2, this.cam.s / 1.2); return; }
    if (mod && k === '0') { e.preventDefault(); this.fitWidth(false); return; }
    if (mod && k === 's') { e.preventDefault(); this.save.flush(); toast('Saved'); return; }
    if (mod) return;
    if ((k === 'delete' || k === 'backspace') && this.selection) { e.preventDefault(); this.deleteSelection(); return; }
    if (k === 'escape') { this.clearSelection(); return; }
    if (e.code === 'Space') { this.spaceDown = true; e.preventDefault(); return; }
    const map = { p: 'pen', h: 'hl', e: 'eraser', l: 'lasso', t: 'text' };
    if (map[k]) this.setTool(map[k]);
    if (k === 'pagedown') this.scrollToPage(Math.min(this.pages.length - 1, this.currentIndex() + 1));
    if (k === 'pageup') this.scrollToPage(Math.max(0, this.currentIndex() - 1));
  }

  // ------------------------------------------------------------- audio ----

  async toggleRecord() {
    if (this.rec) return this.stopRecord();
    if (!navigator.mediaDevices || !window.MediaRecorder) { toast('Recording is not supported in this browser'); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch { toast('Microphone permission was denied'); return; }
    this.stopPlayback(true);
    const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    const chunks = [];
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    mr.start(1000);
    this.rec = { id: uid(), start: performance.now(), mr, stream, chunks, mime };
    this.recBtn.classList.add('recording');
    this.recTimer = setInterval(() => { this.recTime.textContent = fmtTime((performance.now() - this.rec.start) / 1000); }, 250);
    this.recTime.textContent = '0:00';
    toast('Recording — your writing is synced to the audio');
  }

  async stopRecord() {
    const r = this.rec;
    if (!r) return;
    this.rec = null;
    clearInterval(this.recTimer);
    this.recBtn.classList.remove('recording');
    this.recTime.textContent = '';
    await new Promise((res) => { r.mr.onstop = res; try { r.mr.stop(); } catch { res(); } });
    r.stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(r.chunks, { type: r.mr.mimeType || r.mime || 'audio/webm' });
    if (!blob.size) return;
    const asset = await putAsset(uid(), blob);
    const n = this.body.recordings.length + 1;
    this.body.recordings.push({ id: r.id, asset, duration: (performance.now() - r.start) / 1000, created: Date.now(), name: `Recording ${n}` });
    this.changed();
    this.renderAudioBar(r.id);
    toast('Recording saved');
  }

  renderAudioBar(selectId) {
    const B = this.audioBar;
    const recs = this.body.recordings;
    B.innerHTML = '';
    if (!recs.length) { B.hidden = true; this.resize(); return; }
    B.hidden = false;
    if (selectId) this.curRec = selectId;
    if (!recs.find((r) => r.id === this.curRec)) this.curRec = recs[recs.length - 1].id;
    const rec = recs.find((r) => r.id === this.curRec);
    const select = h('select', { class: 'rec-select', 'aria-label': 'Recording' }, recs.map((r) => h('option', { value: r.id, selected: r.id === rec.id }, `${r.name} · ${fmtTime(r.duration)}`)));
    select.addEventListener('change', () => { this.stopPlayback(true); this.curRec = select.value; this.renderAudioBar(); });
    this.playBtn = h('button', { class: 'icon-btn', title: 'Play', 'aria-label': 'Play', html: icons.play, onClick: () => this.togglePlay() });
    this.seek = h('input', { type: 'range', min: 0, max: Math.max(1, Math.round(rec.duration * 1000)), value: 0, class: 'seek', 'aria-label': 'Seek' });
    this.seek.addEventListener('input', () => this.seekTo(+this.seek.value));
    this.timeEl = h('span', { class: 'time' }, `0:00 / ${fmtTime(rec.duration)}`);
    const speeds = [1, 1.25, 1.5, 2, 0.75];
    this.speed = this.speed || 1;
    const speedBtn = h('button', { class: 'chip', onClick: () => {
      this.speed = speeds[(speeds.indexOf(this.speed) + 1) % speeds.length];
      speedBtn.textContent = this.speed + '×';
      if (this.player) this.player.playbackRate = this.speed;
    } }, this.speed + '×');
    B.append(
      h('span', { class: 'ab-icon', html: icons.mic }),
      select,
      h('button', { class: 'icon-btn sm', title: 'Back 10 s', onClick: () => this.seekTo((this.playback ? this.playback.ms : 0) - 10000) }, '−10'),
      this.playBtn,
      h('button', { class: 'icon-btn sm', title: 'Forward 10 s', onClick: () => this.seekTo((this.playback ? this.playback.ms : 0) + 10000) }, '+10'),
      this.seek, this.timeEl, speedBtn,
      h('button', { class: 'icon-btn sm', title: 'Delete recording', 'aria-label': 'Delete recording', html: icons.trash, onClick: () => this.deleteRecording(rec) }),
      h('button', { class: 'icon-btn sm', title: 'Close replay', 'aria-label': 'Close replay', html: icons.close, onClick: () => this.stopPlayback(true) }));
    requestAnimationFrame(() => this.resize());
  }

  async ensurePlayer() {
    const rec = this.body.recordings.find((r) => r.id === this.curRec);
    if (!rec) return null;
    if (this.player && this.player.__rec === rec.id) return this.player;
    if (this.player) this.player.pause();
    const a = new Audio(await assetURL(rec.asset));
    a.__rec = rec.id;
    a.preload = 'auto';
    a.playbackRate = this.speed || 1;
    a.onended = () => { this.playBtn.innerHTML = icons.play; cancelAnimationFrame(this.pbRaf); this.updatePlayback(rec.duration * 1000); };
    this.player = a;
    this.recTimes = [];
    this.recPages = new Set();
    for (const p of this.pages) for (const it of p.items) if (it.rec === rec.id) { this.recTimes.push(it.t); this.recPages.add(p.id); }
    this.recTimes.sort((x, y) => x - y);
    return a;
  }

  async togglePlay() {
    if (this.rec) { toast('Stop recording first'); return; }
    const a = await this.ensurePlayer();
    if (!a) return;
    if (!a.paused) { a.pause(); this.playBtn.innerHTML = icons.play; return; }
    if (!this.playback) this.updatePlayback(a.currentTime * 1000, true);
    try { await a.play(); } catch (e) { toast('Could not play audio'); return; }
    this.playBtn.innerHTML = icons.pause;
    const tick = () => {
      this.updatePlayback(a.currentTime * 1000);
      if (!a.paused) this.pbRaf = requestAnimationFrame(tick);
    };
    this.pbRaf = requestAnimationFrame(tick);
  }

  updatePlayback(ms, force) {
    const rec = this.body.recordings.find((r) => r.id === this.curRec);
    if (!rec) return;
    const prev = this.playback;
    this.playback = { rec: rec.id, ms };
    if (this.seek) this.seek.value = Math.round(ms);
    if (this.timeEl) this.timeEl.textContent = `${fmtTime(ms / 1000)} / ${fmtTime(rec.duration)}`;
    const idx = upperBound(this.recTimes || [], ms);
    if (force || !prev || idx !== this.revealIdx) {
      this.revealIdx = idx;
      for (const o of this.lay) if (force || (this.recPages && this.recPages.has(o.page.id))) this.markDirty(o.page);
    }
  }

  async seekTo(ms) {
    const rec = this.body.recordings.find((r) => r.id === this.curRec);
    if (!rec) return;
    const a = await this.ensurePlayer();
    ms = clamp(ms, 0, rec.duration * 1000);
    try { a.currentTime = ms / 1000; } catch {}
    this.updatePlayback(ms, !this.playback);
  }

  // Tap on handwriting during replay → jump to when it was written.
  seekToStrokeAt(o, x, y) {
    const pb = this.playback;
    const r = 10 / this.cam.s;
    const hit = [...o.page.items].reverse().find((it) => it.type === 'stroke' && it.rec === pb.rec && strokeHit(it, x, y, r));
    if (!hit) return false;
    this.seekTo(hit.t - 1500);
    if (this.player && this.player.paused) this.togglePlay();
    return true;
  }

  stopPlayback(clearReplay) {
    if (this.player) { this.player.pause(); }
    cancelAnimationFrame(this.pbRaf);
    if (this.playBtn) this.playBtn.innerHTML = icons.play;
    if (clearReplay && this.playback) {
      this.playback = null;
      this.player = null;
      this.markAllDirty();
      if (this.seek) this.seek.value = 0;
    }
  }

  async deleteRecording(rec) {
    if (!(await confirmDialog('Delete recording?', 'The audio is removed. Your handwriting stays.'))) return;
    this.stopPlayback(true);
    this.body.recordings = this.body.recordings.filter((r) => r.id !== rec.id);
    for (const p of this.pages) for (const it of p.items) if (it.rec === rec.id) { delete it.rec; delete it.t; }
    this.changed();
    this.renderAudioBar();
  }

  // ------------------------------------------------------------- save -----

  changed() { this.save(); }

  async persist() {
    try {
      if (performance.now() - this.lastThumb > 5000) {
        this.lastThumb = performance.now();
        this.meta.thumb = await makeThumb(this.body);
      }
      await saveNote(this.meta, this.body);
    } catch (e) {
      console.error(e);
      toast('Could not save: ' + (e.message || e));
    }
  }

  async exit() {
    this.commitText();
    if (this.rec) await this.stopRecord();
    this.stopPlayback(true);
    this.save.cancel();
    this.lastThumb = 0;
    await this.persist();
    this.destroy();
    this.onExit();
  }

  destroy() {
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKeyUp);
    document.removeEventListener('visibilitychange', this.onVis);
    window.removeEventListener('pagehide', this.onVis);
    this.ro.disconnect();
    for (const c of this.caches.values()) c.canvas.width = c.canvas.height = 0;
    this.caches.clear();
    this.main.width = this.main.height = this.liveCv.width = this.liveCv.height = 0;
    closePopover();
    this.el.remove();
  }
}

function pick(o, keys) { const r = {}; for (const k of keys) r[k] = o[k]; return r; }

function upperBound(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= v) lo = m + 1; else hi = m; }
  return lo;
}

async function downscale(file, max) {
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { return file; }
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  if (k === 1 && file.size < 1.5e6) { bmp.close && bmp.close(); return file; }
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close && bmp.close();
  const png = file.type === 'image/png';
  const blob = await new Promise((r) => c.toBlob(r, png ? 'image/png' : 'image/jpeg', 0.88));
  c.width = c.height = 0;
  return blob || file;
}
