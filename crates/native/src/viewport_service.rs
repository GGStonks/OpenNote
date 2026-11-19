//! The note's camera while the native canvas draws it (rust/DECISIONS.md ADR-006,
//! docs/rust-native-canvas.md N5): one `viewport::Viewport` beside the page's scenes.
//!
//! - The shells hand it fingers as they arrive (`opennote_viewport_touch`, Android
//!   `viewportTouch`: iOS main thread, Android UI thread); only touches that start over the
//!   note (`Layout::accepts`) are taken, and the camera moves only once two fingers are down.
//! - The render thread (`canvas_service::draw_active`, at the display's rate) advances it
//!   (`draw_tick`) and places the page's last frame at its camera, so ink follows the fingers
//!   with no page round trip.
//! - The page sends its layout and its own views (`viewportLayout`, `viewportSet`), reads the
//!   camera (`viewportCamera`) or is sent it (`opennote_viewport_poll` after each drawn tick,
//!   which the shells evaluate in the page: at most once per page frame), and mirrors it.
//! - Each gesture's frames go to the page's crash report as a `pinch` entry (`gl: 'rust'`) and
//!   to `canvasStats`.
//!
//! `VIEW` is a lock of its own, held only for the arithmetic: a touch never waits for a draw.

use crate::clock_ms;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::{Mutex, MutexGuard};
use viewport::{
    Anchor, FitMode, GestureRecorder, GestureSummary, Layout, Phase, SavedView, Viewport,
};

struct View {
    vp: Viewport,
    /// The gesture being recorded, and those the page has not read yet.
    rec: Option<GestureRecorder>,
    unread: VecDeque<GestureSummary>,
    last: Option<GestureSummary>,
    gestures: u64,
    /// The display's best rate (the shell's), for the record.
    hz: f64,
    /// What the shell's push last delivered.
    pushed_seq: u64,
    pushed_at: f64,
}

static VIEW: Mutex<Option<View>> = Mutex::new(None);

fn view() -> MutexGuard<'static, Option<View>> {
    VIEW.lock().unwrap_or_else(|e| e.into_inner())
}

fn with_view<R>(f: impl FnOnce(&mut View) -> R) -> R {
    f(view().get_or_insert_with(|| View {
        vp: Viewport::new(),
        rec: None,
        unread: VecDeque::new(),
        last: None,
        gestures: 0,
        hz: 0.0,
        pushed_seq: 0,
        pushed_at: f64::NEG_INFINITY,
    }))
}

/// Rust places the canvas and takes fingers: the page said so and the canvas is drawing.
fn owned(v: &View) -> bool {
    v.vp.has_layout() && v.vp.layout().owned
}

/// A finger from the shell: `id` its own, `phase` 0 began, 1 moved, 2 ended, 3 cancelled,
/// (x, y) web view CSS px. True when the camera holds it.
pub fn touch(id: i64, phase: i32, x: f64, y: f64) -> bool {
    let Some(phase) = Phase::from_code(phase) else {
        return false;
    };
    let t = clock_ms() / 1000.0;
    with_view(|v| {
        if phase == Phase::Began && !(owned(v) && v.vp.layout().accepts(x, y)) {
            return false;
        }
        let before = v.vp.fingers();
        let [vx, vy, _, _] = v.vp.layout().view;
        v.vp.touch(id, phase, x - vx, y - vy, t);
        before > 0 || v.vp.fingers() > 0
    })
}

/// The display's best rate (Hz), from the shell.
pub fn set_display_hz(hz: f64) {
    if hz.is_finite() && hz > 0.0 {
        with_view(|v| v.hz = hz);
    }
}

/// The render thread, each display frame: the camera advanced to `now_ms`; where the page's
/// surface is now (device px scale and corner), or None when the page places the canvas itself.
pub(crate) fn draw_tick(now_ms: f64) -> Option<(f64, f64, f64)> {
    with_view(|v| {
        if !owned(v) {
            finish(v, now_ms);
            return None;
        }
        v.vp.tick(now_ms / 1000.0);
        if v.vp.gesture() && v.rec.is_none() {
            v.rec = Some(GestureRecorder::new(
                now_ms,
                v.vp.camera().ez,
                v.vp.events,
                v.vp.rebases,
                v.hz,
            ));
        }
        if let Some(r) = v.rec.as_mut() {
            r.tick(now_ms, false);
            if v.vp.gliding() {
                r.glided();
            }
        }
        if !v.vp.busy() {
            finish(v, now_ms);
        }
        Some(v.vp.surface_device())
    })
}

