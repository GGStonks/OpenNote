import { Stroke, Point } from '../types';

export interface DetectedShape {
  type: 'line' | 'arrow' | 'rectangle' | 'ellipse' | 'triangle' | 'scribble';
  points: Point[];
  confidence: number;
  tikzSnippet: string;
}

/**
 * Geometric shape detection inspired by PDEDraw (GGStonks) and Notability Auto-Shape.
 */
export function detectShapeFromStroke(stroke: Stroke, canvasHeight: number = 1056): DetectedShape {
  const pts = stroke.points;
  if (pts.length < 3) {
    return {
      type: 'scribble',
      points: pts,
      confidence: 1.0,
      tikzSnippet: generateScribbleTikz(pts, stroke.color, canvasHeight),
    };
  }

  const start = pts[0];
  const end = pts[pts.length - 1];
  const directDist = Math.hypot(end.x - start.x, end.y - start.y);

  // Total path length
  let pathLen = 0;
  for (let i = 1; i < pts.length; i++) {
    pathLen += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }

  // 1. Straight Line Check
  // If direct distance is close to total path length, it's a straight line
  const straightness = pathLen > 0 ? directDist / pathLen : 0;
  if (straightness > 0.92 && pts.length >= 2) {
    const scale = 50.0;
    const sX = (start.x / scale).toFixed(2);
    const sY = ((canvasHeight - start.y) / scale).toFixed(2);
    const eX = (end.x / scale).toFixed(2);
    const eY = ((canvasHeight - end.y) / scale).toFixed(2);
    return {
      type: 'line',
      points: [start, end],
      confidence: straightness,
      tikzSnippet: `\\draw[${getColorName(stroke.color)}, thick] (${sX}, ${sY}) -- (${eX}, ${eY});`,
    };
  }

  // Bounding box
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const isClosed = Math.hypot(end.x - start.x, end.y - start.y) < 0.25 * Math.max(width, height);

  // 2. Circle / Ellipse Check
  if (isClosed && pts.length > 8) {
    const rx = width / 2;
    const ry = height / 2;
    let radialDeviation = 0;

    for (const p of pts) {
      const normX = (p.x - cx) / rx;
      const normY = (p.y - cy) / ry;
      const distFromBoundary = Math.abs(Math.hypot(normX, normY) - 1.0);
      radialDeviation += distFromBoundary;
    }
    const avgDeviation = radialDeviation / pts.length;

    if (avgDeviation < 0.22) {
      const scale = 50.0;
      const tikzCx = (cx / scale).toFixed(2);
      const tikzCy = ((canvasHeight - cy) / scale).toFixed(2);
      const tikzRx = (rx / scale).toFixed(2);
      const tikzRy = (ry / scale).toFixed(2);

      // Generate smooth circle/ellipse points for canvas
      const smoothPts: Point[] = [];
      const steps = 36;
      for (let i = 0; i <= steps; i++) {
        const theta = (i / steps) * Math.PI * 2;
        smoothPts.push({
          x: cx + rx * Math.cos(theta),
          y: cy + ry * Math.sin(theta),
          pressure: 0.5,
        });
      }

      return {
        type: 'ellipse',
        points: smoothPts,
        confidence: 1.0 - avgDeviation,
        tikzSnippet: `\\draw[${getColorName(stroke.color)}, thick] (${tikzCx}, ${tikzCy}) ellipse (${tikzRx} and ${tikzRy});`,
      };
    }
  }

  // 3. Rectangle / Triangle Check
  if (isClosed && pts.length > 6) {
    // Detect prominent corners (sharp turn angle)
    const corners: Point[] = [];
    const step = Math.max(2, Math.floor(pts.length / 20));
    for (let i = step; i < pts.length - step; i += step) {
      const pPrev = pts[i - step];
      const pCurr = pts[i];
      const pNext = pts[i + step];
      const v1 = { x: pCurr.x - pPrev.x, y: pCurr.y - pPrev.y };
      const v2 = { x: pNext.x - pCurr.x, y: pNext.y - pCurr.y };
      const dot = v1.x * v2.x + v1.y * v2.y;
      const mag = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y);
      if (mag > 0) {
        const angle = Math.acos(Math.max(-1, Math.min(1, dot / mag)));
        if (angle > 0.8) {
          // Sharp turn
          corners.push(pCurr);
        }
      }
    }

    // Triangle
    if (corners.length >= 2 && corners.length <= 4) {
      const apex = { x: cx, y: minY };
      const rightBase = { x: maxX, y: maxY };
      const leftBase = { x: minX, y: maxY };
      const scale = 50.0;
      return {
        type: 'triangle',
        points: [apex, rightBase, leftBase, apex],
        confidence: 0.85,
        tikzSnippet: `\\draw[${getColorName(stroke.color)}, thick] (${(apex.x / scale).toFixed(2)}, ${((canvasHeight - apex.y) / scale).toFixed(2)}) -- (${(rightBase.x / scale).toFixed(2)}, ${((canvasHeight - rightBase.y) / scale).toFixed(2)}) -- (${(leftBase.x / scale).toFixed(2)}, ${((canvasHeight - leftBase.y) / scale).toFixed(2)}) -- cycle;`,
      };
    }

    // Rectangle
    const scale = 50.0;
    const tl = { x: minX, y: minY };
    const br = { x: maxX, y: maxY };
    const rectPts: Point[] = [
      tl,
      { x: maxX, y: minY },
      br,
      { x: minX, y: maxY },
      tl,
    ];
    return {
      type: 'rectangle',
      points: rectPts,
      confidence: 0.8,
      tikzSnippet: `\\draw[${getColorName(stroke.color)}, thick] (${(tl.x / scale).toFixed(2)}, ${((canvasHeight - tl.y) / scale).toFixed(2)}) rectangle (${(br.x / scale).toFixed(2)}, ${((canvasHeight - br.y) / scale).toFixed(2)});`,
    };
  }

  // Fallback to smooth curve / scribble
  return {
    type: 'scribble',
    points: pts,
    confidence: 1.0,
    tikzSnippet: generateScribbleTikz(pts, stroke.color, canvasHeight),
  };
}

