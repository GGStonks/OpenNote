import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Copy, Pencil, Trash2, AlertTriangle, Loader2 } from 'lucide-react';
import { ImageBlock, LatexBlock, TextBlock } from '../types';
import { TEXT_LINE_HEIGHT, textCss } from '../editor/textStyle';
import { renderLatexContent } from '../services/latexRender';
import { renderTikzPreview, renderTikzWithTeX } from '../services/tikzEngine';

const BASE_MATH_PX = 22;

/**
 * Block views re-render only when their data changes, not on every edit of the page (each pen
 * stroke): a math block measures its rendered size after every render, which forced a layout of
 * the page per block on every stroke. Callbacks are not compared: the page passes handlers that
 * read the current page and tool through refs.
 */
/** CSS for a block turned by `deg` degrees about its centre. */
export function rotationStyle(deg?: number): React.CSSProperties {
  return deg ? { transform: `rotate(${deg}deg)`, transformOrigin: '50% 50%' } : {};
}

/**
 * Content laid out at its size on screen (`zoom` times its page size) and scaled back by 1/zoom,
 * as a compositing layer of its own: the page's zoom is a CSS scale, and WebKit kept rasterising
 * a layer inside it at the scale it first had, so a formula inserted at 2x was a fixed bitmap,
 * pixelated when zoomed further in. This layer's scale on screen is always 1, so it is drawn at
 * exactly the screen's resolution at any zoom (laid out again when the zoom changes).
 */
const ScreenScaled: React.FC<{ zoom: number; width?: number; height?: number; children: React.ReactNode }> = ({ zoom, width, height, children }) => (
  <div
    className="absolute left-0 top-0"
    style={{
      width: width === undefined ? undefined : width * zoom,
      height: height === undefined ? undefined : height * zoom,
      transform: `scale(${1 / zoom})`,
      transformOrigin: '0 0',
      willChange: 'transform',
    }}
  >
    {children}
  </div>
);

function sameData<P extends object>(a: P, b: P): boolean {
  for (const k of Object.keys(b) as (keyof P)[]) {
    if (typeof b[k] === 'function') continue;
    if (a[k] !== b[k]) return false;
  }
  return Object.keys(a).length === Object.keys(b).length;
}

interface ActionPillProps {
  zoom: number;
  onEdit?: () => void;
  onCopy?: () => void;
  onDelete: () => void;
}

const ActionPill: React.FC<ActionPillProps> = ({ zoom, onEdit, onCopy, onDelete }) => (
  <div
    className="absolute left-1/2 bottom-full mb-2 flex items-center gap-1 bg-gray-900/90 text-white px-2 py-1 rounded-full shadow-xl z-40"
    style={{ transform: `translateX(-50%) scale(${1 / zoom})`, transformOrigin: 'bottom center' }}
    onPointerDown={(e) => e.stopPropagation()}
  >
    {onEdit && (
      <button className="p-1.5 hover:text-blue-300" onClick={onEdit} title="Edit source">
        <Pencil className="w-4 h-4" />
      </button>
    )}
    {onCopy && (
      <button className="p-1.5 hover:text-blue-300" onClick={onCopy} title="Copy source">
        <Copy className="w-4 h-4" />
      </button>
    )}
    <button className="p-1.5 hover:text-red-300" onClick={onDelete} title="Delete">
      <Trash2 className="w-4 h-4" />
    </button>
  </div>
);

interface LatexBlockViewProps {
  block: LatexBlock;
  inkColor: string;
  darkPaper: boolean;
  interactive: boolean;
  selected: boolean;
  zoom: number;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onSilentUpdate: (patch: Partial<LatexBlock>) => void;
  /** False for read-only copies (print layout): no measuring, no TeX compile write-backs. */
  measure?: boolean;
}

export const LatexBlockView = React.memo<LatexBlockViewProps>(
  (props) => (props.block.isTikz ? <TikzBlockView {...props} /> : <MathBlockView {...props} />),
  sameData
);

