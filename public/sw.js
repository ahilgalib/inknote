// Offline support: the whole app (incl. pdf.js) is cached, Google Fonts are
// cached the first time they are used. The sync API is never cached.
const VERSION = 'inknote-v10';
const FONTS = 'inknote-fonts';
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'js/app.js', 'js/db.js', 'js/editor.js', 'js/fontpicker.js', 'js/fonts.js', 'js/gallery.js', 'js/gfonts-list.js',
  'js/icons.js', 'js/ink.js', 'js/library.js', 'js/notes.js', 'js/pdf.js', 'js/render.js', 'js/settings.js',
  'js/shapes.js', 'js/sync.js', 'js/templates.js', 'js/toolbox.js', 'js/ui.js', 'js/util.js',
  'vendor/pdfjs/pdf.min.js', 'vendor/pdfjs/pdf.worker.min.js',
  'fonts/figtree-latin-600-normal.woff2', 'fonts/figtree-latin-700-normal.woff2', 'fonts/figtree-latin-800-normal.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== FONTS).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONTS).then(async (cache) => {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  // stale-while-revalidate: instant start from cache, refresh in the background
  e.respondWith(caches.open(VERSION).then(async (cache) => {
    const hit = await cache.match(req, { ignoreSearch: true });
    const net = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; });
    if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
    return net.catch(async () => (await cache.match('index.html')) || Response.error());
  }));
});
