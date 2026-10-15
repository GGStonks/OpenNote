/**
 * Page tile repaints around a pinch (useViewport.ts, PinchInk; CanvasPage.tsx, InkTile and
 * VectorTile).
 *
 *  - `deferring`: while the pinch overlay covers the ink, tiles repaint at the new zoom in slices
 *    instead of all at once when the fingers lift (which froze the page for a moment on a long
 *    note); each tile still painting is in `pending`, and the overlay stays until none is.
 *  - `paused`: while two fingers are zooming, no tile work is done at all (the overlay shows the
 *    ink): repaints left over from the previous zoom made the next pinch stutter. Work waiting for
 *    the fingers to lift is in `resume`.
 */
export const tileWork = {
  deferring: false,
  pending: new Set<object>(),
  paused: false,
  resume: new Set<() => void>(),
};

export function setTilesPaused(paused: boolean) {
  if (tileWork.paused === paused) return;
  tileWork.paused = paused;
  if (paused) return;
  const waiting = [...tileWork.resume];
  tileWork.resume.clear();
  for (const fn of waiting) fn();
}
