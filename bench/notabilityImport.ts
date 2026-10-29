/**
 * Imports Notability notes (.note) and checks the result: what was found, and that the ink is drawn
 * as wide as Notability specifies (curve width x fractional width) along every stroke, through the
 * same geometry the canvas uses (strokeRenderer.inkGeometry).
 *
 *   npx esbuild bench/notabilityImport.ts --bundle --platform=node --format=esm --outfile=node_modules/.cache/nb-import.mjs \
 *     && node node_modules/.cache/nb-import.mjs <file.note> [...]
 */
import { readFileSync } from 'node:fs';
import { NotabilityDeps, importNotability } from '../src/import/notability';
import { inkGeometry, styleOf } from '../src/ink/strokeRenderer';
import { KeyedArchive, PlistValue, parsePlist } from '../src/import/plist';
import { readZip } from '../src/import/zip';

/** Per ink curve, straight from the file: [min, max] of curve width x fractional width (page points). */
async function expectedWidths(bytes: Uint8Array): Promise<{ range: [number, number]; style: number }[]> {
  const z = readZip(bytes).find((e) => e.name.endsWith('Session.plist'))!;
  const ar = new KeyedArchive(parsePlist(await z.read()));
  const store = ar.get(ar.field(ar.field(ar.field(ar.root(), 'richText'), 'Handwriting Overlay'), 'SpatialHash')) as Record<string, PlistValue>;
  const b = (k: string) => ar.get(store[k]) as Uint8Array;
  const n = b('curvesnumpoints'), w = b('curveswidth'), fw = b('curvesfractionalwidths'), styles = store.curvesstyles ? b('curvesstyles') : null;
  const dv = (x: Uint8Array) => new DataView(x.buffer, x.byteOffset, x.byteLength);
  const out: { range: [number, number]; style: number }[] = [];
  let f = 0;
  for (let c = 0; c < n.length / 4; c++) {
    const k = Math.floor((dv(n).getInt32(c * 4, true) - 1) / 3) + 1;
    const vals = Array.from({ length: k }, (_, j) => dv(fw).getFloat32((f + j) * 4, true) * dv(w).getFloat32(c * 4, true));
    f += k;
    out.push({ range: [Math.min(...vals), Math.max(...vals)], style: styles ? styles[c] : 3 });
  }
  return out;
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: nb-import.mjs <file.note> [...]');
  process.exit(2);
}
let bad = 0;
/** The importer's link to the device, in Node: pictures are not decoded, PDFs' page sizes come from pdf-lib. */
const deps: NotabilityDeps = {
  readImage: async () => ({ dataUrl: 'data:image/png;base64,', w: 1, h: 1 }),
  storePdf: async (name, bytes) => {
    const { PDFDocument } = await import('pdf-lib');
    const d = await PDFDocument.load(bytes, { ignoreEncryption: true });
    return {
      fileId: `file_${name}`,
      sizes: d.getPages().map((pg) => {
        const b = pg.getCropBox(), rot = pg.getRotation().angle % 180 !== 0;
        return rot ? { w: b.height, h: b.width } : { w: b.width, h: b.height };
      }),
    };
  },
  solidImage: (c) => `solid:${c}`,
};

for (const f of files) {
  const r = await importNotability(new Uint8Array(readFileSync(f)), f.split('/').pop()!, deps);
  const st = r.surface.strokes;
  const expected = (await expectedWidths(new Uint8Array(readFileSync(f)))).filter((e) => ![1, 2, 6, 7].includes(e.style));
  const heights = r.sheets.map((sh) => `${Math.round(sh.height ?? 0)}${sh.pdf ? 'p' : ''}`);
  console.log(`${f.split('/').pop()}: "${r.title}" paper ${r.paperColor} ${r.paperStyle}, ${r.sheets.length} page(s) [${heights.slice(0, 12).join(' ')}${heights.length > 12 ? ' …' : ''}], ${r.counts.strokes} strokes, ${r.counts.shapes} shapes, ${r.counts.images} images, ${r.counts.texts} text boxes, ${r.counts.pdfPages} PDF pages, ${r.recordings.length} recordings`);
  if (r.skipped.length) console.log(`  left out: ${r.skipped.join(', ')}`);
  for (const t of r.surface.textBlocks ?? []) console.log(`  text  ${JSON.stringify(t.text.slice(0, 40))} at ${t.x.toFixed(0)},${t.y.toFixed(0)} w ${t.width.toFixed(0)} ${t.fontSize}px ${t.fontFamily ?? 'sans'}${t.bold ? ' bold' : ''}${t.italic ? ' italic' : ''} ${t.color}${t.align ? ' ' + t.align : ''}`);
  for (const b of r.surface.imageBlocks ?? []) console.log(`  image ${b.dataUrl.slice(0, 18)} at ${b.x.toFixed(0)},${b.y.toFixed(0)} ${b.width.toFixed(0)}x${b.height.toFixed(0)} rot ${b.rotation ?? 0}`);
  const ink = st.filter((s) => !s.isShape);
  const paired = ink.length === expected.length;
  if (!paired) console.log(`  (widths not checked: ${ink.length} ink strokes for ${expected.length} curves, groups or skipped curves)`);
  ink.forEach((s, i) => {
    const g = inkGeometry(s.points, styleOf(s));
    const drawn = g.widths ?? g.pts.map(() => g.width);
    if (g.pts.length < 1 || drawn.some((x) => !Number.isFinite(x) || x <= 0)) bad++;
    const exp = paired ? expected[i] : null;
    if (exp && s.tool !== 'highlighter') {
      const k = r.importScale;
      const [lo, hi] = [exp.range[0] * k, exp.range[1] * k];
      const [dlo, dhi] = [Math.min(...drawn), Math.max(...drawn)];
      const err = Math.max(Math.abs(dhi - hi) / hi, Math.abs(dlo - Math.max(lo, 0.3)) / Math.max(lo, 0.3));
      if (err > 0.03) {
        bad++;
        console.log(`  stroke ${i}: width ${dlo.toFixed(2)}..${dhi.toFixed(2)}, expected ${lo.toFixed(2)}..${hi.toFixed(2)}`);
      }
    }
  });
}
if (bad) {
  console.log(`${bad} stroke(s) with invalid geometry or widths off by more than 3%`);
  process.exit(1);
}
