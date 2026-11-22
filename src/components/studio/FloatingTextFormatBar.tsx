import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  CheckSquare,
  ChevronDown,
  IndentDecrease,
  IndentIncrease,
  Italic,
  List,
  ListOrdered,
  Minus,
  Plus,
  Square,
  Strikethrough,
  Underline,
} from 'lucide-react';
import { COLOUR_SPHERE, Spectrum } from '../ColorPicker';
import type { ListKind, TextBlock } from '../../types';
import { OnScreen } from '../onScreen';
import { TEXT_FONTS, fontStack, nextTextSize } from '../../editor/textStyle';
import { activeTextEditor } from '../../editor/textEditing';
import { useBack } from '../../services/backStack';

const TEXT_COLORS = ['#111827', '#6B7280', '#1A73E8', '#D93025', '#188038', '#E37400', '#9B51E0', '#FFFFFF'];
const BOX_COLORS: (string | null)[] = [
  null,
  '#FFF4B8',
  '#FFE0B2',
  '#FADADD',
  '#E1F0FF',
  '#DDF3E4',
  '#EDE7F6',
  '#ECEFF1',
  '#FFFFFF',
  '#1F2937',
];
const BOX_PADDING: [number, number] = [8, 5];
const MAX_RADIUS = 40;

const Floating: React.FC<{ anchor: DOMRect; width: number; children: React.ReactNode }> = ({
  anchor,
  width,
  children,
}) => {
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, anchor.left));
  return createPortal(
    <OnScreen
      data-no-pan
      data-text-format
      className="fixed z-[200] studio-glass-dock text-white rounded-2xl shadow-2xl p-2 max-h-[calc(100dvh-20px)] overflow-y-auto no-scrollbar"
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

const DragSlider: React.FC<{ value: number; max: number; onChange: (v: number) => void }> = ({
  value,
  max,
  onChange,
}) => {
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
      <div
        className="absolute left-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-studio-accent"
        style={{ width: `${(value / max) * 100}%` }}
      />
      <div
        className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-5 h-5 rounded-full bg-white shadow"
        style={{ left: `${(value / max) * 100}%` }}
      />
    </div>
  );
};

export interface FloatingTextFormatBarProps {
  block: TextBlock;
  onChange: (patch: Partial<TextBlock>) => void;
}

