import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { LatexBlock, NoteDocument, NotePage, PAGE_HEIGHT, PAGE_WIDTH, Stroke } from '../types';
import { drawStrokes, strokeBounds } from '../ink/strokeRenderer';
import { renderLatexContent } from '../services/latexRender';
import { renderTikzPreview } from '../services/tikzEngine';
import { paperBackground } from './CanvasPage';
import { rotationStyle } from './Blocks';

/**
 * Library thumbnail: the first page of the note, drawn with the same content as the editor:
 * images, ink, math (KaTeX, with its fonts), TikZ diagrams and text. v1.x drew boxes in place of
 * images, math and diagrams.
 *
 * It is a scaled-down copy of the page in the DOM, not a raster: KaTeX and TikZ are HTML / SVG and
 * render exactly as on the page (fonts included), with no foreignObject rasterisation, which
 * cannot load fonts. Thumbnails are built only once they scroll near the screen; images are shown
 * once decoded, so a card never shows a half-loaded picture.
 */

const BASE_MATH_PX = 22;

/** Items of the first page band (everything that reaches into it). */
function firstPage(p: NotePage): { strokes: Stroke[]; page: NotePage } {
  const inBand = (y0: number, y1: number) => y1 >= 0 && y0 <= PAGE_HEIGHT;
  return {
    strokes: p.strokes.filter((s) => {
      const b = strokeBounds(s);
      return inBand(b.minY, b.maxY);
    }),
    page: {
      ...p,
      latexBlocks: p.latexBlocks.filter((b) => inBand(b.y, b.y + b.height)),
      textBlocks: (p.textBlocks ?? []).filter((b) => inBand(b.y, b.y + b.fontSize * 2)),
      imageBlocks: (p.imageBlocks ?? []).filter((b) => inBand(b.y, b.y + b.height)),
    },
  };
}

const ThumbImage: React.FC<{ src: string; style: React.CSSProperties }> = ({ src, style }) => {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    const img = new Image();
    img.src = src;
    img.decode().then(
      () => alive && setReady(true),
      () => alive && setReady(true)
    );
    return () => {
      alive = false;
    };
  }, [src]);
  return ready ? <img src={src} alt="" draggable={false} className="absolute" style={style} /> : null;
};

const ThumbMath: React.FC<{ block: LatexBlock; color: string }> = ({ block, color }) => {
  const html = useMemo(() => renderLatexContent(block.latexCode).html, [block.latexCode]);
  const textual = html.includes('<p>') || html.includes('on-h');
  return (
    <div className="absolute" style={{ left: block.x, top: block.y, width: textual ? block.width : undefined, color: block.color ?? color, ...rotationStyle(block.rotation) }}>
      <div
        className={`on-math ${textual ? 'on-math-text' : 'inline-block whitespace-nowrap'}`}
        style={{ fontSize: BASE_MATH_PX * (block.scale ?? 1) }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
};

const ThumbTikz: React.FC<{ block: LatexBlock; color: string; darkPaper: boolean }> = ({ block, color, darkPaper }) => {
  // The TeX-rendered SVG the editor cached; otherwise the built-in preview (a thumbnail never runs TeX).
  const cached = !!block.tikzSvg && block.tikzSvgSource === block.latexCode;
  const svg = useMemo(() => (cached ? block.tikzSvg! : renderTikzPreview(block.latexCode).svg), [cached, block.tikzSvg, block.latexCode]);
  return (
    <div className="absolute" style={{ left: block.x, top: block.y, width: block.width, height: block.height, color: block.color ?? color, ...rotationStyle(block.rotation) }}>
      <div className={`on-tikz w-full h-full ${cached && darkPaper ? 'on-tikz-dark' : ''}`} dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
};

const ThumbInk: React.FC<{ strokes: Stroke[]; scale: number }> = ({ strokes, scale }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c) return;
    const r = Math.min(2, window.devicePixelRatio || 1) * scale;
    c.width = Math.max(1, Math.round(PAGE_WIDTH * r));
    c.height = Math.max(1, Math.round(PAGE_HEIGHT * r));
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(r, 0, 0, r, 0, 0);
    drawStrokes(ctx, strokes);
  }, [strokes, scale]);
  return <canvas ref={ref} className="absolute left-0 top-0" style={{ width: PAGE_WIDTH, height: PAGE_HEIGHT }} />;
};

const ThumbContent: React.FC<{ note: NoteDocument; scale: number }> = ({ note, scale }) => {
  const surface = note.pages[0];
  const { strokes, page } = useMemo(() => firstPage(surface), [surface]);
  const dark = note.paperColor === 'dark';
  const ink = dark ? '#F3F4F6' : '#111827';
  return (
    <>
      {(page.imageBlocks ?? []).map((im) => (
        <ThumbImage key={im.id} src={im.dataUrl} style={{ left: im.x, top: im.y, width: im.width, height: im.height, ...rotationStyle(im.rotation) }} />
      ))}
      <ThumbInk strokes={strokes} scale={scale} />
      {page.latexBlocks.map((b) => (b.isTikz ? <ThumbTikz key={b.id} block={b} color={ink} darkPaper={dark} /> : <ThumbMath key={b.id} block={b} color={ink} />))}
      {(page.textBlocks ?? []).map((t) => (
        <div
          key={t.id}
          className="absolute whitespace-pre-wrap break-words"
          style={{ left: t.x, top: t.y, width: t.width, fontSize: t.fontSize, lineHeight: 1.35, color: dark && t.color === '#111827' ? '#F3F4F6' : t.color, ...rotationStyle(t.rotation) }}
        >
          {t.text}
        </div>
      ))}
    </>
  );
};

export const NoteThumb: React.FC<{ note: NoteDocument }> = React.memo(({ note }) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.2);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / PAGE_WIDTH || 0.2));
    ro.observe(el);
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setNear(true);
        io.disconnect();
      }
    }, { rootMargin: '400px 0px' });
    io.observe(el);
    return () => {
      ro.disconnect();
      io.disconnect();
    };
  }, []);
  return (
    <div ref={wrapRef} className="w-full overflow-hidden relative" style={{ height: Math.min(192, PAGE_HEIGHT * scale) }}>
      <div
        className="relative overflow-hidden pointer-events-none select-none"
        style={{ width: PAGE_WIDTH, height: PAGE_HEIGHT, transform: `scale(${scale})`, transformOrigin: '0 0', ...paperBackground(note.paperStyle, note.paperColor) }}
      >
        {near && note.pages[0] && <ThumbContent note={note} scale={scale} />}
      </div>
    </div>
  );
});
