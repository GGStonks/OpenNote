use model::*;
use renderer::*;

fn make_dummy_stroke() -> Stroke {
    Stroke {
        id: "s1".to_string(),
        tool: "pen".to_string(),
        color: "#1f2937".to_string(),
        width: 2.0,
        opacity: 1.0,
        points: vec![],
        line_style: None,
        pen_style: Some(PenStyle::Fountain),
        is_shape: None,
        closed: None,
        shape_kind: None,
        fill: None,
        fill_color: None,
        fill_opacity: None,
        arrow: None,
        modeled: None,
        pen_end: None,
        rotation: None,
        created_at: Some(0.0),
        highlight_alpha: None,
        dash_offset: None,
        fill_only: None,
    }
}

fn wave_points(y0: f64, amp: f64, n: usize) -> Vec<Point> {
    let mut pts = Vec::with_capacity(n);
    for i in 0..n {
        let t = i as f64 / (n - 1) as f64;
        let x = 20.0 + t * 160.0;
        let y = y0 + (t * 9.0).sin() * amp;
        let p = 0.25 + 0.75 * (t * 3.1).sin().powi(2);
        pts.push(Point {
            x,
            y,
            pressure: p,
            t: Some(i as f64 * 8.0),
            alt: None,
            az: None,
        });
    }
    pts
}

fn rect_points(x: f64, y: f64, w: f64, h: f64) -> Vec<Point> {
    vec![
        Point { x, y, pressure: 0.5, t: Some(0.0), alt: None, az: None },
        Point { x: x + w, y, pressure: 0.5, t: Some(10.0), alt: None, az: None },
        Point { x: x + w, y: y + h, pressure: 0.5, t: Some(20.0), alt: None, az: None },
        Point { x, y: y + h, pressure: 0.5, t: Some(30.0), alt: None, az: None },
    ]
}

