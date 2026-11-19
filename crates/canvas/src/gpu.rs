//! The GPU objects of the page's ink: device, pipelines, uniforms, the coverage and stencil
//! textures, each scene's buffers. TypeScript counterpart: `src/ink/glInk.ts` `GlInk` (its
//! programs, buffers and the coverage framebuffer; `resize`, `setStrokes`). The passes drawn with
//! them are in `ink.rs`.
//!
//! Nothing here may make wgpu raise a validation error, as such an error inside a render pass
//! aborted the app (wgpu's default handler panics, and the pass's drop panicked again while that
//! unwound): every texture is sized from the target, never from the zoom, and kept within the
//! device's `max_texture_dimension_2d`; no buffer is empty or larger than `max_buffer_size`; and
//! whatever wgpu still reports is recorded (`GpuHealth`), never a panic.

use crate::frame::{Frame, PageDraw};
use crate::scene::{CapInst, Op, Scene, Transform};
use bytemuck::{Pod, Zeroable};
use renderer::color::Rgba;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use wgpu::util::DeviceExt;

#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub(crate) struct Uniforms {
    pub(crate) m: [f32; 4],
    pub(crate) t: [f32; 2],
    pub(crate) size: [f32; 2],
    pub(crate) px: f32,
    pub(crate) glow: f32,
    pub(crate) glow_pad: f32,
    pub(crate) cov: u32,
    pub(crate) col: [f32; 4],
    pub(crate) p_style: u32,
    pub(crate) p_lw: f32,
    pub(crate) p_origin: [f32; 2],
    pub(crate) p_size: [f32; 2],
    pub(crate) p_pad: [f32; 2],
    pub(crate) p_base: [f32; 4],
    pub(crate) p_line: [f32; 4],
    pub(crate) p_margin: [f32; 4],
    pub(crate) p_grid: [f32; 4],
    pub(crate) p_major: [f32; 4],
    pub(crate) p_minor: [f32; 4],
    pub(crate) p_dot: [f32; 4],
}

pub(crate) type PagePlan = (usize, Option<usize>, Vec<(usize, usize)>);

pub(crate) const UNIFORM_STRIDE: u64 = 256;
pub(crate) const COV_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::R8Unorm;
pub(crate) const STENCIL_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Stencil8;

/// A scene's buffers on the device.
pub struct GpuScene {
    pub(crate) caps: wgpu::Buffer,
    pub(crate) flat: wgpu::Buffer,
    pub(crate) ops: Vec<Op>,
}

pub struct GpuCanvas {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub(crate) format: wgpu::TextureFormat,
    pub(crate) uniform_bgl: wgpu::BindGroupLayout,
    pub(crate) tex_bgl: wgpu::BindGroupLayout,
    pub(crate) caps_cov: wgpu::RenderPipeline,
    pub(crate) zero_cov: wgpu::RenderPipeline,
    pub(crate) compose: wgpu::RenderPipeline,
    pub(crate) fill_stencil: wgpu::RenderPipeline,
    pub(crate) flat_box: wgpu::RenderPipeline,
    pub(crate) flat_hole: wgpu::RenderPipeline,
    pub(crate) caps_hatch: wgpu::RenderPipeline,
    pub(crate) flat_plain: wgpu::RenderPipeline,
    pub(crate) paper: wgpu::RenderPipeline,
    /// The pages' rectangles of the frame being drawn (6 vertices each).
    pub(crate) rects: wgpu::Buffer,
    pub(crate) rects_capacity: usize,
    pub(crate) uniforms: wgpu::Buffer,
    pub(crate) uniform_bg: wgpu::BindGroup,
    pub(crate) uniform_capacity: u64,
    pub(crate) size: (u32, u32),
    pub(crate) cov_tex: Option<(wgpu::Texture, wgpu::TextureView, wgpu::BindGroup)>,
    pub(crate) stencil: Option<wgpu::TextureView>,
    pub(crate) slots_scratch: Vec<Uniforms>,
    pub(crate) rects_scratch: Vec<[f32; 2]>,
    /// Per page drawn: its index in the frame, its paper's uniform slot, each op's two slots.
    pub(crate) plan_scratch: Vec<PagePlan>,
    pub(crate) bytes_scratch: Vec<u8>,
    /// What wgpu reported (validation errors, a lost device), recorded instead of a panic.
    pub(crate) health: Arc<GpuHealth>,
    /// The device's largest texture side and largest buffer.
    pub(crate) max_dim: u32,
    pub(crate) max_buffer: u64,
}

