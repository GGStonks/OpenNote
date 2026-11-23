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
use canvas::{ImageItem, Library, OpsLayer, Scene};
use model::Stroke;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

/// A lock taken whatever a panicking thread left behind (every value here stays consistent:
/// each is replaced whole).
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ------------------------------------------------------------------------------------------------
// What the page sends: written by the bridge, drained by the draw.

/// A page's scene as the bridge keeps it, and its bytes in memory: the scene and the strokes' ops
/// kept for it (`SCENE_OPS`, estimated from the scene).
struct Held {
    scene: Arc<Scene>,
    bytes: u64,
}

fn held_bytes(s: &Scene) -> u64 {
    // The ops' capsules are f64 (48 bytes), arrowheads and fills a few points each.
    s.cpu_bytes() + s.caps.len() as u64 * 48 + s.flat.len() as u64 * 16
}

#[derive(Default)]
struct Page {
    /// Each page id's scene as last sent (kept for a host made later), within the memory budget:
    /// beyond it the scenes longest away from the view go, and the page sends them again when
    /// they come near (ADR-007).
    scenes: HashMap<String, Held>,
    bytes: u64,
    /// When each scene id was last near the view (the render thread's count), and the ids near
    /// it now (never evicted).
    near_at: HashMap<String, u64>,
    near_now: HashSet<String>,
    near_tick: u64,
    /// Scene ids near the view that the canvas does not have (in view first): the page sends them.
    missing: Vec<String>,
    missing_gen: u64,
    /// Scenes evicted for memory since the run began.
    dropped: u64,
    /// The surface alone moved (the page's frame otherwise the same).
    surface: Option<[f64; 3]>,
    /// Ids whose scene changed (or went) since the last draw took them.
    changed: HashSet<String>,
    /// The page's last frame: what it shows (desk, sheets' paper, the scene's placement) and where
    /// its surface was (`FrameSpec::surface`); while Rust owns the camera every placement is put
    /// at the camera's surface on each tick (ADR-008).
    frame: Option<FrameSpec>,
    frame_changed: bool,
}

static PAGE: Mutex<Option<Page>> = Mutex::new(None);

/// The canvas's screen while casting (device px), its device px per view unit (0: unknown) and
/// the surface's transform there (scale, left, top).
static CAST_SCREEN: Mutex<([f32; 2], f32, [f64; 3])> = Mutex::new(([0.0, 0.0], 0.0, [0.0; 3]));

/// Placements a cast snapshot carries at most (those meeting the device's screen and half a
/// screen around it): bounded by the screen, never by the note's length.
const CAST_PAGES: usize = 24;

/// A placement a cast snapshot carries: where it sits on the surface, its paper, its scene, its id.
type CastPick = ([f64; 2], Option<canvas::Paper>, Option<Arc<Scene>>, String);

/// The cast viewers' snapshot (canvas::cast): the pages near the view, their paper and ink. With
/// `last`, None when nothing changed since the snapshot `last` names (the pages, their scenes,
/// the screen), and `last` set to this one.
pub fn cast_document(last: Option<&mut u64>) -> Option<Vec<u8>> {
    use std::hash::{Hash, Hasher};
    let (device, view_px, [k, x, y]) = *lock(&CAST_SCREEN);
    if k.is_nan() || k <= 0.0 {
        return None;
    }
    // The screen on the surface (surface px), half a screen more each way.
    let (w, h) = (device[0] as f64 / k, device[1] as f64 / k);
    let (sx0, sy0) = (-x / k - w / 2.0, -y / k - h / 2.0);
    let (sx1, sy1) = (sx0 + 2.0 * w, sy0 + 2.0 * h);
    let (clear, picked) = with_page(|p| {
        let frame = p.frame.as_ref()?;
        let picked: Vec<CastPick> = frame
            .pages
            .iter()
            .filter_map(|pl| {
                // A placement of the page's own transform (a note with pictures): where that puts
                // it on the surface.
                let at = pl.at.or_else(|| {
                    let [fk, fx, fy] = frame.surface?;
                    ((pl.tf.a as f64 - fk).abs() < 1e-3 * fk)
                        .then(|| [(pl.tf.ox as f64 - fx) / fk, (pl.tf.oy as f64 - fy) / fk])
                })?;
                // Its box on the surface: the paper's, else the part of the surface it belongs
                // to; one with neither is kept.
                let bx = match (pl.paper, pl.bx) {
                    (Some(pp), _) => Some([0.0, 0.0, pp.width as f64, pp.height as f64]),
                    (None, b) => b,
                };
                if let Some([x0, y0, x1, y1]) = bx {
                    let (px0, py0, px1, py1) = (at[0] + x0, at[1] + y0, at[0] + x1, at[1] + y1);
                    if px1 < sx0 || px0 > sx1 || py1 < sy0 || py0 > sy1 {
                        return None;
                    }
                }
                Some((at, pl.paper, p.scenes.get(&pl.page).map(|h| h.scene.clone()), pl.page.clone()))
            })
            .take(CAST_PAGES)
            .collect();
        Some((frame.clear, picked))
    })?;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for v in [device[0], device[1], view_px] {
        v.to_bits().hash(&mut h);
    }
    clear.map(|c| [c.r, c.g, c.b, c.a].map(f32::to_bits)).hash(&mut h);
    for (at, paper, scene, id) in &picked {
        id.hash(&mut h);
        at.map(f64::to_bits).hash(&mut h);
        format!("{paper:?}").hash(&mut h);
        scene.as_ref().map(|s| Arc::as_ptr(s) as usize).hash(&mut h);
    }
    let key = h.finish();
    if let Some(l) = last {
        if *l == key {
            return None;
        }
        *l = key;
    }
    let pages: Vec<canvas::cast::CastPage> = picked
        .iter()
        .map(|(at, paper, scene, _)| canvas::cast::CastPage {
            at: *at,
            paper: paper.as_ref(),
            scene: scene.as_deref(),
        })
        .collect();
    Some(canvas::cast::encode(device, view_px, clear, &pages))
}

