//! The camera's arithmetic: src/editor/viewportMath.ts line for line (useViewport.ts calls it).
//! Every constant keeps its TypeScript name; times are in ms, as there. Checked against the
//! TypeScript by tests/reference.rs (`npm run bench:rustref -- bench/rust-ref/viewport.json
//! --module viewport`).

/// viewportMath.ts `FIT_MARGIN`: screen px between a page fitted to the width and each edge.
pub const FIT_MARGIN: f64 = 2.0;
/// `FIT_SNAP`: a pinch ending within this fraction of the fit-to-width zoom snaps to it.
pub const FIT_SNAP: f64 = 0.08;
/// `MIN_ZOOM`, `MAX_ZOOM`: the zoom's limits (below MIN_ZOOM only as far as fitting needs).
pub const MIN_ZOOM: f64 = 0.5;
pub const MAX_ZOOM: f64 = 5.0;
/// `MIN_FIT_ZOOM`: the least zoom fitting the width gives.
pub const MIN_FIT_ZOOM: f64 = 0.05;
/// `PINCH_START`: two fingers zoom once their spread changed this much (before, they scroll).
pub const PINCH_START: f64 = 0.05;
/// `REBASE_RATIO`, `REBASE_MIN_MS`: a pinch that scaled this much since its committed zoom
/// commits it while the fingers are down, at most this often.
pub const REBASE_RATIO: f64 = 1.5;
pub const REBASE_MIN_MS: f64 = 250.0;
/// `TAP_MAX_MS`, `TAP_SLOP`: a two-finger tap (the page's undo) does not fling.
pub const TAP_MAX_MS: f64 = 320.0;
pub const TAP_SLOP: f64 = 14.0;
/// `PULL_THRESHOLD`: pull (after resistance) that adds a page; `PULL_RESISTANCE`: pull per px
/// of finger travel past the end; `PULL_RELEASE_MS`: it goes back over this long; `PULL_EDGE`:
/// travel within this of the end already pulls.
pub const PULL_THRESHOLD: f64 = 110.0;
pub const PULL_RESISTANCE: f64 = 0.5;
pub const PULL_RELEASE_MS: f64 = 220.0;
pub const PULL_EDGE: f64 = 0.5;
/// `MOMENTUM_DECAY`: UIScrollView's normal deceleration rate, per ms. `MOMENTUM_MAX_DT`: one
/// step covers at most this (ms). `MOMENTUM_MIN_SPEED` / `MOMENTUM_STOP_SPEED`: px/ms.
pub const MOMENTUM_DECAY: f64 = 0.998;
pub const MOMENTUM_MAX_DT: f64 = 32.0;
pub const MOMENTUM_MIN_SPEED: f64 = 0.1;
pub const MOMENTUM_STOP_SPEED: f64 = 0.01;
/// `VELOCITY_WINDOW_MS`, `VELOCITY_MIN_DT`, `RELEASE_RECENT_MS`: the release velocity.
pub const VELOCITY_WINDOW_MS: f64 = 80.0;
pub const VELOCITY_MIN_DT: f64 = 8.0;
pub const RELEASE_RECENT_MS: f64 = 80.0;

/// JavaScript's `Math.round` (halves toward +infinity; `f64::round` takes them away from zero).
pub fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// `Math.min` / `Math.max` of two numbers, NaN as JavaScript has it (NaN wins).
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// `clampZoom`: below MIN_ZOOM only as far as fitting the width (or `floor`) needs.
pub fn clamp_zoom(z: f64, client_w: f64, content_w: f64, floor: f64) -> f64 {
    let fit_w = client_w / content_w;
    js_max(js_min(js_min(MIN_ZOOM, fit_w), floor), js_min(MAX_ZOOM, z))
}

/// `fitWidthZoom`: the zoom fitting `width` content px on screen, FIT_MARGIN from either edge.
pub fn fit_width_zoom(client_w: f64, width: f64) -> f64 {
    js_max(
        MIN_FIT_ZOOM,
        (client_w - 2.0 * FIT_MARGIN) / js_max(1.0, width),
    )
}

/// `pinchZoom`: the pinch's zoom from its start zoom and the fingers' spread then and now.
pub fn pinch_zoom(z0: f64, spread: f64, d0: f64, client_w: f64, content_w: f64) -> f64 {
    let fit_w = client_w / content_w;
    js_max(
        js_min(MIN_ZOOM, fit_w),
        js_min(MAX_ZOOM, z0 * (spread / d0)),
    )
}

/// `snapsToFit`: a pinch ending at `z` snaps to the fit-to-width zoom `zf`.
pub fn snaps_to_fit(z: f64, zf: f64) -> bool {
    (z / zf - 1.0).abs() < FIT_SNAP
}

/// `shouldRebase`: the pinch scaled by `k` since its zoom was committed `since_ms` ago.
pub fn should_rebase(k: f64, since_ms: f64) -> bool {
    k.ln().abs() > REBASE_RATIO.ln() && since_ms > REBASE_MIN_MS
}

