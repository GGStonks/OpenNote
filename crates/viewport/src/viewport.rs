//! The note's camera while the native canvas draws it: useViewport.ts's two-finger gesture (pan,
//! pinch about the fingers, rebasing, momentum, the pull past the last page, fit to width and its
//! snap) and its page-originated views (fit to width, fit page, restored views, zooming by a
//! factor, going to a page), ported state for state. Each field names its counterpart there.
//!
//! The camera is the one the page's DOM would have: the committed zoom and scroll positions (what
//! the page's React state and scroll view hold), the sub-pixel translation applyAnchor leaves, and
//! while the fingers zoom, the CSS transform useViewport puts on the content (scaled about the
//! point first between the fingers and moved with them). `Camera::x`, `y`, `ez` are where all of
//! that puts the content's corner on screen and at what scale: the canvas draws there, and the page
//! mirrors the same camera on its own frames.
//!
//! Units as in the page: CSS px in the scroll view's box ("view px"), times in ms inside (the API
//! takes seconds).

use crate::math::*;
use serde::{Deserialize, Serialize};

/// useViewport.ts `FitMode` (`null` is `None`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FitMode {
    Width,
    Page,
}

/// What the page lays out (Editor.tsx): sent on every change (`viewportLayout`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Layout {
    /// The scroll view's box in the web view (CSS px): left, top, clientWidth, clientHeight.
    pub view: [f64; 4],
    /// The unzoomed content (Editor `contentWidth`, `totalHeight`).
    pub content: [f64; 2],
    /// Where the page's surface (CanvasPage) sits in the content (Editor `PAD`, `PAD`).
    pub surface: [f64; 2],
    /// The pages on the surface: left, top, width, height (surface px).
    pub sheets: Vec<[f64; 4]>,
    /// The pull past the last page adds a page (useViewport `onPullCommit`).
    pub pull: bool,
    /// One finger scrolls (useViewport `fingersNavigate`: stylus only, hand tool): natively, the page's.
    pub single: bool,
    /// Controls over the scroll view whose touches are not the camera's (web view CSS px).
    pub holes: Vec<[f64; 4]>,
    /// CSS px to device px.
    pub dpr: f64,
    /// The page's frame interval (src/services/frameRate.ts frameMs): pushes no faster.
    pub frame_ms: f64,
    /// Rust owns this note's camera (the native canvas draws it and the shell hands it fingers).
    pub owned: bool,
    /// The visual viewport (`window.visualViewport`): offsetLeft, offsetTop, scale. The shells'
    /// points are the web view's own; the page's are its client px: client = web / scale + offset
    /// (iOS scrolls the web view under the keyboard: the two then part).
    pub vv: [f64; 3],
    /// The bench's "before" (`--only cameracoherence`): 2.9.6's camera, fingers stamped as they
    /// arrive and the newest camera drawn whatever the page's DOM shows.
    pub legacy: bool,
}

impl Default for Layout {
    fn default() -> Self {
        Layout {
            view: [0.0, 0.0, 0.0, 0.0],
            content: [1.0, 1.0],
            surface: [0.0, 0.0],
            sheets: Vec::new(),
            pull: false,
            single: false,
            holes: Vec::new(),
            dpr: 1.0,
            frame_ms: 1000.0 / 60.0,
            owned: false,
            vv: [0.0, 0.0, 1.0],
            legacy: false,
        }
    }
}

impl Layout {
    pub fn scroll_box(&self) -> ScrollBox {
        ScrollBox {
            client_w: self.view[2],
            client_h: self.view[3],
            content_w: self.content[0].max(1e-9),
            content_h: self.content[1],
        }
    }

    /// The visual viewport's scale, never 0.
    fn vv_scale(&self) -> f64 {
        if self.vv[2].is_finite() && self.vv[2] > 0.0 {
            self.vv[2]
        } else {
            1.0
        }
    }

    /// A shell's web view point (its own points) in the page's client px.
    pub fn client_of_web(&self, x: f64, y: f64) -> (f64, f64) {
        let s = self.vv_scale();
        (x / s + self.vv[0], y / s + self.vv[1])
    }

    /// A page client point in the shell's web view points.
    pub fn web_of_client(&self, x: f64, y: f64) -> (f64, f64) {
        let s = self.vv_scale();
        ((x - self.vv[0]) * s, (y - self.vv[1]) * s)
    }

    /// Where the page's surface is drawn (device px of the shell's view, which covers the web
    /// view from its origin: scale, left, top) for the content's corner at (x, y) view px and
    /// scale `ez`: the one transform of everything the canvas draws. f64 throughout.
    pub fn surface_at(&self, x: f64, y: f64, ez: f64) -> (f64, f64, f64) {
        let s = self.vv_scale();
        let (wx, wy) = self.web_of_client(
            self.view[0] + x + self.surface[0] * ez,
            self.view[1] + y + self.surface[1] * ez,
        );
        (ez * s * self.dpr, wx * self.dpr, wy * self.dpr)
    }

    /// A web view point (CSS px) the camera's fingers may start on.
    pub fn accepts(&self, x: f64, y: f64) -> bool {
        let inside = |r: &[f64; 4]| x >= r[0] && y >= r[1] && x < r[0] + r[2] && y < r[1] + r[3];
        self.owned && inside(&self.view) && !self.holes.iter().any(inside)
    }
}

/// A view to come back to (useViewport `SavedView`): the content point at the screen's corner.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct SavedView {
    pub zoom: f64,
    pub cx: f64,
    pub cy: f64,
    pub fit: Option<FitMode>,
}