const MathBlockView: React.FC<LatexBlockViewProps> = ({ block, inkColor, interactive, selected, zoom, onSelect, onEdit, onDelete, onSilentUpdate, measure = true }) => {
  const rendered = useMemo(() => renderLatexContent(block.latexCode), [block.latexCode]);
  const textual = rendered.html.includes('<p>') || rendered.html.includes('on-h');
  const contentRef = useRef<HTMLDivElement>(null);
  const scale = block.scale ?? 1;
  const z = zoom > 0 ? zoom : 1;

  // Keep the stored box equal to the rendered size (used by lasso hit-testing and export). The
  // content is laid out at screen size (ScreenScaled): page size = measured / zoom.
  useLayoutEffect(() => {
    const el = contentRef.current;
    // Hidden copies (print layout portal) measure 0x0 and must not overwrite the stored size.
    if (!el || !measure || el.offsetParent === null) return;
    const w = Math.ceil(textual ? block.width : el.scrollWidth / z);
    const h = Math.ceil(el.scrollHeight / z);
    if (Math.abs(w - block.width) > 2 || Math.abs(h - block.height) > 2) onSilentUpdate({ width: w, height: h });
  });

  return (
    <div
      className={`absolute ${interactive ? 'pointer-events-auto cursor-pointer' : 'pointer-events-none'} ${selected ? 'outline outline-2 outline-blue-500/80 outline-offset-4 rounded' : ''}`}
      style={{ left: block.x, top: block.y, width: block.width, height: block.height, color: block.color ?? inkColor, ...rotationStyle(block.rotation) }}
      onPointerDown={(e) => {
        if (!interactive) return;
        e.stopPropagation();
        onSelect();
      }}
    >
      {selected && <ActionPill zoom={zoom} onEdit={onEdit} onCopy={() => navigator.clipboard?.writeText(block.latexCode)} onDelete={onDelete} />}
      <ScreenScaled zoom={z} width={textual ? block.width : undefined}>
        <div
          ref={contentRef}
          className={`on-math ${textual ? 'on-math-text' : 'inline-block whitespace-nowrap'}`}
          style={{ fontSize: BASE_MATH_PX * scale * z }}
          dangerouslySetInnerHTML={{ __html: rendered.html }}
        />
      </ScreenScaled>
      {rendered.error && selected && (
        <div className="absolute top-full left-0 mt-1 text-[11px] text-red-600 bg-red-50 border border-red-200 rounded px-1.5 py-0.5 max-w-xs" style={{ transform: `scale(${1 / zoom})`, transformOrigin: 'top left' }}>
          {rendered.error}
        </div>
      )}
    </div>
  );
};

function svgAspect(svg: string): number | null {
  const vb = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/.exec(svg);
  if (!vb) return null;
  const w = parseFloat(vb[1]), h = parseFloat(vb[2]);
  return w > 0 && h > 0 ? h / w : null;
}

