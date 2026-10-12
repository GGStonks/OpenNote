import React, { useEffect, useRef, useState } from 'react';
import {
  Undo2, Redo2, PenLine, Highlighter, Eraser, Lasso, Type, Hand, Share, Settings, ChevronLeft, Plus,
  LayoutTemplate, Sparkles, Image as ImageIcon, Sigma, Shapes, FilePlus2, Trash2, Copy, MoreHorizontal,
  Spline, Slash, Square, Circle, Dot,
} from 'lucide-react';
import { EraserMode, FillType, LineStyle, PaperColor, PaperStyle, PenStyle, ShapeMode, ToolType } from '../types';
import { ToolSettings } from './CanvasPage';

const PEN_COLORS = ['#111827', '#1A73E8', '#D93025', '#188038', '#F2994A', '#9B51E0', '#6B7280', '#00A88A', '#FFFFFF'];
const HIGHLIGHTER_COLORS = ['#FDE047', '#86EFAC', '#93C5FD', '#F9A8D4', '#C4B5FD', '#FDBA74'];
const PEN_WIDTHS = [1.2, 2, 3, 4.5, 7];

export const FILL_OPTIONS: { id: FillType; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'solid', label: 'Solid' },
  { id: 'northEast', label: '////' },
  { id: 'northWest', label: '\\\\' },
  { id: 'crosshatch', label: 'Cross' },
  { id: 'hole', label: 'Hole' },
];

const SHAPE_MODES: { id: ShapeMode; label: string; icon: React.ReactNode }[] = [
  { id: 'curve', label: 'Smart curve', icon: <Spline className="w-4 h-4" /> },
  { id: 'line', label: 'Line', icon: <Slash className="w-4 h-4" /> },
  { id: 'rectangle', label: 'Rectangle', icon: <Square className="w-4 h-4" /> },
  { id: 'ellipse', label: 'Ellipse / circle', icon: <Circle className="w-4 h-4" /> },
  { id: 'point', label: 'Point', icon: <Dot className="w-4 h-4" /> },
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
  paperStyle: PaperStyle;
  setPaperStyle: (s: PaperStyle) => void;
  paperColor: PaperColor;
  setPaperColor: (c: PaperColor) => void;
  onBack: () => void;
  onConvertPage: () => void;
  onExport: () => void;
  onSettings: () => void;
  onAddPage: () => void;
  onDuplicatePage: () => void;
  onDeletePage: () => void;
  onInsertLatex: () => void;
  onInsertImage: (file: File) => void;
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
    className={`h-9 min-w-9 px-2 rounded-xl flex items-center justify-center gap-1 transition ${
      active ? 'bg-white dark:bg-[#3A3A3C] text-blue-600 dark:text-blue-400 shadow-sm' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-200/60 dark:hover:bg-gray-700/50'
    }`}
  >
    {children}
  </button>
);

const Popover: React.FC<{ align?: 'left' | 'right' | 'center'; children: React.ReactNode }> = ({ align = 'left', children }) => (
  <div
    className={`absolute top-11 z-50 bg-white dark:bg-[#2C2C2E] rounded-2xl p-3 shadow-xl border border-gray-200 dark:border-gray-700 w-64 max-w-[calc(100vw-24px)] ${
      align === 'right' ? 'right-0' : align === 'center' ? 'left-1/2 -translate-x-1/2' : 'left-0'
    }`}
  >
    {children}
  </div>
);