/// `subPixel`: what a placement's clamp or rounding left, as a translation only under 1 px.
pub fn sub_pixel(d: f64) -> f64 {
    if d.abs() < 1.0 {
        js_round(d * 100.0) / 100.0
    } else {
        0.0
    }
}

/// `momentumStep`: (scroll moved back by dx, dy; speed after) for a step of `dt_ms`.
pub fn momentum_step(vx: f64, vy: f64, dt_ms: f64) -> (f64, f64, f64, f64) {
    let dt = js_min(MOMENTUM_MAX_DT, dt_ms);
    let decay = MOMENTUM_DECAY.powf(dt);
    (vx * dt, vy * dt, vx * decay, vy * decay)
}

/// Exact continuous exponential integration:
/// \int_0^{dt} v(t) dt = v0 * (1 - decay) / (-ln(MOMENTUM_DECAY))
/// Mathematically invariant across any refresh rate (60 Hz, 120 Hz, 240 Hz).
pub fn momentum_step_exact(vx: f64, vy: f64, dt_ms: f64) -> (f64, f64, f64, f64) {
    let dt = js_min(MOMENTUM_MAX_DT, js_max(0.0, dt_ms));
    let decay = MOMENTUM_DECAY.powf(dt);
    const LAMBDA: f64 = 0.0020020026706730793; // -0.998f64.ln()
    let int_dt = if dt > 1e-6 {
        (1.0 - decay) / LAMBDA
    } else {
        dt
    };
    (vx * int_dt, vy * int_dt, vx * decay, vy * decay)
}

/// `releaseVelocity`: px/ms from recent positions `(x, y, t_ms)`, oldest first.
pub fn release_velocity(h: &[(f64, f64, f64)]) -> (f64, f64) {
    match (h.first(), h.last()) {
        (Some(f), Some(l)) if l.2 - f.2 > VELOCITY_MIN_DT => {
            let dt = l.2 - f.2;
            ((l.0 - f.0) / dt, (l.1 - f.1) / dt)
        }
        _ => (0.0, 0.0),
    }
}

/// `cubicBezier`: CSS cubic-bezier(x1, y1, x2, y2) at progress `u`.
pub fn cubic_bezier(x1: f64, y1: f64, x2: f64, y2: f64, u: f64) -> f64 {
    if u <= 0.0 {
        return 0.0;
    }
    if u >= 1.0 {
        return 1.0;
    }
    let bx =
        |t: f64| ((1.0 - 3.0 * x2 + 3.0 * x1) * t + (3.0 * x2 - 6.0 * x1)) * t * t + 3.0 * x1 * t;
    let by =
        |t: f64| ((1.0 - 3.0 * y2 + 3.0 * y1) * t + (3.0 * y2 - 6.0 * y1)) * t * t + 3.0 * y1 * t;
    let (mut lo, mut hi) = (0.0, 1.0);
    for _ in 0..60 {
        let t = (lo + hi) / 2.0;
        if bx(t) < u {
            lo = t;
        } else {
            hi = t;
        }
    }
    by((lo + hi) / 2.0)
}

/// `pullLeft`: the share of the pull left `ms` after its release.
pub fn pull_left(ms: f64) -> f64 {
    1.0 - cubic_bezier(0.2, 0.8, 0.2, 1.0, ms / PULL_RELEASE_MS)
}

/// `ScrollBox`: the scroll view's client size and the content's unzoomed size.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScrollBox {
    pub client_w: f64,
    pub client_h: f64,
    pub content_w: f64,
    pub content_h: f64,
}

impl ScrollBox {
    /// `marginLeft`: `margin: 0 auto` centres content narrower than the screen.
    pub fn margin_left(&self, z: f64) -> f64 {
        js_max(0.0, (self.client_w - self.content_w * z) / 2.0)
    }
    pub fn max_scroll_left(&self, z: f64) -> f64 {
        js_max(0.0, self.content_w * z - self.client_w)
    }
    pub fn max_scroll_top(&self, z: f64) -> f64 {
        js_max(0.0, self.content_h * z - self.client_h)
    }
}

/// A content point (unscaled px) and where it goes on screen (scroll view px).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Anchor {
    pub cx: f64,
    pub cy: f64,
    pub sx: f64,
    pub sy: f64,
}

/// Where `placeAnchor` puts the content: scroll positions and the sub-pixel rest.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Placement {
    pub scroll_left: f64,
    pub scroll_top: f64,
    pub dx: f64,
    pub dy: f64,
}

/// `placeAnchor`: what the browser makes of useViewport's applyAnchor at zoom `z`.
pub fn place_anchor(b: &ScrollBox, z: f64, a: Anchor) -> Placement {
    let m = b.margin_left(z);
    let scroll_left = js_min(b.max_scroll_left(z), js_max(0.0, a.cx * z + m - a.sx));
    let scroll_top = js_min(b.max_scroll_top(z), js_max(0.0, a.cy * z - a.sy));
    Placement {
        scroll_left,
        scroll_top,
        dx: sub_pixel(a.sx - (a.cx * z + m - scroll_left)),
        dy: sub_pixel(a.sy - (a.cy * z - scroll_top)),
    }
}

