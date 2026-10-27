// Real pen recordings: where the shell's native lead reaches at lift versus where the finished
// stroke ends. While writing, ONInkView (ios-native/OpenNoteShell.m) draws a lead from the end of
// the modelled line to the Pencil's newest sample, while the newest sample of each move has force
// (> 2% of its maximum; src/ink/nativePencil.ts keeps the same lead). If the finished stroke
// ended short of it, its tip pulled back at every lift (zoomed in, a page px is several screen px):
// since 2.4.8 a stroke with a lead at lift runs on to it (Stroke.penEnd), so the gap must be 0.
// npm run bench:leadend [-- files]
import { readFileSync, readdirSync } from 'node:fs';
import { SampleDensifier } from '../src/ink/densify';
import { strokeGeometry } from '../src/ink/strokeRenderer';
import type { PenRecording, RecordedSample } from '../src/ink/penRecorder';
import type { Point, Stroke } from '../src/types';

const LEAD_FORCE = 0.02; // OpenNoteShell.m / nativePencil.ts

/** The lead at lift: the newest sample of the last move delivery (the last is the lift's), if it has force. */
function leadAtLift(samples: RecordedSample[]): RecordedSample | null {
  const deliveries: RecordedSample[][] = [];
  for (const q of samples) {
    const last = deliveries[deliveries.length - 1];
    if (last && last[0][4] === q[4]) last.push(q);
    else deliveries.push([q]);
  }
  if (deliveries.length < 3) return null;
  const move = deliveries[deliveries.length - 2];
  const newest = move[move.length - 1];
  return newest[3] > LEAD_FORCE ? newest : null;
}

const files: string[] = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync('bench/recordings').map((f) => `bench/recordings/${f}`);
const before: number[] = [], after: number[] = [];
let strokes = 0;
for (const file of files) {
  const rec = JSON.parse(readFileSync(file, 'utf8')) as PenRecording;
  rec.strokes.forEach((s) => {
    if (s.tool !== 'pen') return;
    const pts: Point[] = [];
    const dens = new SampleDensifier();
    for (const [x, y, t, force] of s.samples) {
      for (const q of dens.push({ x, y, t, pressure: force > 0 ? force : 0 })) pts.push(q);
    }
    if (pts.length < 3) return;
    strokes++;
    const lead = leadAtLift(s.samples);
    if (!lead) return;
    const base = { id: 'x', createdAt: 0, tool: 'pen', color: '#000', width: s.width, opacity: 1, penStyle: 'fountain', lineStyle: 'solid' } as const;
    const end = (st: Stroke) => {
      const g = strokeGeometry(st);
      const e = g.pts[g.pts.length - 1];
      return Math.hypot(lead[0] - e.x, lead[1] - e.y);
    };
    before.push(end({ ...base, points: pts }));
    after.push(end({ ...base, points: [...pts, { x: lead[0], y: lead[1], t: lead[2], pressure: lead[3] }], penEnd: true }));
  });
}
const stat = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const at = (q: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))].toFixed(2) : '-');
  return `median ${at(0.5)}, p90 ${at(0.9)}, p99 ${at(0.99)}, max ${s.length ? s[s.length - 1].toFixed(2) : '-'}`;
};
console.log(`${strokes} pen strokes, ${before.length} with a lead at lift`);
console.log(`  lead to the stroke's end, engine end only (before 2.4.8): ${stat(before)} page px`);
console.log(`  lead to the stroke's end, with the pen end:               ${stat(after)} page px`);
