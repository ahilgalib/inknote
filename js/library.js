// Library: subjects (folders) + note grid, search, sort, import/export.
import { h, uid, timeAgo, toast, pickFile } from './util.js';
import { icons } from './icons.js';
import { db } from './db.js';
import { settings, saveSettings, applyTheme } from './settings.js';
import { createNote, deleteNote, duplicateNote, exportNoteFile, exportBackup, importFile, pdfToPages, exportNotePDF } from './notes.js';
import { menu, popover, promptDialog, confirmDialog, progressDialog, closePopover } from './ui.js';

const SUBJECT_COLORS = ['#e5484d', '#f76b15', '#f5b400', '#30a46c', '#0090ff', '#6e56cf', '#d6409f', '#7c8088'];
const REPO = 'https://github.com/ahilgalib/inkwell';

export class Library {
  constructor({ openNote }) {
    this.openNote = openNote;
    this.filter = localStorage.getItem('inkwell.filter') || 'all';
    this.query = '';
    this.el = h('div', { class: 'library' });
  }

  async mount(parent) {
    parent.append(this.el);
    await this.refresh();
  }

  destroy() { this.el.remove(); }

  async refresh() {
    this.notes = await db.all('notes');
    this.subjects = (await db.all('subjects')).sort((a, b) => (a.order || 0) - (b.order || 0));
    if (this.filter !== 'all' && this.filter !== 'none' && !this.subjects.find((s) => s.id === this.filter)) this.filter = 'all';
    this.render();
  }

  setFilter(f) {
    this.filter = f;
    try { localStorage.setItem('inkwell.filter', f); } catch {}
    this.render();
  }

  render() {
    const E = this.el;
    const scrollTop = this.gridWrap ? this.gridWrap.scrollTop : 0;
    E.innerHTML = '';
    const count = (id) => this.notes.filter((n) => (id === 'all' ? true : id === 'none' ? !n.subjectId : n.subjectId === id)).length;

    const subjItem = (id, label, color, extra) => h('button', {
      class: 'subj' + (this.filter === id ? ' on' : ''),
      onClick: () => this.setFilter(id),
      onContextmenu: extra ? (e) => { e.preventDefault(); extra(e.currentTarget); } : null,
    },
    color ? h('span', { class: 'dot', style: { background: color } }) : h('span', { class: 'si', html: id === 'all' ? icons.notes : icons.folder }),
    h('span', { class: 'label' }, label),
    h('span', { class: 'count' }, String(count(id))),
    extra ? h('span', { class: 'subj-more', html: icons.more, onClick: (e) => { e.stopPropagation(); extra(e.currentTarget); } }) : null);

    const side = h('nav', { class: 'lib-side' },
      h('div', { class: 'brand' }, h('img', { src: 'icons/icon.svg', alt: '' }), h('span', {}, 'Inkwell')),
      subjItem('all', 'All notes'),
      subjItem('none', 'Unfiled'),
      h('div', { class: 'side-h' }, h('span', {}, 'Subjects'),
        h('button', { class: 'icon-btn sm', title: 'New subject', 'aria-label': 'New subject', html: icons.plus, onClick: () => this.newSubject() })),
      this.subjects.map((s) => subjItem(s.id, s.name, s.color, (anchor) => this.subjectMenu(anchor, s))),
      h('div', { class: 'grow' }),
      h('button', { class: 'subj', onClick: () => this.settingsDialog() }, h('span', { class: 'si', html: icons.settings }), h('span', { class: 'label' }, 'Settings & backup')));

    // phone: subjects as chips
    const chips = h('div', { class: 'lib-chips' },
      [['all', 'All'], ['none', 'Unfiled'], ...this.subjects.map((s) => [s.id, s.name, s.color])].map(([id, label, color]) =>
        h('button', { class: 'chip' + (this.filter === id ? ' on' : ''), onClick: () => this.setFilter(id) },
          color ? h('span', { class: 'dot', style: { background: color } }) : null, label)),
      h('button', { class: 'chip', onClick: () => this.newSubject() }, '+ Subject'));

    const search = h('input', { class: 'search', type: 'search', placeholder: 'Search notes', value: this.query, 'aria-label': 'Search notes' });
    search.addEventListener('input', () => { this.query = search.value; this.renderGrid(); });

    const title = this.filter === 'all' ? 'All notes' : this.filter === 'none' ? 'Unfiled' : (this.subjects.find((s) => s.id === this.filter) || {}).name;
    const head = h('header', { class: 'lib-head' },
      h('button', { class: 'icon-btn phone-only', title: 'Settings', 'aria-label': 'Settings', html: icons.settings, onClick: () => this.settingsDialog() }),
      h('h1', {}, title),
      h('div', { class: 'grow' }),
      h('div', { class: 'search-wrap' }, h('span', { html: icons.search }), search),
      h('button', { class: 'icon-btn', title: 'Sort', 'aria-label': 'Sort', html: icons.menu, onClick: (e) => this.sortMenu(e.currentTarget) }),
      h('button', { class: 'btn primary new-btn', onClick: (e) => this.newMenu(e.currentTarget) }, h('span', { html: icons.plus }), h('span', { class: 'hide-xs' }, 'New')));

    this.grid = h('div', { class: 'grid' });
    this.gridWrap = h('div', { class: 'grid-wrap' }, this.grid);
    const main = h('main', { class: 'lib-main' }, head, chips, this.gridWrap);
    E.append(side, main);
    this.renderGrid();
    this.gridWrap.scrollTop = scrollTop;

    // drag & drop files on desktop
    main.addEventListener('dragover', (e) => e.preventDefault());
    main.addEventListener('drop', (e) => { e.preventDefault(); this.importFiles([...e.dataTransfer.files]); });
  }

