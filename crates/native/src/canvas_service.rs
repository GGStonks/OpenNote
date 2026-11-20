//! The native canvas's one owner: the GPU objects, what the page sends, and what the canvas
//! reports. The shells hold no pointer to any of it.
//!
//! Three threads reach it, and none waits for another's slow work:
//! - the page's bridge (`canvasScene`, `canvasSceneBin`, `canvasFrame`, `canvasStats`, on the
//!   shell's Rust worker thread) builds a scene on its own thread, then writes it, or the frame,
//!   into `PAGE` (a small lock held only to swap a value in) and returns. It never touches `HOST`,
//!   so it never waits for a draw, which waits for the surface's next image.
//! - the render thread (iOS `ONStartCanvasThread`, Android's "opennote-canvas" HandlerThread)
//!   calls `draw_active` every display frame: under `HOST` it takes what changed in `PAGE`,
//!   uploads it, draws and presents.
//! - the surface's lifecycle (iOS layout, Android's SurfaceHolder callbacks on the UI thread)
//!   calls `attach` / `resize` / `detach` under `HOST`; `detach` returns once no draw can use the
//!   surface, and the window is released after the host.
//!
//! A host made later (Android's surface back from the background, a host made again after its
//! device was lost) is given every scene and the last frame at its first draw: `PAGE` keeps them.
//!
//! Errors never panic: the device's validation errors are recorded by its handler (crates/canvas
//! `GpuHealth`) and shown in `canvasStats` (Settings > Diagnostics, the crash report's
//! `canvas-status`); a lost device, or a panic caught here, drops the host, which is made again
//! from the same layer or window at a later tick. On Android a Vulkan driver that fails to make a
//! device, loses it, or reports errors in its first frames is replaced by GLES for the rest of
//! the run (Mali drivers).

use crate::{clock_ms, f64s};
use canvas::host::{CanvasHost, FrameSpec, PagePlacement};
use canvas::Scene;
use model::Stroke;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

/// A lock taken whatever a panicking thread left behind (every value here stays consistent:
/// each is replaced whole).
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ------------------------------------------------------------------------------------------------
// What the page sends: written by the bridge, drained by the draw.

#[derive(Default)]
struct Page {
    /// Each page id's scene as last sent (kept for a host made later).
    scenes: HashMap<String, Arc<Scene>>,
    /// Ids whose scene changed (or went) since the last draw took them.
    changed: HashSet<String>,
    /// The page's last frame: what it shows (desk, sheets' paper, the scene's placement) and where
    /// its surface was (`FrameSpec::surface`); while Rust owns the camera every placement is put
    /// at the camera's surface on each tick (ADR-008).
    frame: Option<FrameSpec>,
    frame_changed: bool,
}

static PAGE: Mutex<Option<Page>> = Mutex::new(None);

fn with_page<R>(f: impl FnOnce(&mut Page) -> R) -> R {
    f(lock(&PAGE).get_or_insert_with(Default::default))
}

/// The scene of page `id` (None: it goes). Returns at once.
pub fn put_scene(id: &str, scene: Option<Scene>) {
    with_page(|p| {
        match scene {
            Some(s) => p.scenes.insert(id.to_string(), Arc::new(s)),
            None => p.scenes.remove(id),
        };
        p.changed.insert(id.to_string());
    });
}

/// Every scene goes.
pub fn clear_scenes() {
    with_page(|p| {
        let ids: Vec<String> = p.scenes.keys().cloned().collect();
        p.changed.extend(ids);
        p.scenes.clear();
    });
}

/// The page's frame. Returns at once.
pub fn put_frame(frame: FrameSpec) {
    with_page(|p| {
        p.frame = Some(frame);
        p.frame_changed = true;
    });
}

type SceneUpdates = Vec<(String, Option<Arc<Scene>>)>;
type PageFrame = FrameSpec;

/// What the draw must give its host: everything for a new host, else what changed.
fn take_changes(all: bool) -> (SceneUpdates, Option<PageFrame>) {
    with_page(|p| {
        let frame_changed = std::mem::take(&mut p.frame_changed);
        if all {
            p.changed.clear();
            (
                p.scenes
                    .iter()
                    .map(|(k, v)| (k.clone(), Some(v.clone())))
                    .collect(),
                p.frame.clone(),
            )
        } else {
            let ids: Vec<String> = p.changed.drain().collect();
            let updates = ids
                .into_iter()
                .map(|id| {
                    let s = p.scenes.get(&id).cloned();
                    (id, s)
                })
                .collect();
            let frame = if frame_changed { p.frame.clone() } else { None };
            (updates, frame)
        }
    })
}