#[test]
fn test_glcompare_all_16_cases_rasterize() {
    let mut cases: Vec<(&str, Stroke)> = Vec::new();

    // 1. Fountain
    let mut s_fountain = make_dummy_stroke();
    s_fountain.points = wave_points(40.0, 12.0, 60);
    s_fountain.modeled = Some(ModeledKind::Proportional);
    cases.push(("fountain", s_fountain));

    // 2. FountainRaw
    let mut s_raw = make_dummy_stroke();
    s_raw.points = wave_points(40.0, 12.0, 60);
    cases.push(("fountainRaw", s_raw));

    // 3. Ballpoint
    let mut s_bp = make_dummy_stroke();
    s_bp.pen_style = Some(PenStyle::Ballpoint);
    s_bp.points = wave_points(40.0, 12.0, 60);
    cases.push(("ballpoint", s_bp));

    // 4. Highlighter
    let mut s_hl = make_dummy_stroke();
    s_hl.tool = "highlighter".to_string();
    s_hl.color = "#facc15".to_string();
    s_hl.width = 3.0;
    s_hl.pen_style = Some(PenStyle::Ballpoint);
    s_hl.points = wave_points(40.0, 4.0, 60);
    cases.push(("highlighter", s_hl));

    // 5. Translucent
    let mut s_trans = make_dummy_stroke();
    s_trans.pen_style = Some(PenStyle::Ballpoint);
    s_trans.width = 4.0;
    s_trans.opacity = 0.5;
    let mut trans_pts = Vec::new();
    for i in 0..80 {
        let t = i as f64 / 79.0;
        let ang = t * 6.28 * 1.5;
        trans_pts.push(Point {
            x: 40.0 + 120.0 * ang.cos(),
            y: 40.0 + 25.0 * ang.sin(),
            pressure: 0.5,
            t: Some(i as f64 * 8.0),
            alt: None,
            az: None,
        });
    }
    s_trans.points = trans_pts;
    cases.push(("translucent", s_trans));

    // 6. Dashed Shape
    let mut s_dash = make_dummy_stroke();
    s_dash.is_shape = Some(true);
    s_dash.line_style = Some(LineStyle::Dashed);
    s_dash.points = vec![
        Point { x: 20.0, y: 20.0, pressure: 0.5, t: Some(0.0), alt: None, az: None },
        Point { x: 180.0, y: 60.0, pressure: 0.5, t: Some(10.0), alt: None, az: None },
    ];
    cases.push(("dashed", s_dash));

    // 7. Dotted Shape
    let mut s_dot = make_dummy_stroke();
    s_dot.is_shape = Some(true);
    s_dot.line_style = Some(LineStyle::Dotted);
    s_dot.points = vec![
        Point { x: 20.0, y: 60.0, pressure: 0.5, t: Some(0.0), alt: None, az: None },
        Point { x: 180.0, y: 20.0, pressure: 0.5, t: Some(10.0), alt: None, az: None },
    ];
    cases.push(("dotted", s_dot));

    // 8. Pen Dashed
    let mut s_pendash = make_dummy_stroke();
    s_pendash.line_style = Some(LineStyle::Dashed);
    s_pendash.points = wave_points(40.0, 12.0, 60);
    cases.push(("penDashed", s_pendash));

    // 9. Pen Dotted
    let mut s_pendot = make_dummy_stroke();
    s_pendot.line_style = Some(LineStyle::Dotted);
    s_pendot.points = wave_points(40.0, 12.0, 60);
    cases.push(("penDotted", s_pendot));

    // 10. Pen DashDot
    let mut s_dashdot = make_dummy_stroke();
    s_dashdot.line_style = Some(LineStyle::Dashdot);
    s_dashdot.pen_style = Some(PenStyle::Ballpoint);
    s_dashdot.points = wave_points(40.0, 12.0, 60);
    cases.push(("penDashDot", s_dashdot));

    // 11. Arrow
    let mut s_arr = make_dummy_stroke();
    s_arr.is_shape = Some(true);
    s_arr.arrow = Some(true);
    s_arr.width = 3.0;
    s_arr.points = vec![
        Point { x: 20.0, y: 40.0, pressure: 0.5, t: Some(0.0), alt: None, az: None },
        Point { x: 170.0, y: 40.0, pressure: 0.5, t: Some(10.0), alt: None, az: None },
    ];
    cases.push(("arrow", s_arr));

    // 12. Solid Fill
    let mut s_solid = make_dummy_stroke();
    s_solid.is_shape = Some(true);
    s_solid.closed = Some(true);
    s_solid.fill = Some(FillType::Solid);
    s_solid.color = "#2563eb".to_string();
    s_solid.points = rect_points(30.0, 10.0, 120.0, 60.0);
    cases.push(("solidFill", s_solid));

    // 13. Hatch Fill
    let mut s_hatch = make_dummy_stroke();
    s_hatch.is_shape = Some(true);
    s_hatch.closed = Some(true);
    s_hatch.fill = Some(FillType::Crosshatch);
    s_hatch.color = "#dc2626".to_string();
    s_hatch.points = rect_points(30.0, 10.0, 120.0, 60.0);
    cases.push(("hatch", s_hatch));

    // 14. Hole
    let mut s_hole = make_dummy_stroke();
    s_hole.is_shape = Some(true);
    s_hole.closed = Some(true);
    s_hole.fill = Some(FillType::Hole);
    s_hole.points = rect_points(60.0, 15.0, 60.0, 50.0);
    cases.push(("hole", s_hole));

    // 15. Curve
    let mut s_curve = make_dummy_stroke();
    s_curve.is_shape = Some(true);
    s_curve.shape_kind = Some(ShapeKind::Curve);
    s_curve.closed = Some(true);
    s_curve.fill = Some(FillType::Solid);
    s_curve.color = "#7c3aed".to_string();
    s_curve.points = vec![
        Point { x: 30.0, y: 40.0, pressure: 0.5, t: Some(0.0), alt: None, az: None },
        Point { x: 100.0, y: 10.0, pressure: 0.5, t: Some(10.0), alt: None, az: None },
        Point { x: 170.0, y: 40.0, pressure: 0.5, t: Some(20.0), alt: None, az: None },
        Point { x: 100.0, y: 70.0, pressure: 0.5, t: Some(30.0), alt: None, az: None },
    ];
    cases.push(("curve", s_curve));

    // 16. Point
    let mut s_point = make_dummy_stroke();
    s_point.is_shape = Some(true);
    s_point.shape_kind = Some(ShapeKind::Point);
    s_point.width = 3.0;
    s_point.points = vec![
        Point { x: 100.0, y: 40.0, pressure: 0.5, t: Some(0.0), alt: None, az: None },
    ];
    cases.push(("point", s_point));

    for (name, stroke) in cases {
        for &k in &[1.5f64, 4.0f64] {
            let w = (200.0 * k).round() as usize;
            let h = (80.0 * k).round() as usize;
            let mut buf = PixelBuffer::new(w, h);
            buf.clear(Rgba::WHITE);

            let renderer = Renderer::new(k, 0.0, 0.0);
            let ops = build_stroke_ops(&stroke);
            renderer.render_scene(&mut buf, &ops, None, None);

            // Count inked pixels (pixels that differ from white)
            let mut inked_count = 0;
            for y in 0..h {
                for x in 0..w {
                    let p = buf.get_pixel(x, y);
                    if p[0] < 250 || p[1] < 250 || p[2] < 250 {
                        inked_count += 1;
                    }
                }
            }

            if name != "hole" {
                assert!(
                    inked_count > 0,
                    "Case '{}' at scale x{} produced 0 inked pixels!",
                    name,
                    k
                );
            }
            println!("[OK] case '{}' scale x{}: {} pixels inked", name, k, inked_count);
        }
    }
}

