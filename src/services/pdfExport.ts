/**
 * PDF export: one PDF made of the note's pages, each at its own size and orientation.
 *
 * Each page is rendered to a one-page vector PDF of exactly its size (Android:
 * platform.pdfOfPrintLayout), then the pages are joined here, unchanged (pdf-lib copies them; their
 * contents are not re-rendered). The system print dialog, still offered as "Print…", forces one
 * paper size on every page: a note mixing A4 portrait and landscape pages came out on sheets of
 * whatever size the dialog was set to.
 */

/** Joins the first page of each PDF, in order, into one PDF. */
export async function joinPdfPages(pages: Uint8Array[], title: string): Promise<Uint8Array> {
  const { PDFDocument } = await import('pdf-lib');
  const out = await PDFDocument.create();
  out.setTitle(title);
  out.setCreator('OpenNote');
  out.setProducer('OpenNote');
  for (const bytes of pages) {
    const src = await PDFDocument.load(bytes);
    if (!src.getPageCount()) continue;
    const [page] = await out.copyPages(src, [0]);
    out.addPage(page);
  }
  return out.save();
}
