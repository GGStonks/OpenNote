//! The camera's behaviours, each as useViewport.ts has it (the TypeScript lines named).

use viewport::math::*;
use viewport::{Anchor, Camera, FitMode, Layout, Phase, SavedView, Viewport};

const PAD: f64 = 8.0;
const TAIL: f64 = 88.0;
const PAGE_W: f64 = 816.0;
const PAGE_H: f64 = 1056.0;

/// A note of `pages` Letter pages laid out as Editor.tsx does, on an 820 x 1110 scroll view.
fn layout(pages: usize) -> Layout {
    let sheets: Vec<[f64; 4]> = (0..pages)
        .map(|i| [0.0, i as f64 * PAGE_H, PAGE_W, PAGE_H])
        .collect();
    Layout {
        view: [0.0, 70.0, 820.0, 1110.0],
        content: [PAGE_W + 2.0 * PAD, PAD + pages as f64 * PAGE_H + PAD + TAIL],
        surface: [PAD, PAD],
        sheets,
        pull: true,
        single: false,
        holes: vec![],
        dpr: 2.0,
        frame_ms: 1000.0 / 60.0,
        owned: true,
        ..Layout::default()
    }
}

/// A camera fitted to the width at the top of the note.
fn fitted(pages: usize) -> Viewport {
    let mut v = Viewport::new();
    v.set_layout(layout(pages));
    v.fit_width(None);
    v
}

/// Fingers moved from `a` to `b` in `ms`, an event every 8 ms, the display ticking at `hz`.
/// Returns the time at the end (s).
fn fingers(
    v: &mut Viewport,
    a: &[(f64, f64)],
    b: &[(f64, f64)],
    t0: f64,
    ms: f64,
    hz: f64,
    lift: bool,
) -> f64 {
    for (i, p) in a.iter().enumerate() {
        v.touch(i as i64, Phase::Began, p.0, p.1, t0);
    }
    let n = (ms / 8.0).round().max(1.0) as usize;
    let mut next_tick = t0;
    let mut t = t0;
    for s in 1..=n {
        t = t0 + s as f64 * 0.008;
        while next_tick <= t {
            v.tick(next_tick);
            next_tick += 1.0 / hz;
        }
        let u = s as f64 / n as f64;
        for (i, (p, q)) in a.iter().zip(b).enumerate() {
            v.touch(
                i as i64,
                Phase::Moved,
                p.0 + (q.0 - p.0) * u,
                p.1 + (q.1 - p.1) * u,
                t,
            );
        }
    }
    v.tick(t);
    if lift {
        for (i, q) in b.iter().enumerate().take(a.len()) {
            v.touch(i as i64, Phase::Ended, q.0, q.1, t);
        }
    }
    t
}

/// A two-finger fling up by `dy` in `ms`, the fingers lifting as real ones do: one first, the
/// other moving on alone for 24 ms (useViewport resets the release velocity whenever a finger
/// lifts: lifted together, two fingers never fling, in the page as here). The time after.
fn fling(v: &mut Viewport, y0: f64, dy: f64, ms: f64, hz: f64) -> f64 {
    let a = [(360.0, y0), (460.0, y0)];
    let b = [(360.0, y0 - dy), (460.0, y0 - dy)];
    let mut t = fingers(v, &a, &b, 1.0, ms, hz, false);
    v.touch(1, Phase::Ended, 460.0, y0 - dy, t);
    let speed = dy / ms * 8.0;
    for s in 1..=3 {
        t += 0.008;
        v.touch(0, Phase::Moved, 360.0, y0 - dy - speed * s as f64, t);
        v.tick(t);
    }
    v.touch(0, Phase::Ended, 360.0, y0 - dy - speed * 3.0, t);
    t
}

/// Ticks at `hz` from `t` for `ms`; the time after.
fn run(v: &mut Viewport, t: f64, ms: f64, hz: f64) -> f64 {
    let n = (ms / 1000.0 * hz).round() as usize;
    let mut t = t;
    for _ in 0..n {
        t += 1.0 / hz;
        v.tick(t);
    }
    t
}

/// The content point (unscaled px) under view point (x, y), from the camera as drawn.
fn content_at(c: &Camera, x: f64, y: f64) -> (f64, f64) {
    ((x - c.x) / c.ez, (y - c.y) / c.ez)
}

