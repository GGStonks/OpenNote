// Live smooth line on fast strokes: per-frame cost of SmoothLiveStroke.line, the smoothness of
// the line (sharpest turn over 2 px), how far it strays from the true path, and whether the
// incremental live line equals the committed line (settledSmooth of the whole stroke).
// npm run bench:live
import { SmoothLiveStroke } from '../src/ink/smoothLiveStroke';
import { SampleDensifier } from '../src/ink/densify';
import { smoothLine, settledIndex } from '../src/ink/strokeRenderer';
import { pressureWidth } from '../src/ink/engine';
import type { Point } from '../src/types';

const style = { width: 2.4, variable: true, color: '#000' };
const R = 40;
const path = (t: number, speed: number) => {
  const a = (speed * t) / R;
  return { x: 400 + R * Math.cos(a) + 30 * t, y: 400 + R * Math.sin(a) };
};

function run(label: string, hz: number, speed: number, secs: number, densify: boolean) {
  const s = new SmoothLiveStroke();
  const dens = new SampleDensifier();
  const perFrame = Math.max(1, Math.round(hz / 60));
  const n = Math.round(hz * secs);
  const frames: number[] = [];
  let fed = 0;
  for (let i = 0; i < n; i++) {
    const t = i / hz;
    const q = path(t, speed);
    const pt: Point = { x: q.x, y: q.y, t: t * 1000, pressure: 0.5 + 0.2 * Math.sin(t * 7) };
    for (const p of densify ? dens.push(pt) : [pt]) {
      s.add(p.x, p.y, p.t!, p.pressure);
      fed++;
    }
    if (i % perFrame === perFrame - 1) {
      const t0 = performance.now();
      s.line(style as never);
      frames.push(performance.now() - t0);
    }
  }
  const { final } = s.line(style as never);
  // Smoothness: sharpest turn between directions 1 px before and after each point (degrees).
  const P = final;
  const at = [0];
  for (let i = 1; i < P.length; i++) at.push(at[i - 1] + Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y));
  let worst = 0, worstAt = 0;
  for (let i = 1, a = 0, b = 0; i < P.length - 1; i++) {
    // a: the last point at least 1 px before i, b: the first at least 1 px after.
    while (a + 1 < i && at[i] - at[a + 1] >= 1) a++;
    if (b < i) b = i;
    while (b < P.length - 1 && at[b] - at[i] < 1) b++;
    if (at[i] - at[a] < 1 || at[b] - at[i] < 1 || P[i].t < 60) continue;
    const t1 = Math.atan2(P[i].y - P[a].y, P[i].x - P[a].x), t2 = Math.atan2(P[b].y - P[i].y, P[b].x - P[i].x);
    let d = Math.abs(t2 - t1);
    if (d > Math.PI) d = 2 * Math.PI - d;
    if ((d * 180) / Math.PI > worst) { worst = (d * 180) / Math.PI; worstAt = P[i].t; }
  }
  // Ideal turn over 2 px on this path: about 2 / R rad.
  // Stray: distance of the line from the swirl's centre path (radius error).
  let stray = 0, strayAt = 0;
  for (const p of P) {
    if (p.t < 60) continue;
    const t = p.t / 1000;
    const cx = 400 + 30 * t, cy = 400;
    const e = Math.abs(Math.hypot(p.x - cx, p.y - cy) - R);
    if (e > stray) { stray = e; strayAt = p.t; }
  }
  // Live == committed: the whole raw line smoothed at once.
  const raw = s.model.points;
  const widthOf = (q: { p: number }) => pressureWidth(style.width, q.p);
  const full = smoothLine({ pts: raw.slice(), widths: raw.map(widthOf), width: style.width }, settledIndex(raw));
  let diff = 0;
  for (let i = 0; i < final.length; i++) diff = Math.max(diff, Math.hypot(final[i].x - full.pts[i].x, final[i].y - full.pts[i].y));
  frames.sort((a, b) => a - b);
  const last = frames.slice(-Math.ceil(frames.length / 10));
  console.log(
    `${label.padEnd(30)} ${densify ? 'densified' : 'raw      '}: ${String(fed).padStart(5)} samples, ${String(raw.length).padStart(6)} pts | ` +
      `frame median ${frames[frames.length >> 1].toFixed(3)} ms, end ${(last.reduce((a, b) => a + b, 0) / last.length).toFixed(3)} ms | ` +
      `final ${final.length} | sharpest turn ${worst.toFixed(1)}° @${worstAt.toFixed(0)}ms (ideal ${((2 / R) * 180 / Math.PI).toFixed(1)}°), radius error ${stray.toFixed(2)} px @${strayAt.toFixed(0)}ms | live vs committed ${diff.toExponential(1)} px`,
  );
}

for (const [label, hz, speed, secs] of [
  ['swirl 240Hz 3000px/s', 240, 3000, 3],
  ['swirl 120Hz 3000px/s', 120, 3000, 3],
  ['swirl 60Hz 2000px/s', 60, 2000, 3],
  ['swirl 240Hz 800px/s', 240, 800, 3],
] as const) {
  run(label, hz, speed, secs, false);
  run(label, hz, speed, secs, true);
}

// Corners: a zigzag at full speed (no slowing down into the corners, the worst case). How far the
// line passes the corner point (overshoot) and how far it cuts inside it.
function zigzag(hz: number, speed: number, densify: boolean) {
  const s = new SmoothLiveStroke();
  const dens = new SampleDensifier();
  const leg = 60, legs = 8;
  const corner = (k: number) => ({ x: 100 + k * leg * 0.5, y: k % 2 ? 100 : 100 + leg * 0.866 });
  const total = (leg * legs) / speed;
  for (let i = 0; i <= Math.round(total * hz); i++) {
    const t = i / hz, d = Math.min(leg * legs, t * speed), k = Math.min(legs - 1, Math.floor(d / leg)), f = d / leg - k;
    const a = corner(k), b = corner(k + 1);
    const pt: Point = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, t: t * 1000, pressure: 0.6 };
    for (const p of densify ? dens.push(pt) : [pt]) s.add(p.x, p.y, p.t!, p.pressure);
  }
  s.model.finish();
  const P = s.line(style as never).final;
  let over = 0;
  for (let k = 1; k < legs; k++) {
    const c = corner(k);
    // Overshoot: how far beyond the corner's y the line goes (the zigzag's corners are its extremes in y).
    const up = k % 2 === 1;
    for (const p of P) if (Math.abs(p.x - c.x) < leg * 0.3) over = Math.max(over, up ? c.y - p.y : p.y - c.y);
  }
  let cut = Infinity;
  for (let k = 1; k < legs; k++) {
    const c = corner(k);
    let best = Infinity;
    for (const p of P) best = Math.min(best, Math.hypot(p.x - c.x, p.y - c.y));
    cut = Math.min(cut, best);
    cut = Math.max(cut === Infinity ? 0 : cut, 0);
  }
  let worstCut = 0;
  for (let k = 1; k < legs; k++) {
    const c = corner(k);
    let best = Infinity;
    for (const p of P) best = Math.min(best, Math.hypot(p.x - c.x, p.y - c.y));
    worstCut = Math.max(worstCut, best);
  }
  console.log(`zigzag ${hz}Hz ${speed}px/s ${densify ? 'densified' : 'raw      '}: overshoot ${over.toFixed(2)} px, corner rounded off by up to ${worstCut.toFixed(2)} px`);
}
for (const [hz, speed] of [[240, 1500], [120, 1500], [60, 1200]] as const) {
  zigzag(hz, speed, false);
  zigzag(hz, speed, true);
}
