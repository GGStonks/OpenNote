//! The note's camera while the native canvas draws it (rust/DECISIONS.md ADR-006, ADR-008,
//! docs/rust-native-canvas.md N5): one `viewport::Viewport` beside the page's scenes.
//!
//! - The shells hand it fingers as they arrive, each with its own time (`opennote_viewport_touches`,
//!   Android `viewportTouches`: the event's timestamp and its coalesced / historical samples, on
//!   the shells' clock, `clock_ms`); only touches that start over the note (`Layout::accepts`, in
//!   the page's client px) are taken, and the camera moves only once two fingers are down.
//! - The render thread (`canvas_service::draw_at`, at the display's rate) advances it to the
//!   frame's presentation time (`draw_tick`): the fingers are resampled at a fixed time before it
//!   (interpolated between their samples, a little extrapolated when the next is late), so the
//!   delivery's jitter never reaches the camera.
//! - One piece (ADR-008): the canvas draws the camera the page's DOM shows (the page reports the
//!   camera it put on its DOM, `viewportShown`), so text, formulas, the selection and the ink move
//!   together: the canvas draws the camera as far back as the DOM trails it (smoothed, so it moves
//!   as evenly as the camera); a DOM that stops reporting is not waited for (the trail, at most
//!   `lag_max`, is kept and the canvas goes on: no jump either way).
//! - The page sends its layout and its own views (`viewportLayout`, `viewportSet`), reads the
//!   camera (`viewportCamera`) or is sent it (`opennote_viewport_poll` after each drawn tick, which
//!   the shells evaluate in the page, one at a time), and mirrors it.
//! - Each gesture's frames go to the page's crash report as a `pinch` entry (`gl: 'rust'`) and
//!   to `canvasStats`.
//!
//! `VIEW` is a lock of its own, held only for the arithmetic: a touch never waits for a draw. The
//! tick allocates nothing: the queue, the fingers and the camera's history are made once.

use crate::clock_ms;
use crate::one_euro::OneEuroFilter;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::{Mutex, MutexGuard};
use viewport::{
    Anchor, FitMode, GestureRecorder, GestureSummary, Layout, Phase, SavedView, Viewport,
};

/// The fingers are resampled this long before the frame's presentation time: the moment the
/// tick runs at 120 Hz (Android resamples 5 ms before its frame time).
pub const RESAMPLE_MS: f64 = 8.0;
/// How far past its last sample a finger is extrapolated when the next is late (delivered up to a
/// frame late, as the main thread allows): at most two of its sampling intervals. A finger with no
/// sample for longer has stopped (iOS sends nothing for a finger that stands still) and is held
/// where it was.
pub const PREDICT_MAX_MS: f64 = 17.0;
/// The least time between a finger's two samples to extrapolate from them.
const MIN_SAMPLE_MS: f64 = 2.0;
/// Cameras kept to place the one the page's DOM shows (0.5 s at 120 Hz).
const HISTORY: usize = 64;
const QUEUE: usize = 512;
const FINGERS: usize = 10;
/// Ticks kept for the bench (`viewportTrace`), only while it asks.
const TRACE: usize = 8192;

#[derive(Clone, Copy, Debug)]
struct Sample {
    id: i64,
    phase: Phase,
    /// View px (the page's client px less the scroll view's corner).
    x: f64,
    y: f64,
    t: f64,
}

#[derive(Clone, Copy, Debug, Default)]
struct Finger {
    id: i64,
    /// The last position fed to the camera (a real or a resampled one) and its time.
    fed: (f64, f64, f64),
    /// The last two real samples.
    prev: (f64, f64, f64),
    last: (f64, f64, f64),
}

#[derive(Clone, Copy, Debug, Default)]
struct CamRec {
    seq: u64,
    t: f64,
    x: f64,
    y: f64,
    ez: f64,
}