/// The pictures' files the page sent (`canvasImage`), shared by every host made: a host made
/// again (lost device, Android's surface back) decodes them again as they come into view.
static LIBRARY: OnceLock<Library> = OnceLock::new();

pub fn library() -> &'static Library {
    LIBRARY.get_or_init(Library::new)
}

/// Drops the files no page's scene shows any more (a note closed).
fn collect_pictures() {
    let keys: HashSet<u64> = with_page(|p| {
        p.scenes
            .values()
            .flat_map(|s| s.scene.image_keys().collect::<Vec<_>>())
            .collect()
    });
    library().retain(&keys);
}

fn with_page<R>(f: impl FnOnce(&mut Page) -> R) -> R {
    f(lock(&PAGE).get_or_insert_with(Default::default))
}

/// The scene of page `id` (None: it goes). Returns at once.
pub fn put_scene(id: &str, scene: Option<Scene>) {
    with_page(|p| {
        let old = match scene {
            Some(s) => {
                let bytes = held_bytes(&s);
                p.bytes += bytes;
                p.scenes.insert(
                    id.to_string(),
                    Held {
                        scene: Arc::new(s),
                        bytes,
                    },
                )
            }
            None => p.scenes.remove(id),
        };
        if let Some(o) = old {
            p.bytes -= o.bytes;
        }
        p.changed.insert(id.to_string());
    });
}

// ------------------------------------------------------------------------------------------------
// Memory (ADR-007): bounded by the device, never by the note's length.

/// The budgets set by a caller (bench, tests), bytes; 0: derived from the device.
static GPU_BUDGET: AtomicU64 = AtomicU64::new(0);
static CPU_BUDGET: AtomicU64 = AtomicU64::new(0);

/// The device's memory (bytes), when the system says.
fn device_memory() -> Option<u64> {
    #[cfg(unix)]
    {
        // SAFETY: sysconf only reads system values.
        let (pages, size) = unsafe {
            (
                libc::sysconf(libc::_SC_PHYS_PAGES),
                libc::sysconf(libc::_SC_PAGESIZE),
            )
        };
        if pages > 0 && size > 0 {
            return Some(pages as u64 * size as u64);
        }
    }
    None
}

/// The pages' scenes on the GPU: a 48th of the device's memory (iPad and Android GPUs share it
/// with the app), between 32 and 256 MB. What the bridge keeps (scenes and the strokes' ops):
/// twice that.
pub fn budgets() -> (u64, u64) {
    const MB: u64 = 1 << 20;
    let derived = device_memory()
        .map(|m| (m / 48).clamp(32 * MB, 256 * MB))
        .unwrap_or(96 * MB);
    let gpu = match GPU_BUDGET.load(Ordering::Relaxed) {
        0 => derived,
        b => b,
    };
    let cpu = match CPU_BUDGET.load(Ordering::Relaxed) {
        0 => gpu * 2,
        b => b,
    };
    (gpu, cpu)
}

/// Beyond the memory budget, the scenes longest away from the view go (never one near it, nor
/// `keep`), with their strokes' ops; the page is told (`dropped`) and sends them again when they
/// come near. Returns the ids that went.
fn evict_for_memory(keep: &str) -> Vec<String> {
    let (_, budget) = budgets();
    let out = with_page(|p| {
        if p.bytes <= budget || (p.near_now.is_empty() && !p.scenes.is_empty()) {
            return Vec::new();
        }
        let mut cands: Vec<(u64, String)> = p
            .scenes
            .iter()
            .filter(|(id, h)| h.bytes > 1024 && id.as_str() != keep && !p.near_now.contains(*id))
            .map(|(id, _)| (p.near_at.get(id).copied().unwrap_or(0), id.clone()))
            .collect();
        cands.sort();
        let mut out = Vec::new();
        for (_, id) in cands {
            if p.bytes <= budget {
                break;
            }
            if let Some(h) = p.scenes.remove(&id) {
                p.bytes -= h.bytes;
                p.changed.insert(id.clone());
                p.near_at.remove(&id);
                p.dropped += 1;
                out.push(id);
            }
        }
        out
    });
    if !out.is_empty() {
        let mut ops = lock(&SCENE_OPS);
        let map = ops.get_or_insert_with(Default::default);
        for id in &out {
            map.remove(id);
        }
    }
    out
}

