/**
 * Page tile work during a pinch (useViewport.ts; CanvasPage.tsx, InkTile and VectorTile): while two
 * fingers are zooming (`paused`), tiles do no repainting at all and SVG waits (the content is
 * scaled as it is); repaints left over from the previous zoom made the next pinch stutter. Work
 * waiting for the fingers to lift is in `resume`; `pause` is told when two fingers start zooming.
 */
export const tileWork = {
  paused: false,
  resume: new Set<() => void>(),
  pause: new Set<() => void>(),
};

export function setTilesPaused(paused: boolean) {
  if (tileWork.paused === paused) return;
  tileWork.paused = paused;
  if (paused) {
    for (const fn of [...tileWork.pause]) fn();
    return;
  }
  const waiting = [...tileWork.resume];
  tileWork.resume.clear();
  for (const fn of waiting) fn();
}