// ------------------------------------------------------------------------------------------------
// What the canvas reports: written by the draw and the lifecycle, read by `canvasStats`.

#[derive(Clone, Debug, Default)]
struct Status {
    attached: bool,
    adapter: Option<String>,
    backend: Option<String>,
    /// The last error: attach, draw, a frame that failed, a lost device.
    error: Option<String>,
    /// Errors recorded in this run (every host's device, attach failures).
    errors: u64,
    /// The current host's frames.
    frames: u64,
    last_draw_ms: f64,
    worst_draw_ms: f64,
    width: u32,
    height: u32,
    failed_frames: u64,
    skipped_frames: u64,
    skipped_pages: u64,
    /// Hosts made again (lost device, a panic caught).
    recreated: u64,
    lost: u64,
    /// Why Android left Vulkan for GLES in this run.
    fallback: Option<String>,
    /// The host's driver, downlevel flags and self-test; the first error of the run.
    diag: Option<String>,
    first_error: Option<String>,
}

static STATUS: Mutex<Option<Status>> = Mutex::new(None);

fn with_status<R>(f: impl FnOnce(&mut Status) -> R) -> R {
    f(lock(&STATUS).get_or_insert_with(Default::default))
}

fn note_error(e: String) {
    with_status(|s| {
        s.errors += 1;
        if s.first_error.is_none() {
            s.first_error = Some(e.clone());
        }
        s.error = Some(e);
    });
}

/// `canvasStats`: the GPU, frames, errors, never waiting for a draw.
pub fn status_json() -> Value {
    let s = with_status(|s| s.clone());
    let (scenes, capsules) = with_page(|p| {
        (
            p.scenes.len(),
            p.scenes.values().map(|s| s.caps.len()).sum::<usize>(),
        )
    });
    json!({
        "attached": s.attached,
        "adapter": s.adapter,
        "backend": s.backend,
        "error": s.error,
        "errors": s.errors,
        "frames": s.frames,
        "lastDrawMs": s.last_draw_ms,
        "worstDrawMs": s.worst_draw_ms,
        "width": s.width,
        "height": s.height,
        "scenes": scenes,
        "capsules": capsules,
        "failedFrames": s.failed_frames,
        "skippedFrames": s.skipped_frames,
        "skippedPages": s.skipped_pages,
        "recreated": s.recreated,
        "lost": s.lost,
        "fallback": s.fallback,
        "diag": s.diag,
        "firstError": s.first_error,
        "viewport": crate::viewport_service::status(),
    })
}

fn attached() -> bool {
    with_status(|s| s.attached)
}

// ------------------------------------------------------------------------------------------------
// The GPU objects: locked by the render thread for a draw and by the surface's lifecycle.

/// What a host draws into, kept to make the host again.
pub enum Surface {
    /// An offscreen texture on the PC's GPU (tests, the JVM test of the JNI library).
    Offscreen,
    /// A `CAMetalLayer` (iOS); the shell keeps it while attached.
    #[cfg(any(target_os = "ios", target_os = "macos"))]
    Layer(std::ptr::NonNull<std::ffi::c_void>),
    /// An `ANativeWindow` (Android) with one reference of ours, released when this goes.
    #[cfg(target_os = "android")]
    Window(std::ptr::NonNull<ndk_sys::ANativeWindow>),
}

// SAFETY: the layer and the window are plain handles the shells hand over; they are only read
// under `HOST`'s lock (one thread at a time), and the window's reference is released once, on drop.
unsafe impl Send for Surface {}

#[cfg(target_os = "android")]
impl Drop for Surface {
    fn drop(&mut self) {
        if let Surface::Window(w) = self {
            // SAFETY: `w` holds the one reference acquired when the window was attached; this
            // drop is its only release, after the host using it was dropped (`drop_host`).
            unsafe { ndk_sys::ANativeWindow_release(w.as_ptr()) };
        }
    }
}

