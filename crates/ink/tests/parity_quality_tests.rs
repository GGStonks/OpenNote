use ink::{erase_strokes_partial, SmoothLiveStroke};
use model::{ModeledKind, Point, Stroke};
use std::f64::consts::PI;

#[test]
fn test_smooth_live_stroke_width_continuity_across_boundary() {
    let mut live = SmoothLiveStroke::new();
    let width = 2.0;
    let variable = true;

    // Draw a stroke with varying pressure
    for i in 0..40 {
        let t = i as f64 * 5.0; // 5ms per sample
        let x = 100.0 + (i as f64) * 3.0;
        let y = 150.0 + (i as f64 * 0.1).sin() * 20.0;
        let p = 0.3 + 0.4 * ((i as f64) / 40.0 * PI).sin();
        live.add(x, y, t, p);

        // Every few frames, evaluate the line
        if i >= 15 {
            let res = live.line(width, variable);
            assert_eq!(res.final_pts.len(), res.final_w.len());
            assert_eq!(res.rest_pts.len(), res.rest_w.len());

            // If both final and rest points exist, check width continuity across the seam
            if let (Some(&last_final_w), Some(&first_rest_w)) = (res.final_w.last(), res.rest_w.first()) {
                let diff = (last_final_w - first_rest_w).abs();
                assert!(
                    diff < 0.25,
                    "Seam width discontinuity too large: final={last_final_w}, rest={first_rest_w}, diff={diff}"
                );
            }
        }
    }
}

#[test]
fn test_erase_strokes_partial_closed_handwriting_across_seam() {
    // Generate a circular closed handwriting stroke
    let cx = 100.0;
    let cy = 100.0;
    let r = 50.0;
    let n = 36;
    let mut pts = Vec::with_capacity(n);

    for i in 0..n {
        let angle = (i as f64 / n as f64) * 2.0 * PI;
        pts.push(Point {
            x: cx + r * angle.cos(),
            y: cy + r * angle.sin(),
            pressure: 0.5,
            t: Some(i as f64 * 5.0),
            alt: None,
            az: None,
        });
    }

    let stroke = Stroke {
        id: "closed_h1".to_string(),
        tool: "pen".to_string(),
        color: "#000000".to_string(),
        width: 2.0,
        opacity: 1.0,
        points: pts,
        line_style: Some(model::LineStyle::Solid),
        pen_style: Some(model::PenStyle::Fountain),
        is_shape: Some(false),
        closed: Some(true),
        shape_kind: None,
        fill: None,
        fill_color: None,
        fill_opacity: None,
        arrow: None,
        modeled: Some(ModeledKind::Uniform),
        pen_end: None,
        rotation: None,
        created_at: Some(0.0),
        highlight_alpha: None,
        dash_offset: None,
        fill_only: None,
    };

    let mut id_counter = 0;
    let make_id = || {
        id_counter += 1;
        format!("cut_{id_counter}")
    };

    // 1. Erase away from the seam (seam is at angle 0: x=150, y=100; erase at angle PI: x=50, y=100)
    let (pieces, changed) = erase_strokes_partial(&[stroke.clone()], 50.0, 100.0, 10.0, make_id, None);
    assert!(changed);
    // Because wrap-around is merged across the seam, this should yield exactly 1 open continuous piece
    assert_eq!(
        pieces.len(),
        1,
        "Erasing away from the seam on a closed handwriting stroke should merge into 1 continuous piece"
    );
    assert_eq!(pieces[0].closed, Some(false));

    // 2. Erase across the closing seam (at x=150, y=100)
    let mut id_counter2 = 0;
    let make_id2 = || {
        id_counter2 += 1;
        format!("cut2_{id_counter2}")
    };
    let (pieces_seam, changed_seam) = erase_strokes_partial(&[stroke], 150.0, 100.0, 10.0, make_id2, None);
    assert!(changed_seam);
    assert_eq!(
        pieces_seam.len(),
        1,
        "Erasing across the seam should cleanly open the closed stroke into 1 continuous piece"
    );
    assert_eq!(pieces_seam[0].closed, Some(false));
}