/// One tick, for the bench (`--only cameracoherence`).
#[derive(Clone, Copy, Debug, Default)]
pub struct TraceRec {
    /// The frame's presentation time (ms, the shells' clock).
    pub t: f64,
    /// The newest camera: seq and corner / scale (view px).
    pub seq: u64,
    pub x: f64,
    pub y: f64,
    pub ez: f64,
    /// The camera drawn: its time, the seq the page said its DOM shows, corner / scale.
    pub drawn_t: f64,
    pub shown: u64,
    pub dx: f64,
    pub dy: f64,
    pub dez: f64,
    /// The surface's placement drawn (device px: scale, left, top).
    pub k: f64,
    pub sx: f64,
    pub sy: f64,
    /// The page point first under the fingers against where the newest camera puts it, from the
    /// fingers' resampled centre (view px; NaN without two fingers).
    pub under: f64,
    /// The largest gap between a sheet's paper and the ink's transform (device px, as drawn).
    pub ink_paper: f64,
    /// The canvas went on without the DOM (too far behind).
    pub alone: bool,
    pub fingers: usize,
}

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
    /// The canvas's missing pages as last pushed (their generation).
    pushed_missing: u64,
    /// Fingers waiting for their time, and the ids taken (Began accepted, not yet ended).
    queue: VecDeque<Sample>,
    held: Vec<i64>,
    fingers: Vec<Finger>,
    /// The newest cameras, by tick (a ring).
    hist: [CamRec; HISTORY],
    hist_n: usize,
    hist_head: usize,
    /// The camera the page's DOM shows (`viewportShown`) and when that arrived.
    shown: Option<(u64, f64)>,
    /// The last tick: its presentation time and the camera time it drew.
    tick_t: f64,
    drawn_t: f64,
    /// The page point under the fingers when two came down (content px at zoom 1), and how many.
    probe: Option<(f64, f64, usize)>,
    trace: Option<Vec<TraceRec>>,
    /// The display link (shell): its interval and lead (ms); when the camera last changed.
    link: (f64, f64),
    moved_at: f64,
    /// The DOM's trail behind the newest camera (ms, smoothed) and the seq last seen shown.
    trail: f64,
    last_shown: Option<u64>,
    filter_x: OneEuroFilter,
    filter_y: OneEuroFilter,
    filter_ln_ez: OneEuroFilter,
    filter_converging: bool,
    filter_last_t: Option<f64>,
    pub filtered_cam: Option<(f64, f64, f64)>,
}

impl View {
    fn reset_filters(&mut self) {
        self.filter_x.reset();
        self.filter_y.reset();
        self.filter_ln_ez.reset();
        self.filter_converging = false;
        self.filter_last_t = None;
        self.filtered_cam = None;
    }
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
        pushed_missing: 0,
        queue: VecDeque::with_capacity(QUEUE),
        held: Vec::with_capacity(FINGERS),
        fingers: Vec::with_capacity(FINGERS),
        hist: [CamRec::default(); HISTORY],
        hist_n: 0,
        hist_head: 0,
        shown: None,
        tick_t: f64::NEG_INFINITY,
        drawn_t: f64::NEG_INFINITY,
        probe: None,
        trace: None,
        link: (0.0, 0.0),
        moved_at: f64::NEG_INFINITY,
        trail: f64::NAN,
        last_shown: None,
        filter_x: OneEuroFilter::new(8.0, 0.18, 15.0),
        filter_y: OneEuroFilter::new(8.0, 0.18, 15.0),
        filter_ln_ez: OneEuroFilter::new(7.0, 0.25, 15.0),
        filter_converging: false,
        filter_last_t: None,
        filtered_cam: None,
    }))
}

/// Rust places the canvas and takes fingers: the page said so and the canvas is drawing.
fn owned(v: &View) -> bool {
    v.vp.has_layout() && v.vp.layout().owned
}

fn legacy(v: &View) -> bool {
    v.vp.layout().legacy
}

// ------------------------------------------------------------------------------------------------
// The fingers.

/// A finger from the shell: `id` its own, `phase` 0 began, 1 moved, 2 ended, 3 cancelled,
/// (x, y) web view points, `t_ms` its own time on the shells' clock (None: now). True when the
/// camera holds it.
pub fn touch(id: i64, phase: i32, x: f64, y: f64, t_ms: Option<f64>) -> bool {
    let Some(phase) = Phase::from_code(phase) else {
        return false;
    };
    if !(x.is_finite() && y.is_finite()) {
        return false;
    }
    let now = clock_ms();
    with_view(|v| {
        let l = v.vp.layout();
        let (cx, cy) = l.client_of_web(x, y);
        let held = v.held.contains(&id);
        match phase {
            Phase::Began if !held => {
                if !(owned(v) && l.accepts(cx, cy)) || v.held.len() >= FINGERS {
                    return false;
                }
                v.held.push(id);
            }
            Phase::Began | Phase::Moved => {
                if !held {
                    return false;
                }
            }
            Phase::Ended | Phase::Cancelled => {
                if !held {
                    return false;
                }
                v.held.retain(|h| *h != id);
            }
        }
        let [vx, vy, _, _] = l.view;
        let s = Sample {
            id,
            phase,
            x: cx - vx,
            y: cy - vy,
            // A time from the future (another clock) or far past is not the event's.
            t: t_ms
                .filter(|t| t.is_finite() && *t <= now + 50.0 && *t > now - 1000.0)
                .unwrap_or(now),
        };
        if legacy(v) {
            // 2.9.6: each finger as it arrives, stamped then.
            feed(v, Sample { t: now, ..s });
        } else {
            if v.queue.len() >= QUEUE {
                if let Some(old) = v.queue.pop_front() {
                    feed(v, old);
                }
            }
            v.queue.push_back(s);
        }
        true
    })
}