struct Slot {
    host: Option<CanvasHost>,
    surface: Option<Surface>,
    size: (u32, u32),
    /// The host has not had the page's scenes yet.
    fresh: bool,
    /// The host must be made again (lost device, a panic); ticks until the next attempt.
    remake: bool,
    wait: u32,
    attempts: u32,
    /// Frames this host drew, and its errors before them (counted into the status).
    host_frames: u64,
    host_errors: u64,
}

static HOST: Mutex<Slot> = Mutex::new(Slot {
    host: None,
    surface: None,
    size: (0, 0),
    fresh: false,
    remake: false,
    wait: 0,
    attempts: 0,
    host_frames: 0,
    host_errors: 0,
});

/// Android only: Vulkan failed in this run, GLES from now on.
static USE_GL: AtomicBool = AtomicBool::new(false);
const GL_FALLBACK: bool = cfg!(target_os = "android");
/// A Vulkan host reporting errors within its first frames is not trusted.
const TRUST_AFTER_FRAMES: u64 = 3;

fn make_host(surface: &Surface, w: u32, h: u32) -> Result<(CanvasHost, String), String> {
    match surface {
        Surface::Offscreen => CanvasHost::offscreen(w, h),
        #[cfg(any(target_os = "ios", target_os = "macos"))]
        // SAFETY: the shell keeps the CAMetalLayer alive while attached and detaches (synchronously)
        // before releasing it, so the surface never outlives the layer.
        Surface::Layer(layer) => unsafe {
            CanvasHost::attach(
                canvas::wgpu::SurfaceTargetUnsafe::CoreAnimationLayer(layer.as_ptr()),
                w,
                h,
                canvas::wgpu::Backends::METAL,
            )
        },
        #[cfg(target_os = "android")]
        Surface::Window(win) => {
            use canvas::wgpu::rwh::{
                AndroidDisplayHandle, AndroidNdkWindowHandle, RawDisplayHandle, RawWindowHandle,
            };
            let target = || canvas::wgpu::SurfaceTargetUnsafe::RawHandle {
                raw_display_handle: RawDisplayHandle::Android(AndroidDisplayHandle::new()),
                raw_window_handle: RawWindowHandle::AndroidNdk(AndroidNdkWindowHandle::new(
                    win.cast(),
                )),
            };
            // SAFETY (both attaches): the window holds our reference until the slot drops the host
            // first and then the window (`drop_host`), so the surface never outlives it.
            if !USE_GL.load(Ordering::SeqCst) {
                match unsafe { CanvasHost::attach(target(), w, h, canvas::wgpu::Backends::VULKAN) }
                {
                    Ok(r) => return Ok(r),
                    Err(e) => fall_back_to_gl(format!("vulkan attach: {e}")),
                }
            }
            unsafe { CanvasHost::attach(target(), w, h, canvas::wgpu::Backends::GL) }
        }
    }
}

fn fall_back_to_gl(why: String) {
    if GL_FALLBACK && !USE_GL.swap(true, Ordering::SeqCst) {
        with_status(|s| s.fallback = Some(why.clone()));
        note_error(why);
    }
}

/// Android: GLES from the start of this run (before the first attach). The shell asks for it when
/// a run with the canvas on ended in a crash: a GPU driver's segfault (Mali's Vulkan) ends the
/// process past anything Rust can catch, and would otherwise end every run the same way.
pub fn prefer_gl(why: &str) {
    fall_back_to_gl(format!("gles chosen at start: {why}"));
}

/// Puts a new host in the slot (the old one dropped first: a window takes one producer at a time).
fn install(slot: &mut Slot, w: u32, h: u32) -> bool {
    drop_host(slot);
    let Some(surface) = slot.surface.as_ref() else {
        return false;
    };
    match make_host(surface, w, h) {
        Ok((host, name)) => {
            let backend = format!("{:?}", host.backend());
            let diag = host.diag().to_string();
            slot.host = Some(host);
            slot.size = (w, h);
            slot.fresh = true;
            slot.remake = false;
            slot.attempts = 0;
            slot.host_frames = 0;
            slot.host_errors = 0;
            with_status(|s| {
                s.attached = true;
                s.adapter = Some(name);
                s.backend = Some(backend);
                s.diag = Some(diag);
                s.frames = 0;
                s.width = w;
                s.height = h;
            });
            true
        }
        Err(e) => {
            with_status(|s| s.attached = false);
            note_error(format!("attach: {e}"));
            false
        }
    }
}

