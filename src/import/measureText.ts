import type { TextBlock } from '../types';
import { richTextClass, textBlockHtml } from '../editor/richText';
import { textCss } from '../editor/textStyle';

let host: HTMLDivElement | null = null;

/**
 * The height (page px) of a text box as the page draws it: the same HTML and CSS (Blocks.tsx's
 * text box), laid out off screen. Importers place boxes one under another with it.
 */
export function measureTextBlock(t: TextBlock): number {
  if (!host) {
    host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:absolute;left:-100000px;top:0;visibility:hidden;pointer-events:none;contain:layout style;';
    document.body.appendChild(host);
  }
  const box = document.createElement('div');
  Object.assign(box.style, textCss(t) as unknown as Record<string, string>);
  box.style.setProperty('--lh', String(t.lineHeight ?? 1.35));
  box.style.width = `${t.width}px`;
  box.style.fontSize = `${t.fontSize}px`;
  box.style.position = 'absolute';
  box.innerHTML = `<div class="${richTextClass(t)}">${textBlockHtml(t)}</div>`;
  host.appendChild(box);
  const h = box.getBoundingClientRect().height;
  box.remove();
  return Math.max(h, t.height ?? 0);
}