/// One sample into the camera; the fingers' records follow it.
fn feed(v: &mut View, s: Sample) {
    let i = v.fingers.iter().position(|f| f.id == s.id);
    // Never back in time (a sample delivered after a resampled one past it).
    let t = i.map_or(s.t, |i| s.t.max(v.fingers[i].fed.2));
    v.vp.touch(s.id, s.phase, s.x, s.y, t / 1000.0);
    let p = (s.x, s.y, t);
    // The real samples keep their own times (the finger's velocity).
    let real = (s.x, s.y, s.t);
    match (s.phase, i) {
        (Phase::Began, None) => {
            if v.fingers.len() < FINGERS {
                v.fingers.push(Finger {
                    id: s.id,
                    fed: p,
                    prev: real,
                    last: real,
                });
            }
        }
        (Phase::Began | Phase::Moved, Some(i)) => {
            let f = &mut v.fingers[i];
            if real.2 > f.last.2 {
                f.prev = f.last;
                f.last = real;
            }
            f.fed = p;
        }
        (Phase::Ended | Phase::Cancelled, Some(i)) => {
            v.fingers.remove(i);
        }
        _ => {}
    }
}

/// Every sample due by `upto` into the camera, then, with `resample`, each finger still down
/// placed at `upto` itself: between its last sample and the next (queued) one, or a little past
/// its last when the next is late.
fn process(v: &mut View, upto: f64, resample: bool) {
    while v.queue.front().is_some_and(|s| s.t <= upto) {
        if let Some(s) = v.queue.pop_front() {
            feed(v, s);
        }
    }
    if !resample {
        return;
    }
    for i in 0..v.fingers.len() {
        let f = v.fingers[i];
        if f.fed.2 >= upto {
            continue;
        }
        let next = v.queue.iter().find(|s| s.id == f.id).copied();
        let at = match next {
            Some(n) if n.phase == Phase::Moved && n.t > f.fed.2 => {
                let u = ((upto - f.fed.2) / (n.t - f.fed.2)).clamp(0.0, 1.0);
                Some((
                    f.fed.0 + (n.x - f.fed.0) * u,
                    f.fed.1 + (n.y - f.fed.1) * u,
                    upto,
                ))
            }
            Some(_) => None,
            None => {
                let dt = f.last.2 - f.prev.2;
                let gap = upto - f.last.2;
                // Two samples a sampling interval apart (coalesced ones closer say little of
                // the speed), recent enough.
                if dt >= MIN_SAMPLE_MS && gap > 0.0 && gap <= 3.0 * dt {
                    let dist = (f.last.0 - f.prev.0).hypot(f.last.1 - f.prev.1);
                    let v_ms = dist / dt; // px/ms
                    let extrap_weight = if v_ms < 0.06 {
                        0.0
                    } else if v_ms < 0.25 {
                        let t = (v_ms - 0.06) / (0.25 - 0.06);
                        t * t * (3.0 - 2.0 * t)
                    } else {
                        1.0
                    };
                    if extrap_weight > 0.0 {
                        let tp = upto.min(f.last.2 + PREDICT_MAX_MS.min(2.0 * dt));
                        (tp > f.fed.2).then(|| {
                            let u = ((tp - f.last.2) / dt) * extrap_weight;
                            (
                                f.last.0 + (f.last.0 - f.prev.0) * u,
                                f.last.1 + (f.last.1 - f.prev.1) * u,
                                tp,
                            )
                        })
                    } else {
                        None
                    }
                } else {
                    None
                }
            }
        };
        if let Some((x, y, t)) = at {
            v.vp.resampled = true;
            v.vp.touch(f.id, Phase::Moved, x, y, t / 1000.0);
            v.vp.resampled = false;
            v.fingers[i].fed = (x, y, t);
        }
    }
}

/// Every finger waiting, now (a read of the camera outside the ticks).
fn flush(v: &mut View) {
    process(v, f64::INFINITY, false);
}

/// The display's best rate (Hz), from the shell.
pub fn set_display_hz(hz: f64) {
    if hz.is_finite() && hz > 0.0 {
        with_view(|v| v.hz = hz);
    }
}

// ------------------------------------------------------------------------------------------------
// The ticks.

fn hist_push(v: &mut View, c: CamRec) {
    v.hist_head = (v.hist_head + 1) % HISTORY;
    v.hist[v.hist_head] = c;
    v.hist_n = (v.hist_n + 1).min(HISTORY);
}

/// The i-th newest camera (0: the newest).
fn hist_get(v: &View, i: usize) -> Option<CamRec> {
    (i < v.hist_n).then(|| v.hist[(v.hist_head + HISTORY - i) % HISTORY])
}

/// The camera at time `t` from the history (linear between ticks).
fn hist_at(v: &View, t: f64) -> Option<CamRec> {
    let newest = hist_get(v, 0)?;
    if t >= newest.t {
        return Some(newest);
    }
    let mut later = newest;
    for i in 1..v.hist_n {
        let c = hist_get(v, i)?;
        if c.t <= t {
            if later.t <= c.t {
                return Some(c);
            }
            let u = (t - c.t) / (later.t - c.t);
            return Some(CamRec {
                seq: if u < 1.0 { c.seq } else { later.seq },
                t,
                x: c.x + (later.x - c.x) * u,
                y: c.y + (later.y - c.y) * u,
                ez: c.ez + (later.ez - c.ez) * u,
            });
        }
        later = c;
    }
    Some(later)
}

