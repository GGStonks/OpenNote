//! The shells' canvas: a surface (a `CAMetalLayer` on iOS, an `ANativeWindow` on Android) or an
//! offscreen texture (the PC: tests, the CLI), the pages' scenes by id, and the frame the page
//! last described (`canvasFrame`: the desk colour, each visible page's transform and paper).
//! The shell calls `draw` from its display link while `dirty`; the page's messages come through
//! crates/native (`canvasScene`, `canvasFrame`).

use crate::{pc_device, Frame, GpuCanvas, GpuScene, PageDraw, Paper, Scene, Transform};
use model::Stroke;
use renderer::color::Rgba;
use std::collections::HashMap;
use std::time::Instant;

/// A page as the frame shows it.
#[derive(Clone, Debug, PartialEq)]
pub struct PagePlacement {
    pub page: String,
    pub tf: Transform,
    pub paper: Option<Paper>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct FrameSpec {
    pub clear: Option<Rgba>,
    pub pages: Vec<PagePlacement>,
}

#[derive(Clone, Debug, Default)]
pub struct Stats {
    pub frames: u64,
    pub last_draw_ms: f64,
    pub worst_draw_ms: f64,
    pub width: u32,
    pub height: u32,
    pub scenes: usize,
    pub capsules: usize,
}

enum Target {
    Surface { surface: wgpu::Surface<'static>, config: wgpu::SurfaceConfiguration },
    Offscreen { texture: wgpu::Texture },
}

pub struct CanvasHost {
    canvas: GpuCanvas,
    target: Target,
    scenes: HashMap<String, (GpuScene, usize)>,
    frame: FrameSpec,
    pub dirty: bool,
    stats: Stats,
}

impl CanvasHost {
    /// A host drawing to `target`, `w` x `h` device px. `adapter_name` for the logs.
    ///
    /// # Safety
    /// `target` must stay valid while the host lives (the shell detaches it before its view goes).
    pub unsafe fn attach(target: wgpu::SurfaceTargetUnsafe, w: u32, h: u32) -> Result<(Self, String), String> {
        let inst = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());
        let surface = inst.create_surface_unsafe(target).map_err(|e| format!("surface: {e}"))?;
        let adapter = pollster::block_on(inst.request_adapter(&wgpu::RequestAdapterOptions { compatible_surface: Some(&surface), power_preference: wgpu::PowerPreference::HighPerformance, ..Default::default() })).map_err(|e| format!("adapter: {e}"))?;
        let name = format!("{} ({:?})", adapter.get_info().name, adapter.get_info().backend);
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).map_err(|e| format!("device: {e}"))?;
        let caps = surface.get_capabilities(&adapter);
        let format = caps.formats.iter().copied().find(|f| !f.is_srgb()).unwrap_or(caps.formats[0]);
        let alpha_mode = if caps.alpha_modes.contains(&wgpu::CompositeAlphaMode::Opaque) { wgpu::CompositeAlphaMode::Opaque } else { caps.alpha_modes[0] };
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: w.max(1),
            height: h.max(1),
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: 1,
            alpha_mode,
            view_formats: vec![],
        };
        surface.configure(&device, &config);
        let canvas = GpuCanvas::new(device, queue, format);
        Ok((CanvasHost { canvas, target: Target::Surface { surface, config }, scenes: HashMap::new(), frame: FrameSpec::default(), dirty: true, stats: Stats { width: w, height: h, ..Default::default() } }, name))
    }

    /// A host drawing into an offscreen RGBA8 texture on the PC's GPU.
    pub fn offscreen(w: u32, h: u32) -> Result<(Self, String), String> {
        let (device, queue, name) = pc_device()?;
        let canvas = GpuCanvas::new(device, queue, wgpu::TextureFormat::Rgba8Unorm);
        let texture = Self::offscreen_texture(&canvas.device, w, h);
        Ok((CanvasHost { canvas, target: Target::Offscreen { texture }, scenes: HashMap::new(), frame: FrameSpec::default(), dirty: true, stats: Stats { width: w, height: h, ..Default::default() } }, name))
    }

    fn offscreen_texture(device: &wgpu::Device, w: u32, h: u32) -> wgpu::Texture {
        device.create_texture(&wgpu::TextureDescriptor {
            label: Some("offscreen"),
            size: wgpu::Extent3d { width: w.max(1), height: h.max(1), depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        })
    }

    pub fn resize(&mut self, w: u32, h: u32) {
        if (w, h) == (self.stats.width, self.stats.height) {
            return;
        }
        self.stats.width = w;
        self.stats.height = h;
        match &mut self.target {
            Target::Surface { surface, config } => {
                config.width = w.max(1);
                config.height = h.max(1);
                surface.configure(&self.canvas.device, config);
            }
            Target::Offscreen { texture } => *texture = Self::offscreen_texture(&self.canvas.device, w, h),
        }
        self.dirty = true;
    }

    /// The scene of page `id`: built from multiple stroke layers (e.g. from `shapes::z_layers` when blocks interleave).
    pub fn set_scene_layers(&mut self, id: &str, layers: &[&[Stroke]]) -> usize {
        let scene = Scene::build(layers);
        let n = scene.caps.len();
        let gs = self.canvas.upload(&scene);
        self.scenes.insert(id.to_string(), (gs, n));
        self.dirty = true;
        n
    }

    /// The scene of page `id`: its strokes as the page stores them (one z-layer in N2).
    pub fn set_scene(&mut self, id: &str, strokes: &[Stroke]) -> usize {
        self.set_scene_layers(id, &[strokes])
    }

    pub fn remove_scene(&mut self, id: &str) {
        if self.scenes.remove(id).is_some() {
            self.dirty = true;
        }
    }

    pub fn set_frame(&mut self, frame: FrameSpec) {
        if frame != self.frame {
            self.frame = frame;
            self.dirty = true;
        }
    }

    pub fn stats(&self) -> Stats {
        Stats { scenes: self.scenes.len(), capsules: self.scenes.values().map(|s| s.1).sum(), ..self.stats.clone() }
    }

    /// Draws the frame (and presents it on a surface). Ok(true) when something was drawn.
    pub fn draw(&mut self) -> Result<bool, String> {
        if !self.dirty {
            return Ok(false);
        }
        let t0 = Instant::now();
        let (w, h) = (self.stats.width, self.stats.height);
        let pages: Vec<PageDraw> = self
            .frame
            .pages
            .iter()
            .filter_map(|p| {
                self.scenes
                    .get(&p.page)
                    .map(|(scene, _)| PageDraw { scene, tf: p.tf, paper: p.paper })
            })
            .collect();
        let frame = Frame {
            clear: self.frame.clear,
            pages,
        };
        match &mut self.target {
            Target::Surface { surface, config } => {
                let st = match surface.get_current_texture() {
                    Ok(st) => st,
                    Err(wgpu::SurfaceError::Outdated) | Err(wgpu::SurfaceError::Lost) => {
                        surface.configure(&self.canvas.device, config);
                        match surface.get_current_texture() {
                            Ok(st) => st,
                            Err(_) => {
                                self.dirty = true;
                                return Ok(false);
                            }
                        }
                    }
                    Err(e) => {
                        self.dirty = true;
                        return Err(format!("surface: {e}"));
                    }
                };
                let view = st.texture.create_view(&Default::default());
                self.canvas.draw_frame(&view, w, h, &frame);
                st.present();
            }
            Target::Offscreen { texture } => {
                let view = texture.create_view(&Default::default());
                self.canvas.draw_frame(&view, w, h, &frame);
            }
        }
        self.dirty = false;
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        self.stats.frames += 1;
        self.stats.last_draw_ms = ms;
        self.stats.worst_draw_ms = self.stats.worst_draw_ms.max(ms);
        Ok(true)
    }

    /// The offscreen target's pixels (RGBA8), after `draw`.
    pub fn pixels(&mut self) -> Vec<u8> {
        let Target::Offscreen { texture } = &self.target else { return Vec::new() };
        let (w, h) = (self.stats.width, self.stats.height);
        let padded = (w * 4).div_ceil(256) * 256;
        let buf = self.canvas.device.create_buffer(&wgpu::BufferDescriptor { label: Some("readback"), size: (padded * h) as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
        let mut enc = self.canvas.device.create_command_encoder(&Default::default());
        enc.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo { texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            wgpu::TexelCopyBufferInfo { buffer: &buf, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(padded), rows_per_image: None } },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
        self.canvas.queue.submit([enc.finish()]);
        let slice = buf.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
        self.canvas.device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
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
}
