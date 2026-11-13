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
