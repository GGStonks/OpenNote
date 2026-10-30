import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Bookmark, CheckCircle2, Circle, ClipboardCopy, ClipboardPaste, CopyPlus, GripVertical, Palette, Plus, Scissors, Trash2, X } from 'lucide-react';
import { NoteDocument, NotePage } from '../types';
import { SetupPatch, hasOwnSetup } from '../editor/pageSetup';
import { SheetBox, SurfaceLayout, sheetView } from '../editor/sheets';
import { PageThumb } from './NoteThumb';
import { PaperPicker, PaperValues } from './PaperPicker';

/**
 * Page manager: every page of the note (each piece of its surface, ink crossing a page line shown
 * on both) as a live thumbnail, in a side panel.
 *
 *  - Tap a page to go to it (it becomes the selection). "Select" (or ctrl / ⌘ / shift on a
 *    keyboard) selects several pages.
 *  - Drag a page by its grip (or with the mouse, anywhere on it) to move it; dragging a selected
 *    page moves all the selected pages.
 *  - The bar below acts on the selected pages: paper (pattern, colour, orientation, size, or back
 *    to the note's paper), duplicate, copy, cut, paste (after the selection) and delete.
 */

interface PageManagerProps {
  doc: NoteDocument;
  layout: SurfaceLayout;
  currentPage: number;
  selected: ReadonlySet<string>;
  setSelected: (s: ReadonlySet<string>) => void;
  onJump: (index: number) => void;
  onMove: (ids: ReadonlySet<string>, to: number) => void;
  onDelete: (ids: ReadonlySet<string>) => void;
  onDuplicate: (ids: ReadonlySet<string>) => void;
  onCopy: (ids: ReadonlySet<string>) => void;
  onCut: (ids: ReadonlySet<string>) => void;
  onPaste: () => void;
  canPaste: boolean;
  onSetup: (ids: ReadonlySet<string>, patch: SetupPatch | 'reset') => void;
  /** Bookmarks the pages (or takes their bookmarks off). */
  onBookmark: (ids: ReadonlySet<string>, on: boolean) => void;
  onAddPage: () => void;
  onClose: () => void;
}

const THUMB_W = 148;
const THUMB_MAX_H = 192;
/** Thumbnails follow edits at most this often (redrawing one on every stroke is wasted work). */
const THUMB_THROTTLE_MS = 350;

function useThrottled<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  const lastAt = useRef(0);
  useEffect(() => {
    const wait = lastAt.current + ms - performance.now();
    if (wait <= 0) {
      lastAt.current = performance.now();
      setShown(value);
      return;
    }
    const id = setTimeout(() => {
      lastAt.current = performance.now();
      setShown(value);
    }, wait);
    return () => clearTimeout(id);
  }, [value, ms]);
  return shown;
}

const LiveThumb: React.FC<{ surface: NotePage; box: SheetBox; root: Element | null }> = ({ surface, box, root }) => {
  const page = useMemo(() => sheetView(surface, box), [surface, box]);
  const scale = Math.min(THUMB_W / box.width, THUMB_MAX_H / box.height);
  return <PageThumb page={page} width={box.width} height={box.height} paperStyle={box.paperStyle} paperColor={box.paperColor} patternColor={box.patternColor} pdf={box.pdf} scale={scale} root={root} />;
};

const BAR_BTN = 'w-9 h-9 flex items-center justify-center rounded-xl transition active:scale-90 disabled:opacity-30 disabled:active:scale-100';