fn close(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() <= tol
}

#[test]
fn fits_the_width_at_the_start() {
    let v = fitted(5);
    let c = v.camera();
    let zf = fit_width_zoom(820.0, PAGE_W);
    assert!(close(c.zoom, zf, 1e-12));
    assert_eq!(c.fit, Some(FitMode::Width));
    // The page's left edge FIT_MARGIN from the screen's.
    assert!(
        close(c.x + (PAD) * c.ez, FIT_MARGIN, 1e-9),
        "{}",
        c.x + PAD * c.ez
    );
}

#[test]
fn two_fingers_scroll_the_page() {
    let mut v = fitted(5);
    let st0 = v.camera().st;
    fingers(
        &mut v,
        &[(360.0, 600.0), (460.0, 600.0)],
        &[(360.0, 300.0), (460.0, 300.0)],
        1.0,
        200.0,
        120.0,
        false,
    );
    let c = v.camera().clone();
    assert!(close(c.st - st0, 300.0, 1e-6), "scrolled {}", c.st - st0);
    assert!(c.gesture);
    assert!(close(c.zoom, fit_width_zoom(820.0, PAGE_W), 1e-12));
}

#[test]
fn a_small_spread_change_still_scrolls() {
    let mut v = fitted(5);
    // 4% wider: under PINCH_START.
    fingers(
        &mut v,
        &[(360.0, 600.0), (460.0, 600.0)],
        &[(358.0, 500.0), (462.0, 500.0)],
        1.0,
        100.0,
        120.0,
        true,
    );
    let c = v.camera();
    assert!(close(c.zoom, fit_width_zoom(820.0, PAGE_W), 1e-12));
    assert!(c.st > 90.0);
}

#[test]
fn a_pinch_zooms_about_the_fingers() {
    let mut v = fitted(5);
    let c0 = v.camera().clone();
    // The content point between the fingers when the pinch starts (just past PINCH_START).
    let mid = (410.0, 600.0);
    let p0 = content_at(&c0, mid.0, mid.1);
    fingers(
        &mut v,
        &[(360.0, 600.0), (460.0, 600.0)],
        &[(310.0, 600.0), (510.0, 600.0)],
        1.0,
        150.0,
        120.0,
        false,
    );
    let c = v.camera().clone();
    // Spread doubled: twice the zoom (the engage point at 1.05x is the reference: the first
    // 5% stayed at the old scale).
    assert!(
        close(c.ez / c0.zoom, 200.0 / 105.0, 0.02),
        "{}",
        c.ez / c0.zoom
    );
    let p = content_at(&c, mid.0, mid.1);
    // The point first between the fingers is still between them (within the engage step).
    assert!(
        close(p.0, p0.0, 3.0) && close(p.1, p0.1, 3.0),
        "{p:?} vs {p0:?}"
    );
}

#[test]
fn zoom_limits_hold() {
    let mut v = fitted(5);
    // Spread x10: past MAX_ZOOM the zoom shown is rubber-banded (never past ZOOM_RUBBER in log
    // zoom); the release commits MAX_ZOOM without a jump and the picture settles on it.
    fingers(
        &mut v,
        &[(400.0, 600.0), (420.0, 600.0)],
        &[(310.0, 600.0), (510.0, 600.0)],
        1.0,
        300.0,
        120.0,
        false,
    );
    let shown = v.camera().ez;
    assert!(shown > MAX_ZOOM && shown < MAX_ZOOM * ZOOM_RUBBER.exp(), "{shown}");
    let t = fingers(&mut v, &[], &[], 2.0, 8.0, 120.0, false);
    for i in 0..2 {
        v.touch(i, Phase::Ended, 0.0, 0.0, t);
    }
    assert!(close(v.camera().zoom, MAX_ZOOM, 1e-9));
    assert!(close(v.camera().ez, shown, 1e-9), "jumped at the release: {} vs {shown}", v.camera().ez);
    assert!(v.moving());
    run(&mut v, t, 600.0, 120.0);
    assert!(close(v.camera().ez, MAX_ZOOM, 1e-9), "{}", v.camera().ez);
    assert!(!v.moving());
    // Pinching far in: never above, out: never below min(MIN_ZOOM, fitting the width).
    let mut v = fitted(5);
    fingers(
        &mut v,
        &[(110.0, 600.0), (710.0, 600.0)],
        &[(400.0, 600.0), (410.0, 600.0)],
        1.0,
        300.0,
        120.0,
        true,
    );
    let floor = MIN_ZOOM.min(820.0 / (PAGE_W + 2.0 * PAD));
    assert!(close(v.camera().zoom, floor, 1e-9), "{}", v.camera().zoom);
    assert!(v.camera().ez < floor, "shown past the floor while released: {}", v.camera().ez);
    run(&mut v, 2.0, 600.0, 120.0);
    assert!(close(v.camera().ez, floor, 1e-9), "{}", v.camera().ez);
}

