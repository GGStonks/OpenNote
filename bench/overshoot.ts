// Real pen recordings through the app's whole pen pipeline (densify -> ink engine -> settled
// smoothing, i.e. the committed stroke): how far the ink strays from the pen's own path.
// npm run bench:overshoot [-- files]
import { readFileSync, readdirSync } from 'node:fs';
import { SampleDensifier } from '../src/ink/densify';
import { strokeGeometry } from '../src/ink/strokeRenderer';
import type { PenRecording } from '../src/ink/penRecorder';
import type { Point, Stroke } from '../src/types';

type XY = { x: number; y: number };
function distToPolyline(p: XY, poly: XY[]): number {
  let best = poly.length ? Math.hypot(p.x - poly[0].x, p.y - poly[0].y) : Infinity;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1], b = poly[i], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const u = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(p.x - a.x - u * dx, p.y - a.y - u * dy));
  }
  return best;
}

const files: string[] = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync('bench/recordings').map((f) => `bench/recordings/${f}`);
for (const densify of [false, true]) {
  const over: number[] = [];
  let worst = { d: 0, file: '', stroke: 0, where: 0 };
  let n05 = 0, n1 = 0, n2 = 0, total = 0;
  for (const file of files) {
    const rec = JSON.parse(readFileSync(file, 'utf8')) as PenRecording;
    rec.strokes.forEach((s, si) => {
      if (s.tool !== 'pen') return;
      const pts: Point[] = [];
      const dens = new SampleDensifier();
      for (const [x, y, t, force] of s.samples) {
        const pt: Point = { x, y, t, pressure: force > 0 ? force : 0 };
        // As CanvasPage.ingestSamples: the densifier decides about resting samples; without it they are skipped.
        const last = pts[pts.length - 1];
        if (!densify && last && Math.abs(pt.x - last.x) < 0.2 && Math.abs(pt.y - last.y) < 0.2) continue;
        for (const q of densify ? dens.push(pt) : [pt]) pts.push(q);
      }
      if (pts.length < 3) return;
      const stroke = { id: 'x', createdAt: 0, tool: 'pen', color: '#000', width: s.width, opacity: 1, penStyle: 'fountain', lineStyle: 'solid', points: pts } as Stroke;
      const g = strokeGeometry(stroke);
      const raw = s.samples.filter((q) => q[3] > 0).map(([x, y]) => ({ x, y }));
      if (raw.length < 2) return;
      let m = 0, at = 0;
      g.pts.forEach((q, i) => {
        const d = distToPolyline(q, raw);
        if (d > m) { m = d; at = i / Math.max(1, g.pts.length - 1); }
      });
      total++;
      if (m > 0.5) n05++;
      if (m > 1) n1++;
      if (m > 2) n2++;
      over.push(m);
      if (m > worst.d) worst = { d: m, file: file.split('/').pop()!, stroke: si, where: at };
    });
  }
  over.sort((a, b) => a - b);
  console.log(`${densify ? 'densified' : 'raw      '}: ${total} strokes | ink farther than 0.5/1/2 px from the pen path: ${n05}/${n1}/${n2} | median ${over[over.length >> 1].toFixed(2)} px, p95 ${over[Math.floor(over.length * 0.95)].toFixed(2)} px, worst ${worst.d.toFixed(2)} px (${worst.file} #${worst.stroke} at ${(worst.where * 100).toFixed(0)}% of the line)`);
}

// The pen rests in a corner (or at touch-down) and leaves fast: 240 Hz samples that do not move,
// then 2000 px/s at a right angle. How far the ink goes past the corner (against the new direction).
for (const densify of [false, true]) {
  for (const restMs of [0, 30, 80, 200]) {
    const pts: Point[] = [];
    const dens = new SampleDensifier();
    let t = 0;
    const feed = (x: number, y: number) => {
      const pt: Point = { x, y, t, pressure: 0.5 };
      const last = pts[pts.length - 1];
      t += 1000 / 240;
      if (!densify && last && Math.abs(pt.x - last.x) < 0.2 && Math.abs(pt.y - last.y) < 0.2) return;
      for (const q of densify ? dens.push(pt) : [pt]) pts.push(q);
    };
    for (let x = 100; x <= 160; x += 800 / 240) feed(x, 100);
    for (let k = 0; k < (restMs * 240) / 1000; k++) feed(160, 100);
    for (let y = 100; y <= 160; y += 2000 / 240) feed(160, y);
    const g = strokeGeometry({ id: 'x', createdAt: 0, tool: 'pen', color: '#000', width: 2, opacity: 1, penStyle: 'fountain', lineStyle: 'solid', points: pts } as Stroke);
    let back = 0, past = 0;
    for (const q of g.pts) {
      back = Math.max(back, 100 - q.y);
      past = Math.max(past, q.x - 160);
    }
    console.log(`corner after a ${String(restMs).padStart(3)} ms rest ${densify ? 'densified' : 'raw      '}: ink ${past.toFixed(2)} px past the corner, ${back.toFixed(2)} px behind the line`);
  }
}
