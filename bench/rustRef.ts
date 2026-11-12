// Reference outputs of the TypeScript ink pipeline for the Rust port (branch opennote-rs), on
// real pen recordings: every stage the Rust crates must reproduce, stroke by stroke, so a port is
// checked against what the app really draws and not against itself.
//
// Every stroke is replayed with the fountain pen (as bench:look does: widths, nib and smoothing all
// take part), and a pressured stroke ends with its pen end (Stroke.penEnd: the last sample with more
// than 2% force, as the shells' lead reaches it at lift).
//
// Per stroke (pen only): the recorded samples, the points given to the stroke (densified), the
// points given to the engine (enginePoints), the modelled line (nibStroke), the widths
// (inkWidths, on the whole modelled line), the drawn line (strokeGeometry: thinned, smoothed,
// pen end), the live line at the middle sample and at the last one (SmoothLiveStroke.line), the
// dash runs of every line style (inkRuns), and the pieces the precision eraser leaves when it
// touches the drawn line in its middle (solid, and dashed: the pieces keep their place in the pattern).
//
// npm run bench:rustref -- <out.json> [--per N] [files…]   (default: N strokes from each recording)
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { SampleDensifier } from '../src/ink/densify';
import { nibStroke } from '../src/ink/engine';
import { inkWidths } from '../src/ink/inkWidth';
import { SmoothLiveStroke } from '../src/ink/smoothLiveStroke';
import { enginePoints, eraseStrokesPartial, inkRuns, isVariableWidth, penEnd, strokeGeometry, strokeWidth, styleOf } from '../src/ink/strokeRenderer';
import type { PenRecording } from '../src/ink/penRecorder';
import type { LineStyle, Point, Stroke } from '../src/types';

const args = process.argv.slice(2);
const out = args[0];
if (!out || out.startsWith('--')) {
  console.error('usage: npm run bench:rustref -- <out.json> [--per N] [files…]');
  process.exit(1);
}
const perAt = args.indexOf('--per');
const per = perAt > 0 ? Number(args[perAt + 1]) : 6;
const named = args.slice(1).filter((a, i, all) => a !== '--per' && all[i - 1] !== '--per');
const dir = 'bench/recordings/';
const files = named.length ? named : readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => dir + f);

// 9 significant digits: far below what the Rust test should allow (1e-6 px), and a smaller file.
const n = (v: number) => (Number.isFinite(v) ? Number(v.toPrecision(9)) : v);
const pt4 = (q: { x: number; y: number; t?: number; pressure?: number; p?: number }) => [n(q.x), n(q.y), n(q.t ?? 0), n(q.pressure ?? q.p ?? 0)];
const xy = (q: { x: number; y: number }) => [n(q.x), n(q.y)];
const STYLES: LineStyle[] = ['dashed', 'longdash', 'dotted', 'dashdot'];