function generateScribbleTikz(pts: Point[], color: string, canvasHeight: number): string {
  const scale = 50.0;
  // Subsample points for concise TikZ output (max 20 points)
  const stride = Math.max(1, Math.floor(pts.length / 15));
  const sampled: Point[] = [];
  for (let i = 0; i < pts.length; i += stride) {
    sampled.push(pts[i]);
  }
  if (sampled[sampled.length - 1] !== pts[pts.length - 1]) {
    sampled.push(pts[pts.length - 1]);
  }

  const coords = sampled
    .map(p => `(${(p.x / scale).toFixed(2)}, ${((canvasHeight - p.y) / scale).toFixed(2)})`)
    .join(' ');
  return `\\draw[${getColorName(color)}, thick] plot [smooth] coordinates {${coords}};`;
}

function getColorName(hex: string): string {
  const lower = hex.toLowerCase();
  if (lower === '#000000' || lower === '#18181b') return 'black';
  if (lower.includes('blue') || lower === '#3b82f6') return 'blue';
  if (lower.includes('red') || lower === '#ef4444') return 'red';
  if (lower.includes('green') || lower === '#10b981') return 'green';
  if (lower.includes('purple') || lower === '#a855f7') return 'purple';
  if (lower.includes('orange') || lower === '#f97316') return 'orange';
  return 'blue';
}

/**
 * Converts a set of selected strokes into a complete, compilable TikZ snippet
 * matching PDEDraw's TikZExporter architecture.
 */
export function convertStrokesToTikzDocument(strokes: Stroke[], canvasHeight: number = 1056): string {
  let body = '% Generated by OpenNote TikZ Engine (PDEDraw Architecture)\n\\begin{tikzpicture}[scale=1.0, even odd rule]\n';
  for (const s of strokes) {
    const detected = detectShapeFromStroke(s, canvasHeight);
    body += `    ${detected.tikzSnippet}\n`;
  }
  body += '\\end{tikzpicture}';
  return body;
}

/**
 * Check if a point is inside a polygon using ray-casting algorithm.
 */
export function isPointInPolygon(pt: Point, poly: Point[]): boolean {
  if (poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect = ((yi > pt.y) !== (yj > pt.y)) &&
      (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