export const FloatingTextFormatBar: React.FC<FloatingTextFormatBarProps> = ({ block, onChange }) => {
  const act = (fn: () => void) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    },
    onClick: (e: React.MouseEvent) => {
      if (e.detail === 0) fn();
    },
  });

  const toggle = (on: boolean | undefined) =>
    `w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-xl transition active:scale-90 ${
      on ? 'bg-studio-accent text-white shadow-sm' : 'text-gray-300 hover:text-white hover:bg-white/10'
    }`;

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

  const setBox = (c: string | null) => {
    if (!c) return onChange({ background: undefined });
    if (block.padding) return onChange({ background: c });
    const [px, py] = BOX_PADDING;
    onChange({
      background: c,
      padding: BOX_PADDING,
      x: block.x - px,
      y: block.y - py,
      width: block.width + 2 * px,
      ...(block.height ? { height: block.height + 2 * py } : {}),
    });
  };

  const sep = <div className="w-px h-6 bg-white/15 mx-0.5 flex-shrink-0" />;
  const groups = [...new Set(TEXT_FONTS.map((f) => f.group))];

  return (
    <div
      className="flex items-center gap-1 studio-glass-dock text-white rounded-full px-2.5 py-1.5 overflow-x-auto max-w-full text-xs font-medium shadow-2xl select-none"
      data-no-pan
      data-text-format
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {/* Font Size Stepper */}
      <button
        {...act(() => onChange({ fontSize: nextTextSize(block.fontSize, -1) }))}
        className={toggle(false)}
        title="Smaller text"
      >
        <Minus className="w-3.5 h-3.5" />
      </button>
      <span className="w-7 text-center tabular-nums font-mono flex-shrink-0" title="Text size">
        {Math.round(block.fontSize)}
      </span>
      <button
        {...act(() => onChange({ fontSize: nextTextSize(block.fontSize, 1) }))}
        className={toggle(false)}
        title="Larger text"
      >
        <Plus className="w-3.5 h-3.5" />
      </button>

      {sep}

      {/* Typography toggles */}
      <button {...act(() => onChange({ bold: !block.bold }))} className={toggle(block.bold)} title="Bold">
        <Bold className="w-3.5 h-3.5" />
      </button>
      <button {...act(() => onChange({ italic: !block.italic }))} className={toggle(block.italic)} title="Italic">
        <Italic className="w-3.5 h-3.5" />
      </button>
      <button {...act(() => onChange({ underline: !block.underline }))} className={toggle(block.underline)} title="Underline">
        <Underline className="w-3.5 h-3.5" />
      </button>
      <button {...act(() => onChange({ strike: !block.strike }))} className={toggle(block.strike)} title="Strikethrough">
        <Strikethrough className="w-3.5 h-3.5" />
      </button>

      {sep}

      {/* Alignment */}
      {(['left', 'center', 'right'] as const).map((a) => (
        <button
          key={a}
          {...act(() =>
            onChange({
              align: a === 'left' ? undefined : a,
              paras: block.paras?.map(({ align: _drop, ...q }) => q),
            })
          )}
          className={toggle((block.align ?? 'left') === a)}
          title={a === 'left' ? 'Align left' : a === 'center' ? 'Center' : 'Align right'}
        >
          {a === 'left' ? <AlignLeft className="w-3.5 h-3.5" /> : a === 'center' ? <AlignCenter className="w-3.5 h-3.5" /> : <AlignRight className="w-3.5 h-3.5" />}
        </button>
      ))}

      {sep}

      {/* Typeface selector */}
      <button
        onPointerDown={toggleMenu('font')}
        className={`px-2.5 h-8 flex-shrink-0 rounded-xl flex items-center gap-1 transition active:scale-95 whitespace-nowrap ${
          open?.what === 'font' ? 'bg-white/20' : 'hover:bg-white/10'
        }`}
        style={{ fontFamily: fontStack(current.id) }}
        title="Typeface"
      >
        <span>{current.label}</span>
        <ChevronDown className="w-3 h-3 opacity-70" />
      </button>

      {open?.what === 'font' && (
        <Floating anchor={open.at} width={240}>
          {groups.map((g) => (
            <div key={g}>
              <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-white/50 font-bold">
                {g}
              </div>
              {TEXT_FONTS.filter((f) => f.group === g).map((f) => (
                <button
                  key={f.id}
                  {...act(() => {
                    onChange({ fontFamily: f.id });
                    setOpen(null);
                  })}
                  className={`w-full text-left px-3 py-1.5 rounded-xl text-sm ${
                    family === f.id ? 'bg-studio-accent text-white' : 'hover:bg-white/10 text-gray-200'
                  }`}
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

      {/* Lists */}
      {listButton('bullet', <List className="w-3.5 h-3.5" />, 'Bulleted list')}
      {listButton('number', <ListOrdered className="w-3.5 h-3.5" />, 'Numbered list')}
      {listButton('letter', <span className="text-xs font-bold leading-none">a.</span>, 'Lettered list')}
      {listButton('check', <CheckSquare className="w-3.5 h-3.5" />, 'Checklist')}
      <button {...act(() => activeTextEditor.current?.indent(-1))} className={toggle(false)} title="Outdent">
        <IndentDecrease className="w-3.5 h-3.5" />
      </button>
      <button {...act(() => activeTextEditor.current?.indent(1))} className={toggle(false)} title="Indent">
        <IndentIncrease className="w-3.5 h-3.5" />
      </button>

      {sep}

      {/* Colors */}
      {TEXT_COLORS.map((c) => (
        <button
          key={c}
          {...act(() => onChange({ color: c }))}
          className={`w-5 h-5 flex-shrink-0 rounded-full transition active:scale-90 ${
            block.color.toLowerCase() === c.toLowerCase()
              ? 'ring-2 ring-studio-accent ring-offset-2 ring-offset-gray-900'
              : 'ring-1 ring-white/30'
          }`}
          style={{ backgroundColor: c }}
          title="Text color"
        />
      ))}
      <button
        onPointerDown={toggleMenu('colour')}
        className={`w-5 h-5 flex-shrink-0 rounded-full flex items-center justify-center transition active:scale-90 ${
          open?.what === 'colour' ? 'ring-2 ring-studio-accent ring-offset-2 ring-offset-gray-900' : ''
        }`}
        style={COLOUR_SPHERE}
        title="Custom color"
      >
        <Plus className="w-2.5 h-2.5 text-gray-800" strokeWidth={3} />
      </button>

      {open?.what === 'colour' && (
        <Floating anchor={open.at} width={240}>
          <div className="p-1">
            <Spectrum value={block.color} onChange={(c) => onChange({ color: c })} pointerOnly />
          </div>
        </Floating>
      )}

      {sep}

      {/* Box Styling */}
      <button
        onPointerDown={toggleMenu('box')}
        className={`px-2.5 h-8 flex-shrink-0 rounded-xl flex items-center gap-1 transition active:scale-95 ${
          open?.what === 'box' ? 'bg-white/20' : 'hover:bg-white/10'
        }`}
        title="Box color & padding"
      >
        <Square className="w-3.5 h-3.5" style={{ fill: block.background ?? 'none', borderRadius: 2 }} />
        <span>Box</span>
        <ChevronDown className="w-3 h-3 opacity-70" />
      </button>

      {open?.what === 'box' && (
        <Floating anchor={open.at} width={260}>
          <div className="px-2 pt-1 pb-1 text-[10px] uppercase tracking-wider text-white/50 font-bold">
            Box background
          </div>
          <div className="grid grid-cols-5 gap-1.5 px-1 pb-2">
            {BOX_COLORS.map((c) => (
              <button
                key={c ?? 'none'}
                {...act(() => setBox(c))}
                className={`h-8 rounded-xl flex items-center justify-center text-[10px] font-medium ${
                  (block.background ?? null) === c ? 'ring-2 ring-studio-accent' : 'ring-1 ring-white/20'
                }`}
                style={{ backgroundColor: c ?? 'transparent' }}
                title={c ? 'Box background color' : 'No background'}
              >
                {c ? '' : 'None'}
              </button>
            ))}
          </div>
          <div className="px-1 pb-2">
            <Spectrum value={block.background ?? '#FFF4B8'} onChange={(c) => setBox(c)} pointerOnly />
          </div>
          <div className="px-2 pt-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-white/50 font-bold">
            <span>Corner rounding</span>
            <span className="tabular-nums normal-case text-white/90 font-mono text-xs">
              {Math.round(block.radius ?? 0)} px
            </span>
          </div>
          <DragSlider
            value={Math.min(MAX_RADIUS, block.radius ?? 0)}
            max={MAX_RADIUS}
            onChange={(v) => onChange({ radius: v || undefined })}
          />
        </Floating>
      )}
    </div>
  );
};
