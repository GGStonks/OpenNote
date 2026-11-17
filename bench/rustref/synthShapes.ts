export interface SynthStrokePoint {
  x: number;
  y: number;
  t: number;
  pressure: number;
}

export interface SynthStroke {
  id: string;
  kind: string;
  points: SynthStrokePoint[];
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function (): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createGaussian(prng: () => number) {
  let hasNext = false;
  let next = 0;
  return function (sigma = 0.8): number {
    if (hasNext) {
      hasNext = false;
      return next * sigma;
    }
    let u1 = 0;
    let u2 = 0;
    while (u1 <= 1e-15) {
      u1 = prng();
    }
    u2 = prng();
    const r = Math.sqrt(-2.0 * Math.log(u1));
    const theta = 2.0 * Math.PI * u2;
    const z0 = r * Math.cos(theta);
    const z1 = r * Math.sin(theta);
    next = z1;
    hasNext = true;
    return z0 * sigma;
  };
}

interface XY {
  x: number;
  y: number;
}

function samplePolyline(vertices: XY[], step = 2.8): XY[] {
  const pts: XY[] = [];
  if (vertices.length === 0) return pts;
  pts.push({ x: vertices[0].x, y: vertices[0].y });
  for (let i = 0; i < vertices.length - 1; i++) {
    const p1 = vertices[i];
    const p2 = vertices[i + 1];
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) continue;
    const count = Math.max(1, Math.round(d / step));
    for (let k = 1; k <= count; k++) {
      const frac = k / count;
      pts.push({ x: p1.x + dx * frac, y: p1.y + dy * frac });
    }
  }
  return pts;
}

function rotatePoint(p: XY, origin: XY, angle: number): XY {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = p.x - origin.x;
  const dy = p.y - origin.y;
  return {
    x: origin.x + dx * cos - dy * sin,
    y: origin.y + dx * sin + dy * cos,
  };
}

function applyJitterAndBuildPoints(
  rawPoints: XY[],
  isClosed: boolean,
  prng: () => number,
  gaussian: (sigma: number) => number,
): SynthStrokePoint[] {
  const n = rawPoints.length;
  if (n === 0) return [];

  const jittered: XY[] = [];
  for (let i = 0; i < n; i++) {
    let dx: number;
    let dy: number;
    if (i === 0) {
      dx = rawPoints[1].x - rawPoints[0].x;
      dy = rawPoints[1].y - rawPoints[0].y;
    } else if (i === n - 1) {
      dx = rawPoints[n - 1].x - rawPoints[n - 2].x;
      dy = rawPoints[n - 1].y - rawPoints[n - 2].y;
    } else {
      dx = rawPoints[i + 1].x - rawPoints[i - 1].x;
      dy = rawPoints[i + 1].y - rawPoints[i - 1].y;
    }
    const len = Math.hypot(dx, dy);
    const nx = len > 1e-6 ? -dy / len : 0;
    const ny = len > 1e-6 ? dx / len : 1;
    const j = gaussian(0.8);
    jittered.push({
      x: rawPoints[i].x + nx * j,
      y: rawPoints[i].y + ny * j,
    });
  }

  if (isClosed && jittered.length > 1) {
    const first = jittered[0];
    const last = jittered[jittered.length - 1];
    const d = Math.hypot(last.x - first.x, last.y - first.y);
    if (d > 1.8) {
      last.x = first.x + (last.x - first.x) * (1.8 / d);
      last.y = first.y + (last.y - first.y) * (1.8 / d);
    }
  }

  return jittered.map((pt, i) => {
    const pressure = 0.5 + (prng() * 2 - 1) * 0.1;
    const clampedX = Math.max(0, Math.min(800, pt.x));
    const clampedY = Math.max(0, Math.min(1100, pt.y));
    return {
      x: Number(clampedX.toFixed(4)),
      y: Number(clampedY.toFixed(4)),
      t: Number((i * 4.17).toFixed(2)),
      pressure: Number(pressure.toFixed(4)),
    };
  });
}

function sampleCurve(fn: (u: number) => XY, uMin: number, uMax: number, approxTotalLen: number, step = 2.8): XY[] {
  const count = Math.max(8, Math.round(approxTotalLen / step));
  const pts: XY[] = [];
  for (let i = 0; i <= count; i++) {
    const u = uMin + (uMax - uMin) * (i / count);
    pts.push(fn(u));
  }
  return pts;
}

