// PDF import (via the bundled pdf.js, loaded on demand) and a tiny PDF writer for export.

const PDFJS = new URL('../vendor/pdfjs/', import.meta.url).href;
let pdfjsPromise;

function loadPdfJs() {
  if (pdfjsPromise) return pdfjsPromise;
  pdfjsPromise = new Promise((resolve, reject) => {
    if (window.pdfjsLib) return resolve(window.pdfjsLib);
    const s = document.createElement('script');
    s.src = PDFJS + 'pdf.min.js';
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
      resolve(window.pdfjsLib);
    };
    s.onerror = () => { pdfjsPromise = null; reject(new Error('Could not load the PDF reader.')); };
    document.head.append(s);
  });
  return pdfjsPromise;
}

// Render every page of a PDF file to JPEG blobs.
// Returns [{ blob, w, h }] where w/h are page size in CSS px (96 dpi).
export async function importPDF(file, onProgress) {
  const lib = await loadPdfJs();
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await lib.getDocument({ data }).promise;
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const base = page.getViewport({ scale: 96 / 72 });
    // render around 1700px wide – sharp on iPad, still small on disk
    const scale = Math.min(3, 1700 / base.width) * (96 / 72);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.86));
    out.push({ blob, w: Math.round(base.width), h: Math.round(base.height) });
    canvas.width = canvas.height = 0;
    page.cleanup();
    onProgress && onProgress(i, pdf.numPages);
  }
  pdf.destroy();
  return out;
}

// pages: [{ jpeg: Uint8Array, iw, ih, w, h }] – w/h in PDF points.
export function buildPDF(pages) {
  const enc = new TextEncoder();
  const chunks = [];
  let offset = 0;
  const offsets = [];
  const push = (d) => { const b = typeof d === 'string' ? enc.encode(d) : d; chunks.push(b); offset += b.length; };
  const obj = (n, body) => { offsets[n] = offset; push(`${n} 0 obj\n`); body(); push('\nendobj\n'); };

  push('%PDF-1.4\n%âãÏÓ\n');
  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`));
  pages.forEach((p, i) => {
    const pn = 3 + i * 3, cn = pn + 1, im = pn + 2;
    const W = p.w.toFixed(2), H = p.h.toFixed(2);
    obj(pn, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${im} 0 R >> >> /Contents ${cn} 0 R >>`));
    const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
    obj(cn, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
    obj(im, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${p.iw} /Height ${p.ih} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
      push(p.jpeg);
      push('\nendstream');
    });
  });
  const n = 3 + pages.length * 3;
  const xref = offset;
  let x = `xref\n0 ${n}\n0000000000 65535 f \n`;
  for (let i = 1; i < n; i++) x += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  push(x);
  push(`trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  return new Blob(chunks, { type: 'application/pdf' });
}
