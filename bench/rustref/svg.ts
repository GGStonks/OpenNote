import { SampleDensifier } from '../../src/ink/densify';
import { strokeToSvg } from '../../src/ink/strokeRenderer';
import type { LineStyle, NotePage, Point, Stroke } from '../../src/types';
import { listRecordingFiles, loadRecording } from './common';

function pointsFromSamples(samples: number[][]): Point[] {
  const dens = new SampleDensifier();
  const pts: Point[] = [];
  samples.forEach(([x, y, t, force]) => {
    for (const q of dens.push({ x, y, t, pressure: force > 0 ? force : 0 })) {
      pts.push(q);
    }
  });
  return pts;
}

export interface SvgRunOpts {
  per?: number;
  files?: string[];
  [key: string]: unknown;
}

export function run(opts?: SvgRunOpts): unknown {
  const per = opts?.per ?? 6;
  const files = listRecordingFiles(opts?.files);
  const rec = loadRecording(files[0]);
  const pens = rec.strokes.filter((s) => s.tool === 'pen' && s.samples.length > 5);

  const strokes: Stroke[] = [];

  // 1. Solid line (fountain pen)
  strokes.push({
    id: 's-solid',
    tool: 'pen',
    color: '#000000',
    width: 2.0,
    opacity: 1.0,
    penStyle: 'fountain',
    lineStyle: 'solid' as LineStyle,
    points: pointsFromSamples(pens[0].samples),
  });

  // 2. Dashed line
  strokes.push({
    id: 's-dashed',
    tool: 'pen',
    color: '#2563eb',
    width: 2.0,
    opacity: 1.0,
    penStyle: 'fountain',
    lineStyle: 'dashed' as LineStyle,
    points: pointsFromSamples(pens[1 % pens.length].samples),
  });

  // 3. Dotted line
  strokes.push({
    id: 's-dotted',
    tool: 'pen',
    color: '#16a34a',
    width: 2.0,
    opacity: 1.0,
    penStyle: 'fountain',
    lineStyle: 'dotted' as LineStyle,
    points: pointsFromSamples(pens[2 % pens.length].samples),
  });

  // 4. Dashdot line
  strokes.push({
    id: 's-dashdot',
    tool: 'pen',
    color: '#dc2626',
    width: 2.0,
    opacity: 1.0,
    penStyle: 'fountain',
    lineStyle: 'dashdot' as LineStyle,
    points: pointsFromSamples(pens[3 % pens.length].samples),
  });

  // 5. Longdash line
  strokes.push({
    id: 's-longdash',
    tool: 'pen',
    color: '#9333ea',
    width: 2.0,
    opacity: 1.0,
    penStyle: 'fountain',
    lineStyle: 'longdash' as LineStyle,
    points: pointsFromSamples(pens[4 % pens.length].samples),
  });

  // 6. Highlighter (drawStrokes/layerSvg puts highlighters under other ink)
  strokes.push({
    id: 's-highlighter',
    tool: 'highlighter',
    color: '#eab308',
    width: 4.0,
    opacity: 1.0,
    highlightAlpha: 0.35,
    lineStyle: 'solid' as LineStyle,
    points: pointsFromSamples(pens[5 % pens.length].samples),
  });

  // 7. Closed shape with fill
  const pts6 = pointsFromSamples(pens[6 % pens.length].samples).slice(0, 5);
  strokes.push({
    id: 's-fill',
    tool: 'pen',
    color: '#0284c7',
    width: 2.0,
    opacity: 1.0,
    isShape: true,
    closed: true,
    fill: 'solid',
    fillColor: '#38bdf8',
    fillOpacity: 0.3,
    lineStyle: 'solid' as LineStyle,
    points: pts6.length >= 3 ? pts6 : [
      { x: 100, y: 100, pressure: 0.5 },
      { x: 200, y: 100, pressure: 0.5 },
      { x: 150, y: 200, pressure: 0.5 },
    ],
  });

  // 8. Arrow
  const pts7 = pointsFromSamples(pens[7 % pens.length].samples).slice(0, 10);
  strokes.push({
    id: 's-arrow',
    tool: 'pen',
    color: '#e11d48',
    width: 2.5,
    opacity: 1.0,
    arrow: true,
    isShape: true,
    lineStyle: 'solid' as LineStyle,
    points: pts7.length >= 2 ? pts7 : [
      { x: 50, y: 50, pressure: 0.5 },
      { x: 150, y: 80, pressure: 0.5 },
    ],
  });

  // Recorded pen strokes (ink module loader, selection and --per handling)
  let highlighterCount = 0;
  for (const file of files) {
    const recFile = loadRecording(file);
    const penStrokes = recFile.strokes
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.tool === 'pen' && s.samples.length > 2);
    const step = Math.max(1, Math.floor(penStrokes.length / per));
    for (const { s, i } of penStrokes.filter((_, k) => k % step === 0).slice(0, per)) {
      const real = s.samples.some((q) => q[3] > 0 && q[3] !== 0.5);
      const dens = new SampleDensifier();
      const points: Point[] = [];
      s.samples.forEach(([x, y, t, force]) => {
        for (const q of dens.push({ x, y, t, pressure: force > 0 ? force : 0 })) {
          points.push(q);
        }
      });
      if (points.length < 3) continue;

      const lead = real ? [...s.samples].reverse().find((q) => q[3] > 0.02) : undefined;
      const strokePoints = lead
        ? [...points, { x: lead[0], y: lead[1], t: lead[2], pressure: lead[3] }]
        : points;
      const penEnd = !!lead;

      const baseId = `${file.split('/').pop()}#${i}`;
      const base: Stroke = {
        id: baseId,
        tool: 'pen',
        color: '#000000',
        width: s.width,
        opacity: 1.0,
        penStyle: 'fountain',
        points: strokePoints,
        penEnd: penEnd ? true : undefined,
      };
      (base as any).samples = s.samples;

      const lineStyles: { style: LineStyle; color: string }[] = [
        { style: 'solid', color: '#000000' },
        { style: 'dashed', color: '#2563eb' },
        { style: 'dotted', color: '#16a34a' },
        { style: 'dashdot', color: '#dc2626' },
        { style: 'longdash', color: '#9333ea' },
      ];

      for (const { style, color } of lineStyles) {
        strokes.push({
          ...base,
          id: `${baseId}-${style}`,
          lineStyle: style,
          color,
        });
      }

      if (highlighterCount < 3) {
        highlighterCount++;
        strokes.push({
          ...base,
          id: `${baseId}-highlighter`,
          tool: 'highlighter',
          color: '#eab308',
          lineStyle: 'solid',
          highlightAlpha: 0.35,
        });
      }
    }
  }

  const page: NotePage = {
    id: 'page-svg-ref',
    pageNumber: 1,
    strokes,
    latexBlocks: [],
    textBlocks: [],
    imageBlocks: [],
  };

  const viewBox: [number, number, number, number] = [0, 0, 1000, 1000];
  const paper = '#ffffff';
  const inkColor = '#000000';

  // In layerSvg (src/services/svgExport.ts):
  // Highlighters under the ink, as drawStrokes draws a layer.
  const order = [...strokes.filter((s) => s.tool === 'highlighter'), ...strokes.filter((s) => s.tool !== 'highlighter')];
  const layerSvg = order.map((s) => strokeToSvg(s, 0, paper)).join('\n');

  // svgHead (src/services/svgExport.ts):
  // When no latex/text blocks, no CSS needed.
  const SVG_NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"';
  const svgHead = `<svg ${SVG_NS} viewBox="${viewBox[0]} ${viewBox[1]} ${viewBox[2]} ${viewBox[3]}" width="${viewBox[2]}" height="${viewBox[3]}">\n`;

  return {
    format: 'opennote-svg-ref',
    version: 1,
    viewBox,
    paper,
    ink: inkColor,
    page,
    svgHead,
    layerSvg,
    fullSvg: `${svgHead}${layerSvg}\n</svg>\n`,
  };
}