/// What the device reported. wgpu's default handler panics on any validation error, and a
/// panic inside a render pass (the pass's drop panics again while it unwinds) aborts the app,
/// past every `catch_unwind`: so each `GpuCanvas` installs its own handler, which records here.
#[derive(Debug, Default)]
pub struct GpuHealth {
    /// Errors reported since the device was made.
    pub errors: AtomicU64,
    /// Of those, the ones wgpu itself reported (validation, out of memory, internal): a driver
    /// that reports them in its first frames is not trusted (Android falls back to GLES).
    pub uncaptured: AtomicU64,
    /// The device was lost (driver reset, GPU hang): the host must be made again.
    pub lost: AtomicBool,
    /// The last error's message.
    pub last: Mutex<Option<String>>,
}

impl GpuHealth {
    pub fn record(&self, msg: &str) {
        self.errors.fetch_add(1, Ordering::SeqCst);
        let mut msg = msg.trim().to_string();
        if msg.len() > 600 {
            let mut end = 600;
            while !msg.is_char_boundary(end) {
                end -= 1;
            }
            msg.truncate(end);
        }
        *self.last.lock().unwrap_or_else(|e| e.into_inner()) = Some(msg);
    }

    pub fn errors(&self) -> u64 {
        self.errors.load(Ordering::SeqCst)
    }

    pub fn uncaptured(&self) -> u64 {
        self.uncaptured.load(Ordering::SeqCst)
    }

    pub fn is_lost(&self) -> bool {
        self.lost.load(Ordering::SeqCst)
    }

