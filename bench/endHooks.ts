// Real pen recordings: hooks at a stroke's end that the pen did not make. A fast stroke ending at
// speed came out with its line's last few px turned back on itself: the samples without force after
// the lift (the densifier fills the gap to the Pencil's lift sample with more of them) went to the
// ink engine, which never inks them but let them settle its last point. A finger stroke on Android
// ends with the lift's sample (pressure 0), reported ~25 ms after the last move and a few px back
// along the path: drawn as ink, the line's end bent back to it. strokeRenderer.ts `enginePoints`
// leaves both out; this counts the line's end turning back (> 120° in its last 15 px) where the
// pen's own samples did not (< 90°), before and now.
// npm run bench:hooks [-- files]
import { readFileSync, readdirSync } from 'node:fs';
import { SampleDensifier } from '../src/ink/densify';
import { inkGeometry, strokeGeometry, styleOf } from '../src/ink/strokeRenderer';
import type { PenRecording } from '../src/ink/penRecorder';
import type { Point, Stroke } from '../src/types';

type XY = { x: number; y: number };

/**
 * The sharpest turn in the line's last `len` px: the line resampled every px, the angle between the
 * chord over the 3 px before each point and over the 3 px after it (degrees). The same measure for
 * the pen's samples and the drawn line, so a turn the pen really made counts for both.
 */
function endReversal(line: XY[], len = 15): number {
  const pts: XY[] = [];
  let acc = 0;
  for (let i = 0; i < line.length; i++) {
    if (!i) { pts.push(line[0]); continue; }
    const a = line[i - 1], b = line[i], l = Math.hypot(b.x - a.x, b.y - a.y);
    let t = 1 - acc;
    while (t <= l) { pts.push({ x: a.x + ((b.x - a.x) * t) / l, y: a.y + ((b.y - a.y) * t) / l }); t += 1; }
    acc = (acc + l) % 1;
  }
  const n = pts.length;
  let worst = 0;
  for (let i = Math.max(3, n - 1 - len); i < n - 3; i++) {
    const ax = pts[i].x - pts[i - 3].x, ay = pts[i].y - pts[i - 3].y, bx = pts[i + 3].x - pts[i].x, by = pts[i + 3].y - pts[i].y;
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la < 0.5 || lb < 0.5) continue;
    worst = Math.max(worst, (Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)))) * 180) / Math.PI);
  }
  return worst;
}

const files = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync('bench/recordings').map((f) => `bench/recordings/${f}`);
let total = 0, before = 0, now = 0;
for (const file of files) {
  const rec = JSON.parse(readFileSync(file, 'utf8')) as PenRecording;
  rec.strokes.forEach((s, i) => {
    if ((s.tool !== 'pen' && s.tool !== 'highlighter') || s.samples.length < 6) return;
    total++;
    const pts: Point[] = [];
    const dens = new SampleDensifier();
    // As the app builds it: a web stroke (finger, mouse) ends with the lift's sample appended as it
    // came (CanvasPage finish, pressure 0), not densified.
    const lift = s.source === 'web' && s.samples.length > 1 && s.samples[s.samples.length - 1][3] === 0 ? s.samples[s.samples.length - 1] : null;
    for (const [x, y, t, force] of lift ? s.samples.slice(0, -1) : s.samples) for (const q of dens.push({ x, y, t, pressure: force > 0 ? force : 0 })) pts.push(q);
    if (lift) pts.push({ x: lift[0], y: lift[1], t: lift[2], pressure: 0 });
    const stroke = { id: `s${i}`, createdAt: 0, tool: 'pen', color: '#000', width: s.width, opacity: 1, penStyle: s.penStyle ?? 'fountain', lineStyle: 'solid', points: pts } as Stroke;
    // The pen's own turns: its inked samples, densified as the app does (raw samples are too far apart at speed).
    const pen = endReversal(pts.filter((q) => q.pressure > 0));
    if (pen >= 90) return;
    const old = endReversal(inkGeometry(pts, styleOf(stroke)).pts), cur = endReversal(strokeGeometry(stroke).pts);
    if (old > 120) before++;
    if (cur > 120) {
      now++;
      console.log(`  ${file.split('/').pop()} #${i}: the line's end turns ${cur.toFixed(0)}° (the pen ${pen.toFixed(0)}°)`);
    }
  });
}
console.log(`${total} recorded pen strokes: line ends turning back where the pen did not, all samples to the engine ${before}, now ${now}`);
