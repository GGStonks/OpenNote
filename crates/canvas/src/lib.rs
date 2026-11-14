//! The page drawn on the GPU (docs/rust-native-canvas.md, step N1).
//!
//! `Scene::build` turns the page's z-layers of strokes into the same draw ops as the page's WebGL
//! ink (src/ink/glInk.ts `Builder`): a highlighter laid on as one see-through shape; opaque
//! strokes of one colour in a row together as one coverage run (their overlapping capsules never
//! darken), a see-through stroke alone; a shape's fill by even-odd stencil (solid, a hole that
//! erases, or hatch capsules under the stencil); an arrowhead as a flat triangle.
//! `GpuCanvas::draw` renders a scene through a `Transform` onto any target texture: the passes of
//! glInk's `draw` and `layOn` on wgpu. `render_offscreen` is the PC path (tests, the CLI).

pub mod host;
pub use wgpu;

use bytemuck::{Pod, Zeroable};
use model::Stroke;
use renderer::builder::{build_stroke_ops, FillMode, RenderOpKind};
use renderer::capsule::Capsule;
use renderer::color::Rgba;
use wgpu::util::DeviceExt;

/// Page px to device px: d = (a x + c y + ox, b x + d y + oy) (glInk's `GlTransform`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Transform {
    pub a: f32,
    pub b: f32,
    pub c: f32,
    pub d: f32,
    pub ox: f32,
    pub oy: f32,
}

impl Transform {
    pub fn scale(k: f32, ox: f32, oy: f32) -> Self {
        Transform { a: k, b: 0.0, c: 0.0, d: k, ox, oy }
    }
    /// Device px per page px.
    pub fn px(&self) -> f32 {
        (self.a * self.d - self.b * self.c).abs().sqrt().max(1e-6)
    }
    fn apply(&self, x: f32, y: f32) -> (f32, f32) {
        (self.a * x + self.c * y + self.ox, self.b * x + self.d * y + self.oy)
    }
}

/// A box in page px.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PageBox {
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct CapInst {
    a: [f32; 3],
    b: [f32; 3],
    col: [f32; 4],
}

#[derive(Clone, Debug)]
pub enum Op {
    /// A coverage run (max blend), composited once in `col` (straight alpha).
    See { first: u32, count: u32, col: [f32; 4], bx: PageBox },
    /// An even-odd fill of `count` flat vertices (a triangle list) from `first`; then the box
    /// (6 flat vertices at `box_first`) in `col`, erased (hole), or `hatch_count` capsules from
    /// `hatch_first` under the stencil.
    Fill { first: u32, count: u32, mode: FillMode, col: [f32; 4], bx: PageBox, box_first: u32, hatch_first: u32, hatch_count: u32 },
    /// Plain triangles in `col` (arrowheads).
    Flat { first: u32, count: u32, col: [f32; 4], bx: PageBox },
}

/// The page's draw list; `caps` and `flat` are the GPU buffers' contents.
#[derive(Clone, Debug, Default)]
pub struct Scene {
    pub caps: Vec<CapInst>,
    pub flat: Vec<[f32; 2]>,
    pub ops: Vec<Op>,
}

const fn rgba(c: Rgba) -> [f32; 4] {
    [c.r, c.g, c.b, c.a]
}

fn box_of_caps(caps: &[Capsule]) -> PageBox {
    let mut b = PageBox { x0: f32::INFINITY, y0: f32::INFINITY, x1: f32::NEG_INFINITY, y1: f32::NEG_INFINITY };
    for c in caps {
        let (x0, y0, x1, y1) = c.bounds();
        b.x0 = b.x0.min(x0 as f32);
        b.y0 = b.y0.min(y0 as f32);
        b.x1 = b.x1.max(x1 as f32);
        b.y1 = b.y1.max(y1 as f32);
    }
    b
}

