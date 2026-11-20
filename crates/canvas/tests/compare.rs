//! The GPU canvas against the CPU renderer (`crates/renderer`, itself within 1 px of the app's
//! canvas) on the 36 reference strokes (bench/rust-ref/ink.json, `npm run bench:rustref --
//! bench/rust-ref/ink.json`) laid out on one page as fountain pen, ballpoint and highlighter, at
//! 1x and 4x: every inked pixel of each within 1 px of the other's ink, total ink within 2%.
//! The same page as the PC harness draws with the app (opennote_canvas_cli).

use canvas::{pc_device, render_offscreen, GpuCanvas, Scene, Transform};
use model::{PenStyle, Point, Stroke};
use renderer::builder::build_stroke_ops;
use renderer::color::Rgba;
use renderer::{PixelBuffer, Renderer};
use serde_json::Value;

/// The reference strokes on an 816 x 1056 page: rows 0-3 fountain pen, 4 ballpoint, 5 highlighter.
pub fn reference_page() -> Vec<Stroke> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../bench/rust-ref/ink.json");
    let refs: Value = serde_json::from_str(
        &std::fs::read_to_string(path)
            .expect("run npm run bench:rustref -- bench/rust-ref/ink.json"),
    )
    .unwrap();
    let mut out = Vec::new();
    for (i, r) in refs["strokes"].as_array().unwrap().iter().enumerate() {
        let pts: Vec<[f64; 4]> = r["points"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| {
                let v: Vec<f64> = p
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|x| x.as_f64().unwrap())
                    .collect();
                [v[0], v[1], v[2], v[3]]
            })
            .collect();
        let (min_x, min_y) = pts.iter().fold((f64::INFINITY, f64::INFINITY), |m, p| {
            (m.0.min(p[0]), m.1.min(p[1]))
        });
        let (max_x, max_y) = pts
            .iter()
            .fold((f64::NEG_INFINITY, f64::NEG_INFINITY), |m, p| {
                (m.0.max(p[0]), m.1.max(p[1]))
            });
        let s = 1f64
            .min(120.0 / (max_x - min_x).max(1.0))
            .min(150.0 / (max_y - min_y).max(1.0));
        let (col, row) = (i % 6, i / 6);
        let (ox, oy) = (15.0 + col as f64 * 133.0, 20.0 + row as f64 * 172.0);
        let points = pts
            .iter()
            .map(|p| Point {
                x: ox + (p[0] - min_x) * s,
                y: oy + (p[1] - min_y) * s,
                pressure: p[3],
                t: Some(p[2]),
                ..Default::default()
            })
            .collect();
        let (tool, pen_style, color) = match row {
            4 => ("pen", Some(PenStyle::Ballpoint), "#1a3d8f"),
            5 => ("highlighter", None, "#f5c400"),
            _ => ("pen", Some(PenStyle::Fountain), "#000000"),
        };
        out.push(Stroke {
            id: format!("s{i}"),
            tool: tool.into(),
            color: color.into(),
            width: r["width"].as_f64().unwrap(),
            opacity: 1.0,
            points,
            pen_style,
            pen_end: if r["penEndFlag"].as_bool() == Some(true) && tool == "pen" {
                Some(true)
            } else {
                None
            },
            created_at: Some(i as f64),
            ..Default::default()
        });
    }
    out
}

fn luma(p: &[u8]) -> f32 {
    0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32
}

/// `name`: share of a's ink pixels with b's ink within `r` px, total darkness ratio b / a.
fn compare(a: &[u8], b: &[u8], w: usize, h: usize, r: isize) -> (f32, f32, f32, usize, usize) {
    let mask = |img: &[u8]| -> Vec<bool> {
        (0..w * h)
            .map(|i| luma(&img[i * 4..i * 4 + 4]) < 245.0)
            .collect()
    };
    let (ma, mb) = (mask(a), mask(b));
    let near = |m: &[bool], x: isize, y: isize| -> bool {
        for dy in -r..=r {
            for dx in -r..=r {
                let (xx, yy) = (x + dx, y + dy);
                if xx >= 0
                    && yy >= 0
                    && (xx as usize) < w
                    && (yy as usize) < h
                    && m[yy as usize * w + xx as usize]
                {
                    return true;
                }
            }
        }
        false
    };
    let (mut na, mut nb, mut ha, mut hb) = (0usize, 0usize, 0usize, 0usize);
    for y in 0..h as isize {
        for x in 0..w as isize {
            let i = y as usize * w + x as usize;
            if ma[i] {
                na += 1;
                if near(&mb, x, y) {
                    ha += 1;
                }
            }
            if mb[i] {
                nb += 1;
                if near(&ma, x, y) {
                    hb += 1;
                }
            }
        }
    }
    let dark = |img: &[u8]| -> f64 {
        (0..w * h)
            .map(|i| 255.0 - luma(&img[i * 4..i * 4 + 4]) as f64)
            .sum()
    };
    (
        ha as f32 / na.max(1) as f32,
        hb as f32 / nb.max(1) as f32,
        (dark(b) / dark(a).max(1.0)) as f32,
        na,
        nb,
    )
}

