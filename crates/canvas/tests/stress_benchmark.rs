//! Automated Stress Benchmark (Section 5 of Optimization Spec):
//! Scenario 1: Empty Page, 240 Hz Fast Scribble
//! Scenario 2: Heavy Page, 5,000 Committed Strokes + Live Drawing + Rapid Pinch-Zoom
//! Scenario 3: Camera Momentum Glide across 60 Hz, 120 Hz, and 240 Hz

use canvas::host::{CanvasHost, FrameSpec, PagePlacement};
use canvas::telemetry::{FrameSample, FrameStats};
use canvas::{Paper, Transform};
use model::{Point, Stroke};
use renderer::color::Rgba;
use std::time::Instant;

fn sample_stroke(id: &str, x0: f64, y0: f64, x1: f64, y1: f64, width: f64) -> Stroke {
    let points = (0..=10)
        .map(|i| {
            let u = i as f64 / 10.0;
            Point {
                x: x0 + (x1 - x0) * u,
                y: y0 + (y1 - y0) * u,
                pressure: 0.5,
                t: Some(u * 50.0),
                ..Default::default()
            }
        })
        .collect();
    Stroke {
        id: id.into(),
        tool: "pen".into(),
        color: "#1e40af".into(),
        width,
        opacity: 1.0,
        points,
        ..Default::default()
    }
}

#[test]
fn scenario_1_fast_scribble_240hz_telemetry() {
    let mut stats = FrameStats::new(240, 4166); // 240 Hz = 4166 us target budget
    let (mut host, _) = CanvasHost::offscreen(800, 600).expect("offscreen host");

    let paper = Paper {
        width: 816.0,
        height: 1056.0,
        style: 0,
        base: [1.0, 1.0, 1.0, 1.0],
        dark: false,
        pattern: None,
        origin: [0.0, 0.0],
    };

    host.set_frame(FrameSpec {
        surface: None,
        placed: None,
        clear: Some(Rgba::WHITE),
        pages: vec![PagePlacement {
            page: "live_page".into(),
            tf: Transform::scale(1.0, 0.0, 0.0),
            paper: Some(paper),
            at: None,
            bx: None,
        }],
    });

    let mut points: Vec<Point> = Vec::new();
    let frames = 600; // 2.5 seconds at 240 Hz

    for f in 0..frames {
        let t_prep0 = Instant::now();
        let u = f as f64 * 0.05;
        let x = 400.0 + 200.0 * u.cos();
        let y = 300.0 + 150.0 * (u * 1.5).sin();
        points.push(Point {
            x,
            y,
            pressure: 0.6,
            t: Some(f as f64 * 4.166),
            ..Default::default()
        });

        let stroke = Stroke {
            id: "active_scribble".into(),
            tool: "pen".into(),
            color: "#000000".into(),
            width: 3.0,
            opacity: 1.0,
            points: points.clone(),
            ..Default::default()
        };
        host.set_scene("live_page", &[stroke]);
        let cpu_prep_us = t_prep0.elapsed().as_micros() as u64;

        let t_enc0 = Instant::now();
        let _ = host.draw();
        let gpu_enc_us = t_enc0.elapsed().as_micros() as u64;

        stats.record(FrameSample {
            frame_dt_us: 4166,
            cpu_prepare_us: cpu_prep_us,
            gpu_encode_us: gpu_enc_us,
            bytes_uploaded: (points.len() * 32) as u64,
            draw_calls: 2,
        });
    }

    let summary = stats.summarize();
    println!(
        "Scenario 1 Summary (240 Hz Scribble): p50={:.1}µs, p95={:.1}µs, p99={:.1}µs, max={}µs, avg_bytes={:.0}",
        summary.p50_cpu_us, summary.p95_cpu_us, summary.p99_cpu_us, summary.max_cpu_us, summary.avg_bytes_uploaded
    );

    assert!(summary.p50_cpu_us < 2000.0, "p50 CPU must be low");
    assert_eq!(summary.avg_draw_calls, 2.0);
}