/// Drops the host, whatever state a panic left it in.
fn drop_host(slot: &mut Slot) {
    if let Some(host) = slot.host.take() {
        if catch_unwind(AssertUnwindSafe(move || drop(host))).is_err() {
            note_error("the host panicked while it was freed".into());
        }
    }
}

/// A host for `surface`, `w` x `h` device px, made the active one (any earlier one goes first).
/// False when no GPU could draw into it (the reason in the status).
pub fn attach(surface: Surface, w: u32, h: u32) -> bool {
    let mut slot = lock(&HOST);
    drop_host(&mut slot);
    slot.surface = None;
    slot.surface = Some(surface);
    let ok = install(&mut slot, w, h);
    if !ok {
        slot.surface = None;
    }
    ok
}

/// An offscreen host (tests).
pub fn attach_offscreen(w: u32, h: u32) -> bool {
    attach(Surface::Offscreen, w, h)
}

/// The surface's new size (device px).
pub fn resize(w: u32, h: u32) {
    let mut slot = lock(&HOST);
    slot.size = (w, h);
    if let Some(host) = slot.host.as_mut() {
        host.resize(w, h);
        let s = host.stats();
        with_status(|st| {
            st.width = s.width;
            st.height = s.height;
        });
    }
}

/// The surface goes: when this returns no draw uses it, and the window is released.
pub fn detach() {
    let mut slot = lock(&HOST);
    drop_host(&mut slot);
    slot.surface = None;
    slot.remake = false;
    with_status(|s| s.attached = false);
}

/// The offscreen host's pixels (tests): RGBA8, empty when there is none.
pub fn offscreen_pixels() -> Vec<u8> {
    lock(&HOST)
        .host
        .as_mut()
        .map(|h| h.pixels())
        .unwrap_or_default()
}

/// The render thread's draw: what the page changed, then the frame when anything changed.
/// True when a frame was drawn. Without the display's presentation time (the PC's stand-in,
/// tests) the frame is taken as shown a resampling interval from now: the fingers are placed
/// where they are now.
pub fn draw_active() -> bool {
    draw_at(clock_ms() + crate::viewport_service::RESAMPLE_MS)
}

/// The draw of the display frame presented at `present_ms` (the shells' clock: iOS
/// `CADisplayLink.targetTimestamp`, Android Choreographer's frame time plus a vsync period): the
/// camera is advanced to that moment, not to the moment the tick happened to run.
pub fn draw_at(present_ms: f64) -> bool {
    let t = if present_ms.is_finite() {
        present_ms
    } else {
        clock_ms()
    };
    catch_unwind(AssertUnwindSafe(|| draw_locked(t))).unwrap_or_else(|_| {
        // Nothing drawn by a host that panicked is trusted: made again at a later tick.
        let mut slot = lock(&HOST);
        drop_host(&mut slot);
        slot.remake = slot.surface.is_some();
        slot.wait = 30;
        with_status(|s| s.attached = false);
        note_error("draw panicked".into());
        false
    })
}

