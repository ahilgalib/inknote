// Google Drive: save a note (quick notes become Google Docs, handwritten
// notes a PDF) and back up / restore every note. Files go to an "Inknote"
// folder. Uses the drive.file permission: Inknote only sees files it made.
import { toast, loadScript } from './util.js';
import { progressDialog, menu } from './ui.js';
import { serverConfig } from './sync.js';
import { exportNotePDF, buildBackup, importFile } from './notes.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const KEY = 'inknote.drive';
const API = 'https://www.googleapis.com/drive/v3';
const UP = 'https://www.googleapis.com/upload/drive/v3';

let token = null, tokenExp = 0, client = null, clientId = null;
const state = (() => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } })();
state.files = state.files || {};
const keep = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} };

// Load Google's script ahead of time so the sign-in pop-up opens straight
// from the tap (browsers block pop-ups that open after a delay).
export async function warmDrive() {
  try {
    const cfg = await serverConfig();
    clientId = cfg.googleClientId || null;
    if (clientId) await loadScript('https://accounts.google.com/gsi/client');
  } catch {}
  return !!clientId;
}
warmDrive();

function getToken() {
  if (token && Date.now() < tokenExp - 60e3) return Promise.resolve(token);
  if (!clientId) return Promise.reject(new Error('Google Drive is not set up for this site yet'));
  const oauth = window.google && google.accounts && google.accounts.oauth2;
  if (!oauth) return Promise.reject(new Error('Could not reach Google — check your connection'));
  return new Promise((resolve, reject) => {
    client = oauth.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (r) => {
        if (r.error) { reject(new Error(r.error_description || r.error)); return; }
        token = r.access_token;
        tokenExp = Date.now() + (r.expires_in || 3600) * 1000;
        state.linked = true; keep();
        resolve(token);
      },
      error_callback: (e) => reject(new Error(e && e.type === 'popup_closed' ? 'cancelled' : 'Google sign-in was blocked — allow pop-ups and try again')),
    });
    client.requestAccessToken({ prompt: state.linked ? '' : 'consent' });
  });
}

async function gfetch(url, opts = {}) {
  const t = await getToken();
  const res = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + t, ...(opts.headers || {}) } });
  if (res.status === 401) { token = null; throw new Error('Google sign-in expired — try again'); }
  if (!res.ok) {
    let msg = res.status + '';
    try { const j = await res.json(); msg = (j.error && j.error.message) || msg; } catch {}
    if (/has not been used|is disabled/i.test(msg)) msg = 'The Google Drive API is not enabled for this site yet';
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

async function folderId() {
  if (state.folder) {
    try { const f = await gfetch(`${API}/files/${state.folder}?fields=id,trashed`); if (f && !f.trashed) return state.folder; } catch {}
  }
  const q = encodeURIComponent("name='Inknote' and mimeType='application/vnd.google-apps.folder' and trashed=false");
  const found = await gfetch(`${API}/files?q=${q}&fields=files(id)`);
  state.folder = found.files && found.files[0] ? found.files[0].id
    : (await gfetch(`${API}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Inknote', mimeType: 'application/vnd.google-apps.folder' }) })).id;
  keep();
  return state.folder;
}

// create or replace a file (multipart upload)
async function upload({ key, name, blob, mimeType, convertTo }) {
  const meta = { name, mimeType: convertTo || mimeType };
  const prev = key && state.files[key];
  const form = (m) => {
    const fd = new FormData();
    fd.append('metadata', new Blob([JSON.stringify(m)], { type: 'application/json' }));
    fd.append('file', blob, name);
    return fd;
  };
  if (prev) {
    try {
      const f = await gfetch(`${UP}/files/${prev}?uploadType=multipart&fields=id,webViewLink`, { method: 'PATCH', body: form({ name }) });
      return f;
    } catch { /* deleted in Drive: make a new one */ }
  }
  meta.parents = [await folderId()];
  const f = await gfetch(`${UP}/files?uploadType=multipart&fields=id,webViewLink`, { method: 'POST', body: form(meta) });
  if (key) { state.files[key] = f.id; keep(); }
  return f;
}

function done(f, what) {
  const open = () => f.webViewLink && window.open(f.webViewLink, '_blank', 'noopener');
  toast(`${what} saved to Google Drive › Inknote`, 3500);
  return open;
}

function failed(e) {
  if (e.message === 'cancelled') return;
  toast(e.message || 'Google Drive failed', 4500);
}

// One note → Drive (updates the same file next time).
export async function saveToDrive(meta, body) {
  let pd;
  try {
    await getToken();
    pd = progressDialog('Saving to Google Drive…');
    let f;
    if (meta.kind === 'quick') {
      const text = (meta.title ? meta.title + '\n\n' : '') + ((body.quick && body.quick.text) || '');
      f = await upload({ key: 'note:' + meta.id, name: meta.title || 'Quick note', blob: new Blob([text], { type: 'text/plain' }), mimeType: 'text/plain', convertTo: 'application/vnd.google-apps.document' });
    } else {
      const pdf = await exportNotePDF(meta, body, (x) => pd.set(x * 0.8), { returnBlob: true });
      f = await upload({ key: 'note:' + meta.id, name: (meta.title || 'Note') + '.pdf', blob: pdf, mimeType: 'application/pdf' });
    }
    pd.close();
    done(f, '“' + (meta.title || 'Note') + '”');
  } catch (e) { if (pd) pd.close(); failed(e); }
}

// Every note, folder, picture and recording in one file.
export async function backupToDrive({ quiet = false } = {}) {
  let pd;
  try {
    await getToken();
    pd = quiet ? null : progressDialog('Backing up to Google Drive…');
    const blob = await buildBackup();
    await upload({ key: 'backup', name: 'Inknote backup.json', blob, mimeType: 'application/json' });
    state.lastBackup = Date.now(); keep();
    if (pd) pd.close();
    if (!quiet) toast('All notes backed up to Google Drive › Inknote', 3500);
    return true;
  } catch (e) { if (pd) pd.close(); if (!quiet) failed(e); return false; }
}

export async function restoreFromDrive(anchor, onDone) {
  try {
    await getToken();
    const q = encodeURIComponent("name contains 'Inknote backup' and trashed=false");
    const list = await gfetch(`${API}/files?q=${q}&orderBy=modifiedTime desc&fields=files(id,name,modifiedTime,size)&pageSize=10`);
    if (!list.files || !list.files.length) { toast('No Inknote backup in your Google Drive yet'); return; }
    menu(anchor, list.files.map((f) => ({
      label: `${f.name} · ${new Date(f.modifiedTime).toLocaleString()}`,
      icon: 'restore',
      onClick: async () => {
        const pd = progressDialog('Restoring from Google Drive…');
        try {
          const t = await getToken();
          const res = await fetch(`${API}/files/${f.id}?alt=media`, { headers: { Authorization: 'Bearer ' + t } });
          if (!res.ok) throw new Error('Download failed (' + res.status + ')');
          await importFile(await res.blob());
          pd.close();
          toast('Notes restored from Google Drive');
          onDone && onDone();
        } catch (e) { pd.close(); failed(e); }
      },
    })));
  } catch (e) { failed(e); }
}

export function driveInfo() { return { linked: !!state.linked, lastBackup: state.lastBackup || 0 }; }
