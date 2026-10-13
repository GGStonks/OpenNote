/**
 * Coordination between the scroll/zoom viewport and the drawing canvases.
 * The viewport owns touch navigation (pan, pinch); canvases ask it whether a touch belongs to them
 * and are told to cancel an in-progress finger stroke when a second finger turns it into a pinch.
 */
export class GestureBus {
  /** Number of touch pointers currently down on the viewport. */
  touches = 0;
  /** True while the viewport is panning/zooming. */
  navigating = false;
  /** True while a selection or shape handle is being dragged: the page must not scroll. */
  dragging = false;
  /** True while a pen / highlighter / shape / eraser stroke is in progress (autosave waits). */
  inking = false;
  private cancelHandlers = new Set<() => void>();

  onCancel(fn: () => void): () => void {
    this.cancelHandlers.add(fn);
    return () => this.cancelHandlers.delete(fn);
  }

  cancelStrokes(): void {
    this.cancelHandlers.forEach((fn) => fn());
  }
}