fn draw_locked(present_ms: f64) -> bool {
    // The camera first (its own lock): advanced to the frame's time whether or not a host draws.
    let placed = crate::viewport_service::draw_tick(present_ms);
    let mut guard = lock(&HOST);
    let slot: &mut Slot = &mut guard;
    if slot.host.is_none() {
        if !slot.remake || slot.surface.is_none() {
            return false;
        }
        if slot.wait > 0 {
            slot.wait -= 1;
            return false;
        }
        let (w, h) = slot.size;
        if !install(slot, w, h) {
            slot.attempts += 1;
            slot.remake = slot.attempts < 10;
            slot.wait = 120;
            return false;
        }
        with_status(|s| s.recreated += 1);
    }
    let fresh = std::mem::take(&mut slot.fresh);
    let Some(host) = slot.host.as_mut() else {
        return false;
    };
    if host.is_lost() {
        let backend = host.backend();
        with_status(|s| s.lost += 1);
        note_error(format!(
            "device lost: {}",
            host.last_error().unwrap_or_default()
        ));
        if backend == canvas::wgpu::Backend::Vulkan {
            fall_back_to_gl("vulkan device lost".into());
        }
        drop_host(slot);
        slot.remake = slot.surface.is_some();
        slot.wait = 0;
        return false;
    }
    let (updates, frame) = take_changes(fresh);
    for (id, scene) in updates {
        match scene {
            Some(s) => {
                host.put_scene(&id, &s);
            }
            None => host.remove_scene(&id),
        }
    }
    if let Some(f) = frame {
        host.set_frame(f);
    }
    // One transform for everything drawn (ADR-008): the camera's surface while Rust owns the
    // camera, else where the page drew its surface (its own numbers).
    let surface = placed.or(host.frame().surface.map(|[k, x, y]| (k, x, y)));
    if let Some((k, x, y)) = surface {
        host.place(k, x, y);
    }
    let result = host.draw();
    if result == Ok(true) {
        crate::viewport_service::drew(host.frame().paper_gap());
    }
    let s = host.stats();
    let errors = host.errors();
    let uncaptured = host.uncaptured_errors();
    let backend = host.backend();
    let new_errors = errors.saturating_sub(slot.host_errors);
    slot.host_errors = errors;
    if result == Ok(true) {
        slot.host_frames += 1;
    }
    let last = host.last_error();
    with_status(|st| {
        st.frames = s.frames;
        st.last_draw_ms = s.last_draw_ms;
        st.worst_draw_ms = s.worst_draw_ms;
        st.width = s.width;
        st.height = s.height;
        st.failed_frames = s.failed;
        st.skipped_frames = s.skipped_frames;
        st.skipped_pages = s.skipped_pages;
        st.errors += new_errors;
        if new_errors > 0 {
            st.error = last.clone().map(|e| format!("gpu: {e}"));
        }
    });
    if let Err(e) = &result {
        with_status(|st| st.error = Some(format!("draw: {e}")));
    }
    // A Vulkan driver that reports errors in its first frames: GLES for the rest of the run.
    if GL_FALLBACK
        && backend == canvas::wgpu::Backend::Vulkan
        && uncaptured > 0
        && slot.host_frames < TRUST_AFTER_FRAMES
    {
        fall_back_to_gl(format!(
            "vulkan errors in the first frames: {}",
            last.unwrap_or_default()
        ));
        drop_host(slot);
        slot.remake = slot.surface.is_some();
        slot.wait = 0;
        return false;
    }
    result.unwrap_or(false)
}

// ------------------------------------------------------------------------------------------------
// The page's bridge methods (crates/native `call`).

/// Each page's strokes as the canvas last got them: the page's key for a stroke object
/// (rustCore.ts `sceneKey`) to its ops (`build_stroke_ops`, its drawn line: the costly part).
/// rs.22-25 rebuilt every stroke of the note at each lift (140-200 ms on the iPad for a
/// 6,000-stroke note, the stroke missing from the screen meanwhile). Used by the bridge alone.
type StrokeOps = Arc<Vec<renderer::builder::RenderOp>>;
type PageOps = Vec<(u64, StrokeOps)>;
static SCENE_OPS: Mutex<Option<HashMap<String, PageOps>>> = Mutex::new(None);

fn scene_of(ops: &PageOps) -> Scene {
    let layer: Vec<&[renderer::builder::RenderOp]> =
        ops.iter().map(|(_, o)| o.as_slice()).collect();
    Scene::from_ops(&[layer])
}

/// `canvasScene`: a page's strokes (or z-layers of strokes) as JSON, the scene built here.
pub fn canvas_scene(meta: &str) -> Result<(String, Vec<u8>), String> {
    #[derive(Deserialize)]
    struct Req {
        page: String,
        #[serde(default)]
        strokes: Vec<Stroke>,
        #[serde(default)]
        layers: Option<Vec<Vec<Stroke>>>,
    }
    let r: Req = serde_json::from_str(meta).map_err(|e| format!("canvasScene request: {e}"))?;
    let scene = match &r.layers {
        Some(layers) => Scene::build(&layers.iter().map(|l| l.as_slice()).collect::<Vec<_>>()),
        None => Scene::build(&[&r.strokes]),
    };
    let count = scene.caps.len();
    put_scene(&r.page, Some(scene));
    let attached = attached();
    Ok((
        json!({ "ok": attached, "capsules": count, "attached": attached }).to_string(),
        Vec::new(),
    ))
}