    pub fn last(&self) -> Option<String> {
        self.last.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

const OVER: wgpu::BlendState = wgpu::BlendState {
    color: wgpu::BlendComponent {
        src_factor: wgpu::BlendFactor::One,
        dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
        operation: wgpu::BlendOperation::Add,
    },
    alpha: wgpu::BlendComponent {
        src_factor: wgpu::BlendFactor::One,
        dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
        operation: wgpu::BlendOperation::Add,
    },
};
const ERASE: wgpu::BlendState = wgpu::BlendState {
    color: wgpu::BlendComponent {
        src_factor: wgpu::BlendFactor::Zero,
        dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
        operation: wgpu::BlendOperation::Add,
    },
    alpha: wgpu::BlendComponent {
        src_factor: wgpu::BlendFactor::Zero,
        dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
        operation: wgpu::BlendOperation::Add,
    },
};
const MAX: wgpu::BlendState = wgpu::BlendState {
    color: wgpu::BlendComponent {
        src_factor: wgpu::BlendFactor::One,
        dst_factor: wgpu::BlendFactor::One,
        operation: wgpu::BlendOperation::Max,
    },
    alpha: wgpu::BlendComponent {
        src_factor: wgpu::BlendFactor::One,
        dst_factor: wgpu::BlendFactor::One,
        operation: wgpu::BlendOperation::Max,
    },
};

fn stencil_state(
    compare: wgpu::CompareFunction,
    pass_op: wgpu::StencilOperation,
) -> wgpu::DepthStencilState {
    let face = wgpu::StencilFaceState {
        compare,
        fail_op: wgpu::StencilOperation::Keep,
        depth_fail_op: wgpu::StencilOperation::Keep,
        pass_op,
    };
    wgpu::DepthStencilState {
        format: STENCIL_FORMAT,
        depth_write_enabled: false,
        depth_compare: wgpu::CompareFunction::Always,
        stencil: wgpu::StencilState {
            front: face,
            back: face,
            read_mask: 0xff,
            write_mask: 0xff,
        },
        bias: wgpu::DepthBiasState::default(),
    }
}

impl GpuCanvas {
    pub fn new(device: wgpu::Device, queue: wgpu::Queue, format: wgpu::TextureFormat) -> Self {
        // First of all: from here on no error of this device panics.
        let health = Arc::new(GpuHealth::default());
        {
            let h = health.clone();
            device.on_uncaptured_error(Arc::new(move |e: wgpu::Error| {
                h.uncaptured.fetch_add(1, Ordering::SeqCst);
                h.record(&e.to_string());
            }));
            let h = health.clone();
            device.set_device_lost_callback(move |reason, msg| {
                if reason != wgpu::DeviceLostReason::Destroyed {
                    h.lost.store(true, Ordering::SeqCst);
                    h.record(&format!("device lost: {msg}"));
                }
            });
        }
        let limits = device.limits();
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("canvas"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders.wgsl").into()),
        });
        let uniform_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("uniforms"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: true,
                    min_binding_size: wgpu::BufferSize::new(std::mem::size_of::<Uniforms>() as u64),
                },
                count: None,
            }],
        });
        let tex_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("coverage"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: false },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            }],
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: None,
            bind_group_layouts: &[&uniform_bgl, &tex_bgl],
            push_constant_ranges: &[],
        });
        // The coverage pass draws into the coverage texture: its pipelines must not bind it.
        let layout_cov = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("coverage"),
            bind_group_layouts: &[&uniform_bgl],
            push_constant_ranges: &[],
        });
        let cap_layout = wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<CapInst>() as u64,
            step_mode: wgpu::VertexStepMode::Instance,
            attributes: &wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x4],
        };
        let flat_layout = wgpu::VertexBufferLayout {
            array_stride: 8,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &wgpu::vertex_attr_array![0 => Float32x2],
        };
        let make = |layout: &wgpu::PipelineLayout,
                    label: &str,
                    vs: &str,
                    fs: &str,
                    buffers: &[wgpu::VertexBufferLayout],
                    topology: wgpu::PrimitiveTopology,
                    target: wgpu::TextureFormat,
                    blend: Option<wgpu::BlendState>,
                    write: wgpu::ColorWrites,
                    ds: Option<wgpu::DepthStencilState>| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some(vs),
                    buffers,
                    compilation_options: Default::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some(fs),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: target,
                        blend,
                        write_mask: write,
                    })],
                    compilation_options: Default::default(),
                }),
                primitive: wgpu::PrimitiveState {
                    topology,
                    cull_mode: None,
                    ..Default::default()
                },
                depth_stencil: ds,
                multisample: wgpu::MultisampleState::default(),
                multiview: None,
                cache: None,
            })
        };
        use wgpu::{
            ColorWrites as W, CompareFunction as C, PrimitiveTopology as T, StencilOperation as S,
        };
        let keep = || Some(stencil_state(C::Always, S::Keep));
        let caps_cov = make(
            &layout_cov,
            "caps-cov",
            "vs_caps",
            "fs_caps",
            std::slice::from_ref(&cap_layout),
            T::TriangleStrip,
            COV_FORMAT,
            Some(MAX),
            W::ALL,
            None,
        );
        let zero_cov = make(
            &layout_cov,
            "zero-cov",
            "vs_full",
            "fs_zero",
            &[],
            T::TriangleList,
            COV_FORMAT,
            None,
            W::ALL,
            None,
        );
        let compose = make(
            &layout,
            "compose",
            "vs_full",
            "fs_compose",
            &[],
            T::TriangleList,
            format,
            Some(OVER),
            W::ALL,
            keep(),
        );
        let fill_stencil = make(
            &layout,
            "fill-stencil",
            "vs_flat",
            "fs_flat",
            std::slice::from_ref(&flat_layout),
            T::TriangleList,
            format,
            None,
            W::empty(),
            Some(stencil_state(C::Always, S::Invert)),
        );
        let flat_box = make(
            &layout,
            "flat-box",
            "vs_flat",
            "fs_flat",
            std::slice::from_ref(&flat_layout),
            T::TriangleList,
            format,
            Some(OVER),
            W::ALL,
            Some(stencil_state(C::NotEqual, S::Keep)),
        );
        let flat_hole = make(
            &layout,
            "flat-hole",
            "vs_flat",
            "fs_flat",
            std::slice::from_ref(&flat_layout),
            T::TriangleList,
            format,
            Some(ERASE),
            W::ALL,
            Some(stencil_state(C::NotEqual, S::Keep)),
        );
        let caps_hatch = make(
            &layout,
            "caps-hatch",
            "vs_caps",
            "fs_caps",
            std::slice::from_ref(&cap_layout),
            T::TriangleStrip,
            format,
            Some(OVER),
            W::ALL,
            Some(stencil_state(C::NotEqual, S::Keep)),
        );
        let flat_plain = make(
            &layout,
            "flat-plain",
            "vs_flat",
            "fs_flat",
            std::slice::from_ref(&flat_layout),
            T::TriangleList,
            format,
            Some(OVER),
            W::ALL,
            keep(),
        );
        let paper = make(
            &layout,
            "paper",
            "vs_page",
            "fs_paper",
            std::slice::from_ref(&flat_layout),
            T::TriangleList,
            format,
            Some(OVER),
            W::ALL,
            keep(),
        );
        let rects_capacity = 16;
        let rects = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("rects"),
            size: (rects_capacity * 6 * 8) as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let uniform_capacity = 64;
        let (uniforms, uniform_bg) = Self::uniform_buffer(&device, &uniform_bgl, uniform_capacity);
        GpuCanvas {
            device,
            queue,
            format,
            uniform_bgl,
            tex_bgl,
            caps_cov,
            zero_cov,
            compose,
            fill_stencil,
            flat_box,
            flat_hole,
            caps_hatch,
            flat_plain,
            paper,
            rects,
            rects_capacity,
            uniforms,
            uniform_bg,
            uniform_capacity,
            size: (0, 0),
            cov_tex: None,
            stencil: None,
            slots_scratch: Vec::new(),
            rects_scratch: Vec::new(),
            plan_scratch: Vec::new(),
            bytes_scratch: Vec::new(),
            health,
            max_dim: limits.max_texture_dimension_2d.max(1),
            max_buffer: limits.max_buffer_size,
        }
    }

    pub(crate) fn uniform_buffer(
        device: &wgpu::Device,
        bgl: &wgpu::BindGroupLayout,
        n: u64,
    ) -> (wgpu::Buffer, wgpu::BindGroup) {
        let buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("uniforms"),
            size: n * UNIFORM_STRIDE,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("uniforms"),
            layout: bgl,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                    buffer: &buf,
                    offset: 0,
                    size: wgpu::BufferSize::new(std::mem::size_of::<Uniforms>() as u64),
                }),
            }],
        });
        (buf, bg)
    }

    /// The scene's buffers on this device. A scene too large for one buffer (`max_buffer_size`)
    /// is recorded as an error and uploaded empty; an empty one gets a single zero element (wgpu
    /// refuses zero-size vertex buffers on some backends).
    pub fn upload(&self, scene: &Scene) -> GpuScene {
        let cap_bytes = (scene.caps.len() * std::mem::size_of::<CapInst>()) as u64;
        let flat_bytes = (scene.flat.len() * std::mem::size_of::<[f32; 2]>()) as u64;
        let fits = cap_bytes <= self.max_buffer && flat_bytes <= self.max_buffer;
        if !fits {
            self.health.record(&format!(
                "scene of {} capsules too large for one buffer (max {} bytes)",
                scene.caps.len(),
                self.max_buffer
            ));
        }
        let zero_cap = [CapInst::zeroed()];
        let zero_flat = [[0.0f32; 2]];
        let caps: &[CapInst] = if scene.caps.is_empty() || !fits {
            &zero_cap
        } else {
            &scene.caps
        };
        let flat: &[[f32; 2]] = if scene.flat.is_empty() || !fits {
            &zero_flat
        } else {
            &scene.flat
        };
        let caps = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("caps"),
                contents: bytemuck::cast_slice(caps),
                usage: wgpu::BufferUsages::VERTEX,
            });
        let flat = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("flat"),
                contents: bytemuck::cast_slice(flat),
                usage: wgpu::BufferUsages::VERTEX,
            });
        GpuScene {
            caps,
            flat,
            ops: if fits { scene.ops.clone() } else { Vec::new() },
        }
    }

    /// What the device reported (shared with its error handler).
    pub fn health(&self) -> &Arc<GpuHealth> {
        &self.health
    }

    /// The largest texture side this device makes (`max_texture_dimension_2d`).
    pub fn max_texture_side(&self) -> u32 {
        self.max_dim
    }

    pub(crate) fn ensure_size(&mut self, w: u32, h: u32) {
        if self.size == (w, h) && self.cov_tex.is_some() {
            return;
        }
        self.size = (w, h);
        let ext = wgpu::Extent3d {
            width: w.max(1),
            height: h.max(1),
            depth_or_array_layers: 1,
        };
        let cov = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("coverage"),
            size: ext,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: COV_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let cov_view = cov.create_view(&Default::default());
        let bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("coverage"),
            layout: &self.tex_bgl,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&cov_view),
            }],
        });
        self.cov_tex = Some((cov, cov_view, bg));
        let st = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("stencil"),
            size: ext,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: STENCIL_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        self.stencil = Some(st.create_view(&Default::default()));
    }

    pub fn format(&self) -> wgpu::TextureFormat {
        self.format
    }
}

