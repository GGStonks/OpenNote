//! The page drawn on the GPU (docs/rust-native-canvas.md, step N1).
//!
//! `Scene::build` turns the page's z-layers of strokes into the same draw ops as the page's WebGL
//! ink (src/ink/glInk.ts `Builder`): a highlighter laid on as one see-through shape; opaque
//! strokes of one colour in a row together as one coverage run (their overlapping capsules never
//! darken), a see-through stroke alone; a shape's fill by even-odd stencil (solid, a hole that
//! erases, or hatch capsules under the stencil); an arrowhead as a flat triangle.
//! `GpuCanvas::draw` renders a scene through a `Transform` onto any target texture: the passes of
//! glInk's `draw` and `layOn` on wgpu. `render_offscreen` is the PC path (tests, the CLI).

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
    Flat { first: u32, count: u32, col: [f32; 4] },
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
                            // Pushing flat vertices does not break a capsule run.
                            let first = sc.flat.len() as u32;
                            for p in points {
                                sc.flat.push([p.x as f32, p.y as f32]);
                            }
                            arrows.push(Op::Flat { first, count: 3, col: rgba(op.color) });
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
    uniforms: wgpu::Buffer,
    uniform_bg: wgpu::BindGroup,
    uniform_capacity: u64,
    size: (u32, u32),
    cov_tex: Option<(wgpu::Texture, wgpu::TextureView, wgpu::BindGroup)>,
    stencil: Option<wgpu::TextureView>,
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
        let uniform_capacity = 64;
        let (uniforms, uniform_bg) = Self::uniform_buffer(&device, &uniform_bgl, uniform_capacity);
        GpuCanvas {
            device, queue, format, uniform_bgl, tex_bgl, caps_cov, zero_cov, compose, fill_stencil, flat_box, flat_hole, caps_hatch, flat_plain,
            uniforms, uniform_bg, uniform_capacity, size: (0, 0), cov_tex: None, stencil: None,
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
        self.ensure_size(w, h);
        let px = tf.px();
        let base = Uniforms { m: [tf.a, tf.b, tf.c, tf.d], t: [tf.ox, tf.oy], size: [w as f32, h as f32], px, glow: 0.0, glow_pad: 0.0, cov: 0, col: [0.0; 4] };
        // Every op's uniforms first (the colour; `cov` for the coverage pass), one slot each.
        let mut slots: Vec<Uniforms> = Vec::with_capacity(scene.ops.len() * 2 + 1);
        let mut slot_of: Vec<(usize, usize)> = Vec::with_capacity(scene.ops.len());
        let premul = |c: [f32; 4]| [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]];
        for op in &scene.ops {
            match op {
                Op::See { col, .. } => {
                    slots.push(Uniforms { cov: 1, ..base });
                    slots.push(Uniforms { col: premul(*col), ..base });
                    slot_of.push((slots.len() - 2, slots.len() - 1));
                }
                Op::Fill { mode, col, .. } => {
                    slots.push(base);
                    slots.push(Uniforms { col: if *mode == FillMode::Hole { [0.0, 0.0, 0.0, 1.0] } else { premul(*col) }, ..base });
                    slot_of.push((slots.len() - 2, slots.len() - 1));
                }
                Op::Flat { col, .. } => {
                    slots.push(Uniforms { col: premul(*col), ..base });
                    slot_of.push((slots.len() - 1, slots.len() - 1));
                }
            }
        }
        if slots.is_empty() {
            slots.push(base);
        }
        if slots.len() as u64 > self.uniform_capacity {
            self.uniform_capacity = (slots.len() as u64).next_power_of_two();
            let (b, bg) = Self::uniform_buffer(&self.device, &self.uniform_bgl, self.uniform_capacity);
            self.uniforms = b;
            self.uniform_bg = bg;
        }
        let mut bytes = vec![0u8; slots.len() * UNIFORM_STRIDE as usize];
        for (i, s) in slots.iter().enumerate() {
            bytes[i * UNIFORM_STRIDE as usize..i * UNIFORM_STRIDE as usize + std::mem::size_of::<Uniforms>()].copy_from_slice(bytemuck::bytes_of(s));
        }
        self.queue.write_buffer(&self.uniforms, 0, &bytes);
        let offset = |slot: usize| (slot as u64 * UNIFORM_STRIDE) as u32;

        let (_, cov_view, cov_bg) = self.cov_tex.as_ref().unwrap();
        let stencil = self.stencil.as_ref().unwrap();
        let mut enc = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("canvas") });
        // The paper (or nothing), and a clean stencil.
        {
            let clear = paper.map(|p| wgpu::Color { r: p.r as f64, g: p.g as f64, b: p.b as f64, a: p.a as f64 }).unwrap_or(wgpu::Color::TRANSPARENT);
            enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("paper"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: target, resolve_target: None, depth_slice: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(clear), store: wgpu::StoreOp::Store } })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment { view: stencil, depth_ops: None, stencil_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(0), store: wgpu::StoreOp::Store }) }),
                ..Default::default()
            });
        }
        for (i, op) in scene.ops.iter().enumerate() {
            let (s0, s1) = slot_of[i];
            match op {
                Op::See { first, count, bx, .. } => {
                    let Some(sc) = self.scissor(bx, tf, 1.5) else { continue };
                    if *count == 0 {
                        continue;
                    }
                    // The run's coverage: the union of its capsules (max), within its box.
                    {
                        let mut p = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                            label: Some("coverage"),
                            color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: cov_view, resolve_target: None, depth_slice: None, ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store } })],
                            depth_stencil_attachment: None,
                            ..Default::default()
                        });
                        p.set_scissor_rect(sc.0, sc.1, sc.2, sc.3);
                        p.set_bind_group(0, &self.uniform_bg, &[offset(s0)]);
                        p.set_pipeline(&self.zero_cov);
                        p.draw(0..3, 0..1);
                        p.set_pipeline(&self.caps_cov);
                        p.set_vertex_buffer(0, scene.caps.slice(..));
                        p.draw(0..4, *first..*first + *count);
                    }
                    // Composited once, in the run's colour.
                    let mut p = target_pass(&mut enc, target, stencil, "compose", false);
                    p.set_scissor_rect(sc.0, sc.1, sc.2, sc.3);
                    p.set_bind_group(0, &self.uniform_bg, &[offset(s1)]);
                    p.set_bind_group(1, cov_bg, &[]);
                    p.set_pipeline(&self.compose);
                    p.set_stencil_reference(0);
                    p.draw(0..3, 0..1);
                }
                Op::Fill { first, count, mode, bx, box_first, hatch_first, hatch_count, .. } => {
                    let Some(sc) = self.scissor(bx, tf, 1.5) else { continue };
                    let mut p = target_pass(&mut enc, target, stencil, "fill", true);
                    p.set_scissor_rect(sc.0, sc.1, sc.2, sc.3);
                    p.set_bind_group(1, cov_bg, &[]);
                    p.set_stencil_reference(0);
                    // Even-odd: each triangle of the fan flips the stencil.
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
                Op::Flat { first, count, .. } => {
                    let mut p = target_pass(&mut enc, target, stencil, "flat", false);
                    p.set_bind_group(0, &self.uniform_bg, &[offset(s0)]);
                    p.set_bind_group(1, cov_bg, &[]);
                    p.set_stencil_reference(0);
                    p.set_pipeline(&self.flat_plain);
                    p.set_vertex_buffer(0, scene.flat.slice(..));
                    p.draw(*first..*first + *count, 0..1);
                }
            }
        }
        self.queue.submit([enc.finish()]);
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
    let gs = canvas.upload(scene);
    canvas.draw(&view, w, h, &gs, tf, paper);
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
