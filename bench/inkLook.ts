// The look of real handwriting through the app's whole pen pipeline (densify -> ink engine ->
// widths (inkWidth.ts) -> settled smoothing), on the pen recordings in bench/recordings:
//   - accuracy: how far the finished ink strays from the pen's own path (per stroke, the worst point);
//   - wobble: how much the line's direction jitters (RMS change of curvature, per px, on the line
//     resampled every px; lower is smoother, 0 for a perfect circle or line);
//   - width range: each stroke's widest / narrowest point (1 = uniform);
//   - live = finished: the final part of the line drawn while writing (SmoothLiveStroke.line, which
//     the native live ink draws) against the finished stroke, positions and widths. Any gap there
//     shows as the ink changing when the pen lifts.
// WOBBLE_SMOOTHED=1: wobble of the smoothed part only (without each stroke's last SMOOTH_SETTLE,
// which stays as modelled so the live line equals the finished one).
// npm run bench:look [-- files]
import { readFileSync, readdirSync } from 'node:fs';
import { SampleDensifier } from '../src/ink/densify';
import { settledIndex, strokeGeometry, strokeWidth } from '../src/ink/strokeRenderer';
import { SmoothLiveStroke } from '../src/ink/smoothLiveStroke';
import type { PenRecording } from '../src/ink/penRecorder';
import type { Point, Stroke } from '../src/types';

type XY = { x: number; y: number };
function distToPolyline(p: XY, poly: XY[]): { d: number; i: number } {
  let best = Infinity, bi = 0;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1], b = poly[i], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const u = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    const d = Math.hypot(p.x - a.x - u * dx, p.y - a.y - u * dy);
    if (d < best) { best = d; bi = u < 0.5 ? i - 1 : i; }
  }
  return poly.length === 1 ? { d: Math.hypot(p.x - poly[0].x, p.y - poly[0].y), i: 0 } : { d: best, i: bi };
}

/** RMS change of curvature per px along the line resampled every px (0 = perfectly smooth). */
function wobble(pts: XY[]): { sum: number; n: number } {
  const r: XY[] = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], l = Math.hypot(b.x - a.x, b.y - a.y);
    let s = 1 - carry;
    while (s <= l) {
      r.push({ x: a.x + ((b.x - a.x) * s) / l, y: a.y + ((b.y - a.y) * s) / l });
      s += 1;
    }
    carry = l - (s - 1);
  }
  const k: number[] = [];
  for (let i = 1; i < r.length - 1; i++) {
    const t1 = Math.atan2(r[i].y - r[i - 1].y, r[i].x - r[i - 1].x), t2 = Math.atan2(r[i + 1].y - r[i].y, r[i + 1].x - r[i].x);
    let d = t2 - t1;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    k.push(d);
  }
  let sum = 0, n = 0;
  for (let i = 1; i < k.length; i++) {
    // Corners (a turn over 40 degrees in a px) are meant to be sharp: not wobble.
    if (Math.abs(k[i]) > 0.7 || Math.abs(k[i - 1]) > 0.7) continue;
    sum += (k[i] - k[i - 1]) ** 2;
    n++;
  }
  return { sum, n };
}