/// `sheetIndexAtTop`: the page at surface height `y`, from the pages' tops.
pub fn sheet_index_at_top(tops: &[f64], y: f64) -> usize {
    let mut k = 0;
    while k + 1 < tops.len() && tops[k + 1] <= y {
        k += 1;
    }
    k
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_round_takes_halves_up() {
        assert_eq!(js_round(-12.5), -12.0);
        assert_eq!(js_round(12.5), 13.0);
        assert_eq!(sub_pixel(-0.125), -0.12);
        assert_eq!(sub_pixel(1.5), 0.0);
    }

    #[test]
    fn zoom_limits() {
        // A 1000 px wide content on an 800 px screen: fitting needs 0.8 > MIN_ZOOM, so 0.5.
        assert_eq!(clamp_zoom(0.1, 800.0, 1000.0, f64::INFINITY), 0.5);
        // On a 300 px phone the fit (0.3) is allowed below MIN_ZOOM.
        assert_eq!(clamp_zoom(0.1, 300.0, 1000.0, f64::INFINITY), 0.3);
        assert_eq!(clamp_zoom(9.0, 800.0, 1000.0, f64::INFINITY), MAX_ZOOM);
        // Fitting a page (floor) goes lower.
        assert_eq!(clamp_zoom(0.2, 800.0, 1000.0, 0.2), 0.2);
    }

    #[test]
    fn fit_and_snap() {
        let zf = fit_width_zoom(820.0, 816.0);
        assert!((zf - 816.0 / 816.0).abs() < 1e-12);
        assert!(snaps_to_fit(zf * 1.07, zf));
        assert!(!snaps_to_fit(zf * 1.09, zf));
        assert_eq!(fit_width_zoom(10.0, 1e6), MIN_FIT_ZOOM);
    }

    #[test]
    fn rebase_needs_ratio_and_time() {
        assert!(should_rebase(1.6, 300.0));
        assert!(should_rebase(1.0 / 1.6, 300.0));
        assert!(!should_rebase(1.4, 300.0));
        assert!(!should_rebase(1.6, 200.0));
    }

    #[test]
    fn momentum_decays_per_ms_and_caps_the_step() {
        let (dx, dy, vx, vy) = momentum_step(1.0, -2.0, 100.0);
        assert_eq!((dx, dy), (32.0, -64.0));
        assert!(
            (vx - 0.998f64.powi(32)).abs() < 1e-15 && (vy + 2.0 * 0.998f64.powi(32)).abs() < 1e-15
        );
    }

    #[test]
    fn velocity_needs_more_than_8_ms() {
        assert_eq!(
            release_velocity(&[(0.0, 0.0, 0.0), (10.0, 0.0, 8.0)]),
            (0.0, 0.0)
        );
        assert_eq!(
            release_velocity(&[(0.0, 0.0, 0.0), (10.0, 5.0, 10.0)]),
            (1.0, 0.5)
        );
        assert_eq!(release_velocity(&[]), (0.0, 0.0));
    }

    #[test]
    fn pull_goes_back_in_220_ms() {
        assert_eq!(pull_left(0.0), 1.0);
        assert_eq!(pull_left(220.0), 0.0);
        let mid = pull_left(110.0);
        assert!(mid > 0.0 && mid < 0.2, "{mid}");
    }

    #[test]
    fn anchors_are_clamped_to_the_scroll_range() {
        let b = ScrollBox {
            client_w: 800.0,
            client_h: 1000.0,
            content_w: 1000.0,
            content_h: 5000.0,
        };
        // Zoomed out: centred, no horizontal scroll; the anchor's x cannot be kept.
        let p = place_anchor(
            &b,
            0.5,
            Anchor {
                cx: 500.0,
                cy: 100.0,
                sx: 0.0,
                sy: 0.0,
            },
        );
        assert_eq!(p.scroll_left, 0.0);
        assert_eq!(p.scroll_top, 50.0);
        // Zoomed in, kept exactly.
        let p = place_anchor(
            &b,
            2.0,
            Anchor {
                cx: 300.0,
                cy: 400.0,
                sx: 100.0,
                sy: 200.0,
            },
        );
        assert_eq!(
            (p.scroll_left, p.scroll_top, p.dx, p.dy),
            (500.0, 600.0, 0.0, 0.0)
        );
        // Past the top: 0.4 px short is made up by the translation.
        let p = place_anchor(
            &b,
            1.0,
            Anchor {
                cx: 0.0,
                cy: 0.0,
                sx: 0.0,
                sy: 0.4,
            },
        );
        assert_eq!((p.scroll_top, p.dy), (0.0, 0.4));
    }

    #[test]
    fn sheet_at_height() {
        let tops = [0.0, 1000.0, 2000.0];
        assert_eq!(sheet_index_at_top(&tops, -5.0), 0);
        assert_eq!(sheet_index_at_top(&tops, 1000.0), 1);
        assert_eq!(sheet_index_at_top(&tops, 99999.0), 2);
    }
}
