import { SampleDensifier } from '../../src/ink/densify';
import { detectShape, snapStroke } from '../../src/services/shapeRecognition';
import type { LineStyle, Point, Stroke } from '../../src/types';
import { listRecordingFiles, loadRecording, n, pt4, xy } from './common';
import { synthShapes } from './synthShapes';

export interface ShapesRunOpts {
  per?: number;
  all?: boolean;
  files?: string[];
  [key: string]: unknown;
}

export function run(opts?: ShapesRunOpts): unknown {
  const files = listRecordingFiles(opts?.files);
  const strokes: unknown[] = [];

  for (const file of files) {
    const rec = loadRecording(file);
    const pens = rec.strokes
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.tool === 'pen' && s.samples.length > 2);

    const selection =
      opts?.per && opts.per !== 6 && !opts?.all
        ? pens.filter((_, k) => k % Math.max(1, Math.floor(pens.length / opts.per!)) === 0).slice(0, opts.per)
        : pens;

    for (const { s, i } of selection) {
      const real = s.samples.some((q) => q[3] > 0 && q[3] !== 0.5);
      const dens = new SampleDensifier();
      const rawPoints: Point[] = [];
      const base = {
        id: `${file.split('/').pop()}#${i}`,
        createdAt: 0,
        tool: 'pen' as const,
        color: '#000',
        width: s.width,
        opacity: 1,
        penStyle: 'fountain' as const,
        lineStyle: 'solid' as LineStyle,
      };
      s.samples.forEach(([x, y, t, force]) => {
        for (const q of dens.push({ x, y, t, pressure: force > 0 ? force : 0 })) {
          rawPoints.push(q);
        }
      });
      if (rawPoints.length < 3) continue;
      const lead = real ? [...s.samples].reverse().find((q) => q[3] > 0.02) : undefined;
      const unquantized = lead
        ? [...rawPoints, { x: lead[0], y: lead[1], t: lead[2], pressure: lead[3] }]
        : rawPoints;

      // Ensure Rust and TS read the EXACT same input points
      const points: Point[] = unquantized.map((p) => {
        const [x, y, t, pressure] = pt4(p);
        return { x, y, t, pressure };
      });
      const stroke = (lead
        ? { ...base, points, penEnd: true }
        : { ...base, points }) as Stroke;

      const shape = detectShape(stroke.points);
      const snapped = snapStroke(stroke);
      const snap = snapped.isShape
        ? {
            kind: snapped.shapeKind!,
            points: snapped.points.map(xy),
            width: n(snapped.width),
          }
        : null;

      strokes.push({
        id: stroke.id,
        points: stroke.points.map(pt4),
        width: n(stroke.width),
        snap,
        regularPolygon: !!shape?.regular,
        detectParabola: shape?.kind === 'curve',
      });
    }
  }

  const synths = synthShapes(1);
  for (const s of synths) {
    const points: Point[] = s.points.map((p) => {
      const [x, y, t, pressure] = pt4(p);
      return { x, y, t, pressure };
    });
    const stroke: Stroke = {
      id: s.id,
      createdAt: 0,
      tool: 'pen',
      color: '#000',
      width: 2,
      opacity: 1,
      lineStyle: 'solid',
      points,
    };
    const shape = detectShape(stroke.points);
    const snapped = snapStroke(stroke);
    const snap = snapped.isShape
      ? {
          kind: snapped.shapeKind!,
          points: snapped.points.map(xy),
          width: n(snapped.width),
        }
      : null;

    strokes.push({
      id: s.id,
      points: stroke.points.map(pt4),
      width: n(stroke.width),
      snap,
      regularPolygon: !!shape?.regular,
      detectParabola: shape?.kind === 'curve',
    });
  }

  return { format: 'opennote-rust-ref', version: 1, app: '2.9.4-rs.16', strokes };
}
