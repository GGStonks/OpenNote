import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Undo2, Redo2, PenLine, Highlighter, Eraser, Lasso, Type, Hand, Share, Settings, ChevronLeft, Plus,
  LayoutTemplate, Sparkles, Image as ImageIcon, Sigma, Shapes, Trash2, Copy, MoreHorizontal,
  Spline, Slash, Square, Circle, Dot, Pointer, PointerOff, ClipboardPaste, PanelLeft, FileText,
  Bookmark, Cast, Eye, Search, MoveUpRight, Sliders, Check, Wand2
} from 'lucide-react';
import { EraserMode, FillType, PenStyle, ShapeMode, ToolType, LineStyle } from '../types';
import { LINE_STYLES, LineStylePicker } from './LineStyles';
import { SetupPatch } from '../editor/pageSetup';
import { PaperPicker, PaperValues } from './PaperPicker';
import { ToolSettings } from './CanvasPage';
import { ColorPicker } from './ColorPicker';
import { OnScreen } from './onScreen';
import { useBack } from '../services/backStack';
import { MirrorPopover } from './MirrorPopover';

const PEN_COLORS = ['#111827', '#2563EB', '#DC2626', '#16A34A', '#EA580C', '#9333EA', '#4B5563', '#0D9488', '#FFFFFF'];
const HIGHLIGHTER_COLORS = ['#FDE047', '#86EFAC', '#93C5FD', '#F9A8D4', '#C4B5FD', '#FDBA74'];

export const FILL_OPTIONS: { id: FillType; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'solid', label: 'Solid' },
  { id: 'northEast', label: '////' },
  { id: 'northWest', label: '\\\\' },
  { id: 'crosshatch', label: 'Cross' },
  { id: 'hole', label: 'Hole' },
];

const SHAPE_MODES: { id: ShapeMode; label: string; icon: React.ReactNode }[] = [
  { id: 'curve', label: 'Curve', icon: <Spline className="w-5 h-5" strokeWidth={1.75} /> },
  { id: 'line', label: 'Line', icon: <Slash className="w-5 h-5" strokeWidth={1.75} /> },
  { id: 'rectangle', label: 'Rectangle', icon: <Square className="w-5 h-5" strokeWidth={1.75} /> },
  { id: 'ellipse', label: 'Ellipse', icon: <Circle className="w-5 h-5" strokeWidth={1.75} /> },
  { id: 'point', label: 'Point', icon: <Dot className="w-5 h-5" strokeWidth={1.75} /> },
];

/** Live interactive nib preview */
export const NibPreview: React.FC<{
  color: string;
  width: number;
  opacity?: number;
  style?: LineStyle;
}> = ({ color, width, opacity = 1, style = 'solid' }) => {
  const dashArray =
    style === 'dashed' ? '10 6' :
    style === 'dotted' ? '3 5' :
    style === 'dashdot' ? '12 5 3 5' :
    style === 'longdash' ? '20 7' : undefined;

  return (
    <div className="w-full h-11 rounded-2xl bg-gray-100/80 dark:bg-white/5 border border-gray-200/50 dark:border-white/5 flex items-center justify-center px-4 overflow-hidden mb-3">
      <svg className="w-full h-8 overflow-visible" viewBox="0 0 240 32">
        <path
          d="M 20 16 Q 80 4, 120 16 T 220 16"
          fill="none"
          stroke={color.toUpperCase() === '#FFFFFF' ? '#9CA3AF' : color}
          strokeWidth={Math.max(1, Math.min(24, width))}
          strokeOpacity={opacity}
          strokeLinecap="round"
          strokeDasharray={dashArray}
        />
      </svg>
    </div>
  );
};

export const FillSwatch: React.FC<{ fill: FillType; color: string }> = ({ fill, color }) => {
  const id = `sw-${fill}`;
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" className="flex-shrink-0">
      <defs>
        <clipPath id={id}>
          <rect x="2" y="2" width="16" height="16" rx="4" />
        </clipPath>
      </defs>
      {fill === 'solid' && <rect x="2" y="2" width="16" height="16" rx="4" fill={color} fillOpacity="0.35" />}
      {(fill === 'northEast' || fill === 'northWest' || fill === 'crosshatch') && (
        <g clipPath={`url(#${id})`} stroke={color} strokeWidth="1.2" strokeOpacity="0.8">
          {[-16, -10, -4, 2, 8, 14, 20].map((x) => (
            <g key={x}>
              {fill !== 'northWest' && <line x1={x} y1="20" x2={x + 20} y2="0" />}
              {fill !== 'northEast' && <line x1={x} y1="0" x2={x + 20} y2="20" />}
            </g>
          ))}
        </g>
      )}
      <rect x="2" y="2" width="16" height="16" rx="4" fill="none" stroke={color} strokeWidth="1.4" strokeDasharray={fill === 'hole' ? '2.5 2' : undefined} />
      {fill === 'none' && <line x1="5" y1="15" x2="15" y2="5" stroke={color} strokeWidth="1.2" />}
    </svg>
  );
};

export interface ToolbarProps {
  tools: ToolSettings;
  setTools: (patch: Partial<ToolSettings>) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  title: string;
  setTitle: (t: string) => void;
  paper: PaperValues;
  setPaper: (patch: SetupPatch) => void;
  pagesOpen: boolean;
  onTogglePages: () => void;
  onBack: () => void;
  onConvertPage: () => void;
  onExport: () => void;
  onSettings: () => void;
  onDuplicatePage: () => void;
  pageBookmarked: boolean;
  onToggleBookmark: () => void;
  onDeletePage: () => void;
  onInsertLatex: () => void;
  onInsertImage: (file: File) => void;
  onInsertPdf: (file: File) => void;
  onPaste?: () => void;
  currentPage: number;
  totalPages: number;
  audioSlot: React.ReactNode;
  onOpenMirror?: () => void;
  isMirrorActive?: boolean;
  onOpenCommandPalette?: () => void;
  zenMode?: boolean;
  onToggleZen?: () => void;
  dockPosition?: 'bottom' | 'left' | 'right';
  onSetDockPosition?: (pos: 'bottom' | 'left' | 'right') => void;
  cleanPresentation?: boolean;
  onToggleCleanPresentation?: (clean: boolean) => void;
  adaptDarkPaper?: boolean;
  onToggleAdaptDarkPaper?: (adapt: boolean) => void;
  /** Changes when something else (the command palette) asks for the paper panel. */
  openPaperSignal?: number;
}