/// The last time the camera was `seq` (its newest tick with it), if still in the history: a
/// camera that stood still for a while is as recent as its last tick.
fn hist_seq_time(v: &View, seq: u64) -> Option<f64> {
    for i in 0..v.hist_n {
        let c = hist_get(v, i)?;
        if c.seq == seq {
            return Some(c.t);
        }
        if c.seq < seq {
            return None;
        }
    }
    None
}

/// How far the canvas may trail the newest camera to stay with the page's DOM (ms): six of the
/// page's frames (its push, its frame, its reply: two or three when it keeps up), 66 ms at
/// 120 Hz. Further behind (a page stalled by a long frame) it is not waited for.
fn lag_max(v: &View) -> f64 {
    (v.vp.layout().frame_ms * 6.0 + 16.0).clamp(50.0, 120.0)
}

/// The render thread, each display frame: the camera advanced to `t_ms`, the frame's presentation
/// time; where the page's surface is drawn (device px scale and corner), or None when the page
/// places the canvas itself.
pub(crate) fn draw_tick(t_ms: f64) -> Option<(f64, f64, f64)> {
    with_view(|v| {
        if !owned(v) {
            flush(v);
            finish(v, t_ms);
            v.tick_t = t_ms;
            return None;
        }
        let old = legacy(v);
        let resample_lead = if v.hz > 0.0 {
            (1000.0 / v.hz * 0.65).clamp(3.0, 8.0)
        } else {
            RESAMPLE_MS
        };
        if old {
            // 2.9.6: the camera advanced to the moment of the tick.
            v.vp.tick(clock_ms() / 1000.0);
        } else {
            // Fingers, momentum and animations all at one time, the resampling's: a fling goes
            // on from where the fingers left the camera, with no extra step at the release.
            process(v, t_ms - resample_lead, true);
            v.vp.tick((t_ms - resample_lead) / 1000.0);
        }
        let c = v.vp.camera().clone();
        let (view_w, view_h) = {
            let [_, _, vw, vh] = v.vp.layout().view;
            (vw, vh)
        };
        let world_cx = if c.ez > 1e-6 { ((view_w / 2.0) - c.x) / c.ez } else { 0.0 };
        let world_cy = if c.ez > 1e-6 { ((view_h / 2.0) - c.y) / c.ez } else { 0.0 };
        crate::remote_service::broadcast_camera(
            world_cx as f32,
            world_cy as f32,
            c.ez as f32,
            0.0,
            c.gesture,
            c.moving,
        );
        if hist_get(v, 0).is_none_or(|h| h.seq != c.seq) {
            v.moved_at = clock_ms();
        }
        if v.vp.gesture() && v.rec.is_none() && v.vp.fingers() >= 2 {
            v.rec = Some(GestureRecorder::new(
                t_ms,
                c.ez,
                v.vp.events,
                v.vp.rebases,
                v.hz,
            ));
        }
        hist_push(
            v,
            CamRec {
                seq: c.seq,
                t: t_ms,
                x: c.x,
                y: c.y,
                ez: c.ez,
            },
        );
        // The camera to draw: the one the page's DOM shows, unless it is too far behind.
        let busy = v.vp.busy();
        let lag = lag_max(v);
        let shown_t = match v.shown {
            Some((seq, at)) if !old && clock_ms() - at < 1000.0 => {
                if seq == c.seq {
                    Some(t_ms)
                } else {
                    hist_seq_time(v, seq)
                }
            }
            _ => None,
        };
        // How far the DOM trails the newest camera, measured each time it shows a new one and
        // smoothed: the canvas draws the camera that far back, so it moves as evenly as the camera
        // itself (never in the steps of the reports' arrival) and with the DOM. A DOM that stops
        // reporting (a long page frame) is not waited for: the trail is kept and the canvas goes
        // on; one that comes back later raises the trail gradually (no jump either way).
        let dt = (t_ms - v.tick_t).clamp(0.0, 100.0);
        let fresh = v.shown.map(|s| s.0) != v.last_shown;
        v.last_shown = v.shown.map(|s| s.0);
        let alone = shown_t.is_some_and(|st| t_ms - st > lag);
        match shown_t {
            Some(st) if fresh => {
                let obs = (t_ms - st).clamp(0.0, lag);
                let alpha = if dt > 0.0 {
                    1.0 - (-dt / 80.0).exp()
                } else {
                    0.25
                };
                v.trail = if v.trail.is_finite() {
                    v.trail + (obs - v.trail) * alpha
                } else {
                    obs
                };
            }
            Some(_) => {}
            None => {
                let alpha = if dt > 0.0 {
                    1.0 - (-dt / 80.0).exp()
                } else {
                    0.25
                };
                v.trail = if v.trail.is_finite() {
                    v.trail * (1.0 - alpha)
                } else {
                    0.0
                };
            }
        }
        let (draw_cam_x, draw_cam_y, draw_cam_ez, draw_cam_t) = if !v.vp.layout().legacy {
            let trail = if v.trail.is_finite() { v.trail } else { 0.0 };
            let mut draw_t = t_ms - trail;
            if dt.is_finite() && dt > 0.0 && dt < 100.0 && v.drawn_t.is_finite() {
                // Never back.
                draw_t = draw_t.max(v.drawn_t).min(t_ms);
            }
            if !busy && shown_t.is_none_or(|st| st >= t_ms) {
                draw_t = t_ms;
            }
            let d = hist_at(v, draw_t).unwrap_or(CamRec {
                seq: c.seq,
                t: t_ms,
                x: c.x,
                y: c.y,
                ez: c.ez,
            });
            (d.x, d.y, d.ez, draw_t)
        } else {
            // Live presentation at current frame: zero latency, maximum responsiveness, lean execution
            (c.x, c.y, c.ez, t_ms)
        };
        let t_s = t_ms / 1000.0;
        if let Some(prev) = v.filter_last_t {
            if t_s - prev > 0.1 || t_s < prev {
                v.reset_filters();
            }
        }
        v.filter_last_t = Some(t_s);

        let (draw_cam_x, draw_cam_y, draw_cam_ez) = {
            let fx = v.filter_x.filter(draw_cam_x, t_s);
            let fy = v.filter_y.filter(draw_cam_y, t_s);
            let ln_ez = v.filter_ln_ez.filter(draw_cam_ez.ln(), t_s);
            let fez = ln_ez.exp();

            let dx = (fx - draw_cam_x).abs();
            let dy = (fy - draw_cam_y).abs();
            let dln = (ln_ez - draw_cam_ez.ln()).abs();

            if !busy && dx < 0.02 && dy < 0.02 && dln < 1e-4 {
                v.filter_converging = false;
                (draw_cam_x, draw_cam_y, draw_cam_ez)
            } else {
                v.filter_converging = dx >= 0.02 || dy >= 0.02 || dln >= 1e-4;
                (fx, fy, fez)
            }
        };
        v.filtered_cam = Some((draw_cam_x, draw_cam_y, draw_cam_ez));
        v.tick_t = t_ms;
        v.drawn_t = draw_cam_t;
        if let Some(r) = v.rec.as_mut() {
            r.tick(t_ms, false);
            r.placed(t_ms - draw_cam_t, alone);
            if v.vp.gliding() {
                r.glided();
            }
        }
        // The page point under the fingers (the bench's check that it stays there).
        let n = v.vp.fingers();
        let under = match (v.vp.finger_centroid(), n >= 2) {
            (Some((fx, fy)), true) if c.ez > 0.0 => {
                if v.probe.is_none_or(|p| p.2 != n) {
                    v.probe = Some(((fx - c.x) / c.ez, (fy - c.y) / c.ez, n));
                }
                let p = v.probe.unwrap_or_default();
                (c.x + p.0 * c.ez - fx).hypot(c.y + p.1 * c.ez - fy)
            }
            _ => {
                v.probe = None;
                f64::NAN
            }
        };
        let placed =
            v.vp.layout()
                .surface_at(draw_cam_x, draw_cam_y, draw_cam_ez);
        if let Some(tr) = v.trace.as_mut() {
            if tr.len() < TRACE {
                tr.push(TraceRec {
                    t: t_ms,
                    seq: c.seq,
                    x: c.x,
                    y: c.y,
                    ez: c.ez,
                    drawn_t: draw_cam_t,
                    shown: v.shown.map_or(0, |s| s.0),
                    dx: draw_cam_x,
                    dy: draw_cam_y,
                    dez: draw_cam_ez,
                    k: placed.0,
                    sx: placed.1,
                    sy: placed.2,
                    under,
                    ink_paper: f64::NAN,
                    alone,
                    fingers: n,
                });
            }
        }
        if !busy && v.queue.is_empty() {
            finish(v, t_ms);
        }
        Some(placed)
    })
}

