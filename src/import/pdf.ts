import { PageSheet, newId } from '../types';
import { putFile } from '../storage/db';
import { PdfPasswordError, openPdfBytes, pdfPageSizes, pdfTitle } from '../services/pdf';

/**
 * A PDF into a note to write on: one page per page of the PDF, each of the PDF page's own size
 * (1 pt = 4/3 px, as the formats in pageSetup.ts), drawn as its paper from the PDF itself (kept in
 * the library's file store, services/pdf.ts). Nothing of the PDF is converted: it stays exactly as
 * it was, sharp at every zoom, and the PDF export lays it under the ink again.
 */

export interface PdfImport {
  title: string;
  fileId: string;
  sheets: PageSheet[];
  pages: number;
}

/** Asks for a protected PDF's password; null: cancelled. */
export type PasswordPrompt = (wrong: boolean) => Promise<string | null>;

/** Pages larger than this (px wide) are scaled down to it, smaller than MIN up to it (posters, tickets). */
const MAX_PAGE_W = 2400;
const MIN_PAGE_W = 400;

/**
 * Keeps a PDF in the library's file store (asking for its password if it has one): its id, its
 * pages' sizes (points, rotation applied) and its own title.
 */
export async function storePdf(bytes: Uint8Array, fileName: string, askPassword?: PasswordPrompt): Promise<{ fileId: string; sizes: { w: number; h: number }[]; title: string | null }> {
  let password: string | undefined;
  let doc;
  for (;;) {
    try {
      doc = await openPdfBytes(bytes, password);
      break;
    } catch (err) {
      if (!(err instanceof PdfPasswordError) || !askPassword) throw err;
      const given = await askPassword(err.wrong);
      if (given === null) throw new Error('cancelled');
      password = given;
    }
  }
  try {
    const sizes = await pdfPageSizes(doc);
    if (!sizes.length) throw new Error('The PDF has no pages');
    const fileId = newId('file');
    await putFile({ id: fileId, name: fileName, mime: 'application/pdf', bytes: bytes.slice().buffer, ...(password ? { password } : {}), createdAt: Date.now() });
    return { fileId, sizes, title: await pdfTitle(doc) };
  } finally {
    void doc.loadingTask.destroy();
  }
}

export async function importPdf(bytes: Uint8Array, fileName: string, askPassword?: PasswordPrompt): Promise<PdfImport> {
  const { fileId, sizes, title } = await storePdf(bytes, fileName, askPassword);
  {
    const sheets: PageSheet[] = sizes.map((sz, i) => {
      let w = (sz.w * 4) / 3, h = (sz.h * 4) / 3;
      const k = w > MAX_PAGE_W ? MAX_PAGE_W / w : w < MIN_PAGE_W ? MIN_PAGE_W / w : 1;
      w *= k;
      h *= k;
      return { id: newId('sheet'), width: Math.round(w * 100) / 100, height: Math.round(h * 100) / 100, paperStyle: 'blank', pdf: { file: fileId, page: i + 1 } };
    });
    // The file's name, as the library names imported notes (the PDF's own title is often a
    // generator's leftover, "Microsoft Word - …").
    return { title: fileName.replace(/\.pdf$/i, '') || title || 'PDF', fileId, sheets, pages: sizes.length };
  }
}
