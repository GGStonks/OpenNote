/**
 * Native live ink: the stroke being written is also drawn by the app shell, natively, on a layer
 * above the web view.
 *
 * Ink drawn by the page reaches the screen through the web view's rendering pipeline (the page's
 * next animation frame, its paint, the hand-off of its layers to the system compositor): one to
 * two display frames more than a native app such as Notability, which is most of the pen lag a
 * 60 Hz iPad or an Android tablet shows. The shells (ios-native/OpenNoteShell.m, android
 * MainActivity's InkOverlay) draw the same geometry the ink engine models, as soon as each pen
 * sample is modelled, and also continue the line to the newest raw pen position the moment the
 * touch arrives, without waiting for the page.
 *
 * The engine (src/ink/engine) is untouched: this reads LiveStroke's model (its settled points and
 * provisional tail) and sends them, converted to the shell's view units. The page keeps drawing the
 * stroke too (the fallback, and the hand-off when the pen lifts: the shell clears its layer only
 * once the finished stroke has been painted by the page).
 *
 * Messages (one string each, numbers with up to 2 decimals):
 *   b,r,g,b,a,variable,clipX,clipY,clipW,clipH,id   begin / restart: a stroke shown before stays
 *                                                 until its own e,id (the next stroke often
 *                                                 begins before the page has drawn the last)
 *   u,n,x,y,r,...                                 n new settled points, then the tail (x, y, radius)
 *   l,id,x,y                                      the pen lifted: stroke id's line runs on to x, y
 *                                                 at its end's radius (Stroke.penEnd: the lead,
 *                                                 kept); "l,id" alone: no lead (the shells keep it
 *                                                 from the lift until this message)
 *   d,clipX,clipY,clipW,clipH,<commands>         a whole drawing (Draw tool shapes, snapped shapes):
 *                                                 replaces what is shown (commands: inkRecorder.ts)
 *   e,id                                          the page shows stroke id: the shell removes its
 *                                                 copy a few frames later (the page's frame
 *                                                 reaches the screen after it is drawn)
 *   e                                             the page shows the drawing: clear
 *   c                                             cancel: clear now
 */
import type { SmoothLiveStroke } from './smoothLiveStroke';

type Sender = (msg: string) => void;

function sender(): Sender | null {
  const w = window as unknown as {
    webkit?: { messageHandlers?: { opennoteInk?: { postMessage(m: string): void } } };
    OpenNoteInk?: { post(m: string): void };
  };
  const ios = w.webkit?.messageHandlers?.opennoteInk;
  if (ios) return (m) => ios.postMessage(m);
  const android = w.OpenNoteInk;
  if (android) return (m) => android.post(m);
  return null;
}

/** Page px to the shell's view units: x' = ox + x * k (iOS: points = CSS px; Android: device px). */
export interface InkTransform {
  ox: number;
  oy: number;
  k: number;
  /** The part of the screen the page's ink is visible in (view units): outside it the toolbar etc. */
  clip: { x: number; y: number; w: number; h: number };
}

export interface InkStyle {
  color: string;
  width: number;
  variable: boolean;
}

let send: Sender | null | undefined;
let rgbaCtx: CanvasRenderingContext2D | null = null;

/** Any CSS colour as r, g, b (0-255), a (0-1). */
function rgba(color: string): [number, number, number, number] {
  rgbaCtx ??= document.createElement('canvas').getContext('2d');
  if (!rgbaCtx) return [0, 0, 0, 1];
  rgbaCtx.fillStyle = '#000';
  rgbaCtx.fillStyle = color;
  const c = String(rgbaCtx.fillStyle);
  if (c.startsWith('#')) return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16), 1];
  const m = c.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 1];
  return [m[0] ?? 0, m[1] ?? 0, m[2] ?? 0, m[3] ?? 1];
}

const f = (v: number) => String(Math.round(v * 100) / 100);

/** The units of the shell's view per CSS px (Android draws in device px). */
export function nativeInkUnit(): number {
  return (window as unknown as { OpenNoteInk?: unknown }).OpenNoteInk ? window.devicePixelRatio || 1 : 1;
}