#[test]
fn a_pinch_ending_near_the_page_width_snaps_to_it() {
    let mut v = fitted(5);
    let zf = v.camera().zoom;
    // Out to ~1.06x the fit: snaps back (on a spring from where it was), fitted.
    let t = fingers(
        &mut v,
        &[(300.0, 600.0), (520.0, 600.0)],
        &[(290.0, 600.0), (530.0, 600.0)],
        1.0,
        100.0,
        120.0,
        true,
    );
    assert!(v.camera().ez > zf * 1.03, "the snap jumped: {}", v.camera().ez);
    run(&mut v, t, 600.0, 120.0);
    let c = v.camera();
    assert!(close(c.zoom, zf, 1e-12), "{} vs {zf}", c.zoom);
    assert_eq!(c.fit, Some(FitMode::Width));
    assert!(close(c.x + PAD * c.ez, FIT_MARGIN, 1e-9));
    // Beyond FIT_SNAP: kept, not fitted.
    let mut v = fitted(5);
    fingers(
        &mut v,
        &[(300.0, 600.0), (520.0, 600.0)],
        &[(250.0, 600.0), (570.0, 600.0)],
        1.0,
        100.0,
        120.0,
        true,
    );
    let c = v.camera();
    assert!(c.zoom > zf * (1.0 + FIT_SNAP));
    assert_eq!(c.fit, None);
}

#[test]
fn a_long_pinch_commits_its_zoom_on_the_way() {
    let mut v = fitted(5);
    let z0 = v.camera().zoom;
    // Spread x3 over 600 ms: rebased at 1.5x (and again after REBASE_MIN_MS).
    fingers(
        &mut v,
        &[(380.0, 600.0), (440.0, 600.0)],
        &[(320.0, 600.0), (500.0, 600.0)],
        1.0,
        600.0,
        120.0,
        false,
    );
    assert!(v.rebases >= 1, "rebases {}", v.rebases);
    let c = v.camera().clone();
    assert!(c.zoom > z0 * 1.4, "committed zoom {} from {z0}", c.zoom);
    // The picture did not jump at the rebase: the scale is the fingers' (x3, less the engage step).
    assert!(close(c.ez / z0, 3.0 / 1.05, 0.05), "{}", c.ez / z0);
}

#[test]
fn rebasing_keeps_the_picture_in_place() {
    // The camera just before and just after a rebase (same fingers) shows the same picture.
    let mut v = fitted(5);
    v.touch(0, Phase::Began, 380.0, 600.0, 1.0);
    v.touch(1, Phase::Began, 440.0, 600.0, 1.0);
    let mut t = 1.0;
    let mut prev = v.camera().clone();
    let mut checked = 0;
    for s in 1..=80 {
        t += 0.008;
        let d = 30.0 + s as f64 * 1.5;
        let before = v.rebases;
        v.touch(0, Phase::Moved, 410.0 - d, 600.0 + s as f64, t);
        v.touch(1, Phase::Moved, 410.0 + d, 600.0 + s as f64, t);
        v.tick(t);
        let c = v.camera().clone();
        if v.rebases > before {
            // The fingers' centre moved down 1 px: the content under it is the same.
            let a = content_at(&prev, 410.0, 600.0 + (s - 1) as f64);
            let b = content_at(&c, 410.0, 600.0 + s as f64);
            assert!(close(a.0, b.0, 1.0) && close(a.1, b.1, 1.0), "{a:?} {b:?}");
            checked += 1;
        }
        prev = c;
    }
    assert!(checked >= 1);
}

