// Smart maths for quick notes: every line is checked as you type.
//  "120 + 250 * 2"        → shows  = 620
//  "Rice 2 x 60 ="        → shows  120  (tap the suggestion to fill it in)
//  "Rice 120", "Oil 250"  → amounts; a block of them gets a total
//  "Total"                → shows the total of the list above it
// Bangla digits, thousands commas and currency words (tk, ৳, টাকা) are understood.
import { evaluate, pretty } from './calc-engine.js';

const BN = '০১২৩৪৫৬৭৮৯';
const MARKER = /^(\s*)(• |☐ |☑ |- |\* |\d+[.)] )/;
const TOTAL = /^\s*(total|sum|grand total|subtotal|মোট|সর্বমোট|সব মিলিয়ে)\s*([:=]?)\s*([\d.,]*)\s*$/i;
const CURRENCY = /(tk\.?|taka|৳|টাকা|bdt|rs\.?|\$|usd|€|£)/gi;

function normalize(s) {
  return s
    .replace(/[০-৯]/g, (d) => String(BN.indexOf(d)))
    .replace(CURRENCY, ' ')
    .replace(/(\d),(?=\d{3}(\D|$))/g, '$1')        // 1,200 → 1200
    .replace(/(\d)\s*[xX]\s*(?=[\d(])/g, '$1×');      // 12 x 10 → 12×10
}

function calc(expr) {
  try {
    const v = evaluate(expr.trim(), { deg: true });
    return typeof v === 'number' && isFinite(v) ? v : null;
  } catch { return null; }
}

const OP = /[+\-−×÷*/^%]/;
// The maths at the end of a line ("Rice 2 x 60" → "2×60"), or null.
function trailingMath(s) {
  const m = /[\d.()+\-−×÷*/^%\s√π]+$/.exec(s);
  if (!m) return null;
  let t = m[0].trim();
  // "Rice 2 120*2": two numbers with only a space between them → keep the last part
  const parts = t.split(/(?<=[\d)])\s+(?=[\d(√])/);
  t = parts[parts.length - 1].replace(/^[+\-−×÷*/^%\s]+(?=\d|\()/, (x) => (x.trim() === '-' || x.trim() === '−' ? '−' : ''));
  return /\d/.test(t) ? t : null;
}

// Analyse every line. Returns { lines: [{ ghost, amount, fill, total, done }], blocks: [{ end, total, count, hasTotal }] }
export function analyse(text) {
  const raw = text.split('\n');
  const lines = [];
  const blocks = [];
  let cur = null;
  const close = () => { if (cur && cur.count) blocks.push(cur); cur = null; };
  raw.forEach((line, i) => {
    const info = { ghost: '', amount: null, fill: '', total: false, done: /^\s*☑ /.test(line) };
    const body = normalize(line.replace(MARKER, ''));
    const trimmed = body.trim();
    if (!trimmed) { lines.push(info); close(); return; }

    const tm = TOTAL.exec(trimmed);
    if (tm) {
      // a "Total" line: shows the sum of the list above; a written total that
      // no longer matches (an item changed) offers the new one
      info.total = true;
      if (cur && cur.count) {
        const written = tm[3] ? parseFloat(tm[3].replace(/,/g, '')) : null;
        if (written == null) {
          info.ghost = (tm[2] ? ' ' : ' = ') + pretty(cur.total);
          info.fill = (tm[2] ? ' ' : ' = ') + plainNum(cur.total);
        } else if (Math.abs(written - cur.total) > 1e-9) {
          info.ghost = '  → ' + pretty(cur.total);
          info.fill = (tm[2] ? (tm[2] === '=' ? ' = ' : ': ') : ' = ') + plainNum(cur.total);
          info.replace = true;
        }
        cur.hasTotal = true;
        cur.end = i;
      }
      lines.push(info);
      close();
      return;
    }

    if (/=\s*$/.test(trimmed)) {
      // "something =" → offer the answer
      const ex = trailingMath(trimmed.replace(/=\s*$/, ''));
      const v = ex && calc(ex);
      if (v != null) { info.ghost = ' ' + pretty(v); info.fill = (/\s$/.test(line) ? '' : ' ') + plainNum(v); }
      lines.push(info);
      return;
    }

    // "... = 620" already written: count the answer as the amount
    const eq = /=\s*([\d.,]+)\s*$/.exec(trimmed);
    const ex = eq ? eq[1].replace(/,/g, '') : trailingMath(trimmed);
    const v = ex && calc(ex);
    const hasLabel = /[^\d\s.,()+\-−×÷*/^%=√π]/.test(trimmed.replace(ex || '', ''));
    if (v != null) {
      if (!eq && OP.test(ex.replace(/^−/, ''))) info.ghost = ' = ' + pretty(v);
      // a number on a list line ("Rice 120") or a sum on its own counts towards the total
      if (hasLabel || OP.test(ex) || eq) {
        info.amount = v;
        if (!cur) cur = { start: i, end: i, total: 0, count: 0, hasTotal: false };
        cur.total += v; cur.count++; cur.end = i;
      }
    }
    lines.push(info);
  });
  close();
  return { lines, blocks };
}

export function plainNum(v) { return pretty(v).replace(/−/g, '-'); }
