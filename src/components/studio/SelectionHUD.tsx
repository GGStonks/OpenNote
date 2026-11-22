import React, { useState } from 'react';
import {
  Sparkles,
  FileText,
  Share2,
  Wand2,
  Shapes,
  PaintBucket,
  MoveUpRight,
  Scissors,
  ClipboardCopy,
  Share,
  CopyPlus,
  Trash2,
  X,
} from 'lucide-react';
import { FillType, LineStyle } from '../../types';
import { StudioButton } from './StudioButton';
import { LINE_STYLES, LineStyleIcon } from '../LineStyles';
import { FILL_OPTIONS, FillSwatch } from '../Toolbar';

export interface SelectionHUDProps {
  hasInk: boolean;
  onConvertMath: () => void;
  onConvertText: () => void;
  onConvertTikz: () => void;
  onVectorize: () => void;
  onSnap: () => void;
  onRecolor: (color: string) => void;
  onRestyleLine: (style: LineStyle) => void;
  onFill: (fill: FillType) => void;
  onToggleArrow: () => void;
  onCut: () => void;
  onCopy: () => void;
  onExportSvg: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onDeselect: () => void;
}

const QUICK_COLORS = ['#111827', '#1A73E8', '#D93025', '#188038', '#9B51E0'];

export const SelectionHUD: React.FC<SelectionHUDProps> = ({
  hasInk,
  onConvertMath,
  onConvertText,
  onConvertTikz,
  onVectorize,
  onSnap,
  onRecolor,
  onRestyleLine,
  onFill,
  onToggleArrow,
  onCut,
  onCopy,
  onExportSvg,
  onDuplicate,
  onDelete,
  onDeselect,
}) => {
  const [fillMenuOpen, setFillMenuOpen] = useState(false);

  return (
    <div
      data-cutout-clear
      className="fixed left-0 right-0 z-40 flex flex-col items-center justify-center px-3 pointer-events-none"
      style={{ bottom: `calc(72px + var(--sa-bottom))` }}
      data-no-pan
    >
      {/* Fill sub-menu if toggled */}
      {fillMenuOpen && hasInk && (
        <div className="pointer-events-auto mb-2 animate-in fade-in slide-in-from-bottom-2 duration-150">
          <div className="studio-glass-dock rounded-2xl px-2.5 py-1.5 flex items-center gap-2 text-xs text-white">
            {FILL_OPTIONS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => {
                  onFill(f.id);
                  setFillMenuOpen(false);
                }}
                className="flex flex-col items-center gap-1 px-2 py-1 rounded-xl hover:bg-white/10 active:scale-95 transition"
                title={f.label}
              >
                <FillSwatch fill={f.id} color="#E5E7EB" />
                <span className="text-[10px] font-medium">{f.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Main Selection Bar */}
      <div className="pointer-events-auto studio-glass-dock rounded-full px-3 py-1.5 flex items-center gap-1 sm:gap-1.5 text-white max-w-full overflow-x-auto no-scrollbar shadow-2xl">
        {hasInk && (
          <>
            {/* AI Transcriptions */}
            <StudioButton
              size="xs"
              variant="primary"
              onClick={onConvertMath}
              className="bg-blue-600 rounded-full text-xs font-semibold px-3"
              title="Transcribe math to LaTeX (Qwen3-VL)"
            >
              <Sparkles className="w-3.5 h-3.5 mr-1" />
              LaTeX
            </StudioButton>

            <StudioButton
              size="xs"
              variant="ghost"
              onClick={onConvertText}
              className="bg-white/10 text-white rounded-full text-xs font-medium px-2.5"
              title="Transcribe notes (text + math)"
            >
              <FileText className="w-3.5 h-3.5 mr-1" />
              Notes
            </StudioButton>

            <StudioButton
              size="xs"
              variant="ghost"
              onClick={onConvertTikz}
              className="bg-indigo-600/80 text-white rounded-full text-xs font-medium px-2.5"
              title="Transcribe diagram to TikZ (Qwen3-VL)"
            >
              <Share2 className="w-3.5 h-3.5 mr-1" />
              TikZ
            </StudioButton>

            <StudioButton
              size="xs"
              variant="ghost"
              onClick={onVectorize}
              className="bg-white/10 text-white rounded-full text-xs font-medium px-2.5"
              title="Vectorize geometry offline"
            >
              <Wand2 className="w-3.5 h-3.5 mr-1" />
              Vector
            </StudioButton>

            <StudioButton
              size="icon-sm"
              variant="ghost"
              onClick={onSnap}
              title="Snap strokes to geometric shape"
              className="text-gray-300 hover:text-white rounded-full"
            >
              <Shapes className="w-4 h-4" />
            </StudioButton>

            <div className="w-px h-5 bg-white/15 mx-0.5 flex-shrink-0" />

            {/* Quick 5 Recoloring */}
            <div className="flex items-center gap-1 flex-shrink-0">
              {QUICK_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => onRecolor(c)}
                  className="w-5 h-5 rounded-full ring-1 ring-white/30 transition active:scale-90"
                  style={{ backgroundColor: c }}
                  title="Recolor selection"
                />
              ))}
            </div>

            <div className="w-px h-5 bg-white/15 mx-0.5 flex-shrink-0" />

            {/* Line Styles */}
            <div className="flex items-center gap-0.5 flex-shrink-0">
              {LINE_STYLES.map((ls) => (
                <button
                  key={ls.id}
                  type="button"
                  onClick={() => onRestyleLine(ls.id)}
                  className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-300 hover:text-white hover:bg-white/10 active:scale-90 transition"
                  title={ls.label}
                >
                  <LineStyleIcon style={ls.id} width={18} />
                </button>
              ))}
            </div>

            {/* Fill Menu Toggle */}
            <StudioButton
              size="icon-sm"
              variant="ghost"
              active={fillMenuOpen}
              onClick={() => setFillMenuOpen((v) => !v)}
              className="text-gray-300 hover:text-white rounded-full"
              title="Fill closed shapes"
            >
              <PaintBucket className="w-4 h-4" />
            </StudioButton>

            {/* Arrowhead toggle */}
            <StudioButton
              size="icon-sm"
              variant="ghost"
              onClick={onToggleArrow}
              className="text-gray-300 hover:text-white rounded-full"
              title="Toggle arrowhead"
            >
              <MoveUpRight className="w-4 h-4" />
            </StudioButton>

            <div className="w-px h-5 bg-white/15 mx-0.5 flex-shrink-0" />
          </>
        )}

        {/* Standard Operations */}
        <StudioButton
          size="icon-sm"
          variant="ghost"
          onClick={onCut}
          className="text-gray-300 hover:text-white rounded-full"
          title="Cut"
        >
          <Scissors className="w-4 h-4" />
        </StudioButton>

        <StudioButton
          size="icon-sm"
          variant="ghost"
          onClick={onCopy}
          className="text-gray-300 hover:text-white rounded-full"
          title="Copy"
        >
          <ClipboardCopy className="w-4 h-4" />
        </StudioButton>

        <StudioButton
          size="icon-sm"
          variant="ghost"
          onClick={onExportSvg}
          className="text-gray-300 hover:text-white rounded-full"
          title="Export selection as SVG"
        >
          <Share className="w-4 h-4" />
        </StudioButton>

        <StudioButton
          size="icon-sm"
          variant="ghost"
          onClick={onDuplicate}
          className="text-gray-300 hover:text-white rounded-full"
          title="Duplicate"
        >
          <CopyPlus className="w-4 h-4" />
        </StudioButton>

        <StudioButton
          size="icon-sm"
          variant="ghost"
          onClick={onDelete}
          className="text-red-400 hover:text-red-300 rounded-full"
          title="Delete"
        >
          <Trash2 className="w-4 h-4" />
        </StudioButton>

        <StudioButton
          size="icon-sm"
          variant="ghost"
          onClick={onDeselect}
          className="text-gray-400 hover:text-white rounded-full"
          title="Done"
        >
          <X className="w-4 h-4" />
        </StudioButton>
      </div>
    </div>
  );
};
