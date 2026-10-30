import type { TextBlock, TextFont } from '../types';

/**
 * Text box typography: the typefaces offered and how a box's style is written as CSS, the same on
 * the page, in thumbnails, in exports and in print. Nothing is downloaded: each typeface is a CSS
 * stack of its own name (iPadOS and macOS have them all) and the nearest fonts other systems have
 * (Android draws Papyrus or Marker Felt with a lookalike).
 */
export const TEXT_FONTS: { id: TextFont; label: string; css: string; group: 'Sans serif' | 'Serif' | 'Monospace' | 'Handwriting & display' }[] = [
  { id: 'sans', label: 'System', group: 'Sans serif', css: '-apple-system, system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' },
  { id: 'helvetica-neue', label: 'Helvetica Neue', group: 'Sans serif', css: '"Helvetica Neue", Helvetica, Arial, Roboto, sans-serif' },
  { id: 'helvetica', label: 'Helvetica', group: 'Sans serif', css: 'Helvetica, Arial, Roboto, sans-serif' },
  { id: 'arial', label: 'Arial', group: 'Sans serif', css: 'Arial, Helvetica, Roboto, sans-serif' },
  { id: 'avenir', label: 'Avenir Next', group: 'Sans serif', css: '"Avenir Next", Avenir, "Segoe UI", Roboto, sans-serif' },
  { id: 'futura', label: 'Futura', group: 'Sans serif', css: 'Futura, "Century Gothic", "Trebuchet MS", sans-serif' },
  { id: 'gill-sans', label: 'Gill Sans', group: 'Sans serif', css: '"Gill Sans", "Gill Sans MT", Calibri, sans-serif' },
  { id: 'optima', label: 'Optima', group: 'Sans serif', css: 'Optima, Candara, "Segoe UI", sans-serif' },
  { id: 'verdana', label: 'Verdana', group: 'Sans serif', css: 'Verdana, Geneva, "DejaVu Sans", sans-serif' },
  { id: 'trebuchet', label: 'Trebuchet MS', group: 'Sans serif', css: '"Trebuchet MS", "Lucida Grande", sans-serif' },
  { id: 'impact', label: 'Impact', group: 'Sans serif', css: 'Impact, "Haettenschweiler", "Arial Narrow Bold", "Roboto Condensed", sans-serif' },
  { id: 'serif', label: 'System serif', group: 'Serif', css: 'Georgia, "Times New Roman", "Noto Serif", serif' },
  { id: 'georgia', label: 'Georgia', group: 'Serif', css: 'Georgia, "Noto Serif", serif' },
  { id: 'times', label: 'Times New Roman', group: 'Serif', css: '"Times New Roman", Times, "Noto Serif", serif' },
  { id: 'palatino', label: 'Palatino', group: 'Serif', css: 'Palatino, "Palatino Linotype", "Book Antiqua", serif' },
  { id: 'baskerville', label: 'Baskerville', group: 'Serif', css: 'Baskerville, "Baskerville Old Face", Garamond, serif' },
  { id: 'didot', label: 'Didot', group: 'Serif', css: 'Didot, "Bodoni 72", "Bodoni MT", serif' },
  { id: 'hoefler', label: 'Hoefler Text', group: 'Serif', css: '"Hoefler Text", Garamond, Georgia, serif' },
  { id: 'american-typewriter', label: 'American Typewriter', group: 'Serif', css: '"American Typewriter", "Courier New", serif' },
  { id: 'mono', label: 'System mono', group: 'Monospace', css: 'ui-monospace, Menlo, "Roboto Mono", "Courier New", monospace' },
  { id: 'courier', label: 'Courier New', group: 'Monospace', css: '"Courier New", Courier, monospace' },
  { id: 'menlo', label: 'Menlo', group: 'Monospace', css: 'Menlo, Monaco, Consolas, "Roboto Mono", monospace' },
  { id: 'script', label: 'Script', group: 'Handwriting & display', css: '"Snell Roundhand", "Dancing Script", "Segoe Script", cursive' },
  { id: 'snell', label: 'Snell Roundhand', group: 'Handwriting & display', css: '"Snell Roundhand", "Dancing Script", "Segoe Script", cursive' },
  { id: 'bradley-hand', label: 'Bradley Hand', group: 'Handwriting & display', css: '"Bradley Hand", "Segoe Print", "Comic Sans MS", cursive' },
  { id: 'marker-felt', label: 'Marker Felt', group: 'Handwriting & display', css: '"Marker Felt", "Comic Sans MS", "Chalkboard SE", cursive' },
  { id: 'noteworthy', label: 'Noteworthy', group: 'Handwriting & display', css: 'Noteworthy, "Segoe Print", "Comic Sans MS", cursive' },
  { id: 'chalkboard', label: 'Chalkboard SE', group: 'Handwriting & display', css: '"Chalkboard SE", Chalkboard, "Comic Sans MS", cursive' },
  { id: 'chalkduster', label: 'Chalkduster', group: 'Handwriting & display', css: 'Chalkduster, "Chalkboard SE", "Comic Sans MS", cursive' },
  { id: 'papyrus', label: 'Papyrus', group: 'Handwriting & display', css: 'Papyrus, "Papyrus Condensed", fantasy' },
  { id: 'zapfino', label: 'Zapfino', group: 'Handwriting & display', css: 'Zapfino, "Snell Roundhand", cursive' },
];

