import React, { useEffect, useRef, useState } from 'react';
import {
  Undo2, Redo2, PenLine, Highlighter, Eraser, Lasso, Type, Hand, Share, Settings, ChevronLeft, Plus,
  LayoutTemplate, Sparkles, Image as ImageIcon, Sigma, Shapes, Trash2, Copy, MoreHorizontal,
  Spline, Slash, Square, Circle, Dot, Pointer, PointerOff, ClipboardPaste, PanelLeft,
} from 'lucide-react';
import { EraserMode, FillType, LineStyle, PenStyle, ShapeMode, ToolType } from '../types';
import { SetupPatch } from '../editor/pageSetup';
import { PaperPicker, PaperValues } from './PaperPicker';
import { ToolSettings } from './CanvasPage';
import { ColorPicker } from './ColorPicker';

const PEN_COLORS = ['#111827', '#1A73E8', '#D93025', '#188038', '#F2994A', '#9B51E0', '#6B7280', '#00A88A', '#FFFFFF'];
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
  { id: 'curve', label: 'Smart curve', icon: <Spline className="w-6 h-6" /> },
  { id: 'line', label: 'Line', icon: <Slash className="w-6 h-6" /> },
  { id: 'rectangle', label: 'Rectangle', icon: <Square className="w-6 h-6" /> },
  { id: 'ellipse', label: 'Ellipse / circle', icon: <Circle className="w-6 h-6" /> },
  { id: 'point', label: 'Point', icon: <Dot className="w-6 h-6" /> },
];

/** Small preview of a fill style. */
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

interface ToolbarProps {
  tools: ToolSettings;
  setTools: (patch: Partial<ToolSettings>) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  title: string;
  setTitle: (t: string) => void;
  /** The note's default paper (pages without paper of their own, and new pages). */
  paper: PaperValues;
  setPaper: (patch: SetupPatch) => void;
  pagesOpen: boolean;
  onTogglePages: () => void;
  onBack: () => void;
  onConvertPage: () => void;
  onExport: () => void;
  onSettings: () => void;
  onDuplicatePage: () => void;
  onDeletePage: () => void;
  onInsertLatex: () => void;
  onInsertImage: (file: File) => void;
  /** Paste the clipboard (undefined: nothing copied). */
  onPaste?: () => void;
  currentPage: number;
  totalPages: number;
  audioSlot: React.ReactNode;
}

function usePopover() {
  const [open, setOpen] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
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

const ToolButton: React.FC<{ active: boolean; title: string; onClick: () => void; children: React.ReactNode }> = ({ active, title, onClick, children }) => (
  <button
    onClick={onClick}
    title={title}
    className={`h-10 min-w-10 px-1.5 sm:h-11 sm:min-w-11 sm:px-2.5 rounded-2xl flex items-center justify-center gap-1.5 transition-all duration-150 active:scale-95 ${
      active
        ? 'bg-blue-600 text-white shadow-md shadow-blue-600/30'
        : 'text-gray-700 dark:text-gray-200 hover:bg-white dark:hover:bg-white/10'
    }`}
  >
    {children}
  </button>
);

const Popover: React.FC<{ align?: 'left' | 'right' | 'center'; children: React.ReactNode }> = ({ align = 'left', children }) => (
  <div
    className={`absolute top-14 z-50 bg-white/95 dark:bg-ui-raised/95 backdrop-blur-xl rounded-3xl p-4 shadow-2xl shadow-black/15 border border-gray-200/80 dark:border-white/10 w-80 max-w-[calc(100vw-24px)] max-h-[calc(100dvh-90px)] overflow-y-auto overflow-x-hidden no-scrollbar ${
      align === 'right' ? 'right-0' : align === 'center' ? 'left-1/2 -translate-x-1/2' : 'left-0'
    }`}
  >
    {children}
  </div>
);

const Label: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-2 mt-1.5">{children}</div>
);

/**
 * A tool's width (or opacity) as a slider and a box, both from 1 to 100; editing one moves the
 * other. The level maps onto the tool's own range [min, max], along a log scale for widths (fine
 * steps where widths are thin) or straight for opacity.
 */
