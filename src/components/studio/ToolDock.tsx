import React, { useState } from 'react';
import {
  PenLine,
  Highlighter,
  Eraser,
  Lasso,
  Type,
  Hand,
  Pointer,
  PointerOff,
  Spline,
  Slash,
  Square,
  Circle,
  Dot,
} from 'lucide-react';
import { EraserMode, FillType, LineStyle, PenStyle, ShapeMode, ToolType } from '../../types';
import { ToolSettings } from '../CanvasPage';
import { StudioButton } from './StudioButton';
import { StudioSlider } from './StudioSlider';
import { StudioSegmented } from './StudioSegmented';
import { StudioColorGrid } from './StudioColorGrid';
import { StudioPopover } from './StudioPopover';
import { LineStylePicker } from '../LineStyles';
import { FILL_OPTIONS, FillSwatch } from '../Toolbar';

export interface ToolDockProps {
  tools: ToolSettings;
  setTools: (patch: Partial<ToolSettings>) => void;
  className?: string;
}

const PEN_WIDTH_RANGE = { min: 0.5, max: 24 };
const HIGHLIGHTER_WIDTH_RANGE = { min: 1, max: 20 };
const ERASER_SIZE_RANGE = { min: 2, max: 100 };

const HIGHLIGHTER_PRESETS = ['#FDE047', '#86EFAC', '#93C5FD', '#F9A8D4', '#C4B5FD', '#FDBA74'];

const SHAPE_MODES: { id: ShapeMode; label: string; icon: React.ReactNode }[] = [
  { id: 'curve', label: 'Curve', icon: <Spline className="w-4 h-4" /> },
  { id: 'line', label: 'Line', icon: <Slash className="w-4 h-4" /> },
  { id: 'rectangle', label: 'Rect', icon: <Square className="w-4 h-4" /> },
  { id: 'ellipse', label: 'Ellipse', icon: <Circle className="w-4 h-4" /> },
  { id: 'point', label: 'Point', icon: <Dot className="w-4 h-4" /> },
];

