// App shell: switches between the library and the editor (hash routing),
// starts background sync and font loading.
import { db, requestPersistence } from './db.js';
import { applyTheme } from './settings.js';
import { Library } from './library.js';
import { Editor } from './editor.js';
import { QuickNote } from './quicknote.js';
import { toast, h } from './util.js';
import { startSync, setBeforeSync } from './sync.js';
import { loadInstalledFonts } from './fonts.js';

const root = document.getElementById('app');
let library = null;
let editors = [];          // one note, or two side by side (multi-note)
let panes = null;
let routing = Promise.resolve();

applyTheme();
requestPersistence();
// save what is on screen before every sync, so offline work is never missed
setBeforeSync(() => Promise.all(editors.map((ed) => ed.flushSave())));
loadInstalledFonts();
startSync();

// Block Safari's page-level pinch zoom; the canvas does its own zooming.
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('gesturechange', (e) => e.preventDefault());

function wantedIds() {
  const one = location.hash.match(/^#\/note\/([^/]+)$/);
  const two = location.hash.match(/^#\/split\/([^/]+)\/([^/]+)$/);
  if (two) return [decodeURIComponent(two[1]), decodeURIComponent(two[2])].filter((v, i, a) => a.indexOf(v) === i);
  if (one) return [decodeURIComponent(one[1])];
  return [];
}

async function openEditor(id) {
  const meta = await db.get('notes', id);
  const body = meta && await db.get('bodies', id);
  if (!meta || !body) return null;
  meta.opened = Date.now();
  const ed = new (meta.kind === 'quick' ? QuickNote : Editor)(meta, body, {
    onExit: () => {
      editors = editors.filter((x) => x !== ed);
      location.hash = editors.length ? '#/note/' + encodeURIComponent(editors[0].meta.id) : '';
    },
  });
  return ed;
}

async function route() {
  const want = wantedIds();
  const have = editors.map((e) => e.meta.id);
  if (want.length && want.length === have.length && want.every((id, i) => id === have[i])) return;

  // close what is no longer wanted
  for (const ed of editors.filter((e) => !want.includes(e.meta.id))) { ed.onExit = () => {}; await ed.exit(); }
  editors = editors.filter((e) => want.includes(e.meta.id));
  if (library && want.length) { library.destroy(); library = null; }

  if (!want.length) {
    if (panes) { panes.remove(); panes = null; }
    if (!library) {
      library = new Library({ openNote: (id) => { location.hash = '#/note/' + encodeURIComponent(id); } });
      await library.mount(root);
    }
    return;
  }

  const next = [];
  for (const id of want) {
    let ed = editors.find((e) => e.meta.id === id);
    if (!ed) ed = await openEditor(id);
    if (ed) next.push(ed);
  }
  if (!next.length) { toast('Note not found'); location.hash = ''; return; }
  editors = next;
  if (!panes) { panes = h('div', { class: 'panes' }); root.append(panes); }
  panes.classList.toggle('split', editors.length > 1);
  const kids = editors.map((ed) => {
    const pane = h('div', { class: 'pane' });
    if (ed.el.isConnected) pane.append(ed.el); else ed.mount(pane);
    return pane;
  });
  panes.innerHTML = '';
  kids.forEach((k, i) => { if (i) panes.append(h('div', { class: 'pane-divider' })); panes.append(k); });
  for (const ed of editors) { requestAnimationFrame(() => ed.resize()); }
  const first = editors[0];
  if (editors.length === 1 && sessionStorage.getItem('inknote.autorec') === first.meta.id) {
    sessionStorage.removeItem('inknote.autorec');
    first.toggleRecord();
  }
}

// A note open in the editor was changed on another device.
window.addEventListener('inknote-remote-note', async (e) => {
  const ed = editors.find((x) => x.meta.id === e.detail.id);
  if (!ed) return;
  if (e.detail.deleted) { toast('This note was deleted on another device'); return; }
  const meta = await db.get('notes', e.detail.id);
  const body = await db.get('bodies', e.detail.id);
  if (meta && body) ed.applyRemote(meta, body);
});

// handy for debugging from the console
window.inknote = { get view() { return editors[0] || library; }, get editors() { return editors; } };

const queueRoute = () => { routing = routing.then(route, route); };
window.addEventListener('hashchange', queueRoute);
queueRoute();

// A new version was deployed: the service worker swaps itself in; offer a
// one-tap reload (automatic on the home screen) so nobody stays on old code.
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;
    if (!editors.length) { location.reload(); return; }
    if (document.querySelector('.update-bar')) return;
    const bar = h('div', { class: 'update-bar' }, h('span', {}, 'A new version of Inknote is ready'),
      h('button', { class: 'btn primary', onClick: async () => { await Promise.all(editors.map((e) => e.flushSave())); location.reload(); } }, 'Update now'));
    document.body.append(bar);
  });
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').then((r) => r.update()).catch(() => {}); });
}
