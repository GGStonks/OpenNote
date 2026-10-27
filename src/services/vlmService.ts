import { httpRequest, HttpAbortError, HttpError } from '../platform';
import { AppSettings, resolveChatUrl, resolveModelsUrl } from '../settings';
import { cleanModelOutput } from './latexRender';
import { authError, describeKeyStatus, KeyStatus, serverHeaders } from './serverAuth';
import { prepareTikz } from './tikzEngine';
import { crashLog } from './crashLog';

/**
 * Qwen3-VL (llama.cpp / OpenAI-compatible) client for handwriting → LaTeX / TikZ.
 *
 * Fixes vs v1.0: absolute, persisted endpoint; native HTTP on device (no mixed-content/CORS
 * failures); 180 s default timeout (cold model start through the switchboard); explicit errors
 * instead of silently inserting a hard-coded "fallback" formula; prompts that request a single
 * output format; robust parsing of the reply.
 */

export type ConversionMode = 'math' | 'text' | 'tikz';

export interface ConversionResult {
  latex: string;
  mode: ConversionMode;
  model: string;
  elapsedMs: number;
  truncated: boolean;
}

const PROMPTS: Record<ConversionMode, string> = {
  math: [
    'Transcribe the handwritten mathematics in this image into LaTeX.',
    'Rules:',
    '- Output only the LaTeX math itself: no $, $$, \\[ \\] delimiters, no markdown fences, no explanations.',
    '- Copy exactly what is written. Do not solve, simplify, reorder or complete anything.',
    '- If there are several lines or equations, use \\begin{aligned} ... \\end{aligned}, separate lines with \\\\ and put & before the relation sign (=, <, \\le, \\Rightarrow ...).',
    '- Use standard amsmath commands (\\frac, \\sqrt, \\int, \\sum, \\lim, \\vec, \\mathbb, \\begin{pmatrix}, \\begin{cases}).',
    '- Use \\text{...} for words inside the math.',
  ].join('\n'),
  text: [
    'Transcribe these handwritten notes into LaTeX-formatted text.',
    'Rules:',
    '- Keep the original wording, order and line structure. Do not summarise, translate or add content.',
    '- Write ordinary text as plain text. Inline math as $...$. Displayed equations on their own line as \\[ ... \\].',
    '- Headings as \\section*{...}; bullet lists as \\begin{itemize} \\item ... \\end{itemize}.',
    '- Separate paragraphs with a blank line.',
    '- Output only the transcription: no preamble, no \\documentclass, no markdown fences, no comments.',
  ].join('\n'),
  tikz: [
    'Convert the hand-drawn diagram in this image into TikZ code.',
    'Rules:',
    '- Output exactly one \\begin{tikzpicture} ... \\end{tikzpicture} environment and nothing else (no \\documentclass, no \\usepackage, no markdown fences, no explanations).',
    '- Reproduce every shape, line, arrow and label, with the same relative positions and proportions. Use coordinates in cm; keep the picture within about 12 cm x 9 cm.',
    '- Use only standard TikZ: \\draw, \\fill, \\node, \\coordinate, --, rectangle, circle, ellipse, arc, .. controls .., node labels. Arrows: \\draw[->].',
    '- Put math in labels inside $...$. Use black unless colour is clearly intended.',
    '- If the drawing is a function graph, draw axes with \\draw[->] and the curve with plot[smooth] coordinates {...}.',
  ].join('\n'),
};

function describeError(err: unknown, url: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/timed out/i.test(msg)) return `${msg}. The model may still be loading; try again or raise the timeout in Settings.`;
  // Closed before any reply (TLS cut off, connection reset): the server never answered. Seen with
  // a relay in front of the server when its route from the device failed.
  if (/closed|reset|connection (was )?lost|end of stream|EOF|handshake|SSL|TLS/i.test(msg)) {
    return `The connection to ${url} was closed before the server answered (${msg}). Something between this device and the server dropped it: try again, on another network (Wi-Fi / mobile data), or with Tailscale switched the other way.`;
  }
  if (/failed to fetch|network|refused|unreachable|ECONN|Could not connect|offline|NSURLErrorDomain/i.test(msg)) {
    return `Cannot reach ${url} (${msg}). Check the server address, that the device is on the same network / Tailscale, and that the switchboard is running.`;
  }
  return msg;
}