  visibleNotes() {
    const q = this.query.trim().toLowerCase();
    let list = this.notes.filter((n) => this.filter === 'all' ? true : this.filter === 'none' ? !n.subjectId : n.subjectId === this.filter);
    if (q) list = list.filter((n) => (n.title + ' ' + (n.text || '')).toLowerCase().includes(q));
    const sort = settings.sort;
    list.sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title) : sort === 'created' ? b.created - a.created : b.updated - a.updated);
    return list;
  }

  renderGrid() {
    const G = this.grid;
    G.innerHTML = '';
    const list = this.visibleNotes();
    if (!list.length) {
      G.append(h('div', { class: 'empty' },
        h('div', { class: 'empty-art', html: icons.pen }),
        h('h2', {}, this.query ? 'No matching notes' : 'No notes yet'),
        h('p', { class: 'muted' }, this.query ? 'Try another word.' : 'Create a note, or import a PDF to annotate.'),
        this.query ? null : h('div', { class: 'row center' },
          h('button', { class: 'btn primary', onClick: () => this.create() }, 'New note'),
          h('button', { class: 'btn', onClick: () => this.importPDF() }, 'Import PDF'))));
      return;
    }
    for (const n of list) {
      const subj = this.subjects.find((s) => s.id === n.subjectId);
      const card = h('div', { class: 'card' },
        h('button', { class: 'card-open', onClick: () => this.openNote(n.id), 'aria-label': 'Open ' + n.title },
          h('div', { class: 'thumb' }, n.thumb ? h('img', { src: n.thumb, alt: '', loading: 'lazy' }) : h('div', { class: 'thumb-blank' }))),
        h('div', { class: 'card-meta' },
          h('div', { class: 'card-text' },
            h('div', { class: 'card-title' }, n.title),
            h('div', { class: 'card-sub' },
              subj ? h('span', { class: 'dot', style: { background: subj.color } }) : null,
              `${timeAgo(n.updated)} · ${n.pageCount || 1} p`)),
          h('button', { class: 'icon-btn sm', title: 'Note options', 'aria-label': 'Note options', html: icons.more, onClick: (e) => this.noteMenu(e.currentTarget, n) })));
      // long-press on touch opens the menu too
      let lp;
      card.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') lp = setTimeout(() => { lp = 'fired'; this.noteMenu(card, n); }, 550); });
      card.addEventListener('pointerup', () => clearTimeout(lp));
      card.addEventListener('pointercancel', () => clearTimeout(lp));
      card.addEventListener('click', (e) => { if (lp === 'fired') { e.stopPropagation(); e.preventDefault(); lp = null; } }, true);
      card.addEventListener('contextmenu', (e) => { e.preventDefault(); this.noteMenu(card, n); });
      G.append(card);
    }
  }

  // ---- actions ----

  currentSubjectId() { return this.filter !== 'all' && this.filter !== 'none' ? this.filter : null; }

  async create() {
    const meta = await createNote({ subjectId: this.currentSubjectId(), title: defaultTitle() });
    this.openNote(meta.id);
  }

  newMenu(anchor) {
    menu(anchor, [
      { label: 'New note', icon: 'pen', onClick: () => this.create() },
      { label: 'Import PDF to annotate', icon: 'pdf', onClick: () => this.importPDF() },
      { label: 'Import note / backup file', icon: 'upload', onClick: () => this.importNote() },
    ]);
  }

  async importPDF(file) {
    if (!file) [file] = await pickFile('application/pdf,.pdf');
    if (!file) return;
    const pd = progressDialog('Importing PDF…');
    try {
      const pages = await pdfToPages(file, (i, n) => pd.set(i / n, `Page ${i} of ${n}`));
      const meta = await createNote({ title: file.name.replace(/\.pdf$/i, ''), subjectId: this.currentSubjectId(), pages });
      pd.close();
      this.openNote(meta.id);
    } catch (e) { pd.close(); toast(e.message || 'Could not import PDF', 4000); }
  }

  async importNote() {
    const files = await pickFile('.json,application/json', true);
    this.importFiles(files);
  }

  async importFiles(files) {
    let n = 0;
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
        if (t) { n.title = t; await db.put('notes', n); this.render(); }
      } },
      { label: 'Move to subject…', icon: 'folder', onClick: () => this.moveMenu(anchor, n) },
      { label: 'Duplicate', icon: 'duplicate', onClick: async () => { await duplicateNote(n); this.refresh(); } },
      { label: 'Export PDF', icon: 'pdf', onClick: async () => {
        const body = await db.get('bodies', n.id);
        const pd = progressDialog('Exporting PDF…');
        try { await exportNotePDF(n, body, (f) => pd.set(f)); } catch (e) { toast(e.message); }
        pd.close();
      } },
      { label: 'Export note file', icon: 'download', onClick: () => exportNoteFile(n) },
      '-',
      { label: 'Delete', icon: 'trash', danger: true, onClick: async () => {
        if (await confirmDialog(`Delete “${n.title}”?`, 'This cannot be undone.')) { await deleteNote(n.id); this.refresh(); }
      } },
    ]);
  }

  moveMenu(anchor, n) {
    const move = async (id) => { n.subjectId = id; await db.put('notes', n); this.render(); };
    menu(anchor, [
      { label: 'Unfiled', checked: !n.subjectId, onClick: () => move(null) },
      ...this.subjects.map((s) => ({ label: s.name, checked: n.subjectId === s.id, onClick: () => move(s.id) })),
      '-',
      { label: 'New subject…', icon: 'plus', onClick: async () => { const s = await this.newSubject(); if (s) move(s.id); } },
    ]);
  }

  async newSubject() {
    const name = await promptDialog('New subject', '', { placeholder: 'e.g. Biology', ok: 'Create' });
    if (!name) return null;
    const s = { id: uid(), name, color: SUBJECT_COLORS[this.subjects.length % SUBJECT_COLORS.length], order: Date.now() };
    await db.put('subjects', s);
    await this.refresh();
    return s;
  }

  subjectMenu(anchor, s) {
    const colors = h('div', { class: 'row wrap', style: { padding: '6px 10px' } }, SUBJECT_COLORS.map((c) => h('button', {
      class: 'swatch' + (s.color === c ? ' on' : ''), style: { background: c }, 'aria-label': 'Colour',
      onClick: async () => { s.color = c; await db.put('subjects', s); closePopover(); this.render(); },
    })));
    const list = h('div', { class: 'menu' },
      h('button', { class: 'menu-item', onClick: async () => {
        closePopover();
        const name = await promptDialog('Rename subject', s.name);
        if (name) { s.name = name; await db.put('subjects', s); this.render(); }
      } }, h('span', { class: 'mi-icon', html: icons.text }), h('span', {}, 'Rename')),
      colors,
      h('div', { class: 'menu-sep' }),
      h('button', { class: 'menu-item danger', onClick: async () => {
        closePopover();
        if (!(await confirmDialog(`Delete subject “${s.name}”?`, 'Notes inside are kept and become Unfiled.'))) return;
        for (const n of this.notes) if (n.subjectId === s.id) { n.subjectId = null; await db.put('notes', n); }
        await db.del('subjects', s.id);
        this.refresh();
      } }, h('span', { class: 'mi-icon', html: icons.trash }), h('span', {}, 'Delete subject')));
    popover(anchor, list);
  }

  settingsDialog() {
    const seg = (key, opts, after) => h('div', { class: 'seg' }, opts.map(([v, label]) => h('button', {
      class: settings[key] === v ? 'on' : '',
      onClick: (e) => {
        settings[key] = v; saveSettings();
        [...e.currentTarget.parentNode.children].forEach((b) => b.classList.toggle('on', b === e.currentTarget));
        after && after();
      },
    }, label)));
    const toggle = (key, label, hint) => {
      const cb = h('input', { type: 'checkbox', checked: settings[key] });
      cb.addEventListener('change', () => { settings[key] = cb.checked; saveSettings(); });
      return h('label', { class: 'toggle' }, h('span', {}, h('b', {}, label), hint ? h('small', {}, hint) : null), cb);
    };
    const close = () => wrap.remove();
    const box = h('div', { class: 'dialog settings' },
      h('div', { class: 'row' }, h('h3', {}, 'Settings'), h('div', { class: 'grow' }), h('button', { class: 'icon-btn sm', html: icons.close, 'aria-label': 'Close', onClick: close })),
      h('h4', {}, 'Appearance'),
      seg('theme', [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']], applyTheme),
      h('h4', {}, 'Draw with finger'),
      seg('fingerDraw', [['auto', 'Auto'], ['on', 'On'], ['off', 'Off']]),
      h('p', { class: 'muted small' }, 'Auto: fingers draw until an Apple Pencil or stylus is used, then fingers only scroll and zoom (palm rejection).'),
      h('h4', {}, 'Writing'),
      toggle('pressure', 'Pressure sensitivity', 'Line width follows Apple Pencil pressure'),
      toggle('shapeHold', 'Draw & hold for shapes', 'Hold at the end of a stroke to snap it to a line, circle, rectangle…'),
      toggle('twoFingerUndo', 'Two-finger tap to undo', 'Three-finger tap redoes'),
      toggle('autoAddPage', 'Add pages automatically', 'A new page appears when you write near the bottom of the last one'),
      h('h4', {}, 'Backup'),
      h('p', { class: 'muted small' }, 'Notes are stored only on this device, in your browser. Export a backup regularly, and import it on another device to move your notes.'),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn', onClick: () => exportBackup() }, h('span', { html: icons.download }), 'Export backup'),
        h('button', { class: 'btn', onClick: () => { close(); this.importNote(); } }, h('span', { html: icons.upload }), 'Import backup')),
      h('h4', {}, 'About'),
      h('p', { class: 'muted small' }, 'Inkwell is free and open source (MIT). Install it: Share → Add to Home Screen on iPad / iPhone, or the install button in Chrome / Edge.'),
      h('a', { class: 'btn', href: REPO, target: '_blank', rel: 'noopener' }, h('span', { html: icons.github }), 'Source on GitHub'));
    const wrap = h('div', { class: 'dialog-wrap' }, box);
    wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) close(); });
    document.body.append(wrap);
  }
}

function defaultTitle() {
  const d = new Date();
  return 'Note ' + d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
