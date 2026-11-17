use ink::{dash_pattern, stroke_geometry, stroke_width};
use model::{NoteDocument, NotePage, ShapeKind, Stroke};
pub use shapes::zorder::ZLayer;

pub fn f2(v: f64) -> String {
    format!("{:.2}", v)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct XY {
    pub x: f64,
    pub y: f64,
}

pub fn capsule_svg(a: XY, ra: f64, b: XY, rb: f64) -> String {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let d = dx.hypot(dy);
    if d <= (ra - rb).abs() + 1e-6 {
        let (c, r) = if ra >= rb { (a, ra) } else { (b, rb) };
        return format!(
            "M{} {}A{} {} 0 1 0 {} {}A{} {} 0 1 0 {} {}Z",
            f2(c.x + r),
            f2(c.y),
            f2(r),
            f2(r),
            f2(c.x - r),
            f2(c.y),
            f2(r),
            f2(r),
            f2(c.x + r),
            f2(c.y)
        );
    }
    let th = dy.atan2(dx);
    let ph = ((ra - rb) / d).clamp(-1.0, 1.0).acos();
    let p = |c: XY, r: f64, ang: f64| format!("{} {}", f2(c.x + r * ang.cos()), f2(c.y + r * ang.sin()));
    use std::f64::consts::PI;
    let large1 = if 2.0 * ph > PI { 1 } else { 0 };
    let large2 = if 2.0 * PI - 2.0 * ph > PI { 1 } else { 0 };
    format!(
        "M{}L{}A{} {} 0 {} 0 {}L{}A{} {} 0 {} 0 {}Z",
        p(a, ra, th + ph),
        p(b, rb, th + ph),
        f2(rb),
        f2(rb),
        large1,
        p(b, rb, th - ph),
        p(a, ra, th - ph),
        f2(ra),
        f2(ra),
        large2,
        p(a, ra, th + ph)
    )
}

const GL_TOLERANCE: f64 = 0.015;

pub fn cap_keep(pts: &[XY], radii: &[f64]) -> Vec<bool> {
    let n = pts.len();
    if n == 0 {
        return Vec::new();
    }
    let mut keep = vec![false; n];
    keep[0] = true;
    keep[n - 1] = true;
    let mut stack = vec![(0, n - 1)];
    while let Some((i, j)) = stack.pop() {
        if j <= i + 1 {
            continue;
        }
        let a = pts[i];
        let b = pts[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let len2 = dx * dx + dy * dy;

        let mut worst = -1.0;
        let mut at = 0;

        for k in (i + 1)..j {
            let p = pts[k];
            let t = if len2 > 0.0 {
                (((p.x - a.x) * dx + (p.y - a.y) * dy) / len2).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let ex = a.x + dx * t - p.x;
            let ey = a.y + dy * t - p.y;
            let er = radii[i] + (radii[j] - radii[i]) * t - radii[k];
            let err = ex.hypot(ey).max(er.abs());
            if err > worst {
                worst = err;
                at = k;
            }
        }

        if worst > GL_TOLERANCE {
            keep[at] = true;
            stack.push((i, at));
            stack.push((at, j));
        }
    }
    keep
}

pub fn arrow_size(width: f64) -> f64 {
    9.0f64.max(width * 4.6)
}

pub fn arrow_head(points: &[XY], s: &Stroke) -> Option<[XY; 3]> {
    if points.len() < 2 {
        return None;
    }
    let tip_orig = points[points.len() - 1];
    let mut from_orig = points[0];
    let mut found = false;
    for i in (0..(points.len() - 1)).rev() {
        let dx = points[i].x - tip_orig.x;
        let dy = points[i].y - tip_orig.y;
        if dx.hypot(dy) > 2.0 {
            from_orig = points[i];
            found = true;
            break;
        }
    }
    if !found {
        return None;
    }

    let ang = (tip_orig.y - from_orig.y).atan2(tip_orig.x - from_orig.x);
    let size = arrow_size(s.width);
    let ext = stroke_width(s) * 0.9;
    let tip = XY {
        x: tip_orig.x + ext * ang.cos(),
        y: tip_orig.y + ext * ang.sin(),
    };
    let w = |a: f64| XY {
        x: tip.x - size * a.cos(),
        y: tip.y - size * a.sin(),
    };
    use std::f64::consts::PI;
    Some([tip, w(ang - PI / 6.0), w(ang + PI / 6.0)])
}

pub fn svg_centerline_d(pts: &[XY], smooth: bool, closed: bool) -> String {
    if pts.is_empty() {
        return String::new();
    }
    let mut d = format!("M{} {}", f2(pts[0].x), f2(pts[0].y));
    if !smooth || pts.len() < 3 {
        for p in &pts[1..] {
            d.push_str(&format!(" L{} {}", f2(p.x), f2(p.y)));
        }
    } else {
        for i in 1..pts.len() {
            let a = pts[i - 1];
            let b = pts[i];
            d.push_str(&format!(
                " Q{} {} {} {}",
                f2(a.x),
                f2(a.y),
                f2((a.x + b.x) / 2.0),
                f2((a.y + b.y) / 2.0)
            ));
        }
        d.push_str(&format!(
            " L{} {}",
            f2(pts[pts.len() - 1].x),
            f2(pts[pts.len() - 1].y)
        ));
    }
    if closed {
        d.push_str(" Z");
    }
    d
}

pub fn stroke_to_svg_with_paper(s: &Stroke, dy: f64, paper: &str) -> String {
    if s.points.is_empty() {
        return String::new();
    }
    let opacity = s.opacity;
    let pts: Vec<XY> = s.points.iter().map(|p| XY { x: p.x, y: p.y + dy }).collect();

    if s.shape_kind == Some(ShapeKind::Point) {
        let r = 2.5f64.max(s.width * 1.7);
        return format!(
            r#"<circle cx="{}" cy="{}" r="{}" fill="{}" fill-opacity="{}"/>"#,
            f2(pts[0].x),
            f2(pts[0].y),
            f2(r),
            s.color,
            opacity
        );
    }

    let is_shape = s.is_shape.unwrap_or(false);
    let closed = s.closed.unwrap_or(false) && pts.len() > 2;

    let (geo_ink, line_d, area_d) = if is_shape {
        let ld = svg_centerline_d(&pts, false, closed);
        let ad = ld.clone();
        (None, ld, ad)
    } else {
        let mut g = stroke_geometry(s);
        if dy != 0.0 {
            for p in &mut g.pts {
                p.y += dy;
            }
        }
        let ink_pts: Vec<XY> = g.pts.iter().map(|p| XY { x: p.x, y: p.y }).collect();
        let mut ld = svg_centerline_d(&ink_pts, false, false);
        if ink_pts.len() == 1 {
            ld.push_str(" l0.01 0");
        }
        let ad = svg_centerline_d(&ink_pts, false, true);
        (Some(g), ld, ad)
    };

    let fill = if closed {
        match s.fill {
            Some(model::FillType::Solid) => {
                let fill_color = s.fill_color.as_deref().unwrap_or(&s.color);
                let fill_opacity = s.fill_opacity.unwrap_or(0.22);
                format!(
                    r#"<path d="{}" fill="{}" fill-opacity="{}" fill-rule="evenodd" stroke="none"/>"#,
                    area_d, fill_color, fill_opacity
                )
            }
            Some(model::FillType::Hole) => {
                format!(
                    r#"<path d="{}" fill="{}" fill-rule="evenodd" stroke="none"/>"#,
                    area_d, paper
                )
            }
            _ => String::new(),
        }
    } else {
        String::new()
    };

    if s.fill_only.unwrap_or(false) {
        return fill;
    }

    let mut out = String::new();

    let runs = if let Some(ref g) = geo_ink {
        if s.tool == "pen" {
            ink::dashes::ink_runs(g, s.line_style, s.width, s.dash_offset.unwrap_or(0.0))
        } else {
            None
        }
    } else {
        None
    };

    let has_widths = geo_ink.as_ref().map(|g| g.widths.is_some()).unwrap_or(false);
    if (runs.is_some() || has_widths) && s.tool == "pen" {
        let g = geo_ink.as_ref().unwrap();
        let default_run = ink::dashes::DashRun {
            pts: g.pts.iter().map(|p| nib::geometry::XY { x: p.x, y: p.y }).collect(),
            radii: match &g.widths {
                Some(w) => w.iter().map(|&x| x / 2.0).collect(),
                None => vec![g.width / 2.0; g.pts.len()],
            },
        };
        let runs_vec: Vec<ink::dashes::DashRun> = match runs {
            Some(r) => r,
            None => vec![default_run],
        };

        let mut parts = Vec::new();
        for run in &runs_vec {
            let p_slice: Vec<XY> = run.pts.iter().map(|p| XY { x: p.x, y: p.y }).collect();
            let r_slice = &run.radii;
            if p_slice.len() == 1 {
                parts.push(capsule_svg(p_slice[0], r_slice[0], p_slice[0], r_slice[0]));
                continue;
            }
            let keep = cap_keep(&p_slice, r_slice);
            let mut prev = 0;
            for k in 1..p_slice.len() {
                if !keep[k] {
                    continue;
                }
                parts.push(capsule_svg(p_slice[prev], r_slice[prev], p_slice[k], r_slice[k]));
                prev = k;
            }
        }
        let d = parts.join("");
        out.push_str(&format!(
            r#"<path d="{}" fill="{}" fill-opacity="{}" fill-rule="nonzero"/>"#,
            d, s.color, opacity
        ));
    } else {
        let dash = dash_pattern(s.line_style, s.width);
        let dash_attr = if let Some(d) = dash {
            let pat_str: Vec<String> = d.iter().map(|&x| f2(x)).collect();
            let off = s.dash_offset.map(|o| format!(r#" stroke-dashoffset="{}""#, f2(o))).unwrap_or_default();
            format!(r#" stroke-dasharray="{}"{}"#, pat_str.join(","), off)
        } else {
            String::new()
        };

        if s.tool == "highlighter" {
            let alpha = s.highlight_alpha.unwrap_or(0.35);
            out.push_str(&format!(
                r#"<path d="{}" fill="none" stroke="{}" stroke-opacity="{}" stroke-width="{}" stroke-linecap="round" stroke-linejoin="round"{}/>"#,
                line_d, s.color, alpha, s.width * 5.5, dash_attr
            ));
        } else {
            let w = if s.line_style == Some(model::LineStyle::Dotted) {
                s.width * 1.8
            } else {
                stroke_width(s)
            };
            out.push_str(&format!(
                r#"<path d="{}" fill="none" stroke="{}" stroke-opacity="{}" stroke-width="{}" stroke-linecap="round" stroke-linejoin="round"{}/>"#,
                line_d, s.color, opacity, f2(w), dash_attr
            ));
        }
    }

    if s.arrow.unwrap_or(false) && !closed {
        if let Some(h) = arrow_head(&pts, s) {
            out.push_str(&format!(
                r#"<path d="M{} {} L{} {} L{} {} Z" fill="{}"/>"#,
                f2(h[0].x),
                f2(h[0].y),
                f2(h[1].x),
                f2(h[1].y),
                f2(h[2].x),
                f2(h[2].y),
                s.color
            ));
        }
    }

    format!("{}{}", fill, out)
}

pub fn stroke_to_svg(s: &Stroke, dy: f64) -> String {
    stroke_to_svg_with_paper(s, dy, "#FFFFFF")
}

fn turn(el: String, deg: Option<f64>, cx: f64, cy: f64) -> String {
    if let Some(deg) = deg {
        if deg != 0.0 {
            return format!(r#"<g transform="rotate({} {} {})">{}</g>"#, deg, f2(cx), f2(cy), el);
        }
    }
    el
}

pub fn layer_svg(l: &ZLayer, dy: f64, paper: &str, _ink: &str) -> String {
    match l {
        ZLayer::Ink { strokes, .. } => {
            let order: Vec<&Stroke> = strokes
                .iter()
                .filter(|s| s.tool == "highlighter")
                .chain(strokes.iter().filter(|s| s.tool != "highlighter"))
                .collect();
            order
                .iter()
                .map(|s| stroke_to_svg_with_paper(s, dy, paper))
                .collect::<Vec<_>>()
                .join("\n")
        }
        ZLayer::Text { block: tb, .. } => {
            let el = format!(
                r#"<text x="{}" y="{}" font-size="{}" fill="{}" font-family="sans-serif">{}</text>"#,
                f2(tb.x),
                f2(tb.y + dy + tb.font_size),
                f2(tb.font_size),
                tb.color,
                quick_xml::escape::escape(&tb.text)
            );
            turn(el, tb.rotation, tb.x + tb.width / 2.0, tb.y + dy + tb.height.unwrap_or(tb.font_size) / 2.0)
        }
        ZLayer::Image { block: ib, .. } => {
            let el = format!(
                r#"<image href="{}" x="{}" y="{}" width="{}" height="{}"/>"#,
                quick_xml::escape::escape(&ib.data_url),
                f2(ib.x),
                f2(ib.y + dy),
                f2(ib.width),
                f2(ib.height)
            );
            turn(el, ib.rotation, ib.x + ib.width / 2.0, ib.y + dy + ib.height / 2.0)
        }
        _ => String::new(),
    }
}

pub fn svg_head(view_box: [f64; 4], _layers: &[ZLayer]) -> String {
    let [x, y, w, h] = view_box;
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" viewBox=\"{} {} {} {}\" width=\"{}\" height=\"{}\">\n",
        x, y, w, h, w, h
    )
}

pub fn page_to_svg(page: &NotePage, width: f64, height: f64) -> String {
    let layers = shapes::zorder::z_layers(page);
    let mut svg = svg_head([0.0, 0.0, width, height], &layers);

    for l in &layers {
        let s = layer_svg(l, 0.0, "#FFFFFF", "#000000");
        if !s.is_empty() {
            svg.push_str(&s);
            svg.push('\n');
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

        let layers = shapes::zorder::z_layers(&p.page);
        for l in &layers {
            let s = layer_svg(l, dy, &paper, "#000000");
            if !s.is_empty() {
                out.push_str(&s);
                out.push('\n');
            }
        }

        out.push_str("</g>");
    }

    out.push_str("</svg>");
    out
}
