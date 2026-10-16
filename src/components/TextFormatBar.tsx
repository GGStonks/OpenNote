import React from 'react';
import { Bold, Italic, Underline, Minus, Plus } from 'lucide-react';
import type { TextBlock } from '../types';
import { TEXT_FONTS, fontStack, nextTextSize } from '../editor/textStyle';

/** Ink colours offered for text (the pen's palette). */
const TEXT_COLORS = ['#111827', '#6B7280', '#1A73E8', '#D93025', '#188038', '#E37400', '#9B51E0', '#FFFFFF'];

/**
 * Formatting of the text box being edited: size, bold / italic / underline, typeface and colour.
 * It floats at the top of the writing area (the on-screen keyboard covers the bottom of the
 * screen). Every control acts on pointerdown with preventDefault, so the text being typed keeps the
 * keyboard focus: a focus change would end the editing (the box saves on blur).
 */
export const TextFormatBar: React.FC<{ block: TextBlock; onChange: (patch: Partial<TextBlock>) => void }> = ({ block, onChange }) => {
  const act = (fn: () => void) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    },
    // Keyboard (hardware keyboard, accessibility): the click still works.
    onClick: (e: React.MouseEvent) => {
      if (e.detail === 0) fn();
    },
  });
  const toggle = (on: boolean | undefined) =>
    `w-9 h-9 flex-shrink-0 flex items-center justify-center rounded-xl transition active:scale-90 ${on ? 'bg-blue-600 text-white' : 'hover:bg-white/10'}`;
  const family = block.fontFamily ?? 'sans';
  return (
    <div
      className="flex items-center gap-1 bg-ui-bar/95 backdrop-blur-xl text-white rounded-3xl shadow-2xl ring-1 ring-white/10 px-2 py-1.5 overflow-x-auto max-w-full text-sm font-semibold"
      data-no-pan
      data-text-format
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <button {...act(() => onChange({ fontSize: nextTextSize(block.fontSize, -1) }))} className={toggle(false)} title="Smaller text">
        <Minus className="w-4 h-4" />
      </button>
      <span className="w-9 text-center tabular-nums flex-shrink-0" title="Text size">{Math.round(block.fontSize)}</span>
      <button {...act(() => onChange({ fontSize: nextTextSize(block.fontSize, 1) }))} className={toggle(false)} title="Larger text">
        <Plus className="w-4 h-4" />
      </button>
      <div className="w-px h-7 bg-white/15 mx-1 flex-shrink-0" />
      <button {...act(() => onChange({ bold: !block.bold }))} className={toggle(block.bold)} title="Bold">
        <Bold className="w-4 h-4" />
      </button>
      <button {...act(() => onChange({ italic: !block.italic }))} className={toggle(block.italic)} title="Italic">
        <Italic className="w-4 h-4" />
      </button>
      <button {...act(() => onChange({ underline: !block.underline }))} className={toggle(block.underline)} title="Underline">
        <Underline className="w-4 h-4" />
      </button>
      <div className="w-px h-7 bg-white/15 mx-1 flex-shrink-0" />
      {TEXT_FONTS.map((f) => (
        <button
          key={f.id}
          {...act(() => onChange({ fontFamily: f.id }))}
          className={`px-2.5 h-9 flex-shrink-0 rounded-xl transition active:scale-95 ${family === f.id ? 'bg-blue-600 text-white' : 'hover:bg-white/10'}`}
          style={{ fontFamily: fontStack(f.id) }}
          title={`${f.label} typeface`}
        >
          {f.label}
        </button>
      ))}
      <div className="w-px h-7 bg-white/15 mx-1 flex-shrink-0" />
      {TEXT_COLORS.map((c) => (
        <button
          key={c}
          {...act(() => onChange({ color: c }))}
          className={`w-7 h-7 flex-shrink-0 rounded-full transition active:scale-90 ${block.color.toLowerCase() === c.toLowerCase() ? 'ring-2 ring-blue-400 ring-offset-2 ring-offset-gray-800' : 'ring-2 ring-white/30'}`}
          style={{ backgroundColor: c }}
          title="Text colour"
        />
      ))}
    </div>
  );
};
