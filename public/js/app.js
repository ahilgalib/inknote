// App shell: switches between the library and the editor (hash routing),
// starts background sync and font loading.
import { db, requestPersistence } from './db.js';
import { applyTheme } from './settings.js';
import { Library } from './library.js';
import { Editor } from './editor.js';
import { toast } from './util.js';
import { startSync } from './sync.js';
import { loadInstalledFonts } from './fonts.js';

const root = document.getElementById('app');
let view = null;

applyTheme();
requestPersistence();
loadInstalledFonts();
startSync();

// Block Safari's page-level pinch zoom; the canvas does its own zooming.
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('gesturechange', (e) => e.preventDefault());

async function route() {
  const m = location.hash.match(/^#\/note\/(.+)$/);
  if (view instanceof Editor) {
    if (m && view.meta.id === decodeURIComponent(m[1])) return;
    const ed = view;
    view = null;
    ed.onExit = () => {};
    await ed.exit();
  } else if (view) { view.destroy(); view = null; }

  if (m) {
    const id = decodeURIComponent(m[1]);
    const meta = await db.get('notes', id);
    const body = meta && await db.get('bodies', id);
    if (!meta || !body) { toast('Note not found'); location.hash = ''; return; }
    meta.opened = Date.now();
    view = new Editor(meta, body, { onExit: () => { view = null; location.hash = ''; } });
    view.mount(root);
    if (sessionStorage.getItem('inknote.autorec') === id) {
      sessionStorage.removeItem('inknote.autorec');
      view.toggleRecord();
    }
  } else {
    view = new Library({ openNote: (id) => { location.hash = '#/note/' + encodeURIComponent(id); } });
    await view.mount(root);
  }
}

// A note open in the editor was changed on another device.
window.addEventListener('inknote-remote-note', async (e) => {
  if (!(view instanceof Editor) || view.meta.id !== e.detail.id) return;
  if (e.detail.deleted) { toast('This note was deleted on another device'); return; }
  const meta = await db.get('notes', e.detail.id);
  const body = await db.get('bodies', e.detail.id);
  if (meta && body) view.applyRemote(meta, body);
});

// handy for debugging from the console
window.inknote = { get view() { return view; } };

window.addEventListener('hashchange', route);
route();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}
