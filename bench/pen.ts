/**
 * Pen benchmark: synthetic handwriting with known ground truth, sampled like an Apple Pencil
 * (240 Hz, timestamp jitter, digitiser noise, estimated force at touch-down) and delivered in
 * 120 Hz display frames. Scores an ink engine on what a writer sees:
 *
 *   shape    finished stroke vs the true path: mean / max distance, both directions (cut corners
 *            and shrunken loops show up as true-path points far from the ink)
 *   noise    RMS distance from the true path on slow strokes (digitiser jitter left in the ink)
 *   lag      every frame: distance from the end of the drawn ink (settled + provisional tail) to
 *            where the nib really is when that frame reaches the screen
 *   overshoot  ink drawn beyond the point where the pen stopped
 *   startW   width at the start of the stroke relative to its body (thin, fragile starts)
 *
 * Run: npm run bench:pen
 */
import { pressureWidth } from '../src/ink/inkEngine';
import { NIB } from '../src/ink/nib';
import { Engine, Sample, nib, spring } from './engines';

// Tuning: NIB='{"HORIZON":8}' npm run bench:pen ; SUMMARY=1 prints only the averages.
Object.assign(NIB, JSON.parse(process.env.NIB ?? '{}'));
const SUMMARY = !!process.env.SUMMARY;

type XY = { x: number; y: number };
interface Truth {
  name: string;
  /** Position and pressure at time t (ms), for t in [0, duration]. */
  at: (t: number) => XY;
  force: (t: number) => number;
  duration: number;
  slow?: boolean;
  /** Lift-off strokes: the pen keeps moving while its force fades; the ink must end here (ms). */
  inkEnd?: number;
}

// ---------------------------------------------------------------------------------------------- truth
const minJerk = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * u * (10 - 15 * u + 6 * u * u));

/** A path through `pts` with the pen stopping at every vertex (how real hands draw corners). */
function polyline(name: string, pts: XY[], msPerSeg: number): Truth {
  const n = pts.length - 1;
  return {
    name,
    duration: n * msPerSeg,
    at: (t) => {
      const k = Math.min(n - 1, Math.floor(t / msPerSeg));
      const u = minJerk((t - k * msPerSeg) / msPerSeg);
      return { x: pts[k].x + (pts[k + 1].x - pts[k].x) * u, y: pts[k].y + (pts[k + 1].y - pts[k].y) * u };
    },
    force: bodyForce(n * msPerSeg),
  };
}

/** Writing force: lands light, ~0.35 in the body with a slow wobble, eases off at the end. */
function bodyForce(duration: number) {
  return (t: number) => {
    const land = Math.min(1, t / 14);
    const lift = Math.min(1, (duration - t) / 16);
    return Math.max(0.02, (0.33 + 0.05 * Math.sin(t / 37)) * Math.min(land * 0.7 + 0.3, 1) * Math.min(1, lift * 0.8 + 0.2));
  };
}

/** Speed profile that starts and ends at rest. */
function eased(name: string, curve: (u: number) => XY, duration: number, slow = false): Truth {
  return { name, duration, slow, at: (t) => curve(minJerk(t / duration)), force: bodyForce(duration) };
}

function cursive(name: string, loops: number, height: number, advance: number, msPerLoop: number): Truth {
  // Trochoid: forward motion plus a circle -> loops like "llll" / "eeee".
  const r = height / 2;
  return eased(name, (u) => {
    const a = u * loops * Math.PI * 2;
    return { x: 40 + (advance * a) / (Math.PI * 2) - r * Math.sin(a), y: 100 - r + r * Math.cos(a) };
  }, loops * msPerLoop);
}

const TRUTHS: Truth[] = [
  cursive('cursive llll (36 px)', 5, 36, 14, 210),
  cursive('cursive eeee (14 px)', 6, 14, 9, 150),
  cursive('tiny loops (7 px)', 6, 7, 5, 120),
  polyline('zigzag M/W', [{ x: 20, y: 120 }, { x: 40, y: 60 }, { x: 60, y: 120 }, { x: 80, y: 60 }, { x: 100, y: 120 }], 95),
  polyline('sharp V (12 px)', [{ x: 20, y: 40 }, { x: 26, y: 52 }, { x: 32, y: 40 }], 70),
  eased('fast circle (60 px)', (u) => ({ x: 100 + 30 * Math.cos(u * Math.PI * 2), y: 100 + 30 * Math.sin(u * Math.PI * 2) }), 260),
  eased('flick, stops dead', (u) => ({ x: 20 + 160 * u, y: 50 + 10 * u }), 180),
  eased('slow line (25 px/s)', (u) => ({ x: 20 + 30 * u, y: 80 + 6 * u }), 1500, true),
  eased('slow arc', (u) => ({ x: 60 + 25 * Math.cos(u * 2), y: 60 + 25 * Math.sin(u * 2) }), 1800, true),
  { name: 'dot', duration: 30, at: () => ({ x: 50, y: 50 }), force: bodyForce(30) },
  lifting('lift while moving', (t) => ({ x: 20 + 0.3 * t, y: 50 + 0.05 * t }), 180),
  lifting('lift on a curve', (t) => ({ x: 80 + 40 * Math.cos(t / 130), y: 80 + 40 * Math.sin(t / 130) }), 220),
  lifting('fast lift (900 px/s)', (t) => ({ x: 20 + 0.9 * t, y: 60 - 0.2 * t }), 120),
];

