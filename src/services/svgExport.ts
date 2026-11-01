import katexCss from 'katex/dist/katex.min.css?raw';
import type { NotePage } from '../types';
import type { Selection } from '../editor/selection';
import { textHeight } from '../editor/selection';
import { ZLayer, zLayers } from '../editor/zorder';
import { strokeToSvg } from '../ink/strokeRenderer';
import { renderLatexContent } from './latexRender';
import { renderTikzPreview } from './tikzEngine';
import { textCssString } from '../editor/textStyle';
import { RICH_TEXT_CSS, richTextClass, textBlockHtml } from '../editor/richText';

/**
 * SVG export (the note's pages, ExportModal; a selection, Editor): every item written as it is on
 * the page, and vectors stay vectors. Ink, shapes, fills and highlighters are paths
 * (strokeToSvg), TikZ diagrams their own SVG, text boxes and formulas live text (XHTML in a
 * foreignObject, styled by the same CSS as on the page: RICH_TEXT_CSS, KaTeX's style sheet with
 * its fonts inside the file), pictures the pictures they are. The HTML is written as XHTML in its
 * own namespace (in an SVG file, HTML tags fell into the SVG namespace and HTML entities were not
 * valid XML: formulas did not show outside the app).
 */

const SVG_NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"';

/** The app's own math layout (index.css), with KaTeX's. */
const MATH_CSS = '.on-math .katex-display{margin:0.15em 0}.on-math .katex{font-size:1em}.on-math-text .katex-display{margin:0.4em 0}.on-text p{margin:0 0 0.45em 0;line-height:1.45}.on-text .on-h{font-weight:700;margin:0.3em 0 0.35em}.on-text h3.on-h{font-size:1.25em}.on-text h4.on-h{font-size:1.1em}.on-text h5.on-h{font-size:1em}';

/** KaTeX's fonts as bundled assets, by file name (KaTeX_Main-Regular.woff2 …). */
const KATEX_FONTS = import.meta.glob('../../node_modules/katex/dist/fonts/*.woff2', { query: '?url', import: 'default', eager: true }) as Record<string, string>;

let katexStyle: Promise<string> | null = null;
/** KaTeX's style sheet with its fonts inside (woff2 as data URLs), so formulas show in any SVG viewer. */
function katexStyleSheet(): Promise<string> {
  katexStyle ??= (async () => {
    const urls = new Map(Object.entries(KATEX_FONTS).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1), url]));
    const data = new Map<string, string>();
    await Promise.all(
      [...urls].map(async ([name, url]) => {
        try {
          const b = new Uint8Array(await (await fetch(url)).arrayBuffer());
          let bin = '';
          for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
          data.set(name, `data:font/woff2;base64,${btoa(bin)}`);
        } catch {
          /* that font is left to the viewer */
        }
      })
    );
    // Each @font-face: its woff2 inside the file, the other formats dropped.
    return katexCss.replace(/src:([^;}]*)/g, (all: string, src: string) => {
      const m = /fonts\/(KaTeX_[\w-]+)\.woff2/.exec(src);
      const url = m ? data.get(`${m[1]}.woff2`) : null;
      return url ? `src:url(${url}) format("woff2")` : all;
    });
  })();
  return katexStyle;
}

/** An HTML element (tag, class, style, inner HTML) as well-formed XHTML in its own namespace. */
function xhtml(className: string, style: string, inner: string): string {
  const el = document.createElement('div');
  el.className = className;
  el.setAttribute('style', style);
  el.innerHTML = inner;
  return new XMLSerializer().serializeToString(el);
}

const xmlAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Wraps an SVG element in a rotation about (cx, cy) when the item is turned. */
const turn = (el: string, deg: number | undefined, cx: number, cy: number) => (deg ? `<g transform="rotate(${deg} ${cx.toFixed(2)} ${cy.toFixed(2)})">${el}</g>` : el);

