import React, { useEffect, useRef, useState } from 'react';
import { PageOrientation, PageSize, PaperColor, PaperStyle } from '../types';
import { PAGE_SIZES, PAPER_COLOR_OPTIONS, PAPER_STYLE_OPTIONS, SetupPatch } from '../editor/pageSetup';
import { PAPER_COLORS, paperBackground, paperHex } from './CanvasPage';
import { ColorPicker } from './ColorPicker';

/**
 * Pattern, colour, orientation and format of paper: the note's default (toolbar) or the selected
 * pages (page manager). A null value means the pages differ ("mixed": nothing is highlighted).
 */
export interface PaperValues {
  paperStyle: PaperStyle | null;
  paperColor: PaperColor | null;
  /** Pattern colour (#RRGGBB); null: the default (or the pages differ). */
  patternColor: string | null;
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

const PAPER_PRESETS = PAPER_COLOR_OPTIONS.map((o) => PAPER_COLORS[o.id]);
/** Pattern colours offered besides any colour: blue (as ruled lines), grey, black, red, green, purple. */
const PATTERN_PRESETS = ['#3B82F6', '#9CA3AF', '#111827', '#EF4444', '#16A34A', '#7C3AED'];

/** A colour picked for the paper: the named colour when it is one of them (dark paper stays 'dark'). */
const paperColorOf = (hex: string): PaperColor => PAPER_COLOR_OPTIONS.find((o) => PAPER_COLORS[o.id].toUpperCase() === hex.toUpperCase())?.id ?? (hex.toUpperCase() as PaperColor);

/** A colour being dragged in the spectrum reaches the note this long after the last move (one undo step, not one per move). */
const COLOUR_SETTLE_MS = 150;

export const PaperPicker: React.FC<{ value: PaperValues; onChange: (patch: SetupPatch) => void }> = ({ value: given, onChange }) => {
  const [pending, setPending] = useState<SetupPatch | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useRef<() => void>(() => undefined);
  flush.current = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (pending) onChange(pending);
    setPending(null);
  };
  useEffect(() => () => flush.current(), []);
  const setColour = (patch: SetupPatch) => {
    setPending((p) => ({ ...p, ...patch }));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => flush.current(), COLOUR_SETTLE_MS);
  };
  const value = pending ? { ...given, ...pending } : given;
  const swatchColor = value.paperColor ?? 'white';
  const pattern = value.patternColor ?? null;
  return (
    <div>
      <Label>Pattern</Label>
      <div className="grid grid-cols-3 gap-1.5">
        {PAPER_STYLE_OPTIONS.map((o) => (
          <button key={o.id} onClick={() => onChange({ paperStyle: o.id })} className={chip(value.paperStyle === o.id) + ' p-1.5 flex flex-col items-center gap-1'} title={o.label}>
            <span className="block w-full h-9 rounded-md border border-black/10 overflow-hidden" style={paperBackground(o.id, swatchColor, undefined, 1, true, pattern)} />
            <span className="leading-tight text-center">{o.label}</span>
          </button>
        ))}
      </div>
      <Label>Colour</Label>
      <ColorPicker value={value.paperColor ? paperHex(value.paperColor) : ''} onChange={(c) => setColour({ paperColor: paperColorOf(c) })} presets={PAPER_PRESETS} />
      {value.paperStyle !== 'blank' && (
        <>
          <div className="flex items-center justify-between">
            <Label>Pattern colour</Label>
            <button onClick={() => setColour({ patternColor: null })} className={chip(!pattern) + ' px-2 py-0.5 mt-0.5'}>
              Default
            </button>
          </div>
          <ColorPicker value={pattern ?? ''} onChange={(c) => setColour({ patternColor: c.toUpperCase() })} presets={PATTERN_PRESETS} size="sm" />
        </>
      )}
      <Label>Orientation</Label>
      <div className="grid grid-cols-2 gap-1.5">
        {(['portrait', 'landscape'] as PageOrientation[]).map((o) => (
          <button key={o} onClick={() => onChange({ orientation: o })} className={chip(value.orientation === o) + ' min-w-0 px-1 py-2 flex flex-col items-center justify-center gap-1'}>
            {/* Both shapes in the same 20 px box, so they line up; the label stacked below fits a narrow panel. */}
            <span className="w-5 h-5 flex-shrink-0 flex items-center justify-center">
              <span className={`block border-2 border-current rounded-[3px] ${o === 'portrait' ? 'w-3.5 h-[18px]' : 'w-[18px] h-3.5'}`} />
            </span>
            <span className="text-[11px] leading-tight max-w-full truncate">{o === 'portrait' ? 'Portrait' : 'Landscape'}</span>
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
