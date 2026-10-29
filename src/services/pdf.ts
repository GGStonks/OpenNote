import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { PdfPageRef } from '../types';
import { getFile, getThumb, putThumb } from '../storage/db';

/**
 * PDFs drawn as the paper of pages (PageSheet.pdf): imported PDFs and Notability notes on PDFs.
 *
 * The file stays as it is in the library's file store (db.ts files) and is drawn by pdf.js from its
 * vectors whenever a page needs it, at the resolution it is shown at: sharp at every zoom, the
 * original's text kept for PDF exports (pdfExport.ts lays the original page under the ink). The
 * legacy build of pdf.js is used: the apps run in system web views of every age. Its worker is
 * a file of the app; where a web view cannot start it (a custom scheme), pdf.js parses on the main
 * thread instead, from the same file. Its data (character maps, standard fonts, image decoders)
 * ships in public/pdfjs (scripts/copy-pdfjs.mjs), so PDFs render offline.
 */

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

let lib: Promise<PdfJs> | null = null;

function pdfjs(): Promise<PdfJs> {
  lib ??= import('pdfjs-dist/legacy/build/pdf.mjs').then((m) => {
    m.GlobalWorkerOptions.workerSrc = workerUrl;
    return m;
  });
  lib.catch(() => (lib = null));
  return lib;
}

const dataUrl = (dir: string) => new URL(`pdfjs/${dir}/`, document.baseURI).href;

/** A PDF that could not be opened without its password: `retry` with one. */
export class PdfPasswordError extends Error {
  constructor(readonly wrong: boolean) {
    super(wrong ? 'Wrong password' : 'This PDF is protected by a password');
  }
}