/**
 * The tool strip scrolls when the screen is narrower than its tools (phones upright): its ends fade
 * where more tools lie beyond them, and the chosen tool is scrolled into view.
 */
function useScrollStrip(vertical: boolean, activeKey: string) {
  const ref = useRef<HTMLDivElement>(null);
  const [ends, setEnds] = useState({ start: false, end: false });
  const measure = () => {
    const el = ref.current;
    if (!el) return;
    const pos = vertical ? el.scrollTop : el.scrollLeft;
    const max = vertical ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
    const next = { start: pos > 1, end: pos < max - 1 };
    setEnds((e) => (e.start === next.start && e.end === next.end ? e : next));
  };
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [vertical]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = ref.current;
    const btn = el?.querySelector<HTMLElement>('[data-active]');
    if (!el || !btn) return;
    if (vertical) {
      const top = btn.offsetTop - el.offsetTop, bottom = top + btn.offsetHeight;
      if (top < el.scrollTop) el.scrollTop = top - 8;
      else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight + 8;
    } else {
      const left = btn.offsetLeft - el.offsetLeft, right = left + btn.offsetWidth;
      if (left < el.scrollLeft) el.scrollLeft = left - 8;
      else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth + 8;
    }
    measure();
  }, [activeKey, vertical]); // eslint-disable-line react-hooks/exhaustive-deps
  const dir = vertical ? 'to bottom' : 'to right';
  const mask = ends.start || ends.end
    ? `linear-gradient(${dir}, ${ends.start ? 'transparent, #000 28px' : '#000, #000'}, ${ends.end ? '#000 calc(100% - 28px), transparent' : '#000'})`
    : undefined;
  return { ref, onScroll: measure, style: mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined };
}

function usePopover() {
  const [open, setOpen] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useBack(!!open, () => setOpen(null));
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(null);
    };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [open]);
  return { open, setOpen, ref };
}

const ToolDockButton: React.FC<{
  active: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ active, title, onClick, children }) => (
  <button
    onClick={onClick}
    title={title}
    aria-label={title}
    aria-pressed={active}
    data-active={active || undefined}
    className={`flex-shrink-0 min-w-[40px] min-h-[40px] h-10 w-10 sm:h-11 sm:w-11 rounded-2xl flex items-center justify-center relative transition-[background-color,color,box-shadow,transform] duration-150 active:scale-95 ${
      active
        ? 'bg-blue-600 text-white shadow-md shadow-blue-600/30'
        : 'text-gray-700 dark:text-gray-200 hover:bg-black/5 dark:hover:bg-white/10'
    }`}
  >
    {children}
  </button>
);

const DockPopover: React.FC<{
  position?: 'bottom' | 'left' | 'right';
  children: React.ReactNode;
}> = ({ position = 'bottom', children }) => {
  const positionClass =
    position === 'left'
      ? 'left-full top-0 ml-3'
      : position === 'right'
      ? 'right-full top-0 mr-3'
      : 'bottom-full left-1/2 -translate-x-1/2 mb-3';

  return (
    <OnScreen
      data-ui-panel
      data-no-pan
      data-viewport-hole
      className={`absolute z-50 glass-pill rounded-3xl p-4 shadow-2xl w-80 max-w-[calc(100vw-24px)] max-h-[calc(100dvh-120px)] overscroll-contain overflow-y-auto no-scrollbar pop-enter text-gray-900 dark:text-gray-100 ${positionClass}`}
    >
      {children}
    </OnScreen>
  );
};

const HeaderPopover: React.FC<{
  align?: 'left' | 'right';
  children: React.ReactNode;
}> = ({ align = 'right', children }) => (
  <OnScreen
    data-ui-panel
    data-no-pan
    data-viewport-hole
    className={`absolute top-full mt-2 z-50 glass-pill rounded-3xl p-4 shadow-2xl w-80 max-w-[calc(100vw-24px)] max-h-[calc(100dvh-90px)] overscroll-contain overflow-y-auto no-scrollbar pop-enter text-gray-900 dark:text-gray-100 ${
      align === 'right' ? 'right-0' : 'left-0'
    }`}
  >
    {children}
  </OnScreen>
);

const Label: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-2 mt-1.5">{children}</div>
);

