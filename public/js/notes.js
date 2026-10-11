// Note model: create, save, trash, duplicate, import/export, backup.
import { db, putAsset, getAssetBlob, collectGarbage, noteAssetIds } from './db.js';
import { uid, blobToDataURL, dataURLToBlob, saveFile, safeName } from './util.js';
import { SIZES, plannerById, plannerPaperColor } from './templates.js';
import { settings } from './settings.js';
import { renderPageCanvas } from './render.js';
import { buildPDF, importPDF } from './pdf.js';

const TRASH_DAYS = 30;

// Tell the sync engine something changed locally.
export function localChanged() { window.dispatchEvent(new Event('inknote-local-change')); }

export function newPage(opts = {}) {
  const size = SIZES[opts.size || settings.defaultSize] || SIZES.letter;
  const template = opts.template ?? settings.defaultTemplate;
  return {
    id: uid(),
    w: opts.w || size.w,
    h: opts.h || size.h,
    template,
    color: opts.color ?? (plannerById(template) ? plannerPaperColor(template) : settings.defaultColor),
    tpl: opts.tpl ? { ...opts.tpl } : undefined,
    bg: opts.bg || null,
    items: [],
  };
}

export function defaultTitle() {
  const d = new Date();
  return 'Note ' + d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export async function createNote({ title, subjectId = null, pages } = {}) {
  const id = uid();
  const now = Date.now();
  const meta = { id, title: title || defaultTitle(), subjectId, created: now, updated: now, bodyRev: now, opened: now, thumb: null, pageCount: 1, text: '' };
  const body = { id, pages: pages || [newPage()], recordings: [], zc: 0 };
  meta.pageCount = body.pages.length;
  await db.put('bodies', body);
  await db.put('notes', meta);
  localChanged();
  return meta;
}

export async function saveNote(meta, body) {
  meta.updated = Date.now();
  meta.bodyRev = meta.updated;
  meta.pageCount = body.pages.length;
  meta.text = body.pages.flatMap((p) => p.items.filter((i) => i.type === 'text').map((i) => i.text)).join(' ').slice(0, 4000);
  await db.put('bodies', body);
  await db.put('notes', meta);
  localChanged();
}

// Metadata-only change (rename, move, trash…).
export async function touchMeta(meta) {
  meta.updated = Date.now();
  await db.put('notes', meta);
  localChanged();
}

export async function makeThumb(body) {
  const page = body.pages[0];
  if (!page) return null;
  const c = await renderPageCanvas(page, 300 / page.w);
  const url = c.toDataURL('image/jpeg', 0.75);
  c.width = c.height = 0;
  return url;
}

// ---- trash (Recently Deleted) ----------------------------------------------

export async function trashNote(meta) { meta.trashed = Date.now(); await touchMeta(meta); }
export async function restoreNote(meta) { delete meta.trashed; await touchMeta(meta); }

export async function deleteForever(id) {
  await db.del('notes', id);
  await db.del('bodies', id);
  await db.put('tombstones', { id: 'note:' + id, kind: 'note', itemId: id, updated: Date.now() });
  localChanged();
  collectGarbage().catch(() => {});
}

export async function purgeTrash() {
  const cutoff = Date.now() - TRASH_DAYS * 864e5;
  for (const n of await db.all('notes')) if (n.trashed && n.trashed < cutoff) await deleteForever(n.id);
}

export async function deleteSubject(s) {
  await db.del('subjects', s.id);
  await db.put('tombstones', { id: 'subject:' + s.id, kind: 'subject', itemId: s.id, updated: Date.now() });
  localChanged();
}

export async function saveSubject(s) {
  s.updated = Date.now();
  await db.put('subjects', s);
  localChanged();
}

export async function duplicateNote(meta) {
  const body = await db.get('bodies', meta.id);
  const id = uid();
  const copy = structuredClone(body);
  copy.id = id;
  for (const p of copy.pages) p.id = uid();
  const now = Date.now();
  const m = { ...meta, id, title: meta.title + ' copy', created: now, updated: now, bodyRev: now };
  delete m.syncedUpdated; delete m.syncedBodyRev; delete m.trashed;
  await db.put('bodies', copy);
  await db.put('notes', m);
  localChanged();
  return m;
}

// ---- PDF -------------------------------------------------------------------

export async function exportNotePDF(meta, body, onProgress) {
  const pages = [];
  for (let i = 0; i < body.pages.length; i++) {
    const p = body.pages[i];
    const scale = Math.min(2.2, 2000 / Math.max(p.w, p.h));
    const c = await renderPageCanvas(p, scale);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    pages.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), iw: c.width, ih: c.height, w: p.w * 0.75, h: p.h * 0.75 });
    c.width = c.height = 0;
    onProgress && onProgress((i + 1) / body.pages.length);
  }
  await saveFile(buildPDF(pages), safeName(meta.title) + '.pdf');
}