const LevelControl: React.FC<{ value: number; min: number; max: number; log?: boolean; onChange: (v: number) => void; label: string }> = ({ value, min, max, log = true, onChange, label }) => {
  const toLevel = (v: number) => Math.round(1 + 99 * (log ? Math.log(Math.max(min, Math.min(max, v)) / min) / Math.log(max / min) : (Math.max(min, Math.min(max, v)) - min) / (max - min)));
  const fromLevel = (l: number) => (log ? min * Math.pow(max / min, (l - 1) / 99) : min + ((l - 1) / 99) * (max - min));
  const level = toLevel(value);
  const [draft, setDraft] = useState(String(level));
  useEffect(() => setDraft(String(level)), [level]);
  const set = (l: number) => onChange(fromLevel(Math.max(1, Math.min(100, Math.round(l)))));
  return (
    <div className="flex items-center gap-3 mb-2">
      <input type="range" min={1} max={100} step={1} value={level} onChange={(e) => set(+e.target.value)} className="flex-1 accent-blue-600" aria-label={label} />
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
        className="w-16 text-center text-sm rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-ui-high py-1.5 tabular-nums"
      />
    </div>
  );
};

/** The tools' width ranges (page px) behind the 1-100 levels. */
const PEN_WIDTH_RANGE = { min: 0.5, max: 24 };
const HIGHLIGHTER_WIDTH_RANGE = { min: 1, max: 20 };
const ERASER_SIZE_RANGE = { min: 2, max: 100 };

