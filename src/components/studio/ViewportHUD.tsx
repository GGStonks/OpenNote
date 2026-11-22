import React from 'react';
import { Minus, Plus, Maximize, MoveHorizontal } from 'lucide-react';
import { FitMode } from '../../editor/useViewport';

export interface ViewportHUDProps {
  currentPage: number;
  totalPages: number;
  zoom: number;
  maxZoom: number;
  fitMode: FitMode;
  onZoomBy: (factor: number) => void;
  onToggleFit: () => void;
  className?: string;
  style?: React.CSSProperties;
}

export const ViewportHUD: React.FC<ViewportHUDProps> = ({
  currentPage,
  totalPages,
  zoom,
  maxZoom,
  fitMode,
  onZoomBy,
  onToggleFit,
  className = '',
  style,
}) => {
  return (
    <div
      data-cutout-clear
      data-no-pan
      style={style}
      className={`absolute right-[calc(0.75rem+var(--sa-right))] z-30 flex items-center gap-1.5 select-none ${className}`}
    >
      {/* Page indicator */}
      <div className="pointer-events-none px-3 py-1.5 rounded-full bg-black/60 text-white text-xs font-semibold tabular-nums backdrop-blur-md shadow-md border border-white/10">
        {currentPage} / {totalPages}
      </div>

      {/* Zoom pill */}
      <div className="flex items-center rounded-full bg-black/60 text-white text-xs font-semibold tabular-nums backdrop-blur-md shadow-md border border-white/10 overflow-hidden">
        <button
          type="button"
          onClick={() => onZoomBy(0.8)}
          className="hidden sm:flex px-2 py-1.5 hover:bg-white/10 active:scale-95 transition"
          title="Zoom out"
        >
          <Minus className="w-3.5 h-3.5" />
        </button>

        <button
          type="button"
          onClick={onToggleFit}
          className="flex items-center gap-1 px-2.5 py-1.5 hover:bg-white/10 active:scale-95 transition font-mono"
          title={fitMode === 'width' ? 'Fit full page' : 'Fit page width'}
        >
          {fitMode === 'width' ? (
            <Maximize className="w-3 h-3 text-studio-accent" />
          ) : (
            <MoveHorizontal className="w-3 h-3" />
          )}
          <span>{Math.round(zoom * 100)}%</span>
        </button>

        <button
          type="button"
          onClick={() => onZoomBy(1.25)}
          disabled={zoom >= maxZoom - 1e-3}
          className="hidden sm:flex px-2 py-1.5 hover:bg-white/10 disabled:opacity-40 active:scale-95 transition"
          title="Zoom in"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
