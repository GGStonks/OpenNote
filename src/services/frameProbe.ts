import { crashLog } from './crashLog';

/**
 * Frame-rate test (Settings > Diagnostics): how fast this device's web view draws, for choosing
 * how zooming is drawn. Pinches on the iPad ran at 33 ms a frame with the note moving; whether
 * that is the web view's ceiling or the cost of moving the note decides whether ink drawn on the
 * GPU in the page (WebGL, as Notability draws with Metal) could be fluid, or only the shell can.
 *
 * Each phase runs PHASE_MS and its frame gaps go into the crash report ('probe'):
 *   idle    nothing changes
 *   note    the open note scaled every frame, as a pinch drawn by the page did
 *   webgl   a screen-sized WebGL canvas drawing 30,000 triangles every frame at a new scale
 *   canvas  a screen-sized 2D canvas drawing 300 curves every frame at a new scale
 */
const PHASE_MS = 1600;
const WARMUP_MS = 200;
const KEY = 'opennote_frameprobe_v1';

export interface ProbeResult {
  at: number;
  phases: Record<string, { p50: number; p95: number; fps: number; frames: number } | null>;
}

const frame = () => new Promise<number>((r) => requestAnimationFrame(r));

async function measure(step: (t: number) => void): Promise<{ p50: number; p95: number; fps: number; frames: number }> {
  const t0 = await frame();
  const times: number[] = [];
  for (let t = t0; t - t0 < PHASE_MS; ) {
    step(t - t0);
    t = await frame();
    if (t - t0 > WARMUP_MS) times.push(t);
  }
  const gaps = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
  const p50 = gaps[gaps.length >> 1] ?? 0;
  const mean = gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length);
  return { p50: Math.round(p50 * 10) / 10, p95: Math.round((gaps[Math.floor(gaps.length * 0.95)] ?? 0) * 10) / 10, fps: Math.round(1000 / Math.max(1, mean)), frames: gaps.length };
}

function screenCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  c.width = Math.round(innerWidth * dpr);
  c.height = Math.round(innerHeight * dpr);
  Object.assign(c.style, { position: 'fixed', left: '0', top: '0', width: `${innerWidth}px`, height: `${innerHeight}px`, zIndex: '9999', pointerEvents: 'none' });
  document.body.appendChild(c);
  return c;
}

async function webglPhase() {
  const c = screenCanvas();
  try {
    const gl = c.getContext('webgl', { antialias: true, alpha: true });
    if (!gl) return null;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, 'attribute vec2 p; uniform float k; void main() { gl_Position = vec4((p - 0.5) * 2.0 * k, 0.0, 1.0); }'));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, 'precision mediump float; void main() { gl_FragColor = vec4(0.07, 0.09, 0.15, 1.0); }'));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    // 30,000 thin triangles scattered like handwriting.
    const n = 30000, v = new Float32Array(n * 6);
    let x = 0.5, y = 0.5;
    for (let i = 0; i < n; i++) {
      x = Math.min(1, Math.max(0, x + (Math.random() - 0.5) * 0.02));
      y = Math.min(1, Math.max(0, y + (Math.random() - 0.5) * 0.02));
      v.set([x, y, x + 0.004, y + 0.001, x + 0.001, y + 0.004], i * 6);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const k = gl.getUniformLocation(prog, 'k');
    gl.viewport(0, 0, c.width, c.height);
    return await measure((t) => {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(k, 1 + 0.3 * Math.sin(t / 300));
      gl.drawArrays(gl.TRIANGLES, 0, n * 3);
    });
  } finally {
    c.remove();
  }
}

async function canvasPhase() {
  const c = screenCanvas();
  try {
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const curves = Array.from({ length: 300 }, () => Array.from({ length: 6 }, () => Math.random()));
    return await measure((t) => {
      const s = 1 + 0.3 * Math.sin(t / 300);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.setTransform(s * c.width, 0, 0, s * c.height, 0, 0);
      ctx.lineWidth = 0.002;
      ctx.strokeStyle = '#111827';
      ctx.beginPath();
      for (const q of curves) {
        ctx.moveTo(q[0], q[1]);
        ctx.quadraticCurveTo(q[2], q[3], q[4], q[5]);
      }
      ctx.stroke();
    });
  } finally {
    c.remove();
  }
}

async function notePhase() {
  const el = document.querySelector<HTMLElement>('[data-note-content]');
  if (!el) return null;
  const prev = { transform: el.style.transform, origin: el.style.transformOrigin, will: el.style.willChange };
  el.style.transformOrigin = '50% 30%';
  el.style.willChange = 'transform';
  try {
    return await measure((t) => {
      el.style.transform = `scale(${1 + 0.3 * Math.sin(t / 300)})`;
    });
  } finally {
    Object.assign(el.style, { transform: prev.transform, transformOrigin: prev.origin, willChange: prev.will });
  }
}

export const frameProbe = {
  get last(): ProbeResult | null {
    try {
      return JSON.parse(localStorage.getItem(KEY) || 'null') as ProbeResult | null;
    } catch {
      return null;
    }
  },
  async run(): Promise<ProbeResult> {
    const label = document.createElement('div');
    label.textContent = 'Measuring the frame rate… (7 s, keep the screen still)';
    Object.assign(label.style, { position: 'fixed', left: '50%', bottom: '24px', transform: 'translateX(-50%)', zIndex: '10000', padding: '8px 14px', borderRadius: '12px', background: 'rgba(28,28,30,0.9)', color: '#fff', font: '600 13px system-ui', pointerEvents: 'none' });
    document.body.appendChild(label);
    const phases: ProbeResult['phases'] = {};
    try {
      phases.idle = await measure(() => {});
      phases.note = await notePhase();
      phases.webgl = await webglPhase();
      phases.canvas = await canvasPhase();
    } finally {
      label.remove();
    }
    const result = { at: Date.now(), phases };
    crashLog.event('probe', { ...Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, v])), dpr: window.devicePixelRatio, w: innerWidth, h: innerHeight, maxFps: window.OpenNoteNative?.maxFps, fullFrameRate: window.OpenNoteNative?.fullFrameRate });
    try {
      localStorage.setItem(KEY, JSON.stringify(result));
    } catch {
      /* storage full */
    }
    return result;
  },
};

// For the UI benchmark (bench/ui.mjs --only probe).
(window as unknown as { __opennoteFrameProbe?: typeof frameProbe }).__opennoteFrameProbe = frameProbe;