export const Toolbar: React.FC<ToolbarProps> = (p) => {
  const { tools, setTools } = p;
  const pop = usePopover();
  const fileRef = useRef<HTMLInputElement>(null);

  const selectTool = (tool: ToolType, menu?: string) => {
    if (tools.tool === tool && menu) pop.setOpen(pop.open === menu ? null : menu);
    else {
      setTools({ tool });
      pop.setOpen(null);
    }
  };

  const shelf = (
    <div ref={pop.ref} className="flex items-center bg-gray-100/90 dark:bg-ui-raised p-1 sm:p-1.5 rounded-[22px] border border-gray-200/70 dark:border-white/10 gap-0.5 sm:gap-1 shadow-inner">
      <div className="relative">
        <ToolButton active={tools.tool === 'pen'} title="Pen (tap again for options)" onClick={() => selectTool('pen', 'pen')}>
          <PenLine className="w-6 h-6" />
          <span className="hidden sm:block w-4 h-4 rounded-full ring-2 ring-white/90 dark:ring-black/40 shadow-sm" style={{ backgroundColor: tools.penColor }} />
        </ToolButton>
        {pop.open === 'pen' && (
          <Popover>
            <Label>Pen type</Label>
            <div className="flex gap-1 mb-2">
              {(['fountain', 'ballpoint'] as PenStyle[]).map((s) => (
                <button key={s} onClick={() => setTools({ penStyle: s })} className={`flex-1 text-sm py-2 rounded-xl border capitalize ${tools.penStyle === s ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' : 'border-gray-200 dark:border-gray-600'}`}>
                  {s === 'fountain' ? 'Fountain (pressure)' : 'Ballpoint'}
                </button>
              ))}
            </div>
            <Label>Width</Label>
            <LevelControl label="Pen width" value={tools.penWidth} {...PEN_WIDTH_RANGE} onChange={(v) => setTools({ penWidth: v })} />
            <Label>Colour</Label>
            <ColorPicker value={tools.penColor} onChange={(c) => setTools({ penColor: c })} presets={PEN_COLORS} />
            <label className="flex items-center justify-between gap-3 py-1 mt-3 text-sm text-gray-700 dark:text-gray-300">
              Draw &amp; hold to snap shapes
              <input type="checkbox" checked={tools.holdToSnap} onChange={(e) => setTools({ holdToSnap: e.target.checked })} />
            </label>
          </Popover>
        )}
      </div>

      <div className="relative">
        <ToolButton active={tools.tool === 'shape'} title="Smart pen: smooth curves that close themselves, lines, rectangles, ellipses, fills (tap again for options)" onClick={() => selectTool('shape', 'shape')}>
          {SHAPE_MODES.find((m) => m.id === tools.shapeMode)?.icon ?? <Spline className="w-6 h-6" />}
          <span className="hidden sm:block w-4 h-4 rounded-full ring-2 ring-white/90 dark:ring-black/40 shadow-sm" style={{ backgroundColor: tools.shapeColor }} title="Draw colour" />
        </ToolButton>
        {pop.open === 'shape' && (
          <Popover>
            <Label>Draw</Label>
            <div className="grid grid-cols-5 gap-1 mb-2">
              {SHAPE_MODES.map((m) => (
                <button key={m.id} onClick={() => setTools({ shapeMode: m.id })} title={m.label} className={`h-11 rounded-xl border flex items-center justify-center ${tools.shapeMode === m.id ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' : 'border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-300'}`}>
                  {m.icon}
                </button>
              ))}
            </div>
            <Label>Fill (closed shapes)</Label>
            <div className="grid grid-cols-6 gap-1 mb-2">
              {FILL_OPTIONS.map((f) => (
                <button key={f.id} onClick={() => setTools({ shapeFill: f.id })} title={f.label} className={`h-11 rounded-xl border flex items-center justify-center ${tools.shapeFill === f.id ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30' : 'border-gray-200 dark:border-gray-600'}`}>
                  <FillSwatch fill={f.id} color={tools.shapeColor.toUpperCase() === '#FFFFFF' ? '#9CA3AF' : tools.shapeColor} />
                </button>
              ))}
            </div>
            <Label>Line</Label>
            <div className="flex gap-1 mb-2">
              {(['solid', 'dashed', 'dotted'] as LineStyle[]).map((ls) => (
                <button key={ls} onClick={() => setTools({ shapeLineStyle: ls })} className={`flex-1 text-sm py-2 rounded-xl border capitalize ${tools.shapeLineStyle === ls ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' : 'border-gray-200 dark:border-gray-600'}`}>
                  {ls}
                </button>
              ))}
            </div>
            <Label>Width</Label>
            <LevelControl label="Draw width" value={tools.shapeWidth} {...PEN_WIDTH_RANGE} onChange={(v) => setTools({ shapeWidth: v })} />
            <Label>Colour</Label>
            <div className="mb-2">
              <ColorPicker value={tools.shapeColor} onChange={(c) => setTools({ shapeColor: c })} presets={PEN_COLORS} size="sm" />
            </div>
            <label className="flex items-center justify-between gap-3 py-1 mt-1 text-sm text-gray-700 dark:text-gray-300">
              Draw &amp; hold to make a clean shape
              <input type="checkbox" checked={tools.holdToSnap} onChange={(e) => setTools({ holdToSnap: e.target.checked })} />
            </label>
            <label className="flex items-center justify-between gap-3 py-1 mt-1 text-sm text-gray-700 dark:text-gray-300">
              Arrowhead on open lines
              <input type="checkbox" checked={tools.shapeArrow} onChange={(e) => setTools({ shapeArrow: e.target.checked })} />
            </label>
            <label className="flex items-center justify-between gap-3 py-1 mt-2 text-sm text-gray-700 dark:text-gray-300">
              Snap to shapes (points, edges, crossings)
              <input type="checkbox" checked={tools.shapeSnap} onChange={(e) => setTools({ shapeSnap: e.target.checked })} />
            </label>
            <label className="flex items-center justify-between gap-3 py-1 mt-2 text-sm text-gray-700 dark:text-gray-300">
              Snap to grid / dot paper
              <input type="checkbox" checked={tools.shapeGridSnap} onChange={(e) => setTools({ shapeGridSnap: e.target.checked })} />
            </label>
            <p className="text-[10px] text-gray-400 mt-2 leading-snug">End a curve near its start to close it. Closed shapes take the fill. Lasso a single shape to reshape it with its handles.</p>
          </Popover>
        )}
      </div>

      <div className="relative">
        <ToolButton active={tools.tool === 'highlighter'} title="Highlighter" onClick={() => selectTool('highlighter', 'hl')}>
          <Highlighter className="w-6 h-6" />
          <span className="hidden sm:block w-4 h-4 rounded-full ring-2 ring-white/90 dark:ring-black/40 shadow-sm" style={{ backgroundColor: tools.highlighterColor }} />
        </ToolButton>
        {pop.open === 'hl' && (
          <Popover>
            <Label>Colour</Label>
            <div className="mb-2">
              <ColorPicker value={tools.highlighterColor} onChange={(c) => setTools({ highlighterColor: c })} presets={HIGHLIGHTER_COLORS} />
            </div>
            <Label>Width</Label>
            <LevelControl label="Highlighter width" value={tools.highlighterWidth} {...HIGHLIGHTER_WIDTH_RANGE} onChange={(v) => setTools({ highlighterWidth: v })} />
            <Label>Opacity</Label>
            <LevelControl label="Highlighter opacity" value={tools.highlighterOpacity} min={0.01} max={1} log={false} onChange={(v) => setTools({ highlighterOpacity: v })} />
          </Popover>
        )}
      </div>

      <div className="relative">
        <ToolButton active={tools.tool === 'eraser'} title="Eraser" onClick={() => selectTool('eraser', 'eraser')}>
          <Eraser className="w-6 h-6" />
        </ToolButton>
        {pop.open === 'eraser' && (
          <Popover align="center">
            <Label>Mode</Label>
            <div className="flex gap-1 mb-2">
              {(['stroke', 'partial'] as EraserMode[]).map((m) => (
                <button key={m} onClick={() => setTools({ eraserMode: m })} className={`flex-1 text-sm py-2 rounded-xl border ${tools.eraserMode === m ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' : 'border-gray-200 dark:border-gray-600'}`}>
                  {m === 'stroke' ? 'Whole stroke' : 'Precision'}
                </button>
              ))}
            </div>
            <Label>Size</Label>
            <LevelControl label="Eraser size" value={tools.eraserSize} {...ERASER_SIZE_RANGE} onChange={(v) => setTools({ eraserSize: v })} />
          </Popover>
        )}
      </div>

      <ToolButton active={tools.tool === 'lasso'} title="Lasso: select, move, convert to LaTeX/TikZ" onClick={() => selectTool('lasso')}>
        <Lasso className="w-6 h-6" />
      </ToolButton>
      <ToolButton active={tools.tool === 'text'} title="Text" onClick={() => selectTool('text')}>
        <Type className="w-6 h-6" />
      </ToolButton>
      <ToolButton active={tools.tool === 'hand'} title="Scroll / hand" onClick={() => selectTool('hand')}>
        <Hand className="w-6 h-6" />
      </ToolButton>
      <ToolButton
        active={!tools.stylusOnly}
        title={tools.stylusOnly ? 'Pencil only (fingers scroll). Tap to allow finger drawing.' : 'Finger drawing enabled. Tap for pencil only.'}
        onClick={() => setTools({ stylusOnly: !tools.stylusOnly })}
      >
        {tools.stylusOnly ? <PointerOff className="w-6 h-6" /> : <Pointer className="w-6 h-6" />}
      </ToolButton>
    </div>
  );

  const menu = usePopover();

  return (
    <header className="bg-white/95 dark:bg-ui-panel/95 backdrop-blur border-b border-gray-200 dark:border-gray-800 z-30 select-none pt-[env(safe-area-inset-top)]">
      <div className="flex flex-wrap lg:flex-nowrap items-center gap-x-3 gap-y-2 px-3 py-2">
        <div className="flex items-center gap-0.5 min-w-0 flex-1 lg:flex-1 lg:basis-0">
          <button onClick={p.onBack} className="flex items-center text-blue-600 dark:text-blue-400 px-2 py-2 rounded-xl text-base font-semibold hover:bg-blue-50 dark:hover:bg-blue-900/20">
            <ChevronLeft className="w-6 h-6" />
            <span className="hidden 2xl:inline">Notes</span>
          </button>
          <button
            onClick={p.onTogglePages}
            className={`p-2.5 rounded-xl active:scale-95 transition ${p.pagesOpen ? 'bg-blue-600 text-white' : 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10'}`}
            title="Pages"
          >
            <PanelLeft className="w-6 h-6" />
          </button>
          <input
            value={p.title}
            onChange={(e) => p.setTitle(e.target.value)}
            className="font-semibold text-base bg-transparent rounded-lg px-2 py-1.5 min-w-0 w-full max-w-[220px] text-gray-900 dark:text-gray-100 truncate focus:outline-none focus:ring-1 focus:ring-blue-500 select-text"
          />
          <button onClick={p.onUndo} disabled={!p.canUndo} className="p-2.5 rounded-xl text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10 disabled:opacity-30 active:scale-95 transition" title="Undo">
            <Undo2 className="w-6 h-6" />
          </button>
          <button onClick={p.onRedo} disabled={!p.canRedo} className="p-2.5 rounded-xl text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10 disabled:opacity-30 active:scale-95 transition" title="Redo">
            <Redo2 className="w-6 h-6" />
          </button>
        </div>

        <div className="order-last w-full flex justify-center lg:order-none lg:w-auto lg:flex-none">{shelf}</div>

        <div ref={menu.ref} className="flex items-center justify-end gap-0.5 relative lg:flex-1 lg:basis-0">
          {p.audioSlot}
          <button onClick={p.onConvertPage} className="hidden sm:flex items-center gap-2 bg-gradient-to-r from-blue-600 to-indigo-600 text-white px-3 2xl:px-4 py-2.5 rounded-2xl text-sm font-semibold shadow-md shadow-indigo-600/25 active:scale-95 transition" title="Transcribe the current page with Qwen3-VL">
            <Sparkles className="w-5 h-5" />
            <span className="hidden 2xl:inline">Page → LaTeX</span>
          </button>
          <button onClick={() => menu.setOpen(menu.open === 'paper' ? null : 'paper')} className="p-2.5 rounded-xl text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10 active:scale-95 transition" title="Paper">
            <LayoutTemplate className="w-6 h-6" />
          </button>
          <button onClick={() => menu.setOpen(menu.open === 'more' ? null : 'more')} className="p-2.5 rounded-xl text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10 active:scale-95 transition" title="Insert & pages">
            <MoreHorizontal className="w-6 h-6" />
          </button>
          <button onClick={p.onExport} className="p-2.5 rounded-xl text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10 active:scale-95 transition" title="Export">
            <Share className="w-6 h-6" />
          </button>
          <button onClick={p.onSettings} className="p-2.5 rounded-xl text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/10 active:scale-95 transition" title="Settings">
            <Settings className="w-6 h-6" />
          </button>

          {menu.open === 'paper' && (
            <Popover align="right">
              <div className="text-xs text-gray-500 dark:text-gray-400 mb-3 leading-snug">
                Note paper: used by new pages and by every page without paper of its own (set that in Pages).
              </div>
              <PaperPicker value={p.paper} onChange={p.setPaper} />
            </Popover>
          )}
          {menu.open === 'more' && (
            <Popover align="right">
              <div className="flex flex-col text-sm text-gray-800 dark:text-gray-200">
                {[
                  { icon: <Sparkles className="w-5 h-5" />, label: 'Transcribe page → LaTeX', fn: p.onConvertPage, cls: 'sm:hidden' },
                  { icon: <Sigma className="w-5 h-5" />, label: 'Insert LaTeX / TikZ', fn: p.onInsertLatex },
                  { icon: <ImageIcon className="w-5 h-5" />, label: 'Insert image', fn: () => fileRef.current?.click() },
                  ...(p.onPaste ? [{ icon: <ClipboardPaste className="w-5 h-5" />, label: 'Paste copied items', fn: p.onPaste }] : []),
                  { icon: <Copy className="w-5 h-5" />, label: 'Duplicate current page', fn: p.onDuplicatePage },
                  { icon: <Trash2 className="w-5 h-5" />, label: 'Delete current page', fn: p.onDeletePage, danger: true },
                ].map((it) => (
                  <button
                    key={it.label}
                    onClick={() => {
                      menu.setOpen(null);
                      it.fn();
                    }}
                    className={`flex items-center gap-3 px-3 py-3 rounded-xl text-[15px] hover:bg-gray-100 dark:hover:bg-white/10 text-left ${it.danger ? 'text-red-600' : ''} ${it.cls ?? ''}`}
                  >
                    {it.icon}
                    {it.label}
                  </button>
                ))}
                <div className="text-[11px] text-gray-400 px-2 pt-1 flex items-center gap-1">
                  <Shapes className="w-3 h-3" /> Page {p.currentPage} of {p.totalPages}
                </div>
              </div>
            </Popover>
          )}
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
        </div>
      </div>
    </header>
  );
};
