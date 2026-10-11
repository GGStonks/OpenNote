import katex from 'katex';
import { compileTikzToSvg } from './tikzService';

export interface LatexConversionResult {
  latex: string;
  renderedHtml: string;
  isTikz: boolean;
  source: 'vlm' | 'fallback';
}

const DEFAULT_VLM_ENDPOINT = '/v1/chat/completions';

export async function convertHandwritingToLatex(
  imageBase64: string,
  mode: 'math' | 'tikz' = 'math',
  endpoint: string = DEFAULT_VLM_ENDPOINT,
  modelName: string = 'qwen3-vl'
): Promise<LatexConversionResult> {
  const cleanBase64 = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;

  let prompt = '';
  if (mode === 'tikz') {
    prompt = `You are an expert LaTeX and PGF/TikZ diagram programmer.
Examine this handwritten drawing, geometric sketch, flowchart, circuit, or diagram carefully.
Transcribe it into clean, compilable TikZ code using \\begin{tikzpicture} ... \\end{tikzpicture}.
Use appropriate nodes, coordinates, shapes, arrows, and styles.
Return ONLY the \\begin{tikzpicture} ... \\end{tikzpicture} snippet. Do not include conversational commentary or extra markdown fences.`;
  } else {
    prompt = `You are an expert handwriting-to-LaTeX converter.
Examine this handwritten math equation or formula carefully.
Transcribe the exact mathematical formulas, equations, or notes into clean, compilable LaTeX.
Return ONLY the LaTeX code inside \\[ ... \\] or an align* environment. Do not include markdown commentary, conversational preamble, or explanation.`;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer sk-dummy'
      },
      body: JSON.stringify({
        model: modelName,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/png;base64,${cleanBase64}`
                }
              }
            ]
          }
        ],
        temperature: 0.1,
        max_tokens: 1536
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const data = await response.json();
      let rawText = data.choices?.[0]?.message?.content || '';

      // Clean markdown fences
      rawText = rawText.replace(/```(?:latex|tex|tikz)?/gi, '').replace(/```/g, '').trim();

      const isTikzResult = mode === 'tikz' || rawText.includes('tikzpicture');
      let cleanCode = rawText;

      if (!isTikzResult) {
        const match = rawText.match(/\\\[([\s\S]*?)\\\]/) || rawText.match(/\$\$([\s\S]*?)\$\$/);
        cleanCode = match ? match[1].trim() : rawText.trim();
      }

      const renderedHtml = isTikzResult ? renderTikzPreview(cleanCode) : renderLatexToHtml(cleanCode);

      return {
        latex: cleanCode,
        renderedHtml,
        isTikz: isTikzResult,
        source: 'vlm'
      };
    }
  } catch (err) {
    console.warn('VLM endpoint unreachable, using smart math/tikz fallback:', err);
  }

  // Graceful fallback for offline testing
  if (mode === 'tikz') {
    const fallbackTikz = `\\begin{tikzpicture}[scale=1.2]
  \\draw[->] (-0.5,0) -- (3,0) node[right] {$x$};
  \\draw[->] (0,-0.5) -- (0,3) node[above] {$y$};
  \\draw[thick, blue] (0,0) -- (2,2) node[midway, above left] {$y=x$};
  \\draw[fill=red] (2,2) circle (2pt) node[right] {$(2,2)$};
\\end{tikzpicture}`;
    return {
      latex: fallbackTikz,
      renderedHtml: renderTikzPreview(fallbackTikz),
      isTikz: true,
      source: 'fallback'
    };
  }

  const fallbackLatex = '\\oint_{\\mathcal{C}} \\mathbf{F} \\cdot d\\mathbf{r} = \\iint_{\\mathcal{S}} (\\nabla \\times \\mathbf{F}) \\cdot d\\mathbf{S}';
  return {
    latex: fallbackLatex,
    renderedHtml: renderLatexToHtml(fallbackLatex),
    isTikz: false,
    source: 'fallback'
  };
}

export function renderLatexToHtml(latex: string): string {
  try {
    return katex.renderToString(latex, {
      displayMode: true,
      throwOnError: false
    });
  } catch (e) {
    console.error('KaTeX rendering error:', e);
    return `<span class="text-red-500 font-mono text-xs">Error rendering: ${escapeHtml(latex)}</span>`;
  }
}

/**
 * Renders TikZ code as a clean, transparent vector SVG graphic
 */
export function renderTikzPreview(tikzCode: string, width: number = 360, height: number = 240): string {
  return compileTikzToSvg(tikzCode, width, height);
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
