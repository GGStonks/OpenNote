import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Copy, Pencil, Trash2, AlertTriangle, Loader2 } from 'lucide-react';
import { ImageBlock, LatexBlock, TextBlock } from '../types';
import { renderLatexContent } from '../services/latexRender';
import { renderTikzPreview, renderTikzWithTeX } from '../services/tikzEngine';

const BASE_MATH_PX = 22;

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

export const LatexBlockView: React.FC<LatexBlockViewProps> = (props) =>
  props.block.isTikz ? <TikzBlockView {...props} /> : <MathBlockView {...props} />;

const MathBlockView: React.FC<LatexBlockViewProps> = ({ block, inkColor, interactive, selected, zoom, onSelect, onEdit, onDelete, onSilentUpdate, measure = true }) => {
  const rendered = useMemo(() => renderLatexContent(block.latexCode), [block.latexCode]);
  const textual = rendered.html.includes('<p>') || rendered.html.includes('on-h');
  const contentRef = useRef<HTMLDivElement>(null);
  const scale = block.scale ?? 1;

  // Keep the stored box equal to the rendered size (used by lasso hit-testing and export).
  useLayoutEffect(() => {
    const el = contentRef.current;
    // Hidden copies (print layout portal) measure 0x0 and must not overwrite the stored size.
    if (!el || !measure || el.offsetParent === null) return;
    const w = Math.ceil(textual ? block.width : el.scrollWidth);
    const h = Math.ceil(el.scrollHeight);
    if (Math.abs(w - block.width) > 2 || Math.abs(h - block.height) > 2) onSilentUpdate({ width: w, height: h });
  });

  return (
    <div
      className={`absolute ${interactive ? 'pointer-events-auto cursor-pointer' : 'pointer-events-none'} ${selected ? 'outline outline-2 outline-blue-500/80 outline-offset-4 rounded' : ''}`}
      style={{ left: block.x, top: block.y, width: textual ? block.width : undefined, color: block.color ?? inkColor }}
      onPointerDown={(e) => {
        if (!interactive) return;
        e.stopPropagation();
        onSelect();
      }}
    >
      {selected && <ActionPill zoom={zoom} onEdit={onEdit} onCopy={() => navigator.clipboard?.writeText(block.latexCode)} onDelete={onDelete} />}
      <div
        ref={contentRef}
        className={`on-math ${textual ? 'on-math-text' : 'inline-block whitespace-nowrap'}`}
        style={{ fontSize: BASE_MATH_PX * scale }}
        dangerouslySetInnerHTML={{ __html: rendered.html }}
      />
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
      style={{ left: block.x, top: block.y, width: block.width, height: block.height, color: block.color ?? inkColor }}
      onPointerDown={(e) => {
        if (!interactive) return;
        e.stopPropagation();
        onSelect();
      }}
    >
      {selected && <ActionPill zoom={zoom} onEdit={onEdit} onCopy={() => navigator.clipboard?.writeText(block.latexCode)} onDelete={onDelete} />}
      <div
        className={`on-tikz w-full h-full ${cachedOk && darkPaper ? 'on-tikz-dark' : ''}`}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
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
}

export const TextBlockView: React.FC<TextBlockViewProps> = ({ block, interactive, editing, selected, zoom, darkPaper, onStartEdit, onCommit, onDelete }) => {
  const [draft, setDraft] = useState(block.text);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setDraft(block.text), [block.text]);
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  });
  useEffect(() => {
    if (editing) {
      const el = areaRef.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    }
  }, [editing]);
  const color = darkPaper && block.color === '#111827' ? '#F3F4F6' : block.color;
  const style: React.CSSProperties = { left: block.x, top: block.y, width: block.width, fontSize: block.fontSize, color, lineHeight: 1.35 };

  if (editing) {
    return (
      <div className="absolute z-30" style={style} onPointerDown={(e) => e.stopPropagation()}>
        <textarea
          ref={areaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => onCommit(draft)}
          className="w-full bg-blue-50/40 outline outline-2 outline-blue-400 rounded resize-none overflow-hidden p-0 m-0 border-0 select-text"
          style={{ font: 'inherit', color: 'inherit', lineHeight: 'inherit', userSelect: 'text', WebkitUserSelect: 'text' }}
          placeholder="Type…"
        />
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
};

export const ImageBlockView: React.FC<{ block: ImageBlock; selected: boolean }> = ({ block, selected }) => (
  <img
    src={block.dataUrl}
    alt=""
    draggable={false}
    className={`absolute pointer-events-none select-none ${selected ? 'outline outline-2 outline-blue-500/80 outline-offset-4' : ''}`}
    style={{ left: block.x, top: block.y, width: block.width, height: block.height }}
  />
);