impl Scene {
    /// The scene of `layers` (bottom first, strokes in page order within a layer), drawn per
    /// layer in drawStrokes' order: highlighters, fills, ink, arrowheads.
    pub fn build(layers: &[&[Stroke]]) -> Scene {
        let mut sc = Scene::default();
        for layer in layers {
            let mut hl: Vec<Op> = Vec::new();
            let mut fills: Vec<Op> = Vec::new();
            let mut ink: Vec<Op> = Vec::new();
            let mut arrows: Vec<Op> = Vec::new();
            // The open opaque run: its op index in `ink`, its colour, and whether the capsules
            // pushed since are still contiguous with it.
            let mut run: Option<(usize, [f32; 4])> = None;
            for s in layer.iter() {
                for op in build_stroke_ops(s) {
                    match op.kind {
                        RenderOpKind::Highlighter { caps } => {
                            run = None;
                            hl.push(Op::See { first: sc.push_caps(&caps, op.color), count: caps.len() as u32, col: rgba(op.color), bx: box_of_caps(&caps) });
                        }
                        RenderOpKind::Fill { area, mode, hatch_caps } => {
                            run = None;
                            if area.len() < 3 {
                                continue;
                            }
                            let bx = {
                                let mut b = PageBox { x0: f32::INFINITY, y0: f32::INFINITY, x1: f32::NEG_INFINITY, y1: f32::NEG_INFINITY };
                                for p in &area {
                                    b.x0 = b.x0.min(p.x as f32);
                                    b.y0 = b.y0.min(p.y as f32);
                                    b.x1 = b.x1.max(p.x as f32);
                                    b.y1 = b.y1.max(p.y as f32);
                                }
                                b
                            };
                            // The fan from the first corner as a triangle list (each triangle flips the stencil).
                            let first = sc.flat.len() as u32;
                            let p0 = area[0];
                            for w in area.windows(2).skip(1) {
                                sc.flat.push([p0.x as f32, p0.y as f32]);
                                sc.flat.push([w[0].x as f32, w[0].y as f32]);
                                sc.flat.push([w[1].x as f32, w[1].y as f32]);
                            }
                            let count = sc.flat.len() as u32 - first;
                            let box_first = sc.flat.len() as u32;
                            for (x, y) in [(bx.x0, bx.y0), (bx.x1, bx.y0), (bx.x0, bx.y1), (bx.x1, bx.y0), (bx.x1, bx.y1), (bx.x0, bx.y1)] {
                                sc.flat.push([x, y]);
                            }
                            let hatch_first = sc.push_caps(&hatch_caps, op.color);
                            fills.push(Op::Fill { first, count, mode, col: rgba(op.color), bx, box_first, hatch_first, hatch_count: hatch_caps.len() as u32 });
                        }
                        RenderOpKind::Ink { caps } => {
                            let col = rgba(op.color);
                            let first = sc.push_caps(&caps, op.color);
                            let bx = box_of_caps(&caps);
                            match run {
                                Some((i, rc)) if rc == col && col[3] >= 1.0 => {
                                    if let Op::See { count, bx: b, .. } = &mut ink[i] {
                                        *count += caps.len() as u32;
                                        b.x0 = b.x0.min(bx.x0);
                                        b.y0 = b.y0.min(bx.y0);
                                        b.x1 = b.x1.max(bx.x1);
                                        b.y1 = b.y1.max(bx.y1);
                                    }
                                }
                                _ => {
                                    ink.push(Op::See { first, count: caps.len() as u32, col, bx });
                                    run = if col[3] >= 1.0 { Some((ink.len() - 1, col)) } else { None };
                                }
                            }
                        }
                        RenderOpKind::Arrow { points } => {
                            if points.is_empty() {
                                continue;
                            }
                            let bx = {
                                let mut b = PageBox { x0: f32::INFINITY, y0: f32::INFINITY, x1: f32::NEG_INFINITY, y1: f32::NEG_INFINITY };
                                for p in &points {
                                    b.x0 = b.x0.min(p.x as f32);
                                    b.y0 = b.y0.min(p.y as f32);
                                    b.x1 = b.x1.max(p.x as f32);
                                    b.y1 = b.y1.max(p.y as f32);
                                }
                                b
                            };
                            let first = sc.flat.len() as u32;
                            for p in points {
                                sc.flat.push([p.x as f32, p.y as f32]);
                            }
                            arrows.push(Op::Flat { first, count: 3, col: rgba(op.color), bx });
                        }
                        RenderOpKind::Glow { .. } => {}
                    }
                }
            }
            sc.ops.extend(hl);
            sc.ops.extend(fills);
            sc.ops.extend(ink);
            sc.ops.extend(arrows);
        }
        sc
    }

    fn push_caps(&mut self, caps: &[Capsule], col: Rgba) -> u32 {
        let first = self.caps.len() as u32;
        let c = rgba(col);
        for k in caps {
            self.caps.push(CapInst { a: [k.ax as f32, k.ay as f32, k.ra as f32], b: [k.bx as f32, k.by as f32, k.rb as f32], col: c });
        }
        first
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
struct Uniforms {
    m: [f32; 4],
    t: [f32; 2],
    size: [f32; 2],
    px: f32,
    glow: f32,
    glow_pad: f32,
    cov: u32,
    col: [f32; 4],
    p_style: u32,
    p_lw: f32,
    p_origin: [f32; 2],
    p_size: [f32; 2],
    p_pad: [f32; 2],
    p_base: [f32; 4],
    p_line: [f32; 4],
    p_margin: [f32; 4],
    p_grid: [f32; 4],
    p_major: [f32; 4],
    p_minor: [f32; 4],
    p_dot: [f32; 4],
}

/// A page's paper, as the app's `paperBackground` (CanvasPage.tsx) draws it: the colours and the
/// lattice origin are decided here from what the page knows (its hex colour, whether it is dark,
/// a chosen pattern colour), the pattern itself in `fs_paper`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Paper {
    pub width: f32,
    pub height: f32,
    /// 0 blank, 1 ruled, 2 narrow, 3 lines, 4 narrowLines, 5 grid, 6 graph, 7 dots.
    pub style: u32,
    pub base: [f32; 4],
    pub dark: bool,
    /// A chosen pattern colour (rgb 0..1), else the defaults.
    pub pattern: Option<[f32; 3]>,
    /// Where the page sits on the surface (page px): grids and dots line up across pages.
    pub origin: [f32; 2],
}

impl Paper {
    pub fn style_code(name: &str) -> u32 {
        match name { "ruled" => 1, "narrow" => 2, "lines" => 3, "narrowLines" => 4, "grid" => 5, "graph" => 6, "dots" => 7, _ => 0 }
    }