/// `canvasSceneBin`: the scene as the page sends it from a note (rustCore.ts rustSetCanvasScene):
/// meta `{ page, strokes: [{ k, n?, s? }] }` in z-order, `k` each stroke object's key, `s` its
/// style and `n` its point count, sent only for a stroke the canvas does not have yet (else its
/// key `k` alone); data the points of those, f64 x, y, pressure, t (t NaN: none), n per stroke
/// in order. A key the canvas does not hold is answered `missing` (nothing changes; the page
/// sends them all). No strokes: the page's scene goes.
pub fn canvas_scene_bin(meta: &str, data: &[u8]) -> Result<(String, Vec<u8>), String> {
    #[derive(Deserialize)]
    struct Head {
        k: u64,
        #[serde(default)]
        n: usize,
        #[serde(default)]
        s: Option<Stroke>,
    }
    #[derive(Deserialize)]
    struct Req {
        page: String,
        strokes: Vec<Head>,
    }
    let r: Req = serde_json::from_str(meta).map_err(|e| format!("canvasSceneBin request: {e}"))?;
    let vals = f64s(data)?;
    let total: usize = r
        .strokes
        .iter()
        .filter(|h| h.s.is_some())
        .map(|h| h.n)
        .sum();
    if total * 4 != vals.len() {
        return Err(format!(
            "{} points announced, {} values sent",
            total,
            vals.len()
        ));
    }
    if r.strokes.is_empty() {
        lock(&SCENE_OPS)
            .get_or_insert_with(Default::default)
            .remove(&r.page);
        put_scene(&r.page, None);
        let attached = attached();
        return Ok((json!({ "ok": attached, "capsules": 0, "attached": attached, "strokes": 0, "built": 0 }).to_string(), Vec::new()));
    }
    let held: HashMap<u64, StrokeOps> = lock(&SCENE_OPS)
        .get_or_insert_with(Default::default)
        .get(&r.page)
        .map(|v| v.iter().cloned().collect())
        .unwrap_or_default();
    let missing: Vec<u64> = r
        .strokes
        .iter()
        .filter(|h| h.s.is_none() && !held.contains_key(&h.k))
        .map(|h| h.k)
        .collect();
    if !missing.is_empty() {
        return Ok((
            json!({ "ok": false, "missing": missing }).to_string(),
            Vec::new(),
        ));
    }
    // The new strokes' ops, built on the bridge's thread, no lock held.
    let mut at = 0;
    let mut built = 0;
    let ops: PageOps = r
        .strokes
        .into_iter()
        .map(|h| {
            let o = match h.s {
                Some(mut st) => {
                    st.points = vals[at * 4..(at + h.n) * 4]
                        .as_chunks::<4>()
                        .0
                        .iter()
                        .map(|c| model::Point {
                            x: c[0],
                            y: c[1],
                            pressure: c[2],
                            t: if c[3].is_nan() { None } else { Some(c[3]) },
                            ..Default::default()
                        })
                        .collect();
                    at += h.n;
                    built += 1;
                    Arc::new(renderer::builder::build_stroke_ops(&st))
                }
                None => held[&h.k].clone(),
            };
            (h.k, o)
        })
        .collect();
    let scene = scene_of(&ops);
    let strokes = ops.len();
    let count = scene.caps.len();
    lock(&SCENE_OPS)
        .get_or_insert_with(Default::default)
        .insert(r.page.clone(), ops);
    put_scene(&r.page, Some(scene));
    let attached = attached();
    Ok((json!({ "ok": attached, "capsules": count, "attached": attached, "strokes": strokes, "built": built }).to_string(), Vec::new()))
}

/// `canvasFrame`: where the page shows its pages (crates/canvas `FrameSpec::parse`).
pub fn canvas_frame(meta: &str) -> Result<(String, Vec<u8>), String> {
    let frame = FrameSpec::parse(meta);
    let parsed = frame.is_some();
    if let Some(f) = frame {
        put_frame(f);
    }
    let attached = attached();
    Ok((
        json!({ "ok": attached && parsed, "attached": attached }).to_string(),
        Vec::new(),
    ))
}