export const PageManager: React.FC<PageManagerProps> = (p) => {
  const { doc, layout, selected, setSelected } = p;
  const pages = doc.sheets;
  /** The surface, following edits at most every THUMB_THROTTLE_MS. */
  const surface = useThrottled(doc.pages[0], THUMB_THROTTLE_MS);
  const [selectMode, setSelectMode] = useState(false);
  /** Only bookmarked pages listed. */
  const [onlyMarked, setOnlyMarked] = useState(false);
  const [paperOpen, setPaperOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null);
  const items = useRef(new Map<string, HTMLDivElement>());
  /** Last page tapped (shift-click selects the range from it). */
  const anchor = useRef<string | null>(null);

  const setups = layout.sheets;
  const count = selected.size;

  // Keep the current page in view in the list.
  useEffect(() => {
    const id = pages[p.currentPage]?.id;
    const el = id ? items.current.get(id) : null;
    const list = listRef.current;
    if (!el || !list) return;
    const r = el.getBoundingClientRect(), l = list.getBoundingClientRect();
    if (r.top < l.top || r.bottom > l.bottom) list.scrollTop += r.top - l.top - l.height / 2 + r.height / 2;
  }, [p.currentPage]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!count) setPaperOpen(false);
  }, [count]);

  const onTap = (e: React.MouseEvent, index: number) => {
    const id = pages[index].id;
    if (e.shiftKey && anchor.current) {
      const a = pages.findIndex((pg) => pg.id === anchor.current);
      if (a >= 0) {
        const [lo, hi] = a < index ? [a, index] : [index, a];
        setSelected(new Set(pages.slice(lo, hi + 1).map((pg) => pg.id)));
        return;
      }
    }
    anchor.current = id;
    if (selectMode || e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSelected(next);
      return;
    }
    setSelected(new Set([id]));
    p.onJump(index);
  };

  // ---------------------------------------------------------------------------- drag & drop
  const [drag, setDrag] = useState<{ ids: ReadonlySet<string>; x: number; y: number; to: number } | null>(null);
  const dragRef = useRef<{ ids: ReadonlySet<string>; pointerId: number; startY: number; started: boolean; to: number; x: number; y: number } | null>(null);
  const autoScroll = useRef<number | null>(null);
  /** Time of the last auto-scroll step (frame-time scaling). */
  const autoScrollAt = useRef<number | null>(null);

  const dropIndex = (clientY: number) => {
    for (let i = 0; i < pages.length; i++) {
      const el = items.current.get(pages[i].id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return pages.length;
  };

  const stopAutoScroll = () => {
    if (autoScroll.current !== null) cancelAnimationFrame(autoScroll.current);
    autoScroll.current = null;
    autoScrollAt.current = null;
  };

  const runAutoScroll = (now: number) => {
    const list = listRef.current, d = dragRef.current;
    autoScroll.current = null;
    if (!list || !d?.started) return;
    // Speed per 60 Hz frame, scaled by the real frame time: the same speed at 60 and 120 Hz.
    const frames = autoScrollAt.current === null ? 1 : Math.min(2, (now - autoScrollAt.current) / (1000 / 60));
    autoScrollAt.current = now;
    const r = list.getBoundingClientRect();
    const edge = 48;
    const v = (d.y < r.top + edge ? -(r.top + edge - d.y) / 3 : d.y > r.bottom - edge ? (d.y - (r.bottom - edge)) / 3 : 0) * frames;
    if (v) {
      list.scrollTop += v;
      d.to = dropIndex(d.y);
      setDrag({ ids: d.ids, x: d.x, y: d.y, to: d.to });
    }
    autoScroll.current = requestAnimationFrame(runAutoScroll);
  };

  const beginDrag = (e: React.PointerEvent, id: string, immediate: boolean) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const ids = selected.has(id) ? selected : new Set([id]);
    dragRef.current = { ids, pointerId: e.pointerId, startY: e.clientY, started: false, to: -1, x: e.clientX, y: e.clientY };
    if (immediate) {
      e.preventDefault();
      e.stopPropagation();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      startDrag(e.clientX, e.clientY);
    }
  };

  const startDrag = (x: number, y: number) => {
    const d = dragRef.current;
    if (!d) return;
    d.started = true;
    if (!d.ids.size || ![...d.ids].every((id) => selected.has(id))) setSelected(d.ids);
    d.to = dropIndex(y);
    setDrag({ ids: d.ids, x, y, to: d.to });
    if (autoScroll.current === null) autoScroll.current = requestAnimationFrame(runAutoScroll);
  };

  const moveDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    d.x = e.clientX;
    d.y = e.clientY;
    if (!d.started) {
      if (Math.abs(e.clientY - d.startY) < 6) return;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      startDrag(e.clientX, e.clientY);
      return;
    }
    d.to = dropIndex(e.clientY);
    setDrag({ ids: d.ids, x: d.x, y: d.y, to: d.to });
  };

  const endDrag = (e: React.PointerEvent, cancelled = false) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    dragRef.current = null;
    stopAutoScroll();
    if (!d.started) return;
    setDrag(null);
    if (!cancelled && d.to >= 0) p.onMove(d.ids, d.to);
    // The click that follows a mouse drag must not count as a tap.
    suppressClick.current = true;
    setTimeout(() => (suppressClick.current = false), 0);
  };
  const suppressClick = useRef(false);
  useEffect(() => stopAutoScroll, []);

  // ---------------------------------------------------------------------------- paper of the selection
  const paperValue = useMemo<PaperValues>(() => {
    const sel = setups.filter((_, i) => selected.has(pages[i].id));
    const same = <K extends keyof PaperValues>(k: K) => (sel.length && sel.every((s) => s[k] === sel[0][k]) ? (sel[0][k] as PaperValues[K]) : null);
    // Pages of their own size (PDF pages) have no format to show.
    const custom = sel.some((s) => s.custom);
    return { paperStyle: same('paperStyle'), paperColor: same('paperColor'), patternColor: same('patternColor'), size: custom ? null : same('size'), orientation: custom ? null : same('orientation') };
  }, [setups, selected, pages]);
  const anyOwn = pages.some((pg) => selected.has(pg.id) && hasOwnSetup(pg));

  const dragLabel = drag ? (drag.ids.size > 1 ? `${drag.ids.size} pages` : `Page ${pages.findIndex((pg) => drag.ids.has(pg.id)) + 1}`) : '';

  return (
    <aside data-cutout-clear className="h-full w-[calc(216px+var(--sa-left))] pl-[var(--sa-left)] flex-shrink-0 flex flex-col bg-ui-app dark:bg-ui-side border-r border-gray-200 dark:border-gray-800 select-none" data-no-pan>
      <div className="flex items-center gap-1 px-3 py-2 border-b border-gray-200 dark:border-gray-800">
        <div className="font-semibold text-sm text-gray-900 dark:text-gray-100 flex-1">
          {count > 1 ? `${count} selected` : `${pages.length} page${pages.length === 1 ? '' : 's'}`}
        </div>
        {selectMode && (
          <button
            onClick={() => setSelected(count === pages.length ? new Set() : new Set(pages.map((pg) => pg.id)))}
            className="text-xs font-semibold text-blue-600 dark:text-blue-400 px-1.5 py-1 rounded-lg"
          >
            {count === pages.length ? 'None' : 'All'}
          </button>
        )}
        <button
          onClick={() => {
            if (selectMode && count > 1) setSelected(new Set([pages[p.currentPage]?.id].filter(Boolean) as string[]));
            setSelectMode(!selectMode);
          }}
          className={`text-xs font-semibold px-2 py-1 rounded-lg ${selectMode ? 'bg-blue-600 text-white' : 'text-blue-600 dark:text-blue-400'}`}
        >
          {selectMode ? 'Done' : 'Select'}
        </button>
        <button
          onClick={() => setOnlyMarked(!onlyMarked)}
          className={`p-1 rounded-lg ${onlyMarked ? 'bg-red-500 text-white' : 'text-gray-400 hover:text-gray-600'}`}
          title={onlyMarked ? 'Show all pages' : 'Show bookmarked pages only'}
        >
          <Bookmark className="w-4 h-4" fill={onlyMarked ? 'currentColor' : 'none'} />
        </button>
        <button onClick={p.onClose} className="p-1 text-gray-400 hover:text-gray-600 rounded-lg" title="Close">
          <X className="w-5 h-5" />
        </button>
      </div>
      {onlyMarked && !pages.some((pg) => pg.bookmarked) && (
        <div className="px-4 py-6 text-xs text-gray-500 text-center leading-snug">No bookmarked pages. Bookmark a page from the … menu, or select pages here and tap the bookmark below.</div>
      )}

      <div
        ref={(el) => {
          listRef.current = el;
          if (el !== listEl) setListEl(el);
        }}
        className="flex-1 overflow-y-auto overscroll-contain px-3 py-3"
        style={{ touchAction: drag ? 'none' : 'pan-y' }}
      >
        {pages.map((pg, i) => {
          if (onlyMarked && !pg.bookmarked) return null;
          const setup = setups[i];
          const isSel = selected.has(pg.id);
          const isCur = i === p.currentPage;
          const moving = drag?.ids.has(pg.id);
          return (
            <React.Fragment key={pg.id}>
              {/* Keyed: without keys, the marker appearing in front of a page remounted (and fully repainted) its thumbnail. */}
              {drag && drag.to === i && <div key="drop" className="h-1 -mt-0.5 mb-1.5 rounded-full bg-blue-500" />}
              <div
                key="page"
                ref={(el) => {
                  if (el) items.current.set(pg.id, el);
                  else items.current.delete(pg.id);
                }}
                className={`relative flex flex-col items-center mb-3 transition-opacity ${moving ? 'opacity-40' : ''}`}
                onPointerDown={(e) => e.pointerType === 'mouse' && beginDrag(e, pg.id, false)}
                onPointerMove={moveDrag}
                onPointerUp={(e) => endDrag(e)}
                onPointerCancel={(e) => endDrag(e, true)}
                onClick={(e) => !suppressClick.current && onTap(e, i)}
              >
                <div
                  className={`relative rounded-md overflow-hidden shadow-sm cursor-pointer ${
                    isSel ? 'ring-[3px] ring-blue-500' : isCur ? 'ring-2 ring-blue-300 dark:ring-blue-800' : 'ring-1 ring-black/10 dark:ring-white/10'
                  }`}
                >
                  <LiveThumb surface={surface} box={setup} root={listEl} />
                  {pg.bookmarked && (
                    <svg className="absolute right-2 top-0 pointer-events-none" width="12" height="18" viewBox="0 0 22 34" aria-label="Bookmarked">
                      <path d="M0 0h22v34l-11-8-11 8z" fill="#E5484D" />
                    </svg>
                  )}
                  {(selectMode || count > 1) && (
                    <span className="absolute right-1 bottom-1 text-blue-600 bg-white rounded-full">
                      {isSel ? <CheckCircle2 className="w-5 h-5" /> : <Circle className="w-5 h-5 text-gray-400" />}
                    </span>
                  )}
                  <span
                    className="absolute left-0 top-0 p-1.5 text-gray-500 bg-white/80 dark:bg-black/40 dark:text-gray-300 rounded-br-lg cursor-grab"
                    style={{ touchAction: 'none' }}
                    title="Drag to move"
                    onPointerDown={(e) => beginDrag(e, pg.id, true)}
                    onPointerMove={moveDrag}
                    onPointerUp={(e) => endDrag(e)}
                    onPointerCancel={(e) => endDrag(e, true)}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <GripVertical className="w-4 h-4" />
                  </span>
                </div>
                <div className={`text-[11px] mt-1 tabular-nums ${isCur ? 'font-bold text-blue-600 dark:text-blue-400' : 'text-gray-500'}`}>
                  {i + 1}
                  {setup.orientation === 'landscape' || setup.size !== 'letter' ? <span className="font-normal text-gray-400"> · {setup.size.toUpperCase()}{setup.orientation === 'landscape' ? ' ↔' : ''}</span> : null}
                </div>
              </div>
            </React.Fragment>
          );
        })}
        {drag && drag.to === pages.length && <div className="h-1 rounded-full bg-blue-500 mb-3" />}
        <button
          onClick={p.onAddPage}
          className="w-full flex items-center justify-center gap-1.5 py-3 rounded-xl border-2 border-dashed border-gray-300 dark:border-gray-700 text-gray-500 text-xs font-semibold active:scale-95 transition"
        >
          <Plus className="w-4 h-4" /> Add page
        </button>
      </div>

      {paperOpen && count > 0 && (
        <div className="max-h-[55%] overflow-y-auto border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-ui-panel px-3 py-3">
          <div className="flex items-center mb-1">
            <div className="text-xs font-semibold text-gray-700 dark:text-gray-200 flex-1">
              Paper of {count > 1 ? `${count} pages` : `page ${pages.findIndex((pg) => selected.has(pg.id)) + 1}`}
            </div>
            <button onClick={() => setPaperOpen(false)} className="p-1 text-gray-400 rounded-lg">
              <X className="w-4 h-4" />
            </button>
          </div>
          <PaperPicker value={paperValue} onChange={(patch) => p.onSetup(selected, patch)} />
          <button
            disabled={!anyOwn}
            onClick={() => p.onSetup(selected, 'reset')}
            className="mt-3 w-full text-xs font-semibold py-2 rounded-xl border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 disabled:opacity-40"
            title="These pages follow the note's paper again (toolbar → Paper)"
          >
            Use the note's paper
          </button>
        </div>
      )}

      <div className="flex items-center justify-between px-1.5 py-1.5 border-t border-gray-200 dark:border-gray-800 text-gray-700 dark:text-gray-200 pb-[calc(6px+var(--sa-bottom))]">
        <button disabled={!count} onClick={() => setPaperOpen(!paperOpen)} className={`${BAR_BTN} ${paperOpen ? 'bg-blue-600 text-white' : ''}`} title="Paper of the selected pages">
          <Palette className="w-5 h-5" />
        </button>
        <button
          disabled={!count}
          onClick={() => p.onBookmark(selected, !pages.filter((pg) => selected.has(pg.id)).every((pg) => pg.bookmarked))}
          className={BAR_BTN}
          title={count && pages.filter((pg) => selected.has(pg.id)).every((pg) => pg.bookmarked) ? 'Remove bookmark' : 'Bookmark'}
        >
          <Bookmark className="w-4 h-4" fill={count && pages.filter((pg) => selected.has(pg.id)).every((pg) => pg.bookmarked) ? 'currentColor' : 'none'} />
        </button>
        <button disabled={!count} onClick={() => p.onDuplicate(selected)} className={BAR_BTN} title="Duplicate">
          <CopyPlus className="w-5 h-5" />
        </button>
        <button disabled={!count} onClick={() => p.onCopy(selected)} className={BAR_BTN} title="Copy pages">
          <ClipboardCopy className="w-5 h-5" />
        </button>
        <button disabled={!count} onClick={() => p.onCut(selected)} className={BAR_BTN} title="Cut pages">
          <Scissors className="w-5 h-5" />
        </button>
        <button disabled={!p.canPaste} onClick={p.onPaste} className={BAR_BTN} title="Paste pages after the selection">
          <ClipboardPaste className="w-5 h-5" />
        </button>
        <button disabled={!count} onClick={() => p.onDelete(selected)} className={BAR_BTN + ' text-red-500'} title="Delete pages">
          <Trash2 className="w-5 h-5" />
        </button>
      </div>

      {drag && (
        <div className="fixed z-[80] pointer-events-none px-2.5 py-1 rounded-full bg-blue-600 text-white text-xs font-semibold shadow-lg" style={{ left: drag.x + 14, top: drag.y - 12 }}>
          {dragLabel}
        </div>
      )}
    </aside>
  );
};
