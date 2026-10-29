import { getFile } from '../storage/db';


/**
 * PDF export: one PDF made of the note's pages, each at its own size and orientation.
 *
 * Each page is rendered to a one-page vector PDF of exactly its size (Android:
 * platform.pdfOfPrintLayout), then the pages are joined here, unchanged (pdf-lib copies them; their
 * contents are not re-rendered). The system print dialog, still offered as "Print…", forces one
 * paper size on every page: a note mixing A4 portrait and landscape pages came out on sheets of
 * whatever size the dialog was set to.
 *
 * A page showing a PDF (an imported PDF, a Notability note on a PDF) is printed without it and
 * without its paper (`under`), and the original PDF page is laid under it here, as the editor fits
 * it (services/pdf.ts pdfFit): the export keeps the original's vectors and text instead of a
 * picture of them.
 */

export interface PrintedPage {
  /** The PDF the page was printed in (with other pages of its size), and its page there (0-based). */
  bytes: Uint8Array;
  index?: number;
  /**
   * The PDF page to lay under it, and the paper's colour (#RRGGBB) under that. `multiply`: the
   * printed page came out opaque white (not see-through where it is empty), and is multiplied over
   * the PDF page: its white leaves the PDF page as it is, its ink darkens it as ink on paper.
   */
  under?: { file: string; page: number; paper: string; multiply?: boolean };
}

type PdfLib = typeof import('pdf-lib');
type Doc = Awaited<ReturnType<PdfLib['PDFDocument']['load']>>;
/** A stored PDF, read by pdf-lib. */
export type PdfSource = Doc;

/**
 * The stored PDFs pdf-lib can lay under printed pages (not those it cannot read, e.g. encrypted
 * ones), read once for the whole export.
 */
export async function loadUnderlays(ids: string[]): Promise<Map<string, Doc>> {
  const { PDFDocument } = await import('pdf-lib');
  const ok = new Map<string, Doc>();
  for (const id of new Set(ids)) {
    try {
      const f = await getFile(id);
      if (f) ok.set(id, await PDFDocument.load(f.bytes, { updateMetadata: false }));
    } catch {
      /* drawn as a picture instead */
    }
  }
  return ok;
}

/** The number of pages of a printed PDF. */
export async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  const { PDFDocument } = await import('pdf-lib');
  return (await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount();
}

const rgbOf = (hex: string): [number, number, number] => {
  const n = parseInt(hex.replace('#', '').slice(0, 6), 16);
  return Number.isFinite(n) ? [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255] : [1, 1, 1];
};

/**
 * Joins the printed pages, in order, into one PDF (with the PDF pages they lie on). `loaded`: stored
 * PDFs already read (loadUnderlays).
 */
export async function joinPdfPages(pages: PrintedPage[], title: string, loaded?: Map<string, Doc>): Promise<Uint8Array> {
  const lib = await import('pdf-lib');
  const { PDFDocument, rgb, degrees } = lib;
  const out = await PDFDocument.create();
  out.setTitle(title);
  out.setCreator('OpenNote');
  out.setProducer('OpenNote');
  const sources = new Map<string, Promise<Doc>>();
  loaded?.forEach((d, id) => sources.set(id, Promise.resolve(d)));
  const source = (id: string) => {
    let p = sources.get(id);
    if (!p) {
      p = getFile(id).then((f) => {
        if (!f) throw new Error('A PDF of the note is missing');
        return PDFDocument.load(f.bytes, { updateMetadata: false });
      });
      sources.set(id, p);
    }
    return p;
  };
  const prints = new Map<Uint8Array, Promise<Doc>>();
  for (const printed of pages) {
    let load = prints.get(printed.bytes);
    if (!load) prints.set(printed.bytes, (load = PDFDocument.load(printed.bytes)));
    const src = await load;
    const index = printed.index ?? 0;
    if (index >= src.getPageCount()) continue;
    if (!printed.under) {
      const [page] = await out.copyPages(src, [index]);
      out.addPage(page);
      continue;
    }
    const top = src.getPage(index);
    const { width: W, height: H } = top.getSize();
    const page = out.addPage([W, H]);
    const [r, g, b] = rgbOf(printed.under.paper);
    page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: rgb(r, g, b) });
    const orig = await source(printed.under.file);
    const op = orig.getPage(Math.min(Math.max(1, printed.under.page), orig.getPageCount()) - 1);
    const box = op.getCropBox();
    const rot = (((op.getRotation().angle % 360) + 360) % 360) as 0 | 90 | 180 | 270;
    const emb = await out.embedPage(op, { left: box.x, bottom: box.y, right: box.x + box.width, top: box.y + box.height });
    // Fitted and centred as the editor shows it (pdf.ts pdfFit), the page's own rotation applied.
    const ew = box.width, eh = box.height;
    const [dw, dh] = rot === 90 || rot === 270 ? [eh, ew] : [ew, eh];
    const k = Math.min(W / dw, H / dh);
    const bx = (W - dw * k) / 2, by = (H - dh * k) / 2;
    const at =
      rot === 0 ? { x: bx, y: by } : rot === 90 ? { x: bx, y: by + dh * k } : rot === 180 ? { x: bx + dw * k, y: by + dh * k } : { x: bx + dw * k, y: by };
    page.drawPage(emb, { ...at, width: ew * k, height: eh * k, rotate: degrees(-rot) });
    const printedPage = await out.embedPage(top);
    if (printed.under.multiply) {
      // Multiplied as a whole: an isolated transparency group (the printed page sets its own blend
      // mode for what it draws, which would replace the multiplying inside it).
      await printedPage.embed();
      const xobj = out.context.lookup(printedPage.ref) as unknown as { dict: { set(k: unknown, v: unknown): void } };
      xobj.dict.set(lib.PDFName.of('Group'), out.context.obj({ Type: 'Group', S: 'Transparency', I: true, CS: 'DeviceRGB' }));
    }
    page.drawPage(printedPage, { x: 0, y: 0, width: W, height: H, ...(printed.under.multiply ? { blendMode: lib.BlendMode.Multiply } : {}) });
  }
  return out.save();
}

// For the UI benchmark (bench/ui.mjs --only pdfimport): the joining of printed pages and PDF pages.
(window as unknown as { __opennotePdfExport?: unknown }).__opennotePdfExport = { joinPdfPages, loadUnderlays };
