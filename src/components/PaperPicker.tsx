import React from 'react';
import { PageOrientation, PageSize, PaperColor, PaperStyle } from '../types';
import { PAGE_SIZES, PAPER_COLOR_OPTIONS, PAPER_STYLE_OPTIONS, SetupPatch } from '../editor/pageSetup';
import { PAPER_COLORS, paperBackground } from './CanvasPage';

/**
 * Pattern, colour, orientation and format of paper: the note's default (toolbar) or the selected
 * pages (page manager). A null value means the pages differ ("mixed": nothing is highlighted).
 */
export interface PaperValues {
  paperStyle: PaperStyle | null;
  paperColor: PaperColor | null;
  size: PageSize | null;
  orientation: PageOrientation | null;
}

const Label: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-2 mt-2.5 first:mt-0.5">{children}</div>
);

const chip = (on: boolean) =>
  `rounded-xl text-xs font-medium border transition active:scale-95 ${
    on ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' : 'border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-300'
  }`;

export const PaperPicker: React.FC<{ value: PaperValues; onChange: (patch: SetupPatch) => void }> = ({ value, onChange }) => {
  const swatchColor = value.paperColor ?? 'white';
  return (
    <div>
      <Label>Pattern</Label>
      <div className="grid grid-cols-3 gap-1.5">
        {PAPER_STYLE_OPTIONS.map((o) => (
          <button key={o.id} onClick={() => onChange({ paperStyle: o.id })} className={chip(value.paperStyle === o.id) + ' p-1.5 flex flex-col items-center gap-1'} title={o.label}>
            <span className="block w-full h-9 rounded-md border border-black/10 overflow-hidden" style={{ ...paperBackground(o.id, swatchColor), backgroundPosition: undefined }} />
            <span className="leading-tight text-center">{o.label}</span>
          </button>
        ))}
      </div>
      <Label>Colour</Label>
      <div className="flex flex-wrap gap-2">
        {PAPER_COLOR_OPTIONS.map((o) => (
          <button
            key={o.id}
            onClick={() => onChange({ paperColor: o.id })}
            title={o.label}
            className={`w-9 h-9 rounded-full border-2 shadow-sm transition active:scale-90 ${value.paperColor === o.id ? 'border-blue-500 scale-110' : 'border-gray-300 dark:border-gray-600'}`}
            style={{ backgroundColor: PAPER_COLORS[o.id] }}
          />
        ))}
      </div>
      <Label>Orientation</Label>
      <div className="grid grid-cols-2 gap-1.5">
        {(['portrait', 'landscape'] as PageOrientation[]).map((o) => (
          <button key={o} onClick={() => onChange({ orientation: o })} className={chip(value.orientation === o) + ' px-2 py-2 flex items-center justify-center gap-2'}>
            <span className={`inline-block flex-shrink-0 border-2 border-current rounded-sm ${o === 'portrait' ? 'w-3 h-4' : 'w-4 h-3'}`} />
            {o === 'portrait' ? 'Portrait' : 'Landscape'}
          </button>
        ))}
      </div>
      <Label>Size</Label>
      <div className="grid grid-cols-3 gap-1.5">
        {(Object.keys(PAGE_SIZES) as PageSize[]).map((id) => (
          <button key={id} onClick={() => onChange({ size: id })} className={chip(value.size === id) + ' px-2 py-2'}>
            {PAGE_SIZES[id].label}
          </button>
        ))}
      </div>
    </div>
  );
};
