//! The shells' canvas: a surface (a `CAMetalLayer` on iOS, an `ANativeWindow` on Android) or an
//! offscreen texture (the PC: tests, the CLI), the pages' scenes by id, and the frame the page
//! last described (`frame.rs`). TypeScript counterpart: the page's canvas element with its
//! `GlInk` (src/ink/glInk.ts, `usePinchInk`): made for a surface, given the layers and the
//! transform, drawn when they changed.
//!
//! A host is owned by one place (crates/native `canvas_service`), which locks it for a draw and
//! for the surface's lifecycle only. Nothing here panics on what the page sends or on what the
//! GPU reports: the device's errors are recorded (`GpuHealth`), a frame whose surface image is
//! outdated or late is skipped and drawn at the next tick, and a lost device is reported by
//! `is_lost` for the owner to make the host again.

pub use crate::frame::{FrameSpec, PagePlacement};
use crate::gpu::{device_descriptor, pc_device_backend};
use crate::{Frame, GpuCanvas, GpuScene, PageDraw, Scene};
use model::Stroke;
use std::collections::HashMap;
use std::time::Instant;

#[derive(Clone, Debug, Default)]
pub struct Stats {
    pub frames: u64,
    pub last_draw_ms: f64,
    pub worst_draw_ms: f64,
    pub width: u32,
    pub height: u32,
    pub scenes: usize,
    pub capsules: usize,
    /// Frames that failed (an error from the GPU while drawing them).
    pub failed: u64,
    /// Frames skipped because the surface's image was outdated, lost or late.
    pub skipped_frames: u64,
    /// Placements left out because their transform could not be drawn.
    pub skipped_pages: u64,
}

enum Target {
    Surface {
        surface: wgpu::Surface<'static>,
        config: wgpu::SurfaceConfiguration,
        reconfigure: bool,
    },
    Offscreen {
        texture: wgpu::Texture,
    },
}

pub struct CanvasHost {
    canvas: GpuCanvas,
    target: Target,
    backend: wgpu::Backend,
    scenes: HashMap<String, (GpuScene, usize)>,
    /// Drawn for a placement with paper but no scene (a sheet's paper, the ink placed apart).
    empty: GpuScene,
    frame: FrameSpec,
    pub dirty: bool,
    stats: Stats,
}