#[test]
fn a_fling_glides_and_slows_down() {
    let mut v = fitted(8);
    let t = fling(&mut v, 900.0, 400.0, 100.0, 120.0);
    let at_lift = v.camera().st;
    assert!(v.gliding());
    let t = run(&mut v, t, 100.0, 120.0);
    let after_100 = v.camera().st;
    let t = run(&mut v, t, 100.0, 120.0);
    let after_200 = v.camera().st;
    assert!(
        after_100 > at_lift + 100.0,
        "glided {}",
        after_100 - at_lift
    );
    assert!(after_200 - after_100 < after_100 - at_lift, "slows down");
    run(&mut v, t, 6000.0, 120.0);
    assert!(!v.gliding(), "stops");
    // 4 px/ms released: the steps' sum v dt / (1 - 0.998^dt) at 120 Hz, about 2000 px.
    let total = v.camera().st - at_lift;
    let dt = 1000.0 / 120.0;
    assert!(
        close(total, 4.0 * dt / (1.0 - 0.998f64.powf(dt)), 60.0),
        "glide {total}"
    );
}

#[test]
fn the_glide_is_the_same_at_60_and_120_hz() {
    let glide = |hz: f64| {
        let mut v = fitted(8);
        let t = fling(&mut v, 900.0, 400.0, 100.0, hz);
        let a = v.camera().st;
        run(&mut v, t, 6000.0, hz);
        v.camera().st - a
    };
    let (g60, g120) = (glide(60.0), glide(120.0));
    // UIScrollView's per-ms decay over elapsed time: within 1% (the steps' integration).
    assert!((g60 / g120 - 1.0).abs() < 0.01, "{g60} vs {g120}");
}

#[test]
fn a_touch_stops_the_glide() {
    let mut v = fitted(8);
    let t = fling(&mut v, 900.0, 400.0, 100.0, 120.0);
    assert!(v.gliding());
    let t = run(&mut v, t, 50.0, 120.0);
    v.touch(9, Phase::Began, 100.0, 100.0, t);
    let st = v.camera().st;
    run(&mut v, t, 200.0, 120.0);
    assert!(!v.gliding());
    assert_eq!(v.camera().st, st);
}

#[test]
fn no_glide_after_a_pinch_or_a_slow_release() {
    let mut v = fitted(8);
    let t = fingers(
        &mut v,
        &[(360.0, 600.0), (460.0, 600.0)],
        &[(300.0, 500.0), (520.0, 500.0)],
        1.0,
        100.0,
        120.0,
        true,
    );
    assert!(!v.gliding());
    run(&mut v, t, 100.0, 120.0);
    // Held still for 100 ms before lifting.
    let mut v = fitted(8);
    let t = fingers(
        &mut v,
        &[(360.0, 900.0), (460.0, 900.0)],
        &[(360.0, 500.0), (460.0, 500.0)],
        1.0,
        100.0,
        120.0,
        false,
    );
    let t = run(&mut v, t, 100.0, 120.0);
    v.touch(0, Phase::Ended, 360.0, 500.0, t);
    v.touch(1, Phase::Ended, 460.0, 500.0, t);
    assert!(!v.gliding());
}

#[test]
fn the_glide_stops_at_the_top() {
    let mut v = fitted(8);
    v.page_scroll(0.0, 300.0, 0.0, 0.0);
    let t = fling(&mut v, 300.0, -400.0, 100.0, 120.0);
    run(&mut v, t, 2000.0, 120.0);
    assert_eq!(v.camera().st, 0.0);
    assert!(!v.gliding());
}

#[test]
fn a_two_finger_tap_does_not_move_or_glide() {
    let mut v = fitted(5);
    let c0 = v.camera().clone();
    let t = fingers(
        &mut v,
        &[(360.0, 600.0), (460.0, 600.0)],
        &[(361.0, 601.0), (461.0, 601.0)],
        1.0,
        80.0,
        120.0,
        true,
    );
    run(&mut v, t, 300.0, 120.0);
    assert!(!v.gliding());
    assert!(close(v.camera().st, c0.st, 1.5));
}