/**
 * The typeface, weight and slant a font name says (an imported note's PostScript names:
 * "HelveticaNeue-Bold", "Papyrus-Condensed", "MarkerFelt-Thin", "TimesNewRomanPS-ItalicMT").
 */
export function fontFromName(name: string): { family: TextFont; bold: boolean; italic: boolean } {
  const n = name.toLowerCase().replace(/[\s_]/g, '');
  const pick = (): TextFont => {
    const table: [RegExp, TextFont][] = [
      [/helveticaneue/, 'helvetica-neue'], [/helvetica/, 'helvetica'], [/arial/, 'arial'], [/avenir/, 'avenir'], [/futura/, 'futura'],
      [/gillsans/, 'gill-sans'], [/optima/, 'optima'], [/verdana/, 'verdana'], [/trebuchet/, 'trebuchet'], [/impact/, 'impact'],
      [/georgia/, 'georgia'], [/timesnewroman|^times/, 'times'], [/palatino/, 'palatino'], [/baskerville/, 'baskerville'],
      [/didot|bodoni/, 'didot'], [/hoefler/, 'hoefler'], [/americantypewriter/, 'american-typewriter'],
      [/courier/, 'courier'], [/menlo|monaco|consol|sfmono|mono/, 'menlo'],
      [/snell/, 'snell'], [/bradley/, 'bradley-hand'], [/markerfelt|marker/, 'marker-felt'], [/noteworthy/, 'noteworthy'],
      [/chalkduster/, 'chalkduster'], [/chalkboard|comic/, 'chalkboard'], [/papyrus/, 'papyrus'], [/zapfino/, 'zapfino'],
      [/script|hand|brush|cursive/, 'script'], [/serif|garamond|cambria|charter|baskerville/, 'serif'],
    ];
    for (const [re, id] of table) if (re.test(n) && !(id === 'serif' && /sans/.test(n))) return id;
    return 'helvetica-neue';
  };
  return { family: pick(), bold: /bold|black|heavy|semibold|demi/.test(n), italic: /italic|oblique/.test(n) };
}

/** Font sizes offered by the size buttons (page px). */
export const TEXT_SIZES = [10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64, 80];

export const TEXT_LINE_HEIGHT = 1.35;

export function fontStack(f: TextFont | undefined): string {
  return (TEXT_FONTS.find((x) => x.id === f) ?? TEXT_FONTS[0]).css;
}

