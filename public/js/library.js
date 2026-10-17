// Library: Notability-style sidebar (notes, folders, recently deleted) and a
// home screen with quick actions, templates and recent notes.
import { h, uid, timeAgo, toast, pickFile } from './util.js';
import { icons } from './icons.js';
import { db } from './db.js';
import { settings, saveSettings, applyTheme } from './settings.js';
import {
  createNote, trashNote, restoreNote, deleteForever, purgeTrash, duplicateNote, exportNoteFile, exportBackup,
  importFile, pdfToPages, imagesToPages, exportNotePDF, touchMeta, saveSubject, deleteSubject, newPage, defaultTitle,
} from './notes.js';
import { menu, popover, promptDialog, confirmDialog, progressDialog, closePopover, sheet } from './ui.js';
import { SIZES } from './templates.js';
import { templateGallery, templateCard } from './gallery.js';
import { account, onStatus, signIn, signUp, signOut, updateName, deleteAccount, syncNow, getStatus, signInGoogle, serverConfig } from './sync.js';

const NOTE_TABS = ['all', 'recent', 'fav', 'unfiled'];
// "13 Oct, 2026"
const fmtDay = (t) => { const d = new Date(t); return `${d.getDate()} ${d.toLocaleDateString('en-GB', { month: 'short' }).slice(0, 3)}, ${d.getFullYear()}`; };
const FOLDER_COLORS = ['#e5484d', '#f76b15', '#f5b400', '#30a46c', '#0090ff', '#6e56cf', '#d6409f', '#7c8088'];
const REPO = 'https://github.com/ahilgalib/inknote';
export const APP_VERSION = '2026.10.11 (9)';

export class Library {
  constructor({ openNote }) {
    this.openNote = openNote;
    this.view = localStorage.getItem('inknote.view') || 'home';
    this.query = '';
    this.selecting = false;
    this.picked = new Set();
    this.el = h('div', { class: 'library' });
    this.onRemote = () => this.refresh();
    this.onAcct = () => this.render();
    window.addEventListener('inknote-remote-change', this.onRemote);
    window.addEventListener('inknote-account', this.onAcct);
  }

  async mount(parent) {
    parent.append(this.el);
    purgeTrash().catch(() => {});
    await this.refresh();
    this.unsub = onStatus(() => this.renderSync());
  }

  destroy() {
    window.removeEventListener('inknote-remote-change', this.onRemote);
    window.removeEventListener('inknote-account', this.onAcct);
    this.unsub && this.unsub();
    this.el.remove();
  }

  async refresh() {
    const all = await db.all('notes');
    this.notes = all.filter((n) => !n.trashed);
    this.trash = all.filter((n) => n.trashed);
    this.folders = (await db.all('subjects')).sort((a, b) => (a.order || 0) - (b.order || 0));
    if (this.view.startsWith('folder:') && !this.folders.find((f) => 'folder:' + f.id === this.view)) this.view = 'home';
    this.render();
  }

  go(view) {
    this.view = view;
    this.query = '';
    this.selecting = false;
    this.picked = new Set();
    try { localStorage.setItem('inknote.view', view); } catch {}
    this.el.classList.remove('side-open');
    this.render();
  }

  render() {
    const E = this.el;
    E.innerHTML = '';
    E.append(this.renderSide(), this.renderMain());
    this.renderSync();
  }

  // ---------------------------------------------------------------- sidebar --

  renderSide() {
    const search = h('input', { class: 'search', type: 'search', placeholder: 'Search', value: this.query, 'aria-label': 'Search notes' });
    search.addEventListener('input', () => {
      this.query = search.value;
      if (this.query && !NOTE_TABS.includes(this.view) && !this.view.startsWith('folder:')) { this.view = 'all'; this.renderMainOnly(); search.focus(); }
      else this.renderGrid();
    });
    const nav = (icon, label, on, onClick, count) => h('button', { class: 'nav-item' + (on ? ' on' : ''), onClick },
      h('span', { class: 'nav-ico', html: icons[icon] }), h('span', { class: 'label' }, label), count != null ? h('span', { class: 'count' }, String(count)) : null);
    const folderRows = this.folders.map((f) => h('button', {
      class: 'nav-item folder' + (this.view === 'folder:' + f.id ? ' on' : ''), onClick: () => this.go('folder:' + f.id),
      onContextmenu: (e) => { e.preventDefault(); this.folderMenu(e.currentTarget, f); },
    }, h('span', { class: 'fdot', style: { background: f.color } }), h('span', { class: 'label' }, f.name),
    h('span', { class: 'side-more', html: icons.more, onClick: (e) => { e.stopPropagation(); this.folderMenu(e.currentTarget, f); } })));

    this.syncCard = h('div', { class: 'sync-card' });
    return h('nav', { class: 'lib-side' },
      h('div', { class: 'side-top' },
        h('button', { class: 'icon-btn gear', title: 'Settings', 'aria-label': 'Settings', html: icons.nGear, onClick: () => this.settingsSheet() })),
      h('label', { class: 'side-search' }, h('span', { html: icons.search }), search),
      h('div', { class: 'side-scroll' },
        h('div', { class: 'nav' },
          nav('nHome', 'Home', this.view === 'home', () => this.go('home')),
          nav('nNotes', 'Notes', NOTE_TABS.includes(this.view), () => this.go('all'), this.notes.length),
          nav('nGallery', 'Gallery', false, () => this.fromTemplate())),
        h('div', { class: 'side-h' }, h('span', {}, 'Folders'),
          h('button', { class: 'icon-btn sm', title: 'New folder', 'aria-label': 'New folder', html: icons.plus, onClick: () => this.newFolder() })),
        folderRows.length ? folderRows : h('button', { class: 'folder-empty', onClick: () => this.newFolder() }, 'Organize notes into folders.'),
        h('div', { class: 'nav bottom' },
          nav('trash', 'Recently Deleted', this.view === 'trash', () => this.go('trash'), this.trash.length || null))),
      this.syncCard);
  }

