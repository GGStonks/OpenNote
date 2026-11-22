import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bookmark,
  CheckCircle2,
  Circle,
  ClipboardCopy,
  ClipboardPaste,
  CopyPlus,
  GripVertical,
  Palette,
  Plus,
  Scissors,
  Trash2,
  X,
  Filter,
} from 'lucide-react';
import { NoteDocument, NotePage } from '../../types';
import { SetupPatch, hasOwnSetup } from '../../editor/pageSetup';
import { SheetBox, SurfaceLayout, sheetView } from '../../editor/sheets';
import { PageThumb } from '../NoteThumb';
import { PaperPicker } from '../PaperPicker';
import { StudioButton } from './StudioButton';
import { StudioSheet } from './StudioSheet';

export interface PageStudioTrayProps {
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

const LiveThumb: React.FC<{ surface: NotePage; box: SheetBox; root: Element | null }> = ({
  surface,
  box,
  root,
}) => {
  const page = useMemo(() => sheetView(surface, box), [surface, box]);
  const scale = Math.min(THUMB_W / box.width, THUMB_MAX_H / box.height);
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

export const PageStudioTray: React.FC<PageStudioTrayProps> = (p) => {
  const { doc, layout, selected, setSelected } = p;
  const pages = doc.sheets;
  const surface = useThrottled(doc.pages[0], THUMB_THROTTLE_MS);
  const [selectMode, setSelectMode] = useState(false);
  const [onlyMarked, setOnlyMarked] = useState(false);
  const [paperModalOpen, setPaperModalOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null);
  const items = useRef(new Map<string, HTMLDivElement>());
  const anchor = useRef<string | null>(null);

  const setups = layout.sheets;
  const count = selected.size;

  // Scroll current page into view
  useEffect(() => {
    const id = pages[p.currentPage]?.id;
    const el = id ? items.current.get(id) : null;
    const list = listRef.current;
    if (!el || !list) return;
    const r = el.getBoundingClientRect();
    const l = list.getBoundingClientRect();
    if (r.top < l.top || r.bottom > l.bottom) {
      list.scrollTop += r.top - l.top - l.height / 2 + r.height / 2;
    }
  }, [p.currentPage]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Drag and drop reordering
  const [drag, setDrag] = useState<{ ids: ReadonlySet<string>; x: number; y: number; to: number } | null>(
    null
  );
  const dragRef = useRef<{
    ids: ReadonlySet<string>;
    pointerId: number;
    startY: number;
    started: boolean;
    to: number;
    x: number;
    y: number;
  } | null>(null);
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

  const startDrag = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    const ids = selected.has(id) ? selected : new Set([id]);
    if (!selected.has(id)) setSelected(ids);
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    dragRef.current = {
      ids,
      pointerId: e.pointerId,
      startY: e.clientY,
      started: false,
      to: dropIndex(e.clientY),
      x: e.clientX,
      y: e.clientY,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const st = dragRef.current;
    if (!st || st.pointerId !== e.pointerId) return;
    if (!st.started) {
      if (Math.abs(e.clientY - st.startY) < 6) return;
      st.started = true;
    }
    st.x = e.clientX;
    st.y = e.clientY;
    st.to = dropIndex(e.clientY);
    setDrag({ ids: st.ids, x: st.x, y: st.y, to: st.to });

    const list = listRef.current;
    if (!list) return;
    const r = list.getBoundingClientRect();
    const edge = 48;
    const up = Math.max(0, r.top + edge - e.clientY);
    const down = Math.max(0, e.clientY - (r.bottom - edge));
    if (up > 0 || down > 0) {
      const speed = up > 0 ? -up * 0.4 : down * 0.4;
      if (autoScroll.current === null) {
        autoScrollAt.current = performance.now();
        const step = () => {
          if (!dragRef.current?.started) {
            autoScroll.current = null;
            return;
          }
          const now = performance.now();
          const dt = Math.min(50, now - (autoScrollAt.current ?? now));
          autoScrollAt.current = now;
          list.scrollTop += speed * (dt / 16);
          dragRef.current.to = dropIndex(dragRef.current.y);
          setDrag((d) => (d ? { ...d, to: dragRef.current!.to } : null));
          autoScroll.current = requestAnimationFrame(step);
        };
        autoScroll.current = requestAnimationFrame(step);
      }
    } else if (autoScroll.current !== null) {
      cancelAnimationFrame(autoScroll.current);
      autoScroll.current = null;
    }
  };

  const endDrag = (e: React.PointerEvent) => {
    const st = dragRef.current;
    if (!st || st.pointerId !== e.pointerId) return;
    if (autoScroll.current !== null) {
      cancelAnimationFrame(autoScroll.current);
      autoScroll.current = null;
    }
    dragRef.current = null;
    setDrag(null);
    if (st.started) {
      p.onMove(st.ids, st.to);
    }
  };

  // Selected pages paper values
  const paperValues = useMemo(() => {
    const list = setups.filter((s) => selected.has(s.id));
    if (!list.length) return null;
    const same = <K extends keyof SheetBox>(k: K) => {
      const v = list[0][k];
      return list.every((s) => s[k] === v) ? v : null;
    };
    return {
      paperStyle: same('paperStyle'),
      paperColor: same('paperColor'),
      patternColor: same('patternColor'),
      size: same('size'),
      orientation: same('orientation'),
    };
  }, [setups, selected]);

  const allBookmarked = count > 0 && [...selected].every((id) => doc.sheets.find((s) => s.id === id)?.bookmarked);

  return (
    <aside
      data-cutout-clear
      className="w-72 sm:w-80 h-full studio-glass border-r border-black/5 dark:border-white/10 flex flex-col select-none shadow-2xl relative z-40"
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {/* Header */}
      <div className="h-14 pt-[var(--sa-top)] px-4 flex items-center justify-between border-b border-black/5 dark:border-white/10 flex-shrink-0">
        <div className="flex items-center gap-2">
          <h2 className="font-serif font-bold text-base text-gray-900 dark:text-gray-100">Pages</h2>
          <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-studio-accent-subtle text-studio-accent tabular-nums">
            {pages.length}
          </span>
        </div>

        <div className="flex items-center gap-1">
          <StudioButton
            size="icon-sm"
            variant="ghost"
            active={onlyMarked}
            onClick={() => setOnlyMarked(!onlyMarked)}
            title={onlyMarked ? 'Show all pages' : 'Show only bookmarked pages'}
          >
            <Bookmark className="w-4 h-4" fill={onlyMarked ? 'currentColor' : 'none'} />
          </StudioButton>

          <StudioButton
            size="icon-sm"
            variant="ghost"
            active={selectMode}
            onClick={() => setSelectMode(!selectMode)}
            title="Toggle multi-select"
          >
            <CheckCircle2 className="w-4 h-4" />
          </StudioButton>

          <StudioButton
            size="icon-sm"
            variant="ghost"
            onClick={p.onClose}
            title="Close tray"
          >
            <X className="w-4 h-4" />
          </StudioButton>
        </div>
      </div>

      {/* Pages List */}
      <div
        ref={(el) => {
          listRef.current = el;
          setListEl(el);
        }}
        className="flex-1 overflow-y-auto p-4 space-y-4 no-scrollbar"
        style={{ touchAction: 'pan-y' }}
      >
        {pages.map((s, index) => {
          if (onlyMarked && !s.bookmarked) return null;
          const isCurrent = index === p.currentPage;
          const isSelected = selected.has(s.id);
          const box = setups[index];

          return (
            <div
              key={s.id}
              ref={(el) => {
                if (el) items.current.set(s.id, el);
                else items.current.delete(s.id);
              }}
              onClick={(e) => onTap(e, index)}
              onPointerDown={(e) => startDrag(e, s.id)}
              className={`group relative rounded-2xl p-2.5 transition-all duration-150 cursor-pointer flex items-center gap-3 ${
                isSelected
                  ? 'bg-studio-accent-subtle ring-2 ring-studio-accent shadow-md'
                  : isCurrent
                  ? 'bg-black/5 dark:bg-white/5 ring-1 ring-studio-accent/40'
                  : 'hover:bg-black/5 dark:hover:bg-white/5'
              }`}
            >
              <div className="text-gray-400 group-hover:text-gray-600 dark:group-hover:text-gray-200 cursor-grab active:cursor-grabbing p-1">
                <GripVertical className="w-4 h-4" />
              </div>

              {/* Thumbnail Container */}
              <div
                className="relative rounded-xl overflow-hidden border border-black/10 dark:border-white/10 shadow-sm flex-shrink-0"
                style={{ width: THUMB_W, height: Math.min(THUMB_MAX_H, (THUMB_W * box.height) / box.width) }}
              >
                <LiveThumb surface={surface} box={box} root={listEl} />
                {s.bookmarked && (
                  <Bookmark
                    className="absolute top-1.5 right-1.5 w-4 h-4 text-studio-accent drop-shadow"
                    fill="currentColor"
                  />
                )}
              </div>

              {/* Index & details */}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold text-gray-800 dark:text-gray-200 tabular-nums">
                  Page {index + 1}
                </div>
                {hasOwnSetup(s) && (
                  <div className="text-[10px] text-studio-accent font-medium mt-0.5">Custom paper</div>
                )}
              </div>
            </div>
          );
        })}

        {/* Add Page Button */}
        <StudioButton
          variant="glass"
          size="md"
          onClick={p.onAddPage}
          className="w-full flex items-center justify-center gap-2 mt-4"
        >
          <Plus className="w-4 h-4" />
          <span>Add Blank Page</span>
        </StudioButton>
      </div>

      {/* Selected Pages Actions Footer */}
      {count > 0 && (
        <div className="p-3 bg-white/95 dark:bg-ui-panel/95 border-t border-black/5 dark:border-white/10 flex items-center justify-between gap-1 shadow-lg flex-shrink-0">
          <StudioButton
            size="icon-sm"
            variant="ghost"
            onClick={() => setPaperModalOpen(true)}
            title="Paper for selected pages"
          >
            <Palette className="w-4 h-4 text-studio-accent" />
          </StudioButton>

          <StudioButton
            size="icon-sm"
            variant="ghost"
            onClick={() => p.onBookmark(selected, !allBookmarked)}
            title="Bookmark selected pages"
          >
            <Bookmark className="w-4 h-4" fill={allBookmarked ? 'currentColor' : 'none'} />
          </StudioButton>

          <StudioButton
            size="icon-sm"
            variant="ghost"
            onClick={() => p.onDuplicate(selected)}
            title="Duplicate selected pages"
          >
            <CopyPlus className="w-4 h-4" />
          </StudioButton>

          <StudioButton
            size="icon-sm"
            variant="ghost"
            onClick={() => p.onCopy(selected)}
            title="Copy selected pages"
          >
            <ClipboardCopy className="w-4 h-4" />
          </StudioButton>

          <StudioButton
            size="icon-sm"
            variant="ghost"
            onClick={() => p.onCut(selected)}
            title="Cut selected pages"
          >
            <Scissors className="w-4 h-4" />
          </StudioButton>

          {p.canPaste && (
            <StudioButton
              size="icon-sm"
              variant="ghost"
              onClick={p.onPaste}
              title="Paste pages after selection"
            >
              <ClipboardPaste className="w-4 h-4" />
            </StudioButton>
          )}

          <StudioButton
            size="icon-sm"
            variant="ghost"
            onClick={() => p.onDelete(selected)}
            className="text-red-500 hover:text-red-600"
            title="Delete selected pages"
          >
            <Trash2 className="w-4 h-4" />
          </StudioButton>
        </div>
      )}

      {/* Paper styling modal for selected pages */}
      {paperValues && (
        <StudioSheet
          isOpen={paperModalOpen}
          onClose={() => setPaperModalOpen(false)}
          title={`Paper for ${count} page${count === 1 ? '' : 's'}`}
        >
          <PaperPicker
            value={paperValues}
            onChange={(patch) => {
              p.onSetup(selected, patch);
            }}
          />
          <div className="mt-4 pt-3 border-t border-black/5 dark:border-white/5 flex justify-end">
            <StudioButton
              size="sm"
              variant="secondary"
              onClick={() => {
                p.onSetup(selected, 'reset');
                setPaperModalOpen(false);
              }}
            >
              Reset to Note Paper
            </StudioButton>
          </div>
        </StudioSheet>
      )}
    </aside>
  );
};
