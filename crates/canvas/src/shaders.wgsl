// The page's ink on the GPU: the shaders of src/ink/glInk.ts, in WGSL.
//
// Page px go to device px through `m` and `t` (d = m * p + t); `px` is device px per page px.
// Capsules are drawn as instanced quads around each capsule, their coverage from the exact signed
// distance (sdPiece, as the canvas renderer's), either into the coverage texture (cov = 1: the
// union of a colour run by max blend, composited once) or straight to the target (hatches).

struct Uniforms {
  m: mat2x2<f32>,
  t: vec2<f32>,
  size: vec2<f32>,
  px: f32,
  glow: f32,
  glow_pad: f32,
  cov: u32,
  col: vec4<f32>,
  // Paper (fs_paper): the app's paperBackground (src/components/CanvasPage.tsx) in page px.
  p_style: u32,
  p_lw: f32,
  p_origin: vec2<f32>,
  p_size: vec2<f32>,
  p_pad: vec2<f32>,
  p_base: vec4<f32>,
  p_line: vec4<f32>,
  p_margin: vec4<f32>,
  p_grid: vec4<f32>,
  p_major: vec4<f32>,
  p_minor: vec4<f32>,
  p_dot: vec4<f32>,
  // A picture (fs_pic): its box (x, y, w, h page px), the file's part shown (u0, v0, u1, v1),
  // (cos, sin) of its clockwise turn, its opacity, one device px in page px.
  i_quad: vec4<f32>,
  i_uv: vec4<f32>,
  i_rot: vec4<f32>,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(1) @binding(0) var cov_tex: texture_2d<f32>;

fn clip(d: vec2<f32>) -> vec4<f32> {
  return vec4<f32>(d.x / u.size.x * 2.0 - 1.0, 1.0 - d.y / u.size.y * 2.0, 0.0, 1.0);
}

// ---------------------------------------------------------------------------------- capsules

struct CapIn {
  @location(0) a: vec3<f32>,
  @location(1) b: vec3<f32>,
  @location(2) col: vec4<f32>,
};

struct CapOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) p: vec2<f32>,
  @location(1) @interpolate(flat) a: vec3<f32>,
  @location(2) @interpolate(flat) b: vec3<f32>,
  @location(3) @interpolate(flat) col: vec4<f32>,
};

@vertex
fn vs_caps(@builtin(vertex_index) vi: u32, c: CapIn) -> CapOut {
  let corner = vec2<f32>(f32(vi & 1u), f32(vi >> 1u));
  let R = max(c.a.z, c.b.z) + (1.5 + u.glow_pad) / u.px;
  let ab = c.b.xy - c.a.xy;
  let L = length(ab);
  var un = vec2<f32>(1.0, 0.0);
  if (L > 1e-6) { un = ab / L; }
  let p = c.a.xy + un * mix(-R, L + R, corner.x) + vec2<f32>(-un.y, un.x) * mix(-R, R, corner.y);
  var o: CapOut;
  o.p = p;
  o.a = c.a;
  o.b = c.b;
  o.col = c.col;
  o.pos = clip(u.m * p + u.t);
  return o;
}

fn cro(x: vec2<f32>, y: vec2<f32>) -> f32 { return x.x * y.y - x.y * y.x; }

fn sd_piece(p0: vec2<f32>, pa: vec2<f32>, pb: vec2<f32>, ra: f32, rb: f32) -> f32 {
  let ba = pb - pa;
  let h = dot(ba, ba);
  let dr = ra - rb;
  if (h <= dr * dr + 1e-9) {
    if (ra >= rb) { return length(p0 - pa) - ra; }
    return length(p0 - pb) - rb;
  }
  let p = p0 - pa;
  var q = vec2<f32>(dot(p, vec2<f32>(ba.y, -ba.x)), dot(p, ba)) / h;
  q.x = abs(q.x);
  let c = vec2<f32>(sqrt(h - dr * dr), dr);
  let k = cro(c, q);
  let mm = dot(c, q);
  let n = dot(q, q);
  if (k < 0.0) { return sqrt(h * n) - ra; }
  if (k > c.x) { return sqrt(h * (n + 1.0 - 2.0 * q.y)) - rb; }
  return mm - ra;
}