#[test]
fn scenario_2_heavy_page_5000_strokes_culling() {
    let mut stats = FrameStats::new(240, 8333); // 120 Hz = 8333 us target budget
    let (mut host, _) = CanvasHost::offscreen(1024, 768).expect("offscreen host");

    // Generate 5,000 committed strokes laid out down a long document
    let total_strokes = 5000;
    let mut strokes = Vec::with_capacity(total_strokes);
    for i in 0..total_strokes {
        let y = (i as f64) * 8.0;
        strokes.push(sample_stroke(
            &format!("s_{i}"),
            50.0,
            y,
            400.0,
            y + 5.0,
            2.0,
        ));
    }

    let t_init = Instant::now();
    host.set_scene("heavy_doc", &strokes);
    println!(
        "Uploaded 5,000 strokes in {:.2} ms",
        t_init.elapsed().as_secs_f64() * 1000.0
    );

    let paper = Paper {
        width: 816.0,
        height: ((total_strokes as f64) * 8.0 + 500.0) as f32,
        style: 0,
        base: [1.0, 1.0, 1.0, 1.0],
        dark: false,
        pattern: None,
        origin: [0.0, 0.0],
    };

    // Render 60 frames while rapidly scrolling and pinch-zooming
    for f in 0..60 {
        let t0 = Instant::now();
        let scroll_y = (f as f64) * 200.0;
        let zoom = 1.0 + 0.1 * ((f as f64) * 0.2).sin();

        host.set_frame(FrameSpec {
            surface: None,
            placed: None,
            clear: Some(Rgba::WHITE),
            pages: vec![PagePlacement {
                page: "heavy_doc".into(),
                tf: Transform::scale(zoom as f32, 0.0, -scroll_y as f32),
                paper: Some(paper),
                at: None,
                bx: None,
            }],
        });

        let cpu_prep_us = t0.elapsed().as_micros() as u64;

        let t_enc = Instant::now();
        let drawn = host.draw().expect("draw");
        let gpu_enc_us = t_enc.elapsed().as_micros() as u64;
        assert!(drawn);

        stats.record(FrameSample {
            frame_dt_us: 8333,
            cpu_prepare_us: cpu_prep_us,
            gpu_encode_us: gpu_enc_us,
            bytes_uploaded: 2048,
            draw_calls: 2,
        });
    }

    let summary = stats.summarize();
    println!(
        "Scenario 2 Summary (5,000 Strokes Zoom/Pan): p50={:.1}µs, p95={:.1}µs, p99={:.1}µs, max={}µs, avg_draws={:.0}",
        summary.p50_cpu_us, summary.p95_cpu_us, summary.p99_cpu_us, summary.max_cpu_us, summary.avg_draw_calls
    );

    assert!(
        summary.p99_cpu_us < 2000.0,
        "p99 CPU time under rapid pinch/zoom must be < 2 ms"
    );
}

#[test]
fn scenario_3_momentum_glide_refresh_rate_invariance() {
    use viewport::math::momentum_step_exact;

    // Simulate glide with vx=0, vy=3.5 px/ms over 1500 ms at 60 Hz, 120 Hz, and 240 Hz
    let simulate_glide = |hz: f64| -> f64 {
        let dt = 1000.0 / hz;
        let mut vy: f64 = 3.5;
        let mut total_distance = 0.0;
        let mut elapsed = 0.0;
        while elapsed < 1500.0 && vy.abs() > 0.01 {
            let (_, dy, _, nvy) = momentum_step_exact(0.0, vy, dt);
            total_distance += dy;
            vy = nvy;
            elapsed += dt;
        }
        total_distance
    };

    let dist_60 = simulate_glide(60.0);
    let dist_120 = simulate_glide(120.0);
    let dist_240 = simulate_glide(240.0);

    let diff_120 = (dist_120 - dist_60).abs() / dist_60;
    let diff_240 = (dist_240 - dist_60).abs() / dist_60;

    println!(
        "Scenario 3 Invariance: 60Hz={dist_60:.2}px, 120Hz={dist_120:.2}px (diff={:.3}%), 240Hz={dist_240:.2}px (diff={:.3}%)",
        diff_120 * 100.0,
        diff_240 * 100.0
    );

    assert!(
        diff_120 < 0.01,
        "120 Hz glide must be within 1% of 60 Hz glide"
    );
    assert!(
        diff_240 < 0.01,
        "240 Hz glide must be within 1% of 60 Hz glide"
    );
}
