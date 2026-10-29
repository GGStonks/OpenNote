// Copies pdf.js's data files into public/pdfjs so imported PDFs render fully offline: character maps
// (CJK text), the standard fonts (PDFs that do not embed theirs) and the WebAssembly image decoders
// (JPEG 2000, JBIG2, colour profiles).
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'pdfjs-dist');
const dest = join(root, 'public', 'pdfjs');

if (!existsSync(src)) {
  console.error('[copy-pdfjs] pdfjs-dist is not installed; run npm install');
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const dir of ['cmaps', 'standard_fonts', 'wasm']) cpSync(join(src, dir), join(dest, dir), { recursive: true });
console.log('[copy-pdfjs] copied pdf.js data files to public/pdfjs');
