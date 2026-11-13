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

// Coverage of the band [s, e) over this pixel's extent in page px (the page px per device px).
fn band(v: f32, s: f32, e: f32, hw: f32, px: f32) -> f32 {
  return clamp((min(e, v + hw) - max(s, v - hw)) * px, 0.0, 1.0);
}

// Coverage of the bands [k * period + off, k * period + off + lw) around v.
fn rep(v: f32, period: f32, lw: f32, off: f32, hw: f32, px: f32) -> f32 {
  let s = v - ((v - off) - floor((v - off) / period) * period);
  return min(1.0, band(v, s, s + lw, hw, px) + band(v, s + period, s + period + lw, hw, px) + band(v, s - period, s - period + lw, hw, px));
}

@fragment
fn fs_paper(i: PageOut) -> @location(0) vec4<f32> {
  let px = u.px;
  let hw = 0.5 / px;
  let lw = u.p_lw;
  var c = u.p_base;
  let x = i.p.x;
  let y = i.p.y;
  let st = u.p_style;
  if (st >= 1u && st <= 4u) {
    // Ruled / narrow / lines / narrow lines: lines every gap from y = 80, under a plain top band
    // of 79 px; ruled and narrow keep a margin line at x = 79.
    var gap = 32.0;
    if (st == 2u || st == 4u) { gap = 24.0; }
    let lines = rep(y, gap, lw, 80.0 - lw, hw, px) * band(y, 79.0, 1e9, hw, px);
    c = over(c, u.p_line, lines);
    if (st <= 2u) { c = over(c, u.p_margin, band(x, 79.0, 79.0 + lw, hw, px)); }
  } else if (st == 5u) {
    let ox = x + u.p_origin.x;
    let oy = y + u.p_origin.y;
    c = over(c, u.p_grid, rep(oy, 24.0, lw, 0.0, hw, px));
    c = over(c, u.p_grid, rep(ox, 24.0, lw, 0.0, hw, px));
  } else if (st == 6u) {
    let ox = x + u.p_origin.x;
    let oy = y + u.p_origin.y;
    c = over(c, u.p_minor, rep(oy, 12.0, 1.0, 0.0, hw, px));
    c = over(c, u.p_minor, rep(ox, 12.0, 1.0, 0.0, hw, px));
    c = over(c, u.p_major, rep(oy, 60.0, lw, 0.0, hw, px));
    c = over(c, u.p_major, rep(ox, 60.0, lw, 0.0, hw, px));
  } else if (st == 7u) {
    // Dots of radius 1.3 (fading to 0 over 0.4 px) on the 24 px lattice, centred at 12.
    let ox = x + u.p_origin.x - 12.0;
    let oy = y + u.p_origin.y - 12.0;
    let d = length(vec2<f32>(ox - round(ox / 24.0) * 24.0, oy - round(oy / 24.0) * 24.0));
    let r = u.p_pad.x;
    c = over(c, u.p_dot, 1.0 - clamp((d - r) / 0.4, 0.0, 1.0));
  }
  return vec4<f32>(c.rgb * c.a, c.a);
}