/// A device on the first adapter (the PC's GPU, or software Vulkan).
pub fn pc_device() -> Result<(wgpu::Device, wgpu::Queue, String), String> {
    pc_device_backend().map(|(d, q, name, _)| (d, q, name))
}

/// `pc_device` with the adapter's backend.
pub fn pc_device_backend() -> Result<(wgpu::Device, wgpu::Queue, String, wgpu::Backend), String> {
    let inst = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());
    let adapter = pollster::block_on(inst.request_adapter(&wgpu::RequestAdapterOptions::default()))
        .map_err(|e| format!("no GPU adapter: {e}"))?;
    let info = adapter.get_info();
    let name = format!("{} ({:?})", info.name, info.backend);
    let (device, queue) = pollster::block_on(adapter.request_device(&device_descriptor(&adapter)))
        .map_err(|e| format!("no device: {e}"))?;
    Ok((device, queue, name, info.backend))
}

/// The device the canvas asks for: no features, and the adapter's own limits. wgpu's defaults
/// (WebGPU's limits) can exceed what a phone's GPU has (a Mali-G52 under Vulkan or GLES), and a
/// device asked for more than its adapter has is refused.
pub fn device_descriptor(adapter: &wgpu::Adapter) -> wgpu::DeviceDescriptor<'static> {
    wgpu::DeviceDescriptor {
        label: Some("opennote-canvas"),
        required_features: wgpu::Features::empty(),
        required_limits: adapter.limits(),
        ..Default::default()
    }
}