export function synthShapes(seed: number): SynthStroke[] {
  const prng = mulberry32(seed);
  const gaussian = createGaussian(prng);
  const strokes: SynthStroke[] = [];

  // 1. Line (3 instances)
  const lineConfigs = [
    { p1: { x: 100, y: 120 }, p2: { x: 260, y: 120 } },
    { p1: { x: 120, y: 220 }, p2: { x: 320, y: 340 } },
    { p1: { x: 500, y: 150 }, p2: { x: 420, y: 340 } },
  ];
  for (let i = 0; i < lineConfigs.length; i++) {
    const raw = samplePolyline([lineConfigs[i].p1, lineConfigs[i].p2]);
    strokes.push({
      id: `line-${i}`,
      kind: 'line',
      points: applyJitterAndBuildPoints(raw, false, prng, gaussian),
    });
  }

  // 2. Arrow (3 instances: line + 2 head strokes as separate entries arrow-head)
  const arrowConfigs = [
    { start: { x: 100, y: 450 }, tip: { x: 280, y: 450 }, headLen: 26 },
    { start: { x: 350, y: 420 }, tip: { x: 500, y: 520 }, headLen: 28 },
    { start: { x: 680, y: 400 }, tip: { x: 580, y: 560 }, headLen: 24 },
  ];
  for (let i = 0; i < arrowConfigs.length; i++) {
    const { start, tip, headLen } = arrowConfigs[i];
    const angle = Math.atan2(tip.y - start.y, tip.x - start.x);
    const barbAngle1 = angle + Math.PI - 0.5;
    const barbAngle2 = angle + Math.PI + 0.5;
    const barb1 = { x: tip.x + Math.cos(barbAngle1) * headLen, y: tip.y + Math.sin(barbAngle1) * headLen };
    const barb2 = { x: tip.x + Math.cos(barbAngle2) * headLen, y: tip.y + Math.sin(barbAngle2) * headLen };

    const shaftRaw = samplePolyline([start, tip]);
    const head1Raw = samplePolyline([tip, barb1]);
    const head2Raw = samplePolyline([tip, barb2]);

    strokes.push({
      id: `arrow-${i}`,
      kind: 'arrow',
      points: applyJitterAndBuildPoints(shaftRaw, false, prng, gaussian),
    });
    strokes.push({
      id: `arrow-head-${i}-1`,
      kind: 'arrow-head',
      points: applyJitterAndBuildPoints(head1Raw, false, prng, gaussian),
    });
    strokes.push({
      id: `arrow-head-${i}-2`,
      kind: 'arrow-head',
      points: applyJitterAndBuildPoints(head2Raw, false, prng, gaussian),
    });
  }

  // 3. Open Polyline (3 segments, 3 instances)
  const polylineConfigs = [
    [
      { x: 100, y: 680 },
      { x: 180, y: 730 },
      { x: 140, y: 830 },
      { x: 240, y: 870 },
    ],
    [
      { x: 380, y: 650 },
      { x: 480, y: 680 },
      { x: 440, y: 780 },
      { x: 540, y: 750 },
    ],
    [
      { x: 620, y: 660 },
      { x: 690, y: 770 },
      { x: 600, y: 840 },
      { x: 680, y: 920 },
    ],
  ];
  for (let i = 0; i < polylineConfigs.length; i++) {
    const raw = samplePolyline(polylineConfigs[i]);
    strokes.push({
      id: `open-polyline-${i}`,
      kind: 'open polyline',
      points: applyJitterAndBuildPoints(raw, false, prng, gaussian),
    });
  }

  // 4. Triangle (closed, 3 instances)
  const triangleConfigs = [
    { center: { x: 200, y: 220 }, r: 60, rot: 0 },
    { center: { x: 440, y: 220 }, r: 75, rot: Math.PI / 6 },
    { center: { x: 640, y: 220 }, r: 50, rot: Math.PI / 3 },
  ];
  for (let i = 0; i < triangleConfigs.length; i++) {
    const { center, r, rot } = triangleConfigs[i];
    const vertices: XY[] = [];
    for (let k = 0; k < 3; k++) {
      const a = rot + (k * 2 * Math.PI) / 3 - Math.PI / 2;
      vertices.push({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) });
    }
    vertices.push(vertices[0]);
    const raw = samplePolyline(vertices);
    strokes.push({
      id: `triangle-${i}`,
      kind: 'triangle',
      points: applyJitterAndBuildPoints(raw, true, prng, gaussian),
    });
  }

  // 5. Square (closed, 3 instances)
  const squareConfigs = [
    { center: { x: 280, y: 350 }, side: 90, rot: 0 },
    { center: { x: 500, y: 340 }, side: 120, rot: Math.PI / 8 },
    { center: { x: 680, y: 340 }, side: 75, rot: Math.PI / 4 },
  ];
  for (let i = 0; i < squareConfigs.length; i++) {
    const { center, side, rot } = squareConfigs[i];
    const half = side / 2;
    const baseCorners: XY[] = [
      { x: center.x - half, y: center.y - half },
      { x: center.x + half, y: center.y - half },
      { x: center.x + half, y: center.y + half },
      { x: center.x - half, y: center.y + half },
    ];
    const vertices = baseCorners.map((p) => rotatePoint(p, center, rot));
    vertices.push(vertices[0]);
    const raw = samplePolyline(vertices);
    strokes.push({
      id: `square-${i}`,
      kind: 'square',
      points: applyJitterAndBuildPoints(raw, true, prng, gaussian),
    });
  }

  // 6. Regular Pentagon (closed, 3 instances)
  const pentagonConfigs = [
    { center: { x: 160, y: 550 }, r: 60, rot: -Math.PI / 2 },
    { center: { x: 370, y: 560 }, r: 80, rot: Math.PI / 5 },
    { center: { x: 600, y: 550 }, r: 50, rot: 0 },
  ];
  for (let i = 0; i < pentagonConfigs.length; i++) {
    const { center, r, rot } = pentagonConfigs[i];
    const vertices: XY[] = [];
    for (let k = 0; k < 5; k++) {
      const a = rot + (k * 2 * Math.PI) / 5;
      vertices.push({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) });
    }
    vertices.push(vertices[0]);
    const raw = samplePolyline(vertices);
    strokes.push({
      id: `regular-pentagon-${i}`,
      kind: 'regular pentagon',
      points: applyJitterAndBuildPoints(raw, true, prng, gaussian),
    });
  }

  // 7. Circle (closed, 3 instances)
  const circleConfigs = [
    { center: { x: 180, y: 780 }, r: 50 },
    { center: { x: 420, y: 780 }, r: 80 },
    { center: { x: 660, y: 780 }, r: 60 },
  ];
  for (let i = 0; i < circleConfigs.length; i++) {
    const { center, r } = circleConfigs[i];
    const count = Math.max(12, Math.round((2 * Math.PI * r) / 2.8));
    const raw: XY[] = [];
    for (let k = 0; k <= count; k++) {
      const a = (k * 2 * Math.PI) / count;
      raw.push({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) });
    }
    strokes.push({
      id: `circle-${i}`,
      kind: 'circle',
      points: applyJitterAndBuildPoints(raw, true, prng, gaussian),
    });
  }

  // 8. Ellipse (closed, 3 instances)
  const ellipseConfigs = [
    { center: { x: 180, y: 950 }, a: 80, b: 40, rot: 0 },
    { center: { x: 430, y: 960 }, a: 100, b: 55, rot: Math.PI / 4 },
    { center: { x: 670, y: 950 }, a: 70, b: 35, rot: -Math.PI / 6 },
  ];
  for (let i = 0; i < ellipseConfigs.length; i++) {
    const { center, a, b, rot } = ellipseConfigs[i];
    const approxPerim = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
    const count = Math.max(12, Math.round(approxPerim / 2.8));
    const raw: XY[] = [];
    for (let k = 0; k <= count; k++) {
      const theta = (k * 2 * Math.PI) / count;
      const base = { x: center.x + a * Math.cos(theta), y: center.y + b * Math.sin(theta) };
      raw.push(rotatePoint(base, center, rot));
    }
    strokes.push({
      id: `ellipse-${i}`,
      kind: 'ellipse',
      points: applyJitterAndBuildPoints(raw, true, prng, gaussian),
    });
  }

  // 9. Parabola-up (3 instances, vertex at bottom, arms open upwards)
  const parabolaUpConfigs = [
    { vertex: { x: 140, y: 300 }, span: 50, depth: 45, rot: 0 },
    { vertex: { x: 330, y: 310 }, span: 65, depth: 60, rot: 0.1 },
    { vertex: { x: 520, y: 290 }, span: 40, depth: 35, rot: -0.1 },
  ];
  for (let i = 0; i < parabolaUpConfigs.length; i++) {
    const { vertex, span, depth, rot } = parabolaUpConfigs[i];
    const c = depth / (span * span);
    const approxLen = 2 * Math.hypot(span, depth);
    const raw = sampleCurve(
      (u) => {
        const p = { x: vertex.x + u, y: vertex.y - (depth - c * u * u) };
        return rotatePoint(p, vertex, rot);
      },
      -span,
      span,
      approxLen,
    );
    strokes.push({
      id: `parabola-up-${i}`,
      kind: 'parabola-up',
      points: applyJitterAndBuildPoints(raw, false, prng, gaussian),
    });
  }

  // 10. Parabola-down (3 instances, vertex at top, arms open downwards)
  const parabolaDownConfigs = [
    { vertex: { x: 140, y: 360 }, span: 50, depth: 45, rot: 0 },
    { vertex: { x: 330, y: 370 }, span: 65, depth: 60, rot: 0.1 },
    { vertex: { x: 520, y: 350 }, span: 40, depth: 35, rot: -0.1 },
  ];
  for (let i = 0; i < parabolaDownConfigs.length; i++) {
    const { vertex, span, depth, rot } = parabolaDownConfigs[i];
    const c = depth / (span * span);
    const approxLen = 2 * Math.hypot(span, depth);
    const raw = sampleCurve(
      (u) => {
        const p = { x: vertex.x + u, y: vertex.y + (depth - c * u * u) };
        return rotatePoint(p, vertex, rot);
      },
      -span,
      span,
      approxLen,
    );
    strokes.push({
      id: `parabola-down-${i}`,
      kind: 'parabola-down',
      points: applyJitterAndBuildPoints(raw, false, prng, gaussian),
    });
  }

  // 11. Parabola-left (3 instances, vertex at right, arms open leftwards)
  const parabolaLeftConfigs = [
    { vertex: { x: 260, y: 470 }, span: 50, depth: 45, rot: 0 },
    { vertex: { x: 460, y: 480 }, span: 65, depth: 60, rot: 0.1 },
    { vertex: { x: 660, y: 460 }, span: 40, depth: 35, rot: -0.1 },
  ];
  for (let i = 0; i < parabolaLeftConfigs.length; i++) {
    const { vertex, span, depth, rot } = parabolaLeftConfigs[i];
    const c = depth / (span * span);
    const approxLen = 2 * Math.hypot(span, depth);
    const raw = sampleCurve(
      (u) => {
        const p = { x: vertex.x - (depth - c * u * u), y: vertex.y + u };
        return rotatePoint(p, vertex, rot);
      },
      -span,
      span,
      approxLen,
    );
    strokes.push({
      id: `parabola-left-${i}`,
      kind: 'parabola-left',
      points: applyJitterAndBuildPoints(raw, false, prng, gaussian),
    });
  }

  // 12. Parabola-right (3 instances, vertex at left, arms open rightwards)
  const parabolaRightConfigs = [
    { vertex: { x: 200, y: 620 }, span: 50, depth: 45, rot: 0 },
    { vertex: { x: 420, y: 630 }, span: 65, depth: 60, rot: -0.1 },
    { vertex: { x: 620, y: 610 }, span: 40, depth: 35, rot: 0.12 },
  ];
  for (let i = 0; i < parabolaRightConfigs.length; i++) {
    const { vertex, span, depth, rot } = parabolaRightConfigs[i];
    const c = depth / (span * span);
    const approxLen = 2 * Math.hypot(span, depth);
    const raw = sampleCurve(
      (u) => {
        const p = { x: vertex.x + (depth - c * u * u), y: vertex.y + u };
        return rotatePoint(p, vertex, rot);
      },
      -span,
      span,
      approxLen,
    );
    strokes.push({
      id: `parabola-right-${i}`,
      kind: 'parabola-right',
      points: applyJitterAndBuildPoints(raw, false, prng, gaussian),
    });
  }

  // 13. Wide V (opening 140 deg, 3 instances)
  const wideVConfigs = [
    { vertex: { x: 180, y: 730 }, armLen: 70, bisectorAngle: -Math.PI / 2 },
    { vertex: { x: 410, y: 720 }, armLen: 90, bisectorAngle: -Math.PI / 3 },
    { vertex: { x: 640, y: 730 }, armLen: 80, bisectorAngle: -2 * Math.PI / 3 },
  ];
  const halfAngle = (70 * Math.PI) / 180; // 70 deg each side = 140 deg opening
  for (let i = 0; i < wideVConfigs.length; i++) {
    const { vertex, armLen, bisectorAngle } = wideVConfigs[i];
    const arm1Angle = bisectorAngle - halfAngle;
    const arm2Angle = bisectorAngle + halfAngle;
    const tip1 = {
      x: vertex.x + armLen * Math.cos(arm1Angle),
      y: vertex.y + armLen * Math.sin(arm1Angle),
    };
    const tip2 = {
      x: vertex.x + armLen * Math.cos(arm2Angle),
      y: vertex.y + armLen * Math.sin(arm2Angle),
    };
    const raw = samplePolyline([tip1, vertex, tip2]);
    strokes.push({
      id: `wide-V-${i}`,
      kind: 'wide V',
      points: applyJitterAndBuildPoints(raw, false, prng, gaussian),
    });
  }

  return strokes;
}
