/**
 * 240 Hz Apple Pencil input from the iOS shell.
 *
 * WKWebView dispatches pointer events once per display frame (60 or 120 Hz) and does not
 * implement getCoalescedEvents, so a web page sees at most half of the Pencil's 240 samples per
 * second: fast handwriting turned into visible chords. The shell (ios-native/OpenNoteShell.m)
 * forwards every coalesced UITouch sample — precise location, force, altitude, azimuth and its own
 * timestamp — to window.__opennotePencil. While a Pencil stroke is
 * drawn, the canvas takes its samples from here and ignores the web events' positions.
 */

export interface PencilSample {
  clientX: number;
  clientY: number;
  /** Normalised force 0..1. */
  pressure: number;
  /** On the performance.now() clock. */
  timeStamp: number;
  altitudeAngle: number;
  azimuthAngle: number;
  pointerType: 'pen';
  tiltX: number;
  tiltY: number;
}

export type PencilListener = (samples: PencilSample[], predicted: PencilSample[], ended: boolean) => void;

const STRIDE = 6;

/** performance.now() minus the native clock, in ms: the smallest value seen (least IPC delay). */
let offset = Infinity;
/**
 * The offset used for the current touch, fixed when it begins. Refining the estimate mid-stroke
 * shifted the following samples' times by the IPC jitter (a few ms back or forth at 4 ms per
 * sample), which the time-based stroke model turned into kinks.
 */
let touchOffset = Infinity;
let listener: PencilListener | null = null;
/** The attached listener has received its touch's end: it must not get the next touch. */
let listenerEnded = false;
/** Samples of the current touch that arrived before the canvas attached (pointerdown races them). */
let queue: PencilSample[] = [];
let touchActive = false;
let touchEnded = false;
let seen = false;

function decode(data: number[], offset: number): PencilSample[] {
  const out: PencilSample[] = [];
  for (let i = 0; i + STRIDE <= data.length; i += STRIDE) {
    out.push({
      clientX: data[i],
      clientY: data[i + 1],
      pressure: Math.max(0, Math.min(1, data[i + 2])),
      timeStamp: data[i + 3] * 1000 + offset,
      altitudeAngle: data[i + 4],
      azimuthAngle: data[i + 5],
      pointerType: 'pen',
      tiltX: 0,
      tiltY: 0,
    });
  }
  return out;
}

function receive(phase: number, nativeNow: number, data: number[], predicted: number[]) {
  const measured = performance.now() - nativeNow * 1000;
  // A delivery delay is a few ms; a much larger gap means the clocks moved apart (e.g. sleep).
  offset = measured < offset || measured - offset > 1000 ? measured : offset;
  seen = true;
  if (phase === 0) {
    queue = [];
    touchActive = true;
    touchEnded = false;
    touchOffset = offset;
    // Quick strokes (dotting an i): the previous stroke may still be waiting for its web
    // pointerup. Its listener must not take this touch's samples, which drew a line from the end of
    // the last stroke to the start of the new one.
    if (listener && listenerEnded) listener = null;
  }
  const o = Number.isFinite(touchOffset) ? touchOffset : offset;
  const samples = decode(data, o);
  const ended = phase >= 2;
  if (ended) {
    touchActive = false;
    touchEnded = true;
  }
  if (listener) {
    if (ended) listenerEnded = true;
    listener(samples, decode(predicted, o), ended);
  } else queue.push(...samples);
}

if (typeof window !== 'undefined') {
  (window as unknown as { __opennotePencil?: typeof receive }).__opennotePencil = receive;
}

export const nativePencil = {
  /** True once the shell has sent any sample (i.e. running in the iOS app). */
  get available(): boolean {
    return seen;
  },
  /** The current Pencil touch has ended (its final samples were delivered). */
  get ended(): boolean {
    return touchEnded;
  },
  get touching(): boolean {
    return touchActive;
  },
  /** Starts delivering samples to `fn`; samples queued since the touch began come first. */
  attach(fn: PencilListener): PencilSample[] {
    listener = fn;
    listenerEnded = touchEnded;
    const q = queue;
    queue = [];
    return q;
  },
  detach(fn: PencilListener): void {
    // Only the attached listener clears the queue: a stale one being detached must not discard
    // the samples of the touch that has just begun.
    if (listener !== fn) return;
    listener = null;
    queue = [];
  },
};