@fragment
fn fs_caps(i: CapOut) -> @location(0) vec4<f32> {
  let d = sd_piece(i.p, i.a.xy, i.b.xy, i.a.z, i.b.z);
  var cov: f32;
  if (u.glow > 0.0) {
    let sg = u.glow * 0.5;
    let rr = i.a.z + i.b.z;
    cov = 1.0 / (1.0 + exp(1.702 * d / sg)) - 1.0 / (1.0 + exp(1.702 * (d + rr) / sg));
  } else {
    cov = clamp(0.5 - d * u.px, 0.0, 1.0);
  }
  if (cov <= 0.004) { discard; }
  if (u.cov == 1u) { return vec4<f32>(cov, 0.0, 0.0, cov); }
  return vec4<f32>(i.col.rgb * i.col.a * cov, i.col.a * cov);
}

// ---------------------------------------------------------------------------------- flat shapes

@vertex
fn vs_flat(@location(0) pos: vec2<f32>) -> @builtin(position) vec4<f32> {
  return clip(u.m * pos + u.t);
}

@fragment
fn fs_flat() -> @location(0) vec4<f32> {
  return u.col;
}

// ---------------------------------------------------------------------------------- full screen

@vertex
fn vs_full(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  // One triangle covering the clip square.
  let x = f32(i32(vi & 1u) * 4 - 1);
  let y = f32(i32(vi >> 1u) * 4 - 1);
  return vec4<f32>(x, y, 0.0, 1.0);
}

/** The coverage texture's run, in the run's colour (premultiplied), over the target. */
@fragment
fn fs_compose(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let cov = textureLoad(cov_tex, vec2<i32>(pos.xy), 0).r;
  return u.col * cov;
}

/** Clears the coverage texture within the scissor. */
@fragment
fn fs_zero() -> @location(0) vec4<f32> {
  return vec4<f32>(0.0);
}

// ---------------------------------------------------------------------------------- paper

struct PageOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) p: vec2<f32>,
};

@vertex
fn vs_page(@location(0) pos: vec2<f32>) -> PageOut {
  var o: PageOut;
  o.p = pos;
  o.pos = clip(u.m * pos + u.t);
  return o;
}

fn over(dst: vec4<f32>, src: vec4<f32>, a: f32) -> vec4<f32> {
  let sa = src.a * a;
  return vec4<f32>(src.rgb * sa + dst.rgb * (1.0 - sa), sa + dst.a * (1.0 - sa));
}

// How much of the pixel around `p` (half a pixel `h` either side, page px) the band
// [a, a + w) covers along one axis.
fn band(p: f32, a: f32, w: f32, h: f32) -> f32 {
  return clamp((min(p + h, a + w) - max(p - h, a)) / (2.0 * h), 0.0, 1.0);
}

// Lines of width `w` repeating every `step` from `phase`, along one axis.
fn lines(p: f32, phase: f32, step: f32, w: f32, h: f32) -> f32 {
  let a = phase + floor((p - phase) / step) * step;
  return min(1.0, band(p, a, w, h) + band(p, a - step, w, h) + band(p, a + step, w, h));
}

