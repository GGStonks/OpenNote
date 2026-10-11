/**
 * TikZ to SVG Vector Compiler
 * Converts PGF/TikZ diagram snippets (from PDEDraw or VLM models) into pure transparent vector SVGs.
 */

export interface ParsedTikzShape {
  type: 'line' | 'arrow' | 'rect' | 'circle' | 'ellipse' | 'polygon' | 'curve' | 'node';
  coords: { x: number; y: number }[];
  style: {
    color: string;
    strokeWidth: number;
    dashed?: boolean;
    dotted?: boolean;
    fillColor?: string;
    arrow?: boolean;
    rx?: number;
    ry?: number;
    r?: number;
  };
  text?: string;
  nodeScale?: number;
}

// Convert common TikZ color names to CSS colors
const COLOR_MAP: Record<string, string> = {
  black: '#000000',
  gray: '#6B7280',
  white: '#FFFFFF',
  red: '#EF4444',
  green: '#10B981',
  blue: '#3B82F6',
  cyan: '#06B6D4',
  magenta: '#D946EF',
  yellow: '#EAB308',
  orange: '#F97316',
  purple: '#A855F7',
  pink: '#EC4899',
  teal: '#14B8A6',
  indigo: '#6366F1',
};

function resolveColor(rawName: string, defaultColor: string = '#000000'): { stroke: string; fill?: string } {
  let clean = rawName.trim().toLowerCase();
  let fill: string | undefined = undefined;

  // Handle TikZ color percentages, e.g. blue!20 or red!60
  const percentMatch = clean.match(/([a-z]+)!(\d+)/);
  if (percentMatch) {
    const base = percentMatch[1];
    const opacity = parseInt(percentMatch[2], 10) / 100;
    const hex = COLOR_MAP[base] || '#3B82F6';
    return { stroke: hex, fill: hexToRgba(hex, opacity) };
  }

  const hex = COLOR_MAP[clean] || (clean.startsWith('#') ? clean : defaultColor);
  return { stroke: hex, fill };
}