#[test]
fn pulling_past_the_last_page_adds_one() {
    let mut v = fitted(2);
    let max_top = layout(2).scroll_box().max_scroll_top(v.camera().zoom);
    v.page_scroll(0.0, max_top, 0.0, 0.0);
    // 150 px past the end: 75 px of pull, shown, not yet a page.
    let t = fingers(
        &mut v,
        &[(360.0, 900.0), (460.0, 900.0)],
        &[(360.0, 750.0), (460.0, 750.0)],
        1.0,
        150.0,
        120.0,
        false,
    );
    let c = v.camera().clone();
    assert!(close(c.pull, 75.0, 1e-6), "pull {}", c.pull);
    assert!(
        close(c.y, -max_top - 75.0, 1e-6),
        "the content goes up with it: {}",
        c.y
    );
    assert_eq!(c.pulls, 0);
    // Further: past PULL_THRESHOLD (110 after resistance), one page.
    let t = {
        let mut t = t;
        for s in 1..=20 {
            t += 0.008;
            v.touch(0, Phase::Moved, 360.0, 750.0 - s as f64 * 5.0, t);
            v.touch(1, Phase::Moved, 460.0, 750.0 - s as f64 * 5.0, t);
            v.tick(t);
        }
        t
    };
    assert_eq!(v.camera().pulls, 1);
    v.touch(0, Phase::Ended, 360.0, 650.0, t);
    v.touch(1, Phase::Ended, 460.0, 650.0, t);
    assert!(!v.gliding(), "no fling after a pull");
}

#[test]
fn a_released_pull_goes_back_in_220_ms() {
    let mut v = fitted(2);
    let max_top = layout(2).scroll_box().max_scroll_top(v.camera().zoom);
    v.page_scroll(0.0, max_top, 0.0, 0.0);
    let t = fingers(
        &mut v,
        &[(360.0, 900.0), (460.0, 900.0)],
        &[(360.0, 800.0), (460.0, 800.0)],
        1.0,
        100.0,
        120.0,
        true,
    );
    assert_eq!(v.camera().pull, 0.0, "reported 0 at the release");
    let shown = -max_top - v.camera().y;
    assert!(close(shown, 50.0, 1e-6), "still shown: {shown}");
    let t = run(&mut v, t, 110.0, 120.0);
    let mid = -max_top - v.camera().y;
    assert!(mid > 0.0 && mid < 10.0, "{mid}");
    run(&mut v, t, 120.0, 120.0);
    assert!(close(v.camera().y, -max_top, 1e-9));
    assert!(!v.busy());
}

#[test]
fn one_finger_after_two_keeps_scrolling() {
    let mut v = fitted(5);
    let t = fingers(
        &mut v,
        &[(360.0, 600.0), (460.0, 600.0)],
        &[(360.0, 500.0), (460.0, 500.0)],
        1.0,
        80.0,
        120.0,
        false,
    );
    v.touch(1, Phase::Ended, 460.0, 500.0, t);
    let st = v.camera().st;
    let mut t = t;
    for s in 1..=10 {
        t += 0.008;
        v.touch(0, Phase::Moved, 360.0, 500.0 - s as f64 * 10.0, t);
        v.tick(t);
    }
    assert!(
        close(v.camera().st - st, 100.0, 1e-6),
        "{}",
        v.camera().st - st
    );
    // When one finger scrolls (stylus only): it continues scrolling natively in Rust at 120 Hz.
    let mut l = layout(5);
    l.single = true;
    let mut v = Viewport::new();
    v.set_layout(l);
    v.fit_width(None);
    let t = fingers(
        &mut v,
        &[(360.0, 600.0), (460.0, 600.0)],
        &[(360.0, 500.0), (460.0, 500.0)],
        1.0,
        80.0,
        120.0,
        false,
    );
    v.touch(1, Phase::Ended, 460.0, 500.0, t);
    let st = v.camera().st;
    v.touch(0, Phase::Moved, 360.0, 300.0, t + 0.05);
    v.tick(t + 0.05);
    assert!(close(v.camera().st - st, 200.0, 1e-6));
}

#[test]
fn one_finger_alone_scrolls_when_single_layout() {
    let mut l = layout(5);
    l.single = true;
    let mut v = Viewport::new();
    v.set_layout(l);
    v.fit_width(None);
    let c0 = v.camera().clone();
    let t = fingers(
        &mut v,
        &[(360.0, 600.0)],
        &[(360.0, 300.0)],
        1.0,
        100.0,
        120.0,
        false,
    );
    v.tick(t);
    assert!(v.camera().st > c0.st);
    assert!(v.busy());
    v.touch(0, Phase::Ended, 360.0, 300.0, t);
    v.tick(t + 0.016);
    assert!(v.busy());
}

