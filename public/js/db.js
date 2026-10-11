// IndexedDB storage. The device copy is always the source of truth for the
// UI; the sync engine copies changes to and from the cloud in the background.
//   notes      – lightweight metadata for the library (title, folder, thumb…)
//   bodies     – the heavy part of a note (pages, items, recordings)
//   subjects   – folders
//   assets     – binary blobs (images, PDF page renders, audio, fonts)
//   tombstones – deletions waiting to be synced
//   bases      – ids each note had at its last sync (for merging offline edits)

const DB_NAME = 'inknote';
const VERSION = 2;
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of ['notes', 'bodies', 'subjects', 'assets', 'tombstones', 'bases']) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // another tab opened a newer version: let it upgrade, reopen next time
      db.onversionchange = () => { db.close(); dbp = null; };
      resolve(db);
    };
    req.onerror = () => { dbp = null; reject(req.error); };
    req.onblocked = () => console.warn('Inknote: close other tabs to finish updating storage');
  });
  return dbp;
}

function wrap(req) {
  return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
}

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export const db = {
  async all(name) { return wrap((await store(name)).getAll()); },
  async get(name, id) { return wrap((await store(name)).get(id)); },
  async put(name, value) { return wrap((await store(name, 'readwrite')).put(value)); },
  async del(name, id) { return wrap((await store(name, 'readwrite')).delete(id)); },
  async keys(name) { return wrap((await store(name)).getAllKeys()); },
  async clear(name) { return wrap((await store(name, 'readwrite')).clear()); },
};

// Ask the browser not to evict our data (important on iOS Safari).
export async function requestPersistence() {
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch {}
}

// ---- assets -------------------------------------------------------------

const urlCache = new Map();
let remoteFetch = null;
export function setRemoteAssetFetcher(fn) { remoteFetch = fn; }

export async function putAsset(id, blob) {
  await db.put('assets', { id, blob, type: blob.type, size: blob.size });
  return id;
}

export async function getAssetBlob(id) {
  const a = await db.get('assets', id);
  if (a) return a.blob;
  if (remoteFetch) {
    const blob = await remoteFetch(id).catch(() => null);
    if (blob) { await putAsset(id, blob); return blob; }
  }
  return null;
}

export async function assetURL(id) {
  if (urlCache.has(id)) return urlCache.get(id);
  const blob = await getAssetBlob(id);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urlCache.set(id, url);
  return url;
}

export function noteAssetIds(body) {
  const ids = new Set();
  for (const p of body.pages || []) {
    if (p.bg) ids.add(p.bg);
    for (const it of p.items || []) if (it.asset) ids.add(it.asset);
  }
  for (const r of body.recordings || []) ids.add(r.asset);
  return ids;
}

// Remove assets no longer referenced by any note (fonts are kept).
export async function collectGarbage() {
  const bodies = await db.all('bodies');
  const used = new Set();
  for (const b of bodies) noteAssetIds(b).forEach((i) => used.add(i));
  for (const id of await db.keys('assets')) if (!used.has(id) && !String(id).startsWith('font_')) await db.del('assets', id);
}