const strokes: unknown[] = [];
for (const file of files) {
  const rec = JSON.parse(readFileSync(file, 'utf8')) as PenRecording;
  const pens = rec.strokes.map((s, i) => ({ s, i })).filter(({ s }) => s.tool === 'pen' && s.samples.length > 2);
  // Spread over the recording, the longest strokes too.
  const step = Math.max(1, Math.floor(pens.length / per));
  for (const { s, i } of pens.filter((_, k) => k % step === 0).slice(0, per)) {
    const real = s.samples.some((q) => q[3] > 0 && q[3] !== 0.5);
    const dens = new SampleDensifier();
    const live = new SmoothLiveStroke();
    const points: Point[] = [];
    const base = { id: 'ref', createdAt: 0, tool: 'pen' as const, color: '#000', width: s.width, opacity: 1, penStyle: 'fountain' as const, lineStyle: 'solid' as LineStyle };
    const style = { color: '#000', width: strokeWidth(styleOf({ ...base, points: [] } as Stroke)), variable: false };
    const liveAt: unknown[] = [];
    const mid = Math.floor(s.samples.length / 2);
    s.samples.forEach(([x, y, t, force], k) => {
      for (const q of dens.push({ x, y, t, pressure: force > 0 ? force : 0 })) {
        points.push(q);
        live.add(q.x, q.y, q.t ?? t, real ? q.pressure : 0.5);
      }
      if ((k === mid || k === s.samples.length - 1) && points.length > 2) {
        style.variable = real && isVariableWidth(styleOf({ ...base, points } as Stroke));
        const l = live.line(style);
        liveAt.push({ sample: k, variable: style.variable, final: l.final.map(xy), finalW: l.finalW.map(n), rest: l.rest.map(xy), restW: l.restW.map(n) });
      }
    });
    if (points.length < 3) continue;
    // The pen end, as CanvasPage's finishStroke appends it (nativePencil.lead: force > LEAD_FORCE).
    const lead = real ? [...s.samples].reverse().find((q) => q[3] > 0.02) : undefined;
    const stroke = (lead
      ? { ...base, points: [...points, { x: lead[0], y: lead[1], t: lead[2], pressure: lead[3] }], penEnd: true }
      : { ...base, points }) as Stroke;
    const eng = enginePoints(stroke);
    const modeled = nibStroke(eng);
    const g = strokeGeometry(stroke);
    const dashes: Record<string, unknown> = {};
    for (const ls of STYLES) {
      const runs = inkRuns(g, { ...styleOf(stroke), lineStyle: ls });
      dashes[ls] = runs ? runs.map((r) => ({ pts: r.pts.map(xy), radii: r.radii.map(n) })) : null;
    }
    // The precision eraser across the drawn line's middle (radius 4 page px).
    const at = g.pts[Math.floor(g.pts.length / 2)];
    let id = 0;
    const erased = eraseStrokesPartial([{ ...stroke, id: 'ref' }], at.x, at.y, 4, () => `piece${++id}`);
    const erasedDashed = eraseStrokesPartial([{ ...stroke, id: 'ref', lineStyle: 'dashed' }], at.x, at.y, 4, () => `piece${++id}`);
    strokes.push({
      id: `${file.split('/').pop()}#${i}`,
      recordedPenStyle: s.penStyle ?? null,
      width: s.width,
      zoom: s.zoom ?? null,
      realPressure: real,
      samples: s.samples.map(([x, y, t, f]) => [x, y, t, f]),
      points: stroke.points.map(pt4),
      penEndFlag: !!stroke.penEnd,
      enginePoints: eng.map(pt4),
      penEnd: penEnd(stroke) ? xy(penEnd(stroke)!) : null,
      modeled: modeled.map(pt4),
      widths: real && isVariableWidth(styleOf(stroke)) ? inkWidths(modeled, strokeWidth(styleOf(stroke))).map(n) : null,
      geometry: { pts: g.pts.map(pt4), widths: g.widths ? g.widths.map(n) : null, width: n(g.width) },
      live: liveAt,
      dashes,
      eraser: {
        x: n(at.x), y: n(at.y), radius: 4, changed: erased.changed,
        pieces: erased.strokes.map((p) => ({ points: p.points.map(pt4), modeled: p.modeled ?? null, dashOffset: p.dashOffset == null ? null : n(p.dashOffset) })),
      },
      eraserDashed: {
        changed: erasedDashed.changed,
        pieces: erasedDashed.strokes.map((p) => ({ points: p.points.map(pt4), modeled: p.modeled ?? null, dashOffset: p.dashOffset == null ? null : n(p.dashOffset) })),
      },
    });
  }
}
const json = JSON.stringify({ format: 'opennote-rust-ref', version: 1, app: JSON.parse(readFileSync('package.json', 'utf8')).version, strokes });
writeFileSync(out, json);
console.log(`${strokes.length} strokes from ${files.length} recordings -> ${out} (${(json.length / 1e6).toFixed(1)} MB)`);
