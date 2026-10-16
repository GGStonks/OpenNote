/**
 * Page tile work during a pinch (useViewport.ts; CanvasPage.tsx, InkTile and VectorTile): while two
 * fingers are zooming (`paused`), tiles do no repainting at all and SVG waits (the content is
 * scaled as it is); repaints left over from the previous zoom made the next pinch stutter. Work
 * waiting for the fingers to lift is in `resume`.
 */
export const tileWork = {
  paused: false,
  resume: new Set<() => void>(),
  /**
   * Tiles still repainting for a new zoom (InkTile's off-screen repaint, VectorTile's SVG): the
   * sharp ink drawn during a pinch (CanvasPage) stays over them until none is.
   */
  pending: new Set<object>(),
};

export function setTilesPaused(paused: boolean) {
  if (tileWork.paused === paused) return;
  tileWork.paused = paused;
  if (paused) return;
  const waiting = [...tileWork.resume];
  tileWork.resume.clear();
  for (const fn of waiting) fn();
}