#[test]
fn one_finger_alone_is_the_pages() {
    let mut v = fitted(5);
    let c0 = v.camera().clone();
    let t = fingers(
        &mut v,
        &[(360.0, 600.0)],
        &[(360.0, 300.0)],
        1.0,
        100.0,
        120.0,
        true,
    );
    run(&mut v, t, 300.0, 120.0);
    assert_eq!(v.camera().st, c0.st);
    assert!(!v.busy());
}

#[test]
fn a_third_finger_ends_the_pinch_and_pans() {
    let mut v = fitted(5);
    let t = fingers(
        &mut v,
        &[(360.0, 600.0), (460.0, 600.0)],
        &[(330.0, 600.0), (490.0, 600.0)],
        1.0,
        80.0,
        120.0,
        false,
    );
    let z = v.camera().ez;
    v.touch(2, Phase::Began, 410.0, 700.0, t);
    let c = v.camera().clone();
    assert!(
        close(c.zoom, z, 1e-9),
        "committed at the third finger: {} vs {z}",
        c.zoom
    );
    assert_eq!(c.ez, c.zoom);
}

#[test]
fn page_views() {
    let mut v = fitted(5);
    let zf = v.camera().zoom;
    // zoomBy about the middle.
    let mid = content_at(v.camera(), 410.0, 555.0);
    v.zoom_by(1.25);
    assert!(close(v.camera().zoom, zf * 1.25, 1e-12));
    assert_eq!(v.camera().fit, None);
    let mid2 = content_at(v.camera(), 410.0, 555.0);
    assert!(
        close(mid.0, mid2.0, 0.01) && close(mid.1, mid2.1, 0.01),
        "{mid:?} {mid2:?}"
    );
    // Fit page: the whole of page 2 centred.
    v.zoom_to_rect([
        PAD - PAD / 2.0,
        PAD + PAGE_H - PAD / 2.0,
        PAGE_W + PAD,
        PAGE_H + PAD,
    ]);
    let c = v.camera().clone();
    assert_eq!(c.fit, Some(FitMode::Page));
    assert!(close(
        c.zoom,
        (820.0 / (PAGE_W + PAD)).min(1110.0 / (PAGE_H + PAD)),
        1e-12
    ));
    // Back to the width, the content at the top of the screen kept.
    let top = content_at(&c, 0.0, 0.0).1;
    v.fit_width(None);
    assert!(close(content_at(v.camera(), 0.0, 0.0).1, top, 1e-6));
    // A saved view comes back where it was.
    v.zoom_by(2.0);
    v.page_scroll(300.0, 2000.0, 0.0, 0.0);
    let saved = v.view_state();
    let mut w = fitted(5);
    w.restore(saved, None);
    assert!(close(w.camera().x, v.camera().x, 1e-6) && close(w.camera().y, v.camera().y, 1e-6));
    assert!(close(w.camera().zoom, v.camera().zoom, 1e-12));
    // A view fitted to the width is fitted again at its height.
    let fitted_view = SavedView {
        zoom: 3.0,
        cx: 99.0,
        cy: 1500.0,
        fit: Some(FitMode::Width),
    };
    w.restore(fitted_view, None);
    assert!(close(w.camera().zoom, zf, 1e-12));
    assert!(close(content_at(w.camera(), 0.0, 0.0).1, 1500.0, 1e-6));
}

#[test]
fn wheel_zoom_keeps_the_point_under_the_pointer() {
    let mut v = fitted(5);
    let p = content_at(v.camera(), 200.0, 300.0);
    v.zoom_at(1.5, 200.0, 300.0);
    let q = content_at(v.camera(), 200.0, 300.0);
    assert!(close(p.0, q.0, 0.01) && close(p.1, q.1, 0.01));
}

#[test]
fn going_to_a_page_glides_there() {
    let mut v = fitted(5);
    let z = v.camera().zoom;
    let y = PAD + 2.0 * PAGE_H - PAD / 2.0;
    v.scroll_to(y, true, 1.0);
    assert!(v.busy());
    let t = run(&mut v, 1.0, 100.0, 120.0);
    assert!(v.camera().st > 0.0 && v.camera().st < y * z);
    run(&mut v, t, 700.0, 120.0);
    assert!(close(v.camera().st, y * z, 1e-9));
    assert!(!v.busy());
}

