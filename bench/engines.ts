import { ModeledPoint, StrokeModeler as SpringModeler, modelStroke as springStroke, trimLiftOff } from '../src/ink/inkEngine';
import { NibModeler, nibStroke } from '../src/ink/nib';

/** A raw pen sample: page px, ms, force 0..1 (0 = lifting). */
export interface Sample { x: number; y: number; t: number; p: number }

export interface Engine {
  name: string;
  live(): { add(s: Sample): void; settled(): ModeledPoint[]; tail(): ModeledPoint[] };
  final(samples: Sample[]): ModeledPoint[];
}

/** v1.7 engine as CanvasPage drives it (pressure EMA, 0.2 px de-dup); no prediction. */
export const spring: Engine = {
  name: 'v1.7 spring',
  live() {
    const m = new SpringModeler();
    let pe = -1;
    let last: Sample | null = null;
    return {
      add(s) {
        if (last && Math.abs(s.x - last.x) < 0.2 && Math.abs(s.y - last.y) < 0.2) return;
        last = s;
        pe = pe < 0 ? s.p : pe * 0.55 + s.p * 0.45;
        m.add(s.x, s.y, s.t, pe);
      },
      settled: () => m.points,
      tail: () => m.tail(),
    };
  },
  final(samples) {
    let pe = -1;
    let last: Sample | null = null;
    const pts = [];
    const force: number[] = [];
    for (const s of samples) {
      if (last && Math.abs(s.x - last.x) < 0.2 && Math.abs(s.y - last.y) < 0.2) continue;
      last = s;
      pe = pe < 0 ? s.p : pe * 0.55 + s.p * 0.45;
      pts.push({ x: s.x, y: s.y, t: s.t, pressure: pe });
      force.push(s.p);
    }
    // As v1.7's canvas did: the lift-off flick trimmed from the saved stroke.
    return springStroke(trimLiftOff(pts, force));
  },
};

export const nib: Engine = {
  name: 'nib',
  live() {
    const m = new NibModeler();
    return { add: (s) => m.add(s.x, s.y, s.t, s.p), settled: () => m.points, tail: () => m.tail(true) };
  },
  final: (samples) => nibStroke(samples.map((s) => ({ x: s.x, y: s.y, t: s.t, pressure: s.p }))),
};