    fn uniforms(&self, base: &Uniforms) -> Uniforms {
        let c = |r: f32, g: f32, b: f32, a: f32| [r / 255.0, g / 255.0, b / 255.0, a];
        let dark = self.dark;
        // paperBackground's `ink`: a chosen colour at three times the alpha (capped), else the defaults.
        let ink = |a: f32, light: [f32; 4], on_dark: [f32; 4]| match self.pattern {
            Some(pc) => [pc[0], pc[1], pc[2], (a * 3.0).min(1.0)],
            None => if dark { on_dark } else { light },
        };
        let line = match self.pattern { Some(_) => ink(0.22, [0.0; 4], [0.0; 4]), None => if dark { c(255.0, 255.0, 255.0, 0.13) } else { c(59.0, 130.0, 246.0, 0.22) } };
        let grid = ink(if dark { 0.09 } else { 0.08 }, c(0.0, 0.0, 0.0, 0.08), c(255.0, 255.0, 255.0, 0.09));
        let margin = if dark { c(239.0, 68.0, 68.0, 0.35) } else { c(239.0, 68.0, 68.0, 0.4) };
        let major = ink(if dark { 0.16 } else { 0.13 }, c(0.0, 0.0, 0.0, 0.13), c(255.0, 255.0, 255.0, 0.16));
        let minor = match self.pattern { Some(pc) => [pc[0], pc[1], pc[2], 0.15], None => if dark { c(255.0, 255.0, 255.0, 0.06) } else { c(0.0, 0.0, 0.0, 0.05) } };
        let dot = match self.pattern { Some(pc) => [pc[0], pc[1], pc[2], 0.7], None => if dark { c(255.0, 255.0, 255.0, 0.28) } else { c(0.0, 0.0, 0.0, 0.22) } };
        Uniforms { p_style: self.style, p_lw: 1.0, p_origin: self.origin, p_size: [self.width, self.height], p_pad: [1.3, 0.0], p_base: self.base, p_line: line, p_margin: margin, p_grid: grid, p_major: major, p_minor: minor, p_dot: dot, ..*base }
    }
}

/// One page of a frame: its scene through its transform, over its paper.
pub struct PageDraw<'a> {
    pub scene: &'a GpuScene,
    pub tf: Transform,
    pub paper: Option<Paper>,
}

/// What one frame shows: the desk colour (None: see-through) and the pages on it.
pub struct Frame<'a> {
    pub clear: Option<Rgba>,
    pub pages: Vec<PageDraw<'a>>,
}

const UNIFORM_STRIDE: u64 = 256;
const COV_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::R8Unorm;
const STENCIL_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Stencil8;

/// A scene's buffers on the device.
pub struct GpuScene {
    caps: wgpu::Buffer,
    flat: wgpu::Buffer,
    ops: Vec<Op>,
}

#[derive(Clone, Copy)]
struct SeeItem {
    s0: usize,
    s1: usize,
    first: u32,
    count: u32,
    sc: (u32, u32, u32, u32),
}

#[derive(Clone, Copy)]
struct FlatItem {
    s0: usize,
    first: u32,
    count: u32,
    sc: (u32, u32, u32, u32),
}

pub struct GpuCanvas {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    format: wgpu::TextureFormat,
    uniform_bgl: wgpu::BindGroupLayout,
    tex_bgl: wgpu::BindGroupLayout,
    caps_cov: wgpu::RenderPipeline,
    zero_cov: wgpu::RenderPipeline,
    compose: wgpu::RenderPipeline,
    fill_stencil: wgpu::RenderPipeline,
    flat_box: wgpu::RenderPipeline,
    flat_hole: wgpu::RenderPipeline,
    caps_hatch: wgpu::RenderPipeline,
    flat_plain: wgpu::RenderPipeline,
    paper: wgpu::RenderPipeline,
    /// The pages' rectangles of the frame being drawn (6 vertices each).
    rects: wgpu::Buffer,
    rects_capacity: usize,
    uniforms: wgpu::Buffer,
    uniform_bg: wgpu::BindGroup,
    uniform_capacity: u64,
    size: (u32, u32),
    cov_tex: Option<(wgpu::Texture, wgpu::TextureView, wgpu::BindGroup)>,
    stencil: Option<wgpu::TextureView>,
    slots_scratch: Vec<Uniforms>,
    rects_scratch: Vec<[f32; 2]>,
    plan_scratch: Vec<(usize, Option<usize>, Vec<(usize, usize)>)>,
    bytes_scratch: Vec<u8>,
}

const OVER: wgpu::BlendState = wgpu::BlendState {
    color: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add },
    alpha: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add },
};
const ERASE: wgpu::BlendState = wgpu::BlendState {
    color: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::Zero, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add },
    alpha: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::Zero, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add },
};
const MAX: wgpu::BlendState = wgpu::BlendState {
    color: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Max },
    alpha: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Max },
};