/** One stacking layer of a page as SVG, `dy` down; `paper` and `ink` the page's colours. */
export function layerSvg(l: ZLayer, dy: number, paper: string, ink: string): string {
  if (l.kind === 'ink') {
    // Highlighters under the ink, as drawStrokes draws a layer.
    const order = [...l.strokes.filter((s) => s.tool === 'highlighter'), ...l.strokes.filter((s) => s.tool !== 'highlighter')];
    return order.map((s) => strokeToSvg(s, dy, paper)).join('\n');
  }
  if (l.kind === 'image') {
    const im = l.block;
    const href = xmlAttr(im.dataUrl);
    return turn(`<image href="${href}" xlink:href="${href}" x="${im.x}" y="${im.y + dy}" width="${im.width}" height="${im.height}" preserveAspectRatio="none"/>`, im.rotation, im.x + im.width / 2, im.y + dy + im.height / 2);
  }
  if (l.kind === 'text') {
    const t = l.block;
    const h = textHeight(t);
    const body = xhtml(richTextClass(t), `${textCssString(t)};color:${t.color};width:${t.width}px;min-height:${t.height ?? 0}px`, textBlockHtml(t));
    return turn(`<foreignObject x="${t.x}" y="${t.y + dy}" width="${t.width}" height="${Math.max(t.height ?? 0, h + t.fontSize * 4)}">${body}</foreignObject>`, t.rotation, t.x + t.width / 2, t.y + dy + h / 2);
  }
  const b = l.block;
  if (b.isTikz) {
    const svg = b.tikzSvg && b.tikzSvgSource === b.latexCode ? b.tikzSvg : renderTikzPreview(b.latexCode).svg;
    const stretched = (b.stretchX ?? 1) !== 1;
    // The diagram's own <svg>, placed and sized as the block (its own x / y / size attributes replaced:
    // repeated, they made the file invalid XML).
    let inner = svg
      .replace(/<svg\b([^>]*)>/, (_m, attrs: string) => `<svg x="${b.x}" y="${b.y + dy}" width="${b.width}" height="${b.height}"${attrs.replace(/\s(x|y|width|height)="[^"]*"/g, '')}>`)
      .replace(/currentColor/g, b.color ?? ink);
    if (stretched) inner = inner.replace(/<svg\b([^>]*?)(\s+preserveAspectRatio="[^"]*")?([^>]*)>/, '<svg$1$3 preserveAspectRatio="none">');
    return turn(inner, b.rotation, b.x + b.width / 2, b.y + dy + b.height / 2);
  }
  // A formula laid out as in the editor (Blocks.tsx MathBlockView): its size, its sideways stretch.
  const html = renderLatexContent(b.latexCode).html;
  const textual = html.includes('<p>') || html.includes('on-h');
  const sx = b.stretchX ?? 1;
  const style = [
    `font-size:${22 * (b.scale ?? 1)}px`,
    `color:${b.color ?? ink}`,
    textual ? `width:${b.width / sx}px` : 'display:inline-block;white-space:nowrap',
    sx !== 1 ? `transform:scaleX(${sx});transform-origin:0 0` : '',
  ].filter(Boolean).join(';');
  const body = xhtml(`on-math ${textual ? 'on-math-text' : ''}`.trim(), style, html);
  return turn(`<foreignObject x="${b.x}" y="${b.y + dy}" width="${Math.max(b.width, 40) + 20}" height="${Math.max(b.height, 30) + 10}">${body}</foreignObject>`, b.rotation, b.x + b.width / 2, b.y + dy + b.height / 2);
}

/** The <svg> element's opening tag and the style sheets its items need. */
export async function svgHead(viewBox: [number, number, number, number], layers: ZLayer[]): Promise<string> {
  const [x, y, w, h] = viewBox.map((v) => Math.round(v * 100) / 100);
  const maths = layers.some((l) => l.kind === 'latex' && !l.block.isTikz);
  const texts = layers.some((l) => l.kind === 'text');
  const css = [texts ? RICH_TEXT_CSS.replace(/\s+/g, ' ') : '', maths ? MATH_CSS + (await katexStyleSheet()) : ''].filter(Boolean).join('\n');
  return `<svg ${SVG_NS} viewBox="${x} ${y} ${w} ${h}" width="${w}" height="${h}">\n${css ? `<style><![CDATA[${css}]]></style>\n` : ''}`;
}

/**
 * The selected items alone, as one SVG: framed by the selection (its bounds), on no paper
 * (see-through), in their stacking order.
 */
export async function selectionSvg(page: NotePage, sel: Selection, paper: string, ink: string): Promise<string> {
  const has = (ids: string[]) => {
    const set = new Set(ids);
    return (x: { id: string }) => set.has(x.id);
  };
  const only: NotePage = {
    ...page,
    strokes: page.strokes.filter(has(sel.strokeIds)),
    latexBlocks: page.latexBlocks.filter(has(sel.latexIds)),
    textBlocks: (page.textBlocks ?? []).filter(has(sel.textIds)),
    imageBlocks: (page.imageBlocks ?? []).filter(has(sel.imageIds)),
  };
  const layers = zLayers(only);
  const b = sel.bounds;
  let out = await svgHead([b.x, b.y, b.width, b.height], layers);
  for (const l of layers) out += layerSvg(l, 0, paper, ink) + '\n';
  return out + '</svg>\n';
}