#[test]
fn gpu_canvas_matches_cpu_renderer() {
    let (device, queue, name) = pc_device().expect("a GPU or software Vulkan on the PC");
    println!("GPU: {name}");
    let mut canvas = GpuCanvas::new(device, queue, wgpu::TextureFormat::Rgba8Unorm);
    let strokes = reference_page();
    let scene = Scene::build(&[&strokes]);
    assert!(
        scene.caps.len() > 1000,
        "only {} capsules",
        scene.caps.len()
    );
    let mut failures = Vec::new();
    for (scale, w, h) in [(1.0f32, 816u32, 1056u32), (4.0, 816 * 4, 300 * 4)] {
        let paper = Rgba::WHITE;
        let gpu = render_offscreen(
            &mut canvas,
            &scene,
            w,
            h,
            &Transform::scale(scale, 0.0, 0.0),
            Some(paper),
        );
        let mut cpu = PixelBuffer::new(w as usize, h as usize);
        cpu.clear(paper);
        let ops: Vec<_> = strokes.iter().flat_map(build_stroke_ops).collect();
        Renderer::new(scale as f64, 0.0, 0.0).render_scene(&mut cpu, &ops, None, None);
        let (a_in_b, b_in_a, dark, na, nb) = compare(&cpu.data, &gpu, w as usize, h as usize, 1);
        println!("{scale}x: ink px cpu {na} gpu {nb}; within 1 px: {:.2}% of cpu's, {:.2}% of gpu's; darkness gpu/cpu {dark:.3}", a_in_b * 100.0, b_in_a * 100.0);
        if a_in_b < 0.995 || b_in_a < 0.995 || (dark - 1.0).abs() > 0.02 {
            failures.push(format!(
                "{scale}x: within 1 px {:.2}% / {:.2}%, darkness {dark:.3}",
                a_in_b * 100.0,
                b_in_a * 100.0
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "GPU canvas differs from the CPU renderer:\n{}",
        failures.join("\n")
    );
}

#[test]
fn canvas_host_renders_paper_and_strokes() {
    use canvas::host::{CanvasHost, FrameSpec, PagePlacement};
    use canvas::Paper;

    let (mut host, name) = CanvasHost::offscreen(816, 1056).expect("offscreen host");
    println!("Host GPU: {name}");
    let strokes = reference_page();
    let caps = host.set_scene("p1", &strokes);
    assert!(caps > 1000, "expected >1000 capsules, got {caps}");

    let paper = Paper {
        width: 816.0,
        height: 1056.0,
        style: Paper::style_code("ruled"),
        base: [1.0, 1.0, 1.0, 1.0],
        dark: false,
        pattern: None,
        origin: [0.0, 0.0],
    };

    host.set_frame(FrameSpec {
        surface: None,
        placed: None,
        clear: Some(Rgba::new(230.0 / 255.0, 230.0 / 255.0, 230.0 / 255.0, 1.0)),
        pages: vec![PagePlacement {
            page: "p1".to_string(),
            tf: Transform::scale(1.0, 0.0, 0.0),
            paper: Some(paper),
            at: None,
        }],
    });

    assert!(host.dirty, "host should be dirty before draw");
    let drew = host.draw().expect("draw succeeds");
    assert!(drew, "host should have drawn");
    assert!(!host.dirty, "host should not be dirty after draw");

    let drew_again = host.draw().expect("second draw succeeds");
    assert!(!drew_again, "second draw when clean should be false");

    let stats = host.stats();
    assert_eq!(stats.frames, 1);
    assert_eq!(stats.scenes, 1);
    assert_eq!(stats.capsules, caps);

    let pixels = host.pixels();
    assert_eq!(pixels.len(), 816 * 1056 * 4);

    // Verify non-empty, contains ink and paper pixels
    let mut dark_count = 0;
    for chunk in pixels.as_chunks::<4>().0 {
        if luma(chunk) < 240.0 {
            dark_count += 1;
        }
    }
    assert!(
        dark_count > 10000,
        "expected dark pixels for paper and ink, got {dark_count}"
    );
}

/// The paper as the page paints it (CanvasPage.tsx paperBackground, CSS gradients in page px,
/// scaled with the zoom), point-sampled 8 x 8 per device pixel: lined papers have a 1 px line at
/// 79 + k gap (k >= 0) and ruled ones the margin at x 79-80 over all; grid and graph lines are
/// 1 px on the surface's lattice (graph's majors over its minors); dots are 1.3 px fading to 0 at
/// 1.7 on the surface's 24 px lattice. The GPU paper must give the same picture at every zoom,
/// also far inside a page much larger than the screen (until rs.26 the pattern vanished past the
/// screen's size of the page's corner, and its 1 device px lines jumped as the zoom changed).
#[test]
fn gpu_paper_follows_the_pages_css_paper() {
    use canvas::{render_frame_offscreen, Frame, PageDraw, Paper};
    use model::{PaperColor, PaperStyle};

    let (device, queue, name) = pc_device().expect("a GPU or software Vulkan on the PC");
    println!("Paper GPU: {name}");
    let mut canvas = GpuCanvas::new(device, queue, wgpu::TextureFormat::Rgba8Unorm);
    let empty_scene = canvas.upload(&Scene {
        caps: vec![],
        flat: vec![],
        ops: vec![],
    });
    type C = [f64; 4];
    let over = |c: [f64; 3], s: C, on: bool| {
        if on {
            [0, 1, 2].map(|i| s[i] * s[3] + c[i] * (1.0 - s[3]))
        } else {
            c
        }
    };
    let over_a =
        |c: [f64; 3], s: C, a: f64| [0, 1, 2].map(|i| s[i] * s[3] * a + c[i] * (1.0 - s[3] * a));
    let md = |v: f64, m: f64| v - (v / m).floor() * m;
    let (sheet_w, sheet_h, origin) = (816.0f32, 1056.0f32, [0.0f32, 1100.0f32]);
    let (w, h) = (160u32, 120u32);
    let n = 8;

    for (color, dark) in [
        (PaperColor::Name("cream".into()), false),
        (PaperColor::Name("dark".into()), true),
    ] {
        let base = {
            let r = renderer::color::Rgba::parse(color.hex(), 1.0);
            [r.r as f64 * 255.0, r.g as f64 * 255.0, r.b as f64 * 255.0]
        };
        let k = |r: f64, g: f64, b: f64, a: f64| -> C { [r, g, b, a] };
        let (line, margin, grid, major, minor, dot) = if dark {
            (
                k(255., 255., 255., 0.13),
                k(239., 68., 68., 0.35),
                k(255., 255., 255., 0.09),
                k(255., 255., 255., 0.16),
                k(255., 255., 255., 0.06),
                k(255., 255., 255., 0.28),
            )
        } else {
            (
                k(59., 130., 246., 0.22),
                k(239., 68., 68., 0.4),
                k(0., 0., 0., 0.08),
                k(0., 0., 0., 0.13),
                k(0., 0., 0., 0.05),
                k(0., 0., 0., 0.22),
            )
        };
        for style in [
            PaperStyle::Ruled,
            PaperStyle::Narrow,
            PaperStyle::Lines,
            PaperStyle::NarrowLines,
            PaperStyle::Grid,
            PaperStyle::Graph,
            PaperStyle::Dots,
        ] {
            let narrow = matches!(style, PaperStyle::Narrow | PaperStyle::NarrowLines);
            let gap = if narrow { 24.0 } else { 32.0 };
            // A spot with the pattern in view at every zoom (a line, the margin, a lattice point).
            let at: (f64, f64) = match style {
                PaperStyle::Ruled | PaperStyle::Lines => (76.2, 493.3),
                PaperStyle::Narrow | PaperStyle::NarrowLines => (76.2, 485.3),
                _ => (70.3, 480.6),
            };
            let css = |px: f64, py: f64| -> [f64; 3] {
                let (sx, sy) = (px + origin[0] as f64, py + origin[1] as f64);
                let mut c = base;
                match style {
                    PaperStyle::Ruled
                    | PaperStyle::Narrow
                    | PaperStyle::Lines
                    | PaperStyle::NarrowLines => {
                        c = over(c, line, py >= 79.0 && md(py - 79.0, gap) < 1.0);
                        if matches!(style, PaperStyle::Ruled | PaperStyle::Narrow) {
                            c = over(c, margin, (79.0..80.0).contains(&px));
                        }
                    }
                    PaperStyle::Grid => {
                        c = over(c, grid, md(sy, 24.0) < 1.0);
                        c = over(c, grid, md(sx, 24.0) < 1.0);
                    }
                    PaperStyle::Graph => {
                        c = over(c, minor, md(sy, 12.0) < 1.0);
                        c = over(c, minor, md(sx, 12.0) < 1.0);
                        c = over(c, major, md(sy, 60.0) < 1.0);
                        c = over(c, major, md(sx, 60.0) < 1.0);
                    }
                    _ => {
                        let (qx, qy) = (
                            sx - (sx / 24.0).round() * 24.0,
                            sy - (sy / 24.0).round() * 24.0,
                        );
                        c = over_a(c, dot, ((1.7 - qx.hypot(qy)) / 0.4).clamp(0.0, 1.0));
                    }
                }
                c
            };
            for zoom in [1.0f64, 1.5, 2.0, 4.33, 9.1, 23.7] {
                let ox = -at.0 * zoom + 0.37;
                let oy = -at.1 * zoom + 0.61;
                let paper =
                    Paper::from_style_and_color(style, &color, sheet_w, sheet_h, origin, None);
                let frame = Frame {
                    clear: None,
                    pages: vec![PageDraw {
                        scene: &empty_scene,
                        tf: Transform::scale(zoom as f32, ox as f32, oy as f32),
                        paper: Some(paper),
                    }],
                };
                let gpu = render_frame_offscreen(&mut canvas, w, h, &frame);
                let (mut worst, mut marked) = (0.0f64, 0usize);
                for y in 0..h {
                    for x in 0..w {
                        let mut acc = [0.0; 3];
                        for j in 0..n {
                            for i in 0..n {
                                let dx = x as f64 + (i as f64 + 0.5) / n as f64;
                                let dy = y as f64 + (j as f64 + 0.5) / n as f64;
                                let c = css((dx - ox) / zoom, (dy - oy) / zoom);
                                (0..3).for_each(|q| acc[q] += c[q]);
                            }
                        }
                        let o = ((y * w + x) * 4) as usize;
                        let mut on = false;
                        for q in 0..3 {
                            let want = acc[q] / (n * n) as f64;
                            worst = worst.max((gpu[o + q] as f64 - want).abs());
                            on |= (gpu[o + q] as f64 - base[q]).abs() > 2.0;
                        }
                        marked += on as usize;
                    }
                }
                assert!(
                    marked > 0,
                    "{style:?} {} at {zoom}x: no pattern in view",
                    color.hex()
                );
                assert!(
                    worst <= 6.0,
                    "{style:?} {} at {zoom}x: a pixel {worst:.1} levels off the page's paper",
                    color.hex()
                );
            }
        }
    }
}

#[test]
fn gpu_paper_custom_pattern_color() {
    use canvas::{render_frame_offscreen, Frame, PageDraw, Paper};
    use model::{PaperColor, PaperStyle};

    let (device, queue, name) = pc_device().expect("a GPU or software Vulkan on the PC");
    println!("Paper Pattern Color GPU: {name}");
    let mut canvas = GpuCanvas::new(device, queue, wgpu::TextureFormat::Rgba8Unorm);
    let empty_scene = canvas.upload(&Scene {
        caps: vec![],
        flat: vec![],
        ops: vec![],
    });

    let (w, h) = (200u32, 200u32);
    let color = PaperColor::Name("white".to_string());
    let pattern_col = [0.0f32, 1.0f32, 0.0f32];
    for &style in &[
        PaperStyle::Ruled,
        PaperStyle::Grid,
        PaperStyle::Graph,
        PaperStyle::Dots,
    ] {
        let paper = Paper::from_style_and_color(
            style,
            &color,
            w as f32,
            h as f32,
            [0.0, 0.0],
            Some(pattern_col),
        );
        let frame = Frame {
            clear: None,
            pages: vec![PageDraw {
                scene: &empty_scene,
                tf: Transform::scale(1.0, 0.0, 0.0),
                paper: Some(paper),
            }],
        };
        let gpu = render_frame_offscreen(&mut canvas, w, h, &frame);
        let mut green_line_pixels = 0;
        for chunk in gpu.as_chunks::<4>().0 {
            if chunk[1] > chunk[0] && chunk[1] > chunk[2] {
                green_line_pixels += 1;
            }
        }
        assert!(
            green_line_pixels > 0,
            "Expected green pattern lines for {style:?}"
        );
    }
}
