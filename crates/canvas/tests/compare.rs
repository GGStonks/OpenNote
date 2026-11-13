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
    let refs: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("run npm run bench:rustref -- bench/rust-ref/ink.json")).unwrap();
    let mut out = Vec::new();
    for (i, r) in refs["strokes"].as_array().unwrap().iter().enumerate() {
        let pts: Vec<[f64; 4]> = r["points"].as_array().unwrap().iter().map(|p| { let v: Vec<f64> = p.as_array().unwrap().iter().map(|x| x.as_f64().unwrap()).collect(); [v[0], v[1], v[2], v[3]] }).collect();
        let (min_x, min_y) = pts.iter().fold((f64::INFINITY, f64::INFINITY), |m, p| (m.0.min(p[0]), m.1.min(p[1])));
        let (max_x, max_y) = pts.iter().fold((f64::NEG_INFINITY, f64::NEG_INFINITY), |m, p| (m.0.max(p[0]), m.1.max(p[1])));
        let s = 1f64.min(120.0 / (max_x - min_x).max(1.0)).min(150.0 / (max_y - min_y).max(1.0));
        let (col, row) = (i % 6, i / 6);
        let (ox, oy) = (15.0 + col as f64 * 133.0, 20.0 + row as f64 * 172.0);
        let points = pts.iter().map(|p| Point { x: ox + (p[0] - min_x) * s, y: oy + (p[1] - min_y) * s, pressure: p[3], t: Some(p[2]), ..Default::default() }).collect();
        let (tool, pen_style, color) = match row { 4 => ("pen", Some(PenStyle::Ballpoint), "#1a3d8f"), 5 => ("highlighter", None, "#f5c400"), _ => ("pen", Some(PenStyle::Fountain), "#000000") };
        out.push(Stroke {
            id: format!("s{i}"), tool: tool.into(), color: color.into(), width: r["width"].as_f64().unwrap(), opacity: 1.0, points, pen_style,
            pen_end: if r["penEndFlag"].as_bool() == Some(true) && tool == "pen" { Some(true) } else { None },
            created_at: Some(i as f64), ..Default::default()
        });
    }
    out
}

fn luma(p: &[u8]) -> f32 {
    0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32
}

/// `name`: share of a's ink pixels with b's ink within `r` px, total darkness ratio b / a.
fn compare(a: &[u8], b: &[u8], w: usize, h: usize, r: isize) -> (f32, f32, f32, usize, usize) {
    let mask = |img: &[u8]| -> Vec<bool> { (0..w * h).map(|i| luma(&img[i * 4..i * 4 + 4]) < 245.0).collect() };
    let (ma, mb) = (mask(a), mask(b));
    let near = |m: &[bool], x: isize, y: isize| -> bool {
        for dy in -r..=r {
            for dx in -r..=r {
                let (xx, yy) = (x + dx, y + dy);
                if xx >= 0 && yy >= 0 && (xx as usize) < w && (yy as usize) < h && m[yy as usize * w + xx as usize] {
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
            if ma[i] { na += 1; if near(&mb, x, y) { ha += 1; } }
            if mb[i] { nb += 1; if near(&ma, x, y) { hb += 1; } }
        }
    }
    let dark = |img: &[u8]| -> f64 { (0..w * h).map(|i| 255.0 - luma(&img[i * 4..i * 4 + 4]) as f64).sum() };
    (ha as f32 / na.max(1) as f32, hb as f32 / nb.max(1) as f32, (dark(b) / dark(a).max(1.0)) as f32, na, nb)
}

#[test]
fn gpu_canvas_matches_cpu_renderer() {
    let (device, queue, name) = pc_device().expect("a GPU or software Vulkan on the PC");
    println!("GPU: {name}");
    let mut canvas = GpuCanvas::new(device, queue, wgpu::TextureFormat::Rgba8Unorm);
    let strokes = reference_page();
    let scene = Scene::build(&[&strokes]);
    assert!(scene.caps.len() > 1000, "only {} capsules", scene.caps.len());
    let mut failures = Vec::new();
    for (scale, w, h) in [(1.0f32, 816u32, 1056u32), (4.0, 816 * 4, 300 * 4)] {
        let paper = Rgba::WHITE;
        let gpu = render_offscreen(&mut canvas, &scene, w, h, &Transform::scale(scale, 0.0, 0.0), Some(paper));
        let mut cpu = PixelBuffer::new(w as usize, h as usize);
        cpu.clear(paper);
        let ops: Vec<_> = strokes.iter().flat_map(build_stroke_ops).collect();
        Renderer::new(scale as f64, 0.0, 0.0).render_scene(&mut cpu, &ops, None, None);
        let (a_in_b, b_in_a, dark, na, nb) = compare(&cpu.data, &gpu, w as usize, h as usize, 1);
        println!("{scale}x: ink px cpu {na} gpu {nb}; within 1 px: {:.2}% of cpu's, {:.2}% of gpu's; darkness gpu/cpu {dark:.3}", a_in_b * 100.0, b_in_a * 100.0);
        if a_in_b < 0.995 || b_in_a < 0.995 || (dark - 1.0).abs() > 0.02 {
            failures.push(format!("{scale}x: within 1 px {:.2}% / {:.2}%, darkness {dark:.3}", a_in_b * 100.0, b_in_a * 100.0));
        }
    }
    assert!(failures.is_empty(), "GPU canvas differs from the CPU renderer:\n{}", failures.join("\n"));
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
        clear: Some(Rgba::new(230.0 / 255.0, 230.0 / 255.0, 230.0 / 255.0, 1.0)),
        pages: vec![PagePlacement {
            page: "p1".to_string(),
            tf: Transform::scale(1.0, 0.0, 0.0),
            paper: Some(paper),
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
    for chunk in pixels.chunks_exact(4) {
        if luma(chunk) < 240.0 {
            dark_count += 1;
        }
    }
    assert!(dark_count > 10000, "expected dark pixels for paper and ink, got {dark_count}");
}

