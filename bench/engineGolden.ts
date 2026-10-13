/**
 * Golden test of the ink engine (src/ink/engine, Nib v1, frozen at OpenNote 1.8.5).
 *
 * Runs a fixed set of synthetic strokes through the engine exactly as the app drives it (samples
 * streamed one by one, the live tail read after each, then the finished stroke) and compares
 * every output point with the recorded reference in bench/engine-golden.json, to 1e-4 px.
 * Any change of the engine's behaviour fails this test; `npm run build` runs it first.
 *
 *   npm run test:engine            check
 *   npm run test:engine -- --update   rewrite the reference (only for a deliberate engine change)
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { NIB, NibModeler, nibStroke } from '../src/ink/engine';

const FILE = 'bench/engine-golden.json';

let seed = 12345;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

type Sample = [number, number, number, number];

/** 240 Hz samples of a path: noise, a force profile with the Pencil's placeholder at touch-down and a fade at the lift. */
function stroke(at: (u: number) => [number, number], ms: number, opts: { force?: number; fade?: boolean; airLift?: number; noise?: number } = {}): Sample[] {
  const out: Sample[] = [];
  const n = Math.max(1, Math.round(ms / (1000 / 240)));
  const f0 = opts.force ?? 0.3, noise = opts.noise ?? 0.15;
  for (let i = 0; i <= n; i++) {
    const t = (i * 1000) / 240, u = i / n;
    const [x, y] = at(u);
    let f = i < 3 ? 0.08 : f0 * (1 + 0.1 * Math.sin(t / 30));
    if (opts.fade && u > 0.85) f *= Math.max(0, 1 - (u - 0.85) / 0.15);
    out.push([x + noise * gauss(), y + noise * gauss(), t + 0.2 * gauss(), Math.max(0, f)]);
  }
  if (opts.airLift) {
    const [x, y] = at(1);
    out.push([x + opts.airLift, y, out[out.length - 1][2] + 20, 0]);
  }
  return out;
}

const ease = (u: number) => u * u * (3 - 2 * u);
const CASES: Record<string, Sample[]> = {
  dot: stroke(() => [50, 50], 30),
  'slow line': stroke((u) => [20 + 30 * u, 80 + 5 * u], 1200),
  'fast line, air lift': stroke((u) => [20 + 300 * ease(u), 60 - 40 * u], 150, { airLift: 60 }),
  'cursive loops': stroke((u) => { const a = u * 5 * 2 * Math.PI; return [40 + 70 * u - 9 * Math.sin(a), 100 + 9 * Math.cos(a)]; }, 900, { fade: true }),
  'tiny loops': stroke((u) => { const a = u * 6 * 2 * Math.PI; return [40 + 30 * u - 3.5 * Math.sin(a), 60 + 3.5 * Math.cos(a)]; }, 700, { fade: true }),
  zigzag: stroke((u) => { const k = Math.min(3, Math.floor(u * 4)), f = ease(u * 4 - k); const ys = [120, 60, 120, 60, 120]; return [20 + 80 * u, ys[k] + (ys[k + 1] - ys[k]) * f]; }, 400),
  circle: stroke((u) => [100 + 30 * Math.cos(ease(u) * 2 * Math.PI), 100 + 30 * Math.sin(ease(u) * 2 * Math.PI)], 260, { force: 0.45, fade: true }),
  'light pressure': stroke((u) => [10 + 120 * u, 40 + 10 * Math.sin(u * 6)], 500, { force: 0.06 }),
  'no pressure (mouse)': stroke((u) => [10 + 80 * u, 30 + 20 * u * u], 300, { force: 0.5, noise: 0 }),
};

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const flat = (pts: { x: number; y: number; p: number; t: number }[]) => pts.map((q) => [r4(q.x), r4(q.y), r4(q.p), r4(q.t)]);

function run(samples: Sample[]) {
  const m = new NibModeler();
  // Live ink after every sample, as a fingerprint (the full frames would be megabytes).
  const live: string[] = [];
  for (const [x, y, t, p] of samples) {
    m.add(x, y, t, p);
    live.push(createHash('sha256').update(JSON.stringify(flat([...m.points, ...m.tail()]))).digest('base64').slice(0, 16));
  }
  const fin = flat(m.finish());
  const whole = flat(nibStroke(samples.map(([x, y, t, p]) => ({ x, y, t, pressure: p }))));
  return { live, final: fin, nibStroke: whole };
}

const result = { engine: 'Nib v1', params: { ...NIB }, cases: Object.fromEntries(Object.entries(CASES).map(([k, v]) => [k, run(v)])) };

if (process.argv.includes('--update')) {
  writeFileSync(FILE, JSON.stringify(result));
  console.log(`wrote ${FILE}`);
  process.exit(0);
}

const ref = JSON.parse(readFileSync(FILE, 'utf8'));
const problems: string[] = [];
if (JSON.stringify(ref.params) !== JSON.stringify(result.params)) problems.push(`NIB parameters changed: ${JSON.stringify(ref.params)} -> ${JSON.stringify(result.params)}`);
for (const [name, got] of Object.entries(result.cases)) {
  const want = ref.cases[name];
  if (!want) { problems.push(`${name}: not in the reference`); continue; }
  for (const key of ['final', 'nibStroke'] as const) {
    if (JSON.stringify(got[key]) !== JSON.stringify(want[key])) problems.push(`${name}: ${key} differs (${got[key].length} vs ${want[key].length} points)`);
  }
  const frame = got.live.findIndex((f, i) => f !== want.live[i]);
  if (frame >= 0 || got.live.length !== want.live.length) problems.push(`${name}: live ink differs from sample ${frame}`);
}
if (problems.length) {
  console.error('INK ENGINE CHANGED — src/ink/engine is frozen (Nib v1, OpenNote 1.8.5):');
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log(`ink engine OK: ${Object.keys(result.cases).length} strokes identical to the reference (live, finished, nibStroke)`);