const files: string[] = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync('bench/recordings').map((f) => `bench/recordings/${f}`);
const dev: number[] = [], range: number[] = [];
let wSum = 0, wN = 0, strokes = 0;
const posGaps: number[] = [], wGaps: number[] = [];
let liveN = 0;
let worstW = { gap: 0, where: '' };
for (const file of files) {
  const rec = JSON.parse(readFileSync(file, 'utf8')) as PenRecording;
  for (const s of rec.strokes) {
    if (s.tool !== 'pen') continue;
    const pts: Point[] = [];
    const dens = new SampleDensifier();
    const live = new SmoothLiveStroke();
    const real = s.samples.some((q) => q[3] > 0 && q[3] !== 0.5);
    for (const [x, y, t, force] of s.samples) {
      for (const q of dens.push({ x, y, t, pressure: force > 0 ? force : 0 })) {
        pts.push(q);
        live.add(q.x, q.y, q.t ?? t, real ? q.pressure : 0.5);
      }
    }
    if (pts.length < 3) continue;
    const stroke = { id: 'x', createdAt: 0, tool: 'pen', color: '#000', width: s.width, opacity: 1, penStyle: 'fountain', lineStyle: 'solid', points: pts } as Stroke;
    const g = strokeGeometry(stroke);
    const raw = s.samples.filter((q) => q[3] > 0).map(([x, y]) => ({ x, y }));
    if (raw.length < 2 || g.pts.length < 3) continue;
    strokes++;
    let m = 0;
    for (const q of g.pts) m = Math.max(m, distToPolyline(q, raw).d);
    dev.push(m);
    const w = wobble(process.env.WOBBLE_SMOOTHED ? g.pts.slice(0, Math.max(3, settledIndex(g.pts))) : g.pts);
    wSum += w.sum;
    wN += w.n;
    if (g.widths) range.push(Math.max(...g.widths) / Math.max(1e-6, Math.min(...g.widths)));
    // Live, just before the pen lifts: its final part must lie on the finished line, same widths.
    const style = { color: '#000', width: strokeWidth({ tool: 'pen', color: '#000', width: s.width, penStyle: 'fountain', lineStyle: 'solid' } as never), variable: !!g.widths };
    const { final, finalW } = live.line(style);
    // Matched in order along the line (a letter crossing itself must not match another part of it).
    let j = 0;
    for (let i = 0; i < final.length; i++) {
      let bj = j, bd = Infinity;
      for (let k = j; k < Math.min(g.pts.length, j + 8); k++) {
        const d = Math.hypot(final[i].x - g.pts[k].x, final[i].y - g.pts[k].y);
        if (d < bd) { bd = d; bj = k; }
      }
      j = bj;
      // Projected onto the finished line's segments either side of the nearest point; the
      // finished width interpolated there (the two lines are not sampled at the same places).
      let pd = bd, pw = g.widths ? g.widths[bj] : 0;
      for (const k of [bj - 1, bj]) {
        if (k < 0 || k + 1 >= g.pts.length) continue;
        const A = g.pts[k], B = g.pts[k + 1], dx = B.x - A.x, dy = B.y - A.y, l2 = dx * dx + dy * dy;
        const u = l2 ? Math.max(0, Math.min(1, ((final[i].x - A.x) * dx + (final[i].y - A.y) * dy) / l2)) : 0;
        const d = Math.hypot(final[i].x - A.x - u * dx, final[i].y - A.y - u * dy);
        if (d < pd) {
          pd = d;
          if (g.widths) pw = g.widths[k] + (g.widths[k + 1] - g.widths[k]) * u;
        }
      }
      posGaps.push(pd);
      if (g.widths) {
        const gap = Math.abs(finalW[i] - pw) / pw;
        wGaps.push(gap);
        if (gap > worstW.gap) worstW = { gap, where: `${file.split('/').pop()} #${rec.strokes.indexOf(s)} at ${((100 * i) / Math.max(1, final.length - 1)).toFixed(0)}% of the live line (${final.length} pts, finished ${g.pts.length}), pos gap ${pd.toFixed(2)} px, live ${finalW[i].toFixed(3)} vs ${pw.toFixed(3)}` };
      }
      liveN++;
    }
  }
}
const q = (a: number[], f: number) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * f))];
console.log(`${strokes} recorded pen strokes`);
console.log(`accuracy   ink to the pen path, worst point per stroke: median ${q(dev, 0.5).toFixed(2)} px, p95 ${q(dev, 0.95).toFixed(2)} px`);
console.log(`wobble     ${(Math.sqrt(wSum / Math.max(1, wN)) * 1000).toFixed(1)} mrad/px^2 (lower is smoother)`);
console.log(`width      widest/narrowest per stroke: median ${range.length ? q(range, 0.5).toFixed(2) : '-'}x, p95 ${range.length ? q(range, 0.95).toFixed(2) : '-'}x`);
console.log(`live       final live line vs finished stroke over ${liveN} points: position p99 ${q(posGaps, 0.99).toFixed(3)} / max ${q(posGaps, 1).toFixed(3)} px, width p99 ${(q(wGaps, 0.99) * 100).toFixed(2)}% / max ${(q(wGaps, 1) * 100).toFixed(2)}%`);
console.log(`           worst width gap: ${worstW.where}`);