impl CanvasHost {
    /// A host drawing to `target`, `w` x `h` device px, on the first adapter of `backends` that
    /// can present to it. Also the adapter's name and backend, for the canvas status.
    ///
    /// Format, alpha mode and present mode come from the surface's capabilities on that adapter
    /// (a Mali under GLES offers other ones than under Vulkan); the size is kept within the
    /// device's largest texture.
    ///
    /// # Safety
    /// `target` must stay valid while the host lives (the shell detaches it before its view goes).
    pub unsafe fn attach(
        target: wgpu::SurfaceTargetUnsafe,
        w: u32,
        h: u32,
        backends: wgpu::Backends,
    ) -> Result<(Self, String), String> {
        let inst = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            backends,
            ..Default::default()
        });
        let surface = inst
            .create_surface_unsafe(target)
            .map_err(|e| format!("surface: {e}"))?;
        let adapter = pollster::block_on(inst.request_adapter(&wgpu::RequestAdapterOptions {
            compatible_surface: Some(&surface),
            power_preference: wgpu::PowerPreference::HighPerformance,
            ..Default::default()
        }))
        .map_err(|e| format!("no adapter for {backends:?}: {e}"))?;
        let info = adapter.get_info();
        let name = format!("{} ({:?})", info.name, info.backend);
        let caps = surface.get_capabilities(&adapter);
        // 8-bit BGRA or RGBA as the page's canvas draws (blendable everywhere), else the first
        // linear format offered, else the first: never one the surface does not list.
        let preferred = [
            wgpu::TextureFormat::Bgra8Unorm,
            wgpu::TextureFormat::Rgba8Unorm,
        ];
        let format = preferred
            .into_iter()
            .find(|f| caps.formats.contains(f))
            .or_else(|| caps.formats.iter().copied().find(|f| !f.is_srgb()))
            .or_else(|| caps.formats.first().copied())
            .ok_or_else(|| format!("{name}: the surface offers no format"))?;
        if !caps.usages.contains(wgpu::TextureUsages::RENDER_ATTACHMENT) {
            return Err(format!("{name}: the surface cannot be rendered to"));
        }
        let alpha_mode = if caps.alpha_modes.contains(&wgpu::CompositeAlphaMode::Opaque) {
            wgpu::CompositeAlphaMode::Opaque
        } else {
            caps.alpha_modes
                .first()
                .copied()
                .unwrap_or(wgpu::CompositeAlphaMode::Auto)
        };
        let present_mode = if caps.present_modes.contains(&wgpu::PresentMode::Fifo) {
            wgpu::PresentMode::Fifo
        } else {
            caps.present_modes
                .first()
                .copied()
                .unwrap_or(wgpu::PresentMode::AutoVsync)
        };
        let (device, queue) =
            pollster::block_on(adapter.request_device(&device_descriptor(&adapter)))
                .map_err(|e| format!("{name}: device: {e}"))?;
        // The device's error handler is installed here, before anything else is asked of it.
        let canvas = GpuCanvas::new(device, queue, format);
        let max = canvas.max_texture_side();
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: w.clamp(1, max),
            height: h.clamp(1, max),
            present_mode,
            desired_maximum_frame_latency: 1,
            alpha_mode,
            view_formats: vec![],
        };
        surface.configure(&canvas.device, &config);
        if canvas.health().errors() > 0 {
            return Err(format!(
                "{name}: {}",
                canvas.health().last().unwrap_or_default()
            ));
        }
        let empty = canvas.upload(&Scene::default());
        // Nothing is presented before the page's first frame: an empty frame cleared the surface
        // to see-through black, a black flash at every start (the view's launch colour shows meanwhile).
        let stats = Stats {
            width: config.width,
            height: config.height,
            ..Default::default()
        };
        Ok((
            CanvasHost {
                canvas,
                target: Target::Surface {
                    surface,
                    config,
                    reconfigure: false,
                },
                backend: info.backend,
                scenes: HashMap::new(),
                empty,
                frame: FrameSpec::default(),
                dirty: false,
                stats,
            },
            name,
        ))
    }

    /// A host drawing into an offscreen RGBA8 texture on the PC's GPU.
    pub fn offscreen(w: u32, h: u32) -> Result<(Self, String), String> {
        let (device, queue, name, backend) = pc_device_backend()?;
        let canvas = GpuCanvas::new(device, queue, wgpu::TextureFormat::Rgba8Unorm);
        let max = canvas.max_texture_side();
        if w == 0 || h == 0 || w > max || h > max {
            return Err(format!("offscreen size {w} x {h} outside 1..{max}"));
        }
        let texture = Self::offscreen_texture(&canvas.device, w, h);
        let empty = canvas.upload(&Scene::default());
        Ok((
            CanvasHost {
                canvas,
                target: Target::Offscreen { texture },
                backend,
                scenes: HashMap::new(),
                empty,
                frame: FrameSpec::default(),
                dirty: true,
                stats: Stats {
                    width: w,
                    height: h,
                    ..Default::default()
                },
            },
            name,
        ))
    }

    fn offscreen_texture(device: &wgpu::Device, w: u32, h: u32) -> wgpu::Texture {
        device.create_texture(&wgpu::TextureDescriptor {
            label: Some("offscreen"),
            size: wgpu::Extent3d {
                width: w.max(1),
                height: h.max(1),
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        })
    }

    /// The backend the host draws with (Metal, Vulkan, Gl).
    pub fn backend(&self) -> wgpu::Backend {
        self.backend
    }

    /// The surface's new size, kept within 1 and the device's largest texture.
    pub fn resize(&mut self, w: u32, h: u32) {
        let max = self.canvas.max_texture_side();
        let (w, h) = (w.clamp(1, max), h.clamp(1, max));
        if (w, h) == (self.stats.width, self.stats.height) {
            return;
        }
        self.stats.width = w;
        self.stats.height = h;
        match &mut self.target {
            Target::Surface {
                surface,
                config,
                reconfigure,
            } => {
                config.width = w;
                config.height = h;
                surface.configure(&self.canvas.device, config);
                *reconfigure = false;
            }
            Target::Offscreen { texture } => {
                *texture = Self::offscreen_texture(&self.canvas.device, w, h)
            }
        }
        self.dirty = true;
    }

    /// The scene of page `id`: built from multiple stroke layers.
    pub fn set_scene_layers(&mut self, id: &str, layers: &[&[Stroke]]) -> usize {
        self.put_scene(id, &Scene::build(layers))
    }

    /// The scene of page `id`, built by the caller (crates/native builds it on the page's bridge
    /// thread, outside any lock: `Scene::build` is CPU work, ~100 ms for a long note on an iPad).
    pub fn put_scene(&mut self, id: &str, scene: &Scene) -> usize {
        let n = scene.caps.len();
        let gs = self.canvas.upload(scene);
        self.scenes.insert(id.to_string(), (gs, n));
        self.dirty = true;
        n
    }

    /// The scene of page `id`: its strokes as the page stores them (one z-layer).
    pub fn set_scene(&mut self, id: &str, strokes: &[Stroke]) -> usize {
        self.set_scene_layers(id, &[strokes])
    }

    pub fn remove_scene(&mut self, id: &str) {
        if self.scenes.remove(id).is_some() {
            self.dirty = true;
        }
    }

    /// Where the page shows its pages: the page is the camera's one source (its scroll, zoom and
    /// pinch, read from its own box every animation frame), so the canvas never parts from the
    /// text, selection and live ink the web view draws over it. rs.21-25 also moved the camera
    /// from the shells' own pinch and pan recognisers, ignoring the page meanwhile: the ink
    /// drifted off the page's content while the fingers moved and jumped back after.
    pub fn set_frame(&mut self, frame: FrameSpec) {
        if frame != self.frame {
            self.frame = frame;
            self.dirty = true;
        }
    }

    pub fn clear_scenes(&mut self) {
        if !self.scenes.is_empty() {
            self.scenes.clear();
            self.dirty = true;
        }
    }

    pub fn stats(&self) -> Stats {
        Stats {
            scenes: self.scenes.len(),
            capsules: self.scenes.values().map(|s| s.1).sum(),
            ..self.stats.clone()
        }
    }

    /// Errors the device reported since it was made.
    pub fn errors(&self) -> u64 {
        self.canvas.health().errors()
    }

    /// Errors wgpu itself reported (validation, out of memory, internal).
    pub fn uncaptured_errors(&self) -> u64 {
        self.canvas.health().uncaptured()
    }

    /// The device's last error.
    pub fn last_error(&self) -> Option<String> {
        self.canvas.health().last()
    }

    /// The device was lost: this host draws nothing more and must be made again.
    pub fn is_lost(&self) -> bool {
        self.canvas.health().is_lost()
    }

    /// Draws the frame (and presents it on a surface). Ok(true) when something was drawn,
    /// Ok(false) when nothing had changed or the frame was skipped (the surface's image outdated,
    /// lost or late: drawn at the next call), Err when the frame failed (the GPU reported an
    /// error while it was drawn, the surface failed, or the device is lost). A frame that failed
    /// on the GPU is not retried until the page sends something new.
    pub fn draw(&mut self) -> Result<bool, String> {
        if !self.dirty {
            return Ok(false);
        }
        if self.is_lost() {
            return Err(format!(
                "device lost: {}",
                self.last_error().unwrap_or_default()
            ));
        }
        // No frame from the page yet (also after a resize): leave the surface as it is.
        if self.frame == FrameSpec::default() && matches!(self.target, Target::Surface { .. }) {
            return Ok(false);
        }
        let t0 = Instant::now();
        let errors_before = self.errors();
        let (spec, skipped) = self.frame.drawable();
        self.stats.skipped_pages += skipped as u64;
        let pages: Vec<PageDraw> = spec
            .pages
            .iter()
            .filter_map(|p| match self.scenes.get(&p.page) {
                Some((scene, _)) => Some(PageDraw {
                    scene,
                    tf: p.tf,
                    paper: p.paper,
                }),
                // A sheet's paper is drawn even though its ink is a scene placed apart.
                None => p.paper.map(|_| PageDraw {
                    scene: &self.empty,
                    tf: p.tf,
                    paper: p.paper,
                }),
            })
            .collect();
        let frame = Frame {
            clear: spec.clear,
            pages,
        };
        let drawn = match &mut self.target {
            Target::Surface {
                surface,
                config,
                reconfigure,
            } => {
                if *reconfigure {
                    surface.configure(&self.canvas.device, config);
                    *reconfigure = false;
                }
                let st = match surface.get_current_texture() {
                    Ok(st) => st,
                    Err(wgpu::SurfaceError::Outdated) | Err(wgpu::SurfaceError::Lost) => {
                        // The window changed under the surface (rotation, a size not told yet):
                        // configured again, drawn at the next tick.
                        surface.configure(&self.canvas.device, config);
                        self.stats.skipped_frames += 1;
                        return Ok(false);
                    }
                    Err(wgpu::SurfaceError::Timeout) => {
                        self.stats.skipped_frames += 1;
                        return Ok(false);
                    }
                    Err(e) => {
                        self.stats.skipped_frames += 1;
                        return Err(format!("surface: {e}"));
                    }
                };
                let view = st.texture.create_view(&Default::default());
                let (tw, th) = (st.texture.width(), st.texture.height());
                let drawn = self.canvas.draw_frame(&view, tw, th, &frame);
                *reconfigure = st.suboptimal;
                // What was acquired is always presented: dropped unpresented, wgpu discards it,
                // and a failed discard is one of the errors it never hands to the handler.
                st.present();
                drawn
            }
            Target::Offscreen { texture } => {
                let view = texture.create_view(&Default::default());
                let (tw, th) = (texture.width(), texture.height());
                self.canvas.draw_frame(&view, tw, th, &frame)
            }
        };
        self.dirty = false;
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        if !drawn || self.errors() > errors_before {
            self.stats.failed += 1;
            return Err(self
                .last_error()
                .unwrap_or_else(|| "the frame was not drawn".into()));
        }
        self.stats.frames += 1;
        self.stats.last_draw_ms = ms;
        self.stats.worst_draw_ms = self.stats.worst_draw_ms.max(ms);
        Ok(true)
    }

    /// The offscreen target's pixels (RGBA8), after `draw`; empty on a surface or when the read
    /// back failed.
    pub fn pixels(&mut self) -> Vec<u8> {
        let Target::Offscreen { texture } = &self.target else {
            return Vec::new();
        };
        let (w, h) = (texture.width(), texture.height());
        let padded = (w * 4).div_ceil(256) * 256;
        let buf = self.canvas.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("readback"),
            size: padded as u64 * h as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut enc = self
            .canvas
            .device
            .create_command_encoder(&Default::default());
        enc.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture,
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
        self.canvas.queue.submit([enc.finish()]);
        let slice = buf.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
        if self
            .canvas
            .device
            .poll(wgpu::PollType::wait_indefinitely())
            .is_err()
            || !matches!(rx.recv(), Ok(Ok(())))
        {
            self.canvas
                .health()
                .record("readback: the buffer could not be mapped");
            return Vec::new();
        }
        let data = slice.get_mapped_range();
        // In usize: a 32768 x 32768 target (a GPU's largest) is 2^32 bytes, past u32.
        let (wb, padded) = (w as usize * 4, padded as usize);
        let mut out = Vec::with_capacity(wb * h as usize);
        for row in 0..h as usize {
            let o = row * padded;
            out.extend_from_slice(&data[o..o + wb]);
        }
        drop(data);
        buf.unmap();
        out
    }
}
