/**
 * Selection reference generator with comprehensive real selections over strokes and blocks.
 * Page builder includes latexBlocks, textBlocks, and imageBlocks to test block selection.
 */

import { SampleDensifier } from '../../src/ink/densify';
import { snapStroke } from '../../src/services/shapeRecognition';
import {
  computeBounds,
  selectInLasso,
  selectInRect,
  transformSelection,
  RectBounds,
  Selection,
} from '../../src/editor/selection';
import { itemTime, restamp, zLayers } from '../../src/editor/zorder';
import {
  dragHandle,
  ellipsePoints,
  shapeHandles,
  ShapeHandle,
} from '../../src/editor/shapeEdit';
import { curveSegments, strokeBounds, strokeGeometry } from '../../src/ink/strokeRenderer';
import { flattenBeziers } from '../../src/ink/spline';
import { PAGE_WIDTH } from '../../src/types';
import type { ImageBlock, LatexBlock, NotePage, Point, Stroke, TextBlock } from '../../src/types';
import { listRecordingFiles, loadRecording, n, pt4, xy } from './common';
import { synthShapes } from './synthShapes';

function mulberry32(seed: number) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function getStrokeLine(s: Stroke): { x: number; y: number }[] {
  if (s.shapeKind === 'curve') {
    return flattenBeziers(curveSegments(s.points, !!s.closed && s.points.length > 2), 2);
  }
  if (!s.isShape) {
    return strokeGeometry(s).pts;
  }
  return s.points;
}

