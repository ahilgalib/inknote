// The note editor: continuous page canvas, Apple Pencil / touch / mouse input,
// tools, Procreate-style gestures, clipboard, undo, audio synced with ink.
import { h, uid, clamp, debounce, toast, fmtTime, pickFile, saveFile, safeName, loadImage } from './util.js';
import { icons } from './icons.js';
import { settings, saveSettings, fingerDraws, applyTheme } from './settings.js';
import { drawStroke, drawLiveStroke, itemBBox, invalidate, strokeHit, strokeHitSegment, splitStroke, lassoHit, transformItem, round2, inkColor, openTapes } from './ink.js';
import { toolboxMethods, STICKY_COLORS } from './toolbox.js';
import { recognize } from './shapes.js';
import { drawPage, drawItems, measureText, renderPageCanvas, fontFor, drawImageItem, visualBBox } from './render.js';
import { PAPERS, PLANNERS, PAPER_COLORS, SIZES, ACCENTS, templatePreview, isDarkPaper, plannerById, plannerPaperColor, templateLabel, TEMPLATE_FONTS } from './templates.js';
import { putAsset, assetURL, db, getAssetBlob } from './db.js';
import { saveNote, makeThumb, newPage, exportNotePDF, exportNoteFile, pdfToPages, imagesToPages, bodyIds, mergeBodies } from './notes.js';
import { onStatus } from './sync.js';
import { importPDF } from './pdf.js';
import { popover, menu, closePopover, confirmDialog, progressDialog, colorPopover, sliderPopover, promptDialog } from './ui.js';
import { fontStack, loadFont } from './fonts.js';
import { fontPicker } from './fontpicker.js';
import { templateGallery } from './gallery.js';

const GAP = 30;          // space between pages (doc px)
const TOP = 20;          // space above first page (screen px)
const CAP = 2600;        // max cache bitmap size (px, longest side)
const MAX_CACHE = matchMedia('(pointer: coarse)').matches ? 4 : 6;
const HOLD_MS = 520;     // draw-and-hold → shape
const CLIP_PREFIX = 'inknote-clip:';
const DARK_PAPER = '#141416';
const PEN_STYLES = [['fountain', 'Fountain'], ['ball', 'Ballpoint'], ['calli', 'Calligraphy'], ['pencil', 'Pencil'], ['dash', 'Dashed'], ['dot', 'Dotted']];
const DRAW_TOOLS = ['pen', 'hl', 'laser', 'tape'];
let clipboard = null;    // { id, items } shared between notes (and between split panes)
let activeEditor = null; // with two notes side by side, keys / paste go to the one last touched

const TOOLS = [
  ['pen', 'Pen', 'P', 'pen'], ['hl', 'Highlighter', 'H', 'highlighter'], ['eraser', 'Eraser', 'E', 'eraser'],
  ['lasso', 'Lasso', 'L', 'lasso'], ['text', 'Text', 'T', 'text'], ['hand', 'Scroll', 'Space', 'hand'],
];

export class Editor {
  constructor(meta, body, { onExit }) {
    this.meta = meta;
    this.body = body;
    this.pages = body.pages;
    body.recordings = body.recordings || [];
    this.onExit = onExit;
    this.tool = 'pen';
    this.prevTool = 'pen';
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
    this.lasers = [];
    this.lastThumb = 0;
    let zc = 0;
    for (const p of this.pages) for (const it of p.items) zc = Math.max(zc, it.z || 0);
    body.zc = Math.max(body.zc || 0, zc);
    this.save = debounce(() => this.persist(), 1000);
    this.baseIds = bodyIds(body);
    activeEditor = this;
    this.build();
    this.el.addEventListener('pointerdown', () => this.activate(), true);
    this.layoutPages();
    loadFont(settings.tools.text.font);
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
      btn('pages', 'Page thumbnails', () => this.togglePagesPanel()),
      this.titleInput,
      h('div', { class: 'grow' }),
      this.syncPill = h('span', { class: 'sync-pill', hidden: true }),
      this.lockBtn = btn('lock', 'Locked — tap to edit', () => this.toggleLock(), 'lock-btn'),
      this.findAnchor = btn('search', 'Find in note (Ctrl+F)', () => this.findPanel()),
      this.timerBtn = h('button', { class: 'icon-btn timer-btn', title: 'Study timer', 'aria-label': 'Study timer', html: icons.timer, onClick: (e) => this.timerMenu(e.currentTarget) }),
      this.recBtn,
      this.themeBtn = btn('moon', 'Dark / light pages', () => this.toggleDarkMode()),
      btn('template', 'Paper & templates', (e) => this.paperMenu(e.currentTarget)),
      btn('share', 'Share & export', (e) => this.exportMenu(e.currentTarget)),
      btn('expand', 'Full screen (4-finger tap)', () => this.toggleFocus()),
      btn('more', 'More', (e) => this.moreMenu(e.currentTarget)));

    this.toolBtns = {};
    const tools = h('div', { class: 'tb-group tools' }, TOOLS.map(([id, label, key, icon]) => {
      const b = h('button', { class: 'tool-btn', title: `${label} (${key})`, 'aria-label': label, onClick: () => this.toolTap(id), html: icons[icon] });
      this.toolBtns[id] = b;
      return b;
    }),
    this.toolboxBtn = h('button', { class: 'tool-btn', title: 'Toolbox: zoom, tape, ruler, laser, stickers…', 'aria-label': 'Toolbox', onClick: (e) => this.toolboxMenu(e.currentTarget), html: icons.toolbox }),
    h('button', { class: 'tool-btn', title: 'Insert photo, camera, audio, PDF…', 'aria-label': 'Insert', onClick: (e) => this.insertMenu(e.currentTarget), html: icons.image }));
    this.presetsEl = h('div', { class: 'tb-group presets' });

    this.undoBtn = btn('undo', 'Undo (2-finger tap)', () => this.undo());
    this.redoBtn = btn('redo', 'Redo (3-finger tap)', () => this.redo());
    this.optsEl = h('div', { class: 'tb-group opts' });
    const toolbar = h('div', { class: 'ed-toolbar' },
      h('div', { class: 'tb-group tb-first' }, this.undoBtn, this.redoBtn),
      h('div', { class: 'tb-sep' }), tools);
    // Notability-style floating style tray: favourites, colours, sizes, options
    this.tray = h('div', { class: 'style-tray' }, this.presetsEl, this.optsEl);