#[test]
fn test_paper_patterns() {
    let patterns = vec![
        PaperStyle::Ruled,
        PaperStyle::Narrow,
        PaperStyle::Grid,
        PaperStyle::Graph,
        PaperStyle::Dots,
        PaperStyle::Blank,
    ];

    for style in patterns {
        let mut buf_light = PixelBuffer::new(200, 200);
        let color_light = PaperColor::Name("cream".to_string());
        render_paper_background(
            &mut buf_light.data,
            200,
            200,
            800,
            style,
            &color_light,
            1.0,
            0.0,
            0.0,
        );

        let mut buf_dark = PixelBuffer::new(200, 200);
        let color_dark = PaperColor::Name("dark".to_string());
        render_paper_background(
            &mut buf_dark.data,
            200,
            200,
            800,
            style,
            &color_dark,
            1.0,
            0.0,
            0.0,
        );

        // Assert valid non-zero alpha
        assert_eq!(buf_light.get_pixel(0, 0)[3], 255);
        assert_eq!(buf_dark.get_pixel(0, 0)[3], 255);
    }
}

#[test]
fn test_thumbnail_and_selection_glow() {
    let mut s1 = make_dummy_stroke();
    s1.points = wave_points(100.0, 20.0, 50);

    let page = NotePage {
        id: "p1".to_string(),
        page_number: 1,
        strokes: vec![s1.clone()],
        latex_blocks: vec![],
        text_blocks: None,
        image_blocks: None,
    };

    // Test thumbnail
    let thumb = render_page_thumbnail(&page, 204, 264);
    assert_eq!(thumb.width, 204);
    assert_eq!(thumb.height, 264);

    let mut inked = 0;
    for y in 0..264 {
        for x in 0..204 {
            let p = thumb.get_pixel(x, y);
            if p[0] < 240 || p[1] < 240 || p[2] < 240 {
                inked += 1;
            }
        }
    }
    assert!(inked > 0, "Thumbnail should contain rendered ink pixels");

    // Test selection glow
    let glow_ops = build_glow_ops(&[s1], 8.0, Rgba::new(0.2, 0.4, 0.9, 0.5));
    assert_eq!(glow_ops.len(), 1);
    let mut buf = PixelBuffer::new(300, 200);
    buf.clear(Rgba::WHITE);
    let renderer = Renderer::new(1.0, 0.0, 0.0);
    renderer.render_scene(&mut buf, &glow_ops, None, None);

    let mut glow_inked = 0;
    for y in 0..200 {
        for x in 0..300 {
            let p = buf.get_pixel(x, y);
            if p[0] < 250 || p[1] < 250 || p[2] < 250 {
                glow_inked += 1;
            }
        }
    }
    assert!(glow_inked > 0, "Glow pass should produce soft blurred pixels");
}