/// The camera as published (`viewportCamera`, the shells' push).
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Camera {
    /// Changes whenever anything below does.
    pub seq: u64,
    /// The committed zoom and scroll positions (the page's `zoom` state, scrollLeft, scrollTop).
    pub zoom: f64,
    pub sl: f64,
    pub st: f64,
    /// Where the content's corner is (view px) and its scale, all transforms included.
    pub x: f64,
    pub y: f64,
    pub ez: f64,
    pub fit: Option<FitMode>,
    /// The pull past the end as useViewport reports it (`onPull`), and the pulls that added a page.
    pub pull: f64,
    pub pulls: u64,
    /// Placements (applyAnchor: the page dispatches CONTENT_PLACED).
    pub placed: u64,
    /// Two fingers are (or were, still down) moving the camera.
    pub gesture: bool,
    /// Momentum or an animation moves the camera.
    pub moving: bool,
    /// The last change came from the page's own scroll (its DOM has it already).
    pub by_page: bool,
}

/// A finger's phase (the shells' numbering: 0 began, 1 moved, 2 ended, 3 cancelled).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Began,
    Moved,
    Ended,
    Cancelled,
}

impl Phase {
    pub fn from_code(c: i32) -> Option<Phase> {
        match c {
            0 => Some(Phase::Began),
            1 => Some(Phase::Moved),
            2 => Some(Phase::Ended),
            3 => Some(Phase::Cancelled),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct P {
    x: f64,
    y: f64,
}

/// useViewport `pinch`: d0 / z0 at the start (or last rebase), o the content point first between
/// the fingers (outer px), c0 / c the fingers' centre then / now.
#[derive(Clone, Copy, Debug)]
struct Pinch {
    d0: f64,
    z0: f64,
    o: P,
    c0: P,
    c: P,
    engaged: bool,
    /// The zoom's factor, within the limits (what the release commits).
    k: f64,
    /// The fingers' own factor (spread / d0), past the limits too: shown rubber-banded.
    kr: f64,
    #[allow(dead_code)]
    rebased_at: Option<f64>,
}

/// useViewport `tap`.
#[derive(Clone, Debug)]
struct Tap {
    start: f64,
    fingers: usize,
    moved: bool,
    origins: Vec<(i64, P)>,
}

#[derive(Clone, Copy, Debug)]
struct Momentum {
    vx: f64,
    vy: f64,
    t0: f64,
}

/// A value going back to 0 as the pull's CSS transition does (from, release time).
#[derive(Clone, Copy, Debug)]
struct Release {
    from: f64,
    t0: f64,
}

/// A stretch past an edge going back (shown scroll px past it, as `spring` from x0 moving at v0).
#[derive(Clone, Copy, Debug)]
struct Spring {
    x0: f64,
    v0: f64,
    t0: f64,
}

/// A released pinch settling into place: the content's corner and scale as shown at the release.
#[derive(Clone, Copy, Debug)]
struct Settle {
    from: P,
    ez: f64,
    t0: f64,
}

/// A smooth scroll to a page (`el.scrollTo({ behavior: 'smooth' })`).
#[derive(Clone, Copy, Debug)]
struct Glide {
    from: f64,
    to: f64,
    t0: f64,
    ms: f64,
}

/// The camera and the gesture moving it.
#[derive(Clone, Debug)]
pub struct Viewport {
    layout: Layout,
    has_layout: bool,
    // The committed camera (useViewport zoomRef, the scroll view's scroll, outer's `translate`).
    zoom: f64,
    sl: f64,
    st: f64,
    sub: P,
    fit: Option<FitMode>,
    // The gesture (useViewport's refs).
    pointers: Vec<(i64, P)>,
    last: Option<(P, f64)>,
    velocity: P,
    history: Vec<(P, f64)>,
    pending: P,
    momentum: Option<Momentum>,
    tap: Option<Tap>,
    pinch: Option<Pinch>,
    pull_raw: f64,
    /// The pull's translateY on the content (0 while a pinch is engaged).
    pull_shown: f64,
    pull_release: Option<Release>,
    /// The page's own pull (one finger past the end, the wheel), shown the same way.
    page_pull: f64,
    page_pull_release: Option<Release>,
    glide: Option<Glide>,
    /// Fingers panning past an edge: how far (scroll px, signed as sl / st) beyond it they asked;
    /// shown through `rubber`. The committed scroll stays within its range.
    over: P,
    /// Stretches going back (x, y): after the fingers lift, or a fling's overshoot at an edge.
    bounce: [Option<Spring>; 2],
    /// A released pinch going to where its zoom was committed (limits, edges, the width snap).
    settle: Option<Settle>,
    /// `gestures.navigating`.
    navigating: bool,
    /// Two fingers came down in this touch sequence (the camera's gesture).
    two: bool,
    js_scrolled: bool,
    // Published.
    reported_pull: f64,
    pulls: u64,
    placed: u64,
    by_page: bool,
    cam: Camera,
    /// The time (ms) of the last frame: animations are shown as they were then between frames.
    cam_time: f64,
    /// Rebases and touch events so far (for the gesture's log).
    pub rebases: u64,
    pub events: u64,
    /// The last pinch: its zoom at the start and at the end.
    pub last_pinch: Option<(f64, f64)>,
    /// The fingers' places being fed are resampled ones (between real samples): a pinch engages
    /// and rebases only on a real sample, where the page's own gesture does.
    pub resampled: bool,
    /// Timestamp (ms) of the most recent finger-count transition (e.g. 2->1).
    transition_at: Option<f64>,
}

impl Default for Viewport {
    fn default() -> Self {
        Self::new()
    }
}

impl Viewport {
    pub fn new() -> Self {
        let mut v = Viewport {
            layout: Layout::default(),
            has_layout: false,
            zoom: 1.0,
            sl: 0.0,
            st: 0.0,
            sub: P::default(),
            fit: Some(FitMode::Width),
            pointers: Vec::new(),
            last: None,
            velocity: P::default(),
            history: Vec::new(),
            pending: P::default(),
            momentum: None,
            tap: None,
            pinch: None,
            pull_raw: 0.0,
            pull_shown: 0.0,
            pull_release: None,
            page_pull: 0.0,
            page_pull_release: None,
            glide: None,
            over: P::default(),
            bounce: [None, None],
            settle: None,
            navigating: false,
            two: false,
            js_scrolled: false,
            reported_pull: 0.0,
            pulls: 0,
            placed: 0,
            by_page: false,
            cam: Camera::default(),
            cam_time: 0.0,
            rebases: 0,
            events: 0,
            last_pinch: None,
            resampled: false,
            transition_at: None,
        };
        v.recompute();
        v
    }

    // --------------------------------------------------------------------------------------------
    // What the page sends.

    /// The page's layout. The scroll positions are clamped to the new range, as the browser does.
    pub fn set_layout(&mut self, l: Layout) {
        self.layout = l;
        self.has_layout = true;
        self.clamp_scroll();
        self.recompute();
    }

    /// The scroll view's new size (view px).
    pub fn set_view_size(&mut self, w: f64, h: f64) {
        let mut l = self.layout.clone();
        l.view[2] = w;
        l.view[3] = h;
        self.set_layout(l);
    }

    pub fn layout(&self) -> &Layout {
        &self.layout
    }

    pub fn has_layout(&self) -> bool {
        self.has_layout
    }

    /// The page's camera as it is (a note opened, Rust taking over): zoom, scroll, translation, fit.
    pub fn adopt(&mut self, zoom: f64, sl: f64, st: f64, sub: (f64, f64), fit: Option<FitMode>) {
        if !(zoom > 0.0 && zoom.is_finite() && sl.is_finite() && st.is_finite()) {
            return;
        }
        self.zoom = zoom;
        self.sl = sl;
        self.st = st;
        self.sub = P { x: sub.0, y: sub.1 };
        self.fit = fit;
        self.momentum = None;
        self.glide = None;
        self.by_page = true;
        self.clamp_scroll();
        self.recompute();
    }

    /// The page scrolled itself (one finger natively, the wheel, the mouse, the keyboard): its
    /// scroll positions, and how far they moved since the camera last placed them. Not while two
    /// fingers move the camera; during momentum the movement is added to it.
    pub fn page_scroll(&mut self, sl: f64, st: f64, dsl: f64, dst: f64) {
        if self.two || !(sl.is_finite() && st.is_finite()) {
            return;
        }
        if self.momentum.is_some() || self.glide.is_some() {
            self.sl += dsl;
            self.st += dst;
            self.glide = None;
        } else {
            self.sl = sl;
            self.st = st;
        }
        self.clamp_scroll();
        self.by_page = true;
        self.recompute();
    }

    /// useViewport `fitWidth`: the page `target` (left, width in content px; default the page in
    /// view) FIT_MARGIN from either edge, the content at the top of the screen kept in place.
    pub fn fit_width(&mut self, target: Option<(f64, f64)>) {
        if self.blocked() || self.layout.view[2] <= 0.0 {
            return;
        }
        self.fit = Some(FitMode::Width);
        let (left, width) = target.unwrap_or_else(|| self.fit_target());
        let z = fit_width_zoom(self.layout.view[2], width);
        let a = self.anchor_at(0.0, 0.0);
        self.set_view_inner(
            z,
            Some(Anchor {
                cx: left - FIT_MARGIN / z,
                sx: 0.0,
                ..a
            }),
            f64::INFINITY,
        );
        self.recompute();
    }

    /// useViewport `zoomToRect`: a rectangle of the content (x, y, width, height) fitted, centred.
    pub fn zoom_to_rect(&mut self, r: [f64; 4]) {
        let [cw, ch] = [self.layout.view[2], self.layout.view[3]];
        if self.blocked() || cw <= 0.0 || r[2] <= 0.0 || r[3] <= 0.0 {
            return;
        }
        self.fit = Some(FitMode::Page);
        let z = (cw / r[2]).min(ch / r[3]);
        self.set_view_inner(
            z,
            Some(Anchor {
                cx: r[0] + r[2] / 2.0,
                cy: r[1] + r[3] / 2.0,
                sx: cw / 2.0,
                sy: ch / 2.0,
            }),
            z,
        );
        self.recompute();
    }

    /// useViewport `restoreView`: the content point at the screen's corner, at its zoom; a view
    /// fitted to the width is fitted again.
    pub fn restore(&mut self, v: SavedView, target: Option<(f64, f64)>) {
        if self.blocked()
            || self.layout.view[2] <= 0.0
            || !v.cx.is_finite()
            || !v.cy.is_finite()
            || !(v.zoom.is_finite() && v.zoom > 0.0)
        {
            return;
        }
        if v.fit == Some(FitMode::Width) {
            self.fit = Some(FitMode::Width);
            let (left, width) = target.unwrap_or_else(|| self.fit_target());
            let z = fit_width_zoom(self.layout.view[2], width);
            self.set_view_inner(
                z,
                Some(Anchor {
                    cx: left - FIT_MARGIN / z,
                    cy: v.cy,
                    sx: 0.0,
                    sy: 0.0,
                }),
                f64::INFINITY,
            );
        } else {
            self.fit = v.fit;
            self.set_view_inner(
                v.zoom,
                Some(Anchor {
                    cx: v.cx,
                    cy: v.cy,
                    sx: 0.0,
                    sy: 0.0,
                }),
                v.zoom,
            );
        }
        self.recompute();
    }

    /// useViewport `zoomBy`: by a factor about the middle of the screen (keyboard, buttons).
    pub fn zoom_by(&mut self, f: f64) {
        if self.blocked() || !(f.is_finite() && f > 0.0) {
            return;
        }
        self.fit = None;
        self.set_view_inner(self.zoom * f, None, f64::INFINITY);
        self.recompute();
    }

    /// The wheel's zoom (ctrl + wheel, a trackpad's pinch): by a factor about a view point.
    pub fn zoom_at(&mut self, f: f64, sx: f64, sy: f64) {
        if self.blocked() || !(f.is_finite() && f > 0.0) {
            return;
        }
        self.fit = None;
        let a = self.anchor_at(sx, sy);
        self.set_view_inner(self.zoom * f, Some(a), f64::INFINITY);
        self.recompute();
    }

    /// useViewport `setView`: zoom `z` (clamped), `a` (default the screen's middle) kept in place.
    pub fn set_view(&mut self, z: f64, a: Option<Anchor>, floor: f64) {
        if self.blocked() {
            return;
        }
        self.set_view_inner(z, a, floor);
        self.recompute();
    }

    /// Editor `jumpToPage`: the content height `y` (unscaled px) to the top of the screen, gliding.
    pub fn scroll_to(&mut self, y: f64, smooth: bool, t: f64) {
        if self.blocked() || !y.is_finite() {
            return;
        }
        let to = (y * self.zoom).clamp(0.0, self.layout.scroll_box().max_scroll_top(self.zoom));
        self.momentum = None;
        self.by_page = false;
        if smooth && (to - self.st).abs() > 0.5 {
            let d = (to - self.st).abs();
            self.glide = Some(Glide {
                from: self.st,
                to,
                t0: t * 1000.0,
                ms: (150.0 + d.sqrt() * 8.0).clamp(200.0, 600.0),
            });
        } else {
            self.st = to;
            self.glide = None;
        }
        self.recompute();
    }

    /// The page's own pull past the end (one finger, the wheel), `animate`d back when released.
    pub fn page_pull(&mut self, d: f64, animate: bool, t: f64) {
        let shown = self.page_pull_now(t * 1000.0);
        if d <= 0.0 && animate && shown > 0.0 {
            self.page_pull_release = Some(Release {
                from: shown,
                t0: t * 1000.0,
            });
        } else {
            self.page_pull_release = None;
        }
        self.page_pull = d.max(0.0);
        self.by_page = false;
        self.recompute();
    }

    /// Momentum and glides stop.
    pub fn stop(&mut self) {
        self.momentum = None;
        self.glide = None;
        self.bounce = [None, None];
        self.settle = None;
        self.recompute();
    }

    /// useViewport `viewState`: the view as it is now.
    pub fn view_state(&self) -> SavedView {
        let a = self.anchor_at(0.0, 0.0);
        SavedView {
            zoom: self.zoom,
            cx: a.cx,
            cy: a.cy,
            fit: self.fit,
        }
    }

    /// Page ops wait while two fingers move the camera (their anchors would be stale).
    fn blocked(&self) -> bool {
        !self.has_layout || self.two
    }

    // --------------------------------------------------------------------------------------------
    // The fingers (useViewport onDown / onMove / onUp), view px, seconds.

    pub fn touch(&mut self, id: i64, phase: Phase, x: f64, y: f64, t: f64) {
        if !x.is_finite() || !y.is_finite() || !t.is_finite() {
            return;
        }
        let now = t * 1000.0;
        let p = P { x, y };
        self.events += 1;
        self.by_page = false;
        match phase {
            Phase::Began => self.down(id, p, now),
            Phase::Moved => self.moved(id, p, now),
            Phase::Ended => self.up(id, now, false),
            Phase::Cancelled => self.up(id, now, true),
        }
        self.recompute();
    }

    /// Fingers the camera holds now.
    pub fn fingers(&self) -> usize {
        self.pointers.len()
    }

    /// The point between the fingers the camera holds (view px), when any.
    pub fn finger_centroid(&self) -> Option<(f64, f64)> {
        (!self.pointers.is_empty()).then(|| {
            let c = self.centroid();
            (c.x, c.y)
        })
    }

    fn down(&mut self, id: i64, p: P, now: f64) {
        if self.pointers.iter().any(|(i, _)| *i == id) {
            self.moved(id, p, now);
            return;
        }
        if self.pointers.is_empty() {
            self.js_scrolled = false;
            self.two = false;
        }
        // stopMomentum (a touch also ends the browser's smooth scroll).
        self.momentum = None;
        self.glide = None;
        // A stretch going back is caught where it is shown (the fingers take it on from there).
        self.catch_stretch(now);
        if self.pointers.is_empty() {
            self.tap = Some(Tap {
                start: now,
                fingers: 0,
                moved: false,
                origins: Vec::new(),
            });
        }
        let n = self.pointers.len();
        if let Some(t) = self.tap.as_mut() {
            t.origins.push((id, p));
            t.fingers = t.fingers.max(n + 1);
            if now - t.start > TAP_MAX_MS {
                t.moved = true;
            }
        }
        self.pointers.push((id, p));
        if self.pointers.len() >= 2 {
            // A second finger always scrolls and zooms.
            self.navigating = true;
            self.two = true;
            if self.pointers.len() == 2 {
                self.begin_pinch();
            } else {
                self.end_pinch(now);
            }
        } else if self.layout.single {
            self.navigating = true;
        }
        self.reset_track(now);
        self.velocity = P::default();
    }

    fn moved(&mut self, id: i64, p: P, now: f64) {
        let Some(slot) = self.pointers.iter_mut().find(|(i, _)| *i == id) else {
            return;
        };
        slot.1 = p;
        if let Some(t) = self.tap.as_mut() {
            if !t.moved {
                if let Some((_, o)) = t.origins.iter().find(|(i, _)| *i == id) {
                    if (p.x - o.x).hypot(p.y - o.y) > TAP_SLOP {
                        t.moved = true;
                    }
                }
            }
        }
        let Some((last, _)) = self.last else {
            return;
        };
        if !self.navigating {
            return;
        }
        self.js_scrolled = true;
        let c = self.centroid();
        if self.pointers.len() == 2 && self.pinch.is_some() {
            let spread = self.spread();
            let mut pz = self.pinch.expect("pinch");
            let s = spread / pz.d0;
            if !pz.engaged && !self.resampled && (s - 1.0).abs() > PINCH_START {
                // The pinch starts here, about the point between the fingers; movement not
                // scrolled yet is dropped.
                self.pending = P::default();
                let corner = self.content_corner();
                pz.engaged = true;
                pz.d0 = spread;
                pz.c0 = c;
                pz.c = c;
                pz.o = P {
                    x: c.x - corner.x,
                    y: c.y - corner.y,
                };
                self.pinch = Some(pz);
                self.release_pull(now, false);
                self.over = P::default();
                self.bounce = [None, None];
            }
            if pz.engaged {
                // trackPinch
                let z = pinch_zoom(
                    pz.z0,
                    spread,
                    pz.d0,
                    self.layout.view[2],
                    self.layout.scroll_box().content_w,
                );
                pz.k = z / pz.z0;
                pz.kr = spread / pz.d0;
                pz.c = c;
                self.pinch = Some(pz);
                // Hard rule: NEVER rebase layout/zoom mid-gesture.
                // 100% of camera motion is driven via GPU uniforms and CSS transform.
                // Single atomic rebase on settle only in end_pinch.
                self.last = Some((c, now));
                return;
            }
        }
        self.pending.x += c.x - last.x;
        self.pending.y += c.y - last.y;
        self.last = Some((c, now));
        self.history.push((c, now));
        while self.history.len() > 2 && now - self.history[0].1 > VELOCITY_WINDOW_MS {
            self.history.remove(0);
        }
    }

    fn up(&mut self, id: i64, now: f64, cancelled: bool) {
        let Some(i) = self.pointers.iter().position(|(p, _)| *p == id) else {
            return;
        };
        self.pointers.remove(i);
        if self.pointers.len() < 2 {
            self.two = false;
            self.end_pinch(now);
        }
        if !self.pointers.is_empty() {
            // A finger lifted: continue from the remaining ones without a jump.
            self.transition_at = Some(now);
            self.reset_track(now);
            return;
        }
        let in_transition_window = self.transition_at.is_some_and(|t| now - t < 50.0);
        self.transition_at = None;
        self.flush_scroll();
        let pulled = self.pull_raw > 0.0;
        self.release_pull(now, true);
        let stretched = (self.over.x != 0.0, self.over.y != 0.0);
        self.release_stretch(now);
        let h: Vec<(f64, f64, f64)> = self.history.iter().map(|(p, t)| (p.x, p.y, *t)).collect();
        let (vx, vy) = release_velocity_weighted(&h);
        self.velocity = P { x: vx, y: vy };
        // Along a stretched axis the content springs back instead of flinging.
        if stretched.0 {
            self.velocity.x = 0.0;
        }
        if stretched.1 {
            self.velocity.y = 0.0;
        }
        self.history.clear();
        let tap = self.tap.take();
        let was_navigating = self.navigating;
        self.navigating = false;
        self.two = false;
        let recent = self.last.is_some_and(|(_, t)| now - t < RELEASE_RECENT_MS);
        self.last = None;
        if let Some(t) = tap {
            if !t.moved && t.fingers >= 2 && now - t.start < TAP_MAX_MS {
                // A two- or three-finger tap: the page's undo / redo, no fling.
                return;
            }
        }
        let speed = self.velocity.x.hypot(self.velocity.y);
        let suppress_fling = in_transition_window && (speed < 0.5 || h.len() < 3);
        if was_navigating && recent && !pulled && self.js_scrolled && !cancelled && !suppress_fling
        {
            self.start_momentum(now);
        }
    }

    fn centroid(&self) -> P {
        let n = self.pointers.len().max(1) as f64;
        let (x, y) = self
            .pointers
            .iter()
            .fold((0.0, 0.0), |(x, y), (_, p)| (x + p.x, y + p.y));
        P { x: x / n, y: y / n }
    }

    /// The distance between the first two fingers (in the order they came down).
    fn spread(&self) -> f64 {
        match (self.pointers.first(), self.pointers.get(1)) {
            (Some((_, a)), Some((_, b))) => (a.x - b.x).hypot(a.y - b.y),
            _ => 0.0,
        }
    }

    fn reset_track(&mut self, now: f64) {
        let c = self.centroid();
        self.last = Some((c, now));
        self.history = vec![(c, now)];
    }

    fn begin_pinch(&mut self) {
        let d = self.spread();
        self.pinch = (d > 0.0).then_some(Pinch {
            d0: d,
            z0: self.zoom,
            o: P::default(),
            c0: P::default(),
            c: P::default(),
            engaged: false,
            k: 1.0,
            kr: 1.0,
            rebased_at: None,
        });
    }

    /// useViewport `rebase`: the pinch's zoom committed while the fingers are down.
    #[allow(dead_code)]
    fn rebase(&mut self, now: f64) {
        let Some(pz) = self.pinch else {
            return;
        };
        let a = Anchor {
            cx: pz.o.x / pz.z0,
            cy: pz.o.y / pz.z0,
            sx: pz.c.x,
            sy: pz.c.y,
        };
        self.set_view_inner(pz.z0 * pz.k, Some(a), f64::INFINITY);
        // The content's corner as placed (applyAnchor cleared the transform).
        let corner = self.placed_corner();
        let spread = self.spread();
        self.pinch = Some(Pinch {
            z0: self.zoom,
            d0: spread,
            k: 1.0,
            kr: 1.0,
            c0: pz.c,
            o: P {
                x: pz.c.x - corner.x,
                y: pz.c.y - corner.y,
            },
            rebased_at: Some(now),
            ..pz
        });
        self.rebases += 1;
    }

    /// useViewport `endPinch`: the pinch's zoom applied (snapped to the page's width when close),
    /// reached on a spring from where the fingers left it (past the limits or the edges, rubber
    /// banded, or short of the snap).
    fn end_pinch(&mut self, now: f64) {
        let Some(p) = self.pinch else {
            return;
        };
        if !p.engaged {
            self.pinch = None;
            return;
        }
        let (from, from_ez) = self.visual(self.release_clock());
        self.pinch = None;
        // No momentum after a pinch (the fingers' last movement was zooming, not a fling).
        self.js_scrolled = false;
        let z = p.z0 * p.k;
        let a = Anchor {
            cx: p.o.x / p.z0,
            cy: p.o.y / p.z0,
            sx: p.c.x,
            sy: p.c.y,
        };
        let (left, width) = self.fit_target();
        let zf = fit_width_zoom(self.layout.view[2], width);
        if snaps_to_fit(z, zf) {
            // Close to the page's width: fitted exactly, the point between the fingers keeping
            // its height.
            self.fit = Some(FitMode::Width);
            self.set_view_inner(
                zf,
                Some(Anchor {
                    cx: left - FIT_MARGIN / zf,
                    sx: 0.0,
                    ..a
                }),
                f64::INFINITY,
            );
        } else {
            self.fit = None;
            self.set_view_inner(z, Some(a), f64::INFINITY);
        }
        self.last_pinch = Some((p.z0, self.zoom));
        let to = self.placed_corner();
        let far = (from.x - to.x).abs().max((from.y - to.y).abs()) > 0.25
            || (from_ez / self.zoom - 1.0).abs() > 1e-4;
        self.settle = far.then_some(Settle {
            from,
            ez: from_ez,
            t0: now,
        });
    }

    fn flush_scroll(&mut self) {
        let (dx, mut dy) = (-self.pending.x, -self.pending.y);
        self.pending = P::default();
        if dx == 0.0 && dy == 0.0 {
            return;
        }
        let engaged = self.pinch.is_some_and(|p| p.engaged);
        let b = self.layout.scroll_box();
        // A stretch is taken back first, then the scroll moves; past an edge the rest stretches.
        let max_left = b.max_scroll_left(self.zoom).max(0.0);
        let max_top = b.max_scroll_top(self.zoom).max(0.0);
        let mut ty = self.st + self.over.y + dy;
        if self.layout.pull && !self.pointers.is_empty() && !engaged {
            // Past the end: the movement becomes pull; moving back takes the pull back first.
            if self.pull_raw > 0.0 && dy < 0.0 {
                let back = self.pull_raw.min(-dy);
                self.pull_raw -= back;
                dy += back;
                ty += back;
                self.report_pull();
            }
            if dy > 0.0 && ty > max_top - PULL_EDGE {
                let extra = ty - (self.st + self.over.y).max(max_top);
                ty -= extra;
                self.pull_raw += extra;
                self.report_pull();
            }
        }
        let tx = self.sl + self.over.x + dx;
        self.sl = tx.clamp(0.0, max_left);
        self.st = ty.clamp(0.0, max_top);
        self.over = P {
            x: tx - self.sl,
            y: ty - self.st,
        };
        if self.over.x != 0.0 {
            self.bounce[0] = None;
        }
        if self.over.y != 0.0 {
            self.bounce[1] = None;
        }
    }

    /// The view's size (view px), for the rubber band.
    fn dims(&self) -> (f64, f64) {
        (self.layout.view[2].max(1.0), self.layout.view[3].max(1.0))
    }

    /// The stretch past the edges shown now (scroll px, signed as sl / st).
    fn stretch_now(&self, now: f64) -> P {
        let (w, h) = self.dims();
        let axis = |i: usize, raw: f64, d: f64| {
            if raw != 0.0 {
                rubber(raw, d)
            } else {
                self.bounce[i].map_or(0.0, |s| spring(s.x0, s.v0, now - s.t0).0)
            }
        };
        P {
            x: axis(0, self.over.x, w),
            y: axis(1, self.over.y, h),
        }
    }

    /// The fingers lifted with the content stretched: it springs back from where it shows.
    fn release_stretch(&mut self, now: f64) {
        let shown = self.stretch_now(now);
        for (i, (raw, x)) in [(self.over.x, shown.x), (self.over.y, shown.y)].into_iter().enumerate() {
            if raw != 0.0 {
                self.bounce[i] = Some(Spring { x0: x, v0: 0.0, t0: now });
            }
        }
        self.over = P::default();
    }

    /// A finger came down on a stretch going back: held where it shows. A settling pinch ends.
    fn catch_stretch(&mut self, now: f64) {
        let shown = self.stretch_now(now);
        let (w, h) = self.dims();
        if self.bounce[0].is_some() {
            self.over.x = rubber_inverse(shown.x, w);
        }
        if self.bounce[1].is_some() {
            self.over.y = rubber_inverse(shown.y, h);
        }
        self.bounce = [None, None];
        self.settle = None;
    }

    fn report_pull(&mut self) {
        let d = self.pull_raw * PULL_RESISTANCE;
        if !self.pinch.is_some_and(|p| p.engaged) {
            self.pull_release = None;
            self.pull_shown = d.max(0.0);
        }
        self.reported_pull = d;
        if d >= PULL_THRESHOLD {
            self.pull_raw = 0.0;
            self.pull_shown = 0.0;
            self.reported_pull = 0.0;
            self.pulls += 1;
        }
    }

    fn release_pull(&mut self, now: f64, animate: bool) {
        if self.pull_raw == 0.0 {
            return;
        }
        self.pull_raw = 0.0;
        let from = self.pull_now(now);
        self.pull_release = (animate && from > 0.0).then_some(Release { from, t0: now });
        self.pull_shown = 0.0;
        self.reported_pull = 0.0;
    }

    fn start_momentum(&mut self, now: f64) {
        if self.velocity.x.hypot(self.velocity.y) < MOMENTUM_MIN_SPEED {
            return;
        }
        self.momentum = Some(Momentum {
            vx: self.velocity.x,
            vy: self.velocity.y,
            t0: now,
        });
    }

    // --------------------------------------------------------------------------------------------
    // Each display frame.

    /// Advances momentum, the pull's release and glides to `t` (seconds), and applies the fingers'
    /// movement since the last frame. The camera to draw.
    pub fn tick(&mut self, t: f64) -> &Camera {
        if !t.is_finite() {
            return &self.cam;
        }
        let now = t * 1000.0;
        if self.pending != P::default() || self.moving() {
            self.by_page = false;
        }
        if self.pending != P::default() {
            self.flush_scroll();
        }
        if let Some(m) = self.momentum {
            if now > m.t0 {
                self.by_page = false;
                let (dx, dy, mut vx, mut vy) = momentum_step_exact(m.vx, m.vy, now - m.t0);
                let b = self.layout.scroll_box();
                let (w, h) = self.dims();
                let max_left = b.max_scroll_left(self.zoom).max(0.0);
                let max_top = b.max_scroll_top(self.zoom).max(0.0);
                // Reaching an edge, the glide runs on past it on a spring and comes back.
                let mut edge = |i: usize, s: &mut f64, d: f64, max: f64, v: &mut f64, len: f64| {
                    let next = *s - d;
                    *s = next.clamp(0.0, max);
                    if next != *s {
                        let cap = BOUNCE_MAX * len * SPRING_W * std::f64::consts::E;
                        self.bounce[i] = Some(Spring { x0: 0.0, v0: (-*v).clamp(-cap, cap), t0: now });
                        *v = 0.0;
                    }
                };
                let (mut sl, mut st) = (self.sl, self.st);
                edge(0, &mut sl, dx, max_left, &mut vx, w);
                edge(1, &mut st, dy, max_top, &mut vy, h);
                self.sl = sl;
                self.st = st;
                self.momentum = (vx.hypot(vy) > MOMENTUM_STOP_SPEED)
                    .then_some(Momentum { vx, vy, t0: now });
            }
        }
        if let Some(r) = self.pull_release {
            if now - r.t0 >= PULL_RELEASE_MS {
                self.pull_release = None;
            }
        }
        if let Some(r) = self.page_pull_release {
            if now - r.t0 >= PULL_RELEASE_MS {
                self.page_pull_release = None;
            }
        }
        for i in 0..2 {
            if let Some(s) = self.bounce[i] {
                let (x, v) = spring(s.x0, s.v0, now - s.t0);
                if now > s.t0 && x.abs() < 0.05 && v.abs() < 0.002 {
                    self.bounce[i] = None;
                }
            }
        }
        if let Some(s) = self.settle {
            if spring(1.0, 0.0, now - s.t0).0 < 0.002 {
                self.settle = None;
            }
        }
        if let Some(g) = self.glide {
            let u = ((now - g.t0) / g.ms).clamp(0.0, 1.0);
            // CSS `ease`, as browsers' smooth scrolling roughly is.
            self.st = g.from + (g.to - g.from) * cubic_bezier(0.25, 0.1, 0.25, 1.0, u);
            self.clamp_scroll();
            if u >= 1.0 {
                self.glide = None;
            }
        }
        self.recompute_at(now);
        &self.cam
    }

    /// Navigation active (fingers down moving camera or momentum glide).
    pub fn busy(&self) -> bool {
        self.two || (self.layout.single && self.navigating) || self.moving()
    }

    /// Fingers down moving the camera.
    pub fn gesture(&self) -> bool {
        !self.pointers.is_empty() && (self.two || (self.layout.single && self.navigating))
    }

    /// Momentum, the pull's release or a glide.
    pub fn moving(&self) -> bool {
        self.momentum.is_some()
            || self.pull_release.is_some()
            || self.page_pull_release.is_some()
            || self.glide.is_some()
            || self.bounce.iter().any(Option::is_some)
            || self.settle.is_some()
    }

    /// Momentum after the fingers lifted.
    pub fn gliding(&self) -> bool {
        self.momentum.is_some()
    }

    pub fn camera(&self) -> &Camera {
        &self.cam
    }

    /// The page's surface (CanvasPage's box) in device px: (scale, x, y) of its corner.
    pub fn surface_device(&self) -> (f64, f64, f64) {
        self.layout.surface_at(self.cam.x, self.cam.y, self.cam.ez)
    }

    /// The page in view (Editor `currentPage`: the one at a third of the screen's height). A
    /// binary search over the sheets' tops (laid out down the page in order: the same answer as
    /// `sheet_index_at_top`'s walk): read with every camera the page is sent, so never a walk
    /// over the note's sheets (ADR-007).
    pub fn current_sheet(&self) -> usize {
        let y = (self.st + self.layout.view[3] / 3.0) / self.zoom - self.layout.surface[1];
        match self.layout.sheets.get(1..) {
            Some(rest) => rest.partition_point(|s| s[1] <= y),
            None => 0,
        }
    }

    /// Editor `fitTarget`: the page in view's left edge and width (content px).
    pub fn fit_target(&self) -> (f64, f64) {
        match self.layout.sheets.get(self.current_sheet()) {
            Some(s) => (self.layout.surface[0] + s[0], s[2]),
            None => (0.0, self.layout.scroll_box().content_w),
        }
    }

    // --------------------------------------------------------------------------------------------
    // Placement (useViewport setView / applyAnchor / contentCorner / anchorAt).

    fn clamp_scroll(&mut self) {
        let b = self.layout.scroll_box();
        self.sl = self.sl.clamp(0.0, b.max_scroll_left(self.zoom).max(0.0));
        self.st = self.st.clamp(0.0, b.max_scroll_top(self.zoom).max(0.0));
    }

    /// The content's corner as laid out and placed (no CSS transform).
    fn placed_corner(&self) -> P {
        let b = self.layout.scroll_box();
        P {
            x: b.margin_left(self.zoom) - self.sl + self.sub.x,
            y: -self.st + self.sub.y,
        }
    }

    fn pull_now(&self, now: f64) -> f64 {
        match self.pull_release {
            Some(r) => r.from * pull_left(now - r.t0),
            None => self.pull_shown,
        }
    }

    fn page_pull_now(&self, now: f64) -> f64 {
        match self.page_pull_release {
            Some(r) => r.from * pull_left(now - r.t0),
            None => self.page_pull,
        }
    }

    /// The content's corner on screen and its scale, every transform included.
    fn visual(&self, now: f64) -> (P, f64) {
        if let Some(p) = self.pinch.filter(|p| p.engaged) {
            return self.pinch_visual(&p);
        }
        let c = self.placed_corner();
        let s = self.stretch_now(now);
        let to = P {
            x: c.x - s.x,
            y: c.y - s.y - self.pull_now(now) - self.page_pull_now(now),
        };
        let Some(st) = self.settle else {
            return (to, self.zoom);
        };
        // From the release's picture to the committed one: a scaling about the point both share
        // (or a translation), its share left going down on the spring.
        let left = spring(1.0, 0.0, now - st.t0).0;
        let r0 = st.ez / self.zoom;
        if (r0 - 1.0).abs() < 1e-9 {
            return (
                P {
                    x: to.x + (st.from.x - to.x) * left,
                    y: to.y + (st.from.y - to.y) * left,
                },
                self.zoom,
            );
        }
        let f = P {
            x: (st.from.x - r0 * to.x) / (1.0 - r0),
            y: (st.from.y - r0 * to.y) / (1.0 - r0),
        };
        let r = 1.0 + (r0 - 1.0) * left;
        (
            P {
                x: f.x + (to.x - f.x) * r,
                y: f.y + (to.y - f.y) * r,
            },
            self.zoom * r,
        )
    }

    /// A pinch as shown: the content point first between the fingers stays under them, the zoom
    /// past its limits and the content past its edges rubber-banded (what the release would clamp).
    fn pinch_visual(&self, p: &Pinch) -> (P, f64) {
        let b = self.layout.scroll_box();
        let (w, h) = self.dims();
        let zc = p.z0 * p.k;
        let zr = p.z0 * p.kr;
        let zs = if zr.is_finite() && zr > 0.0 && (zr / zc - 1.0).abs() > 1e-12 {
            zc * rubber((zr / zc).ln(), ZOOM_RUBBER).exp()
        } else {
            zc
        };
        let a = Anchor {
            cx: p.o.x / p.z0,
            cy: p.o.y / p.z0,
            sx: p.c.x,
            sy: p.c.y,
        };
        // Past the edges at the committed zoom: where the fingers put the corner, less where the
        // release would place it.
        let pl = place_anchor(&b, zc, a);
        let ex = (a.sx - a.cx * zc) - (b.margin_left(zc) - pl.scroll_left + pl.dx);
        let ey = (a.sy - a.cy * zc) - (-pl.scroll_top + pl.dy);
        (
            P {
                x: a.sx - a.cx * zs - ex + rubber(ex, w),
                y: a.sy - a.cy * zs - ey + rubber(ey, h),
            },
            zs,
        )
    }

    /// useViewport `contentCorner` (the content's box on screen, transforms included).
    fn content_corner(&self) -> P {
        self.visual(self.release_clock()).0
    }

    /// The time the visual is evaluated at between frames: the last frame's.
    fn release_clock(&self) -> f64 {
        self.cam_time
    }

    /// useViewport `anchorAt`: the content point under the view point (sx, sy).
    pub fn anchor_at(&self, sx: f64, sy: f64) -> Anchor {
        let o = self.content_corner();
        Anchor {
            cx: (sx - o.x) / self.zoom,
            cy: (sy - o.y) / self.zoom,
            sx,
            sy,
        }
    }

    fn set_view_inner(&mut self, z: f64, a: Option<Anchor>, floor: f64) {
        if !self.has_layout || !z.is_finite() {
            return;
        }
        let b = self.layout.scroll_box();
        let z = clamp_zoom(z, b.client_w, b.content_w, floor);
        let a = a.unwrap_or_else(|| self.anchor_at(b.client_w / 2.0, b.client_h / 2.0));
        if (z - self.zoom).abs() >= 1e-4 {
            self.zoom = z;
        }
        self.apply_anchor(a);
    }

    /// applyAnchor: `a` placed at the committed zoom; the content's transform (pinch, pull) goes.
    fn apply_anchor(&mut self, a: Anchor) {
        self.pull_shown = 0.0;
        self.pull_release = None;
        let p = place_anchor(&self.layout.scroll_box(), self.zoom, a);
        self.sl = p.scroll_left;
        self.st = p.scroll_top;
        self.sub = P { x: p.dx, y: p.dy };
        self.placed += 1;
        self.by_page = false;
    }

    fn recompute(&mut self) {
        let t = self.cam_time;
        self.recompute_at(t);
    }

    fn recompute_at(&mut self, now: f64) {
        self.cam_time = now;
        let (corner, ez) = self.visual(now);
        let next = Camera {
            seq: self.cam.seq,
            zoom: self.zoom,
            sl: self.sl,
            st: self.st,
            x: corner.x,
            y: corner.y,
            ez,
            fit: self.fit,
            pull: self.reported_pull,
            pulls: self.pulls,
            placed: self.placed,
            gesture: self.gesture(),
            moving: self.moving(),
            by_page: self.cam.by_page,
        };
        if next != self.cam {
            self.cam = Camera {
                seq: self.cam.seq + 1,
                by_page: self.by_page,
                ..next
            };
        }
    }
}