    this.main = h('canvas', { class: 'cv-main' });
    this.liveCv = h('canvas', { class: 'cv-live' });
    this.mctx = this.main.getContext('2d');
    this.lctx = this.liveCv.getContext('2d');
    this.textarea = h('textarea', { class: 'text-edit', hidden: true, spellcheck: 'true', autocapitalize: 'sentences' });
    this.textarea.addEventListener('input', () => this.sizeTextarea());
    this.textarea.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== this.textarea && !this.gripping) this.commitText(); }, 120));
    this.textarea.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.textarea.blur(); e.stopPropagation(); });
    this.selMenu = h('div', { class: 'sel-menu', hidden: true });
    // grips on the text box being edited: drag to move it, drag the side to change its width
    this.textGrip = h('div', { class: 'text-grip', hidden: true, title: 'Drag to move', html: icons.move });
    this.textWidthGrip = h('div', { class: 'text-wgrip', hidden: true, title: 'Drag to resize' });
    this.bindTextGrip(this.textGrip, 'move');
    this.bindTextGrip(this.textWidthGrip, 'width');
    this.pageInd = h('div', { class: 'page-ind' });
    this.addTile = h('button', { class: 'add-tile', hidden: true, onClick: () => this.addPage(this.pages.length - 1) }, h('span', { html: icons.plus }), 'Add page');
    this.focusExit = h('button', { class: 'focus-exit', title: 'Exit full screen', 'aria-label': 'Exit full screen', html: icons.shrink, onClick: () => this.toggleFocus() });
    this.stage = h('div', { class: 'stage' }, this.main, this.liveCv, this.textarea, this.textGrip, this.textWidthGrip, this.selMenu, this.pageInd, this.addTile, this.focusExit);

    this.audioBar = h('div', { class: 'audio-bar', hidden: true });
    this.pagesPanel = h('aside', { class: 'pages-panel', hidden: true });

    this.el = h('div', { class: 'editor' }, topbar, toolbar,
      h('div', { class: 'ed-body' }, this.pagesPanel, this.stage, this.tray), this.audioBar);

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
    this.stage.addEventListener('dragover', (e) => { e.preventDefault(); });
    this.stage.addEventListener('drop', (e) => this.onDrop(e));

    this.onKey = (e) => this.handleKey(e);
    this.onKeyUp = (e) => { if (e.code === 'Space') this.spaceDown = false; };
    this.onVis = () => { if (document.visibilityState === 'hidden') this.save.flush(); };
    this.onPaste = (e) => this.handlePasteEvent(e);
    this.onFont = () => this.markAllDirty();
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('paste', this.onPaste);
    window.addEventListener('inknote-font', this.onFont);
    document.addEventListener('visibilitychange', this.onVis);
    window.addEventListener('pagehide', this.onVis);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.stage);

    this.unsubSync = onStatus((st) => this.renderSyncPill(st));
    this.timerTick = setInterval(() => this.renderTimer(), 1000);
    this.renderTimer();
    this.renderToolbar();
    this.renderAudioBar();
    TEMPLATE_FONTS.forEach((f) => loadFont(f.split(':')[0]));
  }

  activate() {
    if (activeEditor === this) return;
    activeEditor = this;
    for (const el of document.querySelectorAll('.editor.active')) el.classList.remove('active');
    this.el.classList.add('active');
  }

  inSplit() { return !!this.el.closest('.panes.split'); }

  async splitMenu(anchor) {
    const others = (await db.all('notes')).filter((n) => !n.trashed && n.id !== this.meta.id).sort((a, b) => b.updated - a.updated).slice(0, 25);
    if (!others.length) { toast('Create another note first'); return; }
    menu(anchor, others.map((n) => ({ label: n.title, icon: 'notes', onClick: () => { location.hash = `#/split/${encodeURIComponent(this.meta.id)}/${encodeURIComponent(n.id)}`; } })));
  }

  mount(parent) {
    parent.append(this.el);
    this.resize();
    this.lockBtn.hidden = !this.meta.locked;
    if (!settings.tipsSeen) setTimeout(() => { if (this.el.isConnected) this.showTips(this.toolboxBtn); }, 700);
  }

  resize() {
    const r = this.stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const prevW = this.vw;
    this.rect = r;
    this.vw = r.width; this.vh = r.height;
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    for (const c of [this.main, this.liveCv]) {
      c.width = Math.round(this.vw * this.dpr);
      c.height = Math.round(this.vh * this.dpr);
      c.style.width = this.vw + 'px';
      c.style.height = this.vh + 'px';
    }
    if (!this.inited) { this.inited = true; this.fitWidth(true); }
    else if (prevW && Math.abs(prevW - this.vw) > 40) this.fitWidth(false); // rotation / split view
    else this.clampCam();
    if (this.zoom) this.layoutZoom();
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
    const minY = Math.min(TOP, this.vh - this.totalH * s - 140);
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

  targetScale(page) { return Math.min(this.cam.s * this.dpr, CAP / Math.max(page.w, page.h)); }

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
      ctx.fillStyle = 'rgba(0,0,0,0.07)';
      ctx.fillRect(sx - 0.5, sy + 1, sw + 1, sh + 2);
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
    const dk = this.curDark();
    if (dk !== this.lastDark) {
      this.lastDark = dk;
      this.themeBtn.innerHTML = icons[dk ? 'sun' : 'moon'];
      this.renderToolbar();
    }
  }

  curDark() { const p = this.lay && this.vw ? this.pages[this.currentIndex()] : this.pages[0]; return !!p && !p.bg && isDarkPaper(p.color); }

  // Fade from the old picture to the new one (template / paper changes).
  crossfade() {
    if (!this.vw || !this.main.width) return;
    const c = h('canvas', { class: 'cv-fade' });
    c.width = this.main.width; c.height = this.main.height;
    c.style.width = this.vw + 'px'; c.style.height = this.vh + 'px';
    c.getContext('2d').drawImage(this.main, 0, 0);
    this.stage.insertBefore(c, this.liveCv);
    requestAnimationFrame(() => requestAnimationFrame(() => { c.style.opacity = '0'; }));
    setTimeout(() => { c.remove(); c.width = c.height = 0; }, 420);
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
    if (this.zoom && (!page || this.zoom.o.page === page)) this.zoom.cache = null;
    this.requestRender();
  }

  markAllDirty() { for (const c of this.caches.values()) c.dirty = true; if (this.zoom) this.zoom.cache = null; this.requestRender(); }

  // A freshly committed stroke is painted straight onto the cached bitmap and
  // onto the screen, so lifting the pen never triggers a full page redraw.
  paintCommitted(o, item) {
    const page = o.page;
    if (this.zoom && this.zoom.o === o) this.zoom.cache = null;
    // tape always stays on top: repaint the page when ink goes under it
    if (item.tool !== 'tape' && page.items.some((i) => i.tool === 'tape')) { this.markDirty(page); return; }
    const dark = isDarkPaper(page.color) && !page.bg;
    const c = this.caches.get(page.id);
    if (c && !c.dirty && !this.playback) {
      const ctx = c.canvas.getContext('2d');
      ctx.setTransform(c.scale, 0, 0, c.scale, 0, 0);
      ctx.__dark = dark;
      drawStroke(ctx, item);
      ctx.__dark = false;
    } else if (c) c.dirty = true;
    const m = this.mctx;
    m.save();
    this.pageTransform(m, o);
    m.beginPath(); m.rect(0, 0, page.w, page.h); m.clip();
    m.__dark = dark;
    drawStroke(m, item);
    m.__dark = false;
    m.restore();
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
      ctx.__dark = isDarkPaper(L.o.page.color) && !L.o.page.bg;
      drawLiveStroke(ctx, { type: 'stroke', tool: L.tool, style: L.style, color: L.color, size: L.size, pts: L.pts, shape: L.shape, closed: L.closed });
      ctx.__dark = false;
      ctx.restore();
    }
    if (this.lasers.length) {
      const now = performance.now();
      this.lasers = this.lasers.filter((l) => !l.end || now - l.end < 900);
      for (const l of this.lasers) {
        this.pageTransform(ctx, l.o);
        const a = l.end ? Math.max(0, 1 - (now - l.end) / 900) : 1;
        drawLiveStroke(ctx, { type: 'stroke', tool: 'laser', color: l.color, size: 4, pts: l.pts, alpha: a });
        ctx.globalAlpha = 1;
      }
      if (this.lasers.some((l) => l.end)) this.requestLive();
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
      ctx.fillStyle = 'rgba(79,107,237,0.07)';
      ctx.fill();
      ctx.setLineDash([]);
    }
    const sel = this.selection;
    if (sel) {
      const d = this.drag, s = this.cam.s;
      this.pageTransform(ctx, sel.o);
      if (d && d.mode === 'crop') {
        const img = this.images.get(d.cur.asset);
        ctx.save(); ctx.globalAlpha = 0.28; drawImageItem(ctx, d.full, img); ctx.restore();
        drawImageItem(ctx, { ...d.cur, sticker: false }, img);
      } else if (d && d.bmp) {
        // the selection is lifted off the page as one bitmap: moving, scaling
        // and rotating it costs a single drawImage per frame
        ctx.save();
        this.applyDragTransform(ctx, d);
        ctx.shadowColor = 'rgba(0,0,0,0.22)';
        ctx.shadowBlur = 16 * this.dpr;
        ctx.shadowOffsetY = 6 * this.dpr;
        ctx.drawImage(d.bmp.canvas, d.bmp.x, d.bmp.y, d.bmp.w, d.bmp.h);
        ctx.restore();
      }
      ctx.save();
      ctx.lineWidth = 1.5 / s;
      ctx.strokeStyle = '#4f6bed';
      ctx.fillStyle = '#fff';
      if (this.cropMode) {
        let it = d && d.mode === 'crop' ? d.cur : this.selItems()[0];
        if (it && d && d.mode === 'move') it = { ...it, x: it.x + d.dx, y: it.y + d.dy };
        if (it) {
          ctx.lineWidth = 2 / s;
          ctx.strokeRect(it.x, it.y, it.w, it.h);
          ctx.lineWidth = 5 / s;
          ctx.strokeStyle = '#fff';
          ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 3;
          const L = 18 / s;
          for (const [x, y, dx, dy] of [[it.x, it.y, 1, 1], [it.x + it.w, it.y, -1, 1], [it.x, it.y + it.h, 1, -1], [it.x + it.w, it.y + it.h, -1, -1]]) {
            ctx.beginPath(); ctx.moveTo(x + dx * L, y); ctx.lineTo(x, y); ctx.lineTo(x, y + dy * L); ctx.stroke();
          }
          for (const [x, y, hor] of [[it.x + it.w / 2, it.y, 1], [it.x + it.w / 2, it.y + it.h, 1], [it.x, it.y + it.h / 2, 0], [it.x + it.w, it.y + it.h / 2, 0]]) {
            ctx.beginPath();
            if (hor) { ctx.moveTo(x - L / 2, y); ctx.lineTo(x + L / 2, y); } else { ctx.moveTo(x, y - L / 2); ctx.lineTo(x, y + L / 2); }
            ctx.stroke();
          }
        }
      } else {
        const b = this.selBox(true);
        if (b) {
          if (d && d.mode === 'rotate') { ctx.translate(d.cx, d.cy); ctx.rotate(d.a); ctx.translate(-d.cx, -d.cy); }
          ctx.setLineDash([6 / s, 4 / s]);
          ctx.strokeRect(b.x, b.y, b.w, b.h);
          ctx.setLineDash([]);
          // four corner handles (resize) and a rotate handle (top-centre)
          ctx.lineWidth = 2 / s;
          for (const [x, y] of [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]]) {
            ctx.beginPath(); ctx.arc(x, y, 8 / s, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          }
          ctx.beginPath(); ctx.moveTo(b.x + b.w / 2, b.y); ctx.lineTo(b.x + b.w / 2, b.y - 22 / s); ctx.stroke();
          ctx.beginPath(); ctx.arc(b.x + b.w / 2, b.y - 28 / s, 7 / s, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        }
      }
      ctx.restore();
    }
    if (this.quiz && this.flashTape) {
      const q = this.quiz.list[this.quiz.i], o = this.lay[q.i];
      if (o) {
        const b = itemBBox(q.it), s = this.cam.s;
        this.pageTransform(ctx, o);
        ctx.save();
        ctx.strokeStyle = '#f5b400'; ctx.lineWidth = 3 / s; ctx.setLineDash([8 / s, 5 / s]);
        ctx.strokeRect(b.x - 6 / s, b.y - 6 / s, b.w + 12 / s, b.h + 12 / s);
        ctx.restore();
      }
    }
    if (this.zoom) this.drawZoomBox(ctx);
    if (this.ruler) this.drawRuler(ctx);
    if (this.zoom) this.drawZoom();
    if (this.hover && (this.tool === 'eraser' || this.eraserOverride)) {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.beginPath();
      ctx.arc(this.hover.x, this.hover.y, this.eraserRadius() * this.cam.s, 0, Math.PI * 2);
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = 'rgba(120,120,120,0.9)';
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fill();
      ctx.stroke();
    }
  }

  applyDragTransform(ctx, d) {
    if (d.mode === 'move') ctx.translate(d.dx, d.dy);
    else if (d.mode === 'scale') { ctx.translate(d.ox, d.oy); ctx.scale(d.k, d.k); ctx.translate(-d.ox, -d.oy); }
    else { ctx.translate(d.cx, d.cy); ctx.rotate(d.a); ctx.translate(-d.cx, -d.cy); }
  }

  positionOverlays() {
    this.positionSelMenu();
    if (this.textEdit) this.placeTextarea();
    // "Add page" tile below the last page, like Notability
    const last = this.lay[this.lay.length - 1];
    if (last) {
      const { s, x, y } = this.cam;
      const top = y + (last.y + last.page.h) * s + 16;
      const show = top < this.vh - 10 && top > 0;
      this.addTile.hidden = !show;
      if (show) {
        const w = Math.min(last.page.w * s, 360);
        this.addTile.style.transform = `translate(${x - w / 2}px, ${top}px)`;
        this.addTile.style.width = w + 'px';
      }
    }
  }

  flashIndicator(text) {
    const i = this.currentIndex();
    this.pageInd.textContent = text || `${this.pages[i] && this.pages[i].bookmark ? '🔖 ' : ''}${i + 1} / ${this.pages.length}`;
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
    const r = this.rect || this.liveCv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  onDown(e) {
    e.preventDefault();
    closePopover();
    this.rect = this.liveCv.getBoundingClientRect();
    try { this.liveCv.setPointerCapture(e.pointerId); } catch {}
    const pos = this.localPos(e);
    const p = { id: e.pointerId, type: e.pointerType, sx: pos.x, sy: pos.y, x0: pos.x, y0: pos.y, t0: performance.now(), role: null };
    if (this.eyedrop) { this.pickColorAt(pos); return; }
    // fingers / mouse move the ruler and the zoom box (the Pencil draws along them)
    if (e.pointerType !== 'pen' && !this.gesturePointers().length) {
      const rh = this.ruler && this.rulerHit(pos.x, pos.y);
      if (rh) { p.role = 'ruler'; this.pointers.set(p.id, p); this.startRulerDrag(rh, p); return; }
      if (this.zoom && this.zoomBoxHit(pos.x, pos.y)) {
        const d = this.screenToDoc(pos.x, pos.y), Z = this.zoom;
        p.role = 'zoombox'; p.zb = { x: d.x, y: d.y, bx: Z.x, by: Z.y };
        this.pointers.set(p.id, p);
        return;
      }
    }

    if (e.pointerType === 'pen' && !settings.penSeen) {
      settings.penSeen = true;
      saveSettings();
      if (settings.fingerDraw === 'auto') toast('Pencil detected — fingers now scroll & zoom (change in Settings)', 3200);
    }

    if (e.pointerType === 'touch') {
      if (this.penActive) return; // palm rejection
      this.pointers.set(p.id, p);
      const touches = [...this.pointers.values()].filter((q) => q.type === 'touch' && q.role !== 'ignore');
      if (touches.length === 1 && ((this.selection && this.selHit(p.sx, p.sy)) || (fingerDraws() && this.tool !== 'hand'))) {
        p.role = 'draw';
        this.startTool(p, e);
        return;
      }
      for (const q of touches) {
        if (q.role === 'draw') {
          if (p.t0 - q.t0 < 280) { this.cancelTool(q); q.role = 'gesture'; }
          else { p.role = 'ignore'; return; }
        }
      }
      p.role = 'gesture';
      this.beginGesture();
      return;
    }

    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
    this.pointers.set(p.id, p);
    if (e.pointerType === 'pen') {
      this.penActive = true;
      this.stopInertia();
      for (const q of this.pointers.values()) if (q.type === 'touch') { if (q.role === 'draw') this.cancelTool(q); q.role = 'ignore'; }
      this.gesture = null;
      // stylus with an eraser end / eraser button
      this.eraserOverride = !!(e.buttons & 32) || e.button === 5;
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
    if (p.role === 'ruler' || p.role === 'zoombox') {
      const pos = this.localPos(e);
      p.sx = pos.x; p.sy = pos.y;
      if (p.role === 'ruler') this.moveRulerDrag(p);
      else {
        const d = this.screenToDoc(pos.x, pos.y), Z = this.zoom;
        if (Z) {
          Z.x = clamp(p.zb.bx + d.x - p.zb.x, 0, Math.max(0, Z.o.page.w - Z.w));
          Z.y = clamp(p.zb.by + d.y - p.zb.y, 0, Math.max(0, Z.o.page.h - Z.h));
          Z.margin = Z.x; Z.cache = null;
          this.requestLive();
        }
      }
      return;
    }
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
    if (this.tool === 'eraser' || this.eraserOverride) this.hover = { x: p.sx, y: p.sy };
    this.requestLive();
  }

  onUp(e, cancelled = false) {
    const p = this.pointers.get(e.pointerId);
    if (e.pointerType === 'pen') { this.penActive = false; this.hover = null; }
    if (!p) return;
    this.pointers.delete(e.pointerId);
    if (p.role === 'ruler') this.rulerDrag = null;
    else if (p.role === 'zoombox') { if (this.zoom) this.zoomVisible(); }
    else if (p.role === 'gesture') this.endGesture(p, cancelled);
    else if (p.role === 'draw') this.endTool(p, cancelled && p.type === 'touch');
    if (e.pointerType === 'touch' && this.tool === 'eraser') this.hover = null;
    this.requestLive();
  }

  // ---- pan / pinch / Procreate-style multi-finger gestures ----

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
      startS: prev ? prev.startS : this.cam.s,
      multi: prev && prev.multi ? prev.multi : (g.length >= 3 ? { x: cx, y: cy } : null),
      last: { x: cx, y: cy },
      samples: [],
    };
    clearTimeout(this.holdUndoT); clearInterval(this.holdUndoI);
    if (g.length === 2 && settings.twoFingerUndo && !this.gesture.moved) {
      // two-finger touch & hold = rapid undo (Procreate)
      this.holdUndoT = setTimeout(() => {
        if (!this.gesture || this.gesture.moved || this.gesture.n !== 2) return;
        this.gesture.heldUndo = true;
        this.undo(); this.flashIndicator('Undo');
        this.holdUndoI = setInterval(() => { this.undo(); this.flashIndicator('Undo'); }, 260);
      }, 650);
    }
    this.setInteracting(true);
  }

  moveGesture() {
    const G = this.gesture;
    if (!G) return;
    const g = this.gesturePointers();
    if (g.length !== G.n) { this.beginGesture(); return; }
    const cx = g.reduce((a, q) => a + q.sx, 0) / g.length;
    const cy = g.reduce((a, q) => a + q.sy, 0) / g.length;
    G.last = { x: cx, y: cy };
    if (!G.moved && Math.hypot(cx - G.cx, cy - G.cy) < 7 && (g.length < 2 || Math.abs(Math.hypot(g[0].sx - g[1].sx, g[0].sy - g[1].sy) - G.dist) < 9)) return;
    G.moved = true;
    clearTimeout(this.holdUndoT); clearInterval(this.holdUndoI);
    if (g.length >= 3) return; // 3+ fingers: reserved for gestures, no scrolling
    if (g.length === 2) {
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

  endGesture(p, cancelled) {
    const G = this.gesture;
    clearTimeout(this.holdUndoT); clearInterval(this.holdUndoI);
    const remaining = this.gesturePointers();
    if (remaining.length) { if (G) this.beginGesture(); return; }
    this.gesture = null;
    if (!G || cancelled) { this.setInteracting(false); return; }
    const dt = performance.now() - G.t0;
    if (p.type === 'touch' && !G.heldUndo) {
      const dy = G.multi ? G.last.y - G.multi.y : 0, dx = G.multi ? G.last.x - G.multi.x : 0;
      if (G.maxN === 3 && dy > 60 && Math.abs(dx) < dy) { this.copyPasteMenu(G.last); this.setInteracting(false); return; }
      if (!G.moved && dt < 350) {
        if (G.maxN === 2 && settings.twoFingerUndo) { this.undo(); this.flashIndicator('Undo'); }
        else if (G.maxN === 3 && settings.twoFingerUndo) { this.redo(); this.flashIndicator('Redo'); }
        else if (G.maxN >= 4) this.toggleFocus();
        else if (G.maxN === 1) this.tapAt(G.last);
      }
      // quick pinch-in snaps back to fit width
      if (G.moved && G.maxN === 2 && dt < 320 && this.cam.s < G.startS * 0.8) { this.fitWidth(false); }
    }
    const sm = G.samples;
    if (G.moved && G.n === 1 && sm.length >= 2) {
      const a = sm[0], b = sm[sm.length - 1];
      const t = b.t - a.t;
      if (t > 0 && performance.now() - b.t < 60) {
        const vx = (b.x - a.x) / t, vy = (b.y - a.y) / t;
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
  activeTool() { return this.eraserOverride ? 'eraser' : this.tool; }

  startTool(p, e) {
    const d = this.screenToDoc(p.sx, p.sy);
    const t = this.activeTool();
    if (this.meta.locked && t !== 'laser' && t !== 'hand') {
      p.role = 'none';
      if (!this.lockToast || performance.now() - this.lockToast > 2500) { this.lockToast = performance.now(); toast('This note is locked — tap the lock to edit'); }
      return;
    }
    if (this.textEdit && t !== 'text') this.commitText();
    // a selection can be moved / resized / rotated whatever tool is active
    if (this.selection && t !== 'laser' && !this.eraserOverride) {
      const hit = this.selHit(p.sx, p.sy);
      if (hit) { this.startDrag(hit, p); return; }
      this.clearSelection();
    }
    if (t === 'text' && !this.textEdit) {
      // press on a text box / picture: drag moves it, a tap edits / selects it
      const o = this.pageAt(d.x, d.y);
      const it = o && this.itemAt(o, d.x - o.x, d.y - o.y, ['text', 'image', 'audio']);
      if (it) { this.press = { o, item: it, sx: p.sx, sy: p.sy }; return; }
    }
    if (DRAW_TOOLS.includes(t)) {
      const o = this.pageAt(d.x, d.y, t === 'laser' ? 2000 : 0);
      if (!o) { p.role = 'none'; return; }
      if (this.selection) this.clearSelection();
      const size = this.currentSize(t);
      // start near the ruler: the stroke follows its edge
      const edge = t !== 'laser' && this.rulerEdgeFor(d.x, d.y, size);
      let lx = d.x - o.x, ly = d.y - o.y;
      if (edge) { const q = this.snapToEdge(edge, d.x, d.y); lx = q.x - o.x; ly = q.y - o.y; }
      const pr = this.pressure(e, null);
      const L = {
        o, pid: p.id, tool: t, style: t === 'pen' ? (this.toolCfg('pen').style || 'fountain') : undefined,
        color: this.currentColor(t), size, edge: edge || null, straight: t === 'hl' && !!this.toolCfg('hl').straight,
        pts: [round2(lx), round2(ly), pr], lastP: pr, sx: lx, sy: ly, raw: { x: lx, y: ly },
        holdRef: { x: p.sx, y: p.sy }, startT: performance.now(), shape: false, pen: e.pointerType === 'pen',
      };
      if (t === 'laser') { L.end = 0; this.lasers.push(L); this.laser = L; }
      else { this.live = L; this.armHold(); }
      this.requestLive();
    } else if (t === 'eraser') {
      const o = this.pageAt(d.x, d.y, 30);
      if (!o) { p.role = 'none'; return; }
      if (this.selection) this.clearSelection();
      this.erase = { o, removed: new Map(), added: new Map(), last: { x: d.x - o.x, y: d.y - o.y } };
      this.eraseSeg(d.x - o.x, d.y - o.y);
      this.hover = { x: p.sx, y: p.sy };
    } else if (t === 'lasso') {
      const o = this.pageAt(d.x, d.y, 40);
      if (!o) { p.role = 'none'; return; }
      this.lasso = { o, pts: [d.x - o.x, d.y - o.y] };
    }
    // text is handled on pointer-up so the keyboard can open (iOS needs a user gesture)
  }

  moveTool(p, ev) {
    if (this.press) {
      const pr = this.press;
      if (Math.hypot(p.sx - pr.sx, p.sy - pr.sy) > 8) {
        this.press = null;
        this.select(pr.o, [pr.item.id]);
        this.startDrag('move', { sx: pr.sx, sy: pr.sy });
        this.updateDrag(p);
      }
      return;
    }
    const d = this.screenToDoc(p.sx, p.sy);
    const L = this.live || (this.laser && this.laser.pid === p.id ? this.laser : null);
    if (L) {
      if (L.shape) return;
      let lx = d.x - L.o.x, ly = d.y - L.o.y;
      if (L.edge) { const q = this.snapToEdge(L.edge, d.x, d.y); lx = q.x - L.o.x; ly = q.y - L.o.y; }
      if (L.straight) {
        // straight highlighter: a clean line from start to here
        L.raw = { x: lx, y: ly };
        L.pts = [L.pts[0], L.pts[1], L.pts[2], round2(lx), round2(ly), L.pts[2]];
        L.sx = lx; L.sy = ly;
        return;
      }
      if (Math.hypot(lx - L.raw.x, ly - L.raw.y) < 0.6 / this.cam.s) return;
      L.raw = { x: lx, y: ly };
      // pressure is smoothed so the line width never "shivers"
      const target = this.pressure(ev, L);
      const pr = L.lastP + (target - L.lastP) * 0.32;
      // light position smoothing; the curve fitting does the rest
      const k = L.pen ? 0.6 : 0.5;
      L.sx += (lx - L.sx) * k; L.sy += (ly - L.sy) * k;
      L.pts.push(round2(L.sx), round2(L.sy), Math.round(pr * 1000) / 1000);
      L.lastP = pr;
      if (L.tool !== 'laser' && !L.edge && Math.hypot(p.sx - L.holdRef.x, p.sy - L.holdRef.y) > 5) {
        L.holdRef = { x: p.sx, y: p.sy };
        this.armHold();
      }
      return;
    }
    if (this.erase) { this.eraseSeg(d.x - this.erase.o.x, d.y - this.erase.o.y); return; }
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
    } else if (this.laser && this.laser.pid === p.id) {
      this.laser.end = performance.now();
      this.laser = null;
    } else if (this.erase) {
      this.finishErase();
      if (settings.eraserAutoDeselect && this.tool === 'eraser' && !this.eraserOverride && this.prevTool && this.prevTool !== 'eraser') this.setTool(this.prevTool);
    } else if (this.drag) this.endDrag();
    else if (this.press) { const pr = this.press; this.press = null; if (!cancelled) this.tapItem(pr.o, pr.item, 'text'); }
    else if (this.lasso) this.finishLasso(p);
    else if (this.tool === 'text' && !cancelled) this.textTap(p);
    this.eraserOverride = false;
    this.requestLive();
  }

  cancelTool(p) {
    if (this.live && this.live.pid === p.id) { clearTimeout(this.holdTimer); this.live = null; }
    else if (this.erase) this.finishErase();
    else if (this.drag) { this.drag.cancel = true; this.endDrag(); }
    else if (this.lasso) this.lasso = null;
    this.press = null;
    p.role = 'none';
    this.requestLive();
  }

  pressure(ev, L) {
    if (ev.pointerType === 'pen') {
      if (!settings.pressure) return 0.5;
      let pr = ev.pressure;
      if (!pr) pr = L ? L.lastP : 0.35;
      return clamp(Math.pow(pr, 0.75), 0.05, 1);
    }
    return 0.5; // mouse & finger: steady width
  }

  armHold() {
    clearTimeout(this.holdTimer);
    if (!settings.shapeHold) return;
    this.holdTimer = setTimeout(() => {
      const L = this.live;
      if (!L || L.shape || L.edge || L.straight || L.tool === 'tape' || L.pts.length < 18) return;
      const shape = recognize(L.pts);
      if (!shape) return;
      L.shape = true;
      L.closed = shape.closed;
      L.pts = shape.pts.map(round2);
      this.requestLive();
      if (navigator.vibrate) navigator.vibrate(10);
    }, HOLD_MS);
  }

  commitStroke(p) {
    const L = this.live;
    this.live = null;
    const tap = Math.hypot(p.sx - p.x0, p.sy - p.y0) < 6 && performance.now() - p.t0 < 350;
    if (this.playback && tap && this.seekToStrokeAt(L.o, L.pts[0], L.pts[1])) { this.requestLive(); return; }
    if (tap && L.tool !== 'laser') {
      const tape = this.tapeAt(L.o, L.pts[0], L.pts[1]);
      if (tape) { this.toggleTape(L.o, tape); this.requestLive(); return; }
      const hit = this.itemAt(L.o, L.pts[0], L.pts[1], p.type === 'pen' ? ['audio'] : ['image', 'audio', 'text']);
      if (hit) { this.tapItem(L.o, hit, 'pen'); this.requestLive(); return; }
    }
    let pts = L.pts;
    if (!L.shape && !L.straight && pts.length > 3) {
      const n = pts.length;
      if (Math.hypot(pts[n - 3] - L.raw.x, pts[n - 2] - L.raw.y) > 0.3) pts = pts.concat([round2(L.raw.x), round2(L.raw.y), L.lastP]);
    }
    const item = { id: uid(), type: 'stroke', tool: L.tool, color: L.color, size: L.size, pts, z: ++this.body.zc };
    if (L.style && L.style !== 'fountain') item.style = L.style;
    if (L.shape) { item.shape = true; if (L.closed) item.closed = true; }
    if (this.rec) { item.rec = this.rec.id; item.t = Math.round(L.startT - this.rec.start); }
    const page = L.o.page;
    page.items.push(item);
    this.lastStroke = item;
    this.pushOp({ kind: 'items', page: page.id, add: [structuredClone(item)], remove: [] });
    this.paintCommitted(L.o, item);
    if (settings.autoAddPage && page === this.pages[this.pages.length - 1] && !page.bg) {
      const b = itemBBox(item);
      if (b.y + b.h > page.h * 0.84) this.addPage(this.pages.length - 1, true);
    }
  }

  // ---- eraser (Notability-style: precise, whole stroke, or highlighter only) ----

  eraseSeg(lx, ly) {
    const E = this.erase;
    const page = E.o.page;
    const r = this.eraserRadius();
    const ax = E.last.x, ay = E.last.y;
    E.last = { x: lx, y: ly };
    const mode = this.toolCfg('eraser').mode;
    let changed = false;
    for (let i = page.items.length - 1; i >= 0; i--) {
      const it = page.items[i];
      if (it.type !== 'stroke') continue;
      if (mode === 'hl' && it.tool !== 'hl') continue;
      if (!strokeHitSegment(it, ax, ay, lx, ly, r)) continue;
      changed = true;
      page.items.splice(i, 1);
      if (E.added.has(it.id)) E.added.delete(it.id);
      else E.removed.set(it.id, structuredClone(it));
      if (mode === 'precise' || mode === 'hl') {
        const parts = splitStroke(it, ax, ay, lx, ly, r);
        for (const pts of parts) {
          const n = { ...it, id: uid(), pts };
          delete n.closed;
          if (n.shape) n.shape = true;
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
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < L.pts.length; i += 2) {
      x0 = Math.min(x0, L.pts[i]); x1 = Math.max(x1, L.pts[i]);
      y0 = Math.min(y0, L.pts[i + 1]); y1 = Math.max(y1, L.pts[i + 1]);
    }
    let ids;
    if (L.pts.length < 8 || Math.max(x1 - x0, y1 - y0) * this.cam.s < 10) {
      const [x, y] = L.pts;
      const r = 8 / this.cam.s;
      const hit = [...page.items].reverse().find((it) => {
        if (it.type === 'stroke') return strokeHit(it, x, y, r);
        const b = itemBBox(it);
        return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
      });
      ids = hit ? [hit.id] : [];
      if (!hit && clipboard) { this.pasteMenuAt({ x: p.sx, y: p.sy }); return; }
    } else {
      ids = page.items.filter((it) => lassoHit(it, L.pts)).map((i) => i.id);
    }
    if (ids.length) this.select(L.o, ids);
    else this.requestLive();
  }

  select(o, ids) {
    if (this.textEdit) this.commitText();
    this.cropMode = false;
    this.selection = { o, ids: new Set(ids) };
    this.showSelMenu();
    this.requestLive();
  }

  clearSelection() {
    this.selection = null;
    this.cropMode = false;
    this.selMenu.hidden = true;
    this.requestLive();
  }

  selItems() {
    const s = this.selection;
    return s ? s.o.page.items.filter((i) => s.ids.has(i.id)) : [];
  }

  selBox(raw) {
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
      else if (d.mode === 'scale') b = { x: d.ox + (b.x - d.ox) * d.k, y: d.oy + (b.y - d.oy) * d.k, w: b.w * d.k, h: b.h * d.k };
    }
    return b;
  }

  selScreenBox() {
    const b = this.selBox();
    if (!b) return null;
    const o = this.selection.o, { s, x, y } = this.cam;
    return { x: x + (o.x + b.x) * s, y: y + (o.y + b.y) * s, w: b.w * s, h: b.h * s };
  }

  // Which handle (if any) is under a screen point.
  selHit(sx, sy) {
    if (this.cropMode) {
      const it = this.selItems()[0];
      if (!it) return null;
      const o = this.selection.o, { s, x, y } = this.cam;
      const L = x + (o.x + it.x) * s, T = y + (o.y + it.y) * s, R = L + it.w * s, B = T + it.h * s;
      const near = 22;
      const w = Math.abs(sx - L) < near, e = Math.abs(sx - R) < near, n = Math.abs(sy - T) < near, so = Math.abs(sy - B) < near;
      const inX = sx > L - near && sx < R + near, inY = sy > T - near && sy < B + near;
      const edge = (n && inX ? 'n' : so && inX ? 's' : '') + (w && inY ? 'w' : e && inY ? 'e' : '');
      if (edge) return 'crop:' + edge;
      if (sx > L && sx < R && sy > T && sy < B) return 'move';
      return null;
    }
    const r = this.selScreenBox();
    if (!r) return null;
    const corners = { nw: [r.x, r.y], ne: [r.x + r.w, r.y], sw: [r.x, r.y + r.h], se: [r.x + r.w, r.y + r.h] };
    for (const [k, [cx, cy]] of Object.entries(corners)) if (Math.hypot(sx - cx, sy - cy) < 24) return 'scale:' + k;
    if (Math.hypot(sx - (r.x + r.w / 2), sy - (r.y - 28)) < 24) return 'rotate';
    if (sx >= r.x - 10 && sx <= r.x + r.w + 10 && sy >= r.y - 10 && sy <= r.y + r.h + 10) return 'move';
    return null;
  }

  // Render the selection once into a bitmap that is moved around while dragging.
  dragBitmap(items, page) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const it of items) { const b = visualBBox(it); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
    x0 -= 4; y0 -= 4; x1 += 4; y1 += 4;
    const w = x1 - x0, hh = y1 - y0;
    if (!(w > 0 && hh > 0)) return null;
    const q = Math.min(this.cam.s * this.dpr, 2400 / Math.max(w, hh));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w * q)); c.height = Math.max(1, Math.ceil(hh * q));
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(q, 0, 0, q, -x0 * q, -y0 * q);
    drawItems(ctx, page, items, { images: this.images });
    return { canvas: c, x: x0, y: y0, w, h: hh };
  }

  startDrag(hit, p) {
    const [mode, arg] = hit.split(':');
    const b = this.selBox();
    const d = this.screenToDoc(p.sx, p.sy), o = this.selection.o;
    const ub = { x: b.x + 6, y: b.y + 6, w: b.w - 12, h: b.h - 12 };
    const D = {
      mode, sx0: p.sx, sy0: p.sy, dx: 0, dy: 0, k: 1, a: 0,
      ox: ub.x, oy: ub.y, bw: b.w, bh: b.h, cx: b.x + b.w / 2, cy: b.y + b.h / 2,
      a0: Math.atan2(d.y - o.y - (b.y + b.h / 2), d.x - o.x - (b.x + b.w / 2)),
    };
    if (mode === 'scale') {
      // scale about the opposite corner
      const c = arg || 'se';
      D.hx = c.includes('e') ? ub.x + ub.w : ub.x; D.hy = c.includes('s') ? ub.y + ub.h : ub.y;
      D.ox = c.includes('e') ? ub.x : ub.x + ub.w; D.oy = c.includes('s') ? ub.y : ub.y + ub.h;
    }
    if (mode === 'crop') {
      const it = this.selItems()[0];
      const c0 = it.crop || { x: 0, y: 0, w: 1, h: 1 };
      const fw = it.w / c0.w, fh = it.h / c0.h;
      const fx = it.x - (it.flip ? 1 - c0.x - c0.w : c0.x) * fw, fy = it.y - c0.y * fh;
      Object.assign(D, { edge: arg, orig: structuredClone(it), cur: structuredClone(it), full: { ...it, x: fx, y: fy, w: fw, h: fh, crop: undefined, sticker: false } });
    } else D.bmp = this.dragBitmap(this.selItems(), o.page);
    this.drag = D;
    this.hidden = new Set(this.selection.ids);
    this.markDirty(o.page);
    this.selMenu.hidden = true;
    this.requestLive();
  }

  updateDrag(p) {
    const d = this.drag, s = this.cam.s, o = this.selection.o;
    const q = this.screenToDoc(p.sx, p.sy);
    const lx = q.x - o.x, ly = q.y - o.y;
    if (d.mode === 'move') { d.dx = (p.sx - d.sx0) / s; d.dy = (p.sy - d.sy0) / s; }
    else if (d.mode === 'scale') {
      const vx = d.hx - d.ox, vy = d.hy - d.oy, l2 = vx * vx + vy * vy || 1;
      d.k = clamp(((lx - d.ox) * vx + (ly - d.oy) * vy) / l2, 0.05, 25);
    } else if (d.mode === 'crop') {
      const f = d.full, it = d.orig, e = d.edge, min = 16 / s;
      let L = it.x, T = it.y, R = it.x + it.w, B = it.y + it.h;
      if (e.includes('w')) L = clamp(lx, f.x, R - min);
      if (e.includes('e')) R = clamp(lx, L + min, f.x + f.w);
      if (e.includes('n')) T = clamp(ly, f.y, B - min);
      if (e.includes('s')) B = clamp(ly, T + min, f.y + f.h);
      const dl = (L - f.x) / f.w, dr = (R - f.x) / f.w;
      d.cur = { ...it, x: L, y: T, w: R - L, h: B - T, crop: { x: it.flip ? 1 - dr : dl, y: (T - f.y) / f.h, w: dr - dl, h: (B - T) / f.h } };
    } else {
      let a = Math.atan2(ly - d.cy, lx - d.cx) - d.a0;
      const snap = Math.round(a / (Math.PI / 4)) * (Math.PI / 4);
      if (Math.abs(a - snap) < 0.06) a = snap; // snap to 45°
      d.a = a;
    }
  }

  endDrag() {
    const d = this.drag;
    this.drag = null;
    this.hidden = null;
    if (d.bmp) d.bmp.canvas.width = d.bmp.canvas.height = 0;
    const o = this.selection.o, page = o.page;
    const moved = !d.cancel && (d.mode === 'move' ? Math.hypot(d.dx, d.dy) > 0.5 : d.mode === 'scale' ? Math.abs(d.k - 1) > 0.005
      : d.mode === 'crop' ? JSON.stringify(d.cur) !== JSON.stringify(d.orig) : Math.abs(d.a) > 0.005);
    if (moved) {
      const items = this.selItems();
      const before = items.map((i) => structuredClone(i));
      if (d.mode === 'crop') {
        const it = items[0], c = d.cur.crop;
        Object.assign(it, { x: d.cur.x, y: d.cur.y, w: d.cur.w, h: d.cur.h, crop: c });
        if (c.x < 0.001 && c.y < 0.001 && c.w > 0.999 && c.h > 0.999) delete it.crop;
        invalidate(it);
      } else {
        for (const it of items) {
          if (d.mode === 'move') transformItem(it, { dx: d.dx, dy: d.dy });
          else if (d.mode === 'scale') transformItem(it, { k: d.k, ox: d.ox, oy: d.oy });
          else transformItem(it, { rot: d.a, cx: d.cx, cy: d.cy });
        }
      }
      // dropped onto another page: the items move to that page
      const target = d.mode === 'move' ? this.pageAt(o.x + d.cx + d.dx, o.y + d.cy + d.dy) : null;
      if (target && target !== o) {
        const ids = this.selection.ids;
        page.items = page.items.filter((i) => !ids.has(i.id));
        for (const it of items) { transformItem(it, { dx: o.x - target.x, dy: o.y - target.y }); target.page.items.push(it); }
        target.page.items.sort((a, b) => a.z - b.z);
        this.pushOp({ kind: 'multi', ops: [
          { kind: 'items', page: page.id, remove: before, add: [] },
          { kind: 'items', page: target.page.id, remove: [], add: items.map((i) => structuredClone(i)) },
        ] });
        this.selection = { o: target, ids };
        this.markDirty(target.page);
      } else this.pushOp({ kind: 'items', page: page.id, remove: before, add: items.map((i) => structuredClone(i)) });
    }
    this.markDirty(page);
    this.showSelMenu();
  }

  // Topmost item of the given types under a page point.
  itemAt(o, lx, ly, types) {
    const r = 6 / this.cam.s;
    for (let i = o.page.items.length - 1; i >= 0; i--) {
      const it = o.page.items[i];
      if (!types.includes(it.type)) continue;
      const b = itemBBox(it);
      if (lx >= b.x - r && lx <= b.x + b.w + r && ly >= b.y - r && ly <= b.y + b.h + r) return it;
    }
    return null;
  }

  tapAt(pt) {
    const d = this.screenToDoc(pt.x, pt.y);
    const o = this.pageAt(d.x, d.y);
    const tape = o && this.tapeAt(o, d.x - o.x, d.y - o.y);
    if (tape) { this.toggleTape(o, tape); return; }
    const it = o && this.itemAt(o, d.x - o.x, d.y - o.y, ['image', 'audio', 'text']);
    if (it) this.tapItem(o, it, 'finger');
    else if (this.selection) this.clearSelection();
  }

  // Tap on a picture → select it with its options; text → edit (text tool) or
  // select; audio clip → play.
  tapItem(o, it, via) {
    if (it.type === 'audio') { this.playAudioItem(it); return; }
    if (it.type === 'text' && via === 'text') { this.editText(o, it, false); return; }
    this.select(o, [it.id]);
  }

  showSelMenu() {
    const m = this.selMenu;
    m.innerHTML = '';
    const b = (icon, label, fn, cls = '') => h('button', { class: 'sel-btn ' + cls, title: label, 'aria-label': label, onClick: (e) => { e.stopPropagation(); fn(e); } }, h('span', { html: icons[icon] }), h('small', {}, label));
    const items = this.selItems();
    const one = items.length === 1 ? items[0] : null;
    if (this.cropMode) {
      m.append(
        b('restore', 'Reset', () => this.updateSelected((it) => { if (!it.crop) return; const c = it.crop, fw = it.w / c.w, fh = it.h / c.h; it.x -= (it.flip ? 1 - c.x - c.w : c.x) * fw; it.y -= c.y * fh; it.w = fw; it.h = fh; delete it.crop; })),
        b('check', 'Done', () => { this.cropMode = false; this.showSelMenu(); this.requestLive(); }, 'primary'));
    } else if (one && one.type === 'image') {
      m.append(
        b('sticker', one.sticker ? 'Sticker ✓' : 'Sticker', () => this.updateSelected((it) => { it.sticker = !it.sticker || undefined; })),
        b('crop', 'Crop', () => { if (one.rot) { toast('Straighten the picture to crop it'); return; } this.cropMode = true; this.showSelMenu(); this.requestLive(); }),
        b('rotate', 'Rotate', () => this.rotateSelection(Math.PI / 2)),
        b('flip', 'Flip', () => this.updateSelected((it) => { it.flip = !it.flip || undefined; })),
        b('copy', 'Copy', () => this.copySelection()),
        b('duplicate', 'Duplicate', () => this.duplicateSelection()),
        b('up', 'Front', () => this.reorderSelection(1)),
        b('down', 'Back', () => this.reorderSelection(-1)),
        b('trash', 'Delete', () => this.deleteSelection(), 'danger'));
    } else if (one && one.type === 'audio') {
      m.append(
        b('play', 'Play', () => this.playAudioItem(one)),
        b('copy', 'Copy', () => this.copySelection()),
        b('duplicate', 'Duplicate', () => this.duplicateSelection()),
        b('trash', 'Delete', () => this.deleteSelection(), 'danger'));
    } else {
      const closed = items.filter((i) => i.type === 'stroke' && i.closed);
      m.append(...[
        one && one.type === 'text' ? b('text', 'Edit', () => { const o = this.selection.o; this.clearSelection(); this.editText(o, one, false); }) : null,
        one && one.type === 'text' && one.bg ? b('note', 'Note colour', () => this.updateSelected((it) => { it.bg = STICKY_COLORS[(STICKY_COLORS.indexOf(it.bg) + 1) % STICKY_COLORS.length]; })) : null,
        closed.length ? b('fill', closed.every((i) => i.fill) ? 'Fill ✓' : 'Fill', () => { const on = !closed.every((i) => i.fill); this.updateSelected((it) => { if (it.type === 'stroke' && it.closed) it.fill = on || undefined; }); }) : null,
        b('palette', 'Colour', (e) => colorPopover(e.currentTarget, items.find((i) => i.color)?.color || '#000000', (c, final) => { if (final) this.recolorSelection(c); })),
        b('duplicate', 'Duplicate', () => this.duplicateSelection()),
        b('copy', 'Copy', () => this.copySelection()),
        b('cut', 'Cut', () => { this.copySelection(); this.deleteSelection(); }),
        b('rotate', 'Rotate', () => this.rotateSelection(Math.PI / 2)),
        b('up', 'Front', () => this.reorderSelection(1)),
        b('down', 'Back', () => this.reorderSelection(-1)),
        b('trash', 'Delete', () => this.deleteSelection(), 'danger')].filter(Boolean));
    }
    if (this.meta.locked) {
      m.innerHTML = '';
      m.append(b('copy', 'Copy', () => this.copySelection()), b('lock', 'Locked', () => this.toggleLock()));
    }
    m.hidden = false;
    this.positionSelMenu();
  }

  // Change the selected items in place (undoable).
  updateSelected(fn) {
    const items = this.selItems();
    if (!items.length) return;
    const page = this.selection.o.page;
    const before = items.map((i) => structuredClone(i));
    items.forEach((i) => { fn(i); for (const k of Object.keys(i)) if (i[k] === undefined) delete i[k]; invalidate(i); });
    this.pushOp({ kind: 'items', page: page.id, remove: before, add: items.map((i) => structuredClone(i)) });
    this.markDirty(page);
    this.showSelMenu();
    this.requestLive();
  }

  rotateSelection(a) {
    const b = this.selBox();
    if (!b) return;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    this.updateSelected((it) => transformItem(it, { rot: a, cx, cy }));
  }

  positionSelMenu() {
    if (!this.selection || this.selMenu.hidden) return;
    const r = this.selScreenBox();
    if (!r) return;
    const mw = this.selMenu.offsetWidth, mh = this.selMenu.offsetHeight;
    const left = clamp(r.x + r.w / 2 - mw / 2, 6, this.vw - mw - 6);
    // keep clear of the floating style tray at the top
    const minTop = this.tray && !this.tray.hidden && this.el.classList.contains('focus') === false ? this.tray.offsetTop + this.tray.offsetHeight + 8 : 6;
    let top = r.y - mh - 46;
    if (top < minTop) top = Math.min(this.vh - mh - 6, r.y + r.h + 18);
    if (top < minTop) top = minTop;
    this.selMenu.style.transform = `translate(${left}px, ${top}px)`;
  }

  recolorSelection(color) {
    const items = this.selItems().filter((i) => i.type !== 'image' && i.type !== 'audio');
    if (!items.length) return;
    const before = items.map((i) => structuredClone(i));
    items.forEach((i) => { i.color = color; invalidate(i); });
    this.pushOp({ kind: 'items', page: this.selection.o.page.id, remove: before, add: items.map((i) => structuredClone(i)) });
    this.markDirty(this.selection.o.page);
  }

  reorderSelection(dir) {
    const items = this.selItems();
    if (!items.length) return;
    const page = this.selection.o.page;
    const before = items.map((i) => structuredClone(i));
    if (dir > 0) items.forEach((i) => { i.z = ++this.body.zc; });
    else { const minZ = Math.min(...page.items.map((i) => i.z)) - items.length - 1; items.forEach((i, k) => { i.z = minZ + k; }); }
    page.items.sort((a, b) => a.z - b.z);
    this.pushOp({ kind: 'items', page: page.id, remove: before, add: items.map((i) => structuredClone(i)) });
    this.markDirty(page);
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

  // ---- clipboard (also talks to the system clipboard: paste into other apps) ----

  copyItems(items, label) {
    if (!items.length) return;
    const id = uid();
    const recIds = new Set(items.filter((i) => i.type === 'audio').map((i) => i.rec));
    clipboard = { id, items: items.map((i) => structuredClone(i)), recs: this.body.recordings.filter((r) => recIds.has(r.id)).map((r) => structuredClone(r)) };
    toast(label || (items.length === 1 ? 'Copied' : `Copied ${items.length} items`));
    this.renderToolbar();
    // best effort: put a PNG of the selection on the system clipboard
    try {
      if (navigator.clipboard && window.ClipboardItem) {
        const page = (this.selection && this.selection.o.page) || this.pages[this.currentIndex()];
        const png = this.itemsToPNG(page, items);
        navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([CLIP_PREFIX + id], { type: 'text/plain' }), 'image/png': png })]).catch(() => {});
      }
    } catch {}
  }

  async itemsToPNG(page, items) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const it of items) { const b = itemBBox(it); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
    const k = 2, pad = 8;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil((x1 - x0 + pad * 2) * k)); c.height = Math.max(1, Math.ceil((y1 - y0 + pad * 2) * k));
    const ctx = c.getContext('2d');
    ctx.setTransform(k, 0, 0, k, (pad - x0) * k, (pad - y0) * k);
    drawItems(ctx, page, items, { images: this.images });
    return new Promise((r) => c.toBlob(r, 'image/png'));
  }

  copySelection() { this.copyItems(this.selItems()); }

  copyPage() {
    const page = this.pages[this.currentIndex()];
    this.copyItems(page.items, 'Copied everything on this page');
  }

  duplicateSelection() {
    const items = this.selItems();
    this.insertItems(this.selection.o, items.map((i) => structuredClone(i)), 20);
  }

  paste(at) {
    if (!clipboard) { this.pasteSystem(at); return; }
    const o = at ? this.pageAt(...Object.values(this.screenToDoc(at.x, at.y)), 0) || this.lay[this.currentIndex()] : this.lay[this.currentIndex()];
    const items = clipboard.items.map((i) => structuredClone(i));
    for (const r of clipboard.recs || []) {
      if (!this.body.recordings.some((x) => x.id === r.id)) { this.body.recordings.push(structuredClone(r)); this.renderAudioBar(); }
    }
    if (at) {
      // centre the pasted items where the finger/pen tapped
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const it of items) { const b = itemBBox(it); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
      const d = this.screenToDoc(at.x, at.y);
      const dx = d.x - o.x - (x0 + x1) / 2, dy = d.y - o.y - (y0 + y1) / 2;
      items.forEach((it) => transformItem(it, { dx, dy }));
      this.insertItems(o, items, 0);
    } else this.insertItems(o, items, 20);
  }

  // Read the system clipboard (images, PDF, audio, rich or plain text from other apps).
  async pasteSystem(at) {
    if (!navigator.clipboard || !navigator.clipboard.read) { toast('Nothing to paste'); return; }
    try {
      const list = await navigator.clipboard.read();
      for (const ci of list) {
        const text = ci.types.includes('text/plain') ? await (await ci.getType('text/plain')).text() : '';
        if (clipboard && text === CLIP_PREFIX + clipboard.id) { this.paste(at); return; }
        const files = [];
        for (const t of ci.types) if (/^(image|audio)\//.test(t) || t === 'application/pdf') files.push(new File([await ci.getType(t)], 'pasted', { type: t }));
        if (await this.insertFiles(files.slice(0, 1), at, { pasted: true })) return;
        if (ci.types.includes('text/html')) {
          const blobs = await imagesFromHTML(await (await ci.getType('text/html')).text());
          if (blobs.length) { this.insertImages(blobs, at, { sticker: false }); return; }
        }
        if (text.trim()) { this.insertTextBox(text, at); return; }
      }
      toast('Nothing to paste');
    } catch { toast('Allow clipboard access to paste'); }
  }

  handlePasteEvent(e) {
    if (activeEditor !== this) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    if (this.meta.locked) { toast('This note is locked'); return; }
    const dt = e.clipboardData;
    if (!dt) return;
    e.preventDefault();
    this.pasteData(dt);
  }

  async pasteData(dt, at) {
    const files = [...(dt.files || [])];
    for (const item of dt.items || []) {
      if (item.kind !== 'file') continue;
      const f = item.getAsFile();
      if (f && !files.some((x) => x.size === f.size && x.type === f.type)) files.push(f);
    }
    const text = dt.getData('text/plain');
    if (clipboard && text === CLIP_PREFIX + clipboard.id) { this.paste(at); return; }
    if (await this.insertFiles(files, at, { pasted: true })) return;
    const html = dt.getData('text/html');
    if (html) {
      const blobs = await imagesFromHTML(html);
      if (blobs.length) { this.insertImages(blobs, at, { sticker: false }); return; }
    }
    if (text && !text.startsWith(CLIP_PREFIX)) this.insertTextBox(text, at);
    else if (clipboard) this.paste(at);
    else toast('Nothing to paste');
  }

  // Pictures, audio and PDFs from paste / drop / file pickers.
  async insertFiles(files, at, { pasted = false } = {}) {
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    const audio = files.filter((f) => f.type.startsWith('audio/') || /\.(m4a|mp3|wav|aac|ogg|oga|opus|webm|caf|flac)$/i.test(f.name || ''));
    const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name || ''));
    if (imgs.length) await this.insertImages(imgs, at, pasted ? { sticker: false } : {});
    if (audio.length) await this.addAudio(audio, at);
    for (const pdf of pdfs) {
      if (pasted) await this.insertPDFAsImages(pdf, at);
      else await this.insertPDF(pdf);
    }
    return imgs.length + audio.length + pdfs.length > 0;
  }

  // A PDF on the clipboard (e.g. copied from Notability) lands as pictures you can move & resize.
  async insertPDFAsImages(file, at) {
    const pd = progressDialog('Pasting…');
    try {
      const pages = await importPDF(file, (i, n) => pd.set(i / n));
      await this.insertImages(pages.slice(0, 20).map((r) => r.blob), at, { sticker: false });
    } catch (e) { toast(e.message || 'Could not paste that PDF'); }
    pd.close();
  }

  // Procreate-style copy & paste menu (three-finger swipe down).
  copyPasteMenu(at) {
    const r = this.rect || this.liveCv.getBoundingClientRect();
    const anchor = { x: r.left + at.x, y: r.top + at.y };
    const has = !!this.selection;
    menu(anchor, [
      { label: 'Cut', icon: 'cut', onClick: () => { if (has) { this.copySelection(); this.deleteSelection(); } else toast('Select something with the lasso first'); } },
      { label: 'Copy', icon: 'copy', onClick: () => has ? this.copySelection() : toast('Select something with the lasso first') },
      { label: 'Copy page', icon: 'pages', onClick: () => this.copyPage() },
      { label: 'Duplicate', icon: 'duplicate', onClick: () => has ? this.duplicateSelection() : this.duplicatePage() },
      { label: 'Paste', icon: 'paste', onClick: () => this.paste(at) },
    ]);
  }

  pasteMenuAt(at) {
    const r = this.rect || this.liveCv.getBoundingClientRect();
    menu({ x: r.left + at.x, y: r.top + at.y }, [{ label: 'Paste here', icon: 'paste', onClick: () => this.paste(at) }]);
  }

  insertItems(o, items, offset = 0) {
    const page = o.page;
    for (const it of items) {
      it.id = uid();
      it.z = ++this.body.zc;
      if (it.type !== 'audio') delete it.rec;
      delete it.t;
      if (offset) transformItem(it, { dx: offset, dy: offset });
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
    this.editText(o, this.newTextItem(o, lx, ly, ''), true);
  }

  newTextItem(o, lx, ly, text) {
    const cfg = this.toolCfg('text');
    const size = cfg.sizes[cfg.size];
    const x = clamp(lx, 8, o.page.w - 60);
    return {
      id: uid(), type: 'text', x, y: Math.max(4, ly - size * 0.65),
      w: Math.max(80, Math.min(440, o.page.w - x - 24)), text, size, color: cfg.colors[cfg.color],
      font: cfg.font, bold: cfg.bold || undefined, italic: cfg.italic || undefined, underline: cfg.underline || undefined,
      align: cfg.align !== 'left' ? cfg.align : undefined, z: ++this.body.zc,
    };
  }

  insertTextBox(text, at) {
    const pt = at || { x: this.vw / 2 - 150, y: this.vh / 3 };
    const d = this.screenToDoc(pt.x, pt.y);
    const o = this.pageAt(d.x, d.y) || this.lay[this.currentIndex()];
    const item = this.newTextItem(o, d.x - o.x, d.y - o.y, text.slice(0, 20000));
    item.h = measureText(item);
    o.page.items.push(item);
    this.pushOp({ kind: 'items', page: o.page.id, add: [structuredClone(item)], remove: [] });
    this.markDirty(o.page);
    this.select(o, [item.id]);
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
    this.renderToolbar();
  }

  // Toolbar changes apply live to the text box being edited.
  applyTextStyle(props) {
    if (!this.textEdit) return;
    Object.assign(this.textEdit.item, props);
    this.placeTextarea();
    setTimeout(() => this.textarea.focus({ preventScroll: true }), 0);
  }

  placeTextarea() {
    const { o, item } = this.textEdit, { s, x, y } = this.cam;
    const ta = this.textarea;
    ta.style.left = (x + (o.x + item.x) * s) + 'px';
    ta.style.top = (y + (o.y + item.y) * s) + 'px';
    ta.style.width = (item.w * s + 4) + 'px';
    ta.style.font = fontFor({ ...item, size: item.size * s });
    ta.style.lineHeight = '1.3';
    ta.style.textAlign = item.align || 'left';
    ta.style.textDecoration = item.underline ? 'underline' : 'none';
    ta.style.color = inkColor(item.color, item.bg ? false : isDarkPaper(o.page.color) && !o.page.bg);
    ta.style.background = item.bg || 'transparent';
    this.sizeTextarea();
  }

  sizeTextarea() {
    const ta = this.textarea;
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
    if (!this.textEdit) return;
    const left = parseFloat(ta.style.left), top = parseFloat(ta.style.top), w = parseFloat(ta.style.width);
    this.textGrip.hidden = this.textWidthGrip.hidden = false;
    this.textGrip.style.transform = `translate(${left - 34}px, ${top - 6}px)`;
    this.textWidthGrip.style.transform = `translate(${left + w + 2}px, ${top}px)`;
    this.textWidthGrip.style.height = Math.max(24, ta.offsetHeight) + 'px';
  }

  // Drag the grip to move the text box, or its right edge to change the width.
  bindTextGrip(el, kind) {
    let start = null;
    el.addEventListener('pointerdown', (e) => {
      if (!this.textEdit) return;
      e.preventDefault(); e.stopPropagation();
      try { el.setPointerCapture(e.pointerId); } catch {}
      const it = this.textEdit.item;
      start = { x: e.clientX, y: e.clientY, ix: it.x, iy: it.y, iw: it.w };
      this.gripping = true;
    });
    el.addEventListener('pointermove', (e) => {
      if (!start || !this.textEdit) return;
      e.preventDefault();
      const { item, o } = this.textEdit, s = this.cam.s;
      const dx = (e.clientX - start.x) / s, dy = (e.clientY - start.y) / s;
      if (kind === 'move') {
        item.x = clamp(start.ix + dx, -item.w + 30, o.page.w - 30);
        item.y = clamp(start.iy + dy, 0, o.page.h - 20);
      } else item.w = clamp(start.iw + dx, 40, o.page.w * 1.5);
      this.placeTextarea();
    });
    const end = () => {
      if (!start) return;
      start = null;
      setTimeout(() => { this.gripping = false; if (this.textEdit) this.textarea.focus({ preventScroll: true }); }, 0);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  }

  commitText() {
    const te = this.textEdit;
    if (!te) return;
    this.textEdit = null;
    const ta = this.textarea;
    ta.hidden = true;
    this.textGrip.hidden = this.textWidthGrip.hidden = true;
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
    } else if (JSON.stringify({ ...item, text, h: 0 }) !== JSON.stringify({ ...te.before, h: 0 })) {
      item.text = text;
      item.h = measureText(item);
      this.pushOp({ kind: 'items', page: page.id, remove: [te.before], add: [structuredClone(item)] });
    }
    this.markDirty(page);
    this.renderToolbar();
  }

  // ---- images, drag & drop ----

  async pickImages() {
    const files = await pickFile('image/*', true);
    if (files.length) this.insertImages(files);
  }

  takePhoto() {
    const input = h('input', { type: 'file', accept: 'image/*', capture: 'environment', style: { display: 'none' } });
    input.addEventListener('change', () => { if (input.files.length) this.insertImages([...input.files]); input.remove(); });
    document.body.append(input);
    input.click();
  }

  async pickAudio() {
    const files = await pickFile('audio/*,.m4a,.mp3,.wav,.aac,.ogg,.webm,.caf', true);
    if (files.length) this.addAudio(files);
  }

  insertMenu(anchor) {
    if (this.meta.locked) { toast('This note is locked'); return; }
    menu(anchor, [
      { label: 'Photo or image…', icon: 'image', onClick: () => this.pickImages() },
      { label: 'Take photo', icon: 'camera', onClick: () => this.takePhoto() },
      { label: 'Audio file…', icon: 'audio', onClick: () => this.pickAudio() },
      { label: this.rec ? 'Stop recording' : 'Record audio', icon: 'mic', onClick: () => this.toggleRecord() },
      { label: 'Text box', icon: 'text', onClick: () => this.setTool('text') },
      { label: 'Sticky note', icon: 'note', onClick: () => this.addSticky() },
      { label: 'Stickers…', icon: 'sparkle', onClick: () => this.stickerPicker(anchor) },
      { label: 'Scan document', icon: 'scan', onClick: () => this.scanDocument() },
      { label: 'Paste', icon: 'paste', onClick: () => this.paste() },
      '-',
      { label: 'New pictures look like stickers', checked: settings.stickerImages !== false, onClick: () => { settings.stickerImages = settings.stickerImages === false; saveSettings(); } },
      '-',
      { label: 'PDF pages…', icon: 'pdf', onClick: () => this.insertPDF() },
      { label: 'Images as pages…', icon: 'pages', onClick: () => this.insertImagePages() },
    ]);
  }

  async onDrop(e) {
    e.preventDefault();
    if (this.meta.locked) { toast('This note is locked'); return; }
    const files = [...(e.dataTransfer?.files || [])];
    const r = this.liveCv.getBoundingClientRect();
    const at = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (files.length) { this.insertFiles(files, at); return; }
    const html = e.dataTransfer.getData('text/html');
    if (html) { const blobs = await imagesFromHTML(html); if (blobs.length) { this.insertImages(blobs, at); return; } }
    const text = e.dataTransfer.getData('text/plain');
    if (text) this.insertTextBox(text, at);
  }

  // Camera → cleaned-up page (whiter paper, darker ink), like a document scanner.
  scanDocument() {
    const input = h('input', { type: 'file', accept: 'image/*', capture: 'environment', multiple: true, style: { display: 'none' } });
    input.addEventListener('change', async () => {
      const files = [...input.files];
      input.remove();
      if (!files.length) return;
      const pd = progressDialog('Scanning…');
      try { this.insertPagesAfterCurrent(await imagesToPages(files, { scan: true })); } catch (e) { toast(e.message || 'Could not scan'); }
      pd.close();
    });
    document.body.append(input);
    input.click();
  }

  async insertImages(files, at, { sticker = settings.stickerImages !== false, width = 0 } = {}) {
    const d = at ? this.screenToDoc(at.x, at.y) : this.screenToDoc(this.vw / 2, this.vh / 2);
    const o = this.pageAt(d.x, d.y) || this.lay[this.currentIndex()];
    const page = o.page;
    const added = [];
    for (const f of files) {
      try {
        const blob = await downscale(f, 2200);
        const id = await putAsset(uid(), blob);
        const img = await loadImage(await assetURL(id));
        this.images.set(id, img);
        const ratio = img.naturalHeight / img.naturalWidth;
        let w = width || Math.min(img.naturalWidth, page.w * 0.6);
        let hh = w * ratio;
        if (hh > page.h * 0.6) { hh = page.h * 0.6; w = hh / ratio; }
        const off = added.length * 24;
        const item = {
          id: uid(), type: 'image', asset: id, w, h: hh, z: ++this.body.zc, sticker: sticker || undefined,
          x: clamp(d.x - o.x - w / 2 + off, 0, page.w - w),
          y: clamp(d.y - o.y - hh / 2 + off, 0, Math.max(0, page.h - hh)),
        };
        page.items.push(item);
        added.push(item);
      } catch { toast('Could not open that image'); }
    }
    if (!added.length) return;
    added.forEach((i) => { if (!i.sticker) delete i.sticker; });
    this.pushOp({ kind: 'items', page: page.id, add: added.map((i) => structuredClone(i)), remove: [] });
    this.markDirty(page);
    this.select(o, added.map((i) => i.id));
  }

  // ---- audio clips on the page ----

  audioChip(o, rec, lx, ly) {
    const w = 230, hh = 54;
    return {
      id: uid(), type: 'audio', rec: rec.id, label: rec.name, dur: Math.round(rec.duration || 0), w, h: hh, z: ++this.body.zc,
      x: clamp(lx - w / 2, 0, Math.max(0, o.page.w - w)), y: clamp(ly - hh / 2, 0, Math.max(0, o.page.h - hh)),
    };
  }

  async addAudio(files, at) {
    const pt = at || { x: this.vw / 2, y: this.vh / 2 };
    const d = this.screenToDoc(pt.x, pt.y);
    const o = this.pageAt(d.x, d.y) || this.lay[this.currentIndex()];
    const added = [];
    let last;
    for (const f of files) {
      try {
        const asset = await putAsset(uid(), f);
        last = { id: uid(), asset, duration: await audioDuration(f), created: Date.now(), name: String(f.name && f.name !== 'pasted' ? f.name : 'Audio').replace(/\.[^.]+$/, ''), transcript: [] };
        this.body.recordings.push(last);
        added.push(this.audioChip(o, last, d.x - o.x, d.y - o.y + added.length * 64));
      } catch { toast('Could not add that audio file'); }
    }
    if (!added.length) return;
    o.page.items.push(...added);
    this.pushOp({ kind: 'items', page: o.page.id, add: added.map((i) => structuredClone(i)), remove: [] });
    this.markDirty(o.page);
    this.renderAudioBar(last.id);
    this.select(o, added.map((i) => i.id));
    toast(added.length === 1 ? 'Audio added — tap it to play' : `${added.length} audio clips added`);
  }

  // Put a recording on the page as a clip you can tap to play.
  placeRecording(rec) {
    const d = this.screenToDoc(this.vw / 2, this.vh / 2);
    const o = this.pageAt(d.x, d.y) || this.lay[this.currentIndex()];
    this.insertItems(o, [this.audioChip(o, rec, d.x - o.x, d.y - o.y)], 0);
  }

  async playAudioItem(it) {
    const rec = this.body.recordings.find((r) => r.id === it.rec);
    if (!rec) { toast('This recording is no longer in the note'); return; }
    if (this.curRec !== rec.id || !this.player) { this.stopPlayback(true); this.renderAudioBar(rec.id); }
    this.togglePlay();
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
    if (op.kind === 'multi') {
      const list = dir > 0 ? op.ops : op.ops.slice().reverse();
      for (const o of list) this.applyOp(o, dir);
      return;
    }
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
        if (page) Object.assign(page, structuredClone(dir > 0 ? c.after : c.before));
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

  addPage(afterIndex = this.currentIndex(), silent = false, opts) {
    const ref = this.pages[afterIndex] || this.pages[this.pages.length - 1];
    const p = newPage(opts || (ref && !ref.bg ? { w: ref.w, h: ref.h, template: ref.template, color: ref.color, tpl: ref.tpl } : {}));
    this.pagesOp(() => this.pages.splice(afterIndex + 1, 0, p));
    if (!silent) { this.scrollToPage(afterIndex + 1); toast('Page added'); }
  }

  duplicatePage(i = this.currentIndex()) {
    const p = structuredClone(this.pages[i]);
    p.id = uid();
    for (const it of p.items) { it.id = uid(); if (it.type !== 'audio') delete it.rec; delete it.t; }
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
      act('close', 'Close', () => this.togglePagesPanel())),
    h('div', { class: 'seg pp-filter' }, [['all', 'All'], ['bm', 'Bookmarks']].map(([v, l]) =>
      h('button', { class: (this.ppFilter || 'all') === v ? 'on' : '', onClick: () => { this.ppFilter = v; this.renderPagesPanel(); } }, l))));
    const list = h('div', { class: 'pp-list' });
    this.pages.forEach((page, i) => {
      if (this.ppFilter === 'bm' && !page.bookmark) return;
      const thumb = h('div', { class: 'pp-thumb' + (i === cur ? ' current' : '') + (page.bookmark ? ' bm' : ''), style: { aspectRatio: `${page.w} / ${page.h}` } });
      renderPageCanvas(page, 150 / page.w).then((c) => thumb.append(c));
      list.append(h('div', { class: 'pp-item' },
        h('button', { class: 'pp-open', onClick: () => { this.scrollToPage(i); this.renderPagesPanel(); } }, thumb, h('span', { class: 'pp-num' }, String(i + 1))),
        h('div', { class: 'pp-actions' },
          act('up', 'Move up', () => this.movePage(i, -1)),
          act('down', 'Move down', () => this.movePage(i, 1)),
          act(page.bookmark ? 'bookmarkOn' : 'bookmark', page.bookmark ? 'Remove bookmark' : 'Bookmark page', () => this.toggleBookmark(i)),
          act('duplicate', 'Duplicate page', () => this.duplicatePage(i)),
          act('trash', 'Delete page', () => this.deletePage(i)))));
    });
    P.append(list, h('button', { class: 'btn block', onClick: () => this.addPage(this.pages.length - 1) }, '+ Add page'));
  }

  toggleFocus() {
    this.el.classList.toggle('focus');
    requestAnimationFrame(() => this.resize());
  }

  // ---- paper & templates ----

  applyPageProps(targets, props) {
    const keys = Object.keys(props);
    const changes = targets.map((p) => ({ id: p.id, before: structuredClone(pick(p, keys)), after: structuredClone(props) }));
    targets.forEach((p) => Object.assign(p, structuredClone(props)));
    this.pushOp({ kind: 'props', changes });
    this.pagesChanged();
  }

  // Dark / light pages in one tap (like Notability). Black ink shows white on
  // dark paper and white ink shows black on light paper; other colours stay.
  toggleDarkMode() {
    const toDark = !this.curDark();
    const lightFor = (p) => {
      if (p.lightColor && !isDarkPaper(p.lightColor)) return p.lightColor;
      const pc = plannerById(p.template) ? plannerPaperColor(p.template) : null;
      return pc && !isDarkPaper(pc) ? pc : '#ffffff';
    };
    const changes = [];
    for (const p of this.pages) {
      if (p.bg || isDarkPaper(p.color) === toDark) continue;
      const before = { color: p.color, lightColor: p.lightColor };
      const after = toDark ? { color: DARK_PAPER, lightColor: p.color } : { color: lightFor(p), lightColor: undefined };
      Object.assign(p, after);
      if (p.lightColor === undefined) delete p.lightColor;
      changes.push({ id: p.id, before, after });
    }
    this.crossfade();
    if (changes.length) { this.pushOp({ kind: 'props', changes }); this.pagesChanged(); }
    if (toDark) { if (!isDarkPaper(settings.defaultColor)) settings.lightDefaultColor = settings.defaultColor; settings.defaultColor = DARK_PAPER; }
    else settings.defaultColor = settings.lightDefaultColor || '#ffffff';
    settings.theme = toDark ? 'dark' : 'light';
    saveSettings();
    applyTheme();
    this.renderToolbar();
    toast(toDark ? 'Dark mode · black ink shows white' : 'Light mode · white ink shows black');
  }

  // Paper & template picker. It is built once and updated in place, so
  // switching templates is instant (no flicker, previews are cached).
  paperMenu(anchor) {
    const page = this.pages[this.currentIndex()];
    const scope = () => this._paperScope || 'page';
    const targets = () => scope() === 'all' ? this.pages.filter((p) => !p.bg) : [page];
    const apply = (props) => { this.crossfade(); this.applyPageProps(targets(), props); refresh(); };
    const setTemplate = (id) => {
      if (id === page.template && scope() === 'page') return;
      const props = { template: id, tpl: { ...(page.tpl || {}) } };
      if (plannerById(id) !== plannerById(page.template) || !plannerById(id)) {
        props.color = plannerById(id) ? plannerPaperColor(id) : (plannerById(page.template) ? (isDarkPaper(page.color) ? DARK_PAPER : '#ffffff') : page.color);
      }
      apply(props);
      settings.defaultTemplate = id; saveSettings();
    };
    const tplBtns = new Map();
    const paperColor = () => plannerById(page.template) ? (isDarkPaper(page.color) ? DARK_PAPER : '#ffffff') : page.color;
    let previewColor = paperColor();
    const card = (id) => {
      const b = h('button', { class: 'tpl', onClick: () => setTemplate(id) },
        templatePreview(id, { color: plannerById(id) ? undefined : previewColor, width: 76 }), h('span', {}, templateLabel(id)));
      tplBtns.set(id, b);
      return b;
    };
    const scopeBtns = ['page', 'all'].map((v) => h('button', { onClick: () => { this._paperScope = v; refresh(); } }, v === 'all' ? 'All pages' : 'This page'));
    const colorBtns = PAPER_COLORS.map((c) => [c.id, h('button', { class: 'swatch', title: c.label, 'aria-label': c.label, style: { background: c.id }, onClick: () => apply({ color: c.id }) })]);
    const accentBtns = ACCENTS.map((c) => [c, h('button', { class: 'swatch', style: { background: c }, 'aria-label': c, onClick: () => apply({ tpl: { ...(page.tpl || {}), accent: c } }) })]);
    const titleIn = h('input', { class: 'input', placeholder: 'Heading text' });
    titleIn.addEventListener('change', () => apply({ tpl: { ...(page.tpl || {}), title: titleIn.value } }));
    const sizeBtns = Object.values(SIZES).map((sz) => [sz, h('button', { class: 'chip', onClick: () => { apply({ w: sz.w, h: sz.h }); this.fitWidth(false); } }, sz.label)]);
    const plannerBox = h('div', {}, h('h4', {}, 'Accent colour'), h('div', { class: 'row wrap' }, accentBtns.map((x) => x[1])), h('h4', {}, 'Heading'), titleIn);
    const refresh = () => {
      scopeBtns.forEach((b, k) => b.classList.toggle('on', ['page', 'all'][k] === scope()));
      for (const [id, b] of tplBtns) b.classList.toggle('on', page.template === id);
      const pc = paperColor();
      if (pc !== previewColor) {
        previewColor = pc;
        for (const p of PAPERS) { const b = tplBtns.get(p.id); b.querySelector('canvas').replaceWith(templatePreview(p.id, { color: pc, width: 76 })); }
      }
      colorBtns.forEach(([c, b]) => b.classList.toggle('on', page.color === c));
      sizeBtns.forEach(([sz, b]) => b.classList.toggle('on', page.w === sz.w && page.h === sz.h));
      const isPlanner = !!plannerById(page.template);
      plannerBox.hidden = !isPlanner;
      accentBtns.forEach(([c, b]) => b.classList.toggle('on', (page.tpl || {}).accent === c));
      if (document.activeElement !== titleIn) titleIn.value = (page.tpl || {}).title || '';
    };
    const pop = h('div', { class: 'paper-pop' },
      h('div', { class: 'row' }, h('div', { class: 'seg' }, scopeBtns), h('div', { class: 'grow' }),
        h('button', { class: 'chip', onClick: () => { closePopover(); this.toggleDarkMode(); } }, h('span', { html: icons[this.curDark() ? 'sun' : 'moon'] }), this.curDark() ? 'Light' : 'Dark'),
        h('button', { class: 'chip', onClick: () => { closePopover(); this.addPage(this.currentIndex(), false, { w: page.w, h: page.h, template: page.template, color: page.color, tpl: page.tpl }); } }, '+ Add page')),
      h('h4', {}, 'Paper'), h('div', { class: 'tpl-grid' }, PAPERS.map((p) => card(p.id))),
      h('div', { class: 'row' }, h('h4', {}, 'Planners'), h('div', { class: 'grow' }),
        h('button', { class: 'chip', onClick: () => { closePopover(); this.templateGalleryForPages(); } }, 'All templates…')),
      h('div', { class: 'tpl-grid' }, PLANNERS.slice(0, 8).map((p) => card(p.id))),
      plannerBox,
      h('h4', {}, 'Paper colour'),
      h('div', { class: 'row wrap' }, colorBtns.map((x) => x[1]),
        h('button', { class: 'swatch more', 'aria-label': 'Custom colour', html: icons.palette, onClick: (e) => colorPopover(e.currentTarget, page.color, (c, fin) => { if (fin) apply({ color: c }); }) })),
      h('h4', {}, 'Size & orientation'), h('div', { class: 'row wrap' }, sizeBtns.map((x) => x[1])));
    refresh();
    popover(anchor, pop, { className: 'wide' });
  }

  templateGalleryForPages() {
    templateGallery({
      title: 'Add pages from template', action: 'Add pages',
      onPick: (st) => {
        const sz = SIZES[st.size];
        const i = this.currentIndex();
        const pages = Array.from({ length: st.count }, () => newPage({ w: sz.w, h: sz.h, template: st.template, color: st.color, tpl: st.tpl }));
        const blankOnly = this.pages.length === 1 && !this.pages[0].items.length && !this.pages[0].bg;
        this.pagesOp(() => { if (blankOnly) this.pages.splice(0, 1, ...pages); else this.pages.splice(i + 1, 0, ...pages); });
        this.fitWidth(false);
        this.scrollToPage(blankOnly ? 0 : i + 1);
      },
    });
  }

  exportMenu(anchor) {
    menu(anchor, [
      { label: 'Export as PDF', icon: 'pdf', onClick: () => this.exportPDF() },
      { label: 'Export this page as image', icon: 'image', onClick: () => this.exportPNG() },
      { label: 'Export note file (.inknote.json)', icon: 'download', onClick: () => { this.save.flush(); exportNoteFile(this.meta); } },
      '-',
      { label: 'Print', icon: 'paper', onClick: () => this.print() },
    ]);
  }

  moreMenu(anchor) {
    const fd = settings.fingerDraw;
    menu(anchor, [
      { label: 'Import PDF pages…', icon: 'pdf', onClick: () => this.insertPDF() },
      { label: 'Import images as pages…', icon: 'image', onClick: () => this.insertImagePages() },
      { label: 'Paste', icon: 'paste', onClick: () => this.paste() },
      { label: 'Fit to width', icon: 'zoomFit', onClick: () => this.fitWidth(false) },
      '-',
      { label: 'Draw with finger: Auto', checked: fd === 'auto', onClick: () => this.setFinger('auto') },
      { label: 'Draw with finger: On', checked: fd === 'on', onClick: () => this.setFinger('on') },
      { label: 'Draw with finger: Off', checked: fd === 'off', onClick: () => this.setFinger('off') },
      { label: 'Eraser returns to pen', checked: settings.eraserAutoDeselect, onClick: () => { settings.eraserAutoDeselect = !settings.eraserAutoDeselect; saveSettings(); } },
      { label: 'Gestures help', icon: 'hand', onClick: () => this.gestureHelp() },
      { label: 'Quick tips', icon: 'help', onClick: () => this.showTips(anchor) },
      '-',
      { label: this.pages[this.currentIndex()].bookmark ? 'Remove bookmark' : 'Bookmark this page', icon: 'bookmark', onClick: () => this.toggleBookmark() },
      { label: 'Go to page…', icon: 'pages', onClick: () => this.goToPage() },
      { label: 'Find in note', icon: 'search', onClick: () => this.findPanel() },
      this.inSplit() ? { label: 'Close this side', icon: 'close', onClick: () => this.exit() } : { label: 'Open another note side by side…', icon: 'pages', onClick: () => this.splitMenu(anchor) },
      { label: 'Study timer…', icon: 'timer', onClick: () => this.timerMenu(this.timerBtn) },
      { label: this.meta.locked ? 'Unlock note' : 'Lock note (read only)', icon: this.meta.locked ? 'unlock' : 'lock', onClick: () => this.toggleLock() },
      '-',
      { label: 'Delete this page', icon: 'trash', danger: true, onClick: () => this.deletePage() },
    ]);
  }

  toggleLock() {
    this.meta.locked = !this.meta.locked || undefined;
    if (!this.meta.locked) delete this.meta.locked;
    if (this.meta.locked) { this.commitText(); this.clearSelection(); }
    this.lockBtn.hidden = !this.meta.locked;
    this.changed();
    toast(this.meta.locked ? 'Note locked — read only' : 'Note unlocked');
  }

  async goToPage() {
    const v = await promptDialog('Go to page', String(this.currentIndex() + 1), { placeholder: `1 – ${this.pages.length}`, ok: 'Go' });
    const n = parseInt(v, 10);
    if (n >= 1 && n <= this.pages.length) this.scrollToPage(n - 1);
  }

  gestureHelp() {
    const rows = [
      ['Two-finger tap', 'Undo'], ['Two-finger hold', 'Rapid undo'], ['Three-finger tap', 'Redo'],
      ['Three-finger swipe down', 'Copy & paste menu'], ['Four-finger tap', 'Full screen on / off'],
      ['Pinch', 'Zoom (quick pinch in = fit width)'], ['Draw & hold', 'Perfect shape'],
      ['Lasso tap on empty space', 'Paste here'], ['Stylus eraser end / button', 'Erase'],
      ['Finger tap on a picture / text', 'Select it (drag to move, corners to resize)'],
      ['Tap an audio clip', 'Play it'], ['Text tool: drag a text box', 'Move it'],
    ];
    popover(this.optsEl, h('div', { class: 'help-pop' }, h('h4', {}, 'Gestures'),
      h('table', {}, rows.map(([a, b]) => h('tr', {}, h('td', {}, a), h('td', {}, b))))), { className: 'wide' });
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

  async print() {
    const w = window.open('', '_blank');
    if (!w) { toast('Allow pop-ups to print'); return; }
    w.document.write('<title>' + safeName(this.meta.title) + '</title><style>body{margin:0}img{width:100%;display:block;page-break-after:always}</style>');
    for (const p of this.pages) { const c = await renderPageCanvas(p, 2); w.document.write(`<img src="${c.toDataURL('image/jpeg', 0.9)}">`); }
    w.document.close();
    w.onload = () => w.print();
    setTimeout(() => w.print(), 800);
  }

  async insertPDF(file) {
    if (!file) [file] = await pickFile('application/pdf,.pdf');
    if (!file) return;
    const pd = progressDialog('Importing PDF…');
    try {
      const pages = await pdfToPages(file, (i, n) => pd.set(i / n, `Page ${i} of ${n}`));
      this.insertPagesAfterCurrent(pages);
    } catch (e) { toast(e.message || 'Could not import PDF'); }
    pd.close();
  }

  async insertImagePages() {
    const files = await pickFile('image/*', true);
    if (!files.length) return;
    this.insertPagesAfterCurrent(await imagesToPages(files));
  }

  insertPagesAfterCurrent(pages) {
    if (!pages.length) return;
    const at = this.currentIndex();
    const replaceBlank = this.pages.length === 1 && !this.pages[0].items.length && !this.pages[0].bg;
    this.pagesOp(() => { if (replaceBlank) this.pages.splice(0, 1, ...pages); else this.pages.splice(at + 1, 0, ...pages); });
    this.fitWidth(false);
    this.scrollToPage(replaceBlank ? 0 : at + 1);
  }

  // ---- toolbar ----

  toolTap(t) {
    if (this.tool === t && (t === 'pen' || t === 'hl' || t === 'eraser')) { this.toolOptions(t); return; }
    this.setTool(t);
  }

  setTool(t, keepSelection = false) {
    if (this.textEdit && t !== 'text') this.commitText();
    if (!keepSelection && this.selection) this.clearSelection();
    if (t === 'eraser' && this.tool !== 'eraser') this.prevTool = this.tool;
    this.tool = t;
    this.hover = null;
    this.renderToolbar();
    this.requestLive();
  }

  // second tap on a tool: its detailed options
  toolOptions(t) {
    const anchor = this.toolBtns[t];
    if (t === 'pen') {
      const cfg = this.toolCfg('pen');
      popover(anchor, h('div', { class: 'opt-pop' }, h('h4', {}, 'Pen style'),
        h('div', { class: 'seg wrap' }, PEN_STYLES.map(([v, l]) =>
          h('button', { class: cfg.style === v ? 'on' : '', onClick: () => { cfg.style = v; saveSettings(); closePopover(); this.renderToolbar(); } }, l))),
        h('label', { class: 'toggle' }, h('span', {}, h('b', {}, 'Pressure sensitivity')), (() => { const c = h('input', { type: 'checkbox', checked: settings.pressure }); c.onchange = () => { settings.pressure = c.checked; saveSettings(); }; return c; })()),
        h('label', { class: 'toggle' }, h('span', {}, h('b', {}, 'Draw & hold for shapes')), (() => { const c = h('input', { type: 'checkbox', checked: settings.shapeHold }); c.onchange = () => { settings.shapeHold = c.checked; saveSettings(); }; return c; })())));
    } else if (t === 'eraser') {
      const cfg = this.toolCfg('eraser');
      popover(anchor, h('div', { class: 'opt-pop' }, h('h4', {}, 'Eraser'),
        h('div', { class: 'seg' }, [['precise', 'Precise'], ['stroke', 'Whole stroke'], ['hl', 'Highlighter only']].map(([v, l]) =>
          h('button', { class: cfg.mode === v ? 'on' : '', onClick: () => { cfg.mode = v; saveSettings(); closePopover(); this.renderToolbar(); } }, l))),
        h('label', { class: 'toggle' }, h('span', {}, h('b', {}, 'Return to previous tool after erasing')), (() => { const c = h('input', { type: 'checkbox', checked: settings.eraserAutoDeselect }); c.onchange = () => { settings.eraserAutoDeselect = c.checked; saveSettings(); }; return c; })())));
    } else this.setTool(t);
  }

  renderToolbar() {
    for (const [id, b] of Object.entries(this.toolBtns)) b.classList.toggle('on', id === this.tool);
    this.toolboxBtn.classList.toggle('on', this.tool === 'tape' || this.tool === 'laser' || !!this.zoom || !!this.ruler);
    this.renderPresets(this.presetsEl);
    const O = this.optsEl;
    O.innerHTML = '';
    const t = this.tool;
    const cfg = settings.tools[t];
    const swatches = () => cfg.colors.forEach((c, i) => {
      const shown = t === 'pen' || t === 'text' ? inkColor(c, this.curDark()) : c;
      const sw = h('button', { class: 'swatch' + (i === cfg.color ? ' on' : ''), style: { background: shown }, title: i === cfg.color ? 'Tap again for more colours' : 'Colour', 'aria-label': 'Colour ' + (i + 1) });
      sw.addEventListener('click', () => {
        if (i === cfg.color) {
          colorPopover(sw, c, (nc, fin) => { cfg.colors[i] = nc; if (fin) { saveSettings(); this.renderToolbar(); if (t === 'text') this.applyTextStyle({ color: nc }); } else sw.style.background = nc; });
        } else { cfg.color = i; saveSettings(); this.renderToolbar(); if (t === 'text') this.applyTextStyle({ color: c }); }
      });
      O.append(sw);
    });
    const sizes = (render) => cfg.sizes.forEach((sz, i) => {
      const b = h('button', { class: 'size-btn' + (i === cfg.size ? ' on' : ''), title: i === cfg.size ? 'Tap again to fine-tune' : 'Size', 'aria-label': 'Size ' + (i + 1) }, render(sz, i));
      b.addEventListener('click', () => {
        if (i === cfg.size) {
          const range = t === 'hl' ? [4, 48, 1] : t === 'eraser' ? [3, 80, 1] : t === 'text' ? [8, 96, 1] : [0.4, 14, 0.1];
          sliderPopover(b, { label: 'Size', min: range[0], max: range[1], step: range[2], value: sz, onInput: (v) => { cfg.sizes[i] = v; saveSettings(); if (t === 'text') this.applyTextStyle({ size: v }); } });
        } else { cfg.size = i; saveSettings(); this.renderToolbar(); if (t === 'text') this.applyTextStyle({ size: cfg.sizes[i] }); }
      });
      O.append(b);
    });
    if (t === 'pen' || t === 'hl') {
      swatches();
      O.append(h('div', { class: 'tb-sep sm' }));
      sizes((sz) => { const d = Math.min(22, 3 + (t === 'hl' ? sz / 2 : sz * 2.4)); return h('span', { class: 'size-dot', style: { width: d + 'px', height: d + 'px', background: t === 'pen' ? inkColor(cfg.colors[cfg.color], this.curDark()) : cfg.colors[cfg.color], opacity: t === 'hl' ? 0.6 : 1 } }); });
      if (t === 'pen') O.append(h('button', { class: 'chip', onClick: () => this.toolOptions('pen') }, (PEN_STYLES.find((x) => x[0] === (cfg.style || 'fountain')) || PEN_STYLES[0])[1]));
      if (t === 'hl') O.append(h('button', { class: 'chip' + (cfg.straight ? ' on' : ''), title: 'Highlight in straight lines', onClick: () => { cfg.straight = !cfg.straight; saveSettings(); this.renderToolbar(); } }, 'Straight'));
      O.append(h('button', { class: 'size-btn', title: 'Eyedropper: pick a colour from the page', 'aria-label': 'Eyedropper', html: icons.dropper, onClick: () => this.startEyedropper() }));
    } else if (t === 'tape') {
      swatches();
      O.append(h('div', { class: 'tb-sep sm' }));
      sizes((sz) => h('span', { class: 'tape-dot', style: { width: Math.min(26, 8 + sz / 2) + 'px', height: Math.min(14, 4 + sz / 4) + 'px', background: cfg.colors[cfg.color] } }));
      O.append(h('button', { class: 'chip', onClick: () => this.startQuiz() }, 'Quiz me'),
        h('button', { class: 'chip', onClick: () => this.setAllTapes(true) }, 'Reveal all'),
        h('button', { class: 'chip', onClick: () => this.setAllTapes(false) }, 'Cover all'),
        h('span', { class: 'hint' }, 'Draw tape over answers · tap a tape to peek'));
    } else if (t === 'text') {
      const st = this.textEdit ? this.textEdit.item : cfg;
      O.append(h('button', { class: 'chip font-chip', style: { fontFamily: fontStack(cfg.font) }, onClick: (e) => fontPicker(e.currentTarget, cfg.font, (f) => { cfg.font = f; saveSettings(); this.renderToolbar(); this.applyTextStyle({ font: f }); this.markAllDirty(); }) }, cfg.font || 'Font'));
      swatches();
      O.append(h('div', { class: 'tb-sep sm' }));
      sizes((sz) => h('span', { class: 'size-txt' }, Math.round(sz)));
      const tog = (key, icon) => h('button', { class: 'size-btn' + (st[key] ? ' on' : ''), 'aria-label': key, html: icons[icon], onClick: () => { cfg[key] = !st[key]; saveSettings(); this.applyTextStyle({ [key]: cfg[key] || undefined }); this.renderToolbar(); } });
      O.append(tog('bold', 'bold'), tog('italic', 'italic'), tog('underline', 'underline'));
      const al = st.align || 'left';
      const next = { left: 'center', center: 'right', right: 'left' };
      O.append(h('button', { class: 'size-btn', 'aria-label': 'Alignment', html: icons['align' + al[0].toUpperCase() + al.slice(1)], onClick: () => { cfg.align = next[al]; saveSettings(); this.applyTextStyle({ align: cfg.align === 'left' ? undefined : cfg.align }); this.renderToolbar(); } }));
    } else if (t === 'eraser') {
      O.append(h('div', { class: 'seg' }, [['precise', 'Precise'], ['stroke', 'Stroke'], ['hl', 'Highlighter']].map(([v, l]) =>
        h('button', { class: cfg.mode === v ? 'on' : '', onClick: () => { cfg.mode = v; saveSettings(); this.renderToolbar(); } }, l))));
      sizes((sz, i) => h('span', { class: 'size-ring', style: { width: (6 + i * 6) + 'px', height: (6 + i * 6) + 'px' } }));
      O.append(h('label', { class: 'mini-toggle', title: 'Return to the previous tool after erasing' },
        (() => { const c = h('input', { type: 'checkbox', checked: settings.eraserAutoDeselect }); c.onchange = () => { settings.eraserAutoDeselect = c.checked; saveSettings(); }; return c; })(), 'Auto-return'));
    } else if (t === 'lasso') {
      O.append(h('span', { class: 'hint' }, 'Circle to select · drag ↻ to rotate'));
      O.append(h('button', { class: 'chip', onClick: () => this.paste() }, h('span', { html: icons.paste }), 'Paste'));
    } else if (t === 'laser') {
      swatches();
      O.append(h('span', { class: 'hint' }, 'Point things out — the trail fades away'));
    } else if (t === 'hand') {
      O.append(h('span', { class: 'hint' }, 'Drag to scroll · pinch to zoom'));
    }
    this.updateUndo();
  }

  handleKey(e) {
    if (activeEditor !== this) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); this.redo(); return; }
    if (mod && k === 'c') { if (this.selection) { e.preventDefault(); this.copySelection(); } return; }
    if (mod && k === 'x') { if (this.selection) { e.preventDefault(); this.copySelection(); this.deleteSelection(); } return; }
    if (mod && k === 'v') return; // handled by the paste event (works with system clipboard)
    if (mod && k === 'd') { e.preventDefault(); if (this.selection) this.duplicateSelection(); return; }
    if (mod && (k === '=' || k === '+')) { e.preventDefault(); this.zoomAt(this.vw / 2, this.vh / 2, this.cam.s * 1.2); return; }
    if (mod && k === '-') { e.preventDefault(); this.zoomAt(this.vw / 2, this.vh / 2, this.cam.s / 1.2); return; }
    if (mod && k === '0') { e.preventDefault(); this.fitWidth(false); return; }
    if (mod && k === 's') { e.preventDefault(); this.save.flush(); toast('Saved'); return; }
    if (mod && k === 'f') { e.preventDefault(); this.findPanel(); return; }
    if (mod) return;
    if ((k === 'delete' || k === 'backspace') && this.selection) { e.preventDefault(); if (!this.meta.locked) this.deleteSelection(); return; }
    if (k === 'escape' && this.eyedrop) { this.eyedrop = false; this.liveCv.style.cursor = ''; return; }
    if (k === 'escape') { if (this.el.classList.contains('focus')) this.toggleFocus(); this.clearSelection(); return; }
    if (e.code === 'Space') { this.spaceDown = true; e.preventDefault(); return; }
    const map = { p: 'pen', h: 'hl', e: 'eraser', l: 'lasso', t: 'text', k: 'laser', y: 'tape' };
    if (k === 'z' && !e.shiftKey) { this.toggleZoom(); return; }
    if (k === 'r') { this.toggleRuler(); return; }
    if (map[k]) this.setTool(map[k]);
    if (k === 'f') this.toggleFocus();
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
    this.rec = { id: uid(), start: performance.now(), mr, stream, chunks, mime, transcript: [] };
    this.startTranscript();
    this.recBtn.classList.add('recording');
    this.recTimer = setInterval(() => { this.recTime.textContent = fmtTime((performance.now() - this.rec.start) / 1000); }, 250);
    this.recTime.textContent = '0:00';
    toast('Recording — your writing is synced to the audio');
  }

  // Live captions where the browser supports speech recognition (Safari, Chrome, Edge).
  startTranscript() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR || !this.rec) return;
    const r = this.rec;
    try {
      const sr = new SR();
      sr.continuous = true;
      sr.interimResults = false;
      sr.lang = navigator.language || 'en-US';
      sr.onresult = (ev) => {
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          if (ev.results[i].isFinal) r.transcript.push({ t: Math.round(performance.now() - r.start), text: ev.results[i][0].transcript.trim() });
        }
      };
      sr.onend = () => { if (this.rec === r) { try { sr.start(); } catch {} } };
      sr.start();
      r.sr = sr;
    } catch {}
  }

  async stopRecord() {
    const r = this.rec;
    if (!r) return;
    this.rec = null;
    clearInterval(this.recTimer);
    if (r.sr) { try { r.sr.onend = null; r.sr.stop(); } catch {} }
    this.recBtn.classList.remove('recording');
    this.recTime.textContent = '';
    await new Promise((res) => { r.mr.onstop = res; try { r.mr.stop(); } catch { res(); } });
    r.stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(r.chunks, { type: r.mr.mimeType || r.mime || 'audio/webm' });
    if (!blob.size) return;
    const asset = await putAsset(uid(), blob);
    const n = this.body.recordings.length + 1;
    this.body.recordings.push({ id: r.id, asset, duration: (performance.now() - r.start) / 1000, created: Date.now(), name: `Recording ${n}`, transcript: r.transcript.filter((x) => x.text) });
    this.changed();
    this.renderAudioBar(r.id);
    toast('Recording saved');
  }

  renderAudioBar(selectId) {
    const B = this.audioBar;
    const recs = this.body.recordings;
    B.innerHTML = '';
    if (!recs.length) { B.hidden = true; requestAnimationFrame(() => this.resize()); return; }
    B.hidden = false;
    if (selectId) this.curRec = selectId;
    if (!recs.find((r) => r.id === this.curRec)) this.curRec = recs[recs.length - 1].id;
    const rec = recs.find((r) => r.id === this.curRec);
    const select = h('select', { class: 'rec-select', 'aria-label': 'Recording' }, recs.map((r) => h('option', { value: r.id, selected: r.id === rec.id }, `${r.name} · ${fmtTime(r.duration)}`)));
    select.addEventListener('change', () => { this.stopPlayback(true); this.curRec = select.value; this.renderAudioBar(); });
    this.playBtn = h('button', { class: 'icon-btn play', title: 'Play', 'aria-label': 'Play', html: icons.play, onClick: () => this.togglePlay() });
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
      h('button', { class: 'icon-btn sm', title: 'Place on page (tap the clip to play)', 'aria-label': 'Place on page', html: icons.insert, onClick: () => this.placeRecording(rec) }),
      h('button', { class: 'icon-btn sm', title: 'Transcript', 'aria-label': 'Transcript', html: icons.transcript, onClick: (e) => this.transcriptPanel(e.currentTarget, rec) }),
      h('button', { class: 'icon-btn sm', title: 'Rename recording', 'aria-label': 'Rename recording', html: icons.text, onClick: () => { const n = prompt('Recording name', rec.name); if (n) { rec.name = n; this.changed(); this.renderAudioBar(); } } }),
      h('button', { class: 'icon-btn sm', title: 'Download audio', 'aria-label': 'Download audio', html: icons.download, onClick: async () => { const b = await getAssetBlob(rec.asset); if (b) saveFile(b, `${safeName(rec.name)}.${(b.type.split('/')[1] || 'webm').split(';')[0]}`); } }),
      h('button', { class: 'icon-btn sm', title: 'Delete recording', 'aria-label': 'Delete recording', html: icons.trash, onClick: () => this.deleteRecording(rec) }),
      h('button', { class: 'icon-btn sm', title: 'Exit replay', 'aria-label': 'Exit replay', html: icons.close, onClick: () => this.stopPlayback(true) }));
    requestAnimationFrame(() => this.resize());
  }

  transcriptPanel(anchor, rec) {
    const lines = rec.transcript || [];
    popover(anchor, h('div', { class: 'transcript-pop' },
      h('h4', {}, 'Transcript'),
      lines.length ? h('div', { class: 'tr-list' }, lines.map((l) => h('button', { class: 'tr-line', onClick: () => { this.seekTo(l.t); if (this.player && this.player.paused) this.togglePlay(); } }, h('span', { class: 'tr-t' }, fmtTime(l.t / 1000)), l.text)))
        : h('p', { class: 'muted small' }, 'No transcript for this recording. Live captions are made while recording in browsers with speech recognition (Safari, Chrome, Edge).'),
      lines.length ? h('button', { class: 'btn block', onClick: () => { closePopover(); this.insertTextBox(lines.map((l) => l.text).join(' ')); } }, 'Insert transcript as text') : null), { className: 'wide' });
  }

  async ensurePlayer() {
    const rec = this.body.recordings.find((r) => r.id === this.curRec);
    if (!rec) return null;
    if (this.player && this.player.__rec === rec.id) return this.player;
    if (this.player) this.player.pause();
    const url = await assetURL(rec.asset);
    if (!url) { toast('Audio is still downloading…'); return null; }
    const a = new Audio(url);
    a.__rec = rec.id;
    a.preload = 'auto';
    a.playbackRate = this.speed || 1;
    a.onloadedmetadata = () => { if (!rec.duration && Number.isFinite(a.duration)) { rec.duration = a.duration; this.changed(); } };
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
    try { await a.play(); } catch { toast('Could not play audio'); return; }
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
    if (!a) return;
    ms = clamp(ms, 0, rec.duration * 1000);
    try { a.currentTime = ms / 1000; } catch {}
    this.updatePlayback(ms, !this.playback);
  }

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
    if (this.player) this.player.pause();
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
    for (const o of this.lay) {
      const n = o.page.items.length;
      o.page.items = o.page.items.filter((it) => !(it.type === 'audio' && it.rec === rec.id));
      if (o.page.items.length !== n) this.markDirty(o.page);
    }
    this.clearSelection();
    this.changed();
    this.renderAudioBar();
  }

  // ------------------------------------------------------------- save -----

  changed() { this.dirty = true; this.save(); }

  // Saving never runs while the pen is on the glass (keeps writing smooth).
  async persist() {
    if (this.pointers.size || this.live || this.erase || this.drag) { this.save(); return; }
    if (this.saving) { this.save(); return; }
    this.saving = true;
    try {
      this.dirty = false;
      await saveNote(this.meta, this.body);
      this.baseIds = bodyIds(this.body);
      if (performance.now() - this.lastThumb > 20000) {
        this.lastThumb = performance.now();
        await new Promise((r) => (window.requestIdleCallback ? requestIdleCallback(r, { timeout: 2000 }) : setTimeout(r, 200)));
        this.meta.thumb = await makeThumb(this.body);
        await db.put('notes', this.meta);
      }
    } catch (e) {
      console.error(e);
      toast('Could not save: ' + (e.message || e));
    } finally { this.saving = false; }
  }

  // Called by the sync engine right before it syncs, so nothing unsaved is missed.
  async flushSave() {
    if (!this.dirty || this.pointers.size || this.live || this.erase || this.drag) return;
    this.save.cancel();
    await this.persist();
  }

  isBusy() { return this.dirty || this.saving || this.pointers.size > 0 || !!this.textEdit || !!this.rec; }

  renderSyncPill(st) {
    const P = this.syncPill;
    if (!P) return;
    const offline = !navigator.onLine || st.state === 'offline';
    const view = offline ? ['cloudOff', 'Offline · saved on this device', 'off']
      : st.state === 'syncing' ? ['sync', 'Syncing…', 'busy']
      : st.state === 'synced' ? ['cloud', 'Synced', 'ok']
      : st.state === 'error' ? ['cloudOff', 'Sync paused · saved on this device', 'off'] : null;
    P.hidden = !view;
    if (!view) return;
    P.className = 'sync-pill ' + view[2];
    P.title = view[1];
    P.innerHTML = icons[view[0]];
    P.append(h('span', {}, offline ? 'Offline' : view[2] === 'busy' ? 'Syncing' : view[2] === 'ok' ? 'Synced' : 'Paused'));
  }

  // Another device changed this note. Its changes are merged into what is on
  // screen (nothing you wrote, even offline, is thrown away).
  applyRemote(meta, body) {
    if (this.pointers.size || this.live || this.erase || this.drag || this.textEdit || this.saving) {
      clearTimeout(this.remoteT);
      this.remoteT = setTimeout(() => this.reloadFromDB(), 1200);
      return false;
    }
    const merged = mergeBodies(this.body, body, this.baseIds, this.dirty);
    const titleFocused = document.activeElement === this.titleInput;
    const { thumb, ...rest } = meta;
    Object.assign(this.meta, rest);
    if (!titleFocused) this.titleInput.value = this.meta.title;
    this.body.pages.length = 0;
    this.body.pages.push(...merged.pages);
    this.body.recordings = merged.recordings;
    this.body.zc = merged.zc;
    this.baseIds = bodyIds(body);
    this.undoStack.length = this.redoStack.length = 0;
    this.clearSelection();
    for (const c of this.caches.values()) c.canvas.width = c.canvas.height = 0;
    this.caches.clear();
    this.layoutPages();
    this.clampCam();
    this.updateUndo();
    this.renderAudioBar();
    if (!this.pagesPanel.hidden) this.renderPagesPanel();
    this.requestRender();
    if (this.dirty) this.changed();
    toast('Synced changes from another device');
    return true;
  }

  async reloadFromDB() {
    const meta = await db.get('notes', this.meta.id);
    const body = await db.get('bodies', this.meta.id);
    if (meta && body && this.el.isConnected) this.applyRemote(meta, body);
  }

  async exit() {
    this.commitText();
    if (this.rec) await this.stopRecord();
    this.stopPlayback(true);
    this.save.cancel();
    this.lastThumb = 0;
    this.pointers.clear();
    this.live = null;
    await this.persist();
    this.destroy();
    this.onExit();
  }

  destroy() {
    clearTimeout(this.remoteT);
    clearInterval(this.timerTick);
    if (activeEditor === this) activeEditor = null;
    if (this.quizBar) this.quizBar.remove();
    if (this.unsubSync) this.unsubSync();
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('paste', this.onPaste);
    window.removeEventListener('inknote-font', this.onFont);
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

Object.assign(Editor.prototype, toolboxMethods);

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

// Duration of an audio file in seconds (0 if the browser can't tell).
function audioDuration(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const a = new Audio();
    const done = (v) => { clearTimeout(t); URL.revokeObjectURL(url); resolve(Number.isFinite(v) ? v : 0); };
    const t = setTimeout(() => done(0), 5000);
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(a.duration);
    a.onerror = () => done(0);
    a.src = url;
  });
}

// Pictures inside copied web / app content (data: URLs or downloadable links).
async function imagesFromHTML(html) {
  let doc;
  try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch { return []; }
  const out = [];
  for (const img of [...doc.images].slice(0, 12)) {
    const src = img.getAttribute('src') || '';
    try {
      if (src.startsWith('data:image/')) out.push(await (await fetch(src)).blob());
      else if (/^https?:|^blob:/.test(src)) {
        const res = await fetch(src, { mode: 'cors' });
        const b = res.ok ? await res.blob() : null;
        if (b && b.type.startsWith('image/')) out.push(b);
      }
    } catch {}
  }
  return out;
}