pub fn canvas_stats() -> Result<(String, Vec<u8>), String> {
    Ok((status_json().to_string(), Vec::new()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CanvasRenderReq {
    width: u32,
    height: u32,
    scale: Option<f32>,
    ox: Option<f32>,
    oy: Option<f32>,
    paper_color: Option<String>,
    paper_style: Option<String>,
    strokes: Vec<Stroke>,
}

/// `canvasRender` (tests, the PC harness): strokes drawn by a host of their own, the pixels back.
pub fn canvas_render(meta: &str) -> Result<(String, Vec<u8>), String> {
    let t0 = clock_ms();
    let req: CanvasRenderReq =
        serde_json::from_str(meta).map_err(|e| format!("canvasRender request: {e}"))?;
    if req.width == 0 || req.height == 0 {
        return Err("invalid dimensions".into());
    }
    let (mut host, _gpu_name) = CanvasHost::offscreen(req.width, req.height)?;
    let scene_caps = host.set_scene("page", &req.strokes);
    let scale = req.scale.unwrap_or(1.0);
    let tf = canvas::Transform::scale(scale, req.ox.unwrap_or(0.0), req.oy.unwrap_or(0.0));
    let clear_rgba = req
        .paper_color
        .as_deref()
        .map(|c| renderer::color::Rgba::parse(c, 1.0))
        .unwrap_or(renderer::color::Rgba::WHITE);
    let style_code = req
        .paper_style
        .as_deref()
        .map(canvas::Paper::style_code)
        .unwrap_or(0);
    let paper = (style_code > 0).then(|| canvas::Paper {
        width: req.width as f32 / scale,
        height: req.height as f32 / scale,
        style: style_code,
        base: [clear_rgba.r, clear_rgba.g, clear_rgba.b, clear_rgba.a],
        dark: false,
        pattern: None,
        origin: [0.0, 0.0],
    });
    host.set_frame(FrameSpec {
        surface: None,
        placed: None,
        clear: Some(clear_rgba),
        pages: vec![PagePlacement {
            page: "page".to_string(),
            tf,
            paper,
            at: None,
        }],
    });
    host.draw()?;
    let px = host.pixels();
    let reply_meta = json!({ "width": req.width, "height": req.height, "capsules": scene_caps, "ms": clock_ms() - t0 });
    Ok((reply_meta.to_string(), px))
}

// ------------------------------------------------------------------------------------------------
// The shells' C ABI (iOS; the JNI functions of lib.rs call the same).

/// Attaches the canvas to a `CAMetalLayer` (iOS). False when no GPU could draw into it.
///
/// # Safety
/// `layer` must be a CAMetalLayer that stays alive until `opennote_canvas_detach` returns.
#[cfg(any(target_os = "ios", target_os = "macos"))]
#[no_mangle]
pub unsafe extern "C" fn opennote_canvas_attach_layer(
    layer: *mut std::ffi::c_void,
    w: u32,
    h: u32,
) -> bool {
    catch_unwind(AssertUnwindSafe(|| match std::ptr::NonNull::new(layer) {
        Some(l) => attach(Surface::Layer(l), w, h),
        None => false,
    }))
    .unwrap_or(false)
}

/// The surface's new size, device px.
#[no_mangle]
pub extern "C" fn opennote_canvas_resize(w: u32, h: u32) {
    let _ = catch_unwind(|| resize(w, h));
}

/// The surface goes: when this returns, no draw uses it.
#[no_mangle]
pub extern "C" fn opennote_canvas_detach() {
    let _ = catch_unwind(detach);
}

/// The render thread's draw (never the main thread: it waits for the surface's next image).
/// The draw of the display frame presented at `present_s` (seconds on the shells' clock:
/// `CADisplayLink.targetTimestamp`). Render thread only.
#[no_mangle]
pub extern "C" fn opennote_canvas_draw_at(present_s: f64) -> bool {
    draw_at(present_s * 1000.0)
}

#[no_mangle]
pub extern "C" fn opennote_canvas_draw_active() -> bool {
    catch_unwind(draw_active).unwrap_or(false)
}
