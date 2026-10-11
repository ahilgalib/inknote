// Fonts: any Google Font can be added in one tap; files are cached by the
// service worker so they keep working offline. Custom .ttf/.otf uploads too.
import { GOOGLE_FONTS } from './gfonts-list.js';
import { putAsset, getAssetBlob } from './db.js';
import { uid } from './util.js';

const KEY = 'inknote.fonts';
const SYSTEM = {
  'System Sans': 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  'System Serif': 'Georgia, "Times New Roman", serif',
  'System Mono': 'ui-monospace, Menlo, Consolas, monospace',
};
// legacy ids from early versions
const LEGACY = { sans: 'System Sans', serif: 'System Serif', mono: 'System Mono', hand: 'Caveat' };
const DEFAULT_INSTALLED = ['Inter', 'Caveat', 'Patrick Hand', 'Playfair Display', 'Merriweather', 'Roboto Mono', 'Hind Siliguri', 'Kalam'];

const CAT = { s: 'sans-serif', r: 'serif', d: 'sans-serif', h: 'cursive', m: 'monospace' };
const byName = new Map(GOOGLE_FONTS.map((f) => [f[0], f]));
const loaded = new Set();
const pending = new Map();

function readState() {
  try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; }
}
let state = readState() || { installed: DEFAULT_INSTALLED.slice(), custom: [] };
function persist() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} }

export const SYSTEM_FONTS = Object.keys(SYSTEM);
export function installedFonts() { return [...SYSTEM_FONTS, ...state.custom.map((c) => c.name), ...state.installed]; }
export function isInstalled(name) { return installedFonts().includes(name); }
export function fontInfo(name) { return byName.get(name); }
export { GOOGLE_FONTS };

export function fontStack(name) {
  name = LEGACY[name] || name || 'System Sans';
  if (SYSTEM[name]) return SYSTEM[name];
  const info = byName.get(name);
  return `"${name}", ${info ? CAT[info[1]] : 'sans-serif'}, system-ui, sans-serif`;
}

function notify(name) { window.dispatchEvent(new CustomEvent('inknote-font', { detail: name })); }

function cssURL(name, previewText) {
  const info = byName.get(name);
  const fam = encodeURIComponent(name).replace(/%20/g, '+');
  if (previewText) return `https://fonts.googleapis.com/css2?family=${fam}&text=${encodeURIComponent(previewText)}&display=swap`;
  const bold = info && info[2] & 1, ital = info && info[2] & 2;
  let axes = '';
  if (ital && bold) axes = ':ital,wght@0,400;0,700;1,400;1,700';
  else if (ital) axes = ':ital@0;1';
  else if (bold) axes = ':wght@400;700';
  return `https://fonts.googleapis.com/css2?family=${fam}${axes}&display=swap`;
}

function addLink(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = href;
  document.head.append(l);
}

// Load a Google font (all weights the canvas needs). Resolves when usable.
export function loadFont(name) {
  name = LEGACY[name] || name;
  if (!name || SYSTEM[name] || loaded.has(name)) return Promise.resolve(true);
  if (pending.has(name)) return pending.get(name);
  const p = (async () => {
    if (byName.has(name)) addLink(cssURL(name));
    try {
      await Promise.race([
        Promise.all([document.fonts.load(`400 24px "${name}"`), document.fonts.load(`700 24px "${name}"`)]),
        new Promise((r) => setTimeout(r, 8000)),
      ]);
    } catch {}
    const ok = document.fonts.check(`24px "${name}"`);
    if (ok) { loaded.add(name); notify(name); }
    pending.delete(name);
    return ok;
  })();
  pending.set(name, p);
  return p;
}

// Tiny subset of a font just for showing its name in the picker.
export function loadPreview(name) {
  if (loaded.has(name) || !byName.has(name)) return;
  addLink(cssURL(name, name));
}

export async function installFont(name) {
  if (!state.installed.includes(name)) { state.installed.unshift(name); persist(); }
  return loadFont(name);
}

export function uninstallFont(name) {
  state.installed = state.installed.filter((n) => n !== name);
  state.custom = state.custom.filter((c) => c.name !== name);
  persist();
}

export async function addCustomFont(file) {
  const name = file.name.replace(/\.(ttf|otf|woff2?)$/i, '').replace(/[-_]+/g, ' ').trim().slice(0, 60) || 'Custom font';
  const asset = await putAsset('font_' + uid(), file);
  state.custom = state.custom.filter((c) => c.name !== name);
  state.custom.unshift({ name, asset });
  persist();
  await loadCustom({ name, asset });
  return name;
}

async function loadCustom({ name, asset }) {
  if (loaded.has(name)) return;
  const blob = await getAssetBlob(asset);
  if (!blob) return;
  try {
    const face = new FontFace(name, await blob.arrayBuffer());
    await face.load();
    document.fonts.add(face);
    loaded.add(name);
    notify(name);
  } catch {}
}

// Load everything the user has installed (call once at start, non-blocking).
export function loadInstalledFonts(extra = []) {
  for (const c of state.custom) loadCustom(c);
  for (const n of [...extra, ...state.installed]) loadFont(n);
}

export const CATEGORY_LABELS = { all: 'All', s: 'Sans', r: 'Serif', d: 'Display', h: 'Handwriting', m: 'Mono', bn: 'বাংলা' };