/**
 * The pen leaves the glass while still moving at writing speed (no slowing down): over the last
 * 25 ms the force fades to zero and the Pencil keeps reporting samples in the air. A nib stops
 * inking when the force is gone: the ink must end where it falls below half.
 */
function lifting(name: string, at: (t: number) => XY, duration: number): Truth {
  const fadeFrom = duration - 25, fadeTo = duration - 5;
  return {
    name,
    duration,
    at: (t) => at(Math.min(t, duration)),
    force: (t) => {
      const body = Math.min(1, t / 14) * 0.7 + 0.3;
      const f = 0.33 * Math.min(body, 1);
      return t <= fadeFrom ? f : Math.max(0, 0.33 * (1 - (t - fadeFrom) / (fadeTo - fadeFrom)));
    },
    inkEnd: (fadeFrom + fadeTo) / 2,
  };
}

// -------------------------------------------------------------------------------------------- sensor
let seed = 1;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());


/** 240 Hz Pencil samples: white noise, slow digitiser wobble, timestamp jitter, estimated force. */
function sense(tr: Truth, noise: number): Sample[] {
  const out: Sample[] = [];
  const ph = rand() * 6, ph2 = rand() * 6;
  for (let i = 0; ; i++) {
    const tt = Math.min(tr.duration, i * (1000 / 240));
    const p = tr.at(tt);
    const wob = 0.6 * noise;
    out.push({
      x: p.x + noise * gauss() + wob * Math.sin(tt / 23 + ph),
      y: p.y + noise * gauss() + wob * Math.sin(tt / 29 + ph2),
      t: tt + 0.25 * gauss(),
      // The first samples' force is an estimate: under-read by up to half.
      p: tr.force(tt) * (i < 3 ? 0.5 + 0.17 * i : 1),
    });
    if (tt >= tr.duration) break;
  }
  return out;
}

// ------------------------------------------------------------------------------------------- metrics
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

/** Display pipeline: a frame shows the samples up to DELIVERY ms before it, on screen LATENCY ms later. */
const FRAME = 1000 / 120, DELIVERY = 4, LATENCY = 9;

interface Score { mean: number; max: number; noise: number; lag: number; lagMax: number; over: number; overAvg: number; startW: number; lift: number }

