import katex from 'katex';
import 'katex/dist/katex.min.css';

/**
 * LaTeX normalisation + rendering.
 *
 * VLM output arrives in many shapes ($$..$$, \[..\], align*, full documents, prose mixed with
 * inline math, markdown fences, <think> blocks). Everything is normalised here and rendered with a
 * bundled KaTeX (fonts ship inside the app, so math renders offline).
 */

export function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Removes chat artefacts and LaTeX document scaffolding. */
export function cleanModelOutput(raw: string): string {
  let s = raw.replace(/\r\n/g, '\n');
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
  s = s.replace(/^[\s\S]*?<\/think>/i, ''); // unterminated reasoning prefix
  // Prefer the content of the first fenced block when the model wrapped its answer.
  const fence = /```[a-zA-Z]*\s*\n?([\s\S]*?)```/.exec(s);
  if (fence && fence[1].trim()) s = fence[1];
  s = s.replace(/```[a-zA-Z]*/g, '');
  const doc = /\\begin\{document\}([\s\S]*?)(\\end\{document\}|$)/.exec(s);
  if (doc) s = doc[1];
  s = s
    .replace(/\\documentclass(\[[^\]]*\])?\{[^}]*\}/g, '')
    .replace(/\\usepackage(\[[^\]]*\])?\{[^}]*\}/g, '')
    .replace(/\\(maketitle|tableofcontents)\b/g, '');
  s = s.replace(/^\s*(here is|here's|the latex|latex code|transcription)[^\n]*:\s*\n/i, '');
  return s.trim();
}

/** KaTeX compatibility fixes for constructs it does not implement. */
export function katexCompat(src: string): string {
  return src
    .replace(/\\label\{[^}]*\}/g, '')
    .replace(/\\(nonumber|notag)\b/g, '')
    .replace(/\\intertext\{([^}]*)\}/g, '\\text{$1}\\\\')
    .replace(/\\mathbbm\b/g, '\\mathbb')
    .replace(/\\bm\{/g, '\\boldsymbol{')
    .replace(/\\begin\{(multline|eqnarray)(\*?)\}/g, '\\begin{gather$2}')
    .replace(/\\end\{(multline|eqnarray)(\*?)\}/g, '\\end{gather$2}')
    .replace(/\\(dif|diff)\b/g, '\\mathrm{d}')
    .replace(/\\\s*$/g, '')
    .trim();
}

export interface MathRenderResult {
  html: string;
  error?: string;
}

const KATEX_OPTS = { throwOnError: true, strict: 'ignore' as const, trust: false, output: 'htmlAndMathml' as const };

export function renderMath(latex: string, displayMode = true): MathRenderResult {
  const src = katexCompat(latex);
  try {
    return { html: katex.renderToString(src, { ...KATEX_OPTS, displayMode }) };
  } catch (err: any) {
    const html = katex.renderToString(src, { ...KATEX_OPTS, displayMode, throwOnError: false });
    return { html, error: err?.message ?? String(err) };
  }
}

type Segment =
  | { kind: 'display'; tex: string }
  | { kind: 'inline'; tex: string }
  | { kind: 'text'; text: string };

const DISPLAY_ENVS =
  'equation|equation\\*|align|align\\*|aligned|gather|gather\\*|gathered|multline|multline\\*|eqnarray|eqnarray\\*|alignat|alignat\\*|cases|split|array|matrix|pmatrix|bmatrix|vmatrix|Vmatrix|CD';

/** Splits LaTeX-flavoured notes into text, inline math and display math segments. */
export function segmentLatex(src: string): Segment[] {
  const out: Segment[] = [];
  const re = new RegExp(
    String.raw`\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\begin\{(${DISPLAY_ENVS})\}([\s\S]*?)\\end\{\3\}|\\\(([\s\S]+?)\\\)|\$((?:\\\$|[^$])+?)\$`,
    'g'
  );
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ kind: 'text', text: src.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: 'display', tex: m[1] });
    else if (m[2] !== undefined) out.push({ kind: 'display', tex: m[2] });
    else if (m[3] !== undefined) {
      const env = m[3];
      const body = m[4];
      // equation(*) is just a display wrapper; others are kept so KaTeX lays out alignment.
      out.push({ kind: 'display', tex: /^equation/.test(env) ? body : `\\begin{${env}}${body}\\end{${env}}` });
    } else if (m[5] !== undefined) out.push({ kind: 'inline', tex: m[5] });
    else if (m[6] !== undefined) out.push({ kind: 'inline', tex: m[6] });
    last = re.lastIndex;
  }
  if (last < src.length) out.push({ kind: 'text', text: src.slice(last) });
  return out;
}

/** Heuristic: does undelimited content look like bare math rather than prose? */
export function looksLikeBareMath(src: string): boolean {
  const s = src.trim();
  if (!s) return false;
  if (/\$|\\\[|\\\(|\\begin\{(itemize|enumerate)\}|\\section/.test(s)) return false;
  const words = s.replace(/\\[a-zA-Z]+(\{[^}]*\})?/g, ' ').match(/[A-Za-z]{4,}/g) ?? [];
  const mathy = /\\[a-zA-Z]+|[=^_<>+\-*/]|\d/.test(s);
  return mathy && words.length <= 3;
}

function formatInline(text: string): string {
  return escapeHtml(text)
    .replace(/\\textbf\{([^}]*)\}/g, '<b>$1</b>')
    .replace(/\\(textit|emph)\{([^}]*)\}/g, '<i>$2</i>')
    .replace(/\\underline\{([^}]*)\}/g, '<u>$1</u>')
    .replace(/\\text\{([^}]*)\}/g, '$1')
    .replace(/\\begin\{(itemize|enumerate)\}|\\end\{(itemize|enumerate)\}/g, '')
    .replace(/\\item\s*/g, '<br/>• ')
    .replace(/\\\\(\[[^\]]*\])?/g, '<br/>')
    .replace(/\\(noindent|medskip|bigskip|smallskip|newline|par|centering)\b/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\n/g, '<br/>');
}

const HEADING_RE = /\\(section|subsection|subsubsection)\*?\{([^}]*)\}|^[ \t]*(#{1,4})[ \t]+(.+)$/gm;

/**
 * Renders arbitrary LaTeX-ish content: bare math, display/inline math mixed with text, or
 * environments. Returns HTML plus the first KaTeX error (if any) so the UI can surface it.
 */
export function renderLatexContent(src: string): MathRenderResult {
  const cleaned = cleanModelOutput(src);
  if (!cleaned) return { html: '' };
  const explicit = /\$|\\\[|\\\(/.test(cleaned);
  if (!explicit && looksLikeBareMath(cleaned)) return renderMath(cleaned, true);

  let firstError: string | undefined;
  const blocks: string[] = [];
  let para = '';
  const flush = () => {
    const t = para.replace(/^(\s|<br\/>)+|(\s|<br\/>)+$/g, '');
    if (t) blocks.push(`<p>${t}</p>`);
    para = '';
  };
  const addText = (text: string) => {
    let last = 0;
    let m: RegExpExecArray | null;
    HEADING_RE.lastIndex = 0;
    const pieces: { text?: string; heading?: [number, string] }[] = [];
    while ((m = HEADING_RE.exec(text))) {
      pieces.push({ text: text.slice(last, m.index) });
      const level = m[1] ? ['section', 'subsection', 'subsubsection'].indexOf(m[1]) : m[3].length - 1;
      pieces.push({ heading: [Math.min(level, 2), m[2] ?? m[4]] });
      last = HEADING_RE.lastIndex;
    }
    pieces.push({ text: text.slice(last) });
    for (const piece of pieces) {
      if (piece.heading) {
        flush();
        const tag = `h${piece.heading[0] + 3}`;
        blocks.push(`<${tag} class="on-h">${formatInline(piece.heading[1])}</${tag}>`);
        continue;
      }
      const paras = (piece.text ?? '').split(/\n[ \t]*\n/);
      paras.forEach((pt, i) => {
        if (i > 0) flush();
        para += formatInline(pt.replace(/^\n|\n$/g, ''));
      });
    }
  };

  for (const seg of segmentLatex(cleaned)) {
    if (seg.kind === 'display') {
      flush();
      const r = renderMath(seg.tex, true);
      firstError ??= r.error;
      blocks.push(r.html);
    } else if (seg.kind === 'inline') {
      const r = renderMath(seg.tex, false);
      firstError ??= r.error;
      para += r.html;
    } else {
      addText(seg.text);
    }
  }
  flush();
  return { html: `<div class="on-text">${blocks.join('')}</div>`, error: firstError };
}

/** For .tex / .md export: returns content suitable for a LaTeX document body. */
export function latexForDocument(src: string): string {
  const cleaned = cleanModelOutput(src);
  const segments = segmentLatex(cleaned);
  if (!segments.some((s) => s.kind !== 'text') && looksLikeBareMath(cleaned)) return `\\[\n${cleaned}\n\\]`;
  return cleaned;
}
