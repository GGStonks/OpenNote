pub mod builder;
pub mod capsule;
pub mod color;
pub mod paper;
pub mod raster;

pub use builder::{build_glow_ops, build_stroke_ops, FillMode, RenderOp, RenderOpKind};
pub use capsule::{sd_piece, stroke_gl_geometry, Capsule};
pub use color::Rgba;
pub use paper::render_paper_background;
pub use raster::{render_page_thumbnail, PixelBuffer, Renderer};

use model::{NoteDocument, NotePage, PageSetup, Stroke};

pub fn render_strokes(
    strokes: &[Stroke],
    width: usize,
    height: usize,
    scale: f64,
    ox: f64,
    oy: f64,
) -> PixelBuffer {
    let mut buf = PixelBuffer::new(width, height);
    let renderer = Renderer::new(scale, ox, oy);
    let mut ops = Vec::new();
    for s in strokes {
        ops.extend(build_stroke_ops(s));
    }
    renderer.render_scene(&mut buf, &ops, None, None);
    buf
}

pub fn render_page(page: &NotePage, setup: &PageSetup, scale: f64) -> PixelBuffer {
    let w = (setup.width * scale).round() as usize;
    let h = (setup.height * scale).round() as usize;
    let mut buf = PixelBuffer::new(w, h);
    let renderer = Renderer::new(scale, 0.0, 0.0);

    let mut ops = Vec::new();
    for s in &page.strokes {
        ops.extend(build_stroke_ops(s));
    }

    renderer.render_scene(
        &mut buf,
        &ops,
        Some(setup.paper_style),
        Some(&setup.paper_color),
    );
    buf
}

pub fn render_document_page(
    doc: &NoteDocument,
    page_index: usize,
    scale: f64,
) -> Option<PixelBuffer> {
    let pages = model::sheets::split_into_pages(doc);
    if page_index >= pages.len() {
        return None;
    }
    let p = &pages[page_index];
    Some(render_page(&p.page, &p.box_.setup, scale))
}