const LevelControl: React.FC<{
  value: number;
  min: number;
  max: number;
  log?: boolean;
  onChange: (v: number) => void;
  label: string;
}> = ({ value, min, max, log = true, onChange, label }) => {
  const toLevel = (v: number) =>
    Math.round(1 + 99 * (log ? Math.log(Math.max(min, Math.min(max, v)) / min) / Math.log(max / min) : (Math.max(min, Math.min(max, v)) - min) / (max - min)));
  const fromLevel = (l: number) => (log ? min * Math.pow(max / min, (l - 1) / 99) : min + ((l - 1) / 99) * (max - min));
  const level = toLevel(value);
  const [draft, setDraft] = useState(String(level));
  useEffect(() => setDraft(String(level)), [level]);
  const set = (l: number) => onChange(fromLevel(Math.max(1, Math.min(100, Math.round(l)))));

  return (
    <div className="flex items-center gap-3 mb-2">
      <input
        type="range"
        min={1}
        max={100}
        step={1}
        value={level}
        onChange={(e) => set(+e.target.value)}
        className="flex-1 accent-blue-600"
        aria-label={label}
      />
      <input
        type="number"
        inputMode="numeric"
        min={1}
        max={100}
        value={draft}
        aria-label={`${label} (1-100)`}
        onChange={(e) => {
          setDraft(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value !== '' && Number.isFinite(n) && n >= 1 && n <= 100) set(n);
        }}
        onBlur={() => setDraft(String(level))}
        className="w-16 text-center text-sm rounded-xl border border-gray-200 dark:border-white/10 bg-white/80 dark:bg-ui-high py-1.5 tabular-nums text-gray-900 dark:text-gray-100"
      />
    </div>
  );
};

const PEN_WIDTH_RANGE = { min: 0.5, max: 24 };
const HIGHLIGHTER_WIDTH_RANGE = { min: 1, max: 20 };
const ERASER_SIZE_RANGE = { min: 2, max: 100 };

