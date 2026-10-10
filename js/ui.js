// Popovers, menus and dialogs.
import { h } from './util.js';
import { icons } from './icons.js';

let openPop = null;

export function closePopover() {
  if (openPop) { openPop.remove(); openPop = null; }
}

// Show `content` in a floating panel anchored to `anchor` (element or {x,y}).
export function popover(anchor, content, { className = '' } = {}) {
  closePopover();
  const pop = h('div', { class: 'popover ' + className }, content);
  const scrim = h('div', { class: 'scrim' });
  const wrap = h('div', { class: 'pop-wrap' }, scrim, pop);
  scrim.addEventListener('pointerdown', (e) => { e.preventDefault(); closePopover(); });
  document.body.append(wrap);
  openPop = wrap;
  const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0 };
  const vw = window.innerWidth, vh = window.innerHeight;
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = r.left + r.width / 2 - pw / 2;
  left = Math.max(8, Math.min(vw - pw - 8, left));
  let top = r.bottom + 8;
  if (top + ph > vh - 8) top = Math.max(8, r.top - ph - 8);
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
  return pop;
}

export function menu(anchor, items) {
  const list = h('div', { class: 'menu' },
    items.filter(Boolean).map((it) => it === '-' ? h('div', { class: 'menu-sep' }) :
      h('button', {
        class: 'menu-item' + (it.danger ? ' danger' : '') + (it.checked ? ' checked' : ''),
        onClick: () => { closePopover(); it.onClick && it.onClick(); },
      }, it.icon ? h('span', { class: 'mi-icon', html: icons[it.icon] || '' }) : h('span', { class: 'mi-icon' }),
        h('span', {}, it.label),
        it.checked ? h('span', { class: 'mi-check', html: icons.check }) : null)));
  return popover(anchor, list);
}

function dialog(build) {
  return new Promise((resolve) => {
    const done = (v) => { wrap.remove(); resolve(v); };
    const box = h('div', { class: 'dialog', role: 'dialog' });
    const wrap = h('div', { class: 'dialog-wrap' }, box);
    wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) done(null); });
    build(box, done);
    document.body.append(wrap);
    const f = box.querySelector('input,button.primary');
    if (f) setTimeout(() => { f.focus(); if (f.select) f.select(); }, 30);
  });
}

export function promptDialog(title, value = '', { placeholder = '', ok = 'Save' } = {}) {
  return dialog((box, done) => {
    const input = h('input', { class: 'input', value, placeholder });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(input.value.trim()); if (e.key === 'Escape') done(null); });
    box.append(
      h('h3', {}, title), input,
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn', onClick: () => done(null) }, 'Cancel'),
        h('button', { class: 'btn primary', onClick: () => done(input.value.trim()) }, ok)));
  });
}

export function confirmDialog(title, message, { ok = 'Delete', danger = true } = {}) {
  return dialog((box, done) => {
    box.append(
      h('h3', {}, title), message ? h('p', { class: 'muted' }, message) : null,
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn', onClick: () => done(false) }, 'Cancel'),
        h('button', { class: 'btn primary' + (danger ? ' danger' : ''), onClick: () => done(true) }, ok)));
  });
}

export function progressDialog(title) {
  const bar = h('div', { class: 'progress-bar' });
  const label = h('p', { class: 'muted' }, '');
  const wrap = h('div', { class: 'dialog-wrap' },
    h('div', { class: 'dialog' }, h('h3', {}, title), h('div', { class: 'progress' }, bar), label));
  document.body.append(wrap);
  return {
    set(frac, text) { bar.style.width = Math.round(frac * 100) + '%'; if (text) label.textContent = text; },
    close() { wrap.remove(); },
  };
}