  renderSync() {
    const C = this.syncCard;
    if (!C) return;
    const st = getStatus();
    const a = account();
    C.innerHTML = '';
    if (!a) {
      C.append(h('b', {}, 'Sync across devices'),
        h('p', {}, 'Your notes are saved on this device. Sign in to back them up and sync with your iPad, phone and computer.'),
        h('button', { class: 'btn primary block', onClick: () => this.settingsSheet('account') }, 'Sign in / Create account'));
      return;
    }
    const label = { syncing: 'Syncing…', synced: 'Synced · ' + timeAgo(st.last || Date.now()), offline: 'Offline — saved on this device', error: 'Sync paused — will retry', idle: 'Waiting to sync' }[st.state] || 'Synced';
    C.append(h('div', { class: 'row' },
      h('span', { class: 'sync-ico ' + st.state, html: st.state === 'offline' || st.state === 'error' ? icons.cloudOff : icons.cloud }),
      h('div', { class: 'grow sync-text' }, h('b', {}, a.user.name || a.user.email), h('small', {}, label)),
      h('button', { class: 'icon-btn sm', title: 'Sync now', 'aria-label': 'Sync now', html: icons.sync, onClick: () => syncNow() })));
  }

  // ------------------------------------------------------------------ main --

  renderMainOnly() {
    const old = this.el.querySelector('.lib-main');
    const n = this.renderMain();
    if (old) old.replaceWith(n); else this.el.append(n);
  }

  renderMain() {
    const menuBtn = h('button', { class: 'icon-btn phone-only', 'aria-label': 'Menu', html: icons.menu, onClick: () => this.el.classList.toggle('side-open') });
    const main = h('main', { class: 'lib-main' });
    main.addEventListener('dragover', (e) => e.preventDefault());
    main.addEventListener('drop', (e) => { e.preventDefault(); this.importFiles([...e.dataTransfer.files]); });
    main.append(h('div', { class: 'side-scrim', onClick: () => this.el.classList.remove('side-open') }));
    if (this.view === 'home') {
      const home = this.renderHome();
      main.append(this.topBar(menuBtn), h('div', { class: 'lib-title' }, h('h1', {}, this.homeTitle)), home);
      return main;
    }

    const folder = this.view.startsWith('folder:') ? this.folders.find((f) => 'folder:' + f.id === this.view) : null;
    const tabs = NOTE_TABS.includes(this.view);
    const title = this.view === 'trash' ? 'Recently Deleted' : folder ? folder.name : 'All Notes';
    main.append(this.topBar(menuBtn, this.view === 'trash'
      ? (this.trash.length ? h('button', { class: 'btn', onClick: () => this.emptyTrash() }, 'Empty') : null)
      : this.selecting ? h('button', { class: 'btn primary', onClick: () => { this.selecting = false; this.picked.clear(); this.renderMainOnly(); } }, 'Done') : null),
    h('div', { class: 'lib-title' },
      h('h1', {}, folder ? h('span', { class: 'fdot big', style: { background: folder.color } }) : null, title),
      tabs ? h('div', { class: 'tabs', role: 'tablist' }, [['all', 'All Notes'], ['recent', 'Recents'], ['fav', 'Favorites'], ['unfiled', 'Unfiled']].map(([v, l]) =>
        h('button', { class: 'tab' + (this.view === v ? ' on' : ''), role: 'tab', onClick: () => this.go(v) }, l))) : null));
    if (this.view === 'trash') main.append(h('p', { class: 'muted pad-x' }, 'Notes stay here for 30 days, then they are deleted for good.'));
    this.grid = h('div', { class: 'grid' + (settings.libView === 'list' ? ' list' : '') + (this.selecting ? ' selecting' : '') });
    main.append(h('div', { class: 'grid-wrap' }, this.grid));
    if (this.selecting) {
      this.pickBar = h('div', { class: 'pick-bar' });
      main.append(this.pickBar);
      this.renderPickBar();
    }
    this.renderGrid();
    return main;
  }

