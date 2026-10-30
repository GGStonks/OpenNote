import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlignCenter, AlignLeft, AlignRight, Bold, CheckSquare, ChevronDown, IndentDecrease, IndentIncrease, Italic, List, ListOrdered,
  Minus, Plus, Square, Strikethrough, Underline,
} from 'lucide-react';
import { COLOUR_SPHERE, Spectrum } from './ColorPicker';
import type { ListKind, TextBlock } from '../types';
import { OnScreen } from './onScreen';
import { TEXT_FONTS, fontStack, nextTextSize } from '../editor/textStyle';
import { activeTextEditor } from '../editor/textEditing';
import { useBack } from '../services/backStack';

/** Ink colours offered for text (the pen's palette). */
const TEXT_COLORS = ['#111827', '#6B7280', '#1A73E8', '#D93025', '#188038', '#E37400', '#9B51E0', '#FFFFFF'];
/** Box colours offered (light, so text stays readable on them); null: no box. */
const BOX_COLORS: (string | null)[] = [null, '#FFF4B8', '#FFE0B2', '#FADADD', '#E1F0FF', '#DDF3E4', '#EDE7F6', '#ECEFF1', '#FFFFFF', '#1F2937'];
/** Space added around the text when a box gets a colour (px: sideways, up and down). */
const BOX_PADDING: [number, number] = [8, 5];
const MAX_RADIUS = 40;

/**
 * Formatting of the text box being edited: size, bold / italic / underline / strikethrough,
 * alignment, typeface, lists (acting on the paragraphs selected in the editor), colour, and the
 * box (its colour and the rounding of its corners). It floats at the top of the writing area (the
 * on-screen keyboard covers the bottom of the screen). Every control acts on pointerdown with
 * preventDefault, so the text being typed keeps the keyboard focus: a focus change would end the
 * editing (the box saves on blur). Menus open over the page (the bar scrolls sideways and would
 * cut them off); colours and the corner rounding are picked with the pointer only (an input box
 * would take the focus).
 */

/** A menu under `anchor`, over the page, kept on the screen. */
const Floating: React.FC<{ anchor: DOMRect; width: number; children: React.ReactNode }> = ({ anchor, width, children }) => {
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, anchor.left));
  return createPortal(
    <OnScreen
      data-no-pan
      data-text-format
      className="fixed z-[200] bg-ui-bar/95 backdrop-blur-xl text-white rounded-2xl shadow-2xl ring-1 ring-white/10 p-1.5 max-h-[calc(100dvh-16px)] overflow-y-auto no-scrollbar"
      style={{ left, top: Math.min(anchor.bottom + 6, window.innerHeight - 60), width }}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {children}
    </OnScreen>,
    document.body
  );
};