#[test]
fn the_pages_own_scroll_is_taken_but_not_during_a_gesture() {
    let mut v = fitted(5);
    v.page_scroll(0.0, 500.0, 0.0, 500.0);
    let c = v.camera().clone();
    assert_eq!(c.st, 500.0);
    assert!(c.by_page);
    v.touch(0, Phase::Began, 300.0, 300.0, 1.0);
    v.touch(1, Phase::Began, 400.0, 300.0, 1.0);
    v.page_scroll(0.0, 900.0, 0.0, 400.0);
    assert_eq!(v.camera().st, 500.0);
    // Page views wait too.
    v.zoom_by(2.0);
    assert!(close(v.camera().zoom, c.zoom, 1e-12));
}

#[test]
fn a_smaller_layout_clamps_the_scroll() {
    let mut v = fitted(5);
    v.page_scroll(0.0, 4000.0, 0.0, 0.0);
    v.set_layout(layout(2));
    let max_top = layout(2).scroll_box().max_scroll_top(v.camera().zoom);
    assert!(close(v.camera().st, max_top, 1e-9));
}

#[test]
fn zoomed_out_the_content_is_centred() {
    let mut v = fitted(5);
    v.set_view(0.5, None, f64::INFINITY);
    let c = v.camera();
    assert!(close(c.x, (820.0 - (PAGE_W + 2.0 * PAD) * 0.5) / 2.0, 1e-9));
    assert_eq!(c.sl, 0.0);
}

#[test]
fn the_sequence_changes_only_with_the_camera() {
    let mut v = fitted(5);
    let s = v.camera().seq;
    v.tick(1.0);
    v.tick(1.1);
    assert_eq!(v.camera().seq, s);
    v.zoom_by(1.1);
    assert!(v.camera().seq > s);
}

#[test]
fn the_surface_in_device_px() {
    let v = fitted(5);
    let c = v.camera();
    let (k, x, y) = v.surface_device();
    assert!(close(k, c.ez * 2.0, 1e-12));
    assert!(close(x, (c.x + PAD * c.ez) * 2.0, 1e-9));
    assert!(close(y, (70.0 + c.y + PAD * c.ez) * 2.0, 1e-9));
}

#[test]
fn fingers_on_holes_or_outside_are_not_taken() {
    let mut l = layout(5);
    l.holes = vec![[700.0, 1100.0, 100.0, 40.0]];
    assert!(l.accepts(400.0, 600.0));
    assert!(!l.accepts(400.0, 20.0), "the toolbar");
    assert!(!l.accepts(750.0, 1120.0), "the zoom buttons");
    l.owned = false;
    assert!(!l.accepts(400.0, 600.0));
}

#[test]
fn set_view_keeps_an_anchor() {
    let mut v = fitted(5);
    v.set_view(
        2.0,
        Some(Anchor {
            cx: 400.0,
            cy: 2000.0,
            sx: 100.0,
            sy: 200.0,
        }),
        f64::INFINITY,
    );
    let p = content_at(v.camera(), 100.0, 200.0);
    assert!(close(p.0, 400.0, 1e-9) && close(p.1, 2000.0, 1e-9));
}

/// The camera's corner shown now and at rest (both view px): the stretch is their difference.
fn shown_y(v: &Viewport) -> f64 {
    v.camera().y
}

#[test]
fn panning_past_the_top_stretches_and_springs_back() {
    let mut v = fitted(5);
    let y0 = shown_y(&v);
    // Two fingers pull the top of the note 300 px down: the content follows less and less.
    let t = fingers(&mut v, &[(360.0, 400.0), (460.0, 400.0)], &[(360.0, 700.0), (460.0, 700.0)], 1.0, 300.0, 120.0, false);
    let stretch = shown_y(&v) - y0;
    assert_eq!(v.camera().st, 0.0);
    assert!(close(stretch, rubber(300.0, 1110.0), 1e-6), "{stretch}");
    assert!(stretch > 50.0 && stretch < 300.0);
    // Back 100 px: less stretch, still past the top.
    let t = fingers(&mut v, &[(360.0, 700.0), (460.0, 700.0)], &[(360.0, 600.0), (460.0, 600.0)], t, 100.0, 120.0, false);
    assert!(close(shown_y(&v) - y0, rubber(200.0, 1110.0), 1e-6), "{}", shown_y(&v) - y0);
    // Lifted: no fling, the stretch goes back on its own without crossing the top.
    for (i, x) in [360.0, 460.0].into_iter().enumerate() {
        v.touch(i as i64, Phase::Ended, x, 600.0, t + 0.016);
    }
    assert!(!v.gliding());
    assert!(v.moving());
    let mut tt = t + 0.016;
    for _ in 0..96 {
        tt += 1.0 / 120.0;
        v.tick(tt);
        assert!(shown_y(&v) >= y0 - 1e-9, "crossed the top");
    }
    assert!(close(shown_y(&v), y0, 1e-6), "{}", shown_y(&v) - y0);
    assert!(!v.moving());
    assert_eq!(v.camera().st, 0.0);
}

