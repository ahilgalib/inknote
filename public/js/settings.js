// Per-device preferences, kept in localStorage.

const KEY = 'inknote.settings';

const DEFAULTS = {
  theme: 'light',           // system | light | dark
  fingerDraw: 'auto',       // auto | on | off   (auto = off once an Apple Pencil / stylus is used)
  penSeen: false,
  pressure: true,
  autoAddPage: true,
  shapeHold: true,
  twoFingerUndo: true,
  eraserAutoDeselect: true, // after erasing, jump back to the previous tool (like Notability)
  scrollDir: 'vertical',
  defaultTemplate: 'lined',
  defaultColor: '#ffffff',
  defaultSize: 'letter',
  sort: 'updated',
  libView: 'grid',          // grid | list
  presets: [],              // favourite pens: { tool, color, size, style }
  tipsSeen: false,
  stickerImages: true,
  name: '',
  tools: {
    pen: { colors: ['#1d1d1f', '#1f5bd8', '#d93434', '#1f8a4c', '#8a3ffc'], color: 0, sizes: [1.4, 2.4, 4.2], size: 1, style: 'fountain' },
    hl: { colors: ['#ffe24a', '#7ef29a', '#ff8fd0', '#7cc8ff', '#ffb050'], color: 0, sizes: [10, 18, 28], size: 1, straight: false },
    tape: { colors: ['#f2b84b', '#7cc8ff', '#ff8fa3', '#9be29b', '#b7a6ff'], color: 0, sizes: [14, 24, 36], size: 1 },
    eraser: { mode: 'precise', sizes: [6, 14, 30], size: 1 },
    text: { colors: ['#1d1d1f', '#1f5bd8', '#d93434', '#1f8a4c', '#8a3ffc'], color: 0, sizes: [14, 20, 30], size: 1, font: 'Inter', bold: false, italic: false, underline: false, align: 'left' },
    laser: { colors: ['#ff3b30', '#34c759', '#0a84ff'], color: 0, sizes: [4], size: 0 },
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
if (data.tools.eraser.mode === 'partial') data.tools.eraser.mode = 'precise';

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
