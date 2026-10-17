// Quick note: a typed note like Google Keep — fast on phones, with lists,
// checklists and smart maths (each line works out its sum; lists get totals).
import { h, debounce, toast, saveFile, safeName } from './util.js';
import { icons } from './icons.js';
import { menu, confirmDialog } from './ui.js';
import { saveNote, trashNote, deleteForever } from './notes.js';
import { analyse, plainNum } from './quickcalc.js';
import { Calculator } from './calculator.js';
import { saveToDrive } from './drive.js';

const MARKER = /^(\s*)(• |☐ |☑ |(\d+)([.)]) )/;

export class QuickNote {
  constructor(meta, body, { onExit }) {
    this.meta = meta;
    this.body = body;
    body.quick = body.quick || { text: '' };
    this.onExit = onExit;
    this.save = debounce(() => this.persist(), 700);
    this.build();
  }

  // ------------------------------------------------------------------ DOM --

  build() {
    const tb = (icon, title, fn, cls = '') => h('button', { class: 'tool-btn ' + cls, title, 'aria-label': title, html: icons[icon], onClick: fn });
    this.titleIn = h('input', { class: 'qn-title', value: this.meta.title, placeholder: 'Title', spellcheck: 'false', 'aria-label': 'Title' });
    this.titleIn.addEventListener('input', () => { this.meta.title = this.titleIn.value || 'Quick note'; this.save(); });
    this.titleIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this.ta.focus(); } });

    this.calcBtn = tb('nCalc', 'Calculator', () => this.toggleCalc());
    const top = h('header', { class: 'ed-top qn-top' },
      h('div', { class: 'tb-island back' }, tb('nBack', 'Back to library', () => this.exit())),
      h('div', { class: 'grow' }),
      h('div', { class: 'tb-island actions' },
        tb('nUndo', 'Undo', () => this.exec('undo')),
        tb('nRedo', 'Redo', () => this.exec('redo')),
        this.calcBtn,
        tb('nShare', 'Share', () => this.share()),
        tb('nMore', 'More', (e) => this.moreMenu(e.currentTarget))));

    this.mirror = h('div', { class: 'qn-mirror', 'aria-hidden': 'true' });
    this.ta = h('textarea', { class: 'qn-text', placeholder: 'Note… try “Rice 120”, “Oil 250”, then “Total”', spellcheck: 'true', autocapitalize: 'sentences', 'aria-label': 'Note' });
    this.ta.value = this.body.quick.text;
    this.info = h('div', { class: 'qn-info' });
    this.page = h('div', { class: 'qn-page' }, this.titleIn, this.info, h('div', { class: 'qn-edit' }, this.mirror, this.ta));
    this.scroll = h('div', { class: 'qn-scroll' }, this.page);
    this.scroll.addEventListener('click', (e) => { if (e.target === this.scroll || e.target === this.page) { this.ta.focus(); const n = this.ta.value.length; this.ta.setSelectionRange(n, n); } });

    const fmt = (icon, title, fn) => h('button', { class: 'qn-fmt', title, 'aria-label': title, onPointerdown: (e) => e.preventDefault(), onClick: fn }, h('span', { html: icons[icon] }));
    this.chips = h('div', { class: 'qn-chips' });
    this.bar = h('div', { class: 'qn-bar' },
      fmt('check2', 'Checklist', () => this.toggleMarker('☐ ')),
      fmt('list', 'Bulleted list', () => this.toggleMarker('• ')),
      fmt('nNumList', 'Numbered list', () => this.toggleMarker('1. ')),
      h('div', { class: 'qn-sep' }),
      this.chips);
    this.el = h('div', { class: 'qn' }, top, this.scroll, this.bar);

    const ta = this.ta;
    ta.addEventListener('input', (e) => this.onInput(e));
    ta.addEventListener('beforeinput', (e) => this.onBeforeInput(e));
    ta.addEventListener('keydown', (e) => this.onKey(e));
    ta.addEventListener('click', () => this.onTap());
    ta.addEventListener('keyup', () => this.renderChips());
    document.addEventListener('selectionchange', this.onSel = () => { if (document.activeElement === ta) this.renderChips(); });
    this.onVis = () => { if (document.visibilityState === 'hidden') this.save.flush(); };
    document.addEventListener('visibilitychange', this.onVis);
    // keep the suggestion bar just above the on-screen keyboard
    this.onVV = () => {
      const vv = window.visualViewport;
      if (!vv) return;
      const kb = Math.max(0, innerHeight - vv.height - vv.offsetTop);
      this.el.style.setProperty('--kb', kb + 'px');
      if (document.activeElement === ta) this.caretIntoView();
    };
    if (window.visualViewport) { visualViewport.addEventListener('resize', this.onVV); visualViewport.addEventListener('scroll', this.onVV); }
    this.ro = new ResizeObserver(() => this.render());
    this.ro.observe(this.page);
  }

  mount(parent) {
    parent.append(this.el);
    this.render();
    // a new, empty note: start typing straight away
    if (!this.ta.value) setTimeout(() => this.ta.focus({ preventScroll: true }), 60);
  }

  resize() { this.render(); }

  // ---------------------------------------------------------------- input --

  // Enter continues a list; Enter on an empty list item ends the list (like Keep)
  onBeforeInput(e) {
    if (e.inputType !== 'insertLineBreak' && e.inputType !== 'insertParagraph') return;
    if (this.listEnter()) e.preventDefault();
  }

  onKey(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !('onbeforeinput' in this.ta)) { if (this.listEnter()) e.preventDefault(); }
    if (e.key === 'Tab' && !e.shiftKey && this.firstChip) { e.preventDefault(); this.firstChip(); }
    if (e.key === 'Escape') this.ta.blur();
  }

  listEnter() {
    const ta = this.ta;
    if (ta.selectionStart !== ta.selectionEnd) return false;
    const pos = ta.selectionStart, v = ta.value;
    const ls = v.lastIndexOf('\n', pos - 1) + 1;
    const line = v.slice(ls, pos);
    const m = MARKER.exec(line);
    if (!m) return false;
    if (line.length === m[0].length && v.slice(pos, (v.indexOf('\n', pos) + 1 || v.length + 1) - 1).trim() === '') {
      // empty item: remove the marker, end the list
      ta.setSelectionRange(ls, pos);
      try { document.execCommand('delete'); } catch {}
      if (ta.value.slice(ls, pos) === line) ta.setRangeText('', ls, pos, 'end');
      ta.setSelectionRange(ls, ls);
      this.changed();
      return true;
    }
    let next = m[2];
    if (next === '☑ ') next = '☐ ';
    if (m[3]) next = (parseInt(m[3], 10) + 1) + m[4] + ' ';
    this.insert('\n' + m[1] + next);
    return true;
  }

  onInput() {
    // "- " / "* " → bullet, "[] " → checkbox, at the start of a line
    const ta = this.ta, pos = ta.selectionStart, v = ta.value;
    const ls = v.lastIndexOf('\n', pos - 1) + 1;
    const head = v.slice(ls, pos);
    const rep = head === '- ' || head === '* ' ? '• ' : head === '[] ' || head === '[ ] ' ? '☐ ' : null;
    if (rep) { ta.setSelectionRange(ls, pos); this.insert(rep); }
    this.changed();
  }

  // tap on ☐ / ☑ ticks it
  onTap() {
    const ta = this.ta;
    if (ta.selectionStart !== ta.selectionEnd) return;
    const pos = ta.selectionStart, v = ta.value;
    const ls = v.lastIndexOf('\n', pos - 1) + 1;
    const lead = /^\s*/.exec(v.slice(ls))[0].length;
    const box = v[ls + lead];
    if ((box === '☐' || box === '☑') && pos - (ls + lead) <= 2) {
      ta.setSelectionRange(ls + lead, ls + lead + 1);
      this.insert(box === '☐' ? '☑' : '☐');
      const end = (v.indexOf('\n', ls) + 1 || v.length + 1) - 1;
      ta.setSelectionRange(end, end);
      ta.blur(); // don't pop the keyboard up just to tick an item
    }
    this.renderChips();
  }

  // insert text at the selection, keeping the browser's undo history
  insert(text) {
    const ta = this.ta;
    ta.focus({ preventScroll: true });
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch {}
    if (!ok) ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
    this.changed();
  }

  exec(cmd) { this.ta.focus({ preventScroll: true }); try { document.execCommand(cmd); } catch {} this.changed(); }

  toggleMarker(mk) {
    const ta = this.ta, v = ta.value;
    const a = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
    const b = (v.indexOf('\n', ta.selectionEnd) + 1 || v.length + 1) - 1;
    const lines = v.slice(a, b).split('\n');
    const has = lines.every((l) => (mk === '1. ' ? /^\s*\d+[.)] /.test(l) : l.trimStart().startsWith(mk === '☐ ' ? '☐ ' : mk) || (mk === '☐ ' && l.trimStart().startsWith('☑ '))));
    let n = 0;
    const out = lines.map((l) => {
      const bare = l.replace(MARKER, '$1');
      if (has) return bare;
      n++;
      const lead = /^\s*/.exec(bare)[0];
      return lead + (mk === '1. ' ? n + '. ' : mk) + bare.slice(lead.length);
    });
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(a, b);
    this.insert(out.join('\n'));
  }

  changed() {
    this.body.quick.text = this.ta.value;
    this.render();
    this.save();
  }

  // ---------------------------------------------------------------- render --

  render() {
    const ta = this.ta, text = ta.value;
    this.res = analyse(text);
    const M = this.mirror;
    M.textContent = '';
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const info = this.res.lines[i] || {};
      const row = h('div', { class: 'qn-line' + (info.done ? ' done' : '') + (info.total ? ' total' : '') });
      const m = MARKER.exec(line);
      if (m) {
        row.append(m[1], h('span', { class: 'qn-mk' + (m[2][0] === '☑' ? ' on' : '') }, m[2]));
        row.append(h('span', { class: 'qn-tx' }, line.slice(m[0].length)));
      } else row.append(h('span', { class: 'qn-tx' }, line || '​'));
      if (info.ghost) row.append(h('span', { class: 'qn-ghost' + (info.fill ? ' fill' : '') }, info.ghost.trim()));
      M.append(row);
    });
    // grow with the text (the page scrolls, not the text box)
    ta.style.height = 'auto';
    ta.style.height = Math.max(ta.scrollHeight, 220) + 'px';
    const items = lines.filter((l) => /^\s*[☐☑] /.test(l));
    const done = items.filter((l) => /^\s*☑ /.test(l)).length;
    const bits = [];
    if (items.length) bits.push(`${done}/${items.length} done`);
    const totals = this.res.blocks.filter((b) => b.count > 1);
    if (totals.length === 1) bits.push('Total ' + plainNum(totals[0].total));
    this.info.textContent = bits.join(' · ');
    this.info.hidden = !bits.length;
    this.renderChips();
  }

  // Suggestions for where the cursor is: fill in an answer, add a total…
  renderChips() {
    const C = this.chips, ta = this.ta, v = ta.value;
    if (!this.res) return;
    C.textContent = '';
    this.firstChip = null;
    const pos = ta.selectionStart;
    const li = v.slice(0, pos).split('\n').length - 1;
    const info = this.res.lines[li] || {};
    const chip = (label, fn, cls = '') => {
      const b = h('button', { class: 'qn-chip ' + cls, onPointerdown: (e) => e.preventDefault(), onClick: fn }, label);
      if (!this.firstChip) this.firstChip = fn;
      C.append(b);
    };
    if (info.fill) {
      const label = info.replace ? `Update total ${info.fill.replace(/^[\s=:]+/, '')}` : info.total ? `Total ${info.fill.replace(/^[\s=:]+/, '')}` : `= ${info.fill.trim()}`;
      chip(label, () => this.fillLine(li, info.fill, info.replace), 'primary');
    }
    // a list with amounts and no total yet: offer one
    const blk = this.res.blocks.find((b) => b.count > 1 && !b.hasTotal && li >= b.start && li <= b.end + 1);
    if (blk) chip(`Add total ${plainNum(blk.total)}`, () => this.addTotal(blk), info.fill ? '' : 'primary');
    if (!C.childElementCount) C.append(h('span', { class: 'qn-hint' }, v.trim() ? 'Type a sum like 120+80 — the answer shows up' : 'Lists: start a line with - or [ ]'));
  }

  // put the suggested answer on line li (or replace an outdated total)
  fillLine(li, fill, replace = false) {
    const v = this.ta.value;
    const starts = [0];
    for (let i = 0; i < v.length; i++) if (v[i] === '\n') starts.push(i + 1);
    const end = (v.indexOf('\n', starts[li]) + 1 || v.length + 1) - 1;
    const line = v.slice(starts[li], end);
    const keep = replace ? line.replace(/\s*[:=]?\s*[\d.,]+\s*$/, '') : line.replace(/\s+$/, '');
    this.ta.setSelectionRange(starts[li] + keep.length, end);
    this.insert(fill);
  }

  addTotal(blk) {
    const v = this.ta.value;
    const lines = v.split('\n');
    let at = 0;
    for (let i = 0; i <= blk.end; i++) at += lines[i].length + 1;
    at = Math.min(at - 1, v.length);
    this.ta.setSelectionRange(at, at);
    this.insert('\nTotal = ' + plainNum(blk.total));
  }

  caretIntoView() {
    const ta = this.ta;
    const li = ta.value.slice(0, ta.selectionStart).split('\n').length - 1;
    const row = this.mirror.children[li];
    if (!row) return;
    const r = row.getBoundingClientRect(), s = this.scroll.getBoundingClientRect();
    const vv = window.visualViewport;
    const bottom = Math.min(s.bottom, vv ? vv.height + vv.offsetTop - this.bar.offsetHeight : s.bottom);
    if (r.bottom > bottom - 8) this.scroll.scrollTop += r.bottom - bottom + 24;
    else if (r.top < s.top + 8) this.scroll.scrollTop -= s.top - r.top + 24;
  }

  // -------------------------------------------------------------- actions --

  text() { return (this.meta.title ? this.meta.title + '\n\n' : '') + this.ta.value; }

  async share() {
    this.save.flush();
    if (navigator.share) { try { await navigator.share({ title: this.meta.title, text: this.ta.value }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    this.copy();
  }

  async copy() {
    try { await navigator.clipboard.writeText(this.text()); toast('Copied'); } catch { toast('Could not copy'); }
  }

  moreMenu(anchor) {
    menu(anchor, [
      { label: 'Save to Google Drive', icon: 'nDrive', onClick: () => { this.save.flush(); saveToDrive(this.meta, this.body); } },
      { label: 'Copy text', icon: 'copy', onClick: () => this.copy() },
      { label: 'Download as .txt', icon: 'download', onClick: () => saveFile(new Blob([this.text()], { type: 'text/plain' }), safeName(this.meta.title) + '.txt') },
      { label: 'Clear ticked items', icon: 'check2', onClick: () => this.clearDone() },
      '-',
      { label: 'Delete note', icon: 'trash', danger: true, onClick: async () => {
        if (!(await confirmDialog('Delete this note?', 'It goes to Recently Deleted for 30 days.'))) return;
        await this.persist(); await trashNote(this.meta); this.closed = true; this.exit();
      } },
    ]);
  }

  clearDone() {
    const kept = this.ta.value.split('\n').filter((l) => !/^\s*☑ /.test(l)).join('\n');
    this.ta.focus({ preventScroll: true });
    this.ta.select();
    this.insert(kept);
  }

  toggleCalc() {
    if (this.calc) { this.calc.close(); return; }
    this.calc = new Calculator({
      parent: this.el,
      onInsert: (t) => { this.ta.focus({ preventScroll: true }); this.insert(t); },
      onClose: () => { this.calc = null; this.calcBtn.classList.remove('on'); },
    });
    this.calcBtn.classList.add('on');
  }

  // ----------------------------------------------------------------- save --

  async persist() {
    if (this.closed) return;
    this.body.quick.text = this.ta.value;
    try { await saveNote(this.meta, this.body); } catch (e) { toast('Could not save: ' + (e.message || e)); }
  }

  async flushSave() { this.save.cancel(); await this.persist(); }

  isBusy() { return document.activeElement === this.ta; }

  // edited on another device: take it unless we are typing right now
  applyRemote(meta, body) {
    if (document.activeElement === this.ta) return false;
    Object.assign(this.meta, meta);
    this.body.quick = body.quick || { text: '' };
    this.ta.value = this.body.quick.text;
    this.titleIn.value = this.meta.title;
    this.render();
    return true;
  }

  async exit() {
    this.save.cancel();
    if (!this.closed) {
      // an untouched new quick note is not kept
      if (!this.ta.value.trim() && (!this.meta.title || /^Quick note/.test(this.meta.title)) && Date.now() - this.meta.created < 10 * 60e3) {
        await deleteForever(this.meta.id).catch(() => {});
      } else await this.persist();
    }
    this.destroy();
    this.onExit();
  }

  destroy() {
    if (this.calc) this.calc.close();
    document.removeEventListener('selectionchange', this.onSel);
    document.removeEventListener('visibilitychange', this.onVis);
    if (window.visualViewport) { visualViewport.removeEventListener('resize', this.onVV); visualViewport.removeEventListener('scroll', this.onVV); }
    this.ro.disconnect();
    this.el.remove();
  }
}