export const ToolDock: React.FC<ToolDockProps> = ({ tools, setTools, className = '' }) => {
  const [activePopover, setActivePopover] = useState<string | null>(null);

  const handleToolClick = (tool: ToolType) => {
    if (tools.tool === tool) {
      if (['pen', 'shape', 'highlighter', 'eraser'].includes(tool)) {
        setActivePopover((cur) => (cur === tool ? null : tool));
      }
    } else {
      setTools({ tool });
      setActivePopover(null);
    }
  };

  const closePopover = () => setActivePopover(null);

  const currentShapeIcon =
    SHAPE_MODES.find((m) => m.id === tools.shapeMode)?.icon ?? <Spline className="w-5 h-5" />;

  return (
    <div
      data-cutout-clear
      className={`relative z-40 flex items-center justify-center select-none ${className}`}
      data-no-pan
    >
      <div className="studio-glass-dock rounded-full px-2 py-1.5 flex items-center gap-1 sm:gap-1.5 shadow-2xl">
        {/* Pen Button */}
        <div className="relative">
          <StudioButton
            size="icon"
            variant="ghost"
            active={tools.tool === 'pen'}
            onClick={() => handleToolClick('pen')}
            className={`rounded-full transition-all ${
              tools.tool === 'pen'
                ? 'bg-white/20 text-white ring-2 ring-white/40 shadow-inner'
                : 'text-gray-300 hover:text-white'
            }`}
            title="Pen (tap again for options)"
          >
            <div className="relative flex items-center justify-center">
              <PenLine className="w-5 h-5" />
              <span
                className="absolute -bottom-1 w-2.5 h-2.5 rounded-full ring-1 ring-black/40 shadow-sm"
                style={{ backgroundColor: tools.penColor }}
              />
            </div>
          </StudioButton>

          <StudioPopover
            isOpen={activePopover === 'pen'}
            onClose={closePopover}
            placement="top"
            align="center"
          >
            <div className="space-y-3 text-left">
              <div>
                <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider block mb-1.5">
                  Type
                </span>
                <StudioSegmented<PenStyle>
                  size="sm"
                  value={tools.penStyle}
                  onChange={(s) => setTools({ penStyle: s })}
                  options={[
                    { id: 'fountain', label: 'Fountain' },
                    { id: 'ballpoint', label: 'Ballpoint' },
                  ]}
                />
              </div>

              <div>
                <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider block mb-1.5">
                  Line Style
                </span>
                <LineStylePicker
                  value={tools.penLineStyle}
                  onChange={(ls) => setTools({ penLineStyle: ls })}
                />
              </div>

              <div>
                <StudioSlider
                  label="Stroke Width"
                  value={tools.penWidth}
                  {...PEN_WIDTH_RANGE}
                  onChange={(v) => setTools({ penWidth: v })}
                />
              </div>

              <div>
                <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider block mb-1.5">
                  Ink Color
                </span>
                <StudioColorGrid
                  value={tools.penColor}
                  onChange={(c) => setTools({ penColor: c })}
                />
              </div>
            </div>
          </StudioPopover>
        </div>

        {/* Smart Pen / Shape Button */}
        <div className="relative">
          <StudioButton
            size="icon"
            variant="ghost"
            active={tools.tool === 'shape'}
            onClick={() => handleToolClick('shape')}
            className={`rounded-full transition-all ${
              tools.tool === 'shape'
                ? 'bg-white/20 text-white ring-2 ring-white/40 shadow-inner'
                : 'text-gray-300 hover:text-white'
            }`}
            title="Smart Draw & Shapes (tap again for options)"
          >
            <div className="relative flex items-center justify-center">
              {currentShapeIcon}
              <span
                className="absolute -bottom-1 w-2.5 h-2.5 rounded-full ring-1 ring-black/40 shadow-sm"
                style={{ backgroundColor: tools.shapeColor }}
              />
            </div>
          </StudioButton>

          <StudioPopover
            isOpen={activePopover === 'shape'}
            onClose={closePopover}
            placement="top"
            align="center"
          >
            <div className="space-y-3 text-left">
              <div>
                <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider block mb-1.5">
                  Mode
                </span>
                <StudioSegmented<ShapeMode>
                  size="sm"
                  value={tools.shapeMode}
                  onChange={(m) => setTools({ shapeMode: m })}
                  options={SHAPE_MODES}
                />
              </div>

              <div>
                <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider block mb-1.5">
                  Fill Style
                </span>
                <div className="grid grid-cols-6 gap-1.5">
                  {FILL_OPTIONS.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setTools({ shapeFill: f.id })}
                      className={`h-9 rounded-xl border flex items-center justify-center transition ${
                        tools.shapeFill === f.id
                          ? 'border-studio-accent bg-studio-accent-subtle shadow-sm'
                          : 'border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/5'
                      }`}
                      title={f.label}
                    >
                      <FillSwatch
                        fill={f.id}
                        color={
                          tools.shapeColor.toUpperCase() === '#FFFFFF'
                            ? '#9CA3AF'
                            : tools.shapeColor
                        }
                      />
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider block mb-1.5">
                  Line Style
                </span>
                <LineStylePicker
                  value={tools.shapeLineStyle}
                  onChange={(ls) => setTools({ shapeLineStyle: ls })}
                />
              </div>

              <div>
                <StudioSlider
                  label="Draw Width"
                  value={tools.shapeWidth}
                  {...PEN_WIDTH_RANGE}
                  onChange={(v) => setTools({ shapeWidth: v })}
                />
              </div>

              <div>
                <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider block mb-1.5">
                  Color
                </span>
                <StudioColorGrid
                  size="sm"
                  value={tools.shapeColor}
                  onChange={(c) => setTools({ shapeColor: c })}
                />
              </div>

              <div className="pt-2 border-t border-black/5 dark:border-white/5 space-y-1.5 text-xs text-gray-700 dark:text-gray-300">
                <label className="flex items-center justify-between cursor-pointer">
                  <span>Arrowhead on open lines</span>
                  <input
                    type="checkbox"
                    className="accent-studio-accent rounded"
                    checked={tools.shapeArrow}
                    onChange={(e) => setTools({ shapeArrow: e.target.checked })}
                  />
                </label>
                <label className="flex items-center justify-between cursor-pointer">
                  <span>Snap to shapes</span>
                  <input
                    type="checkbox"
                    className="accent-studio-accent rounded"
                    checked={tools.shapeSnap}
                    onChange={(e) => setTools({ shapeSnap: e.target.checked })}
                  />
                </label>
                <label className="flex items-center justify-between cursor-pointer">
                  <span>Snap to paper grid / dots</span>
                  <input
                    type="checkbox"
                    className="accent-studio-accent rounded"
                    checked={tools.shapeGridSnap}
                    onChange={(e) => setTools({ shapeGridSnap: e.target.checked })}
                  />
                </label>
              </div>
            </div>
          </StudioPopover>
        </div>

        {/* Highlighter Button */}
        <div className="relative">
          <StudioButton
            size="icon"
            variant="ghost"
            active={tools.tool === 'highlighter'}
            onClick={() => handleToolClick('highlighter')}
            className={`rounded-full transition-all ${
              tools.tool === 'highlighter'
                ? 'bg-white/20 text-white ring-2 ring-white/40 shadow-inner'
                : 'text-gray-300 hover:text-white'
            }`}
            title="Highlighter (tap again for options)"
          >
            <div className="relative flex items-center justify-center">
              <Highlighter className="w-5 h-5" />
              <span
                className="absolute -bottom-1 w-2.5 h-2.5 rounded-full ring-1 ring-black/40 shadow-sm"
                style={{ backgroundColor: tools.highlighterColor }}
              />
            </div>
          </StudioButton>

          <StudioPopover
            isOpen={activePopover === 'highlighter'}
            onClose={closePopover}
            placement="top"
            align="center"
          >
            <div className="space-y-3 text-left">
              <div>
                <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider block mb-1.5">
                  Color
                </span>
                <StudioColorGrid
                  presets={HIGHLIGHTER_PRESETS}
                  value={tools.highlighterColor}
                  onChange={(c) => setTools({ highlighterColor: c })}
                />
              </div>

              <div>
                <StudioSlider
                  label="Width"
                  value={tools.highlighterWidth}
                  {...HIGHLIGHTER_WIDTH_RANGE}
                  onChange={(v) => setTools({ highlighterWidth: v })}
                />
              </div>

              <div>
                <StudioSlider
                  label="Opacity"
                  value={tools.highlighterOpacity}
                  min={0.01}
                  max={1.0}
                  log={false}
                  unit=""
                  onChange={(v) => setTools({ highlighterOpacity: v })}
                />
              </div>
            </div>
          </StudioPopover>
        </div>

        {/* Eraser Button */}
        <div className="relative">
          <StudioButton
            size="icon"
            variant="ghost"
            active={tools.tool === 'eraser'}
            onClick={() => handleToolClick('eraser')}
            className={`rounded-full transition-all ${
              tools.tool === 'eraser'
                ? 'bg-white/20 text-white ring-2 ring-white/40 shadow-inner'
                : 'text-gray-300 hover:text-white'
            }`}
            title="Eraser (tap again for options)"
          >
            <Eraser className="w-5 h-5" />
          </StudioButton>

          <StudioPopover
            isOpen={activePopover === 'eraser'}
            onClose={closePopover}
            placement="top"
            align="center"
          >
            <div className="space-y-3 text-left">
              <div>
                <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider block mb-1.5">
                  Mode
                </span>
                <StudioSegmented<EraserMode>
                  size="sm"
                  value={tools.eraserMode}
                  onChange={(m) => setTools({ eraserMode: m })}
                  options={[
                    { id: 'stroke', label: 'Whole Stroke' },
                    { id: 'partial', label: 'Precision' },
                  ]}
                />
              </div>

              <div>
                <StudioSlider
                  label="Eraser Size"
                  value={tools.eraserSize}
                  {...ERASER_SIZE_RANGE}
                  onChange={(v) => setTools({ eraserSize: v })}
                />
              </div>
            </div>
          </StudioPopover>
        </div>

        <div className="w-px h-6 bg-white/15 mx-0.5" />

        {/* Lasso Button */}
        <StudioButton
          size="icon"
          variant="ghost"
          active={tools.tool === 'lasso'}
          onClick={() => handleToolClick('lasso')}
          className={`rounded-full transition-all ${
            tools.tool === 'lasso'
              ? 'bg-white/20 text-white ring-2 ring-white/40 shadow-inner'
              : 'text-gray-300 hover:text-white'
          }`}
          title="Lasso Selection"
        >
          <Lasso className="w-5 h-5" />
        </StudioButton>

        {/* Text Button */}
        <StudioButton
          size="icon"
          variant="ghost"
          active={tools.tool === 'text'}
          onClick={() => handleToolClick('text')}
          className={`rounded-full transition-all ${
            tools.tool === 'text'
              ? 'bg-white/20 text-white ring-2 ring-white/40 shadow-inner'
              : 'text-gray-300 hover:text-white'
          }`}
          title="Text Box"
        >
          <Type className="w-5 h-5" />
        </StudioButton>

        {/* Hand / Pan Button */}
        <StudioButton
          size="icon"
          variant="ghost"
          active={tools.tool === 'hand'}
          onClick={() => handleToolClick('hand')}
          className={`rounded-full transition-all ${
            tools.tool === 'hand'
              ? 'bg-white/20 text-white ring-2 ring-white/40 shadow-inner'
              : 'text-gray-300 hover:text-white'
          }`}
          title="Pan / Scroll Canvas"
        >
          <Hand className="w-5 h-5" />
        </StudioButton>

        <div className="w-px h-6 bg-white/15 mx-0.5" />

        {/* Stylus Lock Button */}
        <StudioButton
          size="icon"
          variant="ghost"
          active={!tools.stylusOnly}
          onClick={() => setTools({ stylusOnly: !tools.stylusOnly })}
          className={`rounded-full transition-all ${
            !tools.stylusOnly
              ? 'text-amber-300 bg-white/10'
              : 'text-gray-300 hover:text-white'
          }`}
          title={
            tools.stylusOnly
              ? 'Palm rejection active: Pencil only draws, fingers scroll. Tap to allow finger drawing.'
              : 'Finger drawing enabled. Tap for Pencil only (palm rejection).'
          }
        >
          {tools.stylusOnly ? <PointerOff className="w-5 h-5" /> : <Pointer className="w-5 h-5" />}
        </StudioButton>
      </div>
    </div>
  );
};
