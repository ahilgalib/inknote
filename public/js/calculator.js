// Floating calculator for the note editor: Basic and Scientific modes,
// live answer while typing, history, copy, and "insert into note".
import { h, clamp, toast } from './util.js';
import { icons } from './icons.js';
import { evaluate, pretty, plain, openBrackets } from './calc-engine.js';

const KEY = 'inknote.calc';
const BIN = ['+', '−', '×', '÷', '^'];

function load() {
  try { return { mode: 'basic', deg: true, history: [], pos: null, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; }
  catch { return { mode: 'basic', deg: true, history: [], pos: null }; }
}

export class Calculator {
  constructor({ parent, onInsert, onClose }) {
    this.st = load();
    this.parent = parent;
    this.onInsert = onInsert;
    this.onClose = onClose;
    this.expr = '';
    this.prev = '';        // "12×3 =" shown above after "="
    this.done = false;     // just pressed "=": typing a digit starts fresh
    this.second = false;   // 2nd: inverse functions
    this.ans = this.st.history[0] ? this.st.history[0].v : 0;
    this.build();
  }

  save() {
    const { mode, deg, history, pos } = this.st;
    try { localStorage.setItem(KEY, JSON.stringify({ mode, deg, history: history.slice(0, 30), pos })); } catch {}
  }

  // ------------------------------------------------------------------ DOM --

  build() {
    const seg = (v, l) => h('button', { class: 'calc-seg' + (this.st.mode === v ? ' on' : ''), 'data-mode': v, onClick: () => this.setMode(v) }, l);
    this.histBtn = h('button', { class: 'calc-ib', title: 'History', 'aria-label': 'History', html: icons.nHistory, onClick: () => this.toggleHistory() });
    this.head = h('div', { class: 'calc-head' },
      h('div', { class: 'calc-segs', role: 'tablist' }, seg('basic', 'Basic'), seg('sci', 'Scientific')),
      h('div', { class: 'grow' }),
      this.histBtn,
      h('button', { class: 'calc-ib', title: 'Close (Esc)', 'aria-label': 'Close calculator', html: icons.close, onClick: () => this.close() }));

    this.prevEl = h('div', { class: 'calc-prev' });
    this.exprEl = h('div', { class: 'calc-expr', 'aria-live': 'polite' });
    this.liveEl = h('div', { class: 'calc-live' });
    this.copyBtn = h('button', { class: 'calc-chip', title: 'Copy answer', onClick: () => this.copy() }, h('span', { html: icons.copy }), 'Copy');
    this.insBtn = h('button', { class: 'calc-chip', title: 'Put this calculation on the page', onClick: () => this.insert() }, h('span', { html: icons.plus }), 'Add to note');
    this.display = h('div', { class: 'calc-display' }, this.prevEl, this.exprEl,
      h('div', { class: 'calc-row' }, this.liveEl, h('div', { class: 'grow' }), this.copyBtn, this.insBtn));

    this.histEl = h('div', { class: 'calc-hist', hidden: true });
    this.sciEl = h('div', { class: 'calc-keys sci' });
    this.basicEl = h('div', { class: 'calc-keys basic' });
    this.el = h('div', { class: 'calc', tabindex: '-1', role: 'dialog', 'aria-label': 'Calculator' },
      this.head, this.display, this.histEl, this.sciEl, this.basicEl);

    this.renderKeys();
    this.bindDrag();
    // keys typed while the calculator has focus never reach the note
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    this.el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (!e.target.closest('input')) { e.preventDefault(); this.el.focus({ preventScroll: true }); }
    });
    this.parent.append(this.el);
    this.applyMode();
    this.place();
    this.render();
    requestAnimationFrame(() => this.el.focus({ preventScroll: true }));
  }

  key(label, fn, cls = '', title) {
    const b = h('button', { class: 'ck ' + cls, title: title || undefined, 'aria-label': title || label });
    b.innerHTML = `<span>${label}</span>`;
    b.addEventListener('click', () => { fn(); this.render(); });
    return b;
  }

  renderKeys() {
    const k = (l, fn, cls, t) => this.key(l, fn, cls, t);
    const ins = (s) => () => this.input(s);
    const two = this.second;
    this.sciEl.innerHTML = '';
    this.sciEl.append(
      k('2<sup>nd</sup>', () => { this.second = !this.second; this.renderKeys(); }, 'fn' + (two ? ' on' : ''), 'Second functions'),
      k(this.st.deg ? 'deg' : 'rad', () => { this.st.deg = !this.st.deg; this.save(); this.renderKeys(); }, 'fn mode', 'Degrees / radians'),
      k('(', ins('('), 'fn'), k(')', ins(')'), 'fn'),
      k('Ans', ins('Ans'), 'fn', 'Last answer'),
      k(two ? 'sin<sup>−1</sup>' : 'sin', ins(two ? 'sin⁻¹(' : 'sin('), 'fn'),
      k(two ? 'cos<sup>−1</sup>' : 'cos', ins(two ? 'cos⁻¹(' : 'cos('), 'fn'),
      k(two ? 'tan<sup>−1</sup>' : 'tan', ins(two ? 'tan⁻¹(' : 'tan('), 'fn'),
      k(two ? 'e<sup>x</sup>' : 'ln', ins(two ? 'e^(' : 'ln('), 'fn'),
      k(two ? '10<sup>x</sup>' : 'log', ins(two ? '10^(' : 'log('), 'fn'),
      k('x<sup>2</sup>', ins('²'), 'fn', 'Square'),
      k('x<sup>3</sup>', ins('³'), 'fn', 'Cube'),
      k('x<sup>y</sup>', ins('^'), 'fn', 'Power'),
      k(two ? '∛' : '√', ins(two ? '∛(' : '√('), 'fn', two ? 'Cube root' : 'Square root'),
      k('|x|', ins('abs('), 'fn', 'Absolute value'),
      k('π', ins('π'), 'fn'), k('e', ins('e'), 'fn'),
      k('n!', ins('!'), 'fn', 'Factorial'),
      k('1/x', () => this.reciprocal(), 'fn', 'Reciprocal'),
      k('EE', ins('E'), 'fn', '×10 to the power'));
    this.basicEl.innerHTML = '';
    this.acKey = k('⌫', () => this.back(), 'util', 'Delete (hold to clear)');
    this.basicEl.append(
      k('AC', () => this.clear(), 'util', 'Clear'), this.acKey, k('%', ins('%'), 'util', 'Percent'), k('÷', ins('÷'), 'op'),
      k('7', ins('7')), k('8', ins('8')), k('9', ins('9')), k('×', ins('×'), 'op'),
      k('4', ins('4')), k('5', ins('5')), k('6', ins('6')), k('−', ins('−'), 'op'),
      k('1', ins('1')), k('2', ins('2')), k('3', ins('3')), k('+', ins('+'), 'op'),
      k('±', () => this.negate(), '', 'Change sign'), k('0', ins('0')), k('.', ins('.')), k('=', () => this.equals(), 'eq', 'Equals'));
    // long-press ⌫ clears everything
    let t;
    this.acKey.addEventListener('pointerdown', () => { t = setTimeout(() => { this.clear(); this.render(); t = 'fired'; }, 500); });
    this.acKey.addEventListener('pointerup', () => clearTimeout(t));
    this.acKey.addEventListener('pointerleave', () => clearTimeout(t));
    this.acKey.addEventListener('click', (e) => { if (t === 'fired') { e.stopImmediatePropagation(); t = null; } }, true);
  }

  setMode(m) {
    this.st.mode = m;
    this.save();
    this.applyMode();
    this.place();
  }

  applyMode() {
    this.el.classList.toggle('is-sci', this.st.mode === 'sci');
    for (const b of this.head.querySelectorAll('.calc-seg')) b.classList.toggle('on', b.dataset.mode === this.st.mode);
  }

  // ---------------------------------------------------------------- input --

  lastNumber() { const m = /(\d+\.?\d*(E[−]?\d*)?|\.\d+)$/.exec(this.expr); return m ? m[0] : ''; }

  input(s) {
    const isNum = /^[\d.]$/.test(s) || s === 'E';
    if (this.done) {
      // after "=": a number starts again, an operator carries on with the answer
      if (isNum || s === 'π' || s === 'e' || s.endsWith('(') || s === 'Ans') this.expr = '';
      this.done = false;
      this.prev = '';
    }
    const e = this.expr, last = e.slice(-1);
    if (BIN.includes(s) || s === '%' || s === '!' || s === '²' || s === '³') {
      if (!e) {
        if (s === '−') { this.expr = '−'; return; }
        if (!this.st.history.length) return;
        this.expr = plain(this.ans);
      } else if (BIN.includes(last) && BIN.includes(s)) {
        // replace the operator (but "×−" is allowed for a negative number)
        if (s === '−' && last !== '−' && last !== '+') { this.expr += s; return; }
        this.expr = e.slice(0, -1).replace(/[×÷^]$/, '');
        if (!this.expr) return;
      } else if (last === '(' && s !== '−') return;
    }
    if (s === '.') {
      const n = this.lastNumber();
      if (n.includes('.') || n.includes('E')) return;
      if (!n) s = '0.';
    }
    if (s === 'E' && (!this.lastNumber() || this.lastNumber().includes('E'))) return;
    if (s === ')' && openBrackets(this.expr) === 0) return;
    if (/^\d$/.test(s) && /(^|[^\d.])0$/.test(e) && !/E[−]?0$/.test(e)) this.expr = e.slice(0, -1); // no "007"
    this.expr += s;
  }

  back() {
    if (this.done) { this.clear(); return; }
    // remove a whole function name at once ("sin(" , "Ans")
    const m = /(sin⁻¹\(|cos⁻¹\(|tan⁻¹\(|sinh\(|cosh\(|tanh\(|sin\(|cos\(|tan\(|log\(|ln\(|abs\(|√\(|∛\(|Ans|0\.)$/.exec(this.expr);
    this.expr = this.expr.slice(0, -(m ? m[0].length : 1));
  }

  clear() { this.expr = ''; this.prev = ''; this.done = false; }

  negate() {
    if (this.done) { this.done = false; this.prev = ''; }
    const e = this.expr;
    let m;
    if (!e) this.expr = '−';
    else if ((m = /\(−([\d.E−]+)\)$/.exec(e))) this.expr = e.slice(0, -m[0].length) + m[1];
    else if ((m = /^−([\d.E−]+)$/.exec(e))) this.expr = m[1];
    else if (/^[\d.E]+$/.test(e)) this.expr = '−' + e;
    else if ((m = /([\d.]+(E−?\d+)?|π|e)$/.exec(e))) this.expr = e.slice(0, -m[0].length) + '(−' + m[0] + ')';
  }

  reciprocal() {
    const v = this.value();
    if (v == null) return;
    this.prev = `1÷(${this.expr}) =`;
    this.finish(1 / v, `1÷(${this.expr})`);
  }

  value() {
    if (!this.expr) return null;
    try {
      const v = evaluate(this.expr + ')'.repeat(openBrackets(this.expr)), { deg: this.st.deg, ans: this.ans });
      return typeof v === 'number' ? v : null;
    } catch { return null; }
  }

  equals() {
    if (!this.expr || this.done) return;
    const v = this.value();
    if (v == null) { this.shake('Check the calculation'); return; }
    const full = this.expr + ')'.repeat(openBrackets(this.expr));
    this.prev = full + ' =';
    this.finish(v, full);
  }

  finish(v, exprText) {
    if (!isFinite(v)) { this.shake(Number.isNaN(v) ? 'Undefined' : 'Can’t divide by zero'); this.prev = ''; return; }
    this.ans = v;
    this.st.history.unshift({ e: exprText, v });
    this.st.history = this.st.history.slice(0, 30);
    this.save();
    this.expr = plain(v);
    this.done = true;
    if (!this.histEl.hidden) this.renderHistory();
  }

  shake(msg) {
    this.liveEl.textContent = msg;
    this.liveEl.classList.add('err');
    this.display.classList.remove('shake');
    void this.display.offsetWidth;
    this.display.classList.add('shake');
    clearTimeout(this.errT);
    this.errT = setTimeout(() => { this.liveEl.classList.remove('err'); this.render(); }, 1400);
  }

  // --------------------------------------------------------------- render --

  render() {
    const e = this.expr;
    this.prevEl.textContent = this.prev || ' ';
    this.exprEl.innerHTML = '';
    const shown = this.done ? pretty(Number(e.replace(/−/g, '-').replace('E', 'e'))) : (e || '0');
    this.exprEl.append(document.createTextNode(shown));
    const open = this.done ? 0 : openBrackets(e);
    if (open) this.exprEl.append(h('span', { class: 'ghost' }, ')'.repeat(open)));
    this.exprEl.classList.toggle('empty', !e);
    this.exprEl.classList.toggle('result', this.done);
    // shrink long numbers so they always fit
    const len = shown.length + open;
    this.exprEl.style.fontSize = (len > 22 ? 20 : len > 16 ? 26 : len > 11 ? 32 : 38) + 'px';
    this.exprEl.scrollLeft = this.exprEl.scrollWidth;

    const v = this.done ? null : this.value();
    const showLive = v != null && isFinite(v) && !/^[−]?[\d.]+$/.test(e);
    if (!this.liveEl.classList.contains('err')) this.liveEl.textContent = showLive ? '= ' + pretty(v) : '';
    const hasAnswer = this.done || showLive;
    this.copyBtn.hidden = this.insBtn.hidden = !hasAnswer;
  }

  toggleHistory() {
    this.histEl.hidden = !this.histEl.hidden;
    this.histBtn.classList.toggle('on', !this.histEl.hidden);
    this.el.classList.toggle('hist-open', !this.histEl.hidden);
    if (!this.histEl.hidden) this.renderHistory();
  }

  renderHistory() {
    const H = this.histEl;
    H.innerHTML = '';
    if (!this.st.history.length) { H.append(h('p', { class: 'calc-empty' }, 'Your calculations will appear here.')); return; }
    for (const it of this.st.history) {
      H.append(h('button', { class: 'calc-hrow', title: 'Use this answer', onClick: () => {
        if (this.done || !this.expr || BIN.includes(this.expr.slice(-1)) || this.expr.endsWith('(')) {
          if (this.done) { this.expr = ''; this.done = false; this.prev = ''; }
          this.expr += plain(it.v);
        } else { this.expr = plain(it.v); }
        this.toggleHistory();
        this.render();
      } }, h('span', { class: 'calc-he' }, it.e), h('b', {}, pretty(it.v))));
    }
    H.append(h('button', { class: 'calc-hclear', onClick: () => { this.st.history = []; this.save(); this.renderHistory(); } }, 'Clear history'));
  }

  // -------------------------------------------------------------- actions --

  answer() {
    if (this.done) return { e: this.prev.replace(/ =$/, ''), v: this.ans };
    const v = this.value();
    return v != null && isFinite(v) ? { e: this.expr + ')'.repeat(openBrackets(this.expr)), v } : null;
  }

  async copy() {
    const a = this.answer();
    if (!a) return;
    try { await navigator.clipboard.writeText(plain(a.v).replace(/−/g, '-')); toast('Copied ' + pretty(a.v)); }
    catch { toast('Could not copy'); }
  }

  insert() {
    const a = this.answer();
    if (!a) return;
    this.onInsert(a.e ? `${a.e} = ${pretty(a.v)}` : pretty(a.v));
  }

  close() {
    this.el.remove();
    this.onClose && this.onClose();
  }

  onKey(e) {
    e.stopPropagation();
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (mod && k.toLowerCase() === 'c') { e.preventDefault(); this.copy(); return; }
    if (mod && k.toLowerCase() === 'v') {
      e.preventDefault();
      navigator.clipboard.readText().then((t) => { for (const c of t.replace(/\s/g, '')) this.typeChar(c); this.render(); }).catch(() => {});
      return;
    }
    if (mod) return;
    if (k === 'Escape') { e.preventDefault(); if (this.expr) this.clear(); else this.close(); this.render(); return; }
    if (k === 'Enter' || k === '=') { e.preventDefault(); this.equals(); this.render(); return; }
    if (k === 'Backspace') { e.preventDefault(); this.back(); this.render(); return; }
    if (k === 'Delete') { e.preventDefault(); this.clear(); this.render(); return; }
    if (k.length === 1 && this.typeChar(k)) { e.preventDefault(); this.render(); }
  }

  // keyboard / paste → calculator input; returns true if the key was used
  typeChar(c) {
    const map = { '*': '×', 'x': '×', '/': '÷', ':': '÷', '-': '−', 'p': 'π', 'e': 'e', 's': 'sin(', 'c': 'cos(', 't': 'tan(', 'l': 'ln(', 'g': 'log(', 'r': '√(', 'a': 'Ans' };
    const s = map[c.toLowerCase()] || c;
    if (/^[\d.+−×÷^()%!πe]$/.test(s) || s.length > 1) { this.input(s); return true; }
    return false;
  }

  // ------------------------------------------------------- drag & position --

  place() {
    const P = this.parent.getBoundingClientRect();
    if (P.width < 600) { this.el.classList.add('docked'); this.el.style.left = this.el.style.top = ''; return; }
    this.el.classList.remove('docked');
    const w = this.el.offsetWidth, hh = this.el.offsetHeight;
    const pos = this.st.pos || { x: P.width - w - 20, y: 64 };
    this.el.style.left = clamp(pos.x, 8, Math.max(8, P.width - w - 8)) + 'px';
    this.el.style.top = clamp(pos.y, 8, Math.max(8, P.height - hh - 8)) + 'px';
  }

  bindDrag() {
    let d = null;
    this.head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button') || this.el.classList.contains('docked')) return;
      d = { x: e.clientX, y: e.clientY, l: this.el.offsetLeft, t: this.el.offsetTop };
      this.head.setPointerCapture(e.pointerId);
      this.el.classList.add('dragging');
    });
    this.head.addEventListener('pointermove', (e) => {
      if (!d) return;
      this.st.pos = { x: d.l + e.clientX - d.x, y: d.t + e.clientY - d.y };
      this.place();
    });
    const end = () => { if (d) { d = null; this.el.classList.remove('dragging'); this.save(); } };
    this.head.addEventListener('pointerup', end);
    this.head.addEventListener('pointercancel', end);
  }
}