function insidePoly(p: { x: number; y: number }, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function cutsPartly(s: Stroke, rect?: RectBounds, lassoPoly?: { x: number; y: number }[]): boolean {
  const pts = getStrokeLine(s);
  if (pts.length < 2) return false;
  let hasIn = false;
  let hasOut = false;
  if (rect) {
    for (const p of pts) {
      if (p.x >= rect.minX && p.x <= rect.maxX && p.y >= rect.minY && p.y <= rect.maxY) {
        hasIn = true;
      } else {
        hasOut = true;
      }
      if (hasIn && hasOut) return true;
    }
  } else if (lassoPoly) {
    for (const p of pts) {
      if (insidePoly(p, lassoPoly)) {
        hasIn = true;
      } else {
        hasOut = true;
      }
      if (hasIn && hasOut) return true;
    }
  }
  return hasIn && hasOut;
}

export interface SelectionRunOpts {
  per?: number;
  files?: string[];
  out?: string;
  [key: string]: unknown;
}

export function run(opts?: SelectionRunOpts): unknown {
  const files = listRecordingFiles(opts?.files);
  const pageStrokes: Stroke[] = [];
  const per = opts?.per ?? 4;

  for (const file of files) {
    const rec = loadRecording(file);
    const pens = rec.strokes.filter((s) => s.tool === 'pen' && s.samples.length > 2);
    const step = Math.max(1, Math.floor(pens.length / per));
    const selected = pens.filter((_, k) => k % step === 0).slice(0, per);
    for (let i = 0; i < selected.length; i++) {
      const s = selected[i];
      const dens = new SampleDensifier();
      const rawPoints: Point[] = [];
      const real = s.samples.some((q) => q[3] > 0 && q[3] !== 0.5);
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
      const points = unquantized.map((p) => {
        const [x, y, t, pressure] = pt4(p);
        return { x, y, t, pressure };
      });
      pageStrokes.push({
        id: `rec_${file.split('/').pop()}_${i}`,
        createdAt: 1700000000000 + pageStrokes.length * 10,
        tool: 'pen',
        color: '#000000',
        width: n(s.width || 2),
        opacity: 1,
        penStyle: 'fountain',
        lineStyle: 'solid',
        points,
        ...(lead ? { penEnd: true } : {}),
      });
    }
  }

  const synths = synthShapes(2);
  const synthIndices = [0, 3, 6, 9, 12, 15, 21];
  for (const idx of synthIndices) {
    if (idx < synths.length) {
      const s = synths[idx];
      const stroke: Stroke = {
        id: `synth_${s.id}`,
        createdAt: 1700000000000 + pageStrokes.length * 10,
        tool: 'pen',
        color: '#ff0000',
        width: 2,
        opacity: 1,
        lineStyle: 'solid',
        points: s.points.map((p) => {
          const [x, y, t, pressure] = pt4(p);
          return { x, y, t, pressure };
        }),
      };
      const snapped = snapStroke(stroke);
      pageStrokes.push({
        ...snapped,
        id: `synth_${s.id}`,
        points: snapped.points.map((p) => {
          const [x, y, t, pressure] = pt4(p);
          return { x, y, t, pressure };
        }),
      });
    }
  }

  const latexBlocks: LatexBlock[] = [
    {
      id: 'latex_1',
      x: 180,
      y: 980,
      width: 220,
      height: 60,
      scale: 1.0,
      latexCode: 'x^2 + y^2 = r^2',
      createdAt: 1700000000050,
      rotation: 0,
    },
    {
      id: 'latex_2',
      x: 480,
      y: 1050,
      width: 160,
      height: 70,
      scale: 1.1,
      latexCode: '\\alpha + \\beta',
      createdAt: 1700000000150,
      rotation: 12,
    },
  ];

  const textBlocks: TextBlock[] = [
    {
      id: 'text_1',
      x: 140,
      y: 1100,
      width: 200,
      height: 45,
      fontSize: 16,
      color: '#000000',
      text: 'Title of Note\nSecond line of note',
      createdAt: 1700000000080,
      rotation: 0,
    },
    {
      id: 'text_2',
      x: 500,
      y: 1250,
      width: 150,
      height: 40,
      fontSize: 14,
      color: '#000000',
      text: 'Rotated block sample',
      createdAt: 1700000000180,
      rotation: -10,
    },
  ];

  const imageBlocks: ImageBlock[] = [
    {
      id: 'image_1',
      x: 220,
      y: 1600,
      width: 140,
      height: 90,
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      createdAt: 1700000000120,
      rotation: 5,
    },
  ];

  const page: NotePage = {
    id: 'page_selection_ref',
    pageNumber: 1,
    strokes: pageStrokes,
    latexBlocks,
    textBlocks,
    imageBlocks,
  };

  const rng = mulberry32(7);
  const pageSide = PAGE_WIDTH;

  const strokeInfo = pageStrokes.map((s) => {
    const b = strokeBounds(s);
    return {
      s,
      b,
      cx: (b.minX + b.maxX) / 2,
      cy: (b.minY + b.maxY) / 2,
    };
  });

  const closePairs: Array<{
    s1: typeof strokeInfo[0];
    s2: typeof strokeInfo[0];
    d: number;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  }> = [];

  for (let i = 0; i < strokeInfo.length; i++) {
    for (let j = i + 1; j < strokeInfo.length; j++) {
      const s1 = strokeInfo[i];
      const s2 = strokeInfo[j];
      const d = Math.hypot(s1.cx - s2.cx, s1.cy - s2.cy);
      if (d < 450) {
        closePairs.push({
          s1,
          s2,
          d,
          minX: Math.min(s1.b.minX, s2.b.minX),
          maxX: Math.max(s1.b.maxX, s2.b.maxX),
          minY: Math.min(s1.b.minY, s2.b.minY),
          maxY: Math.max(s1.b.maxY, s2.b.maxY),
        });
      }
    }
  }

  // Fixed rects for selectInRect
  const rects: RectBounds[] = [
    { minX: 160, minY: 960, maxX: 430, maxY: 1070 },
    { minX: 120, minY: 1080, maxX: 360, maxY: 1170 },
    { minX: 200, minY: 1580, maxX: 380, maxY: 1710 },
    { minX: 460, minY: 1030, maxX: 660, maxY: 1140 },
    { minX: 8500, minY: 8500, maxX: 9500, maxY: 9500 },
  ];

  const generatedRects: RectBounds[] = [];
  for (let i = 0; i < 200; i++) {
    const w = pageSide * (0.05 + 0.75 * rng());
    const h = pageSide * (0.05 + 0.75 * rng());
    if (i < 175 && closePairs.length > 0) {
      const fitting = closePairs.filter((p) => (p.maxX - p.minX) <= w * 0.95 && (p.maxY - p.minY) <= h * 0.95);
      const pair = fitting.length > 0
        ? fitting[Math.floor(rng() * fitting.length)]
        : closePairs[Math.floor(rng() * closePairs.length)];
      const midX = (pair.minX + pair.maxX) / 2;
      const midY = (pair.minY + pair.maxY) / 2;
      const slackX = Math.max(0, w - (pair.maxX - pair.minX));
      const slackY = Math.max(0, h - (pair.maxY - pair.minY));
      const cx = midX + (rng() - 0.5) * slackX * 0.8;
      const cy = midY + (rng() - 0.5) * slackY * 0.8;
      generatedRects.push({
        minX: n(cx - w / 2),
        minY: n(cy - h / 2),
        maxX: n(cx + w / 2),
        maxY: n(cy + h / 2),
      });
    } else {
      const target = strokeInfo[Math.floor(rng() * strokeInfo.length)];
      const cx = target.cx + (rng() - 0.5) * pageSide * 0.4;
      const cy = target.cy + (rng() - 0.5) * pageSide * 0.4;
      generatedRects.push({
        minX: n(cx - w / 2),
        minY: n(cy - h / 2),
        maxX: n(cx + w / 2),
        maxY: n(cy + h / 2),
      });
    }
  }

  const blockRects: RectBounds[] = [
    { minX: 160, minY: 960, maxX: 420, maxY: 1060 },
    { minX: 470, minY: 1040, maxX: 650, maxY: 1130 },
    { minX: 130, minY: 1090, maxX: 350, maxY: 1160 },
    { minX: 490, minY: 1240, maxX: 660, maxY: 1300 },
    { minX: 210, minY: 1590, maxX: 370, maxY: 1700 },
  ];
  const allRects: RectBounds[] = [...rects, ...generatedRects, ...blockRects];

  const rectSelections = allRects.map((rect) => {
    const sel = selectInRect(page, rect);
    return {
      rect: { minX: n(rect.minX), minY: n(rect.minY), maxX: n(rect.maxX), maxY: n(rect.maxY) },
      strokeIds: sel ? sel.strokeIds : [],
      latexIds: sel ? sel.latexIds : [],
      textIds: sel ? sel.textIds : [],
      imageIds: sel ? sel.imageIds : [],
      bounds: sel ? { x: n(sel.bounds.x), y: n(sel.bounds.y), width: n(sel.bounds.width), height: n(sel.bounds.height) } : null,
    };
  });

  // Fixed lassos for selectInLasso
  const lassos: Array<{ x: number; y: number }[]> = [
    [
      { x: 150, y: 950 },
      { x: 440, y: 950 },
      { x: 440, y: 1080 },
      { x: 150, y: 1080 },
    ],
    [
      { x: 120, y: 1070 },
      { x: 380, y: 1070 },
      { x: 250, y: 1220 },
    ],
    [
      { x: 190, y: 1560 },
      { x: 390, y: 1570 },
      { x: 380, y: 1720 },
      { x: 180, y: 1710 },
    ],
    [
      { x: 8500, y: 8500 },
      { x: 9200, y: 8500 },
      { x: 9200, y: 9200 },
    ],
  ];

  const starLassos: Array<{ x: number; y: number }[]> = [];
  for (let i = 0; i < 200; i++) {
    const numPts = Math.floor(8 + (40 - 8 + 1) * rng());
    const baseR = pageSide * (0.05 + 0.45 * rng());
    let cx: number, cy: number;
    if (i < 175 && closePairs.length > 0) {
      const fitting = closePairs.filter((p) => p.d <= baseR * 1.5);
      const pair = fitting.length > 0
        ? fitting[Math.floor(rng() * fitting.length)]
        : closePairs[Math.floor(rng() * closePairs.length)];
      const midX = (pair.minX + pair.maxX) / 2;
      const midY = (pair.minY + pair.maxY) / 2;
      cx = midX + (rng() - 0.5) * 20;
      cy = midY + (rng() - 0.5) * 20;
    } else {
      const target = strokeInfo[Math.floor(rng() * strokeInfo.length)];
      cx = target.cx + (rng() - 0.5) * baseR;
      cy = target.cy + (rng() - 0.5) * baseR;
    }
    const step = (2 * Math.PI) / numPts;
    const poly: Array<{ x: number; y: number }> = [];
    for (let j = 0; j < numPts; j++) {
      const ang = (j + 0.2 + 0.6 * rng()) * step;
      const r = baseR * (0.6 + 0.4 * rng());
      poly.push({ x: n(cx + r * Math.cos(ang)), y: n(cy + r * Math.sin(ang)) });
    }
    starLassos.push(poly);
  }

  const figure8Lassos: Array<{ x: number; y: number }[]> = [];
  for (let i = 0; i < 20; i++) {
    const nPts = 24;
    const rx = pageSide * (0.10 + 0.30 * rng());
    const ry = pageSide * (0.10 + 0.30 * rng());
    const rot = rng() * Math.PI;
    const cosR = Math.cos(rot);
    const sinR = Math.sin(rot);
    const target = strokeInfo[i % strokeInfo.length];
    const cx = target.cx + (rng() - 0.5) * 30;
    const cy = target.cy + (rng() - 0.5) * 30;
    const poly: Array<{ x: number; y: number }> = [];
    for (let j = 0; j < nPts; j++) {
      const t = (j / nPts) * 2 * Math.PI;
      const u = rx * Math.sin(t);
      const v = ry * Math.sin(t) * Math.cos(t);
      const x = cx + u * cosR - v * sinR;
      const y = cy + u * sinR + v * cosR;
      poly.push({ x: n(x), y: n(y) });
    }
    figure8Lassos.push(poly);
  }

  const edgeLassos: Array<{ x: number; y: number }[]> = [];
  for (let i = 0; i < 20; i++) {
    const target = strokeInfo[i % strokeInfo.length];
    const b = target.b;
    const midX = (b.minX + b.maxX) / 2;
    const pad = 20;
    const poly: Array<{ x: number; y: number }> = [
      { x: n(b.minX - pad), y: n(b.minY - pad) },
      { x: n(midX + (rng() - 0.5) * 6), y: n(b.minY - pad) },
      { x: n(midX + (rng() - 0.5) * 6), y: n((b.minY + b.maxY) / 2) },
      { x: n(midX + (rng() - 0.5) * 6), y: n(b.maxY + pad) },
      { x: n(b.minX - pad), y: n(b.maxY + pad) },
      { x: n(b.minX - pad), y: n((b.minY + b.maxY) / 2) },
    ];
    edgeLassos.push(poly);
  }

  const blockLassos: Array<{ x: number; y: number }[]> = [
    [
      { x: 170, y: 970 },
      { x: 410, y: 970 },
      { x: 410, y: 1050 },
      { x: 170, y: 1050 },
    ],
    [
      { x: 470, y: 1040 },
      { x: 650, y: 1040 },
      { x: 650, y: 1130 },
      { x: 470, y: 1130 },
    ],
    [
      { x: 130, y: 1090 },
      { x: 350, y: 1090 },
      { x: 350, y: 1160 },
      { x: 130, y: 1160 },
    ],
    [
      { x: 210, y: 1590 },
      { x: 370, y: 1590 },
      { x: 370, y: 1700 },
      { x: 210, y: 1700 },
    ],
  ];
  const allLassos = [...lassos, ...starLassos, ...figure8Lassos, ...edgeLassos, ...blockLassos];

  const lassoSelections = allLassos.map((lasso) => {
    const sel = selectInLasso(page, lasso);
    return {
      lasso: lasso.map(xy),
      strokeIds: sel ? sel.strokeIds : [],
      latexIds: sel ? sel.latexIds : [],
      textIds: sel ? sel.textIds : [],
      imageIds: sel ? sel.imageIds : [],
      bounds: sel ? { x: n(sel.bounds.x), y: n(sel.bounds.y), width: n(sel.bounds.width), height: n(sel.bounds.height) } : null,
    };
  });

  const rect2Plus = rectSelections.filter((s) => s.strokeIds.length >= 2).length;
  const rectPartial = rectSelections.filter((s, idx) => {
    const r = allRects[idx];
    return s.strokeIds.some((id) => {
      const st = pageStrokes.find((stk) => stk.id === id);
      return st ? cutsPartly(st, r) : false;
    });
  }).length;

  const lasso2Plus = lassoSelections.filter((s) => s.strokeIds.length >= 2).length;
  const lassoPartial = lassoSelections.filter((s, idx) => {
    const l = allLassos[idx];
    return s.strokeIds.some((id) => {
      const st = pageStrokes.find((stk) => stk.id === id);
      return st ? cutsPartly(st, undefined, l) : false;
    });
  }).length;

  console.log(`Rect selections: ${rect2Plus} with >=2 strokes (${rectSelections.length} total), ${rectPartial} cutting strokes partly`);
  console.log(`Lasso selections: ${lasso2Plus} with >=2 strokes (${lassoSelections.length} total), ${lassoPartial} cutting strokes partly`);

  const allNonEmptySelections: Selection[] = [];
  for (const r of allRects) {
    const sel = selectInRect(page, r);
    if (sel && (sel.strokeIds.length + sel.latexIds.length + sel.textIds.length + sel.imageIds.length > 0)) {
      allNonEmptySelections.push(sel);
    }
  }
  for (const l of allLassos) {
    const sel = selectInLasso(page, l);
    if (sel && (sel.strokeIds.length + sel.latexIds.length + sel.textIds.length + sel.imageIds.length > 0)) {
      allNonEmptySelections.push(sel);
    }
  }

  // Bounds tests: initial 3 edge-cases + each non-empty selection
  const rawBoundsTests: Array<{
    strokeIds: string[];
    latexIds: string[];
    textIds: string[];
    imageIds: string[];
  }> = [
    {
      strokeIds: [pageStrokes[0].id, pageStrokes[1].id],
      latexIds: ['latex_1'],
      textIds: ['text_1'],
      imageIds: ['image_1'],
    },
    {
      strokeIds: [pageStrokes[2].id],
      latexIds: ['latex_2'],
      textIds: [],
      imageIds: [],
    },
    {
      strokeIds: [],
      latexIds: [],
      textIds: [],
      imageIds: [],
    },
  ];
  for (const sel of allNonEmptySelections) {
    rawBoundsTests.push({
      strokeIds: sel.strokeIds,
      latexIds: sel.latexIds,
      textIds: sel.textIds,
      imageIds: sel.imageIds,
    });
  }

  const boundsTests = rawBoundsTests.map((s) => {
    const b = computeBounds(page, { pageId: page.id, ...s }, 10);
    return {
      ...s,
      bounds: b ? { x: n(b.x), y: n(b.y), width: n(b.width), height: n(b.height) } : null,
    };
  });

  // Pick 20 non-empty selections across the set
  const step = Math.max(1, Math.floor(allNonEmptySelections.length / 20));
  const chosenSels = allNonEmptySelections.filter((_, k) => k % step === 0).slice(0, 20);

  const transformConfigs = [
    { name: 'move_1', dx: 35.5, dy: -24.5, factor: 1.0, rot: 0, fy: 1.0 },
    { name: 'scale_corner_1', dx: 0.0, dy: 0.0, factor: 1.4, rot: 0, fy: 0.8 },
    { name: 'rotate_1', dx: 0.0, dy: 0.0, factor: 1.0, rot: 35.0, fy: 1.0 },
    { name: 'move_2', dx: -40.0, dy: 60.0, factor: 1.0, rot: 0, fy: 1.0 },
    { name: 'scale_corner_2', dx: 0.0, dy: 0.0, factor: 0.7, rot: 0, fy: 0.7 },
    { name: 'rotate_2', dx: 0.0, dy: 0.0, factor: 1.0, rot: -45.0, fy: 1.0 },
    { name: 'move_scale_1', dx: 15.0, dy: -10.0, factor: 1.2, rot: 0, fy: 1.5 },
    { name: 'move_rotate_1', dx: -20.0, dy: 30.0, factor: 1.0, rot: 90.0, fy: 1.0 },
    { name: 'all_1', dx: 10.0, dy: 15.0, factor: 1.15, rot: 25.0, fy: 0.9 },
    { name: 'move_3', dx: 50.0, dy: -30.0, factor: 1.0, rot: 0, fy: 1.0 },
    { name: 'scale_corner_3', dx: 0.0, dy: 0.0, factor: 1.8, rot: 0, fy: 1.2 },
    { name: 'rotate_3', dx: 0.0, dy: 0.0, factor: 1.0, rot: 180.0, fy: 1.0 },
    { name: 'move_scale_2', dx: -25.0, dy: -20.0, factor: 0.8, rot: 0, fy: 0.8 },
    { name: 'move_rotate_2', dx: 30.0, dy: 40.0, factor: 1.0, rot: -90.0, fy: 1.0 },
    { name: 'all_2', dx: -12.0, dy: 18.0, factor: 1.3, rot: -15.0, fy: 1.1 },
    { name: 'move_4', dx: -45.0, dy: -50.0, factor: 1.0, rot: 0, fy: 1.0 },
    { name: 'scale_corner_4', dx: 0.0, dy: 0.0, factor: 0.6, rot: 0, fy: 1.4 },
    { name: 'rotate_4', dx: 0.0, dy: 0.0, factor: 1.0, rot: 120.0, fy: 1.0 },
    { name: 'all_3', dx: 20.0, dy: -25.0, factor: 0.9, rot: 40.0, fy: 0.9 },
    { name: 'all_4', dx: -15.0, dy: 20.0, factor: 1.1, rot: -60.0, fy: 1.2 },
  ];

  const transformTests = chosenSels.map((sel, idx) => {
    const tf = transformConfigs[idx];
    const transformed = transformSelection(page, sel, tf.dx, tf.dy, tf.factor, tf.rot, tf.fy);
    return {
      name: `${tf.name}_${idx}`,
      dx: n(tf.dx),
      dy: n(tf.dy),
      factor: n(tf.factor),
      rot: n(tf.rot),
      fy: n(tf.fy),
      selection: {
        pageId: sel.pageId,
        strokeIds: sel.strokeIds,
        latexIds: sel.latexIds,
        textIds: sel.textIds,
        imageIds: sel.imageIds,
        bounds: { x: n(sel.bounds.x), y: n(sel.bounds.y), width: n(sel.bounds.width), height: n(sel.bounds.height) },
      },
      transformedPage: {
        id: transformed.id,
        pageNumber: transformed.pageNumber,
        strokes: transformed.strokes
          .filter((st) => sel.strokeIds.includes(st.id))
          .map((st) => ({
            id: st.id,
            width: n(st.width),
            shapeKind: st.shapeKind ?? null,
            rotation: st.rotation !== undefined ? n(st.rotation) : null,
            points: st.points.map((p) => {
              const [x, y, t, pressure] = pt4(p);
              return { x, y, t, pressure };
            }),
          })),
        latexBlocks: transformed.latexBlocks
          .filter((b) => sel.latexIds.includes(b.id))
          .map((b) => ({
            id: b.id,
            x: n(b.x),
            y: n(b.y),
            width: n(b.width),
            height: n(b.height),
            scale: b.scale !== undefined ? n(b.scale) : null,
            stretchX: b.stretchX !== undefined ? n(b.stretchX) : null,
            rotation: b.rotation !== undefined ? n(b.rotation) : null,
          })),
        textBlocks: (transformed.textBlocks ?? [])
          .filter((t) => sel.textIds.includes(t.id))
          .map((t) => ({
            id: t.id,
            x: n(t.x),
            y: n(t.y),
            width: n(t.width),
            height: t.height !== undefined ? n(t.height) : null,
            fontSize: n(t.fontSize),
            rotation: t.rotation !== undefined ? n(t.rotation) : null,
          })),
        imageBlocks: (transformed.imageBlocks ?? [])
          .filter((im) => sel.imageIds.includes(im.id))
          .map((im) => ({
            id: im.id,
            x: n(im.x),
            y: n(im.y),
            width: n(im.width),
            height: n(im.height),
            rotation: im.rotation !== undefined ? n(im.rotation) : null,
          })),
      },
    };
  });

  // Z-Order: shuffle items, test restamp and zLayers
  const shuffledStrokes = [...page.strokes].reverse();
  const shuffledLatex = [...page.latexBlocks].reverse();
  const shuffledText = [...(page.textBlocks ?? [])].reverse();
  const shuffledImages = [...(page.imageBlocks ?? [])].reverse();

  const shuffledPage: NotePage = {
    id: 'page_shuffled',
    pageNumber: 1,
    strokes: shuffledStrokes,
    latexBlocks: shuffledLatex,
    textBlocks: shuffledText,
    imageBlocks: shuffledImages,
  };

  const restamped = restamp(shuffledPage, 1700000000000);
  const layers = zLayers(restamped).map((l) => {
    if (l.kind === 'ink') {
      return { kind: l.kind, key: l.key, strokeIds: l.strokes.map((s) => s.id) };
    }
    return { kind: l.kind, key: l.key, blockId: l.block.id };
  });

  // Shape edit: handles for each shape kind and dragHandle for each handle role
  const shapeStrokes: Stroke[] = [
    {
      id: 'se_point',
      tool: 'pen',
      color: '#000',
      width: 2,
      opacity: 1,
      lineStyle: 'solid',
      isShape: true,
      shapeKind: 'point',
      points: [{ x: 100, y: 100, pressure: 0.5 }],
    },
    {
      id: 'se_line',
      tool: 'pen',
      color: '#000',
      width: 2,
      opacity: 1,
      lineStyle: 'solid',
      isShape: true,
      shapeKind: 'line',
      points: [
        { x: 50, y: 50, pressure: 0.5 },
        { x: 200, y: 120, pressure: 0.5 },
      ],
    },
    {
      id: 'se_polyline',
      tool: 'pen',
      color: '#000',
      width: 2,
      opacity: 1,
      lineStyle: 'solid',
      isShape: true,
      shapeKind: 'polyline',
      points: [
        { x: 20, y: 30, pressure: 0.5 },
        { x: 60, y: 80, pressure: 0.5 },
        { x: 120, y: 40, pressure: 0.5 },
      ],
    },
    {
      id: 'se_triangle',
      tool: 'pen',
      color: '#000',
      width: 2,
      opacity: 1,
      lineStyle: 'solid',
      isShape: true,
      closed: true,
      shapeKind: 'triangle',
      points: [
        { x: 100, y: 50, pressure: 0.5 },
        { x: 150, y: 150, pressure: 0.5 },
        { x: 50, y: 150, pressure: 0.5 },
      ],
    },
    {
      id: 'se_rectangle',
      tool: 'pen',
      color: '#000',
      width: 2,
      opacity: 1,
      lineStyle: 'solid',
      isShape: true,
      closed: true,
      shapeKind: 'rectangle',
      points: [
        { x: 50, y: 50, pressure: 0.5 },
        { x: 150, y: 50, pressure: 0.5 },
        { x: 150, y: 120, pressure: 0.5 },
        { x: 50, y: 120, pressure: 0.5 },
      ],
    },
    {
      id: 'se_polygon',
      tool: 'pen',
      color: '#000',
      width: 2,
      opacity: 1,
      lineStyle: 'solid',
      isShape: true,
      closed: true,
      shapeKind: 'polygon',
      points: [
        { x: 100, y: 40, pressure: 0.5 },
        { x: 150, y: 80, pressure: 0.5 },
        { x: 130, y: 140, pressure: 0.5 },
        { x: 70, y: 140, pressure: 0.5 },
        { x: 50, y: 80, pressure: 0.5 },
      ],
    },
    {
      id: 'se_circle',
      tool: 'pen',
      color: '#000',
      width: 2,
      opacity: 1,
      lineStyle: 'solid',
      isShape: true,
      closed: true,
      shapeKind: 'circle',
      points: ellipsePoints({ x: 100, y: 100 }, { x: 40, y: 0 }, 40, 16).map((p) => {
        const [x, y, t, pressure] = pt4(p);
        return { x, y, t, pressure };
      }),
    },
    {
      id: 'se_ellipse',
      tool: 'pen',
      color: '#000',
      width: 2,
      opacity: 1,
      lineStyle: 'solid',
      isShape: true,
      closed: true,
      shapeKind: 'ellipse',
      points: ellipsePoints({ x: 120, y: 120 }, { x: 60, y: 0 }, 30, 16).map((p) => {
        const [x, y, t, pressure] = pt4(p);
        return { x, y, t, pressure };
      }),
    },
    {
      id: 'se_curve_open',
      tool: 'pen',
      color: '#000',
      width: 2,
      opacity: 1,
      lineStyle: 'solid',
      isShape: true,
      closed: false,
      shapeKind: 'curve',
      points: [
        { x: 20, y: 50, pressure: 0.5 },
        { x: 60, y: 20, pressure: 0.5 },
        { x: 100, y: 80, pressure: 0.5 },
        { x: 140, y: 40, pressure: 0.5 },
      ],
    },
    {
      id: 'se_curve_closed',
      tool: 'pen',
      color: '#000',
      width: 2,
      opacity: 1,
      lineStyle: 'solid',
      isShape: true,
      closed: true,
      shapeKind: 'curve',
      points: [
        { x: 50, y: 50, pressure: 0.5 },
        { x: 100, y: 30, pressure: 0.5 },
        { x: 150, y: 60, pressure: 0.5 },
        { x: 120, y: 120, pressure: 0.5 },
        { x: 60, y: 110, pressure: 0.5 },
      ],
    },
    {
      id: 'se_arrow',
      tool: 'pen',
      color: '#000',
      width: 2,
      opacity: 1,
      lineStyle: 'solid',
      isShape: true,
      shapeKind: 'arrow',
      points: [
        { x: 40, y: 100, pressure: 0.5 },
        { x: 160, y: 100, pressure: 0.5 },
        { x: 140, y: 90, pressure: 0.5 },
        { x: 160, y: 100, pressure: 0.5 },
        { x: 140, y: 110, pressure: 0.5 },
      ],
    },
    {
      id: 'se_handwriting_open',
      tool: 'pen',
      color: '#000',
      width: 2,
      opacity: 1,
      lineStyle: 'solid',
      isShape: false,
      closed: false,
      points: [
        { x: 30, y: 30, pressure: 0.5 },
        { x: 50, y: 45, pressure: 0.5 },
        { x: 80, y: 65, pressure: 0.5 },
        { x: 120, y: 90, pressure: 0.5 },
      ],
    },
  ];

  const handleTests = shapeStrokes.map((s) => {
    const handles = shapeHandles(s) ?? [];
    return {
      strokeId: s.id,
      shapeKind: s.shapeKind ?? 'none',
      stroke: {
        ...s,
        points: s.points.map((p) => {
          const [x, y, , pressure] = pt4(p);
          return { x, y, ...(p.t !== undefined ? { t: n(p.t) } : {}), pressure };
        }),
      },
      handles: handles.map((h) => ({
        x: n(h.x),
        y: n(h.y),
        role: h.role,
        index: h.index,
        anchor: h.anchor ? { x: n(h.anchor.x), y: n(h.anchor.y) } : null,
      })),
    };
  });

  const moveTests: Array<{
    strokeId: string;
    shapeKind: string;
    handleRole: string;
    handle: { x: number; y: number; role: string; index: number; anchor: { x: number; y: number } | null };
    target: [number, number];
    resultStroke: {
      id: string;
      points: Array<{ x: number; y: number; pressure: number }>;
      rotation?: number | null;
    };
  }> = [];

  for (const item of handleTests) {
    for (const h of item.handles) {
      // Offset target by +24.0, -18.0 (an angle ~ -36.8 deg, avoiding standard 0, 45, 90 angles)
      const target = { x: h.x + 24.0, y: h.y - 18.0 };
      const moved = dragHandle(item.stroke as Stroke, h as ShapeHandle, target);
      moveTests.push({
        strokeId: item.strokeId,
        shapeKind: item.shapeKind,
        handleRole: h.role,
        handle: h,
        target: [n(target.x), n(target.y)],
        resultStroke: {
          id: moved.id,
          points: moved.points.map((p) => {
            const [x, y, t, pressure] = pt4(p);
            return { x, y, pressure };
          }),
          rotation: moved.rotation !== undefined ? n(moved.rotation) : null,
        },
      });
    }
  }

  return {
    page: {
      id: page.id,
      pageNumber: page.pageNumber,
      strokes: page.strokes.map((s) => ({
        id: s.id,
        createdAt: s.createdAt,
        tool: s.tool,
        color: s.color,
        width: n(s.width),
        opacity: s.opacity,
        penStyle: s.penStyle ?? null,
        lineStyle: s.lineStyle ?? null,
        isShape: !!s.isShape,
        closed: !!s.closed,
        shapeKind: s.shapeKind ?? null,
        rotation: s.rotation !== undefined ? n(s.rotation) : null,
        penEnd: !!s.penEnd,
        points: s.points.map((p) => {
          const [x, y, t, pressure] = pt4(p);
          return { x, y, t, pressure };
        }),
      })),
      latexBlocks: page.latexBlocks.map((b) => ({
        id: b.id,
        x: n(b.x),
        y: n(b.y),
        width: n(b.width),
        height: n(b.height),
        scale: b.scale !== undefined ? n(b.scale) : null,
        latexCode: b.latexCode,
        createdAt: b.createdAt,
        rotation: b.rotation !== undefined ? n(b.rotation) : null,
      })),
      textBlocks: (page.textBlocks ?? []).map((t) => ({
        id: t.id,
        x: n(t.x),
        y: n(t.y),
        width: n(t.width),
        height: t.height !== undefined ? n(t.height) : null,
        fontSize: n(t.fontSize),
        color: t.color || '#000000',
        text: t.text,
        createdAt: t.createdAt,
        rotation: t.rotation !== undefined ? n(t.rotation) : null,
      })),
      imageBlocks: (page.imageBlocks ?? []).map((im) => ({
        id: im.id,
        x: n(im.x),
        y: n(im.y),
        width: n(im.width),
        height: n(im.height),
        dataUrl: im.dataUrl,
        createdAt: im.createdAt,
        rotation: im.rotation !== undefined ? n(im.rotation) : null,
      })),
    },
    rectSelections,
    lassoSelections,
    boundsTests,
    transformTests,
    zorder: {
      shuffledPage: {
        id: shuffledPage.id,
        pageNumber: shuffledPage.pageNumber,
        strokes: shuffledPage.strokes.map((s) => ({
          id: s.id,
          createdAt: s.createdAt,
          tool: s.tool,
          color: s.color,
          width: n(s.width),
          opacity: s.opacity,
          points: s.points.map((p) => {
            const [x, y, t, pressure] = pt4(p);
            return { x, y, t, pressure };
          }),
        })),
        latexBlocks: shuffledPage.latexBlocks,
        textBlocks: shuffledPage.textBlocks,
        imageBlocks: shuffledPage.imageBlocks,
      },
      restampedPage: {
        id: restamped.id,
        pageNumber: restamped.pageNumber,
        strokes: restamped.strokes.map((s) => ({
          id: s.id,
          createdAt: s.createdAt!,
        })),
        latexBlocks: restamped.latexBlocks.map((b) => ({
          id: b.id,
          createdAt: b.createdAt,
        })),
        textBlocks: (restamped.textBlocks ?? []).map((t) => ({
          id: t.id,
          createdAt: t.createdAt,
        })),
        imageBlocks: (restamped.imageBlocks ?? []).map((im) => ({
          id: im.id,
          createdAt: im.createdAt,
        })),
      },
      layers,
    },
    shapeEdit: {
      handles: handleTests,
      moves: moveTests,
    },
  };
}