/**
 * Joins a streamed (server-sent events) chat-completions reply into one completion object, so
 * extractContent() handles streamed and plain JSON replies alike. Returns null if `text` is not SSE.
 */
function joinEventStream(text: string): any | null {
  if (!/^\s*data:/.test(text)) return null;
  let content = '';
  let finish: string | null = null;
  let model: string | undefined;
  for (const line of text.split('\n')) {
    const m = /^data:\s?(.*)$/.exec(line.trim());
    if (!m || m[1] === '[DONE]') continue;
    let ev: any;
    try {
      ev = JSON.parse(m[1]);
    } catch {
      continue;
    }
    if (ev?.error) return ev;
    model ??= ev?.model;
    const choice = ev?.choices?.[0];
    if (!choice) continue;
    content += choice.delta?.content ?? choice.text ?? '';
    finish = choice.finish_reason ?? finish;
  }
  return { model, choices: [{ message: { content }, finish_reason: finish }] };
}

function extractContent(data: any): { text: string; truncated: boolean } {
  const choice = data?.choices?.[0];
  if (!choice) {
    const apiErr = data?.error?.message ?? data?.error ?? data?.message;
    throw new Error(apiErr ? `Server error: ${apiErr}` : 'Server returned no choices');
  }
  let content = choice.message?.content ?? choice.text ?? '';
  if (Array.isArray(content)) content = content.map((c: any) => c?.text ?? '').join('');
  return { text: String(content), truncated: choice.finish_reason === 'length' };
}

/** Post-processes a reply according to the mode. */
export function normaliseReply(raw: string, mode: ConversionMode): string {
  const cleaned = cleanModelOutput(raw);
  if (mode === 'tikz') return prepareTikz(cleaned).picture;
  if (mode === 'math') {
    // Strip a single outer delimiter pair if the model added one anyway.
    let s = cleaned.trim();
    const outer = /^(?:\$\$([\s\S]*)\$\$|\\\[([\s\S]*)\\\]|\$([\s\S]*)\$|\\\(([\s\S]*)\\\))$/.exec(s);
    if (outer) s = (outer[1] ?? outer[2] ?? outer[3] ?? outer[4]).trim();
    s = s.replace(/^\\begin\{(equation|displaymath)\*?\}([\s\S]*)\\end\{\1\*?\}$/, '$2').trim();
    // Several separate display blocks -> one aligned block.
    const blocks = [...s.matchAll(/\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$/g)].map((m) => (m[1] ?? m[2]).trim());
    if (blocks.length > 1) s = `\\begin{aligned}\n${blocks.map((b) => (b.includes('&') ? b : b.replace(/=/, '&='))).join(' \\\\\n')}\n\\end{aligned}`;
    // Qwen sometimes over-escapes braces, e.g. e^{\{i\pi\}}.
    s = s.replace(/\{\\\{([^{}]*)\\\}\}/g, '{$1}');
    return s;
  }
  return cleaned;
}

