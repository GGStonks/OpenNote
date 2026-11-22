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

use crate::frame::{clamp_rgba, drawable_tf};
pub use crate::frame::{FrameSpec, PagePlacement};
use crate::gpu::{device_descriptor, pc_device_backend};
use crate::pages::{PageStats, PageStore};
use crate::paper::Paper;
use crate::scene::Transform;
use crate::telemetry::{FrameSample, FrameStats, StatsSummary};
use crate::{Frame, GpuCanvas, GpuScene, PageDraw, Scene};
use model::Stroke;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// A drawable that took longer than this to come (ms) means frames were queued ahead of the
/// display (3.0.3's waits were whole refreshes, 8.4 and 16.9 ms): the next tick is skipped, so
/// the queue drains to the frame being drawn. Where a wait stays long though a tick was skipped
/// (a driver whose images come late anyway), nothing is skipped for `DRAIN_PAUSE`.
const BACKLOG_MS: f64 = 4.0;
const DRAIN_PAUSE: Duration = Duration::from_secs(1);
/// A frame whose GPU work has not been seen done for this long is drawn over anyway (a completion
/// that never came must not stop the canvas).
const GPU_STALE: Duration = Duration::from_millis(100);

/// How the last `draw` was paced (the gesture's crash-log entry: `acquireMax`, `gpuLate`,
/// `drained`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Pace {
    /// Time spent waiting for the surface's next image (ms).
    pub acquire_ms: f64,
    /// Skipped: the GPU had not finished the previous frame.
    pub gpu_late: bool,
    /// Skipped: the drawable queue was draining after a long wait for an image.
    pub drained: bool,
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
    /// Frames that failed (an error from the GPU while drawing them).
    pub failed: u64,
    /// Frames skipped because the surface's image was outdated, lost or late.
    pub skipped_frames: u64,
    /// Placements left out because their transform could not be drawn.
    pub skipped_pages: u64,
    /// Frames whose surface image was suboptimal.
    pub suboptimal: u64,
    /// Ticks skipped because the GPU had not finished the previous frame, or to drain frames
    /// queued ahead of the display (`Pace`).
    pub gpu_late: u64,
    pub drained: u64,
    /// The pages' scenes: held, on the GPU, drawn, waited for (crates/canvas `pages`).
    pub pages: PageStats,
    /// Pictures' textures on the device, their bytes and the budget (textures.rs).
    pub pictures: usize,
    pub picture_bytes: u64,
    pub picture_budget: u64,
    pub telemetry: StatsSummary,
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
    /// The adapter as the driver describes it: driver, its version, the downlevel flags, the
    /// self-test's result (canvasStats, the crash report's `canvas-status`).
    diag: String,
    /// Each page's scene, on the GPU near the view only (ADR-007).
    pages: PageStore,
    /// The largest gap between a drawn paper and the surface's transform, the last frame.
    gap: f64,
    /// Drawn for a placement with paper but no scene (a sheet's paper, the ink placed apart).
    empty: GpuScene,
    frame: FrameSpec,
    pub dirty: bool,
    stats: Stats,
    pub telemetry: FrameStats,
    last_frame_instant: Option<Instant>,
    /// Frames submitted to a surface, and the last one the GPU was seen to finish (set by the
    /// queue's completion callback, read after a non-blocking poll).
    submitted: u64,
    done: Arc<AtomicU64>,
    submitted_at: Option<Instant>,
    /// The last wait for a drawable was long: the next tick is skipped; the tick before this draw
    /// was skipped so; no skipping until then.
    drain: bool,
    drained_last: bool,
    no_drain_until: Option<Instant>,
    /// Paced (`Pace`): a surface's ticks are; an offscreen target's on request (`set_paced`).
    paced: bool,
    /// How the last `draw` was paced.
    pub pace: Pace,
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
        let downlevel = adapter.get_downlevel_capabilities();
        let mut diag = format!(
            "driver {} {}; shader model {:?}; downlevel {:?}",
            info.driver, info.driver_info, downlevel.shader_model, downlevel.flags
        );
        // What the drawing needs and a GL or downlevel adapter may lack: the coverage target (R8,
        // max blend) and the stencil of fills. Refused here, the page draws the note itself.
        let cov = adapter.get_texture_format_features(crate::gpu::COV_FORMAT);
        let st = adapter.get_texture_format_features(crate::gpu::STENCIL_FORMAT);
        if !cov
            .allowed_usages
            .contains(wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING)
            || !cov
                .flags
                .contains(wgpu::TextureFormatFeatureFlags::BLENDABLE)
            || !st
                .allowed_usages
                .contains(wgpu::TextureUsages::RENDER_ATTACHMENT)
        {
            return Err(format!(
                "{name}: no blendable R8 coverage or stencil target ({diag})"
            ));
        }
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
        } else if caps.present_modes.contains(&wgpu::PresentMode::Mailbox) {
            wgpu::PresentMode::Mailbox
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
            // Pipelined frame latency (double-buffering) for smooth 120-240 Hz presentation
            desired_maximum_frame_latency: 2,
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
        // GL and Android's Vulkan drivers: the pipeline proved before anything is shown (a capsule
        // through the coverage pass and a sheet's paper, read back). One that draws nothing (a
        // black page on a Mali GLES) is refused: the page draws the note itself.
        if info.backend != wgpu::Backend::Metal {
            let mut canvas = canvas;
            let verdict = self_test(&mut canvas, &empty);
            diag.push_str(&format!(
                "; self-test {}",
                verdict.as_deref().unwrap_or("ok")
            ));
            if let Some(why) = verdict {
                return Err(format!("{name}: self-test failed: {why} ({diag})"));
            }
            return Self::finish_attach(canvas, surface, config, info.backend, empty, diag, name);
        }
        Self::finish_attach(canvas, surface, config, info.backend, empty, diag, name)
    }

    fn finish_attach(
        canvas: GpuCanvas,
        surface: wgpu::Surface<'static>,
        config: wgpu::SurfaceConfiguration,
        backend: wgpu::Backend,
        empty: GpuScene,
        diag: String,
        name: String,
    ) -> Result<(Self, String), String> {
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
                backend,
                diag,
                pages: PageStore::default(),
                gap: 0.0,
                empty,
                frame: FrameSpec::default(),
                dirty: false,
                stats,
                telemetry: FrameStats::default(),
                last_frame_instant: None,
                submitted: 0,
                done: Arc::new(AtomicU64::new(0)),
                submitted_at: None,
                drain: false,
                drained_last: false,
                no_drain_until: None,
                paced: true,
                pace: Pace::default(),
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
                diag: String::new(),
                pages: PageStore::default(),
                gap: 0.0,
                empty,
                frame: FrameSpec::default(),
                dirty: true,
                stats: Stats {
                    width: w,
                    height: h,
                    ..Default::default()
                },
                telemetry: FrameStats::default(),
                last_frame_instant: None,
                submitted: 0,
                done: Arc::new(AtomicU64::new(0)),
                submitted_at: None,
                drain: false,
                drained_last: false,
                no_drain_until: None,
                paced: false,
                pace: Pace::default(),
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

    /// The driver, the downlevel flags and the self-test (see `attach`).
    pub fn diag(&self) -> &str {
        &self.diag
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
        self.put_scene_arc(id, Arc::new(scene.clone()))
    }

    /// The scene of page `id`, shared with its owner's copy: kept here and uploaded to the GPU
    /// when it comes near the view (ADR-007).
    pub fn put_scene_arc(&mut self, id: &str, scene: Arc<Scene>) -> usize {
        self.dirty = true;
        self.pages.put(id, scene)
    }

    /// The GPU memory the pages' scenes may take (bytes): beyond it the least recently used
    /// leave the GPU (never one in view).
    pub fn set_gpu_budget(&mut self, bytes: u64) {
        self.pages.set_budget(bytes);
    }

    /// Scene ids near the view the last frame, and those of them not here (in view first).
    pub fn near(&self) -> &[String] {
        self.pages.near()
    }

    pub fn missing(&self) -> &[String] {
        self.pages.missing()
    }

    /// Pages that entered the view: how long until their ink was drawn (ms).
    pub fn ink_waits(&self) -> Vec<f32> {
        self.pages.ink_waits()
    }

    pub fn reset_ink_waits(&mut self) {
        self.pages.reset_waits();
    }

    /// The largest gap (device px) between a drawn paper and the surface's transform, the last
    /// frame (0 when papers and ink are one transform).
    pub fn paper_gap(&self) -> f64 {
        self.gap
    }

    /// Waits until the GPU has done everything submitted (the PC's stand-in shell: its display
    /// link then waits for the frame as a surface's would). The time it took, ms.
    pub fn wait_gpu(&self) -> f64 {
        let t0 = Instant::now();
        let _ = self.canvas.device.poll(wgpu::PollType::wait_indefinitely());
        t0.elapsed().as_secs_f64() * 1000.0
    }

    fn target_size(&self) -> (u32, u32) {
        match &self.target {
            Target::Surface { config, .. } => (config.width, config.height),
            Target::Offscreen { texture } => (texture.width(), texture.height()),
        }
    }

    /// The scene of page `id`: its strokes as the page stores them (one z-layer).
    pub fn set_scene(&mut self, id: &str, strokes: &[Stroke]) -> usize {
        let scene = Scene::build(&[strokes]);
        self.put_scene(id, &scene)
    }

    pub fn remove_scene(&mut self, id: &str) {
        if self.pages.remove(id) {
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
            self.pages.set_frame(&frame);
            self.frame = frame;
            self.dirty = true;
        }
    }

    /// Every placement on the page's surface placed from one transform (scale, corner, device px):
    /// the camera's, on each tick (`FrameSpec::place`). In place.
    /// The page moved its surface alone (its frame otherwise the same): no new frame to index.
    pub fn set_surface(&mut self, surface: [f64; 3]) {
        if self.frame.surface != Some(surface) {
            self.frame.surface = Some(surface);
            self.dirty = true;
        }
    }

    pub fn near_gen(&self) -> u64 {
        self.pages.near_gen()
    }

    /// Only the surface's transform is kept; each drawn placement's transform is made from it at
    /// the draw (never one per placement of the note per tick: ADR-007).
    pub fn place(&mut self, k: f64, x: f64, y: f64) {
        if !(k.is_finite() && x.is_finite() && y.is_finite() && k > 0.0) {
            return;
        }
        if self.frame.placed != Some([k, x, y]) {
            self.frame.placed = Some([k, x, y]);
            self.dirty = true;
        }
    }

    /// The frame as it will be drawn.
    pub fn frame(&self) -> &FrameSpec {
        &self.frame
    }

    pub fn clear_scenes(&mut self) {
        if self.pages.held() > 0 {
            self.pages.clear();
            self.dirty = true;
        }
    }

    pub fn stats(&self) -> Stats {
        let (pictures, picture_bytes, picture_budget) = self.canvas.picture_memory();
        Stats {
            scenes: self.pages.held(),
            capsules: self.pages.capsules(),
            pages: self.pages.stats(),
            pictures,
            picture_bytes,
            picture_budget,
            telemetry: self.telemetry.summarize(),
            ..self.stats.clone()
        }
    }

    /// The pictures' files this host draws from.
    pub fn library(&self) -> &crate::picture::Library {
        self.canvas.library()
    }

    /// Draws pictures from `lib` (crates/native shares one with the page's bridge).
    pub fn set_library(&mut self, lib: crate::picture::Library) {
        self.canvas.set_library(lib);
        self.dirty = true;
    }

    /// Draws, then again until every picture in view is decoded and drawn at the size it needs
    /// (tests, the PC harness: a shell draws them as they arrive, one display frame each). At
    /// most `rounds` draws.
    pub fn draw_settled(&mut self, rounds: u32) -> Result<bool, String> {
        let mut drawn = self.draw()?;
        for _ in 0..rounds {
            if !self.library().wait_idle(std::time::Duration::from_secs(60)) {
                break;
            }
            if !self.canvas.pictures.arrived() {
                break;
            }
            drawn |= self.draw()?;
        }
        Ok(drawn)
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

    /// Paces an offscreen host's draws as a surface's are (`Pace`; tests).
    pub fn set_paced(&mut self, on: bool) {
        self.paced = on;
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
        self.pace = Pace::default();
        // Pictures the worker decoded since: the frame is drawn again with them.
        if self.canvas.pictures.arrived() {
            self.dirty = true;
        }
        let surface = self.frame.placed.or(self.frame.surface);
        let size = self.target_size();
        if !self.dirty {
            // Nothing new to show: pages coming near are uploaded meanwhile.
            if !self.is_lost() {
                self.pages
                    .prefetch(&self.canvas, &self.frame, surface, size);
            }
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
        // Paced on the GPU and the display, never queued behind them (3.0.3 on the owner's iPad,
        // after a few seconds at rest: the GPU's frames ran past a refresh, the drawables filled
        // up and each tick waited 8 or 17 ms for one, every frame shown one or two refreshes
        // after its time). A tick whose previous frame the GPU has not finished draws nothing
        // (the next tick draws the newest camera); after a long wait for a drawable one tick is
        // skipped, which the frames queued ahead cover, so the queue drains without a gap.
        if self.paced {
            let _ = self.canvas.device.poll(wgpu::PollType::Poll);
            let busy = self.submitted > self.done.load(Ordering::Acquire)
                && self.submitted_at.is_some_and(|t| t.elapsed() < GPU_STALE);
            if busy {
                self.pace.gpu_late = true;
                self.stats.gpu_late += 1;
                return Ok(false);
            }
            if std::mem::take(&mut self.drain) {
                self.pace.drained = true;
                self.drained_last = true;
                self.stats.drained += 1;
                return Ok(false);
            }
        }
        let t0 = Instant::now();
        let frame_dt_us = self
            .last_frame_instant
            .map(|t| t.elapsed().as_micros() as u64)
            .unwrap_or(8333);
        self.last_frame_instant = Some(t0);
        let errors_before = self.errors();
        let bytes_before = self.pages.stats().gpu_bytes;
        // The placements meeting the view (all of them without a surface transform), their
        // scenes on the GPU (ADR-007).
        let order = self.pages.plan(&self.canvas, &self.frame, surface, size);
        // The frame as drawn: placements that cannot be drawn left out, papers that cannot be
        // drawn dropped, the desk colour clamped (FrameSpec::drawable, without copying the frame).
        // A placement on the surface takes the surface's transform (one f64 transform for all,
        // ADR-008), computed here for the drawn ones only.
        let mut skipped = 0u64;
        let mut gap = 0.0f64;
        let empty = &self.empty;
        let store = &self.pages;
        let pages: Vec<PageDraw> = order
            .iter()
            .filter_map(|&i| {
                let p = &self.frame.pages[i];
                let tf = match (surface, p.at) {
                    (Some([k, x, y]), Some([ax, ay])) => Transform {
                        a: k as f32,
                        b: 0.0,
                        c: 0.0,
                        d: k as f32,
                        ox: (x + ax * k) as f32,
                        oy: (y + ay * k) as f32,
                    },
                    _ => p.tf,
                };
                if !drawable_tf(&tf) {
                    skipped += 1;
                    return None;
                }
                let paper = p.paper.filter(Paper::is_drawable);
                if paper.is_some() {
                    if let (Some([k, x, y]), Some([ax, ay])) = (surface, p.at) {
                        gap = gap.max(
                            (tf.ox as f64 - (x + ax * k))
                                .abs()
                                .max((tf.oy as f64 - (y + ay * k)).abs())
                                .max((tf.a as f64 - k).abs() * 1000.0),
                        );
                    }
                }
                match store.gpu(&p.page) {
                    Some(scene) => Some(PageDraw { scene, tf, paper }),
                    // A sheet's paper is drawn even though its ink is a scene placed apart (or
                    // not here yet: the page sends it).
                    None => paper.map(|_| PageDraw {
                        scene: empty,
                        tf,
                        paper,
                    }),
                }
            })
            .collect();
        self.gap = gap;
        self.stats.skipped_pages += skipped;
        let frame = Frame {
            clear: self.frame.clear.map(clamp_rgba),
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
                let ta = Instant::now();
                let acquired = surface.get_current_texture();
                self.pace.acquire_ms = ta.elapsed().as_secs_f64() * 1000.0;
                let long = self.pace.acquire_ms > BACKLOG_MS;
                let now = Instant::now();
                if long && self.drained_last {
                    self.no_drain_until = Some(now + DRAIN_PAUSE);
                }
                self.drained_last = false;
                self.drain = long && self.no_drain_until.is_none_or(|t| now >= t);
                let st = match acquired {
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
                // Suboptimal (Android's pre-rotation, a size not told yet) is configured again
                // once; a surface that stays suboptimal is drawn as it is: reconfiguring the
                // swapchain on every frame of a gesture is what a Mali Vulkan driver crashed on.
                if st.suboptimal {
                    self.stats.suboptimal += 1;
                }
                *reconfigure = st.suboptimal && self.stats.suboptimal == 1;
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
        if self.paced {
            // Seen done by a later tick's poll (Pace).
            self.submitted += 1;
            self.submitted_at = Some(Instant::now());
            let (done, n) = (self.done.clone(), self.submitted);
            self.canvas.queue.on_submitted_work_done(move || {
                done.fetch_max(n, Ordering::AcqRel);
            });
        }
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
        // The CPU's part: the wait for a drawable is the display's (Pace::acquire_ms).
        let cpu_prepare_us = ((ms - self.pace.acquire_ms).max(0.0) * 1000.0) as u64;
        let bytes_uploaded = self.pages.stats().gpu_bytes.saturating_sub(bytes_before);
        self.telemetry.record(FrameSample {
            frame_dt_us,
            cpu_prepare_us,
            gpu_encode_us: 0,
            bytes_uploaded,
            draw_calls: self.pages.stats().drawn as u32,
        });
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

/// Draws a capsule through the coverage pass and a sheet's paper offscreen and reads them back:
/// None when both came out, else what did not.
fn self_test(canvas: &mut GpuCanvas, empty: &GpuScene) -> Option<String> {
    use crate::scene::{CapInst, Op, PageBox, Transform};
    let scene = Scene {
        caps: vec![CapInst::new(
            [8.0, 20.0, 6.0],
            [56.0, 20.0, 6.0],
            [0.0, 0.0, 0.0, 1.0],
        )],
        flat: Vec::new(),
        ops: vec![Op::See {
            first: 0,
            count: 1,
            col: [0.0, 0.0, 0.0, 1.0],
            bx: PageBox {
                x0: 0.0,
                y0: 0.0,
                x1: 64.0,
                y1: 40.0,
            },
        }],
    };
    let gs = canvas.upload(&scene);
    let paper = Paper {
        width: 64.0,
        height: 24.0,
        style: 0,
        base: [1.0, 0.0, 0.0, 1.0],
        dark: false,
        pattern: None,
        origin: [0.0, 0.0],
    };
    let frame = Frame {
        clear: Some(renderer::color::Rgba {
            r: 1.0,
            g: 1.0,
            b: 1.0,
            a: 1.0,
        }),
        pages: vec![
            PageDraw {
                scene: empty,
                tf: Transform::scale(1.0, 0.0, 40.0),
                paper: Some(paper),
            },
            PageDraw {
                scene: &gs,
                tf: Transform::scale(1.0, 0.0, 0.0),
                paper: None,
            },
        ],
    };
    let px = crate::gpu::render_frame_offscreen(canvas, 64, 64, &frame);
    if px.len() < 64 * 64 * 4 {
        return Some(format!(
            "no pixels read back ({})",
            canvas.health().last().unwrap_or_default()
        ));
    }
    // BGRA or RGBA: the channels compared are symmetric (grey, red vs blue / green).
    let at = |x: usize, y: usize| {
        let i = (y * 64 + x) * 4;
        [px[i], px[i + 1], px[i + 2]]
    };
    let ink = at(32, 20);
    let desk = at(32, 4);
    let sheet = at(32, 52);
    let mut bad = Vec::new();
    if ink.iter().any(|c| *c > 90) {
        bad.push(format!("ink {ink:?}"));
    }
    if desk.iter().any(|c| *c < 200) {
        bad.push(format!("clear {desk:?}"));
    }
    let (hi, lo) = (sheet.iter().max().copied(), sheet.iter().min().copied());
    if !(hi > Some(200) && lo < Some(60) && sheet[1] < 60) {
        bad.push(format!("paper {sheet:?}"));
    }
    (!bad.is_empty() || canvas.health().errors() > 0).then(|| {
        format!(
            "{} {}",
            bad.join(", "),
            canvas.health().last().unwrap_or_default()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_self_test_passes_on_a_gpu_that_draws() {
        for format in [
            wgpu::TextureFormat::Rgba8Unorm,
            wgpu::TextureFormat::Bgra8Unorm,
        ] {
            let (device, queue, name, _) = pc_device_backend().expect("a GPU on the PC");
            let mut canvas = GpuCanvas::new(device, queue, format);
            let empty = canvas.upload(&Scene::default());
            assert_eq!(self_test(&mut canvas, &empty), None, "{name} {format:?}");
        }
    }
}
