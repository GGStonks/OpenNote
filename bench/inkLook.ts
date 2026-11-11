// The look of real handwriting through the app's whole pen pipeline (densify -> ink engine ->
// widths (inkWidth.ts) -> settled smoothing), on the pen recordings in bench/recordings:
//   - accuracy: how far the finished ink strays from the pen's own path (per stroke, the worst point);
//   - wobble: how much the line's direction jitters (RMS change of curvature, per px, on the line
//     resampled every px; lower is smoother, 0 for a perfect circle or line);
//   - width range: each stroke's widest / narrowest point (1 = uniform);
//   - nervous: the width's roughness along the finished line (its 2nd derivative: the nib's
//     intended thick and thin around a loop counts too);
//   - ripple: the width's fine jitter only (the part varying within RIPPLE_PX of line, against the
//     width averaged over that), what showed as a nervous, twitching line;
//   - end: each frame while writing, the line's last END_PX (its modelled points) against the same
//     points of the finished line (how much the end moves before it settles: the "serpent");
//   - live = finished: the final part of the line drawn while writing (SmoothLiveStroke.line, which
//     the native live ink draws) against the finished line of the same samples, point for point,
//     and against the stored stroke (matched along the line: approximate where a letter crosses
//     itself; the stored stroke also leaves out the samples after the lift). Any gap there shows as
//     the ink changing when the pen lifts.
// WOBBLE_SMOOTHED=1: wobble of the smoothed part only (without each stroke's last SMOOTH_SETTLE,
// which stays as modelled so the live line equals the finished one).
// npm run bench:look [-- files]
import { readFileSync, readdirSync } from 'node:fs';
import { SampleDensifier } from '../src/ink/densify';
import { settledIndex, settledSmooth, strokeGeometry, strokeWidth } from '../src/ink/strokeRenderer';
import { nibStroke } from '../src/ink/engine';
import { inkWidths } from '../src/ink/inkWidth';
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
let roughSum = 0, roughN = 0;
const endPos: number[] = [], endW: number[] = [];
const exactPos: number[] = [], exactW: number[] = [];
let rippleSum = 0, rippleN = 0;
/** Width variations within this much line are jitter (ripple), not the nib's thick and thin. */
const RIPPLE_PX = 3;
/** The last stretch of the drawn line compared each frame (page px). */
const END_PX = 40;
function arcs(p: XY[]): Float64Array {
  const a = new Float64Array(p.length);
  for (let i = 1; i < p.length; i++) a[i] = a[i - 1] + Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
  return a;
}
for (const file of files) {
  const rec = JSON.parse(readFileSync(file, 'utf8')) as PenRecording;
  for (const s of rec.strokes) {
    if (s.tool !== 'pen') continue;
    const pts: Point[] = [];
    const dens = new SampleDensifier();
    const live = new SmoothLiveStroke();
    const real = s.samples.some((q) => q[3] > 0 && q[3] !== 0.5);
    const liveStyle = { color: '#000', width: strokeWidth({ tool: 'pen', color: '#000', width: s.width, penStyle: 'fountain', lineStyle: 'solid' } as never), variable: real };
    // What is on screen near the pen each frame (the line's last END_PX), kept to compare with the
    // finished stroke: everything drawn there that later changes is the end "moving" while writing.
    const frames: { from: number; pts: XY[]; w: number[] }[] = [];
    for (const [x, y, t, force] of s.samples) {
      for (const q of dens.push({ x, y, t, pressure: force > 0 ? force : 0 })) {
        pts.push(q);
        live.add(q.x, q.y, q.t ?? t, real ? q.pressure : 0.5);
      }
      if (pts.length > 2) {
        const l = live.line(liveStyle);
        // The modelled points only (the engine's provisional tail has no counterpart to compare).
        const n = live.model.points.length;
        const all = l.final.concat(l.rest).slice(0, n), w = l.finalW.concat(l.restW).slice(0, n);
        const at = arcs(all);
        let k = all.length - 1;
        while (k > 0 && at[all.length - 1] - at[k] < END_PX) k--;
        frames.push({ from: k, pts: all.slice(k), w: w.slice(k) });
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
    if (g.widths) {
      // Nervousness: the width's RMS second difference along the finished line, per px.
      const at = arcs(g.pts);
      for (let i = 1; i < g.pts.length - 1; i++) {
        const h1 = at[i] - at[i - 1], h2 = at[i + 1] - at[i];
        if (h1 < 0.05 || h2 < 0.05) continue;
        const d2 = ((g.widths[i + 1] - g.widths[i]) / h2 - (g.widths[i] - g.widths[i - 1]) / h1) / ((h1 + h2) / 2);
        roughSum += (d2 / g.width) ** 2;
        roughN++;
      }
      // Ripple: each width against the widths averaged over RIPPLE_PX either side.
      for (let i = 0; i < g.pts.length; i++) {
        let sw = 0, ww = 0;
        for (let j = i; j >= 0 && at[i] - at[j] <= 2 * RIPPLE_PX; j--) { const e = Math.exp(-((at[i] - at[j]) ** 2) / (2 * RIPPLE_PX ** 2)); sw += g.widths[j] * e; ww += e; }
        for (let j = i + 1; j < g.pts.length && at[j] - at[i] <= 2 * RIPPLE_PX; j++) { const e = Math.exp(-((at[j] - at[i]) ** 2) / (2 * RIPPLE_PX ** 2)); sw += g.widths[j] * e; ww += e; }
        if (at[i] < 2 * RIPPLE_PX || at[g.pts.length - 1] - at[i] < 2 * RIPPLE_PX) continue;
        rippleSum += ((g.widths[i] - sw / ww) / g.width) ** 2;
        rippleN++;
      }
    }
    // The finished line of the very samples the live line had (strokeGeometry also leaves out the
    // samples after the lift): point for point, the live line's points are its points.
    let same: { pts: XY[]; widths: number[] | null } | null = null;
    if (real) {
      const line = nibStroke(pts);
      same = settledSmooth({ pts: line, widths: inkWidths(line, liveStyle.width), width: liveStyle.width });
      // The end while writing: each frame's drawn end against the same points finished.
      for (const f of frames) {
        for (let i = 0; i < f.pts.length && f.from + i < same.pts.length; i++) {
          const q = same.pts[f.from + i];
          endPos.push(Math.hypot(f.pts[i].x - q.x, f.pts[i].y - q.y));
          endW.push(Math.abs(f.w[i] - same.widths![f.from + i]) / same.widths![f.from + i]);
        }
      }
    }
    // Live, just before the pen lifts: its final part must lie on the finished line, same widths.
    const style = { color: '#000', width: strokeWidth({ tool: 'pen', color: '#000', width: s.width, penStyle: 'fountain', lineStyle: 'solid' } as never), variable: !!g.widths };
    const { final, finalW } = live.line(style);
    if (same) for (let i = 0; i < final.length && i < same.pts.length; i++) {
      exactPos.push(Math.hypot(final[i].x - same.pts[i].x, final[i].y - same.pts[i].y));
      exactW.push(Math.abs(finalW[i] - same.widths![i]) / same.widths![i]);
    }
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
console.log(`           point for point (the same samples finished): position max ${q(exactPos, 1).toFixed(4)} px, width max ${(q(exactW, 1) * 100).toFixed(3)}%`);
const rms = (a: number[]) => Math.sqrt(a.reduce((t, v) => t + v * v, 0) / Math.max(1, a.length));
console.log(`nervous    width roughness ${(Math.sqrt(roughSum / Math.max(1, roughN)) * 1000).toFixed(2)} (RMS 2nd derivative of width / nominal, x1000; lower is calmer)`);
console.log(`ripple     width jitter within ${RIPPLE_PX} px of line: RMS ${(Math.sqrt(rippleSum / Math.max(1, rippleN)) * 100).toFixed(2)}% of the nominal width`);
console.log(`end        the line's last ${END_PX} px while writing vs finished: position RMS ${rms(endPos).toFixed(3)} p99 ${q(endPos, 0.99).toFixed(2)} px, width RMS ${(rms(endW) * 100).toFixed(2)}% p99 ${(q(endW, 0.99) * 100).toFixed(1)}% (lower: the end moves less while writing)`);