/** One stroke's native ink. */
export class NativeInk {
  /**
   * The stroke whose ink the shell's layer shows now. A stroke's "e" goes out two frames after the
   * pen lifts; when the next stroke has begun meanwhile (quick writing, dotting an i), its "b"
   * already cleared the layer, and that late "e" wiped the new stroke's ink instead.
   */
  private static showing: NativeInk | null = null;
  private static nextId = 1;
  /** This stroke's id in the shell ("b" and "e"). */
  private readonly id = NativeInk.nextId++;
  /** The shell shows a whole drawing ("d") for it, not a stroke. */
  private scene = false;
  private model: SmoothLiveStroke | null = null;
  private key = '';
  private sent = 0;
  private done = false;
  /** Something was sent (end / cancel must clear it). */
  private shown = false;

  static get available(): boolean {
    if (send === undefined) send = sender();
    return !!send;
  }

  /**
   * Sends what the stroke added since the last call (restarting if the stroke or style changed):
   * the same line the page draws (SmoothLiveStroke.line): its smoothed, final points once each, and
   * the rest (still changing) every time.
   */
  update(stroke: SmoothLiveStroke, style: InkStyle, tf: InkTransform): void {
    if (this.done || !NativeInk.available) return;
    const key = `${style.color}|${style.width}|${style.variable}|${tf.ox}|${tf.oy}|${tf.k}`;
    if (stroke !== this.model || key !== this.key) {
      this.model = stroke;
      this.key = key;
      this.sent = 0;
      const [r, g, b, a] = rgba(style.color);
      send!(['b', r, g, b, a, style.variable ? 1 : 0, f(tf.clip.x), f(tf.clip.y), f(tf.clip.w), f(tf.clip.h), this.id].join(','));
      this.shown = true;
      this.scene = false;
      NativeInk.showing = this;
    }
    const { final, finalW, rest, restW } = stroke.line(style);
    const out: string[] = ['u', String(Math.max(0, final.length - this.sent))];
    const push = (q: { x: number; y: number }, w: number) => {
      out.push(f(tf.ox + q.x * tf.k), f(tf.oy + q.y * tf.k), f((w / 2) * tf.k));
    };
    for (let i = this.sent; i < final.length; i++) push(final[i], finalW[i]);
    this.sent = final.length;
    rest.forEach((q, i) => push(q, restW[i]));
    send!(out.join(','));
  }

  /**
   * The pen lifted: the finished stroke runs on from the line's end to `end` (page px; its
   * Stroke.penEnd), which the shell's lead reached, or ends where the line ends (null).
   */
  lift(end: { x: number; y: number } | null, tf: InkTransform): void {
    if (this.done || this.scene || !this.model || !NativeInk.available) return;
    send!(end ? `l,${this.id},${f(tf.ox + end.x * tf.k)},${f(tf.oy + end.y * tf.k)}` : `l,${this.id}`);
  }

  /** Shows a whole drawing (commands from inkRecorder's record), replacing the stroke or the last drawing. */
  drawing(commands: string, tf: InkTransform): void {
    if (this.done || !NativeInk.available) return;
    this.model = null;
    this.key = '';
    send!(`d,${f(tf.clip.x)},${f(tf.clip.y)},${f(tf.clip.w)},${f(tf.clip.h)}${commands ? ',' + commands : ''}`);
    this.shown = true;
    this.scene = true;
    NativeInk.showing = this;
  }

  /** The page now shows the finished stroke (or its replacement): the shell's layer is cleared. */
  end(): void {
    if (this.done) return;
    this.done = true;
    // A stroke is removed by its id, also when the next one is shown already; a drawing only while
    // it is the one shown.
    if (this.shown && !this.scene && NativeInk.available) send!(`e,${this.id}`);
    else if (this.shown && NativeInk.showing === this && NativeInk.available) send!('e');
    if (NativeInk.showing === this) NativeInk.showing = null;
  }

  /** The stroke was dropped (or became something the shell does not draw): cleared at once. */
  cancel(): void {
    if (this.done) return;
    this.done = true;
    if (this.shown && NativeInk.showing === this && NativeInk.available) send!('c');
    if (NativeInk.showing === this) NativeInk.showing = null;
  }
}
