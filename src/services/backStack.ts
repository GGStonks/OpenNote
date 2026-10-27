import { useEffect, useRef } from 'react';

/**
 * The device's back (Android's back button or gesture): closes what was opened last, as its own
 * close button would: a menu or popover, a dialog, the pages panel, then the note (as the editor's
 * back button). Each closable thing registers while it is shown (useBack), so the newest is on top.
 * The Android shell asks `window.OpenNoteBack()` and sends the app to the background only when
 * nothing was open (back used to close the app from anywhere).
 */

type Entry = { close: { current: () => void } };

const stack: Entry[] = [];

/** Closes the newest registered thing; false when nothing is open. */
export function goBack(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.close.current();
  return true;
}

/** While `active`, the device's back calls `close` (the latest one passed) unless something newer is open. */
export function useBack(active: boolean, close: () => void): void {
  const ref = useRef(close);
  ref.current = close;
  useEffect(() => {
    if (!active) return;
    const entry: Entry = { close: ref };
    stack.push(entry);
    return () => {
      const i = stack.lastIndexOf(entry);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [active]);
}

/** Back stack depth (bench). */
export function backDepth(): number {
  return stack.length;
}

declare global {
  interface Window {
    OpenNoteBack?: () => boolean;
    OpenNoteBackDepth?: () => number;
  }
}

window.OpenNoteBack = goBack;
window.OpenNoteBackDepth = backDepth;
