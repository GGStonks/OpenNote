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
  /** Pointer type of the stroke in progress ('pen': fingers touching the glass meanwhile are a palm). */
  inkingWith = '';
  private cancelHandlers = new Set<() => void>();
  private pinchHandlers = new Set<(phase: 'start' | 'move' | 'end') => void>();

  /** Two fingers are zooming: 'start' when the pinch engages, 'move' as the scale changes, 'end' when they lift. */
  onPinch(fn: (phase: 'start' | 'move' | 'end') => void): () => void {
    this.pinchHandlers.add(fn);
    return () => this.pinchHandlers.delete(fn);
  }

  pinch(phase: 'start' | 'move' | 'end'): void {
    this.pinchHandlers.forEach((fn) => fn(phase));
  }
  private dragCancelHandlers = new Set<() => void>();

  onCancel(fn: () => void): () => void {
    this.cancelHandlers.add(fn);
    return () => this.cancelHandlers.delete(fn);
  }

  cancelStrokes(): void {
    this.cancelHandlers.forEach((fn) => fn());
  }

  /** Registers what aborts a selection / handle drag (it goes back to where it started). */
  onDragCancel(fn: () => void): () => void {
    this.dragCancelHandlers.add(fn);
    return () => this.dragCancelHandlers.delete(fn);
  }

  /** Two fingers are down: any drag of a selection or shape handle is abandoned for scrolling. */
  cancelDrags(): void {
    this.dragCancelHandlers.forEach((fn) => fn());
    this.dragging = false;
  }
}
