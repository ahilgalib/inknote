// Font picker: installed fonts + the whole Google Fonts catalogue + uploads.
import { h, pickFile, toast } from './util.js';
import { popover, closePopover } from './ui.js';
import { account } from './sync.js';
import { GOOGLE_FONTS, installedFonts, installFont, uninstallFont, fontStack, loadPreview, loadFont, addCustomFont, CATEGORY_LABELS, SYSTEM_FONTS } from './fonts.js';

export function fontPicker(anchor, current, onPick) {
  let cat = 'all', q = '', limit = 60;
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search 1,700+ Google Fonts', 'aria-label': 'Search fonts' });
  const chips = h('div', { class: 'chips-row' });
  const list = h('div', { class: 'font-list' });
  const choose = async (name) => {
    closePopover();
    if (!SYSTEM_FONTS.includes(name)) {
      toast('Loading ' + name + '…', 1200);
      const ok = await installFont(name);
      if (!ok) toast('Could not download that font (offline?)');
    }
    onPick(name);
  };
  const row = (name, installed) => {
    const el = h('div', { class: 'font-row' + (name === current ? ' on' : '') },
      h('button', { class: 'font-name', style: { fontFamily: fontStack(name) }, onClick: () => choose(name) }, name),
      installed && !SYSTEM_FONTS.includes(name) ? h('button', { class: 'font-x', title: 'Remove from my fonts', 'aria-label': 'Remove font', onClick: (e) => { e.stopPropagation(); uninstallFont(name); render(); } }, '×')
        : installed ? null : h('button', { class: 'font-get', title: 'Download & add to my fonts (on all your devices)', onClick: async (e) => {
          e.stopPropagation();
          const b = e.currentTarget;
          b.disabled = true; b.textContent = '…';
          const ok = await installFont(name);
          if (ok) { b.textContent = '✓'; b.classList.add('done'); toast(name + ' added to My fonts'); }
          else { b.disabled = false; b.textContent = 'Get'; toast('Could not download that font (offline?)'); }
        } }, 'Get'));
    if (!installed) loadPreview(name); else loadFont(name);
    return el;
  };
  const render = () => {
    chips.innerHTML = '';
    for (const [k, label] of Object.entries(CATEGORY_LABELS)) {
      chips.append(h('button', { class: 'chip' + (cat === k ? ' on' : ''), onClick: () => { cat = k; limit = 60; render(); } }, label));
    }
    list.innerHTML = '';
    const mine = installedFonts();
    const ql = q.trim().toLowerCase();
    if (!ql && cat === 'all') {
      list.append(h('div', { class: 'font-h' }, 'My fonts'));
      mine.forEach((n) => list.append(row(n, true)));
      list.append(h('div', { class: 'font-h' }, 'Google Fonts'));
    }
    const res = GOOGLE_FONTS.filter(([n, c, f]) => (!ql || n.toLowerCase().includes(ql)) && (cat === 'all' || (cat === 'bn' ? f & 4 : c === cat)));
    res.slice(0, limit).forEach(([n]) => list.append(row(n, mine.includes(n))));
    if (!res.length) list.append(h('p', { class: 'muted small pad' }, 'No fonts match.'));
    if (res.length > limit) list.append(h('button', { class: 'btn block', onClick: () => { limit += 120; render(); } }, `Show more (${res.length - limit})`));
  };
  search.addEventListener('input', () => { q = search.value; limit = 60; render(); });
  const upload = h('button', { class: 'btn block', onClick: async () => {
    const [f] = await pickFile('.ttf,.otf,.woff,.woff2,font/*');
    if (!f) return;
    try { const name = await addCustomFont(f); closePopover(); onPick(name); toast('Added ' + name); }
    catch { toast('That font file could not be read'); }
  } }, 'Upload a font file (.ttf / .otf)');
  render();
  const note = h('p', { class: 'muted small font-note' }, account() ? 'My fonts are saved to your account and appear on all your devices.' : 'Sign in to keep My fonts on all your devices.');
  const pop = popover(anchor, h('div', { class: 'font-pop' }, search, chips, list, upload, note), { className: 'wide' });
  const again = () => { if (pop.isConnected) render(); else window.removeEventListener('inknote-fonts-changed', again); };
  window.addEventListener('inknote-fonts-changed', again);
  return pop;
}
