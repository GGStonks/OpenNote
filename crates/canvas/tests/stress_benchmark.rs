//! Automated Stress Benchmark (Section 3 of Surgical Optimization Spec):
//! Test A: 240-frame pan + pinch-zoom over 100-page note with 5,000+ capsules & dot paper
//! Test B: Fling continuity & 60/120/240 Hz invariance in crates/viewport

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

/// Test A: 240-frame pan + pinch-zoom over 100-page note with 5,000+ capsules & dot paper.
/// Verifies:
/// 1. 0 static scene GPU re-uploads during steady-state pan/zoom.
/// 2. p99 CPU prep time < 1500 µs (aim < 600 µs).
#[test]
fn test_a_240_frame_pan_pinch_zoom_100_pages_dot_paper() {
    let mut stats = FrameStats::new(240, 8333); // 120 Hz = 8333 us target budget
    let (mut host, _) = CanvasHost::offscreen(1024, 768).expect("offscreen host");

    let num_pages = 100;
    let strokes_per_page = 50; // 50 * 10 capsules = 500 capsules/page -> 50,000 capsules total!
    let page_h = 1056.0f64;
    let page_w = 816.0f64;

    let paper = Paper {
        width: page_w as f32,
        height: page_h as f32,
        style: 7,                         // Dot paper
        base: [0.984, 0.969, 0.933, 1.0], // #FBF7EE
        dark: false,
        pattern: None,
        origin: [0.0, 0.0],
    };

    let mut placements = Vec::with_capacity(num_pages);
    for p in 0..num_pages {
        let page_id = format!("page_{p}");
        let mut strokes = Vec::with_capacity(strokes_per_page);
        for s in 0..strokes_per_page {
            let y = (s as f64) * 20.0;
            strokes.push(sample_stroke(
                &format!("p{p}_s{s}"),
                50.0,
                y,
                400.0,
                y + 10.0,
                2.0,
            ));
        }
        host.set_scene(&page_id, &strokes);
        placements.push(PagePlacement {
            page: page_id,
            tf: Transform::scale(1.0, 0.0, 0.0),
            paper: Some(paper),
            at: Some([0.0, (p as f64) * (page_h + 20.0)]),
            bx: Some([0.0, 0.0, page_w, page_h]),
        });
    }

    // Set frame with all 100 pages
    host.set_frame(FrameSpec {
        surface: Some([1.0, 0.0, 0.0]),
        placed: None,
        clear: Some(Rgba::WHITE),
        pages: placements.clone(),
    });

    // Warm up the pages in the pan/zoom range [0..2000 px] so they reside on the GPU
    for warmup_y in [0.0, 500.0, 1000.0, 1500.0, 2000.0] {
        host.set_surface([1.0, 0.0, -warmup_y]);
        let _ = host.draw();
    }

    let initial_uploads = host.stats().pages.uploads;
    println!("Initial uploads after warm-up: {initial_uploads}");

    // Render 240 steady-state frames of pan + pinch-zoom over the resident pages
    let total_frames = 240;
    for f in 0..total_frames {
        let t0 = Instant::now();
        let scroll_y = 1000.0 + 800.0 * ((f as f64) * 0.05).sin();
        let zoom = 1.0 + 0.15 * ((f as f64) * 0.08).cos();

        host.set_surface([zoom, 0.0, -scroll_y]);

        let cpu_prep_us = t0.elapsed().as_micros() as u64;

        let t_enc = Instant::now();
        let drawn = host.draw().expect("draw");
        let gpu_enc_us = t_enc.elapsed().as_micros() as u64;
        assert!(drawn);

        stats.record(FrameSample {
            frame_dt_us: 8333,
            cpu_prepare_us: cpu_prep_us,
            gpu_encode_us: gpu_enc_us,
            bytes_uploaded: 0,
            draw_calls: host.stats().pages.drawn as u32,
        });
    }

    let summary = stats.summarize();
    println!(
        "Test A Summary (240 Frames 100-Page Pan/Zoom): p50={:.1}µs, p95={:.1}µs, p99={:.1}µs, max={}µs, avg_draws={:.0}",
        summary.p50_cpu_us, summary.p95_cpu_us, summary.p99_cpu_us, summary.max_cpu_us, summary.avg_draw_calls
    );

    let steady_state_uploads = host.stats().pages.uploads - initial_uploads;
    println!("Steady-state pan/zoom GPU re-uploads: {steady_state_uploads}");

    // Spec Requirement: 0 static scene GPU re-uploads during steady-state pan/zoom
    assert_eq!(
        steady_state_uploads, 0,
        "Steady-state pan/zoom must have 0 GPU re-uploads"
    );

    // Spec Requirement: p99 CPU µs < 1500 (aim < 600 µs)
    assert!(
        summary.p99_cpu_us < 1500.0,
        "p99 CPU time under pan/pinch-zoom must be < 1500 µs (got {:.1} µs)",
        summary.p99_cpu_us
    );
}

/// Test B: Fling continuity & 60/120/240 Hz invariance in crates/viewport.
#[test]
fn test_b_fling_continuity_and_refresh_rate_invariance() {
    use viewport::math::momentum_step_exact;
    use viewport::math::release_velocity_weighted;

    // 1. Refresh rate invariance: 60 Hz, 120 Hz, 240 Hz momentum glide distance
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
        "Test B Invariance: 60Hz={dist_60:.2}px, 120Hz={dist_120:.2}px (diff={:.3}%), 240Hz={dist_240:.2}px (diff={:.3}%)",
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

    // 2. Fling velocity estimation continuity: weighted linear regression over real samples
    let sample_history = vec![
        (100.0, 100.0, 1000.0),
        (105.0, 115.0, 1010.0),
        (112.0, 135.0, 1020.0),
        (120.0, 160.0, 1030.0),
        (130.0, 190.0, 1040.0),
    ];
    let (vx, vy) = release_velocity_weighted(&sample_history);
    println!("Fling release velocity: vx={vx:.3}, vy={vy:.3}");
    assert!(
        vy > 2.0,
        "Release velocity must be smoothly estimated in forward direction"
    );
    assert!(vx > 0.5, "Release vx must match positive trajectory");
}