// The paper as paperBackground (CanvasPage.tsx) paints it with CSS, in page px and scaled with
// the zoom as the page's paper is: 1 px lines (ruled from 79-80 every gap under a blank 79 px top
// band, the margin at x 79-80 over all; grid and graph on the surface's lattice, `p_origin` being
// where the sheet sits on it; graph's majors over its minors), dots of radius 1.3 fading to 0 at
// 1.7 on the surface's 24 px lattice. Each pixel takes the share of it a line covers, so lines
// keep their place and weight at every zoom and sub-pixel offset. Until rs.26 this was the
// thumbnails' bitmap painter: 1 device px lines at rounded places, and only within the screen's
// size of the page's corner (the pattern vanished zoomed in).
@fragment
fn fs_paper(i: PageOut) -> @location(0) vec4<f32> {
  var c = u.p_base;
  let st = u.p_style;
  let h = 0.5 / u.px;
  let p = i.p;
  let s = i.p + u.p_origin;
  if (st >= 1u && st <= 4u) {
    let gap = select(32.0, 24.0, st == 2u || st == 4u);
    // The lines from 79 down (the blank top band covers those above).
    let a0 = 79.0 + floor((p.y - 79.0) / gap) * gap;
    var cov = 0.0;
    for (var k = -1; k <= 1; k++) {
      let a = a0 + f32(k) * gap;
      if (a >= 79.0) { cov += band(p.y, a, 1.0, h); }
    }
    c = over(c, u.p_line, min(cov, 1.0));
    if (st == 1u || st == 2u) {
      c = over(c, u.p_margin, band(p.x, 79.0, 1.0, h));
    }
  } else if (st == 5u) {
    c = over(c, u.p_grid, lines(s.y, 0.0, 24.0, 1.0, h));
    c = over(c, u.p_grid, lines(s.x, 0.0, 24.0, 1.0, h));
  } else if (st == 6u) {
    c = over(c, u.p_minor, lines(s.y, 0.0, 12.0, 1.0, h));
    c = over(c, u.p_minor, lines(s.x, 0.0, 12.0, 1.0, h));
    c = over(c, u.p_major, lines(s.y, 0.0, 60.0, 1.0, h));
    c = over(c, u.p_major, lines(s.x, 0.0, 60.0, 1.0, h));
  } else if (st == 7u) {
    let r = u.p_pad.x;
    let q = s - round(s / 24.0) * 24.0;
    let d2 = dot(q, q);
    let bound = r + 0.4 + 2.0 * h;
    if (d2 < bound * bound) {
      var a = 0.0;
      for (var k = 0u; k < 4u; k++) {
        let o = vec2<f32>(select(-0.5, 0.5, (k & 1u) != 0u), select(-0.5, 0.5, k >= 2u));
        a += clamp((r + 0.4 - length(q + o * h)) / 0.4, 0.0, 1.0);
      }
      c = over(c, u.p_dot, a * 0.25);
    }
  }
  return vec4<f32>(c.rgb * c.a, c.a);
}

// ---------------------------------------------------------------------------------- pictures

@group(2) @binding(0) var pic_tex: texture_2d<f32>;
@group(2) @binding(1) var pic_samp: sampler;

struct PicOut {
  @builtin(position) pos: vec4<f32>,
  // Page px from the box's top left corner, before the turn.
  @location(0) l: vec2<f32>,
};

/** The block's box (Blocks.tsx ImageBlockView: left, top, width, height, then `rotate(deg)` about
 *  its centre: clockwise on screen), one device px larger on each side for its edges' coverage. */
@vertex
fn vs_pic(@builtin(vertex_index) vi: u32) -> PicOut {
  let corner = vec2<f32>(f32(vi & 1u), f32(vi >> 1u));
  let wh = u.i_quad.zw;
  let pad = u.i_rot.w;
  let l = corner * (wh + 2.0 * pad) - pad;
  let d = l - wh * 0.5;
  let cs = u.i_rot.x;
  let sn = u.i_rot.y;
  let p = u.i_quad.xy + wh * 0.5 + vec2<f32>(d.x * cs - d.y * sn, d.x * sn + d.y * cs);
  var o: PicOut;
  o.l = l;
  o.pos = clip(u.m * p + u.t);
  return o;
}

/** The file's pixel there (premultiplied, trilinear), at the block's opacity, times the share of
 *  the device pixel inside the box (its edges antialiased as the browser draws a turned image). */
@fragment
fn fs_pic(i: PicOut) -> @location(0) vec4<f32> {
  let wh = u.i_quad.zw;
  let t = i.l / wh;
  let uv = mix(u.i_uv.xy, u.i_uv.zw, t);
  let c = textureSample(pic_tex, pic_samp, uv);
  let e = min(min(i.l.x, wh.x - i.l.x), min(i.l.y, wh.y - i.l.y)) * u.px;
  let cov = clamp(e + 0.5, 0.0, 1.0);
  return c * (u.i_rot.z * cov);
}
