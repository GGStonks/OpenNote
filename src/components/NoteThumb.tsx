import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { zLayers } from '../editor/zorder';
import { LatexBlock, NoteDocument, NotePage, PaperColor, PaperStyle, PdfPageRef, Stroke } from '../types';
import { sheetSlice, surfaceLayout } from '../editor/sheets';
import { drawStrokes, strokeBounds } from '../ink/strokeRenderer';
import { renderLatexContent } from '../services/latexRender';
import { renderTikzPreview } from '../services/tikzEngine';
import { paperBackground, paperIsDark } from './CanvasPage';
import { rotationStyle } from './Blocks';
import { textCss, textPieces } from '../editor/textStyle';
import { requestThumb } from '../services/thumbCache';
import { pdfPreview } from '../services/pdf';

/**
 * Page thumbnails (library cards: the first page; page manager: every page), drawn with the same content as the editor:
 * images, ink, math (KaTeX, with its fonts), TikZ diagrams and text. v1.x drew boxes in place of
 * images, math and diagrams.
 *
 * It is a scaled-down copy of the page in the DOM, not a raster: KaTeX and TikZ are HTML / SVG and
 * render exactly as on the page (fonts included), with no foreignObject rasterisation, which
 * cannot load fonts. Thumbnails are built only once they scroll near the screen; images are shown
 * once decoded, so a card never shows a half-loaded picture. Library cards show their ink from
 * images drawn once and stored (thumbCache.ts): drawn from the strokes each time, a large library
 * held the home screen up for seconds.
 */

/**
 * A library card's note: its ink comes from the stored thumbnail images. Its content is the
 * surface's, not moved: `offset` brings the page's corner to (0, 0) (moving the strokes copied every
 * point, also for a card whose image was stored).
 */
interface ThumbCache {
  noteId: string;
  updatedAt: number;
  offset: { x: number; y: number };
}

const BASE_MATH_PX = 22;

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

/** A library card's ink layer: the stored image, drawn in the background when missing or out of date. */
const CachedInk: React.FC<{ strokes: Stroke[]; width: number; height: number; cache: ThumbCache; layer: string }> = ({ strokes, width, height, cache, layer }) => {
  const [url, setUrl] = useState<string | null>(null);
  const { x, y } = cache.offset;
  useEffect(
    () => requestThumb(`${cache.noteId}|${layer}`, cache.noteId, cache.updatedAt, strokes, width, height, { x, y }, setUrl),
    [cache.noteId, cache.updatedAt, layer, strokes, width, height, x, y]
  );
  // In the surface's frame, like the rest of the card's content (see ThumbCache).
  return url ? <img src={url} alt="" draggable={false} className="absolute" style={{ left: -x, top: -y, width, height }} /> : null;
};

const ThumbInk: React.FC<{ strokes: Stroke[]; scale: number; width: number; height: number }> = ({ strokes, scale, width, height }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  /** What the canvas shows: the same strokes at the same size are not painted again. */
  const shown = useRef<{ strokes: Stroke[]; key: string } | null>(null);
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c) return;
    const key = `${scale}|${width}|${height}`;
    const prev = shown.current;
    if (prev && prev.key === key && prev.strokes.length === strokes.length && prev.strokes.every((s, i) => s === strokes[i])) return;
    shown.current = { strokes, key };
    const r = Math.min(2, window.devicePixelRatio || 1) * scale;
    c.width = Math.max(1, Math.round(width * r));
    c.height = Math.max(1, Math.round(height * r));
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(r, 0, 0, r, 0, 0);
    drawStrokes(ctx, strokes);
  }, [strokes, scale, width, height]);
  return <canvas ref={ref} className="absolute left-0 top-0" style={{ width, height }} />;
};