function hexToRgba(hex: string, alpha: number): string {
  const c = hex.replace('#', '');
  if (c.length === 6) {
    const r = parseInt(c.slice(0, 2), 16);
    const g = parseInt(c.slice(2, 4), 16);
    const b = parseInt(c.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return hex;
}

export function compileTikzToSvg(tikzCode: string, targetWidth: number = 400, targetHeight: number = 300): string {
  // Extract content between \begin{tikzpicture} and \end{tikzpicture}
  let body = tikzCode;
  const beginIdx = tikzCode.indexOf('\\begin{tikzpicture}');
  const endIdx = tikzCode.indexOf('\\end{tikzpicture}');
  if (beginIdx !== -1 && endIdx !== -1) {
    body = tikzCode.slice(beginIdx + '\\begin{tikzpicture}'.length, endIdx);
    // remove bracketed options e.g. [scale=1.0]
    body = body.replace(/^\s*\[[^\]]*\]/, '');
  }

  const shapes: ParsedTikzShape[] = [];
  const lines = body.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('%'));

  // Coordinate collector for bounding box
  const allPoints: { x: number; y: number }[] = [];

  for (const rawLine of lines) {
    // Remove trailing semicolon and comments
    const line = rawLine.replace(/;.*$/, '').trim();

    // Check line styling: [blue, dashed, ->, fill=red!20, ...]
    let optsStr = '';
    let cmd = line;
    const optsMatch = line.match(/^\\(?:draw|fill|node|path)\s*\[([^\]]*)\]/);
    if (optsMatch) {
      optsStr = optsMatch[1];
      cmd = line.replace(/\[[^\]]*\]/, '');
    }

    const opts = optsStr.split(',').map(s => s.trim().toLowerCase());
    let color = '#2563EB'; // default blue-indigo
    let strokeWidth = 2.5;
    let dashed = false;
    let dotted = false;
    let arrow = false;
    let fillColor: string | undefined = undefined;

    for (const opt of opts) {
      if (opt.includes('->') || opt.includes('-stealth') || opt.includes('-latex')) arrow = true;
      if (opt === 'dashed') dashed = true;
      if (opt === 'dotted') dotted = true;
      if (opt === 'thick') strokeWidth = 3;
      if (opt === 'ultra thick') strokeWidth = 4;
      if (opt === 'thin') strokeWidth = 1.5;
      if (opt.startsWith('fill=')) {
        const fName = opt.replace('fill=', '');
        const res = resolveColor(fName);
        fillColor = res.fill || res.stroke;
      }
      if (COLOR_MAP[opt]) {
        color = COLOR_MAP[opt];
      }
    }

    // 1. Check for \node at (x, y) {$text$};
    const nodeMatch = line.match(/\\node(?:\s*\[[^\]]*\])?\s*at\s*\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)\s*\{([^}]*)\}/i);
    if (nodeMatch) {
      const nx = parseFloat(nodeMatch[1]);
      const ny = parseFloat(nodeMatch[2]);
      const text = nodeMatch[3].replace(/^\$|\$$/g, '').trim();
      shapes.push({
        type: 'node',
        coords: [{ x: nx, y: ny }],
        style: { color, strokeWidth },
        text: text
      });
      allPoints.push({ x: nx, y: ny });
      continue;
    }

    // 2. Check for Circle: (cx, cy) circle (r)
    const circleMatch = cmd.match(/\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)\s*circle\s*\(\s*([-\d.]+)(?:pt|cm)?\s*\)/i);
    if (circleMatch) {
      const cx = parseFloat(circleMatch[1]);
      const cy = parseFloat(circleMatch[2]);
      const r = parseFloat(circleMatch[3]);
      shapes.push({
        type: 'circle',
        coords: [{ x: cx, y: cy }],
        style: { color, strokeWidth, fillColor, r: r || 0.3 }
      });
      allPoints.push({ x: cx - (r || 0.3), y: cy - (r || 0.3) });
      allPoints.push({ x: cx + (r || 0.3), y: cy + (r || 0.3) });
      continue;
    }

    // 3. Check for Ellipse: (cx, cy) ellipse (rx and ry)
    const ellipseMatch = cmd.match(/\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)\s*ellipse\s*\(\s*([-\d.]+)\s*(?:and|,)\s*([-\d.]+)\s*\)/i);
    if (ellipseMatch) {
      const cx = parseFloat(ellipseMatch[1]);
      const cy = parseFloat(ellipseMatch[2]);
      const rx = parseFloat(ellipseMatch[3]);
      const ry = parseFloat(ellipseMatch[4]);
      shapes.push({
        type: 'ellipse',
        coords: [{ x: cx, y: cy }],
        style: { color, strokeWidth, fillColor, rx, ry }
      });
      allPoints.push({ x: cx - rx, y: cy - ry });
      allPoints.push({ x: cx + rx, y: cy + ry });
      continue;
    }

    // 4. Check for Rectangle: (x1, y1) rectangle (x2, y2)
    const rectMatch = cmd.match(/\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)\s*rectangle\s*\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/i);
    if (rectMatch) {
      const x1 = parseFloat(rectMatch[1]);
      const y1 = parseFloat(rectMatch[2]);
      const x2 = parseFloat(rectMatch[3]);
      const y2 = parseFloat(rectMatch[4]);
      shapes.push({
        type: 'rect',
        coords: [{ x: x1, y: y1 }, { x: x2, y: y2 }],
        style: { color, strokeWidth, fillColor }
      });
      allPoints.push({ x: x1, y: y1 }, { x: x2, y: y2 });
      continue;
    }

    // 5. Check for Smooth curve coordinates: plot [smooth] coordinates { (x1, y1) (x2, y2) ... }
    if (cmd.includes('coordinates')) {
      const coordMatches = [...cmd.matchAll(/\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/g)];
      if (coordMatches.length > 1) {
        const pts = coordMatches.map(m => ({ x: parseFloat(m[1]), y: parseFloat(m[2]) }));
        shapes.push({
          type: 'curve',
          coords: pts,
          style: { color, strokeWidth, dashed, dotted, arrow, fillColor }
        });
        pts.forEach(p => allPoints.push(p));
        continue;
      }
    }

    // 6. Check for standard Path / Line / Cycle: (x1, y1) -- (x2, y2) [-- (x3, y3)] [-- cycle]
    const coordMatches = [...cmd.matchAll(/\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/g)];
    if (coordMatches.length >= 2) {
      const pts = coordMatches.map(m => ({ x: parseFloat(m[1]), y: parseFloat(m[2]) }));
      const isCycle = cmd.includes('-- cycle');
      shapes.push({
        type: isCycle ? 'polygon' : (arrow ? 'arrow' : 'line'),
        coords: pts,
        style: { color, strokeWidth, dashed, dotted, arrow, fillColor }
      });
      pts.forEach(p => allPoints.push(p));
      continue;
    }
  }

  // Calculate Bounding Box of all TikZ shapes
  let minX = 0, minY = 0, maxX = 4, maxY = 3;
  if (allPoints.length > 0) {
    minX = Math.min(...allPoints.map(p => p.x));
    maxX = Math.max(...allPoints.map(p => p.x));
    minY = Math.min(...allPoints.map(p => p.y));
    maxY = Math.max(...allPoints.map(p => p.y));
  }

  // Prevent divide by zero or tiny boxes
  const spanX = Math.max(0.8, maxX - minX);
  const spanY = Math.max(0.8, maxY - minY);
  const padding = 30;
  const svgW = targetWidth;
  const svgH = targetHeight;

  // Scale TikZ math coords (where Y goes up) to SVG coords (where Y goes down)
  const mapX = (x: number) => padding + ((x - minX) / spanX) * (svgW - padding * 2);
  const mapY = (y: number) => svgH - padding - ((y - minY) / spanY) * (svgH - padding * 2);

  // Generate SVG Elements
  const svgElements: string[] = [];

  // Arrow marker definition
  const defs = `
    <defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#3B82F6" />
      </marker>
      <marker id="arrow-black" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#1E293B" />
      </marker>
    </defs>
  `;

  for (const s of shapes) {
    let dashStr = '';
    if (s.style.dashed) dashStr = 'stroke-dasharray="8,6"';
    if (s.style.dotted) dashStr = 'stroke-dasharray="2,5"';
    const fillStr = s.style.fillColor ? `fill="${s.style.fillColor}"` : 'fill="none"';
    const markerStr = s.style.arrow ? 'marker-end="url(#arrow)"' : '';

    switch (s.type) {
      case 'line':
      case 'arrow': {
        const d = s.coords.map((p, i) => `${i === 0 ? 'M' : 'L'} ${mapX(p.x).toFixed(1)} ${mapY(p.y).toFixed(1)}`).join(' ');
        svgElements.push(
          `<path d="${d}" stroke="${s.style.color}" stroke-width="${s.style.strokeWidth}" stroke-linecap="round" stroke-linejoin="round" ${fillStr} ${dashStr} ${markerStr} />`
        );
        break;
      }
      case 'polygon': {
        const ptsStr = s.coords.map(p => `${mapX(p.x).toFixed(1)},${mapY(p.y).toFixed(1)}`).join(' ');
        svgElements.push(
          `<polygon points="${ptsStr}" stroke="${s.style.color}" stroke-width="${s.style.strokeWidth}" ${fillStr || 'fill="rgba(59,130,246,0.1)"'} ${dashStr} />`
        );
        break;
      }
      case 'rect': {
        const [p1, p2] = s.coords;
        const x = Math.min(mapX(p1.x), mapX(p2.x));
        const y = Math.min(mapY(p1.y), mapY(p2.y));
        const w = Math.abs(mapX(p2.x) - mapX(p1.x));
        const h = Math.abs(mapY(p2.y) - mapY(p1.y));
        svgElements.push(
          `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="4" stroke="${s.style.color}" stroke-width="${s.style.strokeWidth}" ${fillStr} ${dashStr} />`
        );
        break;
      }
      case 'circle': {
        const p = s.coords[0];
        const rPx = Math.max(6, ((s.style.r || 0.3) / spanX) * (svgW - padding * 2));
        svgElements.push(
          `<circle cx="${mapX(p.x).toFixed(1)}" cy="${mapY(p.y).toFixed(1)}" r="${rPx.toFixed(1)}" stroke="${s.style.color}" stroke-width="${s.style.strokeWidth}" ${fillStr || `fill="${s.style.color}"`} />`
        );
        break;
      }
      case 'ellipse': {
        const p = s.coords[0];
        const rxPx = Math.max(10, ((s.style.rx || 1.0) / spanX) * (svgW - padding * 2));
        const ryPx = Math.max(10, ((s.style.ry || 0.8) / spanY) * (svgH - padding * 2));
        svgElements.push(
          `<ellipse cx="${mapX(p.x).toFixed(1)}" cy="${mapY(p.y).toFixed(1)}" rx="${rxPx.toFixed(1)}" ry="${ryPx.toFixed(1)}" stroke="${s.style.color}" stroke-width="${s.style.strokeWidth}" ${fillStr} ${dashStr} />`
        );
        break;
      }
      case 'curve': {
        if (s.coords.length < 2) break;
        // Construct smooth bezier or polyline path
        let d = `M ${mapX(s.coords[0].x).toFixed(1)} ${mapY(s.coords[0].y).toFixed(1)}`;
        for (let i = 1; i < s.coords.length; i++) {
          d += ` L ${mapX(s.coords[i].x).toFixed(1)} ${mapY(s.coords[i].y).toFixed(1)}`;
        }
        svgElements.push(
          `<path d="${d}" stroke="${s.style.color}" stroke-width="${s.style.strokeWidth}" stroke-linecap="round" stroke-linejoin="round" ${fillStr} ${dashStr} ${markerStr} />`
        );
        break;
      }
      case 'node': {
        const p = s.coords[0];
        const nx = mapX(p.x);
        const ny = mapY(p.y);
        svgElements.push(
          `<text x="${nx.toFixed(1)}" y="${ny.toFixed(1)}" font-family="KaTeX_Math, 'Times New Roman', serif" font-size="16" fill="${s.style.color}" text-anchor="middle" dominant-baseline="central">${escapeXml(s.text || '')}</text>`
        );
        break;
      }
    }
  }

  // Pure transparent background vector SVG
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgW} ${svgH}" width="100%" height="100%" style="background-color: transparent; overflow: visible;">
    ${defs}
    ${svgElements.join('\n    ')}
  </svg>`;
}

function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}