fn stencil_state(compare: wgpu::CompareFunction, pass_op: wgpu::StencilOperation) -> wgpu::DepthStencilState {
    let face = wgpu::StencilFaceState { compare, fail_op: wgpu::StencilOperation::Keep, depth_fail_op: wgpu::StencilOperation::Keep, pass_op };
    wgpu::DepthStencilState {
        format: STENCIL_FORMAT,
        depth_write_enabled: false,
        depth_compare: wgpu::CompareFunction::Always,
        stencil: wgpu::StencilState { front: face, back: face, read_mask: 0xff, write_mask: 0xff },
        bias: wgpu::DepthBiasState::default(),
    }
}

impl GpuCanvas {
    pub fn new(device: wgpu::Device, queue: wgpu::Queue, format: wgpu::TextureFormat) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("canvas"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders.wgsl").into()),
        });
        let uniform_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("uniforms"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: true, min_binding_size: wgpu::BufferSize::new(std::mem::size_of::<Uniforms>() as u64) },
                count: None,
            }],
        });
        let tex_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("coverage"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: false }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
                count: None,
            }],
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[&uniform_bgl, &tex_bgl], push_constant_ranges: &[] });
        // The coverage pass draws into the coverage texture: its pipelines must not bind it.
        let layout_cov = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("coverage"), bind_group_layouts: &[&uniform_bgl], push_constant_ranges: &[] });
        let cap_layout = wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<CapInst>() as u64,
            step_mode: wgpu::VertexStepMode::Instance,
            attributes: &wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x4],
        };
        let flat_layout = wgpu::VertexBufferLayout { array_stride: 8, step_mode: wgpu::VertexStepMode::Vertex, attributes: &wgpu::vertex_attr_array![0 => Float32x2] };
        let make = |layout: &wgpu::PipelineLayout, label: &str, vs: &str, fs: &str, buffers: &[wgpu::VertexBufferLayout], topology: wgpu::PrimitiveTopology, target: wgpu::TextureFormat, blend: Option<wgpu::BlendState>, write: wgpu::ColorWrites, ds: Option<wgpu::DepthStencilState>| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(layout),
                vertex: wgpu::VertexState { module: &shader, entry_point: Some(vs), buffers, compilation_options: Default::default() },
                fragment: Some(wgpu::FragmentState { module: &shader, entry_point: Some(fs), targets: &[Some(wgpu::ColorTargetState { format: target, blend, write_mask: write })], compilation_options: Default::default() }),
                primitive: wgpu::PrimitiveState { topology, cull_mode: None, ..Default::default() },
                depth_stencil: ds,
                multisample: wgpu::MultisampleState::default(),
                multiview: None,
                cache: None,
            })
        };
        use wgpu::{ColorWrites as W, CompareFunction as C, PrimitiveTopology as T, StencilOperation as S};
        let keep = || Some(stencil_state(C::Always, S::Keep));
        let caps_cov = make(&layout_cov, "caps-cov", "vs_caps", "fs_caps", std::slice::from_ref(&cap_layout), T::TriangleStrip, COV_FORMAT, Some(MAX), W::ALL, None);
        let zero_cov = make(&layout_cov, "zero-cov", "vs_full", "fs_zero", &[], T::TriangleList, COV_FORMAT, None, W::ALL, None);
        let compose = make(&layout, "compose", "vs_full", "fs_compose", &[], T::TriangleList, format, Some(OVER), W::ALL, keep());
        let fill_stencil = make(&layout, "fill-stencil", "vs_flat", "fs_flat", std::slice::from_ref(&flat_layout), T::TriangleList, format, None, W::empty(), Some(stencil_state(C::Always, S::Invert)));
        let flat_box = make(&layout, "flat-box", "vs_flat", "fs_flat", std::slice::from_ref(&flat_layout), T::TriangleList, format, Some(OVER), W::ALL, Some(stencil_state(C::NotEqual, S::Keep)));
        let flat_hole = make(&layout, "flat-hole", "vs_flat", "fs_flat", std::slice::from_ref(&flat_layout), T::TriangleList, format, Some(ERASE), W::ALL, Some(stencil_state(C::NotEqual, S::Keep)));
        let caps_hatch = make(&layout, "caps-hatch", "vs_caps", "fs_caps", std::slice::from_ref(&cap_layout), T::TriangleStrip, format, Some(OVER), W::ALL, Some(stencil_state(C::NotEqual, S::Keep)));
        let flat_plain = make(&layout, "flat-plain", "vs_flat", "fs_flat", std::slice::from_ref(&flat_layout), T::TriangleList, format, Some(OVER), W::ALL, keep());
        let paper = make(&layout, "paper", "vs_page", "fs_paper", std::slice::from_ref(&flat_layout), T::TriangleList, format, Some(OVER), W::ALL, keep());
        let rects_capacity = 16;
        let rects = device.create_buffer(&wgpu::BufferDescriptor { label: Some("rects"), size: (rects_capacity * 6 * 8) as u64, usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let uniform_capacity = 64;
        let (uniforms, uniform_bg) = Self::uniform_buffer(&device, &uniform_bgl, uniform_capacity);
        GpuCanvas {
            device, queue, format, uniform_bgl, tex_bgl, caps_cov, zero_cov, compose, fill_stencil, flat_box, flat_hole, caps_hatch, flat_plain, paper, rects, rects_capacity,
            uniforms, uniform_bg, uniform_capacity, size: (0, 0), cov_tex: None, stencil: None,
            slots_scratch: Vec::new(), rects_scratch: Vec::new(), plan_scratch: Vec::new(), bytes_scratch: Vec::new(),
        }
    }

    fn uniform_buffer(device: &wgpu::Device, bgl: &wgpu::BindGroupLayout, n: u64) -> (wgpu::Buffer, wgpu::BindGroup) {
        let buf = device.create_buffer(&wgpu::BufferDescriptor { label: Some("uniforms"), size: n * UNIFORM_STRIDE, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("uniforms"),
            layout: bgl,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding { buffer: &buf, offset: 0, size: wgpu::BufferSize::new(std::mem::size_of::<Uniforms>() as u64) }) }],
        });
        (buf, bg)
    }

    pub fn upload(&self, scene: &Scene) -> GpuScene {
        let caps = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("caps"), contents: bytemuck::cast_slice(if scene.caps.is_empty() { &[CapInst { a: [0.0; 3], b: [0.0; 3], col: [0.0; 4] }] } else { &scene.caps }), usage: wgpu::BufferUsages::VERTEX });
        let flat = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("flat"), contents: bytemuck::cast_slice(if scene.flat.is_empty() { &[[0.0f32; 2]] } else { &scene.flat }), usage: wgpu::BufferUsages::VERTEX });
        GpuScene { caps, flat, ops: scene.ops.clone() }
    }

    fn ensure_size(&mut self, w: u32, h: u32) {
        if self.size == (w, h) && self.cov_tex.is_some() {
            return;
        }
        self.size = (w, h);
        let ext = wgpu::Extent3d { width: w.max(1), height: h.max(1), depth_or_array_layers: 1 };
        let cov = self.device.create_texture(&wgpu::TextureDescriptor { label: Some("coverage"), size: ext, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: COV_FORMAT, usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[] });
        let cov_view = cov.create_view(&Default::default());
        let bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("coverage"), layout: &self.tex_bgl, entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&cov_view) }] });
        self.cov_tex = Some((cov, cov_view, bg));
        let st = self.device.create_texture(&wgpu::TextureDescriptor { label: Some("stencil"), size: ext, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: STENCIL_FORMAT, usage: wgpu::TextureUsages::RENDER_ATTACHMENT, view_formats: &[] });
        self.stencil = Some(st.create_view(&Default::default()));
    }

    /// The device rect (x, y, w, h) of a page box padded by `pad` device px, clipped to the target; None when empty.
    fn scissor(&self, b: &PageBox, tf: &Transform, pad: f32) -> Option<(u32, u32, u32, u32)> {
        let (w, h) = (self.size.0 as f32, self.size.1 as f32);
        let corners = [tf.apply(b.x0, b.y0), tf.apply(b.x1, b.y0), tf.apply(b.x0, b.y1), tf.apply(b.x1, b.y1)];
        let x0 = corners.iter().map(|c| c.0).fold(f32::INFINITY, f32::min) - pad;
        let y0 = corners.iter().map(|c| c.1).fold(f32::INFINITY, f32::min) - pad;
        let x1 = corners.iter().map(|c| c.0).fold(f32::NEG_INFINITY, f32::max) + pad;
        let y1 = corners.iter().map(|c| c.1).fold(f32::NEG_INFINITY, f32::max) + pad;
        let (x0, y0, x1, y1) = (x0.floor().max(0.0), y0.floor().max(0.0), x1.ceil().min(w), y1.ceil().min(h));
        if x1 <= x0 || y1 <= y0 {
            return None;
        }
        Some((x0 as u32, y0 as u32, (x1 - x0) as u32, (y1 - y0) as u32))
    }

    /// Draws `scene` onto `target` (`w` x `h` device px) through `tf`, over `paper` (None: a
    /// see-through target). One command buffer; submitted here.
    pub fn draw(&mut self, target: &wgpu::TextureView, w: u32, h: u32, scene: &GpuScene, tf: &Transform, paper: Option<Rgba>) {
        self.draw_frame(target, w, h, &Frame { clear: paper, pages: vec![PageDraw { scene, tf: *tf, paper: None }] });
    }

    /// Draws a frame: the desk (or nothing), then each page's paper and scene through its
    /// transform. One command buffer; submitted here.
    pub fn draw_frame(&mut self, target: &wgpu::TextureView, w: u32, h: u32, frame: &Frame) {
        self.ensure_size(w, h);
        if frame.pages.len() > self.rects_capacity {
            self.rects_capacity = frame.pages.len().next_power_of_two();
            self.rects = self.device.create_buffer(&wgpu::BufferDescriptor { label: Some("rects"), size: (self.rects_capacity * 6 * 8) as u64, usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        }
        let premul = |c: [f32; 4]| [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]];

        self.slots_scratch.clear();
        self.rects_scratch.clear();
        self.plan_scratch.clear();
        self.bytes_scratch.clear();

        for (pi, page) in frame.pages.iter().enumerate() {
            let tf = &page.tf;
            let base = Uniforms { m: [tf.a, tf.b, tf.c, tf.d], t: [tf.ox, tf.oy], size: [w as f32, h as f32], px: tf.px(), ..Uniforms::zeroed() };
            let paper_slot = page.paper.map(|p| {
                self.slots_scratch.push(p.uniforms(&base));
                for (x, y) in [(0.0, 0.0), (p.width, 0.0), (0.0, p.height), (p.width, 0.0), (p.width, p.height), (0.0, p.height)] {
                    self.rects_scratch.push([x, y]);
                }
                self.slots_scratch.len() - 1
            });
            if paper_slot.is_none() {
                self.rects_scratch.extend([[0.0f32; 2]; 6]);
            }
            let mut slot_of: Vec<(usize, usize)> = Vec::with_capacity(page.scene.ops.len());
            for op in &page.scene.ops {
                match op {
                    Op::See { col, .. } => {
                        self.slots_scratch.push(Uniforms { cov: 1, ..base });
                        self.slots_scratch.push(Uniforms { col: premul(*col), ..base });
                        slot_of.push((self.slots_scratch.len() - 2, self.slots_scratch.len() - 1));
                    }
                    Op::Fill { mode, col, .. } => {
                        self.slots_scratch.push(base);
                        self.slots_scratch.push(Uniforms { col: if *mode == FillMode::Hole { [0.0, 0.0, 0.0, 1.0] } else { premul(*col) }, ..base });
                        slot_of.push((self.slots_scratch.len() - 2, self.slots_scratch.len() - 1));
                    }
                    Op::Flat { col, .. } => {
                        self.slots_scratch.push(Uniforms { col: premul(*col), ..base });
                        slot_of.push((self.slots_scratch.len() - 1, self.slots_scratch.len() - 1));
                    }
                }
            }
            self.plan_scratch.push((pi, paper_slot, slot_of));
        }
        if self.slots_scratch.is_empty() {
            self.slots_scratch.push(Uniforms::zeroed());
        }
        if self.slots_scratch.len() as u64 > self.uniform_capacity {
            self.uniform_capacity = (self.slots_scratch.len() as u64).next_power_of_two();
            let (b, bg) = Self::uniform_buffer(&self.device, &self.uniform_bgl, self.uniform_capacity);
            self.uniforms = b;
            self.uniform_bg = bg;
        }
        let needed_bytes = self.slots_scratch.len() * UNIFORM_STRIDE as usize;
        self.bytes_scratch.resize(needed_bytes, 0);
        for (i, s) in self.slots_scratch.iter().enumerate() {
            let offset = i * UNIFORM_STRIDE as usize;
            self.bytes_scratch[offset..offset + std::mem::size_of::<Uniforms>()].copy_from_slice(bytemuck::bytes_of(s));
        }
        self.queue.write_buffer(&self.uniforms, 0, &self.bytes_scratch);
        if !self.rects_scratch.is_empty() {
            self.queue.write_buffer(&self.rects, 0, bytemuck::cast_slice(&self.rects_scratch));
        }
        let offset = |slot: usize| (slot as u64 * UNIFORM_STRIDE) as u32;

        let (_, cov_view, cov_bg) = self.cov_tex.as_ref().unwrap();
        let stencil = self.stencil.as_ref().unwrap();
        let mut enc = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("canvas") });

        // 1. Initial "desk" pass (clears target + stencil), drawing paper directly inside it!
        {
            let clear = frame.clear.map(|p| wgpu::Color { r: p.r as f64, g: p.g as f64, b: p.b as f64, a: p.a as f64 }).unwrap_or(wgpu::Color::TRANSPARENT);
            let mut p = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("desk"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: target, resolve_target: None, depth_slice: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(clear), store: wgpu::StoreOp::Store } })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment { view: stencil, depth_ops: None, stencil_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(0), store: wgpu::StoreOp::Store }) }),
                ..Default::default()
            });
            let mut paper_bound = false;
            for (pi, paper_slot, _) in &self.plan_scratch {
                let page = &frame.pages[*pi];
                if let (Some(ps), Some(paper)) = (paper_slot, page.paper) {
                    let bx = PageBox { x0: 0.0, y0: 0.0, x1: paper.width, y1: paper.height };
                    if let Some(sc) = self.scissor(&bx, &page.tf, 0.5) {
                        if !paper_bound {
                            p.set_bind_group(1, cov_bg, &[]);
                            p.set_stencil_reference(0);
                            p.set_pipeline(&self.paper);
                            p.set_vertex_buffer(0, self.rects.slice(..));
                            paper_bound = true;
                        }
                        p.set_scissor_rect(sc.0, sc.1, sc.2, sc.3);
                        p.set_bind_group(0, &self.uniform_bg, &[offset(*ps)]);
                        let v0 = (*pi * 6) as u32;
                        p.draw(v0..v0 + 6, 0..1);
                    }
                }
            }
        }

        let scissor_overlaps = |a: (u32, u32, u32, u32), b: (u32, u32, u32, u32)| -> bool {
            !(a.0 + a.2 <= b.0 || b.0 + b.2 <= a.0 || a.1 + a.3 <= b.1 || b.1 + b.3 <= a.1)
        };

        let mut see_batch: Vec<SeeItem> = Vec::new();
        let mut flat_batch: Vec<FlatItem> = Vec::new();

        for (pi, _, slot_of) in &self.plan_scratch {
            let page = &frame.pages[*pi];
            let (tf, scene) = (&page.tf, page.scene);

            for (i, op) in scene.ops.iter().enumerate() {
                let (s0, s1) = slot_of[i];
                match op {
                    Op::See { first, count, bx, .. } => {
                        if !flat_batch.is_empty() {
                            Self::flush_flat(&mut enc, target, stencil, cov_bg, &self.uniform_bg, &self.flat_plain, scene.flat.slice(..), &mut flat_batch);
                        }
                        if *count == 0 {
                            continue;
                        }
                        let Some(sc) = self.scissor(bx, tf, 1.5) else { continue };
                        if see_batch.iter().any(|item| scissor_overlaps(item.sc, sc)) {
                            Self::flush_see(&mut enc, cov_view, target, stencil, cov_bg, &self.uniform_bg, scene.caps.slice(..), &self.zero_cov, &self.caps_cov, &self.compose, &mut see_batch);
                        }
                        see_batch.push(SeeItem { s0, s1, first: *first, count: *count, sc });
                    }
                    Op::Fill { first, count, mode, bx, box_first, hatch_first, hatch_count, .. } => {
                        if !see_batch.is_empty() {
                            Self::flush_see(&mut enc, cov_view, target, stencil, cov_bg, &self.uniform_bg, scene.caps.slice(..), &self.zero_cov, &self.caps_cov, &self.compose, &mut see_batch);
                        }
                        if !flat_batch.is_empty() {
                            Self::flush_flat(&mut enc, target, stencil, cov_bg, &self.uniform_bg, &self.flat_plain, scene.flat.slice(..), &mut flat_batch);
                        }
                        let Some(sc) = self.scissor(bx, tf, 1.5) else { continue };
                        let mut p = target_pass(&mut enc, target, stencil, "fill", true);
                        p.set_scissor_rect(sc.0, sc.1, sc.2, sc.3);
                        p.set_bind_group(1, cov_bg, &[]);
                        p.set_stencil_reference(0);
                        p.set_bind_group(0, &self.uniform_bg, &[offset(s0)]);
                        p.set_pipeline(&self.fill_stencil);
                        p.set_vertex_buffer(0, scene.flat.slice(..));
                        p.draw(*first..*first + *count, 0..1);
                        p.set_bind_group(0, &self.uniform_bg, &[offset(s1)]);
                        match mode {
                            FillMode::Hatch => {
                                p.set_pipeline(&self.caps_hatch);
                                p.set_vertex_buffer(0, scene.caps.slice(..));
                                p.draw(0..4, *hatch_first..*hatch_first + *hatch_count);
                            }
                            FillMode::Solid | FillMode::Hole => {
                                p.set_pipeline(if *mode == FillMode::Hole { &self.flat_hole } else { &self.flat_box });
                                p.set_vertex_buffer(0, scene.flat.slice(..));
                                p.draw(*box_first..*box_first + 6, 0..1);
                            }
                        }
                    }
                    Op::Flat { first, count, bx, .. } => {
                        if !see_batch.is_empty() {
                            Self::flush_see(&mut enc, cov_view, target, stencil, cov_bg, &self.uniform_bg, scene.caps.slice(..), &self.zero_cov, &self.caps_cov, &self.compose, &mut see_batch);
                        }
                        if *count == 0 {
                            continue;
                        }
                        let Some(sc) = self.scissor(bx, tf, 1.5) else { continue };
                        flat_batch.push(FlatItem { s0, first: *first, count: *count, sc });
                    }
                }
            }
            if !see_batch.is_empty() {
                Self::flush_see(&mut enc, cov_view, target, stencil, cov_bg, &self.uniform_bg, scene.caps.slice(..), &self.zero_cov, &self.caps_cov, &self.compose, &mut see_batch);
            }
            if !flat_batch.is_empty() {
                Self::flush_flat(&mut enc, target, stencil, cov_bg, &self.uniform_bg, &self.flat_plain, scene.flat.slice(..), &mut flat_batch);
            }
        }
        self.queue.submit([enc.finish()]);
    }

    fn flush_see(
        enc: &mut wgpu::CommandEncoder,
        cov_view: &wgpu::TextureView,
        target: &wgpu::TextureView,
        stencil: &wgpu::TextureView,
        cov_bg: &wgpu::BindGroup,
        uniform_bg: &wgpu::BindGroup,
        scene_caps: wgpu::BufferSlice,
        zero_cov: &wgpu::RenderPipeline,
        caps_cov: &wgpu::RenderPipeline,
        compose: &wgpu::RenderPipeline,
        batch: &mut Vec<SeeItem>,
    ) {
        if batch.is_empty() {
            return;
        }
        let offset = |slot: usize| (slot as u64 * UNIFORM_STRIDE) as u32;
        {
            let mut p = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("coverage-batch"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: cov_view,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                ..Default::default()
            });
            p.set_vertex_buffer(0, scene_caps);
            for item in batch.iter() {
                p.set_scissor_rect(item.sc.0, item.sc.1, item.sc.2, item.sc.3);
                p.set_bind_group(0, uniform_bg, &[offset(item.s0)]);
                p.set_pipeline(zero_cov);
                p.draw(0..3, 0..1);
                p.set_pipeline(caps_cov);
                p.draw(0..4, item.first..item.first + item.count);
            }
        }
        {
            let mut p = target_pass(enc, target, stencil, "compose-batch", false);
            p.set_pipeline(compose);
            p.set_bind_group(1, cov_bg, &[]);
            p.set_stencil_reference(0);
            for item in batch.iter() {
                p.set_scissor_rect(item.sc.0, item.sc.1, item.sc.2, item.sc.3);
                p.set_bind_group(0, uniform_bg, &[offset(item.s1)]);
                p.draw(0..3, 0..1);
            }
        }
        batch.clear();
    }

    fn flush_flat(
        enc: &mut wgpu::CommandEncoder,
        target: &wgpu::TextureView,
        stencil: &wgpu::TextureView,
        cov_bg: &wgpu::BindGroup,
        uniform_bg: &wgpu::BindGroup,
        flat_plain: &wgpu::RenderPipeline,
        scene_flat: wgpu::BufferSlice,
        batch: &mut Vec<FlatItem>,
    ) {
        if batch.is_empty() {
            return;
        }
        let offset = |slot: usize| (slot as u64 * UNIFORM_STRIDE) as u32;
        let mut p = target_pass(enc, target, stencil, "flat-batch", false);
        p.set_bind_group(1, cov_bg, &[]);
        p.set_stencil_reference(0);
        p.set_pipeline(flat_plain);
        p.set_vertex_buffer(0, scene_flat);
        for item in batch.drain(..) {
            p.set_scissor_rect(item.sc.0, item.sc.1, item.sc.2, item.sc.3);
            p.set_bind_group(0, uniform_bg, &[offset(item.s0)]);
            p.draw(item.first..item.first + item.count, 0..1);
        }
    }

    pub fn format(&self) -> wgpu::TextureFormat {
        self.format
    }
}

