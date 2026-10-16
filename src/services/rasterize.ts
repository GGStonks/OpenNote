import { Rect, Stroke, TextBlock } from '../types';
import { drawStrokes } from '../ink/strokeRenderer';
import { normalizeHex } from '../components/ColorPicker';
import { canvasFont } from '../editor/textStyle';

/**
 * Builds the image sent to the VLM.
 *
 * v1.0 cropped the on-screen stroke canvas at 1x CSS resolution with no margin and the paper
 * lines removed but the page background colour lost (white ink on "dark" paper became white on
 * white). Here the selected ink is re-rendered as vectors onto a clean white canvas, in dark ink,
 * upscaled so handwriting is large enough for Qwen3-VL's vision encoder, with a margin.
 */

const TARGET_LONG_SIDE = 1280;
const MIN_SCALE = 1;
const MAX_SCALE = 4;
const MARGIN = 28;

function readableInk(color: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(color);
  if (!m) return '#000000';
  const v = parseInt(m[1], 16);
  const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // Very light inks (e.g. white ink used on dark paper) are rendered black.
  return lum > 170 ? '#000000' : color;
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else line = test;
    }
    lines.push(line);
  }
  return lines;
}

/**
 * `inkColors`: several ink colours to keep apart (inkColors.ts): each ink is drawn in its own
 * colour (light ones darkened, keeping their hue) instead of all light inks becoming black.
 */
export function renderInkImage(strokes: Stroke[], bounds: Rect, textBlocks: TextBlock[] = [], inkColors?: Map<string, string>): string {
  const longSide = Math.max(bounds.width, bounds.height, 1);
  const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, TARGET_LONG_SIDE / longSide));
  const w = Math.max(64, Math.round(bounds.width * scale + MARGIN * 2));
  const h = Math.max(64, Math.round(bounds.height * scale + MARGIN * 2));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.translate(MARGIN, MARGIN);
  ctx.scale(scale, scale);
  ctx.translate(-bounds.x, -bounds.y);

  for (const t of textBlocks) {
    ctx.fillStyle = '#000000';
    ctx.font = canvasFont(t);
    ctx.textBaseline = 'top';
    wrapText(ctx, t.text, t.width).forEach((line, i) => ctx.fillText(line, t.x, t.y + i * t.fontSize * 1.35));
  }
  // Highlighters carry no content for transcription; ink is drawn dark and fully opaque.
  const ink = strokes
    .filter((s) => s.tool === 'pen')
    .map((s) => ({ ...s, color: inkColors?.get(normalizeHex(s.color) ?? '') ?? readableInk(s.color), opacity: 1, width: Math.max(s.width, 2) }));
  drawStrokes(ctx, ink);
  return canvas.toDataURL('image/png');
}

export function boundsOfStrokes(strokes: Stroke[], textBlocks: TextBlock[] = []): Rect | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of strokes) {
    for (const p of s.points) {
      minX = Math.min(minX, p.x - s.width);
      minY = Math.min(minY, p.y - s.width);
      maxX = Math.max(maxX, p.x + s.width);
      maxY = Math.max(maxY, p.y + s.width);
    }
  }
  for (const t of textBlocks) {
    minX = Math.min(minX, t.x);
    minY = Math.min(minY, t.y);
    maxX = Math.max(maxX, t.x + t.width);
    maxY = Math.max(maxY, t.y + t.fontSize * 1.4 * Math.max(1, t.text.split('\n').length));
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
