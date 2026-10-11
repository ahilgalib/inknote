// Cloud sync. Local-first: every change is saved to IndexedDB immediately and
// works offline. When signed in and online, changes are pulled and pushed in
// the background. If a note was edited on two devices (e.g. one was offline),
// the two versions are merged item by item instead of one replacing the
// other. Assets (images, PDF pages, audio) are uploaded once and downloaded
// on demand.
import { db, putAsset, noteAssetIds, setRemoteAssetFetcher } from './db.js';
import { bodyIds, mergeBodies } from './notes.js';

const KEY = 'inknote.account';
const API = '/api';

let acct = load();
let running = null;
let beforeSync = null;
export function setBeforeSync(fn) { beforeSync = fn; }

async function getBase(id) { try { const b = await db.get('bases', id); return b ? new Set(b.ids) : null; } catch { return null; } }
async function setBase(id, ids) { try { await db.put('bases', { id, ids: [...ids] }); } catch {} }
let timer = 0;
let status = { state: 'idle', last: acct ? acct.last || 0 : 0, error: '' };
const listeners = new Set();

function load() { try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; } }
function save() { try { if (acct) localStorage.setItem(KEY, JSON.stringify(acct)); else localStorage.removeItem(KEY); } catch {} }

function setStatus(s) { status = { ...status, ...s }; listeners.forEach((f) => f(status)); }
export function onStatus(fn) { listeners.add(fn); fn(status); return () => listeners.delete(fn); }
export function getStatus() { return status; }
export function account() { return acct; }

async function api(path, { method = 'GET', body, raw, headers = {} } = {}) {
  const h = { ...headers };
  if (acct && acct.token) h.authorization = 'Bearer ' + acct.token;
  let payload = body;
  if (body !== undefined && !raw) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(API + path, { method, headers: h, body: payload, cache: 'no-store' });
  if (res.status === 401 && acct) { acct = null; save(); setStatus({ state: 'signedout' }); window.dispatchEvent(new Event('inknote-account')); }
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch {}
    const e = new Error(msg); e.status = res.status; throw e;
  }
  return res;
}
const apiJSON = async (path, opts) => (await api(path, opts)).json();

// ---- account ---------------------------------------------------------------

export async function signUp(email, password, name) {
  const r = await apiJSON('/signup', { method: 'POST', body: { email, password, name } });
  acct = { token: r.token, user: r.user, cursor: 0, last: 0 };
  save();
  window.dispatchEvent(new Event('inknote-account'));
  syncNow();
  return r.user;
}

export async function signIn(email, password) {
  const r = await apiJSON('/login', { method: 'POST', body: { email, password } });
  acct = { token: r.token, user: r.user, cursor: 0, last: 0 };
  save();
  window.dispatchEvent(new Event('inknote-account'));
  syncNow();
  return r.user;
}

export async function signOut() {
  try { await api('/logout', { method: 'POST' }); } catch {}
  acct = null;
  save();
  setStatus({ state: 'signedout', error: '' });
  window.dispatchEvent(new Event('inknote-account'));
}

export async function updateName(name) {
  const r = await apiJSON('/me', { method: 'PATCH', body: { name } });
  acct.user = r.user; save();
  window.dispatchEvent(new Event('inknote-account'));
}

export async function deleteAccount(password) {
  await apiJSON('/me', { method: 'DELETE', body: { password } });
  acct = null; save();
  window.dispatchEvent(new Event('inknote-account'));
}

// ---- compression -------------------------------------------------------------

