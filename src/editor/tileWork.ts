/**
 * Page tile repaints while the pinch overlay covers the ink (useViewport.ts, PinchInk): `deferring`
 * makes the tiles repaint at the new zoom in slices (CanvasPage.tsx, InkTile and VectorTile) instead
 * of all at once when the fingers lift, which froze the page for a moment on a long note; each tile
 * still painting is in `pending`, and the overlay stays until none is.
 */
export const tileWork = { deferring: false, pending: new Set<object>() };