  // bell · more · + New, top right (like Notability)
  topBar(menuBtn, extra) {
    return h('header', { class: 'lib-top' }, menuBtn, h('div', { class: 'grow' }), extra,
      h('button', { class: 'icon-btn top-ico', title: 'Sync & account', 'aria-label': 'Sync & account', html: icons.nBell, onClick: (e) => this.statusPop(e.currentTarget) }),
      h('button', { class: 'icon-btn top-ico', title: 'More', 'aria-label': 'More', html: icons.nMore, onClick: (e) => this.viewMenu(e.currentTarget) }),
      h('button', { class: 'new-btn', onClick: (e) => this.newMenu(e.currentTarget) }, h('span', { html: icons.plus }), 'New'));
  }

  statusPop(anchor) {
    const C = h('div', { class: 'sync-card pop' });
    const keep = this.syncCard;
    this.syncCard = C; this.renderSync(); this.syncCard = keep;
    popover(anchor, C, { className: 'wide' });
  }

  viewMenu(anchor) {
    const list = settings.libView === 'list';
    menu(anchor, [
      this.view === 'trash' || this.view === 'home' ? null : { label: 'Select notes', icon: 'check2', onClick: () => { this.selecting = true; this.picked.clear(); this.renderMainOnly(); } },
      { label: list ? 'Grid view' : 'List view', icon: list ? 'grid' : 'list', onClick: () => { settings.libView = list ? 'grid' : 'list'; saveSettings(); this.renderMainOnly(); } },
      { label: 'Sort…', icon: 'menu', onClick: () => this.sortMenu(anchor) },
      '-',
      { label: 'Import…', icon: 'download', onClick: () => this.importMenu(anchor) },
      { label: 'Settings', icon: 'settings', onClick: () => this.settingsSheet() },
    ]);
  }

