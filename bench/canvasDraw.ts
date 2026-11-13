// Bundled by bench/canvasCompare.mjs into the harness page: the app's own canvas drawing of a
// page's strokes (strokeRenderer.drawStrokes), returned as RGBA8 bytes (base64).
import { drawStrokes } from '../src/ink/strokeRenderer';
import type { Stroke } from '../src/types';

(window as unknown as { drawApp: (s: Stroke[], w: number, h: number, scale: number, paper: string) => string }).drawApp = (strokes, w, h, scale, paper) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, w, h);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  drawStrokes(ctx, strokes);
  const d = ctx.getImageData(0, 0, w, h).data;
  let s = '';
  for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode(...d.subarray(i, i + 0x8000));
  return btoa(s);
};