/// The tick's frame was drawn.
pub(crate) fn drew() {
    with_view(|v| {
        if let Some(r) = v.rec.as_mut() {
            r.drew();
        }
    });
}

fn finish(v: &mut View, now_ms: f64) {
    if let Some(r) = v.rec.take() {
        v.gestures += 1;
        let s = r.finish(
            v.gestures,
            now_ms,
            v.vp.camera().zoom,
            v.vp.events,
            v.vp.rebases,
        );
        v.last = Some(s.clone());
        v.unread.push_back(s);
        while v.unread.len() > 16 {
            v.unread.pop_front();
        }
    }
}

fn camera_value(v: &mut View) -> Value {
    camera_value_with(v, true)
}

/// The camera for the page; `take_log`: the gestures recorded since are handed over (once).
fn camera_value_with(v: &mut View, take_log: bool) -> Value {
    let log: Vec<GestureSummary> = if take_log {
        v.unread.drain(..).collect()
    } else {
        Vec::new()
    };
    json!({
        "owned": owned(v),
        "camera": v.vp.camera(),
        "view": v.vp.view_state(),
        "page": v.vp.current_sheet(),
        "fingers": v.vp.fingers(),
        "log": log,
    })
}

/// The shells, after each tick: the camera for the page when it changed and the page's frame
/// interval has passed since the last push (`window.__opennoteCamera(...)`), else None.
pub fn poll(now_ms: f64) -> Option<String> {
    with_view(|v| {
        if !owned(v) && v.unread.is_empty() {
            return None;
        }
        let seq = v.vp.camera().seq;
        let gap = v.vp.layout().frame_ms.clamp(4.0, 100.0) * 0.8;
        if (seq == v.pushed_seq && v.unread.is_empty()) || now_ms - v.pushed_at < gap {
            return None;
        }
        v.pushed_seq = seq;
        v.pushed_at = now_ms;
        Some(camera_value(v).to_string())
    })
}

/// `canvasStats`' viewport part.
pub fn status() -> Value {
    with_view(|v| {
        json!({
            "owned": owned(v),
            "hz": v.hz,
            "gestures": v.gestures,
            "last": v.last,
            "camera": v.vp.camera(),
        })
    })
}