function score(engine: Engine, tr: Truth, noise: number): Score {
  const samples = sense(tr, noise);
  const truth: XY[] = [];
  const inkEnd = tr.inkEnd ?? tr.duration;
  for (let t = 0; t <= inkEnd; t += 0.5) truth.push(tr.at(t));
  truth.push(tr.at(inkEnd));
  /** Ink past where the nib stopped inking, beyond sensor noise. */
  const beyond = (q: XY) => (tr.inkEnd === undefined ? 0 : distToPolyline(q, truth) - 2 * noise - 0.3);
  let lift = 0;

  // Live: frame by frame.
  const live = engine.live();
  let k = 0, lagSum = 0, lagN = 0, lagMax = 0, over = 0, overSum = 0, frames = 0;
  for (let f = FRAME; f < tr.duration + 80; f += FRAME) {
    while (k < samples.length && samples[k].t <= f - DELIVERY) live.add(samples[k++]);
    if (!k) continue;
    const tail = live.tail();
    const settled = live.settled();
    const tip = tail[tail.length - 1] ?? settled[settled.length - 1];
    if (!tip) continue;
    const shownAt = Math.min(tr.duration, f + LATENCY);
    const pen = tr.at(shownAt);
    if (f + LATENCY <= tr.duration) {
      const d = Math.hypot(tip.x - pen.x, tip.y - pen.y);
      lagSum += d;
      lagN++;
      lagMax = Math.max(lagMax, d);
    }
    // Provisional ink where the pen never goes (past the stop, off a curve), beyond sensor noise.
    let fo = 0;
    for (const q of tail) fo = Math.max(fo, distToPolyline(q, truth) - 1.5 * noise - 0.5);
    for (const q of tail) lift = Math.max(lift, beyond(q));
    for (const q of settled) lift = Math.max(lift, beyond(q));
    over = Math.max(over, fo);
    overSum += Math.max(0, fo);
    frames++;
  }

  const ink = engine.final(samples);
  for (const q of ink) lift = Math.max(lift, beyond(q));
  let sum = 0, max = 0;
  for (const q of ink) {
    const d = distToPolyline(q, truth);
    sum += d;
    max = Math.max(max, d);
  }
  let cover = 0;
  for (let i = 0; i < truth.length; i += 4) cover = Math.max(cover, distToPolyline(truth[i], ink));
  const mean = ink.length ? sum / ink.length : 0;
  // Start width: fountain width over the first 4 px of ink vs the stroke median.
  const widths = ink.map((q) => pressureWidth(1, q.p));
  const med = widths.slice().sort((a, b) => a - b)[widths.length >> 1] ?? 1;
  let s = 0, i0 = 0, wmin = Infinity;
  for (; i0 < ink.length && s < 4; i0++) {
    wmin = Math.min(wmin, widths[i0]);
    if (i0) s += Math.hypot(ink[i0].x - ink[i0 - 1].x, ink[i0].y - ink[i0 - 1].y);
  }
  return {
    mean,
    max: Math.max(max, cover),
    noise: tr.slow ? Math.sqrt(ink.reduce((a, q) => a + distToPolyline(q, truth) ** 2, 0) / Math.max(1, ink.length)) : NaN,
    lag: lagN ? lagSum / lagN : 0,
    lagMax,
    over: Math.max(0, over),
    overAvg: frames ? overSum / frames : 0,
    startW: Number.isFinite(wmin) ? wmin / med : 1,
    lift: Math.max(0, lift),
  };
}

// ------------------------------------------------------------------------------------------------ run
const RUNS = 12;
const NOISE = 0.12; // px (CSS px at 1x zoom)
const engines = [spring, nib];
const f = (v: number, d = 2) => (Number.isNaN(v) ? '   -' : v.toFixed(d).padStart(5));
const totals = new Map<string, Score & { n: number; nn: number }>();
if (!SUMMARY) console.log(`${RUNS} runs per stroke, noise ${NOISE} px. Lower is better except startW (1 = full width).\n`);
if (!SUMMARY) console.log('stroke'.padEnd(24) + 'engine'.padEnd(13) + ' mean   max  noise   lag lagMax  over overAv startW  lift');
for (const tr of TRUTHS.filter((t) => !process.env.ONLY || t.name.includes(process.env.ONLY))) {
  for (const e of engines) {
    const acc: Score = { mean: 0, max: 0, noise: 0, lag: 0, lagMax: 0, over: 0, overAvg: 0, startW: 0, lift: 0 };
    seed = 7;
    for (let r = 0; r < RUNS; r++) {
      const s = score(e, tr, NOISE);
      acc.mean += s.mean / RUNS;
      acc.max = Math.max(acc.max, s.max);
      acc.noise += s.noise / RUNS;
      acc.lag += s.lag / RUNS;
      acc.lagMax = Math.max(acc.lagMax, s.lagMax);
      acc.over = Math.max(acc.over, s.over);
      acc.overAvg += s.overAvg / RUNS;
      acc.lift = Math.max(acc.lift, s.lift);
      acc.startW += s.startW / RUNS;
    }
    if (!SUMMARY) console.log(tr.name.padEnd(24) + e.name.padEnd(13) + [acc.mean, acc.max, acc.noise, acc.lag, acc.lagMax, acc.over, acc.overAvg, acc.startW, acc.lift].map((v) => f(v)).join(' '));
    const t = totals.get(e.name) ?? { mean: 0, max: 0, noise: 0, lag: 0, lagMax: 0, over: 0, overAvg: 0, startW: 0, lift: 0, n: 0, nn: 0 };
    t.lift = Math.max(t.lift, acc.lift);
    t.overAvg += acc.overAvg;
    t.mean += acc.mean; t.max += acc.max; t.lag += acc.lag; t.lagMax = Math.max(t.lagMax, acc.lagMax); t.over = Math.max(t.over, acc.over); t.startW += acc.startW; t.n++;
    if (!Number.isNaN(acc.noise)) { t.noise += acc.noise; t.nn++; }
    totals.set(e.name, t);
  }
}
if (!SUMMARY) console.log('\naverage');
for (const [name, t] of totals) {
  console.log(''.padEnd(24) + name.padEnd(13) + [t.mean / t.n, t.max / t.n, t.noise / t.nn, t.lag / t.n, t.lagMax, t.over, t.overAvg / t.n, t.startW / t.n, t.lift].map((v) => f(v)).join(' '));
}
