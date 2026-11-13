//! The GPU canvas on the PC, for the harness that compares it with the app's own drawing
//! (bench/ui.mjs, scratch scripts): `opennote_canvas_cli <page.json> <width> <height> <scale>
//! [paper #rrggbb]`, the page's strokes as the app stores them (JSON array), raw RGBA8 on stdout.
use canvas::{pc_device, render_offscreen, GpuCanvas, Scene, Transform};
use model::Stroke;
use renderer::color::Rgba;
use std::io::Write;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 5 {
        eprintln!("usage: opennote_canvas_cli <page.json> <width> <height> <scale> [paper #rrggbb]");
        std::process::exit(2);
    }
    let strokes: Vec<Stroke> = serde_json::from_str(&std::fs::read_to_string(&args[1]).expect("page.json")).expect("strokes JSON");
    let (w, h, scale): (u32, u32, f32) = (args[2].parse().unwrap(), args[3].parse().unwrap(), args[4].parse().unwrap());
    let paper = args.get(5).map(|c| Rgba::parse(c, 1.0)).unwrap_or(Rgba::WHITE);
    let (device, queue, name) = pc_device().expect("GPU");
    eprintln!("GPU: {name}");
    let mut canvas = GpuCanvas::new(device, queue, wgpu::TextureFormat::Rgba8Unorm);
    let scene = Scene::build(&[&strokes]);
    let t0 = std::time::Instant::now();
    let px = render_offscreen(&mut canvas, &scene, w, h, &Transform::scale(scale, 0.0, 0.0), Some(paper));
    eprintln!("{} strokes, {} capsules, {} ops: {:.1} ms (upload, draw, read back)", strokes.len(), scene.caps.len(), scene.ops.len(), t0.elapsed().as_secs_f64() * 1000.0);
    std::io::stdout().write_all(&px).unwrap();
}
