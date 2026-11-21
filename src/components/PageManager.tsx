import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bookmark, CheckCircle2, Circle, ClipboardCopy, ClipboardPaste, CopyPlus,
  GripVertical, Palette, Plus, Scissors, Trash2, X, ChevronDown, Check,
} from 'lucide-react';
import { NoteDocument, NotePage } from '../types';
import { SetupPatch, hasOwnSetup } from '../editor/pageSetup';
import { SheetBox, SurfaceLayout, sheetView } from '../editor/sheets';
import { PageThumb } from './NoteThumb';
import { PaperPicker, PaperValues } from './PaperPicker';

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
  onBookmark: (ids: ReadonlySet<string>, on: boolean) => void;
  onAddPage: () => void;
  onClose: () => void;
}

const THUMB_W = 148;
const THUMB_MAX_H = 192;
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

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => (typeof window !== 'undefined' ? window.innerWidth < 768 : false));
  useEffect(() => {
    const onResize = () => setMobile(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return mobile;
}

const LiveThumb: React.FC<{ surface: NotePage; box: SheetBox; root: Element | null; maxW?: number }> = ({ surface, box, root, maxW = THUMB_W }) => {
  const page = useMemo(() => sheetView(surface, box), [surface, box]);
  const scale = Math.min(maxW / box.width, THUMB_MAX_H / box.height);
  return (
    <PageThumb
      page={page}
      width={box.width}
      height={box.height}
      paperStyle={box.paperStyle}
      paperColor={box.paperColor}
      patternColor={box.patternColor}
      pdf={box.pdf}
      scale={scale}
      root={root}
    />
  );
};

const BAR_BTN = 'min-w-[36px] min-h-[36px] h-9 w-9 flex items-center justify-center rounded-xl transition active:scale-90 disabled:opacity-30 disabled:active:scale-100 hover:bg-black/5 dark:hover:bg-white/10';

export const PageManager: React.FC<PageManagerProps> = (p) => {
  const { doc, layout, selected, setSelected } = p;
  const pages = doc.sheets;
  const isMobile = useIsMobile();
  const surface = useThrottled(doc.pages[0], THUMB_THROTTLE_MS);
  const [selectMode, setSelectMode] = useState(false);
  const [onlyMarked, setOnlyMarked] = useState(false);
  const [paperOpen, setPaperOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null);
  const items = useRef(new Map<string, HTMLDivElement>());
  const anchor = useRef<string | null>(null);

  const setups = layout.sheets;
  const count = selected.size;

  useEffect(() => {
    const id = pages[p.currentPage]?.id;
    const el = id ? items.current.get(id) : null;
    const list = listRef.current;
    if (!el || !list) return;
    const r = el.getBoundingClientRect(), l = list.getBoundingClientRect();
    if (r.top < l.top || r.bottom > l.bottom) list.scrollTop += r.top - l.top - l.height / 2 + r.height / 2;
  }, [p.currentPage]);

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
    if (isMobile) p.onClose();
  };

  // ---------------------------------------------------------------------------- drag & drop
  const [drag, setDrag] = useState<{ ids: ReadonlySet<string>; x: number; y: number; to: number } | null>(null);
  const dragRef = useRef<{ ids: ReadonlySet<string>; pointerId: number; startY: number; started: boolean; to: number; x: number; y: number } | null>(null);
  const autoScroll = useRef<number | null>(null);
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
      dragRef.current.started = true;
      dragRef.current.to = dropIndex(e.clientY);
      setDrag({ ids, x: e.clientX, y: e.clientY, to: dragRef.current.to });
      runAutoScroll(performance.now());
    }
  };

  const suppressClick = useRef(false);

  const moveDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    d.x = e.clientX;
    d.y = e.clientY;
    if (!d.started) {
      if (Math.abs(e.clientY - d.startY) < 6) return;
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      d.started = true;
      suppressClick.current = true;
      runAutoScroll(performance.now());
    }
    d.to = dropIndex(e.clientY);
    setDrag({ ids: d.ids, x: d.x, y: d.y, to: d.to });
  };

  const endDrag = (e: React.PointerEvent, cancel = false) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    stopAutoScroll();
    dragRef.current = null;
    const was = d.started;
    setDrag(null);
    if (was && !cancel && d.to >= 0) p.onMove(d.ids, d.to);
    setTimeout(() => {
      suppressClick.current = false;
    }, 50);
  };

  const anyOwn = (doc.sheets ?? []).some((s) => selected.has(s.id) && hasOwnSetup(s));
  const paperValue: PaperValues = {
    paperStyle: setups.find((s) => selected.has(s.id))?.paperStyle ?? doc.paperStyle,
    paperColor: setups.find((s) => selected.has(s.id))?.paperColor ?? doc.paperColor,
    patternColor: setups.find((s) => selected.has(s.id))?.patternColor ?? doc.patternColor ?? null,
    size: setups.find((s) => selected.has(s.id))?.size ?? 'letter',
    orientation: setups.find((s) => selected.has(s.id))?.orientation ?? 'portrait',
  };

  const dragLabel = drag ? (drag.ids.size > 1 ? `${drag.ids.size} pages` : `Page ${pages.findIndex((pg) => drag.ids.has(pg.id)) + 1}`) : '';

  const containerClasses = isMobile
    ? 'fixed bottom-0 left-0 right-0 max-h-[72vh] glass-pill rounded-t-3xl shadow-2xl z-50 flex flex-col pop-enter border-t border-gray-200/80 dark:border-white/10 text-gray-900 dark:text-gray-100'
    : 'h-[calc(100%-24px)] my-3 ml-3 w-64 glass-pill rounded-3xl flex flex-col shadow-2xl select-none text-gray-900 dark:text-gray-100 border border-gray-200/80 dark:border-white/10';

  return (
    <aside data-cutout-clear className={containerClasses} data-no-pan>
      {/* Mobile top pill drag handle */}
      {isMobile && (
        <div className="w-12 h-1.5 bg-gray-300 dark:bg-white/20 rounded-full mx-auto mt-2.5 mb-1" />
      )}

      {/* Header */}
      <div className="flex items-center gap-1.5 px-3 py-2.5 border-b border-gray-200/60 dark:border-white/10">
        <div className="font-semibold text-sm truncate flex-1">
          {count > 1 ? `${count} Selected` : `${pages.length} Page${pages.length === 1 ? '' : 's'}`}
        </div>
        {selectMode && (
          <button
            onClick={() => setSelected(count === pages.length ? new Set() : new Set(pages.map((pg) => pg.id)))}
            className="text-xs font-semibold text-blue-600 dark:text-blue-400 px-2 py-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/5"
          >
            {count === pages.length ? 'None' : 'All'}
          </button>
        )}
        <button
          onClick={() => {
            if (selectMode && count > 1) setSelected(new Set([pages[p.currentPage]?.id].filter(Boolean) as string[]));
            setSelectMode(!selectMode);
          }}
          className={`text-xs font-semibold px-2.5 py-1 rounded-xl transition ${
            selectMode ? 'bg-blue-600 text-white shadow-sm' : 'text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20'
          }`}
        >
          {selectMode ? 'Done' : 'Select'}
        </button>
        <button
          onClick={() => setOnlyMarked(!onlyMarked)}
          className={`p-1.5 rounded-xl transition ${
            onlyMarked ? 'bg-red-500 text-white shadow-sm' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-200'
          }`}
          title={onlyMarked ? 'Show all pages' : 'Show bookmarked pages only'}
        >
          <Bookmark className="w-4 h-4" strokeWidth={1.75} fill={onlyMarked ? 'currentColor' : 'none'} />
        </button>
        <button
          onClick={p.onClose}
          className="p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded-xl transition"
          title="Close"
        >
          <X className="w-4 h-4" strokeWidth={1.75} />
        </button>
      </div>

      {onlyMarked && !pages.some((pg) => pg.bookmarked) && (
        <div className="px-4 py-8 text-xs text-gray-400 text-center leading-snug">
          No bookmarked pages in this note.
        </div>
      )}

      {/* Pages List / Grid */}
      <div
        ref={(el) => {
          listRef.current = el;
          if (el !== listEl) setListEl(el);
        }}
        className={`flex-1 overflow-y-auto overscroll-contain p-3 no-scrollbar ${
          isMobile ? 'grid grid-cols-2 gap-3' : 'space-y-3'
        }`}
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
              {drag && drag.to === i && <div key="drop" className="h-1 -mt-0.5 mb-1.5 rounded-full bg-blue-500 col-span-2" />}
              <div
                key="page"
                ref={(el) => {
                  if (el) items.current.set(pg.id, el);
                  else items.current.delete(pg.id);
                }}
                className={`relative flex flex-col items-center transition-all ${moving ? 'opacity-40' : ''}`}
                onPointerDown={(e) => e.pointerType === 'mouse' && beginDrag(e, pg.id, false)}
                onPointerMove={moveDrag}
                onPointerUp={(e) => endDrag(e)}
                onPointerCancel={(e) => endDrag(e, true)}
                onClick={(e) => !suppressClick.current && onTap(e, i)}
              >
                <div
                  className={`relative rounded-xl overflow-hidden shadow-sm cursor-pointer transition-all hover:scale-[1.02] ${
                    isSel
                      ? 'ring-[3px] ring-blue-500 shadow-md shadow-blue-500/20'
                      : isCur
                      ? 'ring-2 ring-blue-400 dark:ring-blue-600'
                      : 'ring-1 ring-black/10 dark:ring-white/10'
                  }`}
                >
                  <LiveThumb surface={surface} box={setup} root={listEl} maxW={isMobile ? 140 : THUMB_W} />
                  {pg.bookmarked && (
                    <svg className="absolute right-2 top-0 pointer-events-none" width="12" height="18" viewBox="0 0 22 34">
                      <path d="M0 0h22v34l-11-8-11 8z" fill="#E5484D" />
                    </svg>
                  )}
                  {(selectMode || count > 1) && (
                    <span className="absolute right-1.5 bottom-1.5 text-blue-600 bg-white rounded-full shadow-sm">
                      {isSel ? <CheckCircle2 className="w-5 h-5" strokeWidth={1.75} /> : <Circle className="w-5 h-5 text-gray-400" strokeWidth={1.75} />}
                    </span>
                  )}
                  <span
                    className="absolute left-0 top-0 p-1.5 text-gray-500 bg-white/80 dark:bg-black/50 backdrop-blur rounded-br-xl cursor-grab active:cursor-grabbing"
                    style={{ touchAction: 'none' }}
                    title="Drag to reorder page"
                    onPointerDown={(e) => beginDrag(e, pg.id, true)}
                    onPointerMove={moveDrag}
                    onPointerUp={(e) => endDrag(e)}
                    onPointerCancel={(e) => endDrag(e, true)}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <GripVertical className="w-4 h-4" strokeWidth={1.75} />
                  </span>
                </div>
                <div className={`text-[11px] mt-1.5 tabular-nums ${isCur ? 'font-bold text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-gray-400'}`}>
                  {i + 1}
                  {setup.orientation === 'landscape' || setup.size !== 'letter' ? (
                    <span className="font-normal opacity-70"> · {setup.size.toUpperCase()}{setup.orientation === 'landscape' ? ' ↔' : ''}</span>
                  ) : null}
                </div>
              </div>
            </React.Fragment>
          );
        })}
        {drag && drag.to === pages.length && <div className="h-1 rounded-full bg-blue-500 mb-3 col-span-2" />}

        {/* Add page button */}
        <button
          onClick={p.onAddPage}
          className={`flex items-center justify-center gap-2 py-3 rounded-2xl border-2 border-dashed border-gray-300 dark:border-white/10 text-gray-500 hover:text-blue-600 hover:border-blue-500/50 text-xs font-semibold active:scale-98 transition ${
            isMobile ? 'col-span-2' : 'w-full'
          }`}
        >
          <Plus className="w-4 h-4" strokeWidth={1.75} /> Add Page
        </button>
      </div>

      {/* Paper Inspector Drawer inside Page Manager */}
      {paperOpen && count > 0 && (
        <div className="max-h-[50%] overflow-y-auto border-t border-gray-200/60 dark:border-white/10 bg-white/95 dark:bg-ui-panel/95 backdrop-blur-xl p-3 no-scrollbar pop-enter">
          <div className="flex items-center mb-2">
            <div className="text-xs font-semibold flex-1">
              Paper of {count > 1 ? `${count} pages` : `page ${pages.findIndex((pg) => selected.has(pg.id)) + 1}`}
            </div>
            <button onClick={() => setPaperOpen(false)} className="p-1 text-gray-400 hover:text-gray-600 rounded-lg">
              <X className="w-4 h-4" strokeWidth={1.75} />
            </button>
          </div>
          <PaperPicker value={paperValue} onChange={(patch) => p.onSetup(selected, patch)} />
          <button
            disabled={!anyOwn}
            onClick={() => p.onSetup(selected, 'reset')}
            className="mt-3 w-full text-xs font-semibold py-2 rounded-xl border border-gray-200 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-40 transition"
          >
            Reset to Note Paper
          </button>
        </div>
      )}

      {/* Bottom Actions Bar */}
      <div className="flex items-center justify-between px-2 py-2 border-t border-gray-200/60 dark:border-white/10 pb-[calc(8px+var(--sa-bottom))]">
        <button disabled={!count} onClick={() => setPaperOpen(!paperOpen)} className={`${BAR_BTN} ${paperOpen ? 'bg-blue-600 text-white shadow-sm' : ''}`} title="Paper of selected pages">
          <Palette className="w-4 h-4" strokeWidth={1.75} />
        </button>
        <button
          disabled={!count}
          onClick={() => p.onBookmark(selected, !pages.filter((pg) => selected.has(pg.id)).every((pg) => pg.bookmarked))}
          className={BAR_BTN}
          title={count && pages.filter((pg) => selected.has(pg.id)).every((pg) => pg.bookmarked) ? 'Remove bookmark' : 'Bookmark'}
        >
          <Bookmark className="w-4 h-4" strokeWidth={1.75} fill={count && pages.filter((pg) => selected.has(pg.id)).every((pg) => pg.bookmarked) ? 'currentColor' : 'none'} />
        </button>
        <button disabled={!count} onClick={() => p.onDuplicate(selected)} className={BAR_BTN} title="Duplicate">
          <CopyPlus className="w-4 h-4" strokeWidth={1.75} />
        </button>
        <button disabled={!count} onClick={() => p.onCopy(selected)} className={BAR_BTN} title="Copy pages">
          <ClipboardCopy className="w-4 h-4" strokeWidth={1.75} />
        </button>
        <button disabled={!count} onClick={() => p.onCut(selected)} className={BAR_BTN} title="Cut pages">
          <Scissors className="w-4 h-4" strokeWidth={1.75} />
        </button>
        <button disabled={!p.canPaste} onClick={p.onPaste} className={BAR_BTN} title="Paste pages after selection">
          <ClipboardPaste className="w-4 h-4" strokeWidth={1.75} />
        </button>
        <button disabled={!count} onClick={() => p.onDelete(selected)} className={`${BAR_BTN} text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20`} title="Delete pages">
          <Trash2 className="w-4 h-4" strokeWidth={1.75} />
        </button>
      </div>

      {drag && (
        <div className="fixed z-[80] pointer-events-none px-3 py-1.5 rounded-full bg-blue-600 text-white text-xs font-semibold shadow-xl" style={{ left: drag.x + 16, top: drag.y - 12 }}>
          {dragLabel}
        </div>
      )}
    </aside>
  );
};
