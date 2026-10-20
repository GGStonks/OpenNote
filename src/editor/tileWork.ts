/**
 * Page tile work during a pinch (useViewport.ts; CanvasPage.tsx, InkTile and VectorTile): while two
 * fingers are zooming (`paused`), tiles do no repainting at all and SVG waits (the content is
 * scaled as it is); repaints left over from the previous zoom made the next pinch stutter. Work
 * waiting for the fingers to lift is in `resume`; `pause` is told when two fingers start zooming,
 * `moved` on every frame of the pinch, once the content has its new transform. `shell`: the iOS
 * shell draws this pinch (nativePinch.ts), the page does nothing. `painting`: the sharp ink layers
 * still painting the tiles in view after a zoom (the GPU ink of the pinch, usePinchInk.ts, stays
 * until they are done).
 */
export const tileWork = {
  paused: false,
  shell: false,
  resume: new Set<() => void>(),
  pause: new Set<() => void>(),
  moved: new Set<() => void>(),
  /** Told every time the fingers lift (unlike `resume`, whose work is done once). */
  ended: new Set<() => void>(),
  painting: new Set<object>(),
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
  for (const fn of [...tileWork.ended]) fn();
}
