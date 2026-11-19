/**
 * Reference outputs of the page camera's arithmetic (src/editor/viewportMath.ts, what
 * useViewport.ts calls) for crates/viewport/tests/reference.rs, which compares the Rust port to
 * 1e-9: `npm run bench:rustref -- bench/rust-ref/viewport.json --module viewport`.
 * Infinity is written as null (JSON has none).
 */
import {
  MAX_ZOOM, MIN_ZOOM, clampZoom, cubicBezier, fitWidthZoom, momentumStep, pinchZoom, placeAnchor, pullLeft, releaseVelocity,
  sheetIndexAtTop, shouldRebase, snapsToFit, subPixel, MOMENTUM_MIN_SPEED, MOMENTUM_STOP_SPEED,
} from '../../src/editor/viewportMath';

const inf = (v: number) => (Number.isFinite(v) ? v : null);

export function run(): unknown {
  const clientWidths = [320, 375.5, 820, 1180, 1366];
  const contentWidths = [400, 832, 1123.2, 1600, 3016];
  const zooms = [0.01, 0.2, 0.4999, 0.5, 0.73, 1, 1.0049, 2.5, 4.99, 5, 7.3];
  const floors = [Infinity, 0.1, 0.35, 0.8];

  const clamp: unknown[] = [];
  for (const z of zooms) for (const cw of clientWidths) for (const w of contentWidths) for (const f of floors) clamp.push([z, cw, w, inf(f), clampZoom(z, cw, w, f)]);

  const fit: unknown[] = [];
  for (const cw of clientWidths) for (const w of [0, 0.5, 1, 300, 816, 1123.2, 5000, 1e6]) fit.push([cw, w, fitWidthZoom(cw, w)]);

  const pinch: unknown[] = [];
  for (const z0 of [0.3, 1, 2.2, 4.8]) for (const spread of [12, 100, 157.3, 900]) for (const d0 of [40, 100, 333]) for (const cw of [375.5, 820]) for (const w of [832, 3016])
    pinch.push([z0, spread, d0, cw, w, pinchZoom(z0, spread, d0, cw, w)]);

  const snap: unknown[] = [];
  for (const zf of [0.37, 1, 1.4521]) for (const r of [0.9, 0.9201, 0.95, 1, 1.0799, 1.08, 1.0801, 1.2]) snap.push([zf * r, zf, snapsToFit(zf * r, zf)]);

  const rebase: unknown[] = [];
  for (const k of [0.5, 0.6666, 0.67, 1, 1.4999, 1.5001, 3]) for (const since of [0, 249.9, 250, 250.1, 1000, Infinity]) rebase.push([k, inf(since), shouldRebase(k, since)]);

  const sub: unknown[] = [];
  for (const d of [-1.2, -1, -0.999, -0.555, -0.125, -0.005, 0, 0.004, 0.005, 0.125, 0.335, 0.999, 1, 3.7]) sub.push([d, subPixel(d)]);

  // A glide from a release velocity, stepped at 60 and 120 Hz and with a stalled frame.
  const glides: unknown[] = [];
  for (const [vx, vy] of [[0, 4.2], [-1.3, 2.7], [0.2, -0.15]]) {
    for (const dts of [[16.67], [8.33], [8.33, 8.33, 50, 8.33]]) {
      let x = 0, y = 0, v = { x: vx, y: vy }, i = 0;
      const out: number[] = [];
      if (Math.hypot(vx, vy) >= MOMENTUM_MIN_SPEED) {
        while (Math.hypot(v.x, v.y) > MOMENTUM_STOP_SPEED && i < 5000) {
          const s = momentumStep(v.x, v.y, dts[i++ % dts.length]);
          x -= s.dx;
          y -= s.dy;
          v = { x: s.vx, y: s.vy };
        }
      }
      out.push(x, y, i);
      glides.push([vx, vy, dts, out]);
    }
  }

  const velocity: unknown[] = [];
  for (const h of [
    [],
    [[1, 2, 3]],
    [[0, 0, 0], [10, 5, 8]],
    [[0, 0, 0], [10, 5, 8.01]],
    [[100, 900, 1000], [100, 860, 1008], [101, 820, 1016], [100, 760, 1024], [98, 700, 1032]],
  ]) {
    const v = releaseVelocity(h.map(([x, y, t]) => ({ x, y, t })));
    velocity.push([h, [v.x, v.y]]);
  }

  const bezier: unknown[] = [];
  for (const c of [[0.2, 0.8, 0.2, 1], [0.25, 0.1, 0.25, 1], [0.42, 0, 0.58, 1]]) for (const u of [-0.1, 0, 0.01, 0.1, 0.33, 0.5, 0.77, 0.99, 1, 1.2])
    bezier.push([c, u, cubicBezier(c[0], c[1], c[2], c[3], u)]);
  const pull: unknown[] = [];
  for (const ms of [0, 1, 16.7, 55, 110, 200, 219.9, 220, 400]) pull.push([ms, pullLeft(ms)]);

  const place: unknown[] = [];
  for (const cw of [375.5, 820]) for (const ch of [667, 1110]) for (const [w, h] of [[832, 5376], [3016, 2000], [400, 300]]) for (const z of [0.3, 1, 2.75])
    for (const a of [{ cx: 0, cy: 0, sx: 0, sy: 0 }, { cx: 416, cy: 2000, sx: 410, sy: 555 }, { cx: 6.4, cy: 4000.3, sx: 0, sy: 0.4 }, { cx: 1e4, cy: -50, sx: 12, sy: 900 }]) {
      const box = { clientWidth: cw, clientHeight: ch, contentWidth: w, contentHeight: h };
      const p = placeAnchor(box, z, a);
      place.push([[cw, ch, w, h], z, [a.cx, a.cy, a.sx, a.sy], [p.scrollLeft, p.scrollTop, p.dx, p.dy]]);
    }

  const sheets: unknown[] = [];
  const tops = [0, 1056, 2112, 2900.5];
  for (const y of [-10, 0, 1055.9, 1056, 2000, 2900.5, 1e5]) sheets.push([tops, y, sheetIndexAtTop(tops, y)]);

  return { limits: [MIN_ZOOM, MAX_ZOOM], clamp, fit, pinch, snap, rebase, sub, glides, velocity, bezier, pull, place, sheets };
}