/// Renders `scene` into `w` x `h` RGBA8 pixels (straight alpha over `paper`), on the PC.
pub fn render_offscreen(
    canvas: &mut GpuCanvas,
    scene: &Scene,
    w: u32,
    h: u32,
    tf: &Transform,
    paper: Option<Rgba>,
) -> Vec<u8> {
    let gs = canvas.upload(scene);
    render_frame_offscreen(
        canvas,
        w,
        h,
        &Frame {
            clear: paper,
            pages: vec![PageDraw {
                scene: &gs,
                tf: *tf,
                paper: None,
            }],
        },
    )
}

/// Renders a frame into `w` x `h` RGBA8 pixels, on the PC.
pub fn render_frame_offscreen(canvas: &mut GpuCanvas, w: u32, h: u32, frame: &Frame) -> Vec<u8> {
    if w == 0 || h == 0 || w > canvas.max_dim || h > canvas.max_dim {
        canvas.health.record(&format!(
            "offscreen size {w} x {h} outside 1..{}",
            canvas.max_dim
        ));
        return Vec::new();
    }
    let tex = canvas.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("offscreen"),
        size: wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
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
    let buf = canvas.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("readback"),
        size: (padded * h) as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut enc = canvas.device.create_command_encoder(&Default::default());
    enc.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture: &tex,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &buf,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(padded),
                rows_per_image: None,
            },
        },
        wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
    );
    canvas.queue.submit([enc.finish()]);
    let slice = buf.slice(..);
    let (tx, rx) = std::sync::mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |r| {
        let _ = tx.send(r);
    });
    if let Err(e) = canvas.device.poll(wgpu::PollType::wait_indefinitely()) {
        canvas.health.record(&format!("poll: {e:?}"));
        return Vec::new();
    }
    if !matches!(rx.recv(), Ok(Ok(()))) {
        canvas
            .health
            .record("readback: the buffer could not be mapped");
        return Vec::new();
    }
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