  renderHome() {
    const hour = new Date().getHours();
    const hello = hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const quick = (icon, label, onClick, cls = '') => h('button', { class: 'quick ' + cls, onClick }, h('span', { class: 'quick-ico', html: icons[icon] }), h('span', {}, label));
    const tplRow = h('div', { class: 'tpl-row' });
    const recent = [...this.notes].sort((a, b) => (b.opened || b.updated) - (a.opened || a.updated)).slice(0, 8);
    const home = h('div', { class: 'home' },
      h('div', { class: 'quick-row' },
        quick('plus', 'New note', () => this.create(), 'primary'),
        quick('nTemplate', 'Templates', () => this.fromTemplate()),
        quick('upload', 'Import or scan', (e) => this.importMenu(e.currentTarget)),
        quick('nMic', 'Record lecture', () => this.create({ record: true }))),
      h('section', { class: 'home-sec' },
        h('div', { class: 'sec-head' }, h('h2', {}, 'Recent'), h('div', { class: 'grow' }),
          recent.length ? h('button', { class: 'link-btn', onClick: () => this.go('all') }, 'All notes ›') : null),
        recent.length ? h('div', { class: 'grid' }, recent.map((n) => this.noteCard(n)))
          : h('button', { class: 'home-empty', onClick: () => this.create() }, h('span', { html: icons.nPen }), h('b', {}, 'Your notes will appear here'), h('small', {}, 'Tap to start your first note'))),
      h('section', { class: 'home-sec' },
        h('div', { class: 'sec-head' }, h('h2', {}, 'Templates'), h('div', { class: 'grow' }),
          h('button', { class: 'link-btn', onClick: () => this.fromTemplate() }, 'See all ›')),
        tplRow));
    this.homeTitle = hello;
    // template previews render progressively so the home screen appears instantly
    const ids = ['assignment', 'dailyGoals', 'plannerDark', 'flashcard', 'weekly', 'lecture', 'cornell'];
    let i = 0;
    const step = () => {
      if (i >= ids.length || !tplRow.isConnected && i > 0) return;
      const id = ids[i++];
      tplRow.append(templateCard(id, () => this.fromTemplate(id), 200));
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    return h('div', { class: 'grid-wrap' }, home);
  }

  visibleNotes() {
    const q = this.query.trim().toLowerCase();
    let list = this.view === 'trash' ? this.trash : this.notes;
    if (this.view.startsWith('folder:')) list = list.filter((n) => 'folder:' + n.subjectId === this.view);
    if (this.view === 'fav') list = list.filter((n) => n.starred);
    if (this.view === 'unfiled') list = list.filter((n) => !n.subjectId || !this.folders.some((f) => f.id === n.subjectId));
    if (this.view === 'recent') list = [...list].filter((n) => n.opened).sort((a, b) => b.opened - a.opened).slice(0, 30);
    if (q) list = list.filter((n) => (n.title + ' ' + (n.text || '')).toLowerCase().includes(q));
    const sort = settings.sort;
    if (this.view === 'recent') return list;
    return [...list].sort((a, b) => this.view === 'trash' ? b.trashed - a.trashed : sort === 'title' ? a.title.localeCompare(b.title) : sort === 'created' ? b.created - a.created : b.updated - a.updated);
  }

  renderGrid() {
    const G = this.grid;
    if (!G) return;
    G.innerHTML = '';
    const list = this.visibleNotes();
    if (!list.length) {
      G.append(h('div', { class: 'empty' },
        h('div', { class: 'empty-art', html: this.view === 'trash' ? icons.trash : icons.pen }),
        h('h2', {}, this.query ? 'No matching notes' : this.view === 'trash' ? 'Nothing here' : this.view === 'fav' ? 'No favorites yet' : 'No notes yet'),
        h('p', { class: 'muted' }, this.query ? 'Try another word.' : this.view === 'trash' ? 'Deleted notes appear here for 30 days.' : 'Create a note, start from a template, or import a PDF.'),
        this.query || this.view === 'trash' ? null : h('div', { class: 'row center' },
          h('button', { class: 'btn primary', onClick: () => this.create() }, 'New note'),
          h('button', { class: 'btn', onClick: () => this.fromTemplate() }, 'Templates'),
          h('button', { class: 'btn', onClick: () => this.importPDF() }, 'Import PDF'))));
      return;
    }
    for (const n of list) G.append(this.noteCard(n));
  }

  renderPickBar() {
    const B = this.pickBar;
    if (!B) return;
    B.innerHTML = '';
    const ids = [...this.picked], list = this.notes.filter((n) => this.picked.has(n.id));
    const act = (icon, label, fn, cls = '') => h('button', { class: 'pick-act ' + cls, disabled: !ids.length, onClick: fn }, h('span', { html: icons[icon] }), h('small', {}, label));
    const done = () => { this.selecting = false; this.picked.clear(); this.refresh(); };
    B.append(h('b', { class: 'pick-count' }, ids.length ? `${ids.length} selected` : 'Tap notes to select'),
      act('starOn', 'Favorite', async () => { const on = !list.every((n) => n.starred); for (const n of list) { if (on) n.starred = true; else delete n.starred; await touchMeta(n); } done(); }),
      act('folder', 'Move', (e) => menu(e.currentTarget, [
        { label: 'No folder', onClick: async () => { for (const n of list) { n.subjectId = null; await touchMeta(n); } done(); } },
        ...this.folders.map((f) => ({ label: f.name, onClick: async () => { for (const n of list) { n.subjectId = f.id; await touchMeta(n); } done(); } })),
      ])),
      act('duplicate', 'Duplicate', async () => { for (const n of list) await duplicateNote(n); done(); }),
      act('trash', 'Delete', async () => { for (const n of list) await trashNote(n); toast(`Moved ${list.length} to Recently Deleted`); done(); }, 'danger'),
      h('button', { class: 'link-btn', onClick: () => { const all = this.visibleNotes(); if (this.picked.size === all.length) this.picked.clear(); else all.forEach((n) => this.picked.add(n.id)); this.renderGrid(); this.renderPickBar(); } }, 'All'));
  }

  noteCard(n) {
    const folder = this.folders.find((s) => s.id === n.subjectId);
    const trashed = !!n.trashed;
    const open = () => {
      if (this.selecting && !trashed) {
        if (this.picked.has(n.id)) this.picked.delete(n.id); else this.picked.add(n.id);
        card.classList.toggle('picked', this.picked.has(n.id));
        this.renderPickBar();
        return;
      }
      trashed ? this.trashMenu(card, n) : this.openNote(n.id);
    };
    const card = h('div', { class: 'card' + (this.picked.has(n.id) ? ' picked' : '') },
      h('button', { class: 'card-open', onClick: open, 'aria-label': 'Open ' + n.title },
        this.selecting ? h('span', { class: 'pick-mark', html: icons.check }) : null,
        h('div', { class: 'thumb' }, n.thumb ? h('img', { src: n.thumb, alt: '', loading: 'lazy' }) : h('div', { class: 'thumb-blank' }))),
      h('div', { class: 'card-meta' },
        h('div', { class: 'card-text' },
          h('div', { class: 'card-title' }, n.starred ? h('span', { class: 'star', html: icons.starOn }) : null, n.locked ? h('span', { class: 'star', html: icons.lock }) : null, n.title),
          h('div', { class: 'card-sub' }, trashed ? `Deleted ${timeAgo(n.trashed)}` : fmtDay(n.updated))),
        folder ? h('span', { class: 'fchip', style: '--fc:' + folder.color }, folder.name) : null,
        h('button', { class: 'icon-btn sm card-more', title: 'Note options', 'aria-label': 'Note options', html: icons.more, onClick: (e) => { e.stopPropagation(); trashed ? this.trashMenu(e.currentTarget, n) : this.noteMenu(e.currentTarget, n); } })));
    let lp;
    card.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') lp = setTimeout(() => { lp = 'fired'; trashed ? this.trashMenu(card, n) : this.noteMenu(card, n); }, 550); });
    card.addEventListener('pointerup', () => clearTimeout(lp));
    card.addEventListener('pointercancel', () => clearTimeout(lp));
    card.addEventListener('click', (e) => { if (lp === 'fired') { e.stopPropagation(); e.preventDefault(); lp = null; } }, true);
    card.addEventListener('contextmenu', (e) => { e.preventDefault(); trashed ? this.trashMenu(card, n) : this.noteMenu(card, n); });
    return card;
  }

  // ---- actions ----

  currentFolderId() { return this.view.startsWith('folder:') ? this.view.slice(7) : null; }

  async create({ record = false, pages } = {}) {
    const meta = await createNote({ subjectId: this.currentFolderId(), title: defaultTitle(), pages });
    if (record) sessionStorage.setItem('inknote.autorec', meta.id);
    this.openNote(meta.id);
  }

  fromTemplate(open) {
    templateGallery({
      open,
      onPick: (st) => {
        const sz = SIZES[st.size];
        const pages = Array.from({ length: st.count }, () => newPage({ w: sz.w, h: sz.h, template: st.template, color: st.color, tpl: st.tpl }));
        this.create({ pages });
      },
    });
  }

  newMenu(anchor) {
    menu(anchor, [
      { label: 'New note', icon: 'pen', onClick: () => this.create() },
      { label: 'New note from template…', icon: 'template', onClick: () => this.fromTemplate() },
      { label: 'New note & start recording', icon: 'mic', onClick: () => this.create({ record: true }) },
      '-',
      { label: 'Import PDF to annotate', icon: 'pdf', onClick: () => this.importPDF() },
      { label: 'Import images as pages', icon: 'image', onClick: () => this.importImages() },
      { label: 'Scan document', icon: 'scan', onClick: () => this.scan() },
      { label: 'Import note / backup file', icon: 'upload', onClick: () => this.importNote() },
    ]);
  }

  importMenu(anchor) {
    menu(anchor, [
      { label: 'PDF (annotate it)', icon: 'pdf', onClick: () => this.importPDF() },
      { label: 'Images / photos as pages', icon: 'image', onClick: () => this.importImages() },
      { label: 'Scan document with camera', icon: 'scan', onClick: () => this.scan() },
      { label: 'Inknote note or backup (.json)', icon: 'upload', onClick: () => this.importNote() },
    ]);
  }

  async importPDF(file) {
    if (!file) [file] = await pickFile('application/pdf,.pdf');
    if (!file) return;
    const pd = progressDialog('Importing PDF…');
    try {
      const pages = await pdfToPages(file, (i, n) => pd.set(i / n, `Page ${i} of ${n}`));
      const meta = await createNote({ title: file.name.replace(/\.pdf$/i, ''), subjectId: this.currentFolderId(), pages });
      pd.close();
      this.openNote(meta.id);
    } catch (e) { pd.close(); toast(e.message || 'Could not import PDF', 4000); }
  }

  async importImages(files) {
    if (!files) files = await pickFile('image/*', true);
    if (!files.length) return;
    const pd = progressDialog('Importing images…');
    try {
      const pages = await imagesToPages(files);
      const meta = await createNote({ title: files[0].name.replace(/\.[^.]+$/, ''), subjectId: this.currentFolderId(), pages });
      pd.close();
      this.openNote(meta.id);
    } catch (e) { pd.close(); toast(e.message || 'Could not import images'); }
  }

  scan() {
    const input = h('input', { type: 'file', accept: 'image/*', capture: 'environment', multiple: true, style: { display: 'none' } });
    input.addEventListener('change', async () => {
      const files = [...input.files];
      input.remove();
      if (!files.length) return;
      const pd = progressDialog('Scanning…');
      try {
        const pages = await imagesToPages(files, { scan: true });
        const meta = await createNote({ title: 'Scan ' + new Date().toLocaleDateString(), subjectId: this.currentFolderId(), pages });
        pd.close();
        this.openNote(meta.id);
      } catch (e) { pd.close(); toast(e.message || 'Could not scan'); }
    });
    document.body.append(input);
    input.click();
  }

  async importNote() { this.importFiles(await pickFile('.json,application/json', true)); }

  async importFiles(files) {
    let n = 0;
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    if (imgs.length) { await this.importImages(imgs); return; }
    for (const f of files) {
      try {
        if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') { await this.importPDF(f); return; }
        n += await importFile(f);
      } catch (e) { toast(`${f.name}: ${e.message}`, 4000); }
    }
    if (n) { toast(`Imported ${n} note${n > 1 ? 's' : ''}`); this.refresh(); }
  }

  sortMenu(anchor) {
    const set = (v) => { settings.sort = v; saveSettings(); this.renderGrid(); };
    menu(anchor, [
      { label: 'Last edited', checked: settings.sort === 'updated', onClick: () => set('updated') },
      { label: 'Date created', checked: settings.sort === 'created', onClick: () => set('created') },
      { label: 'Title', checked: settings.sort === 'title', onClick: () => set('title') },
    ]);
  }

  noteMenu(anchor, n) {
    menu(anchor, [
      { label: 'Open', icon: 'pen', onClick: () => this.openNote(n.id) },
      { label: 'Rename', icon: 'text', onClick: async () => {
        const t = await promptDialog('Rename note', n.title);
        if (t) { n.title = t; await touchMeta(n); this.render(); }
      } },
      { label: n.starred ? 'Remove from Favorites' : 'Add to Favorites', icon: 'star', onClick: async () => { n.starred = !n.starred || undefined; if (!n.starred) delete n.starred; await touchMeta(n); this.render(); } },
      { label: 'Move to folder…', icon: 'folder', onClick: () => this.moveMenu(anchor, n) },
      { label: 'Duplicate', icon: 'duplicate', onClick: async () => { await duplicateNote(n); this.refresh(); } },
      { label: 'Export PDF', icon: 'pdf', onClick: async () => {
        const body = await db.get('bodies', n.id);
        const pd = progressDialog('Exporting PDF…');
        try { await exportNotePDF(n, body, (f) => pd.set(f)); } catch (e) { toast(e.message); }
        pd.close();
      } },
      { label: 'Export note file', icon: 'download', onClick: () => exportNoteFile(n) },
      '-',
      { label: 'Delete', icon: 'trash', danger: true, onClick: async () => { await trashNote(n); toast('Moved to Recently Deleted'); this.refresh(); } },
    ]);
  }

  trashMenu(anchor, n) {
    menu(anchor, [
      { label: 'Restore', icon: 'restore', onClick: async () => { await restoreNote(n); toast('Restored'); this.refresh(); } },
      { label: 'Delete forever', icon: 'trash', danger: true, onClick: async () => {
        if (await confirmDialog(`Delete “${n.title}” forever?`, 'This cannot be undone, on any device.')) { await deleteForever(n.id); this.refresh(); }
      } },
    ]);
  }

  async emptyTrash() {
    if (!(await confirmDialog('Empty Recently Deleted?', `${this.trash.length} note(s) will be deleted forever on every device.`))) return;
    for (const n of this.trash) await deleteForever(n.id);
    this.refresh();
  }

  moveMenu(anchor, n) {
    const move = async (id) => { n.subjectId = id; await touchMeta(n); this.render(); };
    menu(anchor, [
      { label: 'No folder', checked: !n.subjectId, onClick: () => move(null) },
      ...this.folders.map((s) => ({ label: s.name, checked: n.subjectId === s.id, onClick: () => move(s.id) })),
      '-',
      { label: 'New folder…', icon: 'plus', onClick: async () => { const s = await this.newFolder(); if (s) move(s.id); } },
    ]);
  }

  async newFolder() {
    const name = await promptDialog('New folder', '', { placeholder: 'e.g. Biology', ok: 'Create' });
    if (!name) return null;
    const s = { id: uid(), name, color: FOLDER_COLORS[this.folders.length % FOLDER_COLORS.length], order: Date.now() };
    await saveSubject(s);
    await this.refresh();
    return s;
  }

  folderMenu(anchor, s) {
    const colors = h('div', { class: 'row wrap', style: { padding: '6px 10px' } }, FOLDER_COLORS.map((c) => h('button', {
      class: 'swatch' + (s.color === c ? ' on' : ''), style: { background: c }, 'aria-label': 'Colour',
      onClick: async () => { s.color = c; await saveSubject(s); closePopover(); this.render(); },
    })));
    popover(anchor, h('div', { class: 'menu' },
      h('button', { class: 'menu-item', onClick: async () => {
        closePopover();
        const name = await promptDialog('Rename folder', s.name);
        if (name) { s.name = name; await saveSubject(s); this.render(); }
      } }, h('span', { class: 'mi-icon', html: icons.text }), h('span', {}, 'Rename')),
      colors,
      h('div', { class: 'menu-sep' }),
      h('button', { class: 'menu-item danger', onClick: async () => {
        closePopover();
        if (!(await confirmDialog(`Delete folder “${s.name}”?`, 'Notes inside are kept.'))) return;
        for (const n of this.notes) if (n.subjectId === s.id) { n.subjectId = null; await touchMeta(n); }
        await deleteSubject(s);
        this.refresh();
      } }, h('span', { class: 'mi-icon', html: icons.trash }), h('span', {}, 'Delete folder'))));
  }

  // ---------------------------------------------------------------- settings --

  settingsSheet(start = 'account') {
    let tab = start;
    const nav = h('nav', { class: 'set-nav' });
    const pane = h('div', { class: 'set-pane' });
    const S = sheet(h('div', { class: 'settings-wrap' }, nav, pane), { className: 'settings-sheet' });
    const tabs = [['account', 'Account'], ['writing', 'Writing & Pencil'], ['appearance', 'Appearance'], ['backup', 'Backup & data'], ['trash', 'Recently Deleted'], ['help', 'Help']];
    const show = (t) => {
      tab = t;
      nav.innerHTML = '';
      tabs.forEach(([k, l]) => nav.append(h('button', { class: 'set-tab' + (k === tab ? ' on' : ''), onClick: () => k === 'trash' ? (S.close(), this.go('trash')) : show(k) }, l)));
      pane.innerHTML = '';
      pane.append(h('div', { class: 'set-head' }, h('h2', {}, tabs.find((x) => x[0] === t)[1]), h('div', { class: 'grow' }), h('button', { class: 'icon-btn', 'aria-label': 'Close', html: icons.close, onClick: () => S.close() })));
      pane.append(this['set_' + t](() => show(t), S));
    };
    show(tab);
  }

  set_account(again) {
    const a = account();
    if (!a) {
      let mode = 'in';
      const box = h('div', { class: 'set-body auth' });
      const gSlot = h('div', { class: 'google-slot' });
      const google = h('div', { class: 'google-wrap', hidden: true }, gSlot, h('div', { class: 'auth-or' }, h('span', {}, 'or use email')));
      this.mountGoogleButton(gSlot, google, () => { toast('Signed in with Google — syncing your notes'); again(); });
      const draw = () => {
        box.innerHTML = '';
        const email = h('input', { class: 'input', type: 'email', placeholder: 'Email address', autocomplete: 'email', inputmode: 'email' });
        const pass = h('input', { class: 'input', type: 'password', placeholder: mode === 'in' ? 'Password' : 'Choose a password (8+ characters)', autocomplete: mode === 'in' ? 'current-password' : 'new-password' });
        const name = h('input', { class: 'input', placeholder: 'Your name (optional)', autocomplete: 'name' });
        const err = h('p', { class: 'err' });
        const go = async () => {
          err.textContent = '';
          if (!email.value.trim()) { err.textContent = 'Enter your email address'; email.focus(); return; }
          if (pass.value.length < (mode === 'in' ? 1 : 8)) { err.textContent = mode === 'in' ? 'Enter your password' : 'Password needs at least 8 characters'; pass.focus(); return; }
          btn.disabled = true;
          btn.textContent = mode === 'in' ? 'Signing in…' : 'Creating account…';
          try {
            if (mode === 'in') await signIn(email.value, pass.value);
            else await signUp(email.value, pass.value, name.value);
            toast('Signed in — syncing your notes');
            again();
            return;
          } catch (e) { err.textContent = e.message; }
          btn.disabled = false;
          btn.textContent = mode === 'in' ? 'Sign in' : 'Create account';
        };
        for (const i of [email, pass, name]) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
        const btn = h('button', { class: 'btn primary block big', onClick: go }, mode === 'in' ? 'Sign in' : 'Create account');
        const tabs = h('div', { class: 'seg auth-tabs' },
          h('button', { class: mode === 'in' ? 'on' : '', onClick: () => { mode = 'in'; draw(); } }, 'Sign in'),
          h('button', { class: mode === 'up' ? 'on' : '', onClick: () => { mode = 'up'; draw(); } }, 'Create account'));
        const fields = [email, pass];
        if (mode === 'up') fields.unshift(name);
        box.append(
          h('div', { class: 'auth-hero' }, h('span', { class: 'auth-ico', html: icons.cloud }),
            h('h3', {}, mode === 'in' ? 'Welcome back' : 'Create your free account'),
            h('p', { class: 'muted' }, 'Sync notes between your iPad, phone and computer. Everything keeps working offline and syncs when you are back online.')),
          google,
          tabs, ...fields, err, btn,
          h('p', { class: 'muted small center' }, 'Your notes stay on this device too — signing in only adds sync & backup.'));
      };
      draw();
      return box;
    }
    const st = getStatus();
    const nameRow = h('div', { class: 'set-card row' }, h('span', { class: 'grow' }, a.user.name || '—'),
      h('button', { class: 'link-btn', onClick: async () => { const n = await promptDialog('Preferred name', a.user.name); if (n) { try { await updateName(n); again(); } catch (e) { toast(e.message); } } } }, 'Edit'));
    const faq = (q, ans) => { const d = h('details', { class: 'set-card faq' }, h('summary', {}, q), h('p', { class: 'muted' }, ans)); return d; };
    return h('div', { class: 'set-body' },
      h('div', { class: 'acct-banner pattern' }),
      h('div', { class: 'set-card' }, h('div', { class: 'row' }, h('b', { class: 'grow' }, a.user.email), a.user.google ? h('span', { class: 'chip' }, 'Google') : null),
        h('button', { class: 'link-btn', onClick: async () => {
          await signOut();
          toast('Signed out — your notes stay on this device');
          again();
        } }, 'Log out')),
      h('h4', {}, 'Preferred name'), nameRow,
      h('h4', {}, 'Sync'),
      h('div', { class: 'set-card row' }, h('span', { class: 'grow' }, st.state === 'synced' ? 'Up to date · ' + timeAgo(st.last) : st.state === 'offline' ? 'Offline — will sync when you are back online' : st.state === 'syncing' ? 'Syncing…' : st.error || 'Waiting'),
        h('button', { class: 'link-btn', onClick: async () => { await syncNow(); again(); } }, 'Sync now')),
      h('h4', {}, 'FAQ'),
      faq('How do I sync notes across devices?', 'Sign in with the same email on every device (iPad, phone, computer). Notes, folders, images, PDFs and recordings sync automatically in the background.'),
      faq('Does it work offline?', 'Yes. Everything is saved on the device first. When you reconnect, changes upload and download by themselves.'),
      faq('What if I edit the same note on two devices?', 'Both sets of changes are kept: when the devices sync, the edits are merged, even if one of them was offline.'),
      h('button', { class: 'link-btn danger', onClick: async () => {
        const pw = await promptDialog('Delete account', '', { placeholder: a.user.google ? 'Type DELETE to confirm' : 'Enter your password to confirm', ok: 'Delete everything' });
        if (!pw) return;
        try { await deleteAccount(pw); toast('Account deleted. Notes remain on this device.'); again(); } catch (e) { toast(e.message); }
      } }, 'Delete account & cloud data'));
  }

  // "Continue with Google" — shown when the server has a Google client id.
  async mountGoogleButton(slot, wrap, done) {
    const cfg = await serverConfig();
    if (!cfg.googleClientId) return;
    try {
      await loadScript('https://accounts.google.com/gsi/client');
      const g = window.google && window.google.accounts && window.google.accounts.id;
      if (!g) return;
      g.initialize({
        client_id: cfg.googleClientId,
        ux_mode: 'popup',
        callback: async (r) => {
          try { await signInGoogle(r.credential); done(); } catch (e) { toast(e.message, 4000); }
        },
      });
      wrap.hidden = false;
      slot.innerHTML = '';
      const w = Math.min(400, Math.max(220, slot.getBoundingClientRect().width || 320));
      g.renderButton(slot, { theme: document.documentElement.dataset.theme === 'dark' ? 'filled_black' : 'outline', size: 'large', shape: 'pill', text: 'continue_with', width: w, logo_alignment: 'center' });
    } catch { wrap.hidden = true; }
  }

  set_writing() {
    const seg = (key, opts) => h('div', { class: 'seg' }, opts.map(([v, label]) => h('button', {
      class: settings[key] === v ? 'on' : '',
      onClick: (e) => { settings[key] = v; saveSettings(); [...e.currentTarget.parentNode.children].forEach((b) => b.classList.toggle('on', b === e.currentTarget)); },
    }, label)));
    const toggle = (key, label, hint) => {
      const cb = h('input', { type: 'checkbox', checked: settings[key] });
      cb.addEventListener('change', () => { settings[key] = cb.checked; saveSettings(); });
      return h('label', { class: 'toggle' }, h('span', {}, h('b', {}, label), hint ? h('small', {}, hint) : null), cb);
    };
    return h('div', { class: 'set-body' },
      h('h4', {}, 'Draw with finger'),
      seg('fingerDraw', [['auto', 'Auto'], ['on', 'On'], ['off', 'Off']]),
      h('p', { class: 'muted small' }, 'Auto: fingers draw until an Apple Pencil or stylus is used — then fingers only scroll and zoom (palm rejection).'),
      toggle('pressure', 'Pressure sensitivity', 'Line width follows Apple Pencil pressure'),
      toggle('shapeHold', 'Draw & hold for shapes', 'Hold at the end of a stroke to snap to a line, circle, rectangle…'),
      toggle('eraserAutoDeselect', 'Eraser returns to previous tool', 'After erasing you are back on the pen automatically'),
      toggle('twoFingerUndo', 'Gestures', '2-finger tap undo · 3-finger tap redo · 3-finger swipe down copy/paste · 4-finger tap full screen'),
      toggle('autoAddPage', 'Add pages automatically', 'A new page appears when you write near the bottom of the last one'));
  }

  set_appearance() {
    const seg = h('div', { class: 'seg' }, [['light', 'Light'], ['dark', 'Dark'], ['system', 'Match device']].map(([v, l]) => h('button', {
      class: settings.theme === v ? 'on' : '',
      onClick: (e) => { settings.theme = v; saveSettings(); applyTheme(); [...e.currentTarget.parentNode.children].forEach((b) => b.classList.toggle('on', b === e.currentTarget)); },
    }, l)));
    return h('div', { class: 'set-body' }, h('h4', {}, 'Theme'), seg,
      h('p', { class: 'muted small' }, 'Install Inknote like an app: on iPad/iPhone tap Share → Add to Home Screen; on a computer use the install button in the address bar.'));
  }

  set_backup() {
    return h('div', { class: 'set-body' },
      h('p', { class: 'muted' }, 'A backup file contains every note, folder, image, PDF and recording. Keep one somewhere safe, or use it to move notes without an account.'),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn', onClick: () => exportBackup() }, h('span', { html: icons.download }), 'Export backup'),
        h('button', { class: 'btn', onClick: () => this.importNote() }, h('span', { html: icons.upload }), 'Import backup')),
      h('h4', {}, 'Storage'), (() => {
        const p = h('p', { class: 'muted small' }, 'Checking…');
        if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then((e) => { p.textContent = `Using ${(e.usage / 1048576).toFixed(1)} MB on this device.`; });
        else p.textContent = '';
        return p;
      })());
  }

  set_help() {
    return h('div', { class: 'set-body' },
      h('p', {}, 'Inknote is free and open source.'),
      h('p', { class: 'muted small' }, 'Version ' + APP_VERSION),
      h('table', { class: 'help-table' }, [
        ['Two-finger tap', 'Undo'], ['Two-finger hold', 'Rapid undo'], ['Three-finger tap', 'Redo'], ['Three-finger swipe down', 'Copy & paste menu'],
        ['Four-finger tap', 'Full screen'], ['Quick pinch in', 'Fit page'], ['Draw & hold', 'Perfect shape'], ['Tap a tool again', 'More options'],
      ].map(([a, b]) => h('tr', {}, h('td', {}, a), h('td', {}, b)))),
      h('a', { class: 'btn', href: REPO, target: '_blank', rel: 'noopener' }, h('span', { html: icons.github }), 'Source code & issues on GitHub'));
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const sc = document.createElement('script');
    sc.src = src; sc.async = true;
    sc.onload = () => resolve();
    sc.onerror = () => { sc.remove(); reject(new Error('offline')); };
    document.head.append(sc);
  });
}
