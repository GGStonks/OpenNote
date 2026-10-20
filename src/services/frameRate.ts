/**
 * How fast this device draws the page: the refresh rate the page actually gets (Hz), measured from
 * its animation frames, not assumed to be 60 (120 Hz iPads and Android tablets, 90 Hz phones, and
 * a page held at 30 by the system). Work done a slice per frame (tile painting, preparing ink) is
 * sized from it (`frameMs`), so it takes the same share of a frame at any rate.
 *
 * Measured once the page is idle after start-up and each time it comes back to the screen: the
 * median interval of a run of frames. The highest rate seen is kept: the page can sustain it (a
 * run measured while busy reads lower, not higher).
 */
import { crashLog } from './crashLog';
import { pageUnlockFailed } from '../platform';

const RUN = 40;
const listeners = new Set<(hz: number) => void>();
let best = 0;
let measuring = false;

function fallbackHz(): number {
  const max = window.OpenNoteNative?.maxFps;
  return max && max > 0 ? Math.min(max, 60) : 60;
}

/** One run of frames: the median rate (Hz). */
function run(): Promise<number> {
  return new Promise((resolve) => {
    const t: number[] = [];
    const tick = (now: number) => {
      t.push(now);
      if (t.length <= RUN) requestAnimationFrame(tick);
      else {
        const gaps = t.slice(2).map((v, i) => v - t[i + 1]).sort((a, b) => a - b);
        const mid = gaps[gaps.length >> 1];
        resolve(mid > 0 ? 1000 / mid : 0);
      }
    };
    requestAnimationFrame(tick);
  });
}

export const frameRate = {
  /** The page's refresh rate (Hz): the highest measured, 60 (or the display's, if lower) until then. */
  get hz(): number {
    return best || fallbackHz();
  },
  /** One frame (ms) at that rate. */
  get frameMs(): number {
    return 1000 / this.hz;
  },
  get measured(): boolean {
    return best > 0;
  },
  /** Measures a run of frames now (also when already measured: it only raises the rate). */
  async measure(): Promise<number> {
    if (measuring || document.visibilityState === 'hidden') return this.hz;
    measuring = true;
    try {
      const hz = Math.round(await run());
      if (hz > best + 2) {
        best = hz;
        crashLog.set('hz', hz);
        crashLog.event('frame-rate', { hz, display: window.OpenNoteNative?.maxFps, unlocked: window.OpenNoteNative?.fullFrameRate });
        listeners.forEach((l) => l(hz));
      }
      return hz;
    } finally {
      measuring = false;
    }
  },
  subscribe(l: (hz: number) => void): () => void {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};

/**
 * Below this with WebKit's cap lifted, lifting it is what slows the page (it then gets every other
 * frame of a 60 Hz display: 30 fps).
 */
const UNLOCK_MIN_HZ = 50;

/** Measured a moment after start-up (once the first paints are done) and on each return to the screen. */
export function startFrameRate() {
  setTimeout(() => void frameRate.measure(), 1500);
  setTimeout(async () => {
    const hz = Math.max(await frameRate.measure(), frameRate.hz);
    const n = window.OpenNoteNative;
    // (Low Power Mode and heat hold the page at 30 fps whatever the cap.)
    if (n?.fullFrameRate && n.pageRate !== 'max' && !n.lowPower && (n.thermal ?? 0) < 2 && hz < UNLOCK_MIN_HZ) {
      crashLog.event('page-unlock-failed', { hz, display: n.maxFps });
      void pageUnlockFailed().catch(() => undefined);
    }
  }, 6000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') setTimeout(() => void frameRate.measure(), 800);
  });
}