#[test]
fn a_fling_into_the_top_overshoots_and_comes_back() {
    let mut v = fitted(8);
    v.page_scroll(0.0, 300.0, 0.0, 0.0);
    let y_top = {
        let mut w = fitted(8);
        w.tick(0.0);
        shown_y(&w)
    };
    let t = fling(&mut v, 300.0, -400.0, 100.0, 120.0);
    let mut tt = t;
    let mut most: f64 = 0.0;
    for _ in 0..360 {
        tt += 1.0 / 120.0;
        v.tick(tt);
        most = most.max(shown_y(&v) - y_top);
    }
    assert!(most > 1.0, "no overshoot: {most}");
    assert!(most <= BOUNCE_MAX * 1110.0 + 1e-6, "{most}");
    assert_eq!(v.camera().st, 0.0);
    assert!(close(shown_y(&v), y_top, 1e-6));
    assert!(!v.moving());
}

#[test]
fn sideways_past_the_page_stretches_too() {
    // Fitted, the content is a few px wider than the view: dragged right, it scrolls to its left
    // edge, then stretches; released, it rests at that edge.
    let mut v = fitted(5);
    let x0 = v.camera().x;
    let at_edge = x0 + v.camera().sl;
    let t = fingers(&mut v, &[(300.0, 500.0), (400.0, 500.0)], &[(500.0, 500.0), (600.0, 500.0)], 1.0, 200.0, 120.0, true);
    assert!(v.camera().x > at_edge + 20.0, "{}", v.camera().x - at_edge);
    run(&mut v, t, 600.0, 120.0);
    assert_eq!(v.camera().sl, 0.0);
    assert!(close(v.camera().x, at_edge, 1.0), "{} vs {at_edge}", v.camera().x);
    assert!(!v.moving());
}

#[test]
fn a_finger_catches_a_stretch_where_it_shows() {
    let mut v = fitted(5);
    let t = fingers(&mut v, &[(360.0, 400.0), (460.0, 400.0)], &[(360.0, 700.0), (460.0, 700.0)], 1.0, 300.0, 120.0, true);
    let t = run(&mut v, t, 80.0, 120.0);
    let before = shown_y(&v);
    v.touch(0, Phase::Began, 360.0, 500.0, t);
    v.touch(1, Phase::Began, 460.0, 500.0, t);
    v.tick(t);
    assert!(close(shown_y(&v), before, 1e-6), "{} vs {before}", shown_y(&v));
}

#[test]
fn a_pinch_going_in_and_out_does_not_rebase_at_every_swing() {
    // Fingers spreading to 1.8x and back, five times in 2.5 s: under the page's own rule (1.5x,
    // every 250 ms) each swing committed the zoom (7 in one pinch on the owner's iPad, each a few
    // late frames on the canvas); the Rust camera commits at 2x, at most every 500 ms.
    let mut v = fitted(5);
    v.touch(0, Phase::Began, 380.0, 600.0, 1.0);
    v.touch(1, Phase::Began, 440.0, 600.0, 1.0);
    let mut t = 1.0;
    for s in 0..300 {
        t += 0.008333;
        let swing = (s as f64 / 60.0 * std::f64::consts::PI).sin().abs();
        let d = 30.0 * (1.0 + 0.8 * swing);
        v.touch(0, Phase::Moved, 410.0 - d, 600.0, t);
        v.touch(1, Phase::Moved, 410.0 + d, 600.0, t);
        v.tick(t);
    }
    assert_eq!(v.rebases, 0, "rebases {}", v.rebases);
}