async function gzip(str) {
  if (!window.CompressionStream) return new Blob([str], { type: 'application/json' });
  const stream = new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Blob([await new Response(stream).arrayBuffer()], { type: 'application/gzip' });
}
async function gunzipText(buf) {
  const bytes = new Uint8Array(buf);
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return new TextDecoder().decode(bytes);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

// ---- engine ------------------------------------------------------------------

export function scheduleSync(ms = 3000) {
  if (!acct) return;
  clearTimeout(timer);
  timer = setTimeout(syncNow, ms);
}

export function syncNow() {
  if (!acct) { setStatus({ state: 'signedout' }); return Promise.resolve(); }
  if (!navigator.onLine) { setStatus({ state: 'offline' }); return Promise.resolve(); }
  if (running) { running.again = true; return running.p; }
  const r = { again: false };
  r.p = (async () => {
    setStatus({ state: 'syncing', error: '' });
    try {
      if (beforeSync) { try { await beforeSync(); } catch {} }
      // pull first: remote edits get merged into local ones before we push
      let rounds = 0;
      do {
        r.again = false;
        await pull();
        // a refused write means another device changed the note meanwhile: pull & merge again
        if ((await push()) && rounds < 3) r.again = true;
      } while (r.again && ++rounds < 6);
      acct && (acct.last = Date.now(), save());
      setStatus({ state: 'synced', last: Date.now() });
      prefetchAssets();
    } catch (e) {
      console.warn('sync failed', e);
      setStatus({ state: navigator.onLine ? 'error' : 'offline', error: e.message || String(e) });
    } finally { running = null; }
  })();
  running = r;
  return r.p;
}

const serverMeta = (m) => {
  const { syncedUpdated, syncedBodyRev, opened, ...rest } = m;
  return rest;
};

async function push() {
  const items = [];
  const notes = await db.all('notes');
  const dirty = notes.filter((n) => n.updated !== n.syncedUpdated);
  const pushedBodies = new Map();
  for (const n of dirty) {
    const bodyKey = `b_${n.id}_${n.bodyRev || n.updated}`;
    if (n.syncedBodyRev !== (n.bodyRev || n.updated)) {
      const body = await db.get('bodies', n.id);
      if (body) pushedBodies.set(n.id, body);
      if (!body) continue;
      // upload any assets the server doesn't have yet
      const keys = [...noteAssetIds(body)].map((id) => 'a_' + id);
      if (keys.length) {
        const { missing } = await apiJSON('/blobs/missing', { method: 'POST', body: { keys } });
        for (const k of missing) {
          const a = await db.get('assets', k.slice(2));
          if (a) await api('/blob/' + k, { method: 'PUT', body: a.blob, raw: true, headers: { 'content-type': 'application/octet-stream' } });
        }
      }
      const { missing } = await apiJSON('/blobs/missing', { method: 'POST', body: { keys: [bodyKey] } });
      if (missing.length) await api('/blob/' + bodyKey, { method: 'PUT', body: await gzip(JSON.stringify(body)), raw: true, headers: { 'content-type': 'application/octet-stream' } });
    }
    // base: the server version this edit is based on (the server refuses the
    // write if another device changed the note meanwhile; we merge next round)
    items.push({ kind: 'note', id: n.id, updated: n.updated, deleted: 0, data: serverMeta(n), body_key: bodyKey, base: n.syncedUpdated, _n: n });
  }
  for (const s of await db.all('subjects')) {
    if ((s.updated || 1) !== s.syncedUpdated) items.push({ kind: 'subject', id: s.id, updated: s.updated || 1, deleted: 0, data: { name: s.name, color: s.color, order: s.order }, _s: s });
  }
  const tombs = await db.all('tombstones');
  for (const t of tombs) items.push({ kind: t.kind, id: t.itemId, updated: t.updated, deleted: 1, _t: t });
  if (!items.length) return 0;
  let refused = 0;
  for (let i = 0; i < items.length; i += 50) {
    const batch = items.slice(i, i + 50);
    const res = await apiJSON('/items', { method: 'POST', body: { items: batch.map(({ _n, _s, _t, ...x }) => x) } });
    const ok = new Set(res.accepted);
    for (const it of batch) {
      const key = it.kind + ':' + it.id;
      if (it._t) { await db.del('tombstones', it._t.id); continue; }
      if (!ok.has(key)) { if (it._n) refused++; continue; }
      if (it._n) {
        const cur = await db.get('notes', it.id);
        if (cur && cur.updated === it.updated) { cur.syncedUpdated = it.updated; cur.syncedBodyRev = cur.bodyRev || cur.updated; await db.put('notes', cur); }
        if (pushedBodies.has(it.id)) await setBase(it.id, bodyIds(pushedBodies.get(it.id)));
      } else if (it._s) {
        const cur = await db.get('subjects', it.id);
        if (cur && (cur.updated || 1) === it.updated) { cur.syncedUpdated = it.updated; await db.put('subjects', cur); }
      }
    }
  }
  return refused;
}

async function pull() {
  let more = true, changed = false;
  while (more && acct) {
    const res = await apiJSON('/changes?since=' + (acct.cursor || 0));
    for (const it of res.items) {
      if (it.kind === 'subject') {
        const local = await db.get('subjects', it.id);
        if (it.deleted) { if (local) { await db.del('subjects', it.id); changed = true; } continue; }
        if (local && (local.updated || 0) > it.updated && local.syncedUpdated !== local.updated) continue;
        await db.put('subjects', { id: it.id, ...it.data, updated: it.updated, syncedUpdated: it.updated });
        changed = true;
      } else if (it.kind === 'note') {
        const local = await db.get('notes', it.id);
        const localDirty = local && local.updated !== local.syncedUpdated;
        if (it.deleted) {
          if (local && !(localDirty && local.updated > it.updated)) { await db.del('notes', it.id); await db.del('bodies', it.id); changed = true; notifyNote(it.id, true); }
          continue;
        }
        if (local) {
          // our own write coming back, or nothing new
          if (it.updated === local.updated || it.updated === local.syncedUpdated) continue;
          if (!localDirty && local.updated > it.updated) continue;
        }
        const bodyRev = it.data.bodyRev || it.updated;
        let remoteBody = null;
        if (!local || (local.bodyRev || local.updated) !== bodyRev || !(await db.get('bodies', it.id))) {
          const buf = await (await api('/blob/' + it.body_key)).arrayBuffer();
          remoteBody = JSON.parse(await gunzipText(buf));
          remoteBody.id = it.id;
        }
        if (localDirty) {
          // edited here (maybe offline) and on another device: merge both
          const localBody = await db.get('bodies', it.id);
          const now = Date.now();
          const remoteNewer = it.updated > local.updated;
          const meta = remoteNewer ? { ...it.data, id: it.id, opened: local.opened, thumb: local.thumb || it.data.thumb } : { ...local };
          meta.syncedUpdated = it.updated;
          meta.syncedBodyRev = bodyRev;
          meta.updated = now;
          if (remoteBody && localBody && local.syncedBodyRev !== bodyRev) {
            const merged = mergeBodies(localBody, remoteBody, await getBase(it.id), !remoteNewer);
            await db.put('bodies', merged);
            meta.bodyRev = now;
            meta.pageCount = merged.pages.length;
          } else if (remoteBody && !localBody) {
            await db.put('bodies', remoteBody);
            meta.bodyRev = bodyRev;
          } else meta.bodyRev = local.bodyRev || local.updated;
          if (remoteBody) await setBase(it.id, bodyIds(remoteBody));
          await db.put('notes', meta);
          changed = true;
          notifyNote(it.id, false);
          continue;
        }
        const meta = { ...it.data, id: it.id, updated: it.updated, syncedUpdated: it.updated, syncedBodyRev: bodyRev, bodyRev };
        if (remoteBody) { await db.put('bodies', remoteBody); await setBase(it.id, bodyIds(remoteBody)); }
        if (local && local.opened) meta.opened = local.opened;
        await db.put('notes', meta);
        changed = true;
        notifyNote(it.id, false);
      }
    }
    acct.cursor = res.cursor;
    save();
    more = res.more;
  }
  if (changed) window.dispatchEvent(new Event('inknote-remote-change'));
}

function notifyNote(id, deleted) {
  window.dispatchEvent(new CustomEvent('inknote-remote-note', { detail: { id, deleted } }));
}

// Download assets in the background so notes work offline on this device too.
let prefetching = false;
async function prefetchAssets() {
  if (prefetching || !acct) return;
  prefetching = true;
  try {
    const have = new Set(await db.keys('assets'));
    const need = new Set();
    for (const b of await db.all('bodies')) for (const id of noteAssetIds(b)) if (!have.has(id)) need.add(id);
    for (const id of need) {
      if (!navigator.onLine || !acct) break;
      const blob = await fetchAsset(id).catch(() => null);
      if (blob) await putAsset(id, blob);
    }
  } finally { prefetching = false; }
}

async function fetchAsset(id) {
  if (!acct || !navigator.onLine) return null;
  const res = await api('/blob/a_' + id);
  return res.blob();
}

// ---- wiring ------------------------------------------------------------------

export function startSync() {
  setRemoteAssetFetcher(fetchAsset);
  window.addEventListener('inknote-local-change', () => scheduleSync(2500));
  window.addEventListener('online', () => syncNow());
  window.addEventListener('offline', () => setStatus({ state: 'offline' }));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleSync(300); });
  setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 45000);
  if (acct) syncNow(); else setStatus({ state: 'signedout' });
}
