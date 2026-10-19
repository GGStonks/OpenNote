/**
 * Imports Notability notes (.note) and checks the result: what was found, and that the ink is drawn
 * as wide as Notability specifies (curve width x fractional width) along every stroke, through the
 * same geometry the canvas uses (strokeRenderer.inkGeometry).
 *
 *   npx esbuild bench/notabilityImport.ts --bundle --platform=node --format=esm --outfile=node_modules/.cache/nb-import.mjs \
 *     && node node_modules/.cache/nb-import.mjs <file.note> [...]
 */
import { readFileSync } from 'node:fs';
import { importNotability } from '../src/import/notability';
import { inkGeometry, styleOf } from '../src/ink/strokeRenderer';
import { KeyedArchive, parsePlist } from '../src/import/plist';
import { readZip } from '../src/import/zip';

/** Per ink curve, straight from the file: [min, max] of curve width x fractional width (page points). */
async function expectedWidths(bytes: Uint8Array): Promise<{ range: [number, number]; style: number }[]> {
  const z = readZip(bytes).find((e) => e.name.endsWith('Session.plist'))!;
  const ar = new KeyedArchive(parsePlist(await z.read()));
  const store = [...ar.walk(ar.root())].find((o) => 'curvespoints' in o)!;
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
for (const f of files) {
  const r = await importNotability(new Uint8Array(readFileSync(f)), f.split('/').pop()!);
  const st = r.surface.strokes;
  const expected = (await expectedWidths(new Uint8Array(readFileSync(f)))).filter((e) => ![1, 2, 6, 7].includes(e.style));
  console.log(`${f.split('/').pop()}: "${r.title}", ${r.sheets.length} page(s) ${r.pageSize}, ${r.counts.strokes} strokes, ${r.counts.shapes} shapes, ${r.counts.images} images, text ${r.counts.text ? 'yes' : 'no'}`);
  if (r.skipped.length) console.log(`  left out: ${r.skipped.join(', ')}`);
  let ci = 0;
  for (const s of st) {
    const g = inkGeometry(s.points, styleOf(s));
    const exp = !s.isShape ? expected[ci++] : null;
    const drawn = g.widths ?? g.pts.map(() => g.width * (s.tool === 'highlighter' ? 1 : 1));
    const kind = s.isShape ? `${s.shapeKind}` : s.tool === 'highlighter' ? 'highlighter' : s.modeled === 'proportional' ? 'variable' : 'uniform';
    const w = drawn.map((x) => x.toFixed(2));
    console.log(`  ${kind.padEnd(11)} ${s.color} opacity ${s.opacity.toFixed(2)}  ${s.points.length} pts  drawn width ${Math.min(...drawn).toFixed(2)}..${Math.max(...drawn).toFixed(2)}  x ${Math.min(...s.points.map((p) => p.x)).toFixed(0)}..${Math.max(...s.points.map((p) => p.x)).toFixed(0)} y ${Math.min(...s.points.map((p) => p.y)).toFixed(0)}..${Math.max(...s.points.map((p) => p.y)).toFixed(0)}${w.length < 3 ? ` (${w.join(', ')})` : ''}`);
    if (g.pts.length < 1 || drawn.some((x) => !Number.isFinite(x) || x <= 0)) bad++;
    if (exp && s.tool !== 'highlighter') {
      // Notability's widths in OpenNote px: the import scale is the drawn/expected ratio of the widest point.
      const k = r.importScale;
      const [lo, hi] = [exp.range[0] * k, exp.range[1] * k];
      const [dlo, dhi] = [Math.min(...drawn), Math.max(...drawn)];
      const err = Math.max(Math.abs(dhi - hi) / hi, Math.abs(dlo - Math.max(lo, 0.3)) / Math.max(lo, 0.3));
      console.log(`              expected ${lo.toFixed(2)}..${hi.toFixed(2)}  error ${(err * 100).toFixed(1)}%`);
      if (err > 0.03) bad++;
    }
  }
}
if (bad) {
  console.log(`${bad} stroke(s) with invalid geometry or widths off by more than 3%`);
  process.exit(1);
}