export const Toolbar: React.FC<ToolbarProps> = (p) => {
  const { tools, setTools } = p;
  const dockPop = usePopover();
  const headerPop = usePopover();
  const fileRef = useRef<HTMLInputElement>(null);
  const pdfRef = useRef<HTMLInputElement>(null);

  const [smartPenTab, setSmartPenTab] = useState<'shape' | 'style'>('shape');
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const dockPos = p.dockPosition ?? 'bottom';
  useEffect(() => {
    if (p.openPaperSignal) headerPop.setOpen('paper');
  }, [p.openPaperSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectTool = (tool: ToolType, menu?: string) => {
    if (tools.tool === tool && menu) {
      dockPop.setOpen(dockPop.open === menu ? null : menu);
    } else {
      setTools({ tool });
      dockPop.setOpen(null);
    }
  };

  const currentStrokeColor =
    tools.tool === 'highlighter' ? tools.highlighterColor :
    tools.tool === 'shape' ? tools.shapeColor : tools.penColor;

  const currentStrokeWidth =
    tools.tool === 'highlighter' ? tools.highlighterWidth :
    tools.tool === 'shape' ? tools.shapeWidth : tools.penWidth;

  const currentLineStyle =
    tools.tool === 'shape' ? tools.shapeLineStyle : tools.penLineStyle;

  // 1-tap width presets
  const widthPresets =
    tools.tool === 'highlighter'
      ? [3, 8, 16]
      : [2, 5, 12];

  const setWidthPreset = (w: number) => {
    if (tools.tool === 'highlighter') setTools({ highlighterWidth: w });
    else if (tools.tool === 'shape') setTools({ shapeWidth: w });
    else setTools({ penWidth: w });
  };

  // 1-tap favorite swatches
  const quickColors =
    tools.tool === 'highlighter'
      ? HIGHLIGHTER_COLORS.slice(0, 4)
      : ['#111827', '#2563EB', '#DC2626', '#16A34A'];

  const setQuickColor = (c: string) => {
    if (tools.tool === 'highlighter') setTools({ highlighterColor: c });
    else if (tools.tool === 'shape') setTools({ shapeColor: c });
    else setTools({ penColor: c });
  };

  const vertical = dockPos !== 'bottom';
  const dockOrientationClass =
    dockPos === 'left'
      ? 'fixed left-[calc(0.75rem+var(--sa-left))] top-1/2 -translate-y-1/2 z-40 max-h-[calc(100dvh-9rem-var(--sa-top)-var(--sa-bottom))]'
      : dockPos === 'right'
      ? 'fixed right-[calc(0.75rem+var(--sa-right))] top-1/2 -translate-y-1/2 z-40 max-h-[calc(100dvh-9rem-var(--sa-top)-var(--sa-bottom))]'
      : 'fixed bottom-[calc(1rem+var(--sa-bottom))] left-1/2 -translate-x-1/2 z-40 max-w-[calc(100vw-1.5rem-var(--sa-left)-var(--sa-right))]';
  const strip = useScrollStrip(vertical, tools.tool);

  const barBtn = 'min-w-[40px] min-h-[40px] h-10 w-10 sm:h-9 sm:w-9 sm:min-w-[36px] sm:min-h-[36px] flex flex-shrink-0 items-center justify-center rounded-xl active:scale-95 transition';

  return (
    <>
      {/* =========================================================================
          TOP FLOATING GLASS ISLANDS (Zero Full-Width Opaque Header!)
          ========================================================================= */}
      <div data-editor-bar className="fixed top-[calc(0.75rem+var(--sa-top))] left-[calc(0.75rem+var(--sa-left))] right-[calc(0.75rem+var(--sa-right))] z-30 pointer-events-none flex items-center justify-between gap-2 sm:gap-3 select-none">
        {/* Top-Left Island: shrinks first (the title gives up its room). */}
        <div data-no-pan data-viewport-hole className="glass-pill rounded-2xl px-1.5 py-1 sm:px-2 sm:py-1.5 flex items-center gap-1 sm:gap-1.5 pointer-events-auto min-w-0 flex-1 sm:flex-initial sm:max-w-md">
          <button
            onClick={p.onBack}
            className={`${barBtn} text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20`}
            title="Back to notes"
            aria-label="Back to notes"
          >
            <ChevronLeft className="w-5 h-5" strokeWidth={1.75} />
          </button>

          <button
            onClick={p.onTogglePages}
            className={`${barBtn} !hidden sm:!flex ${
              p.pagesOpen ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-700 dark:text-gray-200 hover:bg-black/5 dark:hover:bg-white/10'
            }`}
            title="Pages"
            aria-label="Pages"
            aria-pressed={p.pagesOpen}
          >
            <PanelLeft className="w-5 h-5" strokeWidth={1.75} />
          </button>

          <input
            value={p.title}
            onChange={(e) => p.setTitle(e.target.value)}
            className="hidden min-[300px]:block font-semibold text-sm sm:text-base bg-transparent rounded-lg px-1.5 sm:px-2 h-10 sm:h-9 min-w-0 flex-1 sm:flex-none sm:w-48 text-gray-900 dark:text-gray-100 truncate focus:outline-none focus:ring-1 focus:ring-blue-500 hover:bg-black/5 dark:hover:bg-white/5 transition select-text"
            title="Rename note"
            aria-label="Note title"
          />

          <button
            onClick={p.onTogglePages}
            className={`h-10 sm:h-9 px-2 rounded-xl text-xs font-semibold tabular-nums flex-shrink-0 whitespace-nowrap transition ${
              p.pagesOpen ? 'bg-blue-600 text-white sm:bg-transparent sm:text-gray-500 sm:dark:text-gray-400' : 'text-gray-500 dark:text-gray-400 hover:bg-black/5 dark:hover:bg-white/10'
            }`}
            title="Pages"
            aria-label={`Page ${p.currentPage} of ${p.totalPages}: show pages`}
          >
            {p.currentPage} / {p.totalPages}
          </button>
        </div>

        {/* Top-Right Island */}
        <div ref={headerPop.ref} data-no-pan data-viewport-hole className="glass-pill rounded-2xl px-1.5 py-1 sm:px-2 sm:py-1.5 flex items-center gap-0.5 sm:gap-1 pointer-events-auto relative flex-shrink-0">
          <button
            onClick={p.onUndo}
            disabled={!p.canUndo}
            className={`${barBtn} text-gray-700 dark:text-gray-200 hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-30`}
            title="Undo"
            aria-label="Undo"
          >
            <Undo2 className="w-5 h-5" strokeWidth={1.75} />
          </button>

          <button
            onClick={p.onRedo}
            disabled={!p.canRedo}
            className={`${barBtn} !hidden min-[340px]:!flex text-gray-700 dark:text-gray-200 hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-30`}
            title="Redo"
            aria-label="Redo"
          >
            <Redo2 className="w-5 h-5" strokeWidth={1.75} />
          </button>

          <div className="h-5 w-px bg-gray-300 dark:bg-white/10 mx-0.5 hidden sm:block" />

          {/* Audio slot */}
          <div className="flex items-center">
            {p.audioSlot}
          </div>

          {/* AI Assist button */}
          <button
            onClick={() => headerPop.setOpen(headerPop.open === 'ai' ? null : 'ai')}
            className={`min-w-[36px] min-h-[36px] h-9 px-2.5 rounded-xl hidden sm:flex items-center gap-1.5 text-xs font-semibold active:scale-95 transition ${
              headerPop.open === 'ai'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20'
            }`}
            title="AI Assist (Qwen3-VL)"
          >
            <Sparkles className="w-4 h-4" strokeWidth={1.75} />
            <span className="hidden md:inline">AI Assist</span>
          </button>

          {/* Cast button with live indicator */}
          <button
            onClick={() => headerPop.setOpen(headerPop.open === 'mirror' ? null : 'mirror')}
            className={`min-w-[36px] min-h-[36px] h-9 w-9 hidden sm:flex items-center justify-center rounded-xl relative active:scale-95 transition ${
              headerPop.open === 'mirror' || p.isMirrorActive
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-gray-700 dark:text-gray-200 hover:bg-black/5 dark:hover:bg-white/10'
            }`}
            title="Cast to PC"
          >
            <Cast className="w-5 h-5" strokeWidth={1.75} />
            {p.isMirrorActive && (
              <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-emerald-400 ring-2 ring-white dark:ring-black animate-pulse" />
            )}
          </button>

          {/* More menu */}
          <button
            onClick={() => headerPop.setOpen(headerPop.open === 'more' ? null : 'more')}
            className={`${barBtn} relative ${headerPop.open === 'more' ? 'bg-black/5 dark:bg-white/10' : ''} text-gray-700 dark:text-gray-200 hover:bg-black/5 dark:hover:bg-white/10`}
            title="More actions"
            aria-label="More actions"
            aria-expanded={headerPop.open === 'more'}
          >
            <MoreHorizontal className="w-5 h-5" strokeWidth={1.75} />
            {p.isMirrorActive && (
              <span className="sm:hidden absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-emerald-400 ring-2 ring-white dark:ring-black" />
            )}
          </button>

          {/* AI Assist Popover */}
          {headerPop.open === 'ai' && (
            <HeaderPopover align="right">
              <div className="flex flex-col gap-1 text-sm">
                <div className="px-2 py-1 text-[11px] font-bold text-gray-400 uppercase tracking-wider">
                  Qwen3-VL Multimodal Assist
                </div>
                <button
                  onClick={() => { headerPop.setOpen(null); p.onConvertPage(); }}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-black/5 dark:hover:bg-white/10 text-left font-medium"
                >
                  <Sparkles className="w-5 h-5 text-blue-500" strokeWidth={1.75} />
                  <div>
                    <div className="text-gray-900 dark:text-gray-100">Transcribe Page → LaTeX</div>
                    <div className="text-[11px] text-gray-400">Transcribe handwriting and equations</div>
                  </div>
                </button>
                <button
                  onClick={() => { headerPop.setOpen(null); p.onInsertLatex(); }}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-black/5 dark:hover:bg-white/10 text-left font-medium"
                >
                  <Sigma className="w-5 h-5 text-indigo-500" strokeWidth={1.75} />
                  <div>
                    <div className="text-gray-900 dark:text-gray-100">Insert LaTeX / TikZ Block</div>
                    <div className="text-[11px] text-gray-400">Manual equation or vector diagram</div>
                  </div>
                </button>
              </div>
            </HeaderPopover>
          )}

          {/* Mirror Popover */}
          {headerPop.open === 'mirror' && (
            <HeaderPopover align="right">
              <MirrorPopover
                onClose={() => headerPop.setOpen(null)}
                cleanPresentation={p.cleanPresentation ?? false}
                onToggleCleanPresentation={p.onToggleCleanPresentation ?? (() => undefined)}
              />
            </HeaderPopover>
          )}

          {/* More Actions Popover */}
          {headerPop.open === 'more' && (
            <HeaderPopover align="right">
              <div className="flex flex-col text-sm text-gray-800 dark:text-gray-200">
                {/* Phones: the bar's AI and Cast buttons are here (and Redo on the narrowest). */}
                <div className="sm:hidden flex flex-col">
                  <button
                    onClick={() => { headerPop.setOpen(null); p.onRedo(); }}
                    disabled={!p.canRedo}
                    className="min-[340px]:hidden flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-black/5 dark:hover:bg-white/10 text-left disabled:opacity-40"
                  >
                    <Redo2 className="w-5 h-5" strokeWidth={1.75} /> Redo
                  </button>
                  <button
                    onClick={() => { headerPop.setOpen(null); p.onConvertPage(); }}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-black/5 dark:hover:bg-white/10 text-left"
                  >
                    <Sparkles className="w-5 h-5 text-blue-500" strokeWidth={1.75} /> Transcribe Page → LaTeX
                  </button>
                  <button
                    onClick={() => { headerPop.setOpen(null); p.onInsertLatex(); }}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-black/5 dark:hover:bg-white/10 text-left"
                  >
                    <Sigma className="w-5 h-5 text-indigo-500" strokeWidth={1.75} /> Insert LaTeX / TikZ Block
                  </button>
                  <button
                    onClick={() => headerPop.setOpen('mirror')}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-black/5 dark:hover:bg-white/10 text-left"
                  >
                    <Cast className="w-5 h-5" strokeWidth={1.75} />
                    <span className="flex-1">Cast to PC</span>
                    {p.isMirrorActive && <span className="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">Live</span>}
                  </button>
                  <div className="h-px bg-gray-200 dark:bg-white/10 my-1" />
                </div>
                <button
                  onClick={() => headerPop.setOpen('paper')}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-black/5 dark:hover:bg-white/10 text-left"
                >
                  <LayoutTemplate className="w-5 h-5" strokeWidth={1.75} /> Paper Template & Pattern
                </button>
                <button
                  onClick={() => { headerPop.setOpen(null); p.onExport(); }}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-black/5 dark:hover:bg-white/10 text-left"
                >
                  <Share className="w-5 h-5" strokeWidth={1.75} /> Export Note (PDF / Note)
                </button>
                {p.onOpenCommandPalette && (
                  <button
                    onClick={() => { headerPop.setOpen(null); p.onOpenCommandPalette?.(); }}
                    className="flex items-center justify-between px-3 py-2.5 rounded-xl hover:bg-black/5 dark:hover:bg-white/10 text-left"
                  >
                    <span className="flex items-center gap-3">
                      <Search className="w-5 h-5" strokeWidth={1.75} /> Command Palette
                    </span>
                    <kbd className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-black/5 dark:bg-white/10 text-gray-400">⌘K</kbd>
                  </button>
                )}
                {p.onToggleZen && (
                  <button
                    onClick={() => { headerPop.setOpen(null); p.onToggleZen?.(); }}
                    className="flex items-center justify-between px-3 py-2.5 rounded-xl hover:bg-black/5 dark:hover:bg-white/10 text-left"
                  >
                    <span className="flex items-center gap-3">
                      <Eye className="w-5 h-5" strokeWidth={1.75} /> {p.zenMode ? 'Exit Zen Mode' : 'Zen Focus Mode'}
                    </span>
                    <kbd className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-black/5 dark:bg-white/10 text-gray-400">Tab</kbd>
                  </button>
                )}
                <div className="h-px bg-gray-200 dark:bg-white/10 my-1" />
                <button
                  onClick={() => fileRef.current?.click()}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-black/5 dark:hover:bg-white/10 text-left"
                >
                  <ImageIcon className="w-5 h-5" strokeWidth={1.75} /> Insert Image
                </button>
                <button
                  onClick={() => pdfRef.current?.click()}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-black/5 dark:hover:bg-white/10 text-left"
                >
                  <FileText className="w-5 h-5" strokeWidth={1.75} /> Insert PDF After Current Page
                </button>
                {p.onPaste && (
                  <button
                    onClick={() => { headerPop.setOpen(null); p.onPaste?.(); }}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-black/5 dark:hover:bg-white/10 text-left"
                  >
                    <ClipboardPaste className="w-5 h-5" strokeWidth={1.75} /> Paste Copied Items
                  </button>
                )}
                <button
                  onClick={() => { headerPop.setOpen(null); p.onToggleBookmark(); }}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-black/5 dark:hover:bg-white/10 text-left"
                >
                  <Bookmark className="w-5 h-5" strokeWidth={1.75} fill={p.pageBookmarked ? 'currentColor' : 'none'} />
                  {p.pageBookmarked ? 'Remove Bookmark' : 'Bookmark Page'}
                </button>
                <button
                  onClick={() => { headerPop.setOpen(null); p.onDuplicatePage(); }}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-black/5 dark:hover:bg-white/10 text-left"
                >
                  <Copy className="w-5 h-5" strokeWidth={1.75} /> Duplicate Page
                </button>
                <button
                  onClick={() => { headerPop.setOpen(null); p.onDeletePage(); }}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-red-50 dark:hover:bg-red-900/20 text-red-600 text-left"
                >
                  <Trash2 className="w-5 h-5" strokeWidth={1.75} /> Delete Page
                </button>
                <div className="h-px bg-gray-200 dark:bg-white/10 my-1" />
                <button
                  onClick={() => { headerPop.setOpen(null); p.onSettings(); }}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-black/5 dark:hover:bg-white/10 text-left"
                >
                  <Settings className="w-5 h-5" strokeWidth={1.75} /> App Settings
                </button>
              </div>
            </HeaderPopover>
          )}

          {/* Paper Picker Popover */}
          {headerPop.open === 'paper' && (
            <HeaderPopover align="right">
              <div className="text-xs text-gray-500 dark:text-gray-400 mb-3 leading-snug">
                Note paper template used for new pages and default sheets.
              </div>
              <PaperPicker value={p.paper} onChange={p.setPaper} adaptDarkPaper={p.adaptDarkPaper} onToggleAdaptDarkPaper={p.onToggleAdaptDarkPaper} />
            </HeaderPopover>
          )}
        </div>
      </div>

      {/* =========================================================================
          FLOATING GLASS TOOL DOCK (Bottom-Center or Docked Left / Right)
          ========================================================================= */}
      <div
        ref={dockPop.ref}
        data-tool-dock
        data-cutout-clear
        data-no-pan
        data-viewport-hole
        className={`glass-pill rounded-3xl p-1.5 flex shadow-2xl transition-[transform,opacity] duration-300 pointer-events-auto ${dockOrientationClass}`}
      >
        <div
          ref={strip.ref}
          onScroll={strip.onScroll}
          style={strip.style}
          className={`flex items-center gap-1 no-scrollbar overscroll-contain ${vertical ? 'flex-col overflow-y-auto' : 'flex-row overflow-x-auto'}`}
        >
        {/* Pen Button */}
        <div>
          <ToolDockButton
            active={tools.tool === 'pen'}
            title="Pen (tap again for options)"
            onClick={() => selectTool('pen', 'pen')}
          >
            <PenLine className="w-5 h-5" strokeWidth={1.75} />
            <span
              className="absolute bottom-1.5 right-1.5 w-2 h-2 rounded-full ring-1 ring-white/90 dark:ring-white/50"
              style={{ backgroundColor: tools.penColor }}
            />
          </ToolDockButton>

          {dockPop.open === 'pen' && (
            <DockPopover position={dockPos}>
              <NibPreview color={tools.penColor} width={tools.penWidth} style={tools.penLineStyle} />
              <Label>Pen Type</Label>
              <div className="flex gap-1.5 mb-2.5">
                {(['fountain', 'ballpoint'] as PenStyle[]).map((s) => (
                  <button
                    key={s}
                    onClick={() => setTools({ penStyle: s })}
                    className={`flex-1 text-xs font-semibold py-2 rounded-xl border transition-all ${
                      tools.penStyle === s
                        ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                        : 'border-gray-200 dark:border-white/10 text-gray-700 dark:text-gray-300'
                    }`}
                  >
                    {s === 'fountain' ? 'Fountain (Pressure)' : 'Ballpoint'}
                  </button>
                ))}
              </div>
              <Label>Line Pattern</Label>
              <LineStylePicker value={tools.penLineStyle} onChange={(ls) => setTools({ penLineStyle: ls })} />
              <Label>Thickness</Label>
              <LevelControl label="Pen width" value={tools.penWidth} {...PEN_WIDTH_RANGE} onChange={(v) => setTools({ penWidth: v })} />
              <Label>Ink Color</Label>
              <ColorPicker value={tools.penColor} onChange={(c) => setTools({ penColor: c })} presets={PEN_COLORS} />
            </DockPopover>
          )}
        </div>

        {/* Smart Pen Button */}
        <div>
          <ToolDockButton
            active={tools.tool === 'shape'}
            title="Smart pen: smooth curves, lines, rectangles, ellipses, fills (tap again for options)"
            onClick={() => selectTool('shape', 'shape')}
          >
            {SHAPE_MODES.find((m) => m.id === tools.shapeMode)?.icon ?? <Spline className="w-5 h-5" strokeWidth={1.75} />}
            <span
              className="absolute bottom-1.5 right-1.5 w-2 h-2 rounded-full ring-1 ring-white/90 dark:ring-white/50"
              style={{ backgroundColor: tools.shapeColor }}
            />
          </ToolDockButton>

          {dockPop.open === 'shape' && (
            <DockPopover position={dockPos}>
              <NibPreview color={tools.shapeColor} width={tools.shapeWidth} style={tools.shapeLineStyle} />
              {/* 2-Tab Segmented Control */}
              <div className="flex bg-black/5 dark:bg-white/10 p-0.5 rounded-xl mb-3">
                <button
                  onClick={() => setSmartPenTab('shape')}
                  className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition ${
                    smartPenTab === 'shape' ? 'bg-white dark:bg-ui-raised text-blue-600 dark:text-blue-400 shadow-sm' : 'text-gray-500'
                  }`}
                >
                  Shape
                </button>
                <button
                  onClick={() => setSmartPenTab('style')}
                  className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition ${
                    smartPenTab === 'style' ? 'bg-white dark:bg-ui-raised text-blue-600 dark:text-blue-400 shadow-sm' : 'text-gray-500'
                  }`}
                >
                  Style & Fill
                </button>
              </div>

              {smartPenTab === 'shape' ? (
                <>
                  <Label>Mode</Label>
                  <div className="grid grid-cols-5 gap-1.5 mb-3">
                    {SHAPE_MODES.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => setTools({ shapeMode: m.id })}
                        title={m.label}
                        className={`h-11 rounded-xl border flex flex-col items-center justify-center gap-1 transition ${
                          tools.shapeMode === m.id
                            ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                            : 'border-gray-200 dark:border-white/10 text-gray-700 dark:text-gray-300'
                        }`}
                      >
                        {m.icon}
                        <span className="text-[10px] leading-none">{m.label}</span>
                      </button>
                    ))}
                  </div>

                  <div className="space-y-2 pt-1 border-t border-gray-200/50 dark:border-white/10 text-xs">
                    <label className="flex items-center justify-between cursor-pointer py-1">
                      <span>Arrowhead on lines</span>
                      <input
                        type="checkbox"
                        checked={tools.shapeArrow}
                        onChange={(e) => setTools({ shapeArrow: e.target.checked })}
                        className="w-4 h-4 accent-blue-600 rounded"
                      />
                    </label>
                    <label className="flex items-center justify-between cursor-pointer py-1">
                      <span>Snap to shapes & intersections</span>
                      <input
                        type="checkbox"
                        checked={tools.shapeSnap}
                        onChange={(e) => setTools({ shapeSnap: e.target.checked })}
                        className="w-4 h-4 accent-blue-600 rounded"
                      />
                    </label>
                    <label className="flex items-center justify-between cursor-pointer py-1">
                      <span>Snap to grid / dots</span>
                      <input
                        type="checkbox"
                        checked={tools.shapeGridSnap}
                        onChange={(e) => setTools({ shapeGridSnap: e.target.checked })}
                        className="w-4 h-4 accent-blue-600 rounded"
                      />
                    </label>
                  </div>
                </>
              ) : (
                <>
                  <Label>Closed Shape Fill</Label>
                  <div className="grid grid-cols-6 gap-1 mb-2.5">
                    {FILL_OPTIONS.map((f) => (
                      <button
                        key={f.id}
                        onClick={() => setTools({ shapeFill: f.id })}
                        title={f.label}
                        className={`h-10 rounded-xl border flex items-center justify-center transition ${
                          tools.shapeFill === f.id ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30' : 'border-gray-200 dark:border-white/10'
                        }`}
                      >
                        <FillSwatch fill={f.id} color={tools.shapeColor.toUpperCase() === '#FFFFFF' ? '#9CA3AF' : tools.shapeColor} />
                      </button>
                    ))}
                  </div>
                  <Label>Line Pattern</Label>
                  <LineStylePicker value={tools.shapeLineStyle} onChange={(ls) => setTools({ shapeLineStyle: ls })} />
                  <Label>Stroke Width</Label>
                  <LevelControl label="Draw width" value={tools.shapeWidth} {...PEN_WIDTH_RANGE} onChange={(v) => setTools({ shapeWidth: v })} />
                  <Label>Color</Label>
                  <ColorPicker value={tools.shapeColor} onChange={(c) => setTools({ shapeColor: c })} presets={PEN_COLORS} size="sm" />
                </>
              )}
            </DockPopover>
          )}
        </div>

        {/* Highlighter Button */}
        <div>
          <ToolDockButton
            active={tools.tool === 'highlighter'}
            title="Highlighter (tap again for options)"
            onClick={() => selectTool('highlighter', 'hl')}
          >
            <Highlighter className="w-5 h-5" strokeWidth={1.75} />
            <span
              className="absolute bottom-1.5 right-1.5 w-2 h-2 rounded-full ring-1 ring-white/90 dark:ring-white/50"
              style={{ backgroundColor: tools.highlighterColor }}
            />
          </ToolDockButton>

          {dockPop.open === 'hl' && (
            <DockPopover position={dockPos}>
              <NibPreview color={tools.highlighterColor} width={tools.highlighterWidth} opacity={tools.highlighterOpacity} />
              <Label>Color</Label>
              <div className="mb-2">
                <ColorPicker value={tools.highlighterColor} onChange={(c) => setTools({ highlighterColor: c })} presets={HIGHLIGHTER_COLORS} />
              </div>
              <Label>Width</Label>
              <LevelControl label="Highlighter width" value={tools.highlighterWidth} {...HIGHLIGHTER_WIDTH_RANGE} onChange={(v) => setTools({ highlighterWidth: v })} />
              <Label>Opacity</Label>
              <LevelControl label="Highlighter opacity" value={tools.highlighterOpacity} min={0.01} max={1} log={false} onChange={(v) => setTools({ highlighterOpacity: v })} />
            </DockPopover>
          )}
        </div>

        {/* Eraser Button */}
        <div>
          <ToolDockButton
            active={tools.tool === 'eraser'}
            title="Eraser (tap again for options)"
            onClick={() => selectTool('eraser', 'eraser')}
          >
            <Eraser className="w-5 h-5" strokeWidth={1.75} />
          </ToolDockButton>

          {dockPop.open === 'eraser' && (
            <DockPopover position={dockPos}>
              <Label>Mode</Label>
              <div className="flex gap-1.5 mb-2.5">
                {(['stroke', 'partial'] as EraserMode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => setTools({ eraserMode: m })}
                    className={`flex-1 text-xs font-semibold py-2 rounded-xl border transition ${
                      tools.eraserMode === m
                        ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                        : 'border-gray-200 dark:border-white/10 text-gray-700 dark:text-gray-300'
                    }`}
                  >
                    {m === 'stroke' ? 'Whole Stroke' : 'Precision (Pixel)'}
                  </button>
                ))}
              </div>
              <Label>Size</Label>
              <LevelControl label="Eraser size" value={tools.eraserSize} {...ERASER_SIZE_RANGE} onChange={(v) => setTools({ eraserSize: v })} />
            </DockPopover>
          )}
        </div>

        {/* Lasso Button */}
        <div>
          <ToolDockButton
            active={tools.tool === 'lasso'}
            title="Lasso: select, move, recolor, convert to LaTeX/TikZ"
            onClick={() => selectTool('lasso', 'lasso')}
          >
            <Lasso className="w-5 h-5" strokeWidth={1.75} />
          </ToolDockButton>

          {dockPop.open === 'lasso' && (
            <DockPopover position={dockPos}>
              <Label>Selection Shape</Label>
              <div className="flex gap-1.5 mb-1">
                {(['freeform', 'rect'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setTools({ lassoMode: m })}
                    className={`flex-1 text-xs font-semibold py-2 rounded-xl border transition ${
                      (tools.lassoMode ?? 'freeform') === m
                        ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                        : 'border-gray-200 dark:border-white/10 text-gray-700 dark:text-gray-300'
                    }`}
                  >
                    {m === 'freeform' ? 'Freeform Lasso' : 'Rectangle'}
                  </button>
                ))}
              </div>
            </DockPopover>
          )}
        </div>

        {/* Laser Pointer */}
        <ToolDockButton
          active={tools.tool === 'laser'}
          title="Laser Pointer (broadcasts to connected PCs)"
          onClick={() => selectTool('laser')}
        >
          <Pointer className="w-5 h-5 text-red-500" strokeWidth={1.75} />
          <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-red-500 animate-ping" />
        </ToolDockButton>

        {/* Text Button */}
        <ToolDockButton
          active={tools.tool === 'text'}
          title="Text Box"
          onClick={() => selectTool('text')}
        >
          <Type className="w-5 h-5" strokeWidth={1.75} />
        </ToolDockButton>

        {/* Hand Button */}
        <ToolDockButton
          active={tools.tool === 'hand'}
          title="Hand (Pan / Scroll)"
          onClick={() => selectTool('hand')}
        >
          <Hand className="w-5 h-5" strokeWidth={1.75} />
        </ToolDockButton>

        {/* Stylus-Only Toggle */}
        <ToolDockButton
          active={!tools.stylusOnly}
          title={tools.stylusOnly ? 'Stylus only (fingers scroll). Tap to allow finger ink.' : 'Finger ink allowed. Tap for stylus only.'}
          onClick={() => setTools({ stylusOnly: !tools.stylusOnly })}
        >
          {tools.stylusOnly ? <PointerOff className="w-5 h-5" strokeWidth={1.75} /> : <Pointer className="w-5 h-5" strokeWidth={1.75} />}
        </ToolDockButton>

        {/* =====================================================================
            1-TAP FAVORITE COLOR DOTS
            ===================================================================== */}
        <div className={`bg-gray-300 dark:bg-white/15 hidden sm:block flex-shrink-0 ${vertical ? 'w-5 h-px my-0.5' : 'h-5 w-px mx-0.5'}`} />

        <div className={`hidden sm:flex items-center gap-1 ${vertical ? 'flex-col' : ''}`}>
          {quickColors.map((color) => {
            const isSelected = currentStrokeColor.toLowerCase() === color.toLowerCase();
            return (
              <button
                key={color}
                onClick={() => setQuickColor(color)}
                className={`min-w-[28px] min-h-[28px] w-7 h-7 rounded-full transition-all active:scale-90 flex items-center justify-center ${
                  isSelected ? 'ring-2 ring-blue-500 ring-offset-2 ring-offset-white dark:ring-offset-ui-raised scale-105 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.35)]' : 'hover:scale-105 ring-1 ring-black/10 dark:ring-white/35'
                }`}
                style={{ backgroundColor: color }}
                title={`Select color ${color}`}
              >
                {isSelected && <Check className="w-3.5 h-3.5 text-white" strokeWidth={2.5} />}
              </button>
            );
          })}

          {/* Plus dot for custom color */}
          <button
            onClick={() => selectTool(tools.tool, tools.tool === 'highlighter' ? 'hl' : tools.tool === 'shape' ? 'shape' : 'pen')}
            className="min-w-[28px] min-h-[28px] w-7 h-7 rounded-full border border-dashed border-gray-400 dark:border-white/30 flex items-center justify-center text-gray-500 hover:text-gray-900 dark:hover:text-white transition active:scale-90"
            title="Custom color..."
          >
            <Plus className="w-3.5 h-3.5" strokeWidth={2.5} />
          </button>
        </div>

        {/* =====================================================================
            1-TAP WIDTH PRESET DOTS
            ===================================================================== */}
        <div className={`bg-gray-300 dark:bg-white/15 hidden sm:block flex-shrink-0 ${vertical ? 'w-5 h-px my-0.5' : 'h-5 w-px mx-0.5'}`} />

        <div className={`hidden sm:flex items-center gap-1 px-0.5 ${vertical ? 'flex-col' : ''}`}>
          {widthPresets.map((w, idx) => {
            const isSelected = Math.abs(currentStrokeWidth - w) < 0.8;
            const dotSize = idx === 0 ? 'w-2 h-2' : idx === 1 ? 'w-3 h-3' : 'w-4 h-4';
            return (
              <button
                key={w}
                onClick={() => setWidthPreset(w)}
                className={`min-w-[28px] min-h-[28px] w-7 h-7 rounded-xl flex items-center justify-center transition-all active:scale-90 ${
                  isSelected ? 'bg-blue-500/20 text-blue-600 dark:text-blue-400 ring-1 ring-blue-500/50' : 'hover:bg-black/5 dark:hover:bg-white/10 text-gray-700 dark:text-gray-300'
                }`}
                title={`Width preset: ${w}px`}
              >
                <span className={`rounded-full bg-current ${dotSize}`} />
              </button>
            );
          })}
        </div>
        </div>
      </div>

      {/* Hidden file inputs */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) p.onInsertImage(f);
          e.target.value = '';
        }}
      />
      <input
        ref={pdfRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) p.onInsertPdf(f);
          e.target.value = '';
        }}
      />
    </>
  );
};
