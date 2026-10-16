// Calculator maths: a small, safe expression parser (no eval).
// Understands + − × ÷ ^ % ! ( ), implicit multiplication (2π, 3(4+1)),
// functions (sin cos tan sin⁻¹ … ln log √ ∛ abs), constants π e and Ans.
// Missing closing brackets at the end are fine: "2×(3+4" = 14.

const FUNCS = {
  'sin': (x, deg) => Math.sin(deg ? x * Math.PI / 180 : x),
  'cos': (x, deg) => Math.cos(deg ? x * Math.PI / 180 : x),
  'tan': (x, deg) => {
    if (deg && Math.abs(x % 180) === 90) return NaN; // tan 90° is undefined
    return Math.tan(deg ? x * Math.PI / 180 : x);
  },
  'sin⁻¹': (x, deg) => (deg ? 180 / Math.PI : 1) * Math.asin(x),
  'cos⁻¹': (x, deg) => (deg ? 180 / Math.PI : 1) * Math.acos(x),
  'tan⁻¹': (x, deg) => (deg ? 180 / Math.PI : 1) * Math.atan(x),
  'sinh': Math.sinh, 'cosh': Math.cosh, 'tanh': Math.tanh,
  'ln': Math.log, 'log': Math.log10, 'log₂': Math.log2,
  '√': Math.sqrt, '∛': Math.cbrt, 'abs': Math.abs,
};
const FUNC_NAMES = Object.keys(FUNCS).sort((a, b) => b.length - a.length);
const OPS = '+−-×*÷/^%!()';

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ') { i++; continue; }
    // number, optionally with an exponent: 1.5E-3
    const m = /^(\d+\.?\d*|\.\d+)(E[+−-]?\d+)?/.exec(src.slice(i));
    if (m) { out.push({ t: 'num', v: parseFloat(m[0].replace('−', '-')) }); i += m[0].length; continue; }
    if (src.startsWith('Ans', i)) { out.push({ t: 'ans' }); i += 3; continue; }
    if (c === 'π') { out.push({ t: 'num', v: Math.PI }); i++; continue; }
    if (c === 'e') { out.push({ t: 'num', v: Math.E }); i++; continue; }
    if (c === '²' || c === '³') { out.push({ t: 'op', v: '^' }, { t: 'num', v: c === '²' ? 2 : 3 }); i++; continue; }
    const f = FUNC_NAMES.find((n) => src.startsWith(n, i));
    if (f) { out.push({ t: 'fn', v: f }); i += f.length; continue; }
    if (OPS.includes(c)) {
      const v = c === '-' ? '−' : c === '*' ? '×' : c === '/' ? '÷' : c;
      out.push({ t: 'op', v });
      i++;
      continue;
    }
    throw new Error('Unknown symbol ' + c);
  }
  return out;
}

function factorial(n) {
  if (n < 0 || !Number.isInteger(n)) return gamma(n + 1);
  if (n > 170) return Infinity;
  let r = 1;
  for (let k = 2; k <= n; k++) r *= k;
  return r;
}
// Lanczos approximation (factorial of decimals, like a scientific calculator)
function gamma(z) {
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gamma(1 - z));
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
}

export function evaluate(src, { deg = true, ans = 0 } = {}) {
  const T = tokenize(src);
  let i = 0;
  const peek = () => T[i];
  const isOp = (v) => T[i] && T[i].t === 'op' && T[i].v === v;
  // can the next token start a value? (for implicit multiplication)
  const startsValue = () => { const k = T[i]; return k && (k.t === 'num' || k.t === 'ans' || k.t === 'fn' || (k.t === 'op' && k.v === '(')); };

  function expr() {
    let a = term();
    while (isOp('+') || isOp('−')) {
      const op = T[i++].v;
      const b = term();
      // 50 + 10% = 55 (percent of the left side, like a pocket calculator)
      const bv = b.pct ? a.v * b.v : b.v;
      a = { v: op === '+' ? a.v + bv : a.v - bv };
    }
    return a;
  }
  function term() {
    let a = unary();
    for (;;) {
      if (isOp('×') || isOp('÷')) {
        const op = T[i++].v;
        const b = unary();
        a = { v: op === '×' ? a.v * b.v : a.v / b.v };
      } else if (startsValue()) {
        a = { v: a.v * unary().v };
      } else return a;
    }
  }
  function unary() {
    if (isOp('−')) { i++; const r = unary(); return { v: -r.v, pct: r.pct }; }
    if (isOp('+')) { i++; return unary(); }
    return power();
  }
  function power() {
    const base = postfix();
    if (isOp('^')) { i++; const e = unary(); return { v: Math.pow(base.v, e.v) }; }
    return base;
  }
  function postfix() {
    let a = primary();
    for (;;) {
      if (isOp('!')) { i++; a = { v: factorial(a.v) }; }
      else if (isOp('%')) { i++; a = { v: a.v / 100, pct: true }; }
      else return a;
    }
  }
  function primary() {
    const k = peek();
    if (!k) throw new Error('Incomplete');
    if (k.t === 'num') { i++; return { v: k.v }; }
    if (k.t === 'ans') { i++; return { v: ans }; }
    if (k.t === 'fn') {
      i++;
      // "sin 30" works as well as "sin(30)"
      const arg = isOp('(') ? primary() : power();
      return { v: FUNCS[k.v](arg.v, deg) };
    }
    if (isOp('(')) {
      i++;
      const r = expr();
      if (isOp(')')) i++;
      else if (i < T.length) throw new Error('Missing )');
      return { v: r.v };
    }
    throw new Error('Unexpected ' + k.v);
  }

  const r = expr();
  if (i < T.length) throw new Error('Unexpected ' + T[i].v);
  return r.v;
}

// How many "(" are still open (shown as faint brackets while typing).
export function openBrackets(src) {
  let n = 0;
  for (const c of src) { if (c === '(') n++; else if (c === ')' && n > 0) n--; }
  return n;
}

// Plain number text for further calculation ("0.30000000000000004" → "0.3").
export function plain(v) {
  if (!isFinite(v)) return String(v);
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e15 || a < 1e-9) return v.toExponential(10).replace(/\.?0+e/, 'e').replace('e+', 'E').replace('e-', 'E−');
  return String(Number(v.toPrecision(12))).replace('-', '−');
}

// Number for display: 1,234,567.89 · 1.2345×10¹⁵
const SUP = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '−': '⁻' };
export function pretty(v) {
  if (Number.isNaN(v)) return 'Undefined';
  if (!isFinite(v)) return v > 0 ? '∞' : '−∞';
  const s = plain(v);
  if (s.includes('E')) {
    const [m, e] = s.split('E');
    return m + '×10' + [...e].map((c) => SUP[c] || c).join('');
  }
  const neg = s.startsWith('−');
  const [int, frac] = (neg ? s.slice(1) : s).split('.');
  return (neg ? '−' : '') + int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? '.' + frac : '');
}
