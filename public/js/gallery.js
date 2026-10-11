// Template gallery with live customisation (accent, paper colour, heading, size).
import { h } from './util.js';
import { icons } from './icons.js';
import { sheet, colorPopover } from './ui.js';
import { PLANNERS, PAPERS, ACCENTS, PAPER_COLORS, SIZES, templatePreview, plannerById, plannerPaperColor, TEMPLATE_CATS } from './templates.js';

export function templateCard(id, onClick, width = 220) {
  const p = plannerById(id);
  const canvas = templatePreview(id, { width });
  return h('button', { class: 'tpl-card', onClick },
    h('div', { class: 'tpl-thumb' }, canvas),
    h('div', { class: 'tpl-name' }, (p || PAPERS.find((x) => x.id === id)).label));
}

// opts: { title, action, onPick({template,color,tpl,size,count}), start: 'planners'|'paper' }
export function templateGallery({ title = 'New note from template', action = 'Create note', onPick, start = 'planners', open } = {}) {
  let tab = start, cat = 'all';
  const body = h('div', { class: 'gal-body' });
  const S = sheet(h('div', { class: 'gallery' },
    h('div', { class: 'gal-head' }, h('h2', {}, title), h('div', { class: 'grow' }), h('button', { class: 'icon-btn', 'aria-label': 'Close', html: icons.close, onClick: () => S.close() })),
    body), { className: 'gallery-sheet' });

  const grid = () => {
    body.innerHTML = '';
    const seg = h('div', { class: 'seg' },
      h('button', { class: tab === 'planners' ? 'on' : '', onClick: () => { tab = 'planners'; grid(); } }, 'Planners & templates'),
      h('button', { class: tab === 'paper' ? 'on' : '', onClick: () => { tab = 'paper'; grid(); } }, 'Paper'));
    const g = h('div', { class: 'tpl-grid-lg' });
    const cats = tab === 'planners' ? h('div', { class: 'row wrap cat-row' }, TEMPLATE_CATS.map(([v, l]) =>
      h('button', { class: 'chip' + (cat === v ? ' on' : ''), onClick: () => { cat = v; grid(); } }, l))) : null;
    body.append(...[seg, cats, g].filter(Boolean));
    const ids = tab === 'planners' ? PLANNERS.filter((p) => cat === 'all' || p.cat === cat).map((p) => p.id) : PAPERS.map((p) => p.id);
    // build previews progressively so the sheet opens instantly
    let i = 0;
    const step = () => {
      const end = Math.min(ids.length, i + 4);
      for (; i < end; i++) { const id = ids[i]; g.append(templateCard(id, () => detail(id))); }
      if (i < ids.length) requestAnimationFrame(step);
    };
    step();
  };

  const detail = (id) => {
    const planner = !!plannerById(id);
    const st = { template: id, color: planner ? plannerPaperColor(id) : '#ffffff', tpl: { accent: '', title: '' }, size: 'letter', count: 1 };
    body.innerHTML = '';
    const prev = h('div', { class: 'gal-preview' });
    const draw = () => {
      prev.innerHTML = '';
      const sz = SIZES[st.size];
      prev.append(templatePreview(id, { color: st.color, tpl: st.tpl, w: sz.w, h: sz.h, width: sz.w > sz.h ? 460 : 340 }));
    };
    const swatches = (list, get, set, extra) => h('div', { class: 'row wrap' },
      list.map((c) => h('button', { class: 'swatch' + (get() === c ? ' on' : ''), style: { background: c }, 'aria-label': c, onClick: (e) => { set(c); refresh(); } })),
      extra ? h('button', { class: 'swatch more', 'aria-label': 'Custom colour', html: icons.palette, onClick: (e) => colorPopover(e.currentTarget, get(), (c) => { set(c); refresh(); }) }) : null);
    const ctrl = h('div', { class: 'gal-ctrl' });
    const refresh = () => {
      draw();
      ctrl.innerHTML = '';
      const titleIn = h('input', { class: 'input', value: st.tpl.title, placeholder: 'Heading (optional)' });
      titleIn.addEventListener('input', () => { st.tpl.title = titleIn.value; draw(); });
      const sizeSel = h('select', { class: 'input' }, Object.entries(SIZES).map(([k, v]) => h('option', { value: k, selected: k === st.size }, v.label)));
      sizeSel.addEventListener('change', () => { st.size = sizeSel.value; draw(); });
      const count = h('input', { class: 'input', type: 'number', min: 1, max: 31, value: st.count });
      count.addEventListener('input', () => { st.count = Math.max(1, Math.min(31, +count.value || 1)); });
      ctrl.append(
        h('h3', {}, (plannerById(id) || PAPERS.find((x) => x.id === id)).label),
        planner ? h('label', { class: 'fld' }, h('span', {}, 'Heading'), titleIn) : null,
        planner ? h('div', { class: 'fld' }, h('span', {}, 'Accent colour'), swatches(ACCENTS, () => st.tpl.accent, (c) => { st.tpl.accent = c; }, true)) : null,
        h('div', { class: 'fld' }, h('span', {}, 'Paper colour'), swatches(PAPER_COLORS.map((p) => p.id), () => st.color, (c) => { st.color = c; }, true)),
        h('label', { class: 'fld' }, h('span', {}, 'Page size'), sizeSel),
        h('label', { class: 'fld' }, h('span', {}, 'Number of pages'), count),
        h('div', { class: 'row', style: { marginTop: '18px' } },
          h('button', { class: 'btn', onClick: grid }, 'Back'),
          h('button', { class: 'btn primary grow', onClick: () => { S.close(); onPick({ ...st, tpl: { ...st.tpl } }); } }, action)));
    };
    body.append(h('div', { class: 'gal-detail' }, prev, ctrl));
    refresh();
  };

  if (open) detail(open); else grid();
  return S;
}
