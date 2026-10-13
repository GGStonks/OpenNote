/**
 * Replays real pen recordings (Settings > Diagnostics > Record pen strokes) through the ink
 * engines. Real strokes have no ground truth, so the pen's own later samples stand in for it:
 *
 *   input     what the hardware really sent: sample rate, samples per frame, delivery delay,
 *             force at touch-down vs the stroke body, digitiser noise (raw vs a smooth fit)
 *   follow    mean / max distance from the finished ink to the raw samples (ink that wanders
 *             from the pen beyond its noise)
 *   jag       RMS turning per px of the finished ink (jitter left in the line; lower = smoother)
 *   lag       each 120 Hz frame, built from the samples that had arrived by then: end of the
 *             drawn ink vs where the pen was when the frame reached the screen
 *   over      provisional ink farther from the pen's actual path than its noise
 *
 * Writes bench/out/<recording>-<n>.png: raw samples (grey dots), v1.7 ink (red), Nib ink (blue),
 * each stroke magnified.
 *
 * Run: npm run bench:replay -- bench/recordings/<file>.json [more files]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ModeledPoint, pressureWidth } from '../src/ink/inkEngine';
import { NIB } from '../src/ink/nib';
import type { PenRecording, RecordedStroke } from '../src/ink/penRecorder';
import { Engine, Sample, nib, spring } from './engines';

Object.assign(NIB, JSON.parse(process.env.NIB ?? '{}'));
const FRAME = 1000 / 120, LATENCY = 9;
const ENGINES = [spring, nib];

type XY = { x: number; y: number };
const median = (v: number[]) => (v.length ? v.slice().sort((a, b) => a - b)[v.length >> 1] : NaN);
const pct = (v: number[], q: number) => (v.length ? v.slice().sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(v.length * q))] : NaN);

function distToPolyline(p: XY, poly: XY[]): number {
  if (poly.length === 1) return Math.hypot(p.x - poly[0].x, p.y - poly[0].y);
  let best = Infinity;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1], b = poly[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const u = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(p.x - a.x - u * dx, p.y - a.y - u * dy));
  }
  return best;
}

/** Position of the pen at time t, interpolated between raw samples. */
function penAt(s: Sample[], t: number): XY {
  if (t <= s[0].t) return s[0];
  for (let i = 1; i < s.length; i++) {
    if (s[i].t >= t) {
      const f = (t - s[i - 1].t) / Math.max(1e-6, s[i].t - s[i - 1].t);
      return { x: s[i - 1].x + (s[i].x - s[i - 1].x) * f, y: s[i - 1].y + (s[i].y - s[i - 1].y) * f };
    }
  }
  return s[s.length - 1];
}

