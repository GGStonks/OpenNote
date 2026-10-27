/**
 * Settings > Pen: the finished ink drawn as vectors (SVG, by WebKit at the screen's own resolution,
 * at any zoom) instead of bitmaps (the page canvases and SharpInk's tiles). The shells draw the
 * live line as a vector shape; a bitmap of the same ink, even placed 1:1 on the pixel grid, looked
 * softer to the user the moment the pen lifted. On by default; read when a note is opened.
 */
const KEY = 'opennote_vector_ink';

export function vectorInkEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setVectorInk(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    /* storage unavailable */
  }
}
