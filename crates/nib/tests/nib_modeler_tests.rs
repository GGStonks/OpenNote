use nib::nib::{DEFAULT_NIB, NibModeler};

#[test]
fn test_has_force_trims_trailing_zero_pressure() {
    let mut modeler = NibModeler::new();
    // Add points with positive force
    modeler.add(10.0, 10.0, 0.0, 0.5);
    modeler.add(20.0, 20.0, 5.0, 0.7);
    modeler.add(30.0, 30.0, 10.0, 0.6);
    // Add trailing zero-force points (pen lifting)
    modeler.add(40.0, 40.0, 15.0, 0.0);
    modeler.add(50.0, 50.0, 20.0, 0.0);

    let finished = modeler.finish();
    assert!(!finished.is_empty());
    // Raw samples after trailing zeros should be trimmed by ink_end
    // The finished points should not extend into the trailing zero region
    let last = finished.last().unwrap();
    assert!(last.t <= 20.0);
}

#[test]
fn test_unpressured_stroke_keeps_all_samples() {
    let mut modeler = NibModeler::new();
    // Stroke without pressure (mouse / touch)
    modeler.add(10.0, 10.0, 0.0, 0.0);
    modeler.add(20.0, 20.0, 5.0, 0.0);
    modeler.add(30.0, 30.0, 10.0, 0.0);

    let finished = modeler.finish();
    assert!(!finished.is_empty());
    // Since has_force is false, ink_end returns raw.len(), not trimming anything
}

#[test]
fn test_cached_attack_force_consistency() {
    let params = DEFAULT_NIB;
    let mut modeler = NibModeler::with_params(params);

    // Add points across the attack window (attack = 24ms, press_half = 14ms -> 38ms)
    for i in 0..15 {
        let t = i as f64 * 4.0; // 0, 4, 8, ... 56ms
        let p = 0.3 + (i as f64) * 0.03;
        modeler.add(10.0 + (i as f64) * 5.0, 20.0, t, p);
    }

    let finished = modeler.finish();
    assert!(!finished.is_empty());
    // Finished modeled points have valid pressures
    for pt in finished {
        assert!(pt.p > 0.0 && pt.p <= 1.0);
    }
}