/// A pass on the target that keeps what is drawn (and the stencil, unless `clear_stencil`).
fn target_pass<'a>(enc: &'a mut wgpu::CommandEncoder, target: &'a wgpu::TextureView, stencil: &'a wgpu::TextureView, label: &'static str, clear_stencil: bool) -> wgpu::RenderPass<'a> {
    enc.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some(label),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: target, resolve_target: None, depth_slice: None, ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store } })],
        depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment { view: stencil, depth_ops: None, stencil_ops: Some(wgpu::Operations { load: if clear_stencil { wgpu::LoadOp::Clear(0) } else { wgpu::LoadOp::Load }, store: wgpu::StoreOp::Store }) }),
        ..Default::default()
    })
}

/// A device on the first adapter (the PC's GPU, or software Vulkan).
pub fn pc_device() -> Result<(wgpu::Device, wgpu::Queue, String), String> {
    let inst = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());
    let adapter = pollster::block_on(inst.request_adapter(&wgpu::RequestAdapterOptions::default())).map_err(|e| format!("no GPU adapter: {e}"))?;
    let name = format!("{} ({:?})", adapter.get_info().name, adapter.get_info().backend);
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).map_err(|e| format!("no device: {e}"))?;
    Ok((device, queue, name))
}

/// Renders `scene` into `w` x `h` RGBA8 pixels (straight alpha over `paper`), on the PC.
pub fn render_offscreen(canvas: &mut GpuCanvas, scene: &Scene, w: u32, h: u32, tf: &Transform, paper: Option<Rgba>) -> Vec<u8> {
    let gs = canvas.upload(scene);
    render_frame_offscreen(canvas, w, h, &Frame { clear: paper, pages: vec![PageDraw { scene: &gs, tf: *tf, paper: None }] })
}

