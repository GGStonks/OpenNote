import { openPdfBytes } from './pdf';

/**
 * Where a print puts the page (iOS): WebKit's print formatter, run without the print dialog
 * (ios-native handlePdfPage), may scale the print layout or move it on the sheet. A calibration
 * print (two pages of the size, each with two black marks at known places, Editor's print layout)
 * shows how: printed position = s x laid-out position + d (pt, from the sheet's top-left corner),
 * and the PDF export draws each printed page through the inverse (pdfExport.ts), so the ink lands
 * where it was drawn on the original PDF page. A print that loses part of the page, or places its
 * pages differently, is not used: the export falls back to the print dialog.
 */

export interface PrintFix {
  sx: number;
  sy: number;
  dx: number;
  dy: number;
}

/** The marks' centres on a calibration page of w x h (CSS px), and their size. */
export const CALIBRATION_MARK = 16;
export const calibrationMarks = (w: number, h: number): [number, number][] => [
  [Math.round(w * 0.2), Math.round(h * 0.2)],
  [Math.round(w * 0.8), Math.round(h * 0.8)],
];

/** Within this, a print is taken as laid out (no correction). */
const SAME_SCALE = 0.001, SAME_PT = 0.3;

export type Calibration =
  /** null fix: printed as laid out. `samePages`: every page of a print placed alike (else print one page at a time). */
  | { ok: true; fix: PrintFix | null; samePages: boolean }
  | { ok: false; reason: string };

/** The marks' centres (pt from the top-left corner) on page `n` of a printed calibration PDF. */
async function marksOn(bytes: Uint8Array, n: number): Promise<{ marks: [number, number][]; w: number; h: number } | null> {
  const doc = await openPdfBytes(bytes);
  try {
    if (n > doc.numPages) return null;
    const page = await doc.getPage(n);
    const v = page.getViewport({ scale: 1 });
    const k = Math.min(3, 1400 / Math.max(v.width, v.height));
    const c = document.createElement('canvas');
    c.width = Math.round(v.width * k);
    c.height = Math.round(v.height * k);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    await page.render({ canvas: c, canvasContext: ctx, viewport: page.getViewport({ scale: k }), background: 'rgba(0,0,0,0)' }).promise;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const W = c.width, H = c.height;
    c.width = c.height = 0;
    // Dark pixels of each half (top-left and bottom-right), weighted by how dark they are.
    const find = (x0: number, y0: number, x1: number, y1: number): [number, number] | null => {
      let sx = 0, sy = 0, n = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const i = (y * W + x) * 4;
          const a = d[i + 3] / 255, dark = a * (1 - (d[i] + d[i + 1] + d[i + 2]) / 765);
          if (dark < 0.25) continue;
          sx += (x + 0.5) * dark;
          sy += (y + 0.5) * dark;
          n += dark;
        }
      return n > 4 ? [sx / n / k, sy / n / k] : null;
    };
    const a = find(0, 0, Math.floor(W / 2), Math.floor(H / 2));
    const b = find(Math.floor(W / 2), Math.floor(H / 2), W, H);
    return a && b ? { marks: [a, b], w: v.width, h: v.height } : null;
  } finally {
    void doc.loadingTask.destroy();
  }
}

/** How a print of pages w x h (CSS px) was placed, from its calibration print (two pages). */
export async function measureCalibration(bytes: Uint8Array, w: number, h: number): Promise<Calibration> {
  const expected = calibrationMarks(w, h).map(([x, y]) => [x * 0.75, y * 0.75]);
  const fixes: PrintFix[] = [];
  let sheet = { w: 0, h: 0 };
  for (const n of [1, 2]) {
    const m = await marksOn(bytes, n).catch(() => null);
    if (!m) return { ok: false, reason: n === 1 ? 'calibration marks not found' : 'calibration page 2 missing' };
    sheet = { w: m.w, h: m.h };
    const [[e1x, e1y], [e2x, e2y]] = expected, [[f1x, f1y], [f2x, f2y]] = m.marks;
    const sx = (f2x - f1x) / (e2x - e1x), sy = (f2y - f1y) / (e2y - e1y);
    fixes.push({ sx, sy, dx: f1x - sx * e1x, dy: f1y - sy * e1y });
  }
  const [f] = fixes;
  if (!(f.sx > 0.5 && f.sx < 2 && f.sy > 0.5 && f.sy < 2)) return { ok: false, reason: `scale ${f.sx.toFixed(3)} x ${f.sy.toFixed(3)}` };
  // The whole page must be on the sheet: what a print cut off cannot be brought back.
  const W = w * 0.75, H = h * 0.75, tol = 0.75;
  if (f.dx < -tol || f.dy < -tol || f.dx + f.sx * W > sheet.w + tol || f.dy + f.sy * H > sheet.h + tol)
    return { ok: false, reason: `page cut off (${JSON.stringify(f)} on ${sheet.w.toFixed(1)} x ${sheet.h.toFixed(1)})` };
  const same = (a: PrintFix, b: PrintFix) => Math.abs(a.sx - b.sx) < SAME_SCALE && Math.abs(a.sy - b.sy) < SAME_SCALE && Math.abs(a.dx - b.dx) < SAME_PT && Math.abs(a.dy - b.dy) < SAME_PT;
  const identity = same(f, { sx: 1, sy: 1, dx: 0, dy: 0 }) && Math.abs(sheet.w - W) < 1 && Math.abs(sheet.h - H) < 1;
  return { ok: true, fix: identity ? null : f, samePages: same(f, fixes[1]) };
}