// ------------------------------------------------------------------------------------------------
// The page's bridge methods.

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Adopt {
    zoom: f64,
    sl: f64,
    st: f64,
    #[serde(default)]
    sub: [f64; 2],
    fit: Option<FitMode>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LayoutReq {
    layout: Layout,
    /// The page's camera as it is: taken when Rust starts owning the note's camera.
    adopt: Option<Adopt>,
}

/// `viewportLayout`: the page's layout (and, taking over, its camera).
pub fn viewport_layout(meta: &str) -> Result<(String, Vec<u8>), String> {
    let req: LayoutReq = serde_json::from_str(meta).map_err(|e| format!("viewportLayout: {e}"))?;
    let out = with_view(|v| {
        let was = owned(v);
        v.vp.set_layout(req.layout);
        if let Some(a) = req.adopt {
            if !was || !v.vp.busy() {
                v.vp.adopt(a.zoom, a.sl, a.st, (a.sub[0], a.sub[1]), a.fit);
            }
        }
        camera_value(v)
    });
    Ok((out.to_string(), Vec::new()))
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum SetReq {
    FitWidth {
        target: Option<[f64; 2]>,
    },
    ZoomToRect {
        rect: [f64; 4],
    },
    Restore {
        view: SavedView,
        target: Option<[f64; 2]>,
    },
    ZoomBy {
        f: f64,
    },
    ZoomAt {
        f: f64,
        sx: f64,
        sy: f64,
    },
    SetView {
        z: f64,
        anchor: Option<[f64; 4]>,
        floor: Option<f64>,
    },
    Scroll {
        sl: f64,
        st: f64,
        #[serde(default)]
        dsl: f64,
        #[serde(default)]
        dst: f64,
    },
    ScrollTo {
        y: f64,
        #[serde(default)]
        smooth: bool,
    },
    Pull {
        d: f64,
        #[serde(default)]
        animate: bool,
    },
    Stop,
}

/// `viewportSet`: a camera change the page makes (fit to width, a saved view, a page, zooming by
/// the keyboard or the wheel, its own scroll, its own pull). Replies the camera.
pub fn viewport_set(meta: &str) -> Result<(String, Vec<u8>), String> {
    let req: SetReq = serde_json::from_str(meta).map_err(|e| format!("viewportSet: {e}"))?;
    let t = clock_ms() / 1000.0;
    let out = with_view(|v| {
        let vp = &mut v.vp;
        let pair = |a: Option<[f64; 2]>| a.map(|[l, w]| (l, w));
        match req {
            SetReq::FitWidth { target } => vp.fit_width(pair(target)),
            SetReq::ZoomToRect { rect } => vp.zoom_to_rect(rect),
            SetReq::Restore { view, target } => vp.restore(view, pair(target)),
            SetReq::ZoomBy { f } => vp.zoom_by(f),
            SetReq::ZoomAt { f, sx, sy } => vp.zoom_at(f, sx, sy),
            SetReq::SetView { z, anchor, floor } => vp.set_view(
                z,
                anchor.map(|[cx, cy, sx, sy]| Anchor { cx, cy, sx, sy }),
                floor.unwrap_or(f64::INFINITY),
            ),
            SetReq::Scroll { sl, st, dsl, dst } => vp.page_scroll(sl, st, dsl, dst),
            SetReq::ScrollTo { y, smooth } => vp.scroll_to(y, smooth, t),
            SetReq::Pull { d, animate } => vp.page_pull(d, animate, t),
            SetReq::Stop => vp.stop(),
        }
        camera_value(v)
    });
    Ok((out.to_string(), Vec::new()))
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct CameraReq {
    /// Leave the gestures' log for the page (an observer: the PC's bench).
    keep: bool,
    /// Add the layout the page sent.
    layout: bool,
}

/// `viewportCamera`: the camera now, and the gestures recorded since the last read.
pub fn viewport_camera(meta: &str) -> Result<(String, Vec<u8>), String> {
    let req: CameraReq = serde_json::from_str(meta).unwrap_or_default();
    let out = with_view(|v| {
        let mut out = camera_value_with(v, !req.keep);
        if req.layout {
            out["layout"] = serde_json::to_value(v.vp.layout()).unwrap_or(Value::Null);
        }
        out
    });
    Ok((out.to_string(), Vec::new()))
}

#[derive(Deserialize)]
struct TouchReq {
    /// [id, phase, x, y] (web view CSS px), as a shell sends them one by one.
    touches: Vec<[f64; 4]>,
}

/// `viewportTouch`: fingers through the bridge (the PC's stand-in shell, tests).
pub fn viewport_touch(meta: &str) -> Result<(String, Vec<u8>), String> {
    let req: TouchReq = serde_json::from_str(meta).map_err(|e| format!("viewportTouch: {e}"))?;
    let taken: Vec<bool> = req
        .touches
        .iter()
        .map(|t| touch(t[0] as i64, t[1] as i32, t[2], t[3]))
        .collect();
    Ok((json!({ "taken": taken }).to_string(), Vec::new()))
}

/// Tests: back to a new camera.
pub fn reset() {
    *view() = None;
}

// ------------------------------------------------------------------------------------------------
// The shells' C ABI (iOS; Android's JNI functions in lib.rs call the same).

/// A finger (see [`touch`]). Main thread; returns at once.
#[no_mangle]
pub extern "C" fn opennote_viewport_touch(id: i64, phase: i32, x: f64, y: f64) -> bool {
    std::panic::catch_unwind(|| touch(id, phase, x, y)).unwrap_or(false)
}

/// The display's best rate (Hz).
#[no_mangle]
pub extern "C" fn opennote_viewport_display_hz(hz: f64) {
    let _ = std::panic::catch_unwind(|| set_display_hz(hz));
}

/// The camera for the page when it is due (see [`poll`]): a C string the caller frees with
/// `opennote_viewport_free`, or null.
#[no_mangle]
pub extern "C" fn opennote_viewport_poll() -> *mut std::ffi::c_char {
    std::panic::catch_unwind(|| poll(clock_ms()))
        .ok()
        .flatten()
        .and_then(|s| std::ffi::CString::new(s).ok())
        .map_or(std::ptr::null_mut(), std::ffi::CString::into_raw)
}

/// Frees what `opennote_viewport_poll` returned.
///
/// # Safety
/// `p` must come from `opennote_viewport_poll` and be freed once.
#[no_mangle]
pub unsafe extern "C" fn opennote_viewport_free(p: *mut std::ffi::c_char) {
    if !p.is_null() {
        drop(std::ffi::CString::from_raw(p));
    }
}