/** RMS change of direction per px of line, on the ink resampled every 1 px (rad/px). */
function jaggedness(ink: ModeledPoint[]): number {
  const r: XY[] = [ink[0]];
  let acc = 0;
  for (let i = 1; i < ink.length; i++) {
    const a = ink[i - 1], b = ink[i];
    acc += Math.hypot(b.x - a.x, b.y - a.y);
    if (acc >= 1) {
      r.push(b);
      acc = 0;
    }
  }
  let sum = 0, n = 0, prev: number | null = null;
  for (let i = 1; i < r.length; i++) {
    const ang = Math.atan2(r[i].y - r[i - 1].y, r[i].x - r[i - 1].x);
    if (prev !== null) {
      let d = ang - prev;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      if (Math.abs(d) < 2.5) { sum += d * d; n++; } // ignore real cusps
    }
    prev = ang;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

interface Row { follow: number; followMax: number; jag: number; lag: number; lagP95: number; over: number; wiggle: number; width: number; shimmer: number }

/** Resamples a polyline every `step` px. */
function resample(ink: XY[], step: number): XY[] {
  const out: XY[] = [ink[0]];
  let carry = 0;
  for (let i = 1; i < ink.length; i++) {
    const a = ink[i - 1], b = ink[i];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    let s = step - carry;
    while (s <= d) {
      out.push({ x: a.x + ((b.x - a.x) * s) / d, y: a.y + ((b.y - a.y) * s) / d });
      s += step;
    }
    carry = d - (s - step);
  }
  return out;
}

/**
 * Wiggle: RMS change of curvature between neighbouring 1 px steps (rad/px^2). Real letters bend
 * smoothly (curvature changes slowly); digitiser noise flips it from step to step.
 */
function wiggle(ink: XY[]): number {
  const r = resample(ink, 1);
  const turn: number[] = [];
  for (let i = 2; i < r.length; i++) {
    let d = Math.atan2(r[i].y - r[i - 1].y, r[i].x - r[i - 1].x) - Math.atan2(r[i - 1].y - r[i - 2].y, r[i - 1].x - r[i - 2].x);
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    turn.push(d);
  }
  let sum = 0, n = 0;
  for (let i = 1; i < turn.length; i++) if (Math.abs(turn[i]) < 1 && Math.abs(turn[i - 1]) < 1) { sum += (turn[i] - turn[i - 1]) ** 2; n++; }
  return n ? Math.sqrt(sum / n) : 0;
}

/** Fountain-pen width wobble: RMS relative width change per px of line. */
function widthWobble(ink: ModeledPoint[]): number {
  let sum = 0, len = 0;
  for (let i = 1; i < ink.length; i++) {
    const d = Math.hypot(ink[i].x - ink[i - 1].x, ink[i].y - ink[i - 1].y);
    if (d < 1e-6) continue;
    const w0 = pressureWidth(1, ink[i - 1].p), w1 = pressureWidth(1, ink[i].p);
    sum += ((w1 - w0) / w0) ** 2 / d;
    len += d;
  }
  return len ? Math.sqrt(sum / len) : 0;
}

function evaluate(e: Engine, st: RecordedStroke, noise: number): Row & { ink: ModeledPoint[] } {
  const raw: Sample[] = st.samples.map(([x, y, t, f]) => ({ x, y, t, p: f }));
  const arrival = st.samples.map((s) => s[4]);
  const live = e.live();
  let k = 0;
  const lags: number[] = [];
  let over = 0;
  const end = raw[raw.length - 1].t;
  // Tip shimmer: how far the displayed ink near the tip moves from one frame to the next.
  let prevShown: XY[] | null = null;
  let shimSum = 0, shimN = 0;
  for (let f = (arrival[0] ?? 0) + FRAME; k < raw.length || f < (arrival[arrival.length - 1] ?? 0) + 2 * FRAME; f += FRAME) {
    while (k < raw.length && arrival[k] <= f) live.add(raw[k++]);
    if (!k) continue;
    const tail = live.tail();
    const settled = live.settled();
    const tip = tail[tail.length - 1] ?? settled[settled.length - 1];
    if (tip && f + LATENCY <= end) {
      const pen = penAt(raw, f + LATENCY);
      lags.push(Math.hypot(tip.x - pen.x, tip.y - pen.y));
    }
    for (const q of tail) over = Math.max(over, distToPolyline(q, raw) - 2 * noise - 0.3);
    // Ink shown in this frame vs the last: last 12 px of the previous frame's ink, distance to this frame's.
    const shown = [...settled.slice(-600), ...tail];
    if (prevShown && shown.length > 1) {
      let acc = 0;
      for (let j = prevShown.length - 1; j > 0 && acc < 12; j--) {
        acc += Math.hypot(prevShown[j].x - prevShown[j - 1].x, prevShown[j].y - prevShown[j - 1].y);
        shimSum += distToPolyline(prevShown[j], shown);
        shimN++;
      }
    }
    prevShown = shown;
    if (k >= raw.length && f > (arrival[arrival.length - 1] ?? 0) + 2 * FRAME) break;
  }
  const ink = e.final(raw);
  const d = ink.map((q) => distToPolyline(q, raw));
  return {
    ink,
    follow: d.reduce((a, b) => a + b, 0) / Math.max(1, d.length),
    followMax: Math.max(0, ...d),
    jag: jaggedness(ink),
    wiggle: wiggle(ink),
    width: widthWobble(ink),
    shimmer: shimN ? shimSum / shimN : 0,
    lag: lags.length ? lags.reduce((a, b) => a + b, 0) / lags.length : 0,
    lagP95: pct(lags, 0.95) || 0,
    over: Math.max(0, over),
  };
}

/** Digitiser noise: RMS of raw samples about a local line fit over +/-3 samples, on slow parts. */
function noiseOf(raw: Sample[]): number {
  const res: number[] = [];
  for (let i = 3; i < raw.length - 3; i++) {
    const w = raw.slice(i - 3, i + 4);
    const v = Math.hypot(w[6].x - w[0].x, w[6].y - w[0].y) / Math.max(1e-6, w[6].t - w[0].t);
    if (v > 0.15) continue; // slow parts only: there curvature does not leak into the residual
    const mx = w.reduce((a, q) => a + q.x, 0) / 7, my = w.reduce((a, q) => a + q.y, 0) / 7;
    const mt = w.reduce((a, q) => a + q.t, 0) / 7;
    let sxt = 0, syt = 0, stt = 0;
    for (const q of w) { sxt += (q.t - mt) * (q.x - mx); syt += (q.t - mt) * (q.y - my); stt += (q.t - mt) ** 2; }
    const ex = mx + (sxt / (stt || 1)) * (raw[i].t - mt), ey = my + (syt / (stt || 1)) * (raw[i].t - mt);
    res.push(Math.hypot(raw[i].x - ex, raw[i].y - ey));
  }
  return res.length > 10 ? Math.sqrt(res.reduce((a, b) => a + b * b, 0) / res.length) / Math.sqrt(1 - 1 / 7) : NaN;
}

function inputReport(strokes: RecordedStroke[]) {
  const dts: number[] = [], perFrame: number[] = [], delays: number[] = [], landing: number[] = [], speeds: number[] = [], noises: number[] = [];
  for (const st of strokes) {
    const s = st.samples;
    for (let i = 1; i < s.length; i++) {
      dts.push(s[i][2] - s[i - 1][2]);
      if (s[i][2] > 0) delays.push(s[i][4] - s[i][2]);
      speeds.push(Math.hypot(s[i][0] - s[i - 1][0], s[i][1] - s[i - 1][1]) / Math.max(0.1, s[i][2] - s[i - 1][2]));
    }
    const groups = new Map<number, number>();
    for (const q of s) groups.set(q[4], (groups.get(q[4]) ?? 0) + 1);
    perFrame.push(...groups.values());
    const body = median(s.filter((q) => q[3] > 0).map((q) => q[3]));
    if (body > 0 && s.length > 8) landing.push(...s.slice(0, 3).map((q) => q[3] / body));
    const n = noiseOf(s.map(([x, y, t, p]) => ({ x, y, t, p })));
    if (!Number.isNaN(n)) noises.push(n);
  }
  const src = strokes.reduce((m, s) => m.set(s.source, (m.get(s.source) ?? 0) + 1), new Map<string, number>());
  console.log(`input: ${strokes.length} strokes (${[...src].map(([k, v]) => `${v} ${k}`).join(', ')}), ${dts.length + strokes.length} samples`);
  console.log(`  sample interval  median ${median(dts).toFixed(2)} ms (${(1000 / median(dts)).toFixed(0)} Hz), p95 ${pct(dts, 0.95).toFixed(2)} ms`);
  console.log(`  per delivery     median ${median(perFrame)} samples, p95 ${pct(perFrame, 0.95)}`);
  console.log(`  delivery delay   median ${median(delays).toFixed(1)} ms after the sample (p95 ${pct(delays, 0.95).toFixed(1)})`);
  console.log(`  pen speed        median ${(median(speeds) * 1000).toFixed(0)} px/s, p95 ${(pct(speeds, 0.95) * 1000).toFixed(0)} px/s`);
  console.log(`  force at landing first 3 samples = ${landing.length ? (median(landing) * 100).toFixed(0) : '-'}% of the stroke's median force`);
  console.log(`  digitiser noise  ~${noises.length ? median(noises).toFixed(3) : '-'} px RMS (slow parts)`);
  return noises.length ? median(noises) : 0.12;
}

function svgSheet(strokes: RecordedStroke[], results: Map<string, ModeledPoint[]>[], title: string): string {
  const cols = 4, cell = 300, pad = 12;
  const rows = Math.ceil(strokes.length / cols);
  const parts: string[] = [];
  strokes.forEach((st, i) => {
    const xs = st.samples.map((s) => s[0]), ys = st.samples.map((s) => s[1]);
    const x0 = Math.min(...xs), y0 = Math.min(...ys), w = Math.max(...xs) - x0 || 1, h = Math.max(...ys) - y0 || 1;
    const k = Math.min(12, (cell - 2 * pad) / Math.max(w, h));
    const ox = (i % cols) * cell + pad + (cell - 2 * pad - w * k) / 2, oy = Math.floor(i / cols) * cell + 30 + pad + (cell - 2 * pad - h * k) / 2;
    const X = (x: number) => (ox + (x - x0) * k).toFixed(1), Y = (y: number) => (oy + (y - y0) * k).toFixed(1);
    const line = (pts: XY[], color: string, wd: number) => `<polyline fill="none" stroke="${color}" stroke-width="${wd}" stroke-linejoin="round" stroke-linecap="round" points="${pts.map((p) => `${X(p.x)},${Y(p.y)}`).join(' ')}"/>`;
    parts.push(`<rect x="${(i % cols) * cell}" y="${Math.floor(i / cols) * cell + 30}" width="${cell}" height="${cell}" fill="none" stroke="#ddd"/>`);
    parts.push(`<text x="${(i % cols) * cell + 6}" y="${Math.floor(i / cols) * cell + 44}" font-size="11" fill="#666">#${i} ${st.source} ${st.samples.length} samples, ${k.toFixed(1)}x</text>`);
    parts.push(line(results[i].get(spring.name)!, '#E5484D', 1.4));
    parts.push(line(results[i].get(nib.name)!, '#0B6BFF', 1.4));
    for (const s of st.samples) parts.push(`<circle cx="${X(s[0])}" cy="${Y(s[1])}" r="1.3" fill="${s[3] > 0 ? '#555' : '#d0a000'}"/>`);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * cell}" height="${rows * cell + 30}" style="background:#fff"><rect width="100%" height="100%" fill="#fff"/>` +
    `<text x="8" y="20" font-size="14" font-family="sans-serif">${title} — grey: raw samples (yellow: no force), red: v1.7, blue: Nib</text>${parts.join('')}</svg>`;
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: npm run bench:replay -- bench/recordings/<file>.json');
  process.exit(1);
}
mkdirSync('bench/out', { recursive: true });
for (const file of files) {
  const rec = JSON.parse(readFileSync(file, 'utf8')) as PenRecording;
  const strokes = rec.strokes.filter((s) => s.samples.length >= 2);
  console.log(`\n=== ${basename(file)} — app ${rec.app}, ${rec.platform}, dpr ${rec.devicePixelRatio}, ${rec.userAgent.slice(0, 80)}`);
  const noise = inputReport(strokes);
  const results: Map<string, ModeledPoint[]>[] = strokes.map(() => new Map());
  console.log('\nengine          follow  max    jag(rad/px)  lag   lag95  over   wiggle  width  shimmer');
  for (const e of ENGINES) {
    const rows = strokes.map((st, i) => {
      const r = evaluate(e, st, noise);
      results[i].set(e.name, r.ink);
      return r;
    });
    const avg = (f: (r: Row) => number) => rows.reduce((a, r) => a + f(r), 0) / Math.max(1, rows.length);
    console.log(e.name.padEnd(14) + [avg((r) => r.follow), Math.max(...rows.map((r) => r.followMax)), avg((r) => r.jag), avg((r) => r.lag), avg((r) => r.lagP95), Math.max(...rows.map((r) => r.over)), avg((r) => r.wiggle), avg((r) => r.width), avg((r) => r.shimmer)].map((v) => v.toFixed(3).padStart(7)).join(' '));
  }
  // Contact sheets: 16 strokes per image.
  for (let i = 0; !process.env.NO_PNG && i < strokes.length; i += 16) {
    const svg = svgSheet(strokes.slice(i, i + 16), results.slice(i, i + 16), `${basename(file)} strokes ${i}-${Math.min(strokes.length, i + 16) - 1}`);
    const out = join('bench/out', `${basename(file, '.json')}-${i / 16}`);
    writeFileSync(out + '.svg', svg);
    try {
      execFileSync('rsvg-convert', ['-o', out + '.png', out + '.svg']);
      console.log(`wrote ${out}.png`);
    } catch {
      console.log(`wrote ${out}.svg`);
    }
  }
}
