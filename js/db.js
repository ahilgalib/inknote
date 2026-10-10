// IndexedDB storage. Everything lives on the device; nothing is uploaded.
//   notes    – lightweight metadata for the library (title, subject, thumb…)
//   bodies   – the heavy part of a note (pages, items, recordings)
//   subjects – folders
//   assets   – binary blobs (images, PDF page renders, audio)

const DB_NAME = 'inkwell';
const VERSION = 1;
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('bodies')) db.createObjectStore('bodies', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('subjects')) db.createObjectStore('subjects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
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
};

// Ask the browser not to evict our data (important on iOS Safari).
export async function requestPersistence() {
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch {}
}

// ---- assets -------------------------------------------------------------

const urlCache = new Map();

export async function putAsset(id, blob) {
  await db.put('assets', { id, blob, type: blob.type, size: blob.size });
  return id;
}

export async function getAssetBlob(id) {
  const a = await db.get('assets', id);
  return a ? a.blob : null;
}

export async function assetURL(id) {
  if (urlCache.has(id)) return urlCache.get(id);
  const blob = await getAssetBlob(id);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urlCache.set(id, url);
  return url;
}

// Remove assets no longer referenced by any note.
export async function collectGarbage() {
  const bodies = await db.all('bodies');
  const used = new Set();
  for (const b of bodies) {
    for (const p of b.pages || []) {
      if (p.bg) used.add(p.bg);
      for (const it of p.items || []) if (it.asset) used.add(it.asset);
    }
    for (const r of b.recordings || []) used.add(r.asset);
  }
  for (const id of await db.keys('assets')) if (!used.has(id)) await db.del('assets', id);
}
