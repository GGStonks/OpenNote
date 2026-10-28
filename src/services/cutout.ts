/**
 * Controls kept clear of a display cutout (camera notch or hole), and only those.
 *
 * Android reports a cutout as a band (a waterdrop notch: the status bar's height across the whole
 * width); keeping the band free left empty strips above the top bars, or beside them with the phone
 * sideways. The Android shell sends the cutout's own outline instead (`window.OpenNoteCutout`,
 * rectangles in CSS px, MainActivity), and every bar, list and corner button marked
 * `data-cutout-clear` keeps its place unless one of its controls would be under the cutout: that
 * control alone moves aside, just past it (a margin within its row, or more padding in a row of a
 * list), and the rest of the app still reaches the screen's edges. Again whenever the cutout, the
 * screen or the marked parts change. iOS keeps env(safe-area-inset-*) (--sa-* in index.css).
 */

type Box = { left: number; top: number; right: number; bottom: number };

declare global {
  interface Window {
    OpenNoteCutout?: [number, number, number, number][];
  }
}

/** Space left between a cutout and a control moved past it (CSS px). */
const GAP = 4;

const CONTROLS = 'button, input, textarea, select, a, [role="button"], h1, h2, h3, [data-cutout-item]';
const SHIFTED = 'data-cutout-shift';

function cutouts(): Box[] {
  return (window.OpenNoteCutout ?? []).map(([left, top, right, bottom]) => ({ left, top, right, bottom }));
}

const hits = (a: Box, b: Box) => a.left < b.right + GAP && a.right > b.left - GAP && a.top < b.bottom + GAP && a.bottom > b.top - GAP;

/** The cutout a control would be under, if any. */
function under(el: Element, cuts: Box[]): Box | null {
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return cuts.find((c) => hits(r, c)) ?? null;
}

function reset(root: Element) {
  [...(root.hasAttribute(SHIFTED) ? [root] : []), ...root.querySelectorAll(`[${SHIFTED}]`)].forEach((el) => {
    const e = el as HTMLElement;
    e.style.marginLeft = '';
    e.style.marginRight = '';
    e.style.paddingLeft = '';
    e.style.paddingRight = '';
    e.style.maxWidth = '';
    e.style.minWidth = '';
    e.style.flexShrink = '';
    e.style.paddingTop = '';
    e.removeAttribute(SHIFTED);
  });
}

/** How far each box from `el`'s parent up to `root` overflows sideways (a move must not add to it:
 *  a control pushed out of its row lands on the next one). */
function overflow(el: HTMLElement, root: HTMLElement): number[] {
  const out: number[] = [];
  for (let e = el.parentElement; e; e = e.parentElement) {
    out.push(e.scrollWidth - e.clientWidth);
    if (e === root) break;
  }
  return out;
}

const grew = (before: number[], after: number[]) => after.some((v, i) => v > (before[i] ?? 0) + 1);

/** Moved past the cutout but off its bar or off the screen (a corner button pushed past the edge). */
function outside(el: HTMLElement, root: HTMLElement): boolean {
  const r = el.getBoundingClientRect(), b = root.getBoundingClientRect();
  return r.left < Math.max(0, b.left) - 0.5 || r.right > Math.min(window.innerWidth, b.right) + 0.5;
}

/** The control is clear of `cut` without breaking its bar. */
const fine = (el: HTMLElement, root: HTMLElement, cuts: Box[], cut: Box, before: number[]): boolean =>
  under(el, cuts) !== cut && !grew(before, overflow(el, root)) && !outside(el, root);

/** Can give up width in a row: a text field or text that is cut off with an ellipsis (the note's
 *  title), never a button. */
function shrinks(e: HTMLElement): boolean {
  const cs = getComputedStyle(e);
  return cs.flexShrink !== '0' && e.getBoundingClientRect().width > 0 && (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || cs.overflowX === 'hidden');
}

/** Lets the siblings of `el` that shrink go below their minimum width; undoes it with the result. */
function relaxSiblings(el: HTMLElement): () => void {
  const changed: HTMLElement[] = [];
  for (const sib of el.parentElement ? [...el.parentElement.children] : []) {
    const s = sib as HTMLElement;
    if (s === el || !shrinks(s) || s.style.minWidth) continue;
    s.style.minWidth = '0px';
    s.setAttribute(SHIFTED, '');
    changed.push(s);
  }
  return () =>
    changed.forEach((s) => {
      s.style.minWidth = '';
      s.removeAttribute(SHIFTED);
    });
}