/** The box's typeface, weight, slant, underline and box (colour, corners, padding) as CSS properties. */
export function textCss(t: Pick<TextBlock, 'fontFamily' | 'bold' | 'italic' | 'underline' | 'align' | 'lineHeight' | 'strike' | 'background' | 'radius' | 'padding'>): {
  fontFamily: string;
  fontWeight: number;
  fontStyle: 'italic' | 'normal';
  textDecoration: string;
  textAlign: 'left' | 'center' | 'right';
  lineHeight: number;
  backgroundColor?: string;
  borderRadius?: number;
  padding?: string;
  boxSizing: 'border-box';
  '--lh': number;
} {
  const lh = t.lineHeight ?? TEXT_LINE_HEIGHT;
  return {
    fontFamily: fontStack(t.fontFamily),
    fontWeight: t.bold ? 700 : 400,
    fontStyle: t.italic ? 'italic' : 'normal',
    textDecoration: [t.underline ? 'underline' : '', t.strike ? 'line-through' : ''].filter(Boolean).join(' ') || 'none',
    textAlign: t.align ?? 'left',
    lineHeight: lh,
    ...(t.background ? { backgroundColor: t.background } : {}),
    ...(t.radius ? { borderRadius: t.radius } : {}),
    ...(t.padding ? { padding: `${t.padding[1]}px ${t.padding[0]}px` } : {}),
    boxSizing: 'border-box',
    '--lh': lh,
  };
}

/** The same as one CSS declaration string (SVG export). */
export function textCssString(t: TextBlock): string {
  const c = textCss(t);
  return (
    `font-family:${c.fontFamily.replace(/"/g, "'")};font-size:${t.fontSize}px;font-weight:${c.fontWeight};font-style:${c.fontStyle};text-decoration:${c.textDecoration};text-align:${c.textAlign};line-height:${c.lineHeight};--lh:${c.lineHeight};box-sizing:border-box` +
    (c.backgroundColor ? `;background-color:${c.backgroundColor}` : '') +
    (c.borderRadius ? `;border-radius:${c.borderRadius}px` : '') +
    (c.padding ? `;padding:${c.padding}` : '')
  );
}

/** One piece of a text box's text and how it differs from the box (TextBlock.spans). */
export interface TextPiece {
  text: string;
  css: { fontWeight?: number; fontStyle?: 'italic' | 'normal'; textDecoration?: string; color?: string } | null;
}

/** The text cut where its styled parts (spans) start and end; one plain piece without spans. */
export function textPieces(t: Pick<TextBlock, 'text' | 'spans' | 'bold' | 'italic' | 'underline' | 'strike'>): TextPiece[] {
  const spans = (t.spans ?? []).filter((s) => s.end > s.start && s.start < t.text.length).sort((a, b) => a.start - b.start);
  if (!spans.length) return [{ text: t.text, css: null }];
  const out: TextPiece[] = [];
  let at = 0;
  for (const sp of spans) {
    const a = Math.max(at, sp.start), b = Math.min(t.text.length, sp.end);
    if (a > at) out.push({ text: t.text.slice(at, a), css: null });
    if (b <= a) continue;
    const underline = sp.underline ?? t.underline, strike = sp.strike ?? t.strike;
    out.push({
      text: t.text.slice(a, b),
      css: {
        ...(sp.bold !== undefined ? { fontWeight: sp.bold ? 700 : 400 } : {}),
        ...(sp.italic !== undefined ? { fontStyle: sp.italic ? ('italic' as const) : ('normal' as const) } : {}),
        ...(sp.underline !== undefined || sp.strike !== undefined ? { textDecoration: [underline ? 'underline' : '', strike ? 'line-through' : ''].filter(Boolean).join(' ') || 'none' } : {}),
        ...(sp.color ? { color: sp.color } : {}),
      },
    });
    at = b;
  }
  if (at < t.text.length) out.push({ text: t.text.slice(at), css: null });
  return out;
}

/** A canvas `font` value (rasterised previews). */
export function canvasFont(t: TextBlock): string {
  const c = textCss(t);
  return `${c.fontStyle === 'italic' ? 'italic ' : ''}${c.fontWeight} ${t.fontSize}px ${c.fontFamily}`;
}

/** Sizes one step up or down from `size`. */
export function nextTextSize(size: number, dir: 1 | -1): number {
  if (dir > 0) return TEXT_SIZES.find((s) => s > size + 0.01) ?? size;
  return [...TEXT_SIZES].reverse().find((s) => s < size - 0.01) ?? size;
}