/** A slider set by dragging (no focus taken). */
const DragSlider: React.FC<{ value: number; max: number; onChange: (v: number) => void }> = ({ value, max, onChange }) => {
  const ref = useRef<HTMLDivElement>(null);
  const set = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    onChange(Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * max));
  };
  return (
    <div
      ref={ref}
      className="relative h-8 mx-1 cursor-pointer touch-none"
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        set(e);
      }}
      onPointerMove={(e) => {
        if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) set(e);
      }}
    >
      <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-white/20" />
      <div className="absolute left-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-blue-500" style={{ width: `${(value / max) * 100}%` }} />
      <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-5 h-5 rounded-full bg-white shadow" style={{ left: `${(value / max) * 100}%` }} />
    </div>
  );
};

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
  const [open, setOpen] = useState<{ what: 'font' | 'colour' | 'box'; at: DOMRect } | null>(null);
  useBack(!!open, () => setOpen(null));
  const toggleMenu = (what: 'font' | 'colour' | 'box') => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const at = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setOpen((o) => (o?.what === what ? null : { what, at }));
  };
  const current = TEXT_FONTS.find((f) => f.id === family) ?? TEXT_FONTS[0];
  // The caret's list kind (the list buttons show it), followed as the caret moves.
  const [list, setList] = useState<ListKind | null>(null);
  useEffect(() => {
    const update = () => setList(activeTextEditor.current?.listAtCaret() ?? null);
    update();
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
  }, []);
  const listButton = (kind: ListKind, icon: React.ReactNode, title: string) => (
    <button
      {...act(() => {
        activeTextEditor.current?.toggleList(kind);
        setList(activeTextEditor.current?.listAtCaret() ?? null);
      })}
      className={toggle(list === kind)}
      title={title}
    >
      {icon}
    </button>
  );
  /** A box colour: the text keeps its place (the box grows around it by its padding). */
  const setBox = (c: string | null) => {
    if (!c) return onChange({ background: undefined });
    if (block.padding) return onChange({ background: c });
    const [px, py] = BOX_PADDING;
    onChange({ background: c, padding: BOX_PADDING, x: block.x - px, y: block.y - py, width: block.width + 2 * px, ...(block.height ? { height: block.height + 2 * py } : {}) });
  };
  const sep = <div className="w-px h-7 bg-white/15 mx-1 flex-shrink-0" />;
  const groups = [...new Set(TEXT_FONTS.map((f) => f.group))];
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
      {sep}
      <button {...act(() => onChange({ bold: !block.bold }))} className={toggle(block.bold)} title="Bold">
        <Bold className="w-4 h-4" />
      </button>
      <button {...act(() => onChange({ italic: !block.italic }))} className={toggle(block.italic)} title="Italic">
        <Italic className="w-4 h-4" />
      </button>
      <button {...act(() => onChange({ underline: !block.underline }))} className={toggle(block.underline)} title="Underline">
        <Underline className="w-4 h-4" />
      </button>
      <button {...act(() => onChange({ strike: !block.strike }))} className={toggle(block.strike)} title="Strikethrough">
        <Strikethrough className="w-4 h-4" />
      </button>
      {sep}
      {(['left', 'center', 'right'] as const).map((a) => (
        <button
          key={a}
          {...act(() => onChange({ align: a === 'left' ? undefined : a, paras: block.paras?.map(({ align: _drop, ...q }) => q) }))}
          className={toggle((block.align ?? 'left') === a)}
          title={a === 'left' ? 'Align left' : a === 'center' ? 'Centre' : 'Align right'}
        >
          {a === 'left' ? <AlignLeft className="w-4 h-4" /> : a === 'center' ? <AlignCenter className="w-4 h-4" /> : <AlignRight className="w-4 h-4" />}
        </button>
      ))}
      {sep}
      <button
        onPointerDown={toggleMenu('font')}
        className={`px-2.5 h-9 flex-shrink-0 rounded-xl flex items-center gap-1.5 transition active:scale-95 whitespace-nowrap ${open?.what === 'font' ? 'bg-white/15' : 'hover:bg-white/10'}`}
        style={{ fontFamily: fontStack(current.id) }}
        title="Typeface"
      >
        {current.label}
        <ChevronDown className="w-3.5 h-3.5 opacity-70" />
      </button>
      {open?.what === 'font' && (
        <Floating anchor={open.at} width={240}>
          {groups.map((g) => (
            <div key={g}>
              <div className="px-3 pt-2 pb-1 text-[11px] uppercase tracking-wide text-white/50">{g}</div>
              {TEXT_FONTS.filter((f) => f.group === g).map((f) => (
                <button
                  key={f.id}
                  {...act(() => {
                    onChange({ fontFamily: f.id });
                    setOpen(null);
                  })}
                  className={`w-full text-left px-3 py-2 rounded-xl text-[16px] ${family === f.id ? 'bg-blue-600 text-white' : 'hover:bg-white/10'}`}
                  style={{ fontFamily: fontStack(f.id) }}
                >
                  {f.label}
                </button>
              ))}
            </div>
          ))}
        </Floating>
      )}
      {sep}
      {listButton('bullet', <List className="w-4 h-4" />, 'Bulleted list')}
      {listButton('number', <ListOrdered className="w-4 h-4" />, 'Numbered list')}
      {listButton('letter', <span className="text-[13px] font-bold leading-none">a.</span>, 'Lettered list')}
      {listButton('check', <CheckSquare className="w-4 h-4" />, 'Checklist')}
      <button {...act(() => activeTextEditor.current?.indent(-1))} className={toggle(false)} title="Outdent">
        <IndentDecrease className="w-4 h-4" />
      </button>
      <button {...act(() => activeTextEditor.current?.indent(1))} className={toggle(false)} title="Indent">
        <IndentIncrease className="w-4 h-4" />
      </button>
      {sep}
      {TEXT_COLORS.map((c) => (
        <button
          key={c}
          {...act(() => onChange({ color: c }))}
          className={`w-7 h-7 flex-shrink-0 rounded-full transition active:scale-90 ${block.color.toLowerCase() === c.toLowerCase() ? 'ring-2 ring-blue-400 ring-offset-2 ring-offset-gray-800' : 'ring-2 ring-white/30'}`}
          style={{ backgroundColor: c }}
          title="Text colour"
        />
      ))}
      <button
        onPointerDown={toggleMenu('colour')}
        className={`w-7 h-7 flex-shrink-0 rounded-full flex items-center justify-center transition active:scale-90 ${open?.what === 'colour' ? 'ring-2 ring-blue-400 ring-offset-2 ring-offset-gray-800' : ''}`}
        style={COLOUR_SPHERE}
        title="Any colour"
      >
        <Plus className="w-3 h-3 text-gray-700" strokeWidth={3} />
      </button>
      {open?.what === 'colour' && (
        <Floating anchor={open.at} width={240}>
          <div className="p-1.5">
            <Spectrum value={block.color} onChange={(c) => onChange({ color: c })} pointerOnly />
          </div>
        </Floating>
      )}
      {sep}
      <button
        onPointerDown={toggleMenu('box')}
        className={`px-2.5 h-9 flex-shrink-0 rounded-xl flex items-center gap-1.5 transition active:scale-95 ${open?.what === 'box' ? 'bg-white/15' : 'hover:bg-white/10'}`}
        title="Box colour and corners"
      >
        <Square className="w-4 h-4" style={{ fill: block.background ?? 'none', borderRadius: 3 }} />
        Box
        <ChevronDown className="w-3.5 h-3.5 opacity-70" />
      </button>
      {open?.what === 'box' && (
        <Floating anchor={open.at} width={260}>
          <div className="px-2 pt-1 pb-1 text-[11px] uppercase tracking-wide text-white/50">Box colour</div>
          <div className="grid grid-cols-5 gap-1.5 px-1.5 pb-2">
            {BOX_COLORS.map((c) => (
              <button
                key={c ?? 'none'}
                {...act(() => setBox(c))}
                className={`h-9 rounded-xl flex items-center justify-center text-[11px] ${(block.background ?? null) === c ? 'ring-2 ring-blue-400' : 'ring-1 ring-white/25'}`}
                style={{ backgroundColor: c ?? 'transparent' }}
                title={c ? 'Box colour' : 'No box colour'}
              >
                {c ? '' : 'None'}
              </button>
            ))}
          </div>
          <div className="px-1.5 pb-1">
            <Spectrum value={block.background ?? '#FFF4B8'} onChange={(c) => setBox(c)} pointerOnly />
          </div>
          <div className="px-2 pt-2 flex items-center justify-between text-[11px] uppercase tracking-wide text-white/50">
            <span>Corner rounding</span>
            <span className="tabular-nums normal-case text-white/80 text-xs">{Math.round(block.radius ?? 0)} px</span>
          </div>
          <DragSlider value={Math.min(MAX_RADIUS, block.radius ?? 0)} max={MAX_RADIUS} onChange={(v) => onChange({ radius: v || undefined })} />
        </Floating>
      )}
    </div>
  );
};