/// Scene ids near the view the canvas does not have (in view first), and their generation.
pub fn missing() -> (Vec<String>, u64) {
    with_page(|p| (p.missing.clone(), p.missing_gen))
}

/// Every scene goes.
pub fn clear_scenes() {
    with_page(|p| {
        let ids: Vec<String> = p.scenes.keys().cloned().collect();
        p.changed.extend(ids);
        p.scenes.clear();
        p.bytes = 0;
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

/// What the draw must give its host: everything for a new host, else what changed (and the
/// surface alone when only it moved).
fn take_changes(all: bool) -> (SceneUpdates, Option<PageFrame>, Option<[f64; 3]>) {
    with_page(|p| {
        let frame_changed = std::mem::take(&mut p.frame_changed);
        let surface = p.surface.take();
        if all {
            p.changed.clear();
            (
                p.scenes
                    .iter()
                    .map(|(k, v)| (k.clone(), Some(v.scene.clone())))
                    .collect(),
                p.frame.clone(),
                None,
            )
        } else {
            let ids: Vec<String> = p.changed.drain().collect();
            let updates = ids
                .into_iter()
                .map(|id| {
                    let s = p.scenes.get(&id).map(|h| h.scene.clone());
                    (id, s)
                })
                .collect();
            let frame = if frame_changed { p.frame.clone() } else { None };
            (updates, frame, if frame_changed { None } else { surface })
        }
    })
}

/// After a draw: what is near the view (kept from eviction) and what it misses (the page sends
/// it). Only when the host's lists changed.
fn note_near(near: &[String], missing: &[String]) {
    with_page(|p| {
        note_near_page(p, near, missing);
    });
}

fn note_near_page(p: &mut Page, near: &[String], missing: &[String]) {
    p.near_tick += 1;
    let t = p.near_tick;
    for id in near {
        p.near_at.insert(id.clone(), t);
    }
    p.near_now = near.iter().cloned().collect();
    if p.missing != missing {
        p.missing = missing.to_vec();
        p.missing_gen += 1;
    }
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
    /// The pages' scenes on the host (ADR-007).
    pages: canvas::pages::PageStats,
    /// Time-to-ink of pages entering the view: samples, p50, p95, max (ms).
    ink: (usize, f64, f64, f64),
    /// When (clock_ms) the view last became complete: every page in view drawn with its ink.
    ink_complete_ms: f64,
    /// The GPU's own time per frame (the PC's stand-in waits for it): last, worst.
    gpu_ms: (f64, f64),
    /// The pictures' textures on the device (count, bytes) and their budget.
    pictures: usize,
    picture_bytes: u64,
    picture_budget: u64,
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
    let l = library().stats();
    let (scenes, capsules, bytes, missing, dropped, sample) = with_page(|p| {
        // A few ids, for the crash report: what the view misses, and some of what is held.
        let mut sample: Vec<String> = p
            .missing
            .iter()
            .take(4)
            .map(|m| format!("missing {m}"))
            .collect();
        sample.extend(p.scenes.keys().take(4).map(|k| format!("held {k}")));
        (
            p.scenes.len(),
            p.scenes.values().map(|s| s.scene.caps.len()).sum::<usize>(),
            p.bytes,
            p.missing.len(),
            p.dropped,
            sample,
        )
    });
    let rust_ops: usize = lock(&SCENE_OPS)
        .as_ref()
        .map(|m| m.values().map(|v| v.len()).sum())
        .unwrap_or(0);
    let (gpu_budget, cpu_budget) = budgets();

    let (ink_val, telemetry_val, host_stats) =
        lock(&HOST)
            .host
            .as_ref()
            .map_or((s.ink, json!(null), None), |h| {
                let mut w = h.ink_waits();
                w.sort_by(f32::total_cmp);
                let q = |p: f64| {
                    if w.is_empty() {
                        f64::NAN
                    } else {
                        w[((w.len() - 1) as f64 * p).round() as usize] as f64
                    }
                };
                let ink = (
                    w.len(),
                    q(0.5),
                    q(0.95),
                    w.last().map_or(f64::NAN, |v| *v as f64),
                );
                let t = h.stats().telemetry;
                let telem = json!({
                    "p50CpuUs": t.p50_cpu_us,
                    "p95CpuUs": t.p95_cpu_us,
                    "p99CpuUs": t.p99_cpu_us,
                    "maxCpuUs": t.max_cpu_us,
                    "p50DtUs": t.p50_dt_us,
                    "p95DtUs": t.p95_dt_us,
                    "p99DtUs": t.p99_dt_us,
                    "maxDtUs": t.max_dt_us,
                    "avgBytesUploaded": t.avg_bytes_uploaded,
                    "avgDrawCalls": t.avg_draw_calls,
                    "droppedFramePct": t.dropped_frame_pct,
                    "spikesUnder4_2ms": t.spikes_under_4_2_ms,
                    "spikes4_2To8_5ms": t.spikes_4_2_to_8_5_ms,
                    "spikes8_5To12_5ms": t.spikes_8_5_to_12_5_ms,
                    "spikesOver12_5ms": t.spikes_over_12_5_ms,
                });
                (ink, telem, Some(h.stats()))
            });

    let mut pages = pages_json(
        &s, scenes, bytes, missing, dropped, rust_ops, gpu_budget, cpu_budget, ink_val,
    );
    pages["ids"] = json!(sample);
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
        "pictures": json!({
                "files": l.files,
                "fileBytes": l.file_bytes,
                "pending": l.pending,
                "decodes": l.decodes,
                "decodeMs": l.decode_ms.round(),
                "failed": l.failed,
                "lastFailure": l.last_failure,
                "textures": host_stats.as_ref().map_or(s.pictures, |st| st.pictures),
                "textureBytes": host_stats.as_ref().map_or(s.picture_bytes, |st| st.picture_bytes),
                "budget": host_stats.as_ref().map_or(s.picture_budget, |st| st.picture_budget),
            }),
        "viewport": crate::viewport_service::status(),
        "telemetry": telemetry_val,
        "pages": pages,
    })
}

#[allow(clippy::too_many_arguments)]
fn pages_json(
    s: &Status,
    scenes: usize,
    bytes: u64,
    missing: usize,
    dropped: u64,
    rust_ops: usize,
    gpu_budget: u64,
    cpu_budget: u64,
    ink: (usize, f64, f64, f64),
) -> Value {
    let mb = |b: u64| (b as f64 / 1048576.0 * 100.0).round() / 100.0;
    let pg = &s.pages;
    json!({
            "held": scenes,
            "heldMB": mb(bytes),
            "cpuBudgetMB": mb(cpu_budget),
            "strokesKept": rust_ops,
            "dropped": dropped,
            "missing": missing,
            "onHost": pg.held,
            "resident": pg.resident,
            "gpuMB": mb(pg.gpu_bytes),
            "gpuBudgetMB": mb(gpu_budget),
            "uploads": pg.uploads,
            "evictions": pg.evictions,
            "drawn": pg.drawn,
            "drawnCapsules": pg.drawn_caps,
            "visibleMissing": pg.visible_missing,
            "inkWait": { "n": ink.0, "p50": ink.1, "p95": ink.2, "max": ink.3, "unfilled": pg.ink_unfilled },
            "inkCompleteMs": s.ink_complete_ms,
            "gpuMs": s.gpu_ms.0,
            "worstGpuMs": s.gpu_ms.1,
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
    /// The host's near / missing lists as last given to `PAGE`, its time-to-ink samples as last
    /// summed up, and whether the view was complete (every page in it with its ink).
    near_gen: u64,
    ink_samples: usize,
    complete: bool,
    created_at: f64,
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
    near_gen: u64::MAX,
    ink_samples: usize::MAX,
    complete: false,
    created_at: 0.0,
});

/// The PC's stand-in shell waits for the GPU after each frame (as a surface's next image would).
static GPU_WAIT: AtomicBool = AtomicBool::new(false);
/// The time-to-ink samples start again at the next draw (a bench's run).
static RESET_INK: AtomicBool = AtomicBool::new(false);

pub fn set_gpu_wait(on: bool) {
    GPU_WAIT.store(on, Ordering::Relaxed);
}

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
            if !USE_GL.load(Ordering::SeqCst) {
                if let Some(gpu) = fragile_vulkan_gpu() {
                    fall_back_to_gl(format!(
                        "gles chosen at start: Vulkan on {gpu} (Mali before Valhall) draws the canvas wrong"
                    ));
                }
            }
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

/// The device's Vulkan GPU when it is a Mali before Valhall (asked once per run).
///
/// 3.0.8 moved Android off GLES unless the last run ended in a native crash. On a Galaxy Tab A8
/// (Mali-G52, Android 14) the canvas then drew filled shapes black, drew strokes away from where
/// the page put them while scrolling, and the app ended a second after a note opened, with no
/// exit record that named a native crash, so it never fell back. Until 3.0.7 that tablet drew on
/// GLES and was right. Midgard and Bifrost Malis draw on GLES from the start.
#[cfg(target_os = "android")]
fn fragile_vulkan_gpu() -> Option<String> {
    static GPU: OnceLock<Option<String>> = OnceLock::new();
    GPU.get_or_init(|| {
        let vk = canvas::wgpu::Backends::VULKAN;
        let inst = canvas::wgpu::Instance::new(&canvas::wgpu::InstanceDescriptor {
            backends: vk,
            ..Default::default()
        });
        inst.enumerate_adapters(vk)
            .iter()
            .map(|a| a.get_info().name)
            .find(|name| mali_before_valhall(name))
    })
    .clone()
}

/// Midgard (Mali-T…) and Bifrost (Mali-G31, G51, G52, G71, G72, G76). Valhall and later (G57,
/// G68, G77, G78, G310, G510, G610, G710, G615, G715, G720, …) keep Vulkan.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn mali_before_valhall(name: &str) -> bool {
    let Some(rest) = name.trim().strip_prefix("Mali-") else {
        return false;
    };
    if rest.starts_with('T') {
        return true;
    }
    let Some(model) = rest.strip_prefix('G') else {
        return false;
    };
    let digits: String = model.chars().take_while(char::is_ascii_digit).collect();
    matches!(digits.as_str(), "31" | "51" | "52" | "71" | "72" | "76")
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
        Ok((mut host, name)) => {
            host.set_gpu_budget(budgets().0);
            host.set_library(library().clone());
            let backend = format!("{:?}", host.backend());
            let diag = host.diag().to_string();
            slot.host = Some(host);
            slot.size = (w, h);
            slot.fresh = true;
            slot.remake = false;
            slot.attempts = 0;
            slot.host_frames = 0;
            slot.created_at = clock_ms();
            slot.host_errors = 0;
            slot.near_gen = u64::MAX;
            slot.ink_samples = usize::MAX;
            slot.complete = false;
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

/// Waits (at most `ms`) until no picture is being decoded (tests, the PC harness's snapshot: a
/// shell draws decoded pictures at its next display frame). True when idle.
pub fn settle_pictures(ms: u64) -> bool {
    library().wait_idle(std::time::Duration::from_millis(ms))
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
    let start = clock_ms();
    TICK_PARTS.with(|p| p.set((0.0, 0.0, Default::default())));
    LOCK_MS.with(|l| l.set(0.0));
    let drawn = catch_unwind(AssertUnwindSafe(|| draw_locked(t))).unwrap_or_else(|_| {
        // Nothing drawn by a host that panicked is trusted: made again at a later tick.
        let mut slot = lock(&HOST);
        drop_host(&mut slot);
        slot.remake = slot.surface.is_some();
        slot.wait = 30;
        with_status(|s| s.attached = false);
        note_error("draw panicked".into());
        false
    });
    let (camera, upload, pace) = TICK_PARTS.with(|p| p.get());
    let lock_ms = LOCK_MS.with(|l| l.get());
    crate::viewport_service::tick_work(clock_ms() - start, camera, upload, lock_ms, pace);
    drawn
}

thread_local! {
    /// This render tick's camera step and scene uploads (ms) and its draw's pacing, for the
    /// gesture's record.
    /// This render tick's wait for the canvas's lock (ms; the page's calls hold it).
    static LOCK_MS: std::cell::Cell<f64> = const { std::cell::Cell::new(0.0) };
    static TICK_PARTS: std::cell::Cell<(f64, f64, canvas::host::Pace)> =
        const {
            std::cell::Cell::new((
                0.0,
                0.0,
                canvas::host::Pace {
                    acquire_ms: 0.0,
                    gpu_late: false,
                    drained: false,
                },
            ))
        };
}

fn draw_locked(present_ms: f64) -> bool {
    // The camera first (its own lock): advanced to the frame's time whether or not a host draws.
    let t_cam = clock_ms();
    let placed = crate::viewport_service::draw_tick(present_ms);
    let camera_ms = clock_ms() - t_cam;
    TICK_PARTS.with(|p| p.set((camera_ms, 0.0, Default::default())));
    let t_lock = clock_ms();
    let mut guard = lock(&HOST);
    LOCK_MS.with(|l| l.set(clock_ms() - t_lock));
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
    let (updates, frame, moved) = take_changes(fresh);
    let t_up = clock_ms();
    for (id, scene) in updates {
        match scene {
            Some(s) => {
                host.put_scene_arc(&id, s);
            }
            None => host.remove_scene(&id),
        }
    }
    if let Some(f) = frame {
        host.set_frame(f);
        slot.complete = false;
    }
    let upload_ms = clock_ms() - t_up;
    TICK_PARTS.with(|p| p.set((camera_ms, upload_ms, Default::default())));
    if let Some(sf) = moved {
        host.set_surface(sf);
    }
    if RESET_INK.swap(false, Ordering::Relaxed) {
        host.reset_ink_waits();
    }
    host.set_gpu_budget(budgets().0);
    // One transform for everything drawn (ADR-008): the camera's surface while Rust owns the
    // camera, else where the page drew its surface (its own numbers).
    let surface = placed.or(host.frame().surface.map(|[k, x, y]| (k, x, y)));
    if let Some((k, x, y)) = surface {
        host.place(k, x, y);
        // Casting: the viewers place the note as this frame does, on a screen of this size.
        if crate::remote_service::active() {
            crate::remote_service::broadcast_camera(k, x, y);
            let view_px = crate::viewport_service::drawn_zoom().map_or(0.0, |ez| k / ez);
            *lock(&CAST_SCREEN) = ([slot.size.0 as f32, slot.size.1 as f32], view_px as f32, [k, x, y]);
        }
    }
    host.frame_ms = crate::viewport_service::frame_ms();
    let result = host.draw();
    let pace = host.pace;
    TICK_PARTS.with(|p| p.set((camera_ms, upload_ms, pace)));
    let mut gpu_ms = None;
    if result == Ok(true) {
        crate::viewport_service::drew(host.paper_gap());
        if GPU_WAIT.load(Ordering::Relaxed) {
            gpu_ms = Some(host.wait_gpu());
        }
    }
    // What is near the view and what it misses, for the bridge (eviction) and the page.
    let gen = host.near_gen();
    if gen != slot.near_gen {
        if !crate::viewport_service::busy() {
            slot.near_gen = gen;
            note_near(host.near(), host.missing());
        } else if let Ok(mut guard) = PAGE.try_lock() {
            slot.near_gen = gen;
            let p = guard.get_or_insert_with(Default::default);
            note_near_page(p, host.near(), host.missing());
        }
    }
    let s = host.stats();
    let complete = result == Ok(true) && s.pages.visible_missing == 0 && s.pages.drawn_caps > 0;
    let became_complete = complete && !slot.complete;
    if result == Ok(true) {
        slot.complete = complete;
    }
    let errors = host.errors();
    let uncaptured = host.uncaptured_errors();
    let backend = host.backend();
    let new_errors = errors.saturating_sub(slot.host_errors);
    slot.host_errors = errors;
    if result == Ok(true) {
        slot.host_frames += 1;
    }
    let last = host.last_error();
    if slot.host_frames <= 2
        || slot.host_frames.is_multiple_of(16)
        || became_complete
        || new_errors > 0
        || result.is_err()
    {
        with_status(|st| {
            st.frames = s.frames;
            st.last_draw_ms = s.last_draw_ms;
            st.worst_draw_ms = s.worst_draw_ms;
            st.width = s.width;
            st.height = s.height;
            st.failed_frames = s.failed;
            st.skipped_frames = s.skipped_frames;
            st.skipped_pages = s.skipped_pages;
            st.pages = s.pages.clone();
            if became_complete {
                st.ink_complete_ms = ((clock_ms() - slot.created_at).max(0.0) * 100.0).round() / 100.0;
            }
            if let Some(g) = gpu_ms {
                st.gpu_ms = (g, st.gpu_ms.1.max(g));
            }
            st.pictures = s.pictures;
            st.picture_bytes = s.picture_bytes;
            st.picture_budget = s.picture_budget;
            st.errors += new_errors;
            if new_errors > 0 {
                st.error = last.clone().map(|e| format!("gpu: {e}"));
            }
        });
    }
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

/// One of the page's z-layers as `canvasSceneBin` sends them (rustCore.ts `setCanvasScene`): the
/// next `n` strokes as one ink layer, or a picture (zorder.ts).
#[derive(Deserialize)]
#[serde(untagged)]
enum ZLayer {
    Ink { n: usize },
    Image { img: ZImage },
}

/// A picture's block (Blocks.tsx `ImageBlockView`): its file's key, box, rotation (degrees,
/// clockwise); crop (u0, v0, u1, v1), flips and opacity when given. A number sent as null (NaN on
/// the page) leaves the picture out.
#[derive(Deserialize)]
struct ZImage {
    k: u64,
    x: Option<f32>,
    y: Option<f32>,
    w: Option<f32>,
    h: Option<f32>,
    #[serde(default)]
    r: Option<f32>,
    #[serde(default)]
    crop: Option<[f32; 4]>,
    #[serde(default)]
    fh: bool,
    #[serde(default)]
    fv: bool,
    #[serde(default)]
    o: Option<f32>,
}

impl ZImage {
    fn item(&self) -> Option<ImageItem> {
        let mut it = ImageItem::new(self.k, self.x?, self.y?, self.w?, self.h?);
        it.rotation = self.r.unwrap_or(0.0);
        it.crop = self.crop.unwrap_or(it.crop);
        it.flip_h = self.fh;
        it.flip_v = self.fv;
        it.opacity = self.o.unwrap_or(1.0);
        Some(it)
    }
}

/// The scene of a page's strokes (their ops, in z-order) and pictures: `z` the layers (None: the
/// strokes as one layer).
fn scene_of(ops: &PageOps, z: Option<&[ZLayer]>) -> Result<Scene, String> {
    let all: Vec<&[renderer::builder::RenderOp]> = ops.iter().map(|(_, o)| o.as_slice()).collect();
    let Some(z) = z else {
        return Ok(Scene::from_ops(&[all]));
    };
    let mut at = 0;
    let mut layers = Vec::with_capacity(z.len());
    for l in z {
        match l {
            ZLayer::Ink { n } => {
                let end = at + n;
                if end > all.len() {
                    return Err(format!("layers of {end} strokes, {} sent", all.len()));
                }
                layers.push(OpsLayer::Ink(all[at..end].to_vec()));
                at = end;
            }
            ZLayer::Image { img } => {
                if let Some(it) = img.item() {
                    layers.push(OpsLayer::Image(it));
                }
            }
        }
    }
    if at != all.len() {
        return Err(format!("layers of {at} strokes, {} sent", all.len()));
    }
    Ok(Scene::from_layers(&layers))
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
/// sends them all). No strokes: the page's scene goes, unless `keep` (a sheet without ink: known
/// empty, nothing to ask for). The reply's `dropped`: scenes that went for memory meanwhile
/// (ADR-007; the page sends them again when they come near).
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
        #[serde(default)]
        keep: bool,
        #[serde(default)]
        z: Option<Vec<ZLayer>>,
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
    let pictures: Vec<u64> =
        r.z.iter()
            .flatten()
            .filter_map(|l| match l {
                ZLayer::Image { img } => Some(img.k),
                _ => None,
            })
            .collect();
    if r.strokes.is_empty() && pictures.is_empty() {
        let mut ops = lock(&SCENE_OPS);
        let map = ops.get_or_insert_with(Default::default);
        if r.keep {
            map.insert(r.page.clone(), Vec::new());
        } else {
            map.remove(&r.page);
        }
        drop(ops);
        put_scene(&r.page, r.keep.then(Scene::default));
        collect_pictures();
        let attached = attached();
        return Ok((json!({ "ok": attached, "capsules": 0, "attached": attached, "strokes": 0, "built": 0, "dropped": [] }).to_string(), Vec::new()));
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
    let scene = scene_of(&ops, r.z.as_deref())?;
    let strokes = ops.len();
    // Pictures whose file the canvas does not hold: the page sends them (`canvasImage`); the scene
    // shows them once they come.
    let lib = library();
    let missing_images: Vec<u64> = pictures.into_iter().filter(|k| !lib.contains(*k)).collect();
    let count = scene.caps.len();
    lock(&SCENE_OPS)
        .get_or_insert_with(Default::default)
        .insert(r.page.clone(), ops);
    put_scene(&r.page, Some(scene));
    let dropped = evict_for_memory(&r.page);
    let attached = attached();
    Ok((json!({ "ok": attached, "capsules": count, "attached": attached, "strokes": strokes, "built": built, "dropped": dropped, "missingImages": missing_images }).to_string(), Vec::new()))
}

/// `canvasImage`: a picture's file (meta `{ key }`, data the block's data URL as UTF-8, or the
/// file's bytes), kept by the page's key; identical files once. Nothing is decoded here: the
/// render thread asks for it at the size the zoom needs when it comes into view (crates/canvas
/// picture.rs). Replies its size and kind.
pub fn canvas_image(meta: &str, data: &[u8]) -> Result<(String, Vec<u8>), String> {
    #[derive(Deserialize)]
    struct Req {
        key: u64,
    }
    let r: Req = serde_json::from_str(meta).map_err(|e| format!("canvasImage request: {e}"))?;
    let src = library().insert(r.key, data)?;
    Ok((
        json!({
            "ok": true,
            "width": src.width,
            "height": src.height,
            "svg": src.kind == canvas::picture::Kind::Svg,
        })
        .to_string(),
        Vec::new(),
    ))
}

/// `canvasImageStatus`: of the page's picture keys (meta `{ keys }`), those the canvas has
/// decoded (`ready`: the page may hide its own `<img>`) and those it cannot decode (`failed`: the
/// page keeps drawing them), the others still on their way.
pub fn canvas_image_status(meta: &str) -> Result<(String, Vec<u8>), String> {
    #[derive(Deserialize)]
    struct Req {
        keys: Vec<u64>,
    }
    let r: Req =
        serde_json::from_str(meta).map_err(|e| format!("canvasImageStatus request: {e}"))?;
    let lib = library();
    let (mut ready, mut failed, mut missing) = (Vec::new(), Vec::new(), Vec::new());
    for k in r.keys {
        match lib.source(k).map(|s| lib.decodable(s.id)) {
            None => missing.push(k),
            Some(Some(true)) => ready.push(k),
            Some(Some(false)) => failed.push(k),
            Some(None) => {}
        }
    }
    Ok((
        json!({ "ready": ready, "failed": failed, "missing": missing }).to_string(),
        Vec::new(),
    ))
}

/// `canvasForget`: the scenes of `ids`, or of every id starting with `prefix` (a note's sheets,
/// `prefix:sheet`), go with their strokes' ops (the note closed; sheets changed far from view).
pub fn canvas_forget(meta: &str) -> Result<(String, Vec<u8>), String> {
    #[derive(Deserialize)]
    struct Req {
        #[serde(default)]
        prefix: Option<String>,
        #[serde(default)]
        ids: Vec<String>,
    }
    let r: Req = serde_json::from_str(meta).map_err(|e| format!("canvasForget request: {e}"))?;
    let gone = with_page(|p| {
        let mut ids: Vec<String> = r.ids.clone();
        if let Some(pre) = &r.prefix {
            let pre = format!("{pre}:");
            ids.extend(p.scenes.keys().filter(|k| k.starts_with(&pre)).cloned());
        }
        let mut gone = Vec::new();
        for id in ids {
            if let Some(h) = p.scenes.remove(&id) {
                p.bytes -= h.bytes;
                p.changed.insert(id.clone());
                p.near_at.remove(&id);
                gone.push(id);
            }
        }
        gone
    });
    {
        let mut ops = lock(&SCENE_OPS);
        let map = ops.get_or_insert_with(Default::default);
        for id in &r.ids {
            map.remove(id);
        }
        if let Some(pre) = &r.prefix {
            let pre = format!("{pre}:");
            map.retain(|k, _| !k.starts_with(&pre));
        }
    }
    Ok((
        json!({ "ok": true, "forgotten": gone.len() }).to_string(),
        Vec::new(),
    ))
}

/// `canvasBudget`: the memory budgets in MB (`gpuMB`, `cpuMB`; 0 or absent: from the device).
/// For the bench and tests: the budgets are otherwise the device's.
pub fn canvas_budget(meta: &str) -> Result<(String, Vec<u8>), String> {
    #[derive(Deserialize)]
    struct Req {
        #[serde(default, rename = "gpuMB")]
        gpu_mb: f64,
        #[serde(default, rename = "cpuMB")]
        cpu_mb: f64,
    }
    let r: Req = serde_json::from_str(meta).map_err(|e| format!("canvasBudget request: {e}"))?;
    let b = |mb: f64| {
        if mb.is_finite() && mb > 0.0 {
            (mb * 1048576.0) as u64
        } else {
            0
        }
    };
    GPU_BUDGET.store(b(r.gpu_mb), Ordering::Relaxed);
    CPU_BUDGET.store(b(r.cpu_mb), Ordering::Relaxed);
    let dropped = evict_for_memory("");
    let (g, c) = budgets();
    Ok((json!({ "ok": true, "gpuMB": g as f64 / 1048576.0, "cpuMB": c as f64 / 1048576.0, "dropped": dropped }).to_string(), Vec::new()))
}

/// `canvasFrame`: where the page shows its pages (crates/canvas `FrameSpec::parse`). With `keep`,
/// the surface alone moved (`{ surface, keep: true }`): the frame is otherwise the last one.
pub fn canvas_frame(meta: &str) -> Result<(String, Vec<u8>), String> {
    #[derive(Deserialize)]
    struct Moved {
        keep: bool,
        surface: [f64; 3],
    }
    if let Ok(m) = serde_json::from_str::<Moved>(meta) {
        if m.keep {
            let ok = m.surface.iter().all(|v| v.is_finite()) && m.surface[0] > 0.0;
            let had = ok
                && with_page(|p| match p.frame.as_mut() {
                    Some(f) => {
                        f.surface = Some(m.surface);
                        p.surface = Some(m.surface);
                        true
                    }
                    None => false,
                });
            let attached = attached();
            return Ok((
                json!({ "ok": attached && had, "attached": attached, "frame": had }).to_string(),
                Vec::new(),
            ));
        }
    }
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

/// `canvasStats` (`{ resetInk: true }`: the time-to-ink samples start again).
pub fn canvas_stats(meta: &str) -> Result<(String, Vec<u8>), String> {
    #[derive(Deserialize, Default)]
    #[serde(rename_all = "camelCase")]
    struct Req {
        #[serde(default)]
        reset_ink: bool,
    }
    let r: Req = serde_json::from_str(meta).unwrap_or_default();
    if r.reset_ink {
        RESET_INK.store(true, Ordering::Relaxed);
        with_status(|s| s.ink = (0, f64::NAN, f64::NAN, f64::NAN));
    }
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
            bx: None,
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

#[cfg(test)]
mod tests {
    use super::mali_before_valhall;

    #[test]
    fn midgard_and_bifrost_malis_draw_on_gles() {
        for name in ["Mali-G52", "Mali-G52 MC2", "Mali-G76", "Mali-G31", "Mali-T880", " Mali-G72 "] {
            assert!(mali_before_valhall(name), "{name}");
        }
        for name in [
            "Mali-G57", "Mali-G68", "Mali-G78", "Mali-G510", "Mali-G610", "Mali-G710", "Mali-G715",
            "Mali-G720", "Adreno (TM) 619", "PowerVR B-Series", "Mali-G5", "",
        ] {
            assert!(!mali_before_valhall(name), "{name}");
        }
    }
}