/// Renders a frame into `w` x `h` RGBA8 pixels, on the PC.
pub fn render_frame_offscreen(canvas: &mut GpuCanvas, w: u32, h: u32, frame: &Frame) -> Vec<u8> {
    let tex = canvas.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("offscreen"),
        size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: canvas.format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = tex.create_view(&Default::default());
    canvas.draw_frame(&view, w, h, frame);
    let padded = (w * 4).div_ceil(256) * 256;
    let buf = canvas.device.create_buffer(&wgpu::BufferDescriptor { label: Some("readback"), size: (padded * h) as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
    let mut enc = canvas.device.create_command_encoder(&Default::default());
    enc.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo { texture: &tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
        wgpu::TexelCopyBufferInfo { buffer: &buf, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(padded), rows_per_image: None } },
        wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
    );
    canvas.queue.submit([enc.finish()]);
    let slice = buf.slice(..);
    let (tx, rx) = std::sync::mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |r| {
        let _ = tx.send(r);
    });
    canvas.device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
    rx.recv().expect("map").expect("map ok");
    let data = slice.get_mapped_range();
    let mut out = Vec::with_capacity((w * h * 4) as usize);
    for row in 0..h {
        let o = (row * padded) as usize;
        out.extend_from_slice(&data[o..o + (w * 4) as usize]);
    }
    drop(data);
    buf.unmap();
    out
}