/// The tick's frame was drawn; `ink_paper` the largest gap between the papers and the ink as
/// drawn (device px).
pub(crate) fn drew(ink_paper: f64) {
    with_view(|v| {
        if let Some(r) = v.rec.as_mut() {
            r.drew();
        }
        if let Some(last) = v.trace.as_mut().and_then(|t| t.last_mut()) {
            last.ink_paper = ink_paper;
        }
    });
}

fn finish(v: &mut View, now_ms: f64) {
    if let Some(r) = v.rec.take() {
        let events = v.vp.events.saturating_sub(r.events0());
        // Filter phantom 1-event pinches: genuine pinches have >= 2 events and >= 2 ticks
        if events < 2 || r.ticks_len() < 2 {
            return;
        }
        v.gestures += 1;
        let mut s = r.finish(
            v.gestures,
            now_ms,
            v.vp.camera().zoom,
            v.vp.events,
            v.vp.rebases,
        );
        s.link_ms = (v.link.0 * 100.0).round() / 100.0;
        s.lead_ms = (v.link.1 * 100.0).round() / 100.0;
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
    // The pages near the view the canvas does not have (in view first): the page sends them
    // (ADR-007). VIEW is held: the canvas service's page lock is a leaf.
    let (missing, gen) = crate::canvas_service::missing();
    v.pushed_missing = gen;
    json!({
        "owned": owned(v),
        "camera": v.vp.camera(),
        "view": v.vp.view_state(),
        "page": v.vp.current_sheet(),
        "fingers": v.vp.fingers(),
        "log": log,
        "missing": missing,
    })
}

/// The shells, after each tick: the camera for the page when it changed (and, 2.9.6's camera,
/// once the page's frame interval has passed since the last push), else None. The shells send
/// one at a time (the next once the page has run the last).
pub fn poll(now_ms: f64) -> Option<String> {
    with_view(|v| {
        if !owned(v) && v.unread.is_empty() {
            return None;
        }
        let seq = v.vp.camera().seq;
        let f = v.vp.layout().frame_ms.clamp(4.0, 100.0);
        let gap = if legacy(v) { f * 0.8 } else { f * 0.95 };
        let missing_new = crate::canvas_service::missing().1 != v.pushed_missing;
        if (seq == v.pushed_seq && v.unread.is_empty() && !missing_new)
            || now_ms - v.pushed_at < gap
        {
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
            "shown": v.shown.map(|s| s.0),
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
        flush(v);
        v.vp.set_layout(req.layout);
        if !owned(v) {
            v.held.clear();
            v.shown = None;
        }
        if !was {
            v.reset_filters();
        }
        if let Some(a) = req.adopt {
            if !was || !v.vp.busy() {
                v.vp.adopt(a.zoom, a.sl, a.st, (a.sub[0], a.sub[1]), a.fit);
                v.reset_filters();
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
        flush(v);
        let vp = &mut v.vp;
        let pair = |a: Option<[f64; 2]>| a.map(|[l, w]| (l, w));
        let reset_filter = match req {
            SetReq::ScrollTo { smooth, .. } => !smooth,
            SetReq::Pull { animate, .. } => !animate,
            _ => true,
        };
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
        if reset_filter {
            v.reset_filters();
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
        // The camera as the last tick placed it (fingers are taken at the ticks' times): the
        // page shows only cameras the canvas has, so it can draw the one the page shows.
        let mut out = camera_value_with(v, !req.keep);
        if req.layout {
            out["layout"] = serde_json::to_value(v.vp.layout()).unwrap_or(Value::Null);
        }
        out
    });
    Ok((out.to_string(), Vec::new()))
}

#[derive(Deserialize)]
struct ShownReq {
    seq: u64,
}

/// `viewportShown`: the camera the page has just put on its DOM (its seq), each page frame it
/// changed. The canvas draws that one (ADR-008).
pub fn viewport_shown(meta: &str) -> Result<(String, Vec<u8>), String> {
    let req: ShownReq = serde_json::from_str(meta).map_err(|e| format!("viewportShown: {e}"))?;
    let now = clock_ms();
    with_view(|v| {
        if owned(v) {
            v.shown = Some((req.seq, now));
        }
    });
    Ok(("{}".into(), Vec::new()))
}

#[derive(Deserialize)]
struct TouchReq {
    /// [id, phase, x, y] or [id, phase, x, y, t] (web view points; t ms on the shells' clock), as
    /// a shell sends them.
    touches: Vec<Vec<f64>>,
}

/// `viewportTouch`: fingers through the bridge (the PC's stand-in shell, tests).
pub fn viewport_touch(meta: &str) -> Result<(String, Vec<u8>), String> {
    let req: TouchReq = serde_json::from_str(meta).map_err(|e| format!("viewportTouch: {e}"))?;
    let taken: Vec<bool> = req
        .touches
        .iter()
        .map(|t| t.len() >= 4 && touch(t[0] as i64, t[1] as i32, t[2], t[3], t.get(4).copied()))
        .collect();
    Ok((json!({ "taken": taken }).to_string(), Vec::new()))
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct TraceReq {
    /// Start recording (clears), or stop and hand over the ticks.
    start: bool,
}

/// `viewportTrace`: the bench's record of every tick (see [`TraceRec`]).
pub fn viewport_trace(meta: &str) -> Result<(String, Vec<u8>), String> {
    let req: TraceReq = serde_json::from_str(meta).unwrap_or_default();
    let out = with_view(|v| {
        if req.start {
            v.trace = Some(Vec::with_capacity(TRACE));
            return json!({ "ticks": [] });
        }
        let ticks: Vec<Value> = v
            .trace
            .take()
            .unwrap_or_default()
            .iter()
            .map(|r| {
                let n = |x: f64| if x.is_finite() { json!(x) } else { Value::Null };
                json!([
                    r.t,
                    r.seq,
                    r.x,
                    r.y,
                    r.ez,
                    r.drawn_t,
                    r.shown,
                    r.dx,
                    r.dy,
                    r.dez,
                    r.k,
                    r.sx,
                    r.sy,
                    n(r.under),
                    n(r.ink_paper),
                    r.alone,
                    r.fingers
                ])
            })
            .collect();
        json!({ "ticks": ticks })
    });
    Ok((out.to_string(), Vec::new()))
}

/// Tests: back to a new camera.
pub fn reset() {
    with_view(|v| v.reset_filters());
    *view() = None;
}

// ------------------------------------------------------------------------------------------------
// The shells' C ABI (iOS; Android's JNI functions in lib.rs call the same).

/// A finger (see [`touch`]), stamped now. Main thread; returns at once.
#[no_mangle]
pub extern "C" fn opennote_viewport_touch(id: i64, phase: i32, x: f64, y: f64) -> bool {
    std::panic::catch_unwind(|| touch(id, phase, x, y, None)).unwrap_or(false)
}

/// The fingers of one touch event: `n` samples of five doubles each, [id, phase, x, y, t] (web
/// view points, `t` seconds on the shells' clock: `UITouch.timestamp`), in time order, coalesced
/// samples included. Returns how many the camera holds. Main thread; returns at once.
///
/// # Safety
/// `samples` must point to `5 * n` readable doubles (or be null with `n` 0).
#[no_mangle]
pub unsafe extern "C" fn opennote_viewport_touches(samples: *const f64, n: i32) -> i32 {
    if samples.is_null() || n <= 0 {
        return 0;
    }
    // SAFETY: the caller guarantees 5 * n doubles at `samples`.
    let s = unsafe { std::slice::from_raw_parts(samples, n as usize * 5) };
    std::panic::catch_unwind(|| touches(s)).unwrap_or(0)
}

/// [id, phase, x, y, t s] samples (see [`opennote_viewport_touches`]).
pub fn touches(s: &[f64]) -> i32 {
    s.as_chunks::<5>()
        .0
        .iter()
        .map(|c| {
            i32::from(touch(
                c[0] as i64,
                c[1] as i32,
                c[2],
                c[3],
                Some(c[4] * 1000.0),
            ))
        })
        .sum()
}

/// The display's best rate (Hz).
#[no_mangle]
pub extern "C" fn opennote_viewport_display_hz(hz: f64) {
    let _ = std::panic::catch_unwind(|| set_display_hz(hz));
}

/// Whether the camera moves (fingers, momentum, an animation) or waits for fingers: the shells
/// ask the display for its best rate then and may relax it otherwise.
#[no_mangle]
pub extern "C" fn opennote_viewport_busy() -> bool {
    std::panic::catch_unwind(busy).unwrap_or(false)
}

pub fn busy() -> bool {
    with_view(|v| {
        owned(v)
            && (v.vp.busy()
                || !v.held.is_empty()
                || !v.queue.is_empty()
                || v.filter_converging
                || clock_ms() - v.moved_at < 500.0)
    })
}

pub fn filtered_camera() -> Option<(f64, f64, f64)> {
    with_view(|v| v.filtered_cam)
}

/// The display link's interval and how far ahead of its frame's presentation the tick ran
/// (seconds, as the shells read them), for the gestures' record.
#[no_mangle]
pub extern "C" fn opennote_viewport_link(duration: f64, lead: f64) {
    let _ = std::panic::catch_unwind(|| link(duration * 1000.0, lead * 1000.0));
}

pub fn link(duration_ms: f64, lead_ms: f64) {
    if duration_ms.is_finite() && lead_ms.is_finite() {
        with_view(|v| v.link = (duration_ms, lead_ms));
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn layout() -> String {
        json!({
            "layout": { "view": [0, 50, 800, 1000], "content": [800, 6000], "surface": [8, 8],
                        "sheets": [[0, 0, 784, 1100]], "dpr": 2, "frameMs": 8.33, "owned": true },
            "adopt": { "zoom": 1, "sl": 0, "st": 0, "sub": [0, 0], "fit": null }
        })
        .to_string()
    }

    /// A two-finger pan at a constant 600 px/s, samples every 8.33 ms delivered 0-8 ms late,
    /// ticks at 120 Hz: the camera's position from tick to tick.
    fn pan() -> Vec<f64> {
        reset();
        viewport_layout(&layout()).unwrap();
        let t0 = clock_ms() - 800.0;
        let period = 1000.0 / 120.0;
        let mut seed = 7u64;
        let mut jitter = || {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((seed >> 33) as f64 / (1u64 << 31) as f64) * 8.0
        };
        // Samples: time, y, arrival.
        let samples: Vec<(f64, f64, f64)> = (0..90)
            .map(|i| {
                let t = t0 + i as f64 * period;
                (t, 700.0 - 0.6 * (i as f64 * period), t + jitter())
            })
            .collect();
        let mut ys = Vec::new();
        let mut next = 0;
        for k in 0..80 {
            // The tick runs a frame before its presentation time.
            let present = t0 + 20.0 + k as f64 * period;
            while next < samples.len() && samples[next].2 <= present - period {
                let (t, y, _) = samples[next];
                let phase = if next == 0 { 0 } else { 1 };
                touch(1, phase, 300.0, y + 50.0, Some(t));
                touch(2, phase, 400.0, y + 50.0, Some(t));
                next += 1;
            }
            draw_tick(present);
            with_view(|v| ys.push(v.vp.camera().y));
        }
        ys
    }

    fn worst_second_difference(ys: &[f64]) -> f64 {
        // Once the pan runs (the first few ticks start it).
        ys.windows(3)
            .skip(20)
            .take(40)
            .map(|w| (w[2] - 2.0 * w[1] + w[0]).abs())
            .fold(0.0, f64::max)
    }

    #[test]
    fn resampled_fingers_pan_evenly_despite_late_delivery() {
        let _lock = TEST_LOCK.lock().unwrap();
        let ys = pan();
        let new = worst_second_difference(&ys);
        assert!(new < 0.05, "resampled: worst second difference {new}");
    }

    #[test]
    fn micro_movement_pan_is_subpixel_smooth() {
        let _lock = TEST_LOCK.lock().unwrap();
        reset();
        viewport_layout(&layout()).unwrap();
        let t0 = clock_ms() - 900.0;
        let period = 1000.0 / 120.0; // ~8.333 ms

        // Super-slow two-finger pan at 18 px/s (0.15 px/frame at 120 Hz)
        // Hardware touch samples arrive every ~28 ms quantized to 0.5 px steps.
        let mut touch_samples = Vec::new();
        let mut cur_t = t0;
        let stop_t = t0 + 720.0;
        while cur_t <= stop_t {
            let elapsed_ms = cur_t - t0;
            let continuous_y = 700.0 - (18.0 * elapsed_ms / 1000.0);
            let quantized_y = (continuous_y * 2.0).round() / 2.0;
            touch_samples.push((cur_t, quantized_y));
            cur_t += 28.0;
        }

        let mut ys = Vec::new();
        let mut sample_idx = 0;
        for k in 0..120 {
            let present = t0 + 20.0 + k as f64 * period;
            while sample_idx < touch_samples.len()
                && touch_samples[sample_idx].0 <= present - period
            {
                let (t, y) = touch_samples[sample_idx];
                let phase = if sample_idx == 0 { 0 } else { 1 };
                touch(1, phase, 300.0, y + 50.0, Some(t));
                touch(2, phase, 400.0, y + 50.0, Some(t));
                sample_idx += 1;
            }
            draw_tick(present);
            let cam_y = with_view(|v| v.filtered_cam.map(|c| c.1).unwrap_or(v.vp.camera().y));
            ys.push(cam_y);
        }

        // 1. Zero backward reversals (dy never flips sign during steady slow forward motion)
        for i in 10..80 {
            let dy = ys[i] - ys[i - 1];
            assert!(
                dy <= 1e-4,
                "backward reversal at frame {i}: step={dy} (prev={}, curr={})",
                ys[i - 1],
                ys[i]
            );
        }

        // 2. Max single-frame velocity spike < 2.0x mean step
        let delta_total = (ys[80] - ys[20]).abs();
        let mean_step = delta_total / 60.0;
        assert!(
            mean_step > 0.05,
            "mean step should be non-trivial: {mean_step}"
        );
        for i in 20..80 {
            let step = (ys[i] - ys[i - 1]).abs();
            assert!(
                step < 2.0 * mean_step,
                "velocity spike at frame {i}: step={step}, mean={mean_step}"
            );
        }

        // 3. Continuous non-zero sub-pixel progression on > 90% of frames during slow move
        let moving_frames = (20..80)
            .filter(|&i| (ys[i] - ys[i - 1]).abs() >= 0.03)
            .count();
        let ratio = moving_frames as f64 / 60.0;
        assert!(
            ratio > 0.90,
            "continuous progression on {moving_frames}/60 frames ({:.1}%)",
            ratio * 100.0
        );

        // 4. Final resting position converges within < 0.05 px of true finger position
        let final_raw_cam = with_view(|v| v.vp.camera().y);
        let final_filtered = *ys.last().unwrap();
        assert!(
            (final_filtered - final_raw_cam).abs() < 0.05,
            "final position did not converge: filtered={final_filtered}, target={final_raw_cam}"
        );
    }

    #[test]
    fn the_history_gives_the_camera_at_a_time() {
        let _lock = TEST_LOCK.lock().unwrap();
        reset();
        with_view(|v| {
            for i in 0..5 {
                hist_push(
                    v,
                    CamRec {
                        seq: i,
                        t: i as f64 * 10.0,
                        x: i as f64 * 2.0,
                        y: 0.0,
                        ez: 1.0,
                    },
                );
            }
            let c = hist_at(v, 25.0).unwrap();
            assert!((c.x - 5.0).abs() < 1e-12, "{c:?}");
            assert_eq!(hist_seq_time(v, 3), Some(30.0));
            assert_eq!(hist_at(v, 99.0).unwrap().seq, 4);
        });
    }
}
