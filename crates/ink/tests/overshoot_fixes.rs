//! Tests verifying the four mechanisms for preventing end-of-stroke overshooting / liftoff flick / hook:
//! 1. Purge predicted touches on touchesEnded / ACTION_UP.
//! 2. Drop the final coordinates of UP event (liftoff jitter) / pressure gate.
//! 3. Fix final spline phantom control points (zero-tangent clamping on rapid endpoints).
//! 4. Critically damped spring filter (zeta = 1.0) with immediate lerp to touch endpoint on UP.

use ink::geometry::filter_liftoff_jitter;
use ink::prediction::StrokePredictor;
use ink::spline::{catmull_rom_beziers, Bezier};
use ink::spring::CriticallyDampedSpring;
use model::Point;
use nib::geometry::XY;

#[test]
fn test_mechanism_1_purge_predicted_touches_on_up() {
    let mut predictor = StrokePredictor::new();

    // User draws an upward stroke (e.g. second leg of a "V")
    predictor.push_committed(Point { x: 10.0, y: 10.0, pressure: 0.5, t: Some(0.0), ..Default::default() });
    predictor.push_committed(Point { x: 15.0, y: 25.0, pressure: 0.5, t: Some(10.0), ..Default::default() });
    predictor.push_committed(Point { x: 22.0, y: 50.0, pressure: 0.5, t: Some(20.0), ..Default::default() });

    // While moving fast, hardware predictor projects 1 frame ahead into mid-air
    let raw_prediction = Point { x: 30.0, y: 80.0, pressure: 0.5, t: Some(30.0), ..Default::default() };
    let pred = predictor.update_prediction(Some(raw_prediction));
    assert_eq!(pred.len(), 1, "Predictor should generate 1 provisional point while moving");
    assert!(predictor.live_display_points().len() == 4, "Live display includes prediction");

    // The instant the stylus lifts (ACTION_UP / touchesEnded):
    let final_pts = predictor.on_touch_ended();
    assert_eq!(final_pts.len(), 3, "Prediction buffer must be completely discarded on touch ended");
    assert_eq!(final_pts.last().unwrap().x, 22.0);
    assert_eq!(final_pts.last().unwrap().y, 50.0);
    assert!(predictor.live_display_points().len() == 3, "No extrapolated tail left behind in mid-air");
}

#[test]
fn test_mechanism_2_liftoff_jitter_pressure_gate() {
    // Stylus lifting with contact patch shrinking and centroid jumping sideways:
    let pts = vec![
        Point { x: 100.0, y: 100.0, pressure: 0.35, t: Some(10.0), ..Default::default() },
        Point { x: 105.0, y: 110.0, pressure: 0.20, t: Some(20.0), ..Default::default() },
        Point { x: 110.0, y: 120.0, pressure: 0.08, t: Some(30.0), ..Default::default() }, // Last stable sample (pressure >= 0.05)
        Point { x: 118.0, y: 115.0, pressure: 0.03, t: Some(40.0), ..Default::default() }, // Noisy jump sideways as field collapses
        Point { x: 125.0, y: 112.0, pressure: 0.00, t: Some(50.0), ..Default::default() }, // ACTION_UP sample
    ];

    let filtered = filter_liftoff_jitter(&pts);
    assert_eq!(filtered.len(), pts.len(), "Point count preserved for tapering");

    // Stable points untouched:
    assert_eq!(filtered[2].x, 110.0);
    assert_eq!(filtered[2].y, 120.0);

    // Ultra-low pressure samples (< 0.05) clamped to last stable coordinate:
    assert_eq!(filtered[3].x, 110.0, "Jitter coordinate replaced with last stable position");
    assert_eq!(filtered[3].y, 120.0);
    assert_eq!(filtered[3].pressure, 0.03, "Pressure drop preserved for width taper");

    assert_eq!(filtered[4].x, 110.0, "ACTION_UP sample clamped to last stable position");
    assert_eq!(filtered[4].y, 120.0);
    assert_eq!(filtered[4].pressure, 0.00);
}

#[test]
fn test_mechanism_3_spline_clamped_phantom_control_points() {
    // Accelerating stroke at the end of a "V" flick:
    // P0 -> P1 has distance ~14 px, P1 -> P2 has distance ~64 px (rapid lift-off acceleration)
    let pts = vec![
        XY { x: 0.0, y: 0.0 },
        XY { x: 10.0, y: 10.0 },
        XY { x: 50.0, y: 60.0 },
    ];

    let beziers: Vec<Bezier> = catmull_rom_beziers(&pts, false);
    assert_eq!(beziers.len(), 2, "2 segments for 3 points");

    let last_seg = beziers.last().unwrap();
    let p_start = last_seg[0];
    let c1 = last_seg[1];
    let c2 = last_seg[2];
    let p_end = last_seg[3];

    assert_eq!(p_start, XY { x: 10.0, y: 10.0 });
    assert_eq!(p_end, XY { x: 50.0, y: 60.0 });

    // Quadratic Bézier termination directly at P_end:
    // C2 is naturally curved, strictly within bounds without zero-tangent straight flattening or overshoot
    assert!(c2.x >= 10.0 && c2.x <= 50.0);
    assert!(c2.y >= 10.0 && c2.y <= 60.0);
    // Tangent at end does not point beyond P_end:
    assert!(p_end.x >= c2.x && p_end.y >= c2.y);

    // Verify curve stays within the coordinate bounds of P1 and P2 without whipping past:
    assert!(c1.x >= 10.0 && c1.x <= 50.0);
    assert!(c1.y >= 10.0 && c1.y <= 60.0);
}

#[test]
fn test_mechanism_4_critically_damped_spring_filter() {
    let initial = XY { x: 0.0, y: 0.0 };
    let mut spring = CriticallyDampedSpring::new(initial, 30.0);

    // Stylus rapidly moves to target (100.0, 50.0)
    let target = XY { x: 100.0, y: 50.0 };
    spring.set_target(target);

    // Simulate multiple frames under critical damping
    let dt = 1.0 / 120.0; // 120 Hz display
    for _ in 0..60 {
        let p = spring.step(dt);
        // Under critical damping (zeta = 1.0), position MUST NEVER overshoot target!
        assert!(p.x <= target.x + 1e-9, "Spring must not overshoot target x");
        assert!(p.y <= target.y + 1e-9, "Spring must not overshoot target y");
    }

    // Now test ACTION_UP / touchesEnded lerp:
    let up_touch = XY { x: 120.0, y: 60.0 };
    let lerp_points = spring.on_action_up_lerp(up_touch, 4);

    assert_eq!(lerp_points.len(), 4);
    assert_eq!(lerp_points.last().unwrap().x, 120.0);
    assert_eq!(lerp_points.last().unwrap().y, 60.0);
    assert_eq!(spring.pos, up_touch);
    assert_eq!(spring.vel, XY { x: 0.0, y: 0.0 }, "Velocity halted immediately on UP");
}