const Label: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wide mb-1.5 mt-1">{children}</div>
);

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
    <div ref={pop.ref} className="flex items-center bg-gray-100 dark:bg-[#2C2C2E] p-1 rounded-2xl border border-gray-200/60 dark:border-gray-700/60 gap-0.5">
      <div className="relative">
        <ToolButton active={tools.tool === 'pen'} title="Pen (tap again for options)" onClick={() => selectTool('pen', 'pen')}>
          <PenLine className="w-[18px] h-[18px]" />
          <span className="w-3 h-3 rounded-full border border-gray-300" style={{ backgroundColor: tools.penColor }} />
        </ToolButton>
        {pop.open === 'pen' && (
          <Popover>
            <Label>Pen type</Label>
            <div className="flex gap-1 mb-2">
              {(['fountain', 'ballpoint'] as PenStyle[]).map((s) => (
                <button key={s} onClick={() => setTools({ penStyle: s })} className={`flex-1 text-xs py-1.5 rounded-lg border capitalize ${tools.penStyle === s ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' : 'border-gray-200 dark:border-gray-600'}`}>
                  {s === 'fountain' ? 'Fountain (pressure)' : 'Ballpoint'}
                </button>
              ))}
            </div>
            <Label>Width</Label>
            <div className="flex justify-between mb-2">
              {PEN_WIDTHS.map((w) => (
                <button key={w} onClick={() => setTools({ penWidth: w })} className={`w-9 h-9 rounded-full flex items-center justify-center border ${tools.penWidth === w ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30' : 'border-transparent'}`}>
                  <span className="rounded-full bg-gray-900 dark:bg-gray-100" style={{ width: w * 2.2, height: w * 2.2 }} />
                </button>
              ))}
            </div>
            <Label>Colour</Label>
            <div className="grid grid-cols-5 gap-2 items-center">
              {PEN_COLORS.map((c) => (
                <button key={c} onClick={() => setTools({ penColor: c })} className={`w-8 h-8 rounded-full border-2 ${tools.penColor === c ? 'border-blue-500 scale-110' : 'border-gray-200 dark:border-gray-600'}`} style={{ backgroundColor: c }} />
              ))}
              <label className="w-8 h-8 rounded-full border-2 border-dashed border-gray-300 flex items-center justify-center cursor-pointer overflow-hidden" title="Custom colour">
                <Plus className="w-4 h-4 text-gray-400" />
                <input type="color" className="opacity-0 absolute w-0 h-0" value={tools.penColor} onChange={(e) => setTools({ penColor: e.target.value })} />
              </label>
            </div>
            <label className="flex items-center justify-between mt-3 text-xs text-gray-600 dark:text-gray-300">
              Draw &amp; hold to snap shapes
              <input type="checkbox" checked={tools.holdToSnap} onChange={(e) => setTools({ holdToSnap: e.target.checked })} />
            </label>
          </Popover>
        )}
      </div>

      <div className="relative">
        <ToolButton active={tools.tool === 'shape'} title="Smart pen: smooth curves that close themselves, lines, rectangles, ellipses, fills (tap again for options)" onClick={() => selectTool('shape', 'shape')}>
          {SHAPE_MODES.find((m) => m.id === tools.shapeMode)?.icon ?? <Spline className="w-4 h-4" />}
        </ToolButton>
        {pop.open === 'shape' && (
          <Popover>
            <Label>Draw</Label>
            <div className="grid grid-cols-5 gap-1 mb-2">
              {SHAPE_MODES.map((m) => (
                <button key={m.id} onClick={() => setTools({ shapeMode: m.id })} title={m.label} className={`h-9 rounded-lg border flex items-center justify-center ${tools.shapeMode === m.id ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' : 'border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-300'}`}>
                  {m.icon}
                </button>
              ))}
            </div>
            <Label>Fill (closed shapes)</Label>
            <div className="grid grid-cols-6 gap-1 mb-2">
              {FILL_OPTIONS.map((f) => (
                <button key={f.id} onClick={() => setTools({ shapeFill: f.id })} title={f.label} className={`h-9 rounded-lg border flex items-center justify-center ${tools.shapeFill === f.id ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30' : 'border-gray-200 dark:border-gray-600'}`}>
                  <FillSwatch fill={f.id} color={tools.penColor === '#FFFFFF' ? '#9CA3AF' : tools.penColor} />
                </button>
              ))}
            </div>
            <Label>Line</Label>
            <div className="flex gap-1 mb-2">
              {(['solid', 'dashed', 'dotted'] as LineStyle[]).map((ls) => (
                <button key={ls} onClick={() => setTools({ shapeLineStyle: ls })} className={`flex-1 text-xs py-1.5 rounded-lg border capitalize ${tools.shapeLineStyle === ls ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' : 'border-gray-200 dark:border-gray-600'}`}>
                  {ls}
                </button>
              ))}
            </div>
            <Label>Width</Label>
            <div className="flex justify-between mb-2">
              {PEN_WIDTHS.map((w) => (
                <button key={w} onClick={() => setTools({ penWidth: w })} className={`w-9 h-9 rounded-full flex items-center justify-center border ${tools.penWidth === w ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30' : 'border-transparent'}`}>
                  <span className="rounded-full bg-gray-900 dark:bg-gray-100" style={{ width: w * 2.2, height: w * 2.2 }} />
                </button>
              ))}
            </div>
            <Label>Colour</Label>
            <div className="grid grid-cols-9 gap-1 mb-2">
              {PEN_COLORS.map((c) => (
                <button key={c} onClick={() => setTools({ penColor: c })} className={`w-6 h-6 rounded-full border-2 ${tools.penColor === c ? 'border-blue-500 scale-110' : 'border-gray-200 dark:border-gray-600'}`} style={{ backgroundColor: c }} />
              ))}
            </div>
            <label className="flex items-center justify-between mt-1 text-xs text-gray-600 dark:text-gray-300">
              Arrowhead on open lines
              <input type="checkbox" checked={tools.shapeArrow} onChange={(e) => setTools({ shapeArrow: e.target.checked })} />
            </label>
            <label className="flex items-center justify-between mt-2 text-xs text-gray-600 dark:text-gray-300">
              Snap to shapes (points, edges, crossings)
              <input type="checkbox" checked={tools.shapeSnap} onChange={(e) => setTools({ shapeSnap: e.target.checked })} />
            </label>
            <label className="flex items-center justify-between mt-2 text-xs text-gray-600 dark:text-gray-300">
              Snap to grid / dot paper
              <input type="checkbox" checked={tools.shapeGridSnap} onChange={(e) => setTools({ shapeGridSnap: e.target.checked })} />
            </label>
            <p className="text-[10px] text-gray-400 mt-2 leading-snug">End a curve near its start to close it. Closed shapes take the fill. Lasso a single shape to reshape it with its handles.</p>
          </Popover>
        )}
      </div>

      <div className="relative">
        <ToolButton active={tools.tool === 'highlighter'} title="Highlighter" onClick={() => selectTool('highlighter', 'hl')}>
          <Highlighter className="w-[18px] h-[18px]" />
          <span className="w-3 h-3 rounded-full border border-gray-300" style={{ backgroundColor: tools.highlighterColor }} />
        </ToolButton>
        {pop.open === 'hl' && (
          <Popover>
            <Label>Colour</Label>
            <div className="grid grid-cols-6 gap-2 mb-2">
              {HIGHLIGHTER_COLORS.map((c) => (
                <button key={c} onClick={() => setTools({ highlighterColor: c })} className={`w-8 h-8 rounded-full border-2 ${tools.highlighterColor === c ? 'border-blue-500 scale-110' : 'border-transparent'}`} style={{ backgroundColor: c }} />
              ))}
            </div>
            <Label>Width</Label>
            <input type="range" min={2} max={8} step={0.5} value={tools.highlighterWidth} onChange={(e) => setTools({ highlighterWidth: +e.target.value })} className="w-full" />
          </Popover>
        )}
      </div>

      <div className="relative">
        <ToolButton active={tools.tool === 'eraser'} title="Eraser" onClick={() => selectTool('eraser', 'eraser')}>
          <Eraser className="w-[18px] h-[18px]" />
        </ToolButton>
        {pop.open === 'eraser' && (
          <Popover align="center">
            <Label>Mode</Label>
            <div className="flex gap-1 mb-2">
              {(['stroke', 'partial'] as EraserMode[]).map((m) => (
                <button key={m} onClick={() => setTools({ eraserMode: m })} className={`flex-1 text-xs py-1.5 rounded-lg border ${tools.eraserMode === m ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' : 'border-gray-200 dark:border-gray-600'}`}>
                  {m === 'stroke' ? 'Whole stroke' : 'Precision'}
                </button>
              ))}
            </div>
            <Label>Size</Label>
            <input type="range" min={4} max={40} value={tools.eraserSize} onChange={(e) => setTools({ eraserSize: +e.target.value })} className="w-full" />
          </Popover>
        )}
      </div>

      <ToolButton active={tools.tool === 'lasso'} title="Lasso: select, move, convert to LaTeX/TikZ" onClick={() => selectTool('lasso')}>
        <Lasso className="w-[18px] h-[18px]" />
      </ToolButton>
      <ToolButton active={tools.tool === 'text'} title="Text" onClick={() => selectTool('text')}>
        <Type className="w-[18px] h-[18px]" />
      </ToolButton>
      <ToolButton active={tools.tool === 'hand'} title="Scroll / hand" onClick={() => selectTool('hand')}>
        <Hand className="w-[18px] h-[18px]" />
      </ToolButton>
      <ToolButton
        active={!tools.stylusOnly}
        title={tools.stylusOnly ? 'Pencil only (fingers scroll). Tap to allow finger drawing.' : 'Finger drawing enabled. Tap for pencil only.'}
        onClick={() => setTools({ stylusOnly: !tools.stylusOnly })}
      >
        <span className="text-[10px] font-bold leading-none">{tools.stylusOnly ? '✎ only' : '☝︎ draw'}</span>
      </ToolButton>
    </div>
  );

  const menu = usePopover();

  return (
    <header className="bg-white/95 dark:bg-[#1C1C1E]/95 backdrop-blur border-b border-gray-200 dark:border-gray-800 z-30 select-none pt-[env(safe-area-inset-top)]">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-2 py-1.5">
        <div className="flex items-center gap-1 min-w-0 flex-1 md:flex-none">
          <button onClick={p.onBack} className="flex items-center text-blue-600 dark:text-blue-400 px-1.5 py-1 rounded-lg text-sm font-semibold">
            <ChevronLeft className="w-5 h-5" />
            <span className="hidden sm:inline">Notes</span>
          </button>
          <input
            value={p.title}
            onChange={(e) => p.setTitle(e.target.value)}
            className="font-semibold text-sm bg-transparent rounded px-1.5 py-1 min-w-0 w-full md:w-48 text-gray-900 dark:text-gray-100 truncate focus:outline-none focus:ring-1 focus:ring-blue-500 select-text"
          />
          <button onClick={p.onUndo} disabled={!p.canUndo} className="p-2 rounded-lg text-gray-700 dark:text-gray-200 disabled:opacity-30" title="Undo">
            <Undo2 className="w-[18px] h-[18px]" />
          </button>
          <button onClick={p.onRedo} disabled={!p.canRedo} className="p-2 rounded-lg text-gray-700 dark:text-gray-200 disabled:opacity-30" title="Redo">
            <Redo2 className="w-[18px] h-[18px]" />
          </button>
        </div>

        <div className="order-last w-full flex justify-center md:order-none md:w-auto md:flex-1">{shelf}</div>

        <div ref={menu.ref} className="flex items-center gap-0.5 relative">
          {p.audioSlot}
          <button onClick={p.onConvertPage} className="hidden sm:flex items-center gap-1.5 bg-gradient-to-r from-blue-600 to-indigo-600 text-white px-3 py-1.5 rounded-xl text-xs font-semibold" title="Transcribe the current page with Qwen3-VL">
            <Sparkles className="w-3.5 h-3.5" />
            <span className="hidden lg:inline">Page → LaTeX</span>
          </button>
          <button onClick={() => menu.setOpen(menu.open === 'paper' ? null : 'paper')} className="p-2 rounded-lg text-gray-600 dark:text-gray-300" title="Paper">
            <LayoutTemplate className="w-[18px] h-[18px]" />
          </button>
          <button onClick={() => menu.setOpen(menu.open === 'more' ? null : 'more')} className="p-2 rounded-lg text-gray-600 dark:text-gray-300" title="Insert & pages">
            <MoreHorizontal className="w-[18px] h-[18px]" />
          </button>
          <button onClick={p.onExport} className="p-2 rounded-lg text-gray-600 dark:text-gray-300" title="Export">
            <Share className="w-[18px] h-[18px]" />
          </button>
          <button onClick={p.onSettings} className="p-2 rounded-lg text-gray-600 dark:text-gray-300" title="Settings">
            <Settings className="w-[18px] h-[18px]" />
          </button>

          {menu.open === 'paper' && (
            <Popover align="right">
              <Label>Pattern</Label>
              <div className="grid grid-cols-2 gap-1.5 mb-2">
                {(['blank', 'ruled', 'grid', 'dots'] as PaperStyle[]).map((s) => (
                  <button key={s} onClick={() => p.setPaperStyle(s)} className={`px-2 py-1.5 rounded-lg text-xs capitalize border ${p.paperStyle === s ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30' : 'border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-300'}`}>
                    {s}
                  </button>
                ))}
              </div>
              <Label>Colour</Label>
              <div className="flex gap-2">
                {([
                  ['white', '#FFFFFF'],
                  ['cream', '#FBF7EE'],
                  ['yellow', '#FEF9C3'],
                  ['dark', '#1C1C1F'],
                ] as [PaperColor, string][]).map(([id, c]) => (
                  <button key={id} onClick={() => p.setPaperColor(id)} title={id} className={`w-8 h-8 rounded-full border-2 ${p.paperColor === id ? 'border-blue-500 scale-110' : 'border-gray-300'}`} style={{ backgroundColor: c }} />
                ))}
              </div>
            </Popover>
          )}
          {menu.open === 'more' && (
            <Popover align="right">
              <div className="flex flex-col text-sm text-gray-800 dark:text-gray-200">
                {[
                  { icon: <Sparkles className="w-4 h-4" />, label: 'Transcribe page → LaTeX', fn: p.onConvertPage, cls: 'sm:hidden' },
                  { icon: <Sigma className="w-4 h-4" />, label: 'Insert LaTeX / TikZ', fn: p.onInsertLatex },
                  { icon: <ImageIcon className="w-4 h-4" />, label: 'Insert image', fn: () => fileRef.current?.click() },
                  { icon: <FilePlus2 className="w-4 h-4" />, label: 'Add page after current', fn: p.onAddPage },
                  { icon: <Copy className="w-4 h-4" />, label: 'Duplicate current page', fn: p.onDuplicatePage },
                  { icon: <Trash2 className="w-4 h-4" />, label: 'Delete current page', fn: p.onDeletePage, danger: true },
                ].map((it) => (
                  <button
                    key={it.label}
                    onClick={() => {
                      menu.setOpen(null);
                      it.fn();
                    }}
                    className={`flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-left ${it.danger ? 'text-red-600' : ''} ${it.cls ?? ''}`}
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
