// Per-device preferences, kept in localStorage.

const KEY = 'inkwell.settings';

const DEFAULTS = {
  theme: 'system',          // system | light | dark
  fingerDraw: 'auto',       // auto | on | off   (auto = off once an Apple Pencil / stylus is used)
  penSeen: false,
  pressure: true,
  autoAddPage: true,
  shapeHold: true,
  twoFingerUndo: true,
  defaultTemplate: 'lined',
  defaultColor: '#ffffff',
  defaultSize: 'letter',
  sort: 'updated',
  tools: {
    pen: { colors: ['#1d1d1f', '#1f5bd8', '#d93434', '#1f8a4c', '#8a3ffc'], color: 0, sizes: [1.6, 2.8, 4.6], size: 1 },
    hl: { colors: ['#ffe24a', '#7ef29a', '#ff8fd0', '#7cc8ff', '#ffb050'], color: 0, sizes: [10, 18, 28], size: 1 },
    eraser: { mode: 'stroke', sizes: [6, 14, 30], size: 1 },
    text: { colors: ['#1d1d1f', '#1f5bd8', '#d93434', '#1f8a4c', '#8a3ffc'], color: 0, sizes: [16, 22, 32], size: 1, font: 'sans' },
  },
};

function merge(a, b) {
  const out = { ...a };
  for (const k in b) {
    if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object') out[k] = merge(a[k], b[k]);
    else out[k] = b[k];
  }
  return out;
}

let data;
try { data = merge(DEFAULTS, JSON.parse(localStorage.getItem(KEY) || '{}')); }
catch { data = structuredClone(DEFAULTS); }

export const settings = data;

export function saveSettings() {
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch {}
}

export function applyTheme() {
  const t = data.theme;
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

export function fingerDraws() {
  if (data.fingerDraw === 'on') return true;
  if (data.fingerDraw === 'off') return false;
  return !data.penSeen;
}