const TikzBlockView: React.FC<LatexBlockViewProps> = ({ block, inkColor, darkPaper, interactive, selected, zoom, onSelect, onEdit, onDelete, onSilentUpdate, measure = true }) => {
  const cachedOk = block.tikzSvg && block.tikzSvgSource === block.latexCode;
  const preview = useMemo(() => (cachedOk ? null : renderTikzPreview(block.latexCode)), [block.latexCode, cachedOk]);
  const [status, setStatus] = useState<'idle' | 'compiling' | 'error'>(cachedOk ? 'idle' : 'compiling');
  const [error, setError] = useState<string | null>(null);
  const updateRef = useRef(onSilentUpdate);
  updateRef.current = onSilentUpdate;

  useEffect(() => {
    if (cachedOk) {
      setStatus('idle');
      return;
    }
    let cancelled = false;
    setStatus('compiling');
    setError(null);
    renderTikzWithTeX(block.latexCode)
      .then((svg) => {
        if (cancelled || !measure) return;
        const aspect = svgAspect(svg);
        updateRef.current({
          tikzSvg: svg,
          tikzSvgSource: block.latexCode,
          ...(aspect ? { height: Math.round(block.width * aspect) } : {}),
        });
        setStatus('idle');
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [block.latexCode, cachedOk]); // eslint-disable-line react-hooks/exhaustive-deps

  const svg = cachedOk ? block.tikzSvg! : preview!.svg;

  // Size the preview box to the preview's aspect until the TeX render arrives.
  useLayoutEffect(() => {
    if (cachedOk || !measure) return;
    const aspect = svgAspect(svg);
    if (aspect) {
      const h = Math.round(block.width * aspect);
      if (Math.abs(h - block.height) > 2) onSilentUpdate({ height: h });
    }
  }, [svg]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className={`absolute ${interactive ? 'pointer-events-auto cursor-pointer' : 'pointer-events-none'} ${selected ? 'outline outline-2 outline-blue-500/80 outline-offset-4 rounded' : ''}`}
      style={{ left: block.x, top: block.y, width: block.width, height: block.height, color: block.color ?? inkColor, ...rotationStyle(block.rotation) }}
      onPointerDown={(e) => {
        if (!interactive) return;
        e.stopPropagation();
        onSelect();
      }}
    >
      {selected && <ActionPill zoom={zoom} onEdit={onEdit} onCopy={() => navigator.clipboard?.writeText(block.latexCode)} onDelete={onDelete} />}
      <ScreenScaled zoom={zoom > 0 ? zoom : 1} width={block.width} height={block.height}>
        <div
          className={`on-tikz w-full h-full ${cachedOk && darkPaper ? 'on-tikz-dark' : ''}`}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </ScreenScaled>
      {status !== 'idle' && (
        <div
          className={`absolute -top-2 -right-2 rounded-full p-1 shadow ${status === 'error' ? 'bg-amber-100 text-amber-700' : 'bg-white text-blue-600'}`}
          style={{ transform: `scale(${1 / zoom})`, transformOrigin: 'top right' }}
          title={status === 'error' ? `TeX engine: ${error}. Showing approximate preview.` : 'Rendering with TeX…'}
        >
          {status === 'error' ? <AlertTriangle className="w-3.5 h-3.5" /> : <Loader2 className="w-3.5 h-3.5 animate-spin" />}
        </div>
      )}
    </div>
  );
};

interface TextBlockViewProps {
  block: TextBlock;
  interactive: boolean;
  editing: boolean;
  selected: boolean;
  zoom: number;
  darkPaper: boolean;
  onStartEdit: () => void;
  onCommit: (text: string) => void;
  onDelete: () => void;
  onSilentUpdate: (patch: Partial<TextBlock>) => void;
  /** Resize handle dragged: 'start' and 'end' bracket one undo step, 'move' previews the size. */
  onResize?: (patch: { width?: number; height?: number }, phase: 'start' | 'move' | 'end') => void;
}

/** Narrowest a text box can be resized to (page px). */
const TEXT_MIN_WIDTH = 40;

export const TextBlockView = React.memo<TextBlockViewProps>(function TextBlockView({ block, interactive, editing, selected, zoom, darkPaper, onStartEdit, onCommit, onDelete, onResize }) {
  const [draft, setDraft] = useState(block.text);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setDraft(block.text), [block.text]);
  // Leaving the editor saves what was typed. A tap on the page ends editing without a blur
  // event (the page's pointerdown prevents the focus change and the textarea is just removed),
  // and v1.x then dropped the text: the box was left empty and disappeared. The page keeps the
  // box unless its text is empty.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  const wasEditing = useRef(editing);
  useEffect(() => {
    if (wasEditing.current && !editing) commitRef.current(draftRef.current);
    wasEditing.current = editing;
  }, [editing]);
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.max(el.scrollHeight, block.height ?? 0)}px`;
  });
  const boxRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef(onResize);
  resizeRef.current = onResize;
  /**
   * A resize handle: the right edge sets the width, the bottom edge the (minimum) height, the
   * corner both. The pointer is captured and the page's own handlers never see it; preventDefault
   * keeps the keyboard focus in the text being edited.
   */
  const startResize = (e: React.PointerEvent, axes: 'x' | 'y' | 'xy') => {
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget as HTMLElement;
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const x0 = e.clientX, y0 = e.clientY, w0 = block.width;
    const h0 = (boxRef.current?.offsetHeight ?? block.fontSize * 1.35) as number;
    const minH = block.fontSize * 1.35;
    resizeRef.current?.({}, 'start');
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      const patch: { width?: number; height?: number } = {};
      if (axes !== 'y') patch.width = Math.max(TEXT_MIN_WIDTH, Math.round(w0 + (ev.clientX - x0) / zoom));
      if (axes !== 'x') patch.height = Math.max(minH, Math.round(h0 + (ev.clientY - y0) / zoom));
      resizeRef.current?.(patch, 'move');
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      resizeRef.current?.({}, 'end');
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };
  useEffect(() => {
    if (editing) {
      const el = areaRef.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    }
  }, [editing]);
  const color = darkPaper && block.color === '#111827' ? '#F3F4F6' : block.color;
  const style: React.CSSProperties = {
    left: block.x, top: block.y, width: block.width, minHeight: block.height, fontSize: block.fontSize, color, lineHeight: TEXT_LINE_HEIGHT,
    ...textCss(block), ...rotationStyle(block.rotation),
  };
  // Handles keep their size on screen whatever the zoom.
  const hs = 1 / Math.max(0.3, zoom);
  const handle = (cls: string, css: React.CSSProperties, axes: 'x' | 'y' | 'xy', title: string) =>
    onResize ? (
      <div
        className={`absolute bg-white border-2 border-blue-500 rounded-full shadow ${cls}`}
        style={{ width: 14 * hs, height: 14 * hs, touchAction: 'none', ...css }}
        title={title}
        data-no-pan
        data-no-pan-strict
        onPointerDown={(e) => startResize(e, axes)}
      />
    ) : null;

  if (editing) {
    return (
      <div ref={boxRef} className="absolute z-30" style={style} onPointerDown={(e) => e.stopPropagation()}>
        <textarea
          ref={areaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => {
            // Focus taken by the formatting bar (TextFormatBar): keep editing.
            if ((e.relatedTarget as HTMLElement | null)?.closest?.('[data-text-format]')) {
              requestAnimationFrame(() => areaRef.current?.focus());
              return;
            }
            onCommit(draft);
          }}
          className="w-full bg-blue-50/40 outline outline-2 outline-blue-400 rounded resize-none overflow-hidden p-0 m-0 border-0 select-text"
          style={{ font: 'inherit', color: 'inherit', lineHeight: 'inherit', textDecoration: 'inherit', userSelect: 'text', WebkitUserSelect: 'text' }}
          placeholder="Type…"
        />
        {handle('cursor-ew-resize', { right: -8 * hs, top: '50%', marginTop: -7 * hs }, 'x', 'Drag to change the width')}
        {handle('cursor-ns-resize', { bottom: -8 * hs, left: '50%', marginLeft: -7 * hs }, 'y', 'Drag to change the height')}
        {handle('cursor-nwse-resize', { right: -8 * hs, bottom: -8 * hs }, 'xy', 'Drag to resize')}
      </div>
    );
  }
  return (
    <div
      className={`absolute whitespace-pre-wrap break-words ${interactive ? 'pointer-events-auto cursor-text' : 'pointer-events-none'} ${selected ? 'outline outline-2 outline-blue-500/80 outline-offset-4 rounded' : ''}`}
      style={style}
      onPointerDown={(e) => {
        if (!interactive) return;
        e.stopPropagation();
        onStartEdit();
      }}
    >
      {selected && <ActionPill zoom={zoom} onDelete={onDelete} />}
      {block.text}
    </div>
  );
}, sameData);

export const ImageBlockView = React.memo<{ block: ImageBlock; selected: boolean }>(({ block, selected }) => (
  <img
    src={block.dataUrl}
    alt=""
    draggable={false}
    className={`absolute pointer-events-none select-none ${selected ? 'outline outline-2 outline-blue-500/80 outline-offset-4' : ''}`}
    style={{ left: block.x, top: block.y, width: block.width, height: block.height, ...rotationStyle(block.rotation) }}
  />
));
