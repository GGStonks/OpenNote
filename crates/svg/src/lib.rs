use ink::{dash_pattern, stroke_geometry, stroke_width};
use model::{NoteDocument, NotePage, ShapeKind, Stroke};

pub fn f2(v: f64) -> String {
    format!("{:.2}", v)
}

pub fn stroke_to_svg(s: &Stroke, dy: f64) -> String {
    if s.points.is_empty() {
        return String::new();
    }
    let opacity = s.opacity;

    if s.shape_kind == Some(ShapeKind::Point) {
        let p = s.points[0];
        let r = 2.5f64.max(s.width * 1.7);
        return format!(
            r#"<circle cx="{}" cy="{}" r="{}" fill="{}" fill-opacity="{}"/>"#,
            f2(p.x),
            f2(p.y + dy),
            f2(r),
            s.color,
            opacity
        );
    }

    let is_shape = s.is_shape.unwrap_or(false);
    let closed = s.closed.unwrap_or(false) && s.points.len() > 2;

    let mut out = String::new();

    // Fill
    if closed && s.fill.is_some() && s.fill != Some(model::FillType::None) {
        let fill_color = s.fill_color.as_deref().unwrap_or(&s.color);
        let fill_opacity = s.fill_opacity.unwrap_or(0.22);
        let pts_str: Vec<String> = s
            .points
            .iter()
            .map(|p| format!("{},{}", f2(p.x), f2(p.y + dy)))
            .collect();
        out.push_str(&format!(
            r#"<polygon points="{}" fill="{}" fill-opacity="{}"/>"#,
            pts_str.join(" "),
            fill_color,
            fill_opacity
        ));
    }

    if s.fill_only.unwrap_or(false) {
        return out;
    }

    // Stroke line
    let mut path_d = String::new();
    if is_shape {
        for (i, p) in s.points.iter().enumerate() {
            if i == 0 {
                path_d.push_str(&format!("M {} {}", f2(p.x), f2(p.y + dy)));
            } else {
                path_d.push_str(&format!(" L {} {}", f2(p.x), f2(p.y + dy)));
            }
        }
        if closed {
            path_d.push_str(" Z");
        }
    } else {
        let g = stroke_geometry(s);
        for (i, p) in g.pts.iter().enumerate() {
            if i == 0 {
                path_d.push_str(&format!("M {} {}", f2(p.x), f2(p.y + dy)));
            } else {
                path_d.push_str(&format!(" L {} {}", f2(p.x), f2(p.y + dy)));
            }
        }
        if closed {
            path_d.push_str(" Z");
        }
    }

    let w = stroke_width(s);
    let mut dash_attr = String::new();
    if let Some(pattern) = dash_pattern(s.line_style, s.width) {
        let pat_str: Vec<String> = pattern.iter().map(|&x| f2(x)).collect();
        dash_attr = format!(
            r#" stroke-dasharray="{}" stroke-dashoffset="{}""#,
            pat_str.join(" "),
            f2(s.dash_offset.unwrap_or(0.0))
        );
    }

    out.push_str(&format!(
        r#"<path d="{}" stroke="{}" stroke-width="{}" stroke-linecap="round" stroke-linejoin="round" fill="none" stroke-opacity="{}"{}/>"#,
        path_d, s.color, f2(w), opacity, dash_attr
    ));

    out
}

pub fn page_to_svg(page: &NotePage, width: f64, height: f64) -> String {
    let mut svg = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{}" height="{}" viewBox="0 0 {} {}">"#,
        f2(width),
        f2(height),
        f2(width),
        f2(height)
    );

    // Strokes
    for s in &page.strokes {
        svg.push_str(&stroke_to_svg(s, 0.0));
    }

    // Text blocks
    if let Some(text_blocks) = &page.text_blocks {
        for tb in text_blocks {
            svg.push_str(&format!(
                r#"<text x="{}" y="{}" font-size="{}" fill="{}" font-family="sans-serif">{}</text>"#,
                f2(tb.x),
                f2(tb.y + tb.font_size),
                f2(tb.font_size),
                tb.color,
                quick_xml::escape::escape(&tb.text)
            ));
        }
    }

    // Image blocks
    if let Some(image_blocks) = &page.image_blocks {
        for ib in image_blocks {
            svg.push_str(&format!(
                r#"<image href="{}" x="{}" y="{}" width="{}" height="{}"/>"#,
                quick_xml::escape::escape(&ib.data_url),
                f2(ib.x),
                f2(ib.y),
                f2(ib.width),
                f2(ib.height)
            ));
        }
    }

    svg.push_str("</svg>");
    svg
}

pub fn document_to_svg(doc: &NoteDocument) -> Vec<String> {
    let pages = model::sheets::split_into_pages(doc);
    let mut out = Vec::new();
    for p in pages {
        out.push(page_to_svg(&p.page, p.box_.setup.width, p.box_.setup.height));
    }
    out
}

pub fn build_svg_document(doc: &NoteDocument) -> String {
    let gap = 24.0;
    let pages = model::sheets::split_into_pages(doc);
    if pages.is_empty() {
        return r#"<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0"></svg>"#.to_string();
    }
    let max_w = pages.iter().map(|p| p.box_.setup.width).fold(0.0, f64::max);
    let total_h = pages.iter().map(|p| p.box_.setup.height + gap).sum::<f64>() - gap;

    let mut out = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 {} {}" width="{}" height="{}">"#,
        f2(max_w),
        f2(total_h),
        f2(max_w),
        f2(total_h)
    );

    let mut top = 0.0;
    for (i, p) in pages.iter().enumerate() {
        let dy = top;
        top += p.box_.setup.height + gap;
        let w = p.box_.setup.width;
        let h = p.box_.setup.height;
        let paper = p.box_.setup.paper_color.hex();
        let x_offset = if w < max_w { (max_w - w) / 2.0 } else { 0.0 };

        let transform = if x_offset > 0.0 {
            format!(r#" transform="translate({} 0)""#, f2(x_offset))
        } else {
            String::new()
        };

        out.push_str(&format!(r#"<g id="page-{}"{}>"#, i + 1, transform));
        out.push_str(&format!(
            r#"<rect x="0" y="{}" width="{}" height="{}" fill="{}"/>"#,
            f2(dy),
            f2(w),
            f2(h),
            paper
        ));

        for s in &p.page.strokes {
            out.push_str(&stroke_to_svg(s, dy));
        }

        if let Some(text_blocks) = &p.page.text_blocks {
            for tb in text_blocks {
                out.push_str(&format!(
                    r#"<text x="{}" y="{}" font-size="{}" fill="{}" font-family="sans-serif">{}</text>"#,
                    f2(tb.x),
                    f2(tb.y + dy + tb.font_size),
                    f2(tb.font_size),
                    tb.color,
                    quick_xml::escape::escape(&tb.text)
                ));
            }
        }

        if let Some(image_blocks) = &p.page.image_blocks {
            for ib in image_blocks {
                out.push_str(&format!(
                    r#"<image href="{}" x="{}" y="{}" width="{}" height="{}"/>"#,
                    quick_xml::escape::escape(&ib.data_url),
                    f2(ib.x),
                    f2(ib.y + dy),
                    f2(ib.width),
                    f2(ib.height)
                ));
            }
        }

        out.push_str("</g>");
    }

    out.push_str("</svg>");
    out
}