const ThumbContent: React.FC<{ page: NotePage; dark: boolean; scale: number; width: number; height: number; cache?: ThumbCache }> = ({ page, dark, scale, width, height, cache }) => {
  const ink = dark ? '#F3F4F6' : '#111827';
  const layers = useMemo(() => zLayers(page), [page]);
  return (
    <>
      {/* In stacking order (editor/zorder.ts), as on the page. */}
      {layers.map((l) => {
        if (l.kind === 'ink')
          return cache ? <CachedInk key={l.key} strokes={l.strokes} width={width} height={height} cache={cache} layer={l.key} /> : <ThumbInk key={l.key} strokes={l.strokes} scale={scale} width={width} height={height} />;
        if (l.kind === 'image') {
          const im = l.block;
          return <ThumbImage key={l.key} src={im.dataUrl} style={{ left: im.x, top: im.y, width: im.width, height: im.height, ...rotationStyle(im.rotation) }} />;
        }
        if (l.kind === 'latex') {
          const b = l.block;
          return b.isTikz ? <ThumbTikz key={l.key} block={b} color={ink} darkPaper={dark} /> : <ThumbMath key={l.key} block={b} color={ink} />;
        }
        const t = l.block;
        return (
          <div
            key={l.key}
            className="absolute whitespace-pre-wrap break-words"
            style={{ left: t.x, top: t.y, width: t.width, minHeight: t.height, fontSize: t.fontSize, color: dark && t.color === '#111827' ? '#F3F4F6' : t.color, ...textCss(t), ...rotationStyle(t.rotation) }}
          >
            {t.spans?.length ? textPieces(t).map((p, i) => (p.css ? <span key={i} style={p.css}>{p.text}</span> : p.text)) : t.text}
          </div>
        );
      })}
    </>
  );
};

/**
 * One page scaled to `scale`, its paper included. Built once it comes near the screen (`root`:
 * the scrolling list it is in).
 */
export const PageThumb: React.FC<{
  page: NotePage; width: number; height: number; paperStyle: PaperStyle; paperColor: PaperColor; patternColor?: string | null; scale: number; root?: Element | null; cache?: ThumbCache;
  /** The PDF page shown as this page's paper: its preview under the ink. */
  pdf?: PdfPageRef | null;
}> = React.memo(({ page, width, height, paperStyle, paperColor, patternColor, scale, root, cache, pdf }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!pdf || !near) return;
    let live = true;
    void pdfPreview(pdf).then((u) => live && setPdfUrl(u));
    return () => {
      live = false;
    };
  }, [pdf?.file, pdf?.page, near]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setNear(true);
        io.disconnect();
      }
    }, { root: root ?? null, rootMargin: '400px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [root, near]);
  return (
    <div ref={ref} className="relative overflow-hidden" style={{ width: width * scale, height: height * scale }}>
      <div
        className="relative overflow-hidden pointer-events-none select-none"
        style={{ width, height, transform: `scale(${scale})`, transformOrigin: '0 0', ...paperBackground(paperStyle, paperColor, undefined, scale, false, patternColor) }}
      >
        {pdf && pdfUrl && <img src={pdfUrl} alt="" draggable={false} className="absolute inset-0 w-full h-full" style={{ objectFit: 'contain', maxWidth: 'none' }} />}
        {near && (
          // Sized to reach the page's far corner: images are capped to their container's width.
          <div className="absolute" style={{ left: cache?.offset.x ?? 0, top: cache?.offset.y ?? 0, width: width - (cache?.offset.x ?? 0), height: height - (cache?.offset.y ?? 0) }}>
            <ThumbContent page={page} dark={paperIsDark(paperColor)} scale={scale} width={width} height={height} cache={cache} />
          </div>
        )}
      </div>
    </div>
  );
});

/** Library card: the note's first page, cut to the card's height. */
export const NoteThumb: React.FC<{ note: NoteDocument }> = React.memo(({ note }) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const setup = useMemo(() => (note.pages[0] && note.sheets?.length ? surfaceLayout(note).sheets[0] : null), [note]);
  const page = useMemo(() => (setup ? sheetSlice(note.pages[0], setup) : null), [note, setup]);
  const [cardWidth, setCardWidth] = useState(160);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setCardWidth(el.clientWidth || 160));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scale = setup ? cardWidth / setup.width : 0.2;
  return (
    <div ref={wrapRef} className="w-full overflow-hidden relative" style={{ height: Math.min(192, (setup?.height ?? 1056) * scale) }}>
      {page && setup && (
        <PageThumb
          page={page}
          width={setup.width}
          height={setup.height}
          paperStyle={setup.paperStyle}
          paperColor={setup.paperColor}
          patternColor={setup.patternColor}
          pdf={setup.pdf}
          scale={scale}
          cache={{ noteId: note.id, updatedAt: note.updatedAt, offset: { x: -setup.left, y: -setup.top } }}
        />
      )}
    </div>
  );
});
