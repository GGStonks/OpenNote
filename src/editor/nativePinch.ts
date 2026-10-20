/**
 * Pinch zoom drawn by the iOS shell (ios-native/OpenNoteShell.m, ONPinchOverlay).
 *
 * WebKit draws the page at 30 fps in Low Power Mode and when the iPad is hot, and nothing the page
 * or the shell can set lifts that; native scrolling is not affected, so scrolling stayed fluid and
 * the pinch went at half speed. While two fingers zoom, the shell lays a snapshot of the canvas
 * area over the page and scales it on every finger event sent here (the events still arrive at the
 * display's rate), as Notability's scroll view does; once the page has drawn the new zoom, the
 * snapshot goes. useViewport keeps the gesture's logic and its own transform under the snapshot.
 *
 * Messages (see ONPinchOverlay): b,id,x,y,w,h,c0x,c0y  m,id,k,cx,cy  e,id[,k,cx,cy]
 */
type Post = (msg: string) => void;

let post: Post | null | undefined;
let nextId = 1;

function poster(): Post | null {
  if (post === undefined) {
    const h = (window as unknown as { webkit?: { messageHandlers?: { opennotePinch?: { postMessage(m: string): void } } } }).webkit?.messageHandlers?.opennotePinch;
    post = h ? (m) => h.postMessage(m) : null;
  }
  return post;
}

const n = (v: number) => Math.round(v * 100) / 100;

export const nativePinch = {
  /** Starts a pinch over `area` (viewport px) about `c0` (relative to it); null without the shell. */
  begin(area: { left: number; top: number; width: number; height: number }, c0: { x: number; y: number }): number | null {
    const p = poster();
    if (!p) return null;
    const id = nextId++;
    p(`b,${id},${n(area.left)},${n(area.top)},${n(area.width)},${n(area.height)},${n(c0.x)},${n(c0.y)}`);
    return id;
  },
  /** The scale so far and the point between the fingers now (relative to the area). */
  move(id: number, k: number, c: { x: number; y: number }) {
    poster()?.(`m,${id},${Math.round(k * 10000) / 10000},${n(c.x)},${n(c.y)}`);
  },
  /** The page shows the new zoom, with the scale and the first centre's place it really has. */
  end(id: number, at?: { k: number; x: number; y: number }) {
    poster()?.(at ? `e,${id},${Math.round(at.k * 10000) / 10000},${n(at.x)},${n(at.y)}` : `e,${id}`);
  },
};