export async function pdfToPages(file, onProgress) {
  const rendered = await importPDF(file, onProgress);
  const pages = [];
  for (const r of rendered) {
    const asset = await putAsset(uid(), r.blob);
    pages.push(newPage({ w: r.w, h: r.h, template: 'blank', color: '#ffffff', bg: asset }));
  }
  return pages;
}

// Images as pages (photos of a whiteboard, scans…)
export async function imagesToPages(files) {
  const pages = [];
  for (const f of files) {
    const bmp = await createImageBitmap(f).catch(() => null);
    if (!bmp) continue;
    const k = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
    const w = 816, h = Math.round(816 * bmp.height / bmp.width);
    pages.push(newPage({ w, h, template: 'blank', color: '#ffffff', bg: await putAsset(uid(), blob) }));
  }
  return pages;
}

// ---- note files & backup ---------------------------------------------------

async function packAssets(ids) {
  const out = {};
  for (const id of ids) {
    const b = await getAssetBlob(id);
    if (b) out[id] = await blobToDataURL(b);
  }
  return out;
}

async function unpackAssets(assets) {
  for (const [id, url] of Object.entries(assets || {})) {
    if (!(await db.get('assets', id))) await putAsset(id, await dataURLToBlob(url));
  }
}

export async function exportNoteFile(meta) {
  const body = await db.get('bodies', meta.id);
  const data = { format: 'inknote-note', version: 1, meta: { ...meta, thumb: null }, body, assets: await packAssets(noteAssetIds(body)) };
  await saveFile(new Blob([JSON.stringify(data)], { type: 'application/json' }), safeName(meta.title) + '.inknote.json');
}

export async function exportBackup() {
  const metas = await db.all('notes');
  const subjects = await db.all('subjects');
  const notes = [];
  const ids = new Set();
  for (const m of metas) {
    const body = await db.get('bodies', m.id);
    if (!body) continue;
    noteAssetIds(body).forEach((i) => ids.add(i));
    notes.push({ meta: m, body });
  }
  const data = { format: 'inknote-backup', version: 1, created: Date.now(), subjects, notes, assets: await packAssets(ids) };
  const stamp = new Date().toISOString().slice(0, 10);
  await saveFile(new Blob([JSON.stringify(data)], { type: 'application/json' }), `inknote-backup-${stamp}.json`);
}

// Import a note file or a full backup (also accepts files from the old "Inkwell" name).
export async function importFile(file) {
  const data = JSON.parse(await file.text());
  const fmt = String(data.format || '').replace('inkwell', 'inknote');
  if (fmt === 'inknote-note') {
    await unpackAssets(data.assets);
    const id = uid();
    const now = Date.now();
    await db.put('bodies', { ...data.body, id });
    await db.put('notes', { ...data.meta, id, subjectId: null, updated: now, bodyRev: now, syncedUpdated: undefined });
    localChanged();
    return 1;
  }
  if (fmt === 'inknote-backup') {
    await unpackAssets(data.assets);
    for (const s of data.subjects || []) if (!(await db.get('subjects', s.id))) await db.put('subjects', { ...s, updated: Date.now() });
    let n = 0;
    for (const { meta, body } of data.notes) {
      const existing = await db.get('notes', meta.id);
      if (existing && existing.updated >= meta.updated) continue;
      await db.put('bodies', body);
      await db.put('notes', { ...meta, bodyRev: meta.bodyRev || meta.updated, syncedUpdated: undefined });
      n++;
    }
    localChanged();
    return n;
  }
  throw new Error('Not an Inknote file');
}
