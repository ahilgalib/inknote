// Note model: create, save, duplicate, import/export, backup.
import { db, putAsset, getAssetBlob, collectGarbage } from './db.js';
import { uid, blobToDataURL, dataURLToBlob, saveFile, safeName } from './util.js';
import { SIZES } from './templates.js';
import { settings } from './settings.js';
import { renderPageCanvas } from './render.js';
import { buildPDF, importPDF } from './pdf.js';

export function newPage(opts = {}) {
  const size = SIZES[opts.size || settings.defaultSize] || SIZES.letter;
  return {
    id: uid(),
    w: opts.w || size.w,
    h: opts.h || size.h,
    template: opts.template ?? settings.defaultTemplate,
    color: opts.color ?? settings.defaultColor,
    bg: opts.bg || null,
    items: [],
  };
}

export async function createNote({ title, subjectId = null, pages } = {}) {
  const id = uid();
  const now = Date.now();
  const meta = {
    id, title: title || 'Untitled note', subjectId,
    created: now, updated: now, opened: now,
    thumb: null, pageCount: 1, text: '',
  };
  const body = { id, pages: pages || [newPage()], recordings: [], zc: 0 };
  meta.pageCount = body.pages.length;
  await db.put('bodies', body);
  await db.put('notes', meta);
  return meta;
}

export async function saveNote(meta, body) {
  meta.updated = Date.now();
  meta.pageCount = body.pages.length;
  meta.text = body.pages.flatMap((p) => p.items.filter((i) => i.type === 'text').map((i) => i.text)).join(' ').slice(0, 4000);
  await db.put('bodies', body);
  await db.put('notes', meta);
}

export async function makeThumb(body) {
  const page = body.pages[0];
  if (!page) return null;
  const c = await renderPageCanvas(page, 260 / page.w);
  const url = c.toDataURL('image/jpeg', 0.72);
  c.width = c.height = 0;
  return url;
}

export async function deleteNote(id) {
  await db.del('notes', id);
  await db.del('bodies', id);
  collectGarbage().catch(() => {});
}

export async function duplicateNote(meta) {
  const body = await db.get('bodies', meta.id);
  const id = uid();
  const copy = structuredClone(body);
  copy.id = id;
  for (const p of copy.pages) p.id = uid();
  const m = { ...meta, id, title: meta.title + ' copy', created: Date.now(), updated: Date.now() };
  await db.put('bodies', copy);
  await db.put('notes', m);
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

// ---- note files & backup ---------------------------------------------------

function assetIds(body) {
  const ids = new Set();
  for (const p of body.pages) {
    if (p.bg) ids.add(p.bg);
    for (const it of p.items) if (it.asset) ids.add(it.asset);
  }
  for (const r of body.recordings || []) ids.add(r.asset);
  return ids;
}

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
    const existing = await db.get('assets', id);
    if (!existing) await putAsset(id, await dataURLToBlob(url));
  }
}

export async function exportNoteFile(meta) {
  const body = await db.get('bodies', meta.id);
  const data = { format: 'inkwell-note', version: 1, meta: { ...meta, thumb: null }, body, assets: await packAssets(assetIds(body)) };
  await saveFile(new Blob([JSON.stringify(data)], { type: 'application/json' }), safeName(meta.title) + '.inkwell.json');
}

export async function exportBackup() {
  const metas = await db.all('notes');
  const subjects = await db.all('subjects');
  const notes = [];
  const ids = new Set();
  for (const m of metas) {
    const body = await db.get('bodies', m.id);
    if (!body) continue;
    assetIds(body).forEach((i) => ids.add(i));
    notes.push({ meta: m, body });
  }
  const data = { format: 'inkwell-backup', version: 1, created: Date.now(), subjects, notes, assets: await packAssets(ids) };
  const stamp = new Date().toISOString().slice(0, 10);
  await saveFile(new Blob([JSON.stringify(data)], { type: 'application/json' }), `inkwell-backup-${stamp}.json`);
}

// Import a note file or a full backup. Returns number of notes imported.
export async function importFile(file) {
  const data = JSON.parse(await file.text());
  if (data.format === 'inkwell-note') {
    await unpackAssets(data.assets);
    const id = uid();
    await db.put('bodies', { ...data.body, id });
    await db.put('notes', { ...data.meta, id, subjectId: null, updated: Date.now() });
    return 1;
  }
  if (data.format === 'inkwell-backup') {
    await unpackAssets(data.assets);
    for (const s of data.subjects || []) if (!(await db.get('subjects', s.id))) await db.put('subjects', s);
    let n = 0;
    for (const { meta, body } of data.notes) {
      const existing = await db.get('notes', meta.id);
      if (existing && existing.updated >= meta.updated) continue;
      await db.put('bodies', body);
      await db.put('notes', meta);
      n++;
    }
    return n;
  }
  throw new Error('Not an Inkwell file');
}