/** Moves the controls of `root` that a cutout would cover past it; true if any moved. */
function clear(root: HTMLElement, cuts: Box[]): boolean {
  let moved = false;
  const done = new Set<Element>();
  // One control at a time, measuring again after each: moving one moves the ones after it.
  for (let pass = 0; pass < 12; pass++) {
    const all = [...(root.matches(CONTROLS) ? [root] : []), ...root.querySelectorAll<HTMLElement>(CONTROLS)];
    const el = all.find((c) => !done.has(c) && under(c, cuts));
    if (!el) break;
    done.add(el);
    const cut = under(el, cuts)!;
    const r = el.getBoundingClientRect();
    const box = root.getBoundingClientRect();
    if (r.width >= box.width * 0.8) {
      // A row of a list (as wide as the list) with the cutout at one end: its content starts (or
      // ends) past the cutout. A cutout over the middle of a wide row leaves it as it is.
      const side = cut.left <= r.left + 24 ? 'left' : cut.right >= r.right - 24 ? 'right' : null;
      if (!side) continue;
      const cs = getComputedStyle(el);
      el.setAttribute(SHIFTED, '');
      if (side === 'left') el.style.paddingLeft = `${(parseFloat(cs.paddingLeft) || 0) + cut.right + GAP - r.left}px`;
      else el.style.paddingRight = `${(parseFloat(cs.paddingRight) || 0) + r.right - (cut.left - GAP)}px`;
      moved = true;
      continue;
    }
    // In a row of controls: to the side of the cutout it moves less to, by a margin, so the
    // controls after it (or before it, in a row packed to the end) follow and nothing overlaps.
    // Twice the distance for one centred in a box of its own (it moves half as far).
    const toRight = cut.right + GAP - r.left;
    const toLeft = r.right - (cut.left - GAP);
    const sides: ['margin-left' | 'margin-right', number][] = toLeft < toRight ? [['margin-right', toLeft], ['margin-left', toRight]] : [['margin-left', toRight], ['margin-right', toLeft]];
    const cs = getComputedStyle(el);
    const base = { 'margin-left': parseFloat(cs.marginLeft) || 0, 'margin-right': parseFloat(cs.marginRight) || 0 };
    const before = overflow(el, root);
    let free = false;
    for (const [side, px] of sides) {
      for (const k of [1, 2]) {
        el.style.setProperty(side, `${base[side] + px * k}px`);
        if (fine(el, root, cuts, cut, before)) {
          free = true;
          break;
        }
        // No room for the margin: the row's flexing controls may give it up, below their minimum.
        const undo = relaxSiblings(el);
        if (fine(el, root, cuts, cut, before)) {
          free = true;
          break;
        }
        undo();
        el.style.removeProperty(side);
      }
      if (free) break;
    }
    // Else one that can be cut off (the title) ends before the cutout, at a fixed width from then on
    // (so it does not take up the next control's margin).
    if (!free && shrinks(el) && cut.left - GAP - r.left >= 0 && cut.left > r.left) {
      el.style.maxWidth = `${cut.left - GAP - r.left}px`;
      el.style.minWidth = '0px';
      el.style.flexShrink = '0';
      if (fine(el, root, cuts, cut, before)) free = true;
      else {
        el.style.maxWidth = '';
        el.style.minWidth = '';
        el.style.flexShrink = '';
      }
    }
    if (!free) {
      // A margin is taken up by a sibling before it that shrinks (the note's title in the top bar):
      // that one gives up the room instead, so this control ends before the cutout.
      for (let prev = el.previousElementSibling as HTMLElement | null; prev && !free; prev = prev.previousElementSibling as HTMLElement | null) {
        const w = prev.getBoundingClientRect().width;
        // (One this pass fixed at a width, as the title above, still counts as flexing.)
        if ((getComputedStyle(prev).flexShrink === '0' && !prev.hasAttribute(SHIFTED)) || w - toLeft < 0) continue;
        // Its own margin past the cutout (if it had to move aside itself) is no longer needed.
        const margin = prev.style.marginRight;
        prev.style.marginRight = '';
        // Too little left to read (a title cut to one letter): it gives up all its room.
        const keep = w - toLeft >= 40 ? w - toLeft : 0;
        prev.style.maxWidth = `${keep}px`;
        prev.style.minWidth = '0px';
        prev.style.flexShrink = '0';
        if (!keep) {
          prev.style.paddingLeft = '0px';
          prev.style.paddingRight = '0px';
        }
        if (fine(el, root, cuts, cut, before)) {
          prev.setAttribute(SHIFTED, '');
          free = true;
        } else {
          prev.style.maxWidth = '';
          prev.style.minWidth = '';
          prev.style.flexShrink = '';
          prev.style.paddingLeft = '';
          prev.style.paddingRight = '';
          prev.style.marginRight = margin;
        }
      }
    }
    if (free) {
      el.setAttribute(SHIFTED, '');
      moved = true;
    } else if (cut.top < box.top + box.height / 2 && root.hasAttribute('data-cutout-bar')) {
      // A bar along the top with no room beside the cutout: the bar alone goes down past the
      // cutout's own depth (not the band Android reports), the last resort.
      root.style.paddingTop = `${(parseFloat(getComputedStyle(root).paddingTop) || 0) + cut.bottom + GAP - r.top}px`;
      root.setAttribute(SHIFTED, '');
      moved = true;
      break;
    }
    // Otherwise no room on either side: it stays where it was.
  }
  return moved;
}

let frame: number | null = null;

/** One pass over every marked part of the app. */
function run() {
  frame = null;
  const cuts = cutouts();
  const roots = [...document.querySelectorAll<HTMLElement>('[data-cutout-clear]')];
  roots.forEach(reset);
  if (!cuts.length) return;
  for (const root of roots) clear(root, cuts);
}

/** Runs a pass on the next frame (once, however often asked). */
export function clearCutoutSoon(): void {
  if (frame === null) frame = requestAnimationFrame(run);
}

/** Starts watching (App, once): the cutout, the screen's size and the marked parts' content. */
export function startCutoutClearance(): void {
  window.addEventListener('opennote-cutout', clearCutoutSoon);
  window.addEventListener('resize', clearCutoutSoon);
  // Only changes in or around marked parts (the ink layers change with every stroke).
  new MutationObserver((records) => {
    if (!window.OpenNoteCutout?.length) return;
    for (const m of records) {
      const t = m.target instanceof Element ? m.target : m.target.parentElement;
      if (t?.closest('[data-cutout-clear]') || [...m.addedNodes].some((n) => n instanceof Element && (n.matches('[data-cutout-clear]') || n.querySelector('[data-cutout-clear]')))) {
        clearCutoutSoon();
        return;
      }
    }
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  clearCutoutSoon();
}