export async function convertImage(
  imageDataUrl: string,
  mode: ConversionMode,
  settings: AppSettings,
  hint?: string,
  signal?: AbortSignal
): Promise<ConversionResult> {
  const url = resolveChatUrl(settings.vlmEndpoint);
  const base64 = imageDataUrl.includes(',') ? imageDataUrl.split(',')[1] : imageDataUrl;
  if (!base64) throw new Error('Nothing to transcribe: the selection is empty.');

  let prompt = PROMPTS[mode];
  if (hint) prompt += `\n\n${hint}`;

  const started = performance.now();
  let res;
  try {
    res = await httpRequest({
      url,
      method: 'POST',
      headers: serverHeaders(settings),
      timeoutMs: settings.vlmTimeoutSec * 1000,
      signal,
      body: {
        model: settings.modelName,
        temperature: 0,
        top_p: 1,
        max_tokens: mode === 'math' ? 1024 : mode === 'tikz' ? 2048 : 3072,
        // Greedy decoding can fall into a loop that runs to max_tokens (minutes of GPU/CPU time and
        // a timeout in the app). llama.cpp's DRY sampler penalises only long verbatim repeats, so
        // LaTeX's short recurring patterns (& =, \\) are unaffected.
        dry_multiplier: 0.8,
        dry_base: 1.75,
        dry_allowed_length: 8,
        // Streamed so that a cancelled request stops the generation: llama-server only notices a
        // closed connection when it writes to it, and a non-streamed reply writes nothing until
        // the very end. The events are joined after the reply completes (joinEventStream).
        stream: true,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
              { type: 'text', text: prompt },
            ],
          },
        ],
      },
    });
  } catch (err) {
    if (err instanceof HttpAbortError) throw err;
    throw new Error(describeError(err, url));
  }

  const refused = authError(res);
  if (refused) throw new HttpError(refused, res.status, res.text);
  if (res.status === 503) throw new Error('The VLM server answered 503: the model failed to start (see the switchboard / llama-vision service logs).');
  if (res.status < 200 || res.status >= 300) {
    const detail = typeof res.data === 'object' ? res.data?.error?.message ?? JSON.stringify(res.data).slice(0, 300) : res.text.slice(0, 300);
    throw new HttpError(`VLM server returned HTTP ${res.status}: ${detail}`, res.status, res.text);
  }
  const data = typeof res.data === 'object' ? res.data : joinEventStream(res.text);
  if (!data) throw new Error(`Unexpected (non-JSON) reply from ${url}: ${res.text.slice(0, 200)}`);

  const { text, truncated } = extractContent(data);
  const latex = normaliseReply(text, mode);
  if (!latex.trim()) throw new Error('The model returned an empty transcription.');
  return {
    latex,
    mode,
    model: data.model ?? settings.modelName,
    elapsedMs: performance.now() - started,
    truncated,
  };
}

/** Base URL of the switchboard (without /v1/...). */
export function serverBaseUrl(settings: AppSettings): string {
  return resolveChatUrl(settings.vlmEndpoint).replace(/\/v1\/chat\/completions$/, '');
}

/**
 * A GET of the connection test, tried again once if the connection is dropped before any reply
 * (a reused connection the server or a relay had closed failed the test with "connection closed").
 */
async function testGet(url: string, settings: AppSettings) {
  const get = () => httpRequest({ url, timeoutMs: 60000, headers: serverHeaders(settings) });
  try {
    return await get();
  } catch (err) {
    if (err instanceof HttpAbortError || (err instanceof HttpError && err.status) || /timed out/i.test(String((err as Error)?.message))) throw err;
    crashLog.event('server-test-retry', { url, error: String((err as Error)?.message ?? err).slice(0, 200) });
    await new Promise((r) => setTimeout(r, 500));
    return get();
  }
}

export async function testConnection(settings: AppSettings): Promise<string> {
  const keyUrl = serverBaseUrl(settings) + '/opennote/key';
  const url = resolveModelsUrl(settings.vlmEndpoint);
  let res;
  let keyInfo = '';
  try {
    // This device's access (a server without keys answers 404).
    res = await testGet(keyUrl, settings);
    const refused = authError(res);
    if (refused) throw new HttpError(refused, res.status);
    if (res.status === 200 && typeof res.data === 'object' && res.data?.status) {
      const s = res.data as KeyStatus;
      if (s.status === 'limit_reached') throw new HttpError(`This API key has used its token limit (${s.used.toLocaleString()} of ${(s.limit ?? 0).toLocaleString()} tokens). Ask the server's owner to raise it.`, 429);
      keyInfo = describeKeyStatus(s) + ' ';
    }
    res = await testGet(url, settings);
  } catch (err) {
    if (err instanceof HttpError && err.status) throw err;
    crashLog.event('server-test-failed', { error: String((err as Error)?.message ?? err).slice(0, 200) });
    throw new Error(describeError(err, url));
  }
  const refused = authError(res);
  if (refused) throw new HttpError(refused, res.status);
  if (res.status !== 200) return `HTTP ${res.status} from ${url}`;
  const ids: string[] = (res.data?.data ?? res.data?.models ?? []).map((m: any) => m.id ?? m.name).filter(Boolean);
  if (!ids.length) return `${keyInfo}Connected to ${url}, but no models were listed.`;
  const match = ids.includes(settings.modelName);
  return `${keyInfo}Connected. Models: ${ids.join(', ')}${match ? '' : ` — "${settings.modelName}" is not among them`}`;
}