/** Opens a PDF from its bytes (copied: pdf.js takes them over). */
export async function openPdfBytes(bytes: Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  const m = await pdfjs();
  const task = m.getDocument({
    data: bytes.slice(),
    password,
    cMapUrl: dataUrl('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: dataUrl('standard_fonts'),
    wasmUrl: dataUrl('wasm'),
  });
  try {
    return await task.promise;
  } catch (err) {
    if ((err as { name?: string })?.name === 'PasswordException') throw new PdfPasswordError(!!password);
    throw err;
  }
}

/** Open documents by file id: the last few used stay open. */
const open = new Map<string, Promise<PDFDocumentProxy>>();
const KEEP_OPEN = 4;
export function openPdf(file: string): Promise<PDFDocumentProxy> {
  let p = open.get(file);
  if (p) {
    open.delete(file);
    open.set(file, p);
    return p;
  }
  p = getFile(file).then((f) => {
    if (!f) throw new Error('The PDF of this page is missing');
    return openPdfBytes(new Uint8Array(f.bytes), f.password);
  });
  open.set(file, p);
  p.catch(() => open.delete(file));
  while (open.size > KEEP_OPEN) {
    const [oldest, doc] = open.entries().next().value!;
    open.delete(oldest);
    void doc.then((d) => d.loadingTask.destroy()).catch(() => undefined);
  }
  return p;
}

/** A page's size in PDF points (1/72 in), its rotation applied. */
export function pageSize(page: PDFPageProxy): { w: number; h: number } {
  const v = page.getViewport({ scale: 1 });
  return { w: v.width, h: v.height };
}

/** Where the PDF page sits on a sheet of w x h px: fitted, centred (k: px per PDF point). */
export function pdfFit(page: { w: number; h: number }, w: number, h: number): { k: number; x: number; y: number } {
  const k = Math.min(w / page.w, h / page.h);
  return { k, x: (w - page.w * k) / 2, y: (h - page.h * k) / 2 };
}

/**
 * Renders run one at a time, newest wanted first: pdf.js paints on the main thread (in slices), and
 * several at once only made each later. A job whose `key` is asked again replaces the waiting one.
 */
interface Job {
  key: string;
  run: () => Promise<void>;
  drop: () => void;
}
const queue: Job[] = [];
let running = false;

async function pump() {
  if (running) return;
  running = true;
  try {
    while (queue.length) await queue.shift()!.run();
  } finally {
    running = false;
  }
}

function schedule(key: string, run: () => Promise<void>, drop: () => void) {
  const i = queue.findIndex((j) => j.key === key);
  if (i >= 0) queue.splice(i, 1)[0].drop();
  queue.unshift({ key, run, drop });
  void pump();
}

export interface PdfRegion {
  /** The part of the sheet to draw (sheet px). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Draws `region` of the sheet (w x h px) showing `ref` into `canvas`, at `r` canvas px per sheet
 * px. `key` names the slot (a later render for it replaces a waiting one); resolves false when it
 * was replaced or the PDF could not be drawn. The canvas is drawn off screen and copied in at the
 * end, so it never shows half a page.
 */
export function drawPdfRegion(key: string, ref: PdfPageRef, sheet: { w: number; h: number }, region: PdfRegion, r: number, canvas: HTMLCanvasElement, background?: string): Promise<boolean> {
  return new Promise((resolve) => {
    schedule(
      key,
      async () => {
        try {
          const doc = await openPdf(ref.file);
          const page = await doc.getPage(Math.min(Math.max(1, ref.page), doc.numPages));
          const fit = pdfFit(pageSize(page), sheet.w, sheet.h);
          const w = Math.max(1, Math.round((region.x1 - region.x0) * r)), h = Math.max(1, Math.round((region.y1 - region.y0) * r));
          const off = document.createElement('canvas');
          off.width = w;
          off.height = h;
          const ctx = off.getContext('2d');
          if (!ctx) return resolve(false);
          const viewport = page.getViewport({ scale: fit.k * r });
          await page.render({
            canvas: off,
            canvasContext: ctx,
            viewport,
            transform: [1, 0, 0, 1, (fit.x - region.x0) * r, (fit.y - region.y0) * r],
            background: background ?? 'rgba(0,0,0,0)',
            annotationMode: 1,
          }).promise;
          canvas.width = w;
          canvas.height = h;
          canvas.getContext('2d')?.drawImage(off, 0, 0);
          off.width = off.height = 0;
          resolve(true);
        } catch {
          resolve(false);
        }
      },
      () => resolve(false)
    );
  });
}

/** Width (px) of a page preview (thumbnails, the page manager, a placeholder before the page is drawn). */
const PREVIEW_W = 360;
const previews = new Map<string, Promise<string | null>>();

/**
 * A small picture of a PDF page (a JPEG data URL), made once and kept with the library's
 * thumbnails; null when the PDF cannot be drawn.
 */
export function pdfPreview(ref: PdfPageRef): Promise<string | null> {
  const id = `pdf|${ref.file}|${ref.page}`;
  let p = previews.get(id);
  if (p) return p;
  p = (async () => {
    const have = await getThumb(id).catch(() => null);
    if (have) return have.url;
    const doc = await openPdf(ref.file);
    const page = await doc.getPage(Math.min(Math.max(1, ref.page), doc.numPages));
    const size = pageSize(page);
    const sheet = { w: PREVIEW_W, h: (PREVIEW_W * size.h) / size.w };
    const c = document.createElement('canvas');
    const ok = await drawPdfRegion(`preview|${id}`, ref, sheet, { x0: 0, y0: 0, x1: sheet.w, y1: sheet.h }, 1, c, '#ffffff');
    if (!ok) return null;
    const url = c.toDataURL('image/jpeg', 0.82);
    c.width = c.height = 0;
    await putThumb({ id, noteId: `file:${ref.file}`, updatedAt: 0, url }).catch(() => undefined);
    return url;
  })().catch(() => null);
  previews.set(id, p);
  return p;
}

/**
 * What a printed page has where it has no content: 'clear' (see-through), 'white', or 'colored'
 * (opaque in another colour). Drawn small on a see-through canvas and its pixels counted.
 */
export async function printedBackground(bytes: Uint8Array): Promise<'clear' | 'white' | 'colored'> {
  const doc = await openPdfBytes(bytes);
  try {
    const page = await doc.getPage(1);
    const v = page.getViewport({ scale: 1 });
    const k = Math.min(1, 160 / Math.max(v.width, v.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(v.width * k));
    c.height = Math.max(1, Math.round(v.height * k));
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return 'clear';
    await page.render({ canvas: c, canvasContext: ctx, viewport: page.getViewport({ scale: k }), background: 'rgba(0,0,0,0)' }).promise;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let opaque = 0, white = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] <= 250) continue;
      opaque++;
      if (d[i] > 245 && d[i + 1] > 245 && d[i + 2] > 245) white++;
    }
    c.width = c.height = 0;
    // Opaque over most of the page: a background (ink seldom covers half a page). Mostly white: white.
    const n = d.length / 4;
    return opaque < 0.6 * n ? 'clear' : white > 0.8 * opaque ? 'white' : 'colored';
  } finally {
    void doc.loadingTask.destroy();
  }
}

/** The page sizes of a PDF (points, rotation applied), for laying out its pages. */
export async function pdfPageSizes(doc: PDFDocumentProxy): Promise<{ w: number; h: number }[]> {
  const out: { w: number; h: number }[] = [];
  for (let i = 1; i <= doc.numPages; i++) out.push(pageSize(await doc.getPage(i)));
  return out;
}

/** The PDF's own title, if it has one worth showing. */
export async function pdfTitle(doc: PDFDocumentProxy): Promise<string | null> {
  try {
    const meta = await doc.getMetadata();
    const t = (meta.info as { Title?: unknown })?.Title;
    return typeof t === 'string' && t.trim() && !/^untitled|\.(docx?|pptx?|tex|indd)$/i.test(t.trim()) ? t.trim() : null;
  } catch {
    return null;
  }
}

/** A PDF page as it sits on a sheet of w x h px, as a PNG data URL at `r` px per sheet px (SVG export). */
export async function pdfPageImage(ref: PdfPageRef, w: number, h: number, r = 2): Promise<string | null> {
  const c = document.createElement('canvas');
  const ok = await drawPdfRegion(`image|${ref.file}|${ref.page}|${Math.random()}`, ref, { w, h }, { x0: 0, y0: 0, x1: w, y1: h }, Math.min(r, Math.sqrt(16_000_000 / (w * h))), c);
  const url = ok ? c.toDataURL('image/png') : null;
  c.width = c.height = 0;
  return url;
}
