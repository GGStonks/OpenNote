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
 *   b,r,g,b,a,variable,clipX,clipY,clipW,clipH   begin / restart (clears the layer)
 *   u,n,x,y,r,...                                 n new settled points, then the tail (x, y, radius)
 *   d,clipX,clipY,clipW,clipH,<commands>         a whole drawing (Draw tool shapes, snapped shapes):
 *                                                 replaces what is shown (commands: inkRecorder.ts)
 *   e                                             the page shows the stroke: clear
 *   c                                             cancel: clear now
 */
import type { LiveStroke, ModeledPoint } from './engine';
import { pressureWidth } from './engine';
import { SMOOTH_SETTLE, smoothLine } from './strokeRenderer';

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
  /**
   * The committed stroke will be drawn as the smooth line (strokeRenderer.smoothLine; dense screens
   * and zoomed in): the live ink is the same smooth line, up to SMOOTH_SETTLE before the pen,
   * where later points can no longer change it.
   */
  smooth?: boolean;
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
  private model: LiveStroke | null = null;
  private key = '';
  private sent = 0;
  private done = false;
  /** Something was sent (end / cancel must clear it). */
  private shown = false;

  static get available(): boolean {
    if (send === undefined) send = sender();
    return !!send;
  }

  /** Sends what the stroke's model added since the last call (restarting if the model or style changed). */
  update(stroke: LiveStroke, style: InkStyle, tf: InkTransform): void {
    if (this.done || !NativeInk.available) return;
    const key = `${style.color}|${style.width}|${style.variable}|${!!style.smooth}|${tf.ox}|${tf.oy}|${tf.k}`;
    if (stroke !== this.model || key !== this.key) {
      this.model = stroke;
      this.key = key;
      this.sent = 0;
      const [r, g, b, a] = rgba(style.color);
      send!(['b', r, g, b, a, style.variable ? 1 : 0, f(tf.clip.x), f(tf.clip.y), f(tf.clip.w), f(tf.clip.h)].join(','));
      this.shown = true;
    }
    const m = stroke.model;
    const raw = m.points;
    const widthOf = (q: { p: number }) => (style.variable ? pressureWidth(style.width, q.p) : style.width);
    // Settled ink to send for good: the engine's line, or its smooth line up to where it is final.
    let pts: readonly ModeledPoint[] = raw;
    let widths: readonly number[] | null = null;
    let final = raw.length;
    if (style.smooth && raw.length > 4) {
      // Final: everything more than SMOOTH_SETTLE (along the line) before its newest point.
      let back = 0;
      final = raw.length - 1;
      while (final > 0 && back < SMOOTH_SETTLE) {
        back += Math.hypot(raw[final].x - raw[final - 1].x, raw[final].y - raw[final - 1].y);
        final--;
      }
      final = Math.max(this.sent, final);
      // Only the points about to be sent are smoothed (the line around them is the context).
      const g = smoothLine({ pts: raw.slice(), widths: raw.map(widthOf), width: style.width }, final, this.sent);
      pts = g.pts;
      widths = g.widths;
    }
    const out: string[] = ['u', String(Math.max(0, final - this.sent))];
    const push = (q: { x: number; y: number; p: number }, w: number) => {
      out.push(f(tf.ox + q.x * tf.k), f(tf.oy + q.y * tf.k), f((w / 2) * tf.k));
    };
    for (let i = this.sent; i < final; i++) push(pts[i], widths ? widths[i] : widthOf(pts[i]));
    this.sent = final;
    // The provisional end: the settled line not final yet, then the engine's tail.
    for (let i = final; i < raw.length; i++) push(raw[i], widthOf(raw[i]));
    for (const q of m.tail()) push(q, widthOf(q));
    send!(out.join(','));
  }

  /** Shows a whole drawing (commands from inkRecorder's record), replacing the stroke or the last drawing. */
  drawing(commands: string, tf: InkTransform): void {
    if (this.done || !NativeInk.available) return;
    this.model = null;
    this.key = '';
    send!(`d,${f(tf.clip.x)},${f(tf.clip.y)},${f(tf.clip.w)},${f(tf.clip.h)}${commands ? ',' + commands : ''}`);
    this.shown = true;
  }

  /** The page now shows the finished stroke (or its replacement): the shell's layer is cleared. */
  end(): void {
    if (this.done) return;
    this.done = true;
    if (this.shown && NativeInk.available) send!('e');
  }

  /** The stroke was dropped (or became something the shell does not draw): cleared at once. */
  cancel(): void {
    if (this.done) return;
    this.done = true;
    if (this.shown && NativeInk.available) send!('c');
  }
}
