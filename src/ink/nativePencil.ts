/**
 * 240 Hz Apple Pencil input from the iOS shell.
 *
 * WKWebView dispatches pointer events once per display frame (60 or 120 Hz) and does not
 * implement getCoalescedEvents, so a web page sees at most half of the Pencil's 240 samples per
 * second: fast handwriting turned into visible chords. The shell (ios-native/OpenNoteShell.m)
 * forwards every coalesced UITouch sample — precise location, force, altitude, azimuth and its own
 * timestamp — plus UIKit's predicted touches to window.__opennotePencil. While a Pencil stroke is
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
let listener: PencilListener | null = null;
/** Samples of the current touch that arrived before the canvas attached (pointerdown races them). */
let queue: PencilSample[] = [];
let touchActive = false;
let touchEnded = false;
let seen = false;

function decode(data: number[]): PencilSample[] {
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
  offset = Math.min(offset, performance.now() - nativeNow * 1000);
  seen = true;
  if (phase === 0) {
    queue = [];
    touchActive = true;
    touchEnded = false;
  }
  const samples = decode(data);
  const ended = phase >= 2;
  if (ended) {
    touchActive = false;
    touchEnded = true;
  }
  if (listener) listener(samples, decode(predicted), ended);
  else queue.push(...samples);
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
    const q = queue;
    queue = [];
    return q;
  },
  detach(fn: PencilListener): void {
    if (listener === fn) listener = null;
    queue = [];
  },
};
