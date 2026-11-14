use ink::{
    catmull_rom_beziers, flatten_beziers, inside_polygon, stroke_bounds, stroke_geometry,
    RectBounds,
};
use model::{NotePage, Point, ShapeKind, Stroke};
use nib::geometry::XY;

/// Rendered-geometry helper for accurate selection.
/// - For shapes: uses `s.points`, flattening curves with Catmull-Rom beziers.
/// - For handwriting: uses `stroke_geometry(s).pts` (matches rendered ink, ignores un-inked lift points).
pub fn rendered_stroke_points(s: &Stroke) -> Vec<XY> {
    let is_shape = s.is_shape.unwrap_or(false);
    if is_shape {
        if s.shape_kind == Some(ShapeKind::Curve) {
            let pts_xy: Vec<XY> = s.points.iter().map(|p| XY { x: p.x, y: p.y }).collect();
            let is_closed = s.closed.unwrap_or(false) && pts_xy.len() > 2;
            let beziers = catmull_rom_beziers(&pts_xy, is_closed);
            flatten_beziers(&beziers, 2.0)
        } else {
            s.points.iter().map(|p| XY { x: p.x, y: p.y }).collect()
        }
    } else {
        let g = stroke_geometry(s);
        g.pts.into_iter().map(|p| XY { x: p.x, y: p.y }).collect()
    }
}

/// Tests whether a line segment from a to b intersects an axis-aligned bounding box (Liang-Barsky algorithm).
pub fn segment_intersects_aabb(a: XY, b: XY, rect: &RectBounds) -> bool {
    // If either endpoint is inside the rect, it intersects
    if a.x >= rect.min_x && a.x <= rect.max_x && a.y >= rect.min_y && a.y <= rect.max_y {
        return true;
    }
    if b.x >= rect.min_x && b.x <= rect.max_x && b.y >= rect.min_y && b.y <= rect.max_y {
        return true;
    }

    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let mut t0 = 0.0;
    let mut t1 = 1.0;

    let checks = [
        (-dx, a.x - rect.min_x),
        (dx, rect.max_x - a.x),
        (-dy, a.y - rect.min_y),
        (dy, rect.max_y - a.y),
    ];

    for (p, q) in checks {
        if p == 0.0 {
            if q < 0.0 {
                return false;
            }
        } else {
            let r = q / p;
            if p < 0.0 {
                if r > t1 {
                    return false;
                }
                if r > t0 {
                    t0 = r;
                }
            } else {
                if r < t0 {
                    return false;
                }
                if r < t1 {
                    t1 = r;
                }
            }
        }
    }
    t0 <= t1
}

fn cross(o: XY, a: XY, b: XY) -> f64 {
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
}

fn segments_meet(a: XY, b: XY, c: XY, d: XY) -> bool {
    if a.x.max(b.x) < c.x.min(d.x) || c.x.max(d.x) < a.x.min(b.x) {
        return false;
    }
    if a.y.max(b.y) < c.y.min(d.y) || c.y.max(d.y) < a.y.min(b.y) {
        return false;
    }
    let d1 = cross(c, d, a);
    let d2 = cross(c, d, b);
    let d3 = cross(a, b, c);
    let d4 = cross(a, b, d);
    if ((d1 > 0.0 && d2 < 0.0) || (d1 < 0.0 && d2 > 0.0))
        && ((d3 > 0.0 && d4 < 0.0) || (d3 < 0.0 && d4 > 0.0))
    {
        return true;
    }
    let on = |p: XY, q: XY, r: XY| {
        cross(p, q, r).abs() < 1e-9
            && p.x.min(q.x) <= r.x
            && r.x <= p.x.max(q.x)
            && p.y.min(q.y) <= r.y
            && r.y <= p.y.max(q.y)
    };
    on(c, d, a) || on(c, d, b) || on(a, b, c) || on(a, b, d)
}

/// Tests whether stroke `s` touches or is inside `rect`.
fn stroke_touches_rect(s: &Stroke, rect: &RectBounds) -> bool {
    let b = stroke_bounds(s);
    // Two-stage AABB culling: fast reject if stroke bounding box doesn't touch rect
    if b.max_x < rect.min_x || b.min_x > rect.max_x || b.max_y < rect.min_y || b.min_y > rect.max_y {
        return false;
    }

    let pts = rendered_stroke_points(s);
    if pts.is_empty() {
        return false;
    }

    // 1. Any vertex inside rect
    for p in &pts {
        if p.x >= rect.min_x && p.x <= rect.max_x && p.y >= rect.min_y && p.y <= rect.max_y {
            return true;
        }
    }

    // 2. Any segment intersects rect (Liang-Barsky)
    let n = pts.len();
    let closed = s.closed.unwrap_or(false) && n > 2;
    let seg_count = if closed { n } else { n.saturating_sub(1) };
    for i in 0..seg_count {
        let a = pts[i];
        let b = pts[(i + 1) % n];
        if segment_intersects_aabb(a, b, rect) {
            return true;
        }
    }

    // 3. For closed filled shapes or fill_only: rect overlaps the polygon interior
    let is_filled = (closed
        && s.fill.is_some()
        && s.fill != Some(model::FillType::None)
        && s.fill != Some(model::FillType::Hole))
        || s.fill_only == Some(true);
    if is_filled && n > 2 {
        let center_x = (rect.min_x + rect.max_x) * 0.5;
        let center_y = (rect.min_y + rect.max_y) * 0.5;
        if inside_polygon(center_x, center_y, &pts) || inside_polygon(rect.min_x, rect.min_y, &pts) {
            return true;
        }
    }

    false
}

/// Select strokes intersecting or enclosed by a rectangular selection bounds.
pub fn rect_select_strokes(rect: RectBounds, page: &NotePage) -> Vec<String> {
    let norm_rect = RectBounds {
        min_x: rect.min_x.min(rect.max_x),
        min_y: rect.min_y.min(rect.max_y),
        max_x: rect.min_x.max(rect.max_x),
        max_y: rect.min_y.max(rect.max_y),
    };
    let mut selected = Vec::new();
    for s in &page.strokes {
        if stroke_touches_rect(s, &norm_rect) {
            selected.push(s.id.clone());
        }
    }
    selected
}

/// Tests whether stroke `s` touches or intersects the lasso polygon.
fn stroke_touches_lasso(s: &Stroke, lasso: &[XY], lasso_rect: &RectBounds) -> bool {
    let b = stroke_bounds(s);
    // Two-stage AABB culling
    if b.max_x < lasso_rect.min_x
        || b.min_x > lasso_rect.max_x
        || b.max_y < lasso_rect.min_y
        || b.min_y > lasso_rect.max_y
    {
        return false;
    }

    let pts = rendered_stroke_points(s);
    if pts.is_empty() {
        return false;
    }

    // Check if any point is inside lasso
    for p in &pts {
        if p.x >= lasso_rect.min_x
            && p.x <= lasso_rect.max_x
            && p.y >= lasso_rect.min_y
            && p.y <= lasso_rect.max_y
            && inside_polygon(p.x, p.y, lasso)
        {
            return true;
        }
    }

    // Check if any segment of the stroke intersects any segment of the lasso
    let n = pts.len();
    let closed = s.closed.unwrap_or(false) && n > 2;
    let seg_count = if closed { n } else { n.saturating_sub(1) };
    for i in 0..seg_count {
        let a = pts[i];
        let b = pts[(i + 1) % n];
        if a.x.max(b.x) < lasso_rect.min_x
            || a.x.min(b.x) > lasso_rect.max_x
            || a.y.max(b.y) < lasso_rect.min_y
            || a.y.min(b.y) > lasso_rect.max_y
        {
            continue;
        }
        for j in 0..lasso.len() {
            if segments_meet(a, b, lasso[j], lasso[(j + 1) % lasso.len()]) {
                return true;
            }
        }
    }

    // Closed filled shapes: lasso drawn entirely inside polygon interior
    let is_filled = (closed
        && s.fill.is_some()
        && s.fill != Some(model::FillType::None)
        && s.fill != Some(model::FillType::Hole))
        || s.fill_only == Some(true);
    if is_filled && n > 2 && inside_polygon(lasso[0].x, lasso[0].y, &pts) {
        return true;
    }

    false
}

/// Tests whether points in a candidate stroke touch or are enclosed by the lasso.
/// Replaces the overly-strict `.all(...)` condition so crossing lines and partial
/// enclosures are selected reliably.
pub fn points_in_lasso(lasso: &[XY], item_points: &[Point]) -> bool {
    if lasso.len() < 3 || item_points.is_empty() {
        return false;
    }
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for p in lasso {
        if p.x < min_x { min_x = p.x; }
        if p.y < min_y { min_y = p.y; }
        if p.x > max_x { max_x = p.x; }
        if p.y > max_y { max_y = p.y; }
    }
    let lasso_rect = RectBounds { min_x, min_y, max_x, max_y };

    let mut inside_count = 0;
    for p in item_points {
        if p.x >= min_x && p.x <= max_x && p.y >= min_y && p.y <= max_y && inside_polygon(p.x, p.y, lasso) {
            inside_count += 1;
        }
    }
    if inside_count > 0 {
        return true;
    }

    // Check segment intersections
    let n = item_points.len();
    for i in 1..n {
        let a = XY { x: item_points[i - 1].x, y: item_points[i - 1].y };
        let b = XY { x: item_points[i].x, y: item_points[i].y };
        if a.x.max(b.x) < lasso_rect.min_x
            || a.x.min(b.x) > lasso_rect.max_x
            || a.y.max(b.y) < lasso_rect.min_y
            || a.y.min(b.y) > lasso_rect.max_y
        {
            continue;
        }
        for j in 0..lasso.len() {
            if segments_meet(a, b, lasso[j], lasso[(j + 1) % lasso.len()]) {
                return true;
            }
        }
    }
    false
}

/// Select strokes intersecting or enclosed by a freeform lasso polygon.
pub fn lasso_select_strokes(lasso: &[XY], page: &NotePage) -> Vec<String> {
    if lasso.len() < 3 {
        return Vec::new();
    }
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for p in lasso {
        if p.x < min_x { min_x = p.x; }
        if p.y < min_y { min_y = p.y; }
        if p.x > max_x { max_x = p.x; }
        if p.y > max_y { max_y = p.y; }
    }
    let lasso_rect = RectBounds { min_x, min_y, max_x, max_y };

    let mut selected = Vec::new();
    for s in &page.strokes {
        if stroke_touches_lasso(s, lasso, &lasso_rect) {
            selected.push(s.id.clone());
        }
    }
    selected
}

/// Tight bounding box of selected strokes and blocks on a page.
pub fn selection_bounds(page: &NotePage, ids: &[String]) -> Option<RectBounds> {
    if ids.is_empty() {
        return None;
    }
    let id_set: std::collections::HashSet<&str> = ids.iter().map(|s| s.as_str()).collect();
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    let mut found = false;

    for s in &page.strokes {
        if id_set.contains(s.id.as_str()) {
            let b = stroke_bounds(s);
            if b.min_x < min_x { min_x = b.min_x; }
            if b.min_y < min_y { min_y = b.min_y; }
            if b.max_x > max_x { max_x = b.max_x; }
            if b.max_y > max_y { max_y = b.max_y; }
            found = true;
        }
    }

    for b in &page.latex_blocks {
        if id_set.contains(b.id.as_str()) {
            if b.x < min_x { min_x = b.x; }
            if b.y < min_y { min_y = b.y; }
            if b.x + b.width > max_x { max_x = b.x + b.width; }
            if b.y + b.height > max_y { max_y = b.y + b.height; }
            found = true;
        }
    }

    if let Some(text_blocks) = &page.text_blocks {
        for b in text_blocks {
            if id_set.contains(b.id.as_str()) {
                let h = b.height.unwrap_or(b.font_size * 1.4);
                if b.x < min_x { min_x = b.x; }
                if b.y < min_y { min_y = b.y; }
                if b.x + b.width > max_x { max_x = b.x + b.width; }
                if b.y + h > max_y { max_y = b.y + h; }
                found = true;
            }
        }
    }

    if let Some(image_blocks) = &page.image_blocks {
        for b in image_blocks {
            if id_set.contains(b.id.as_str()) {
                if b.x < min_x { min_x = b.x; }
                if b.y < min_y { min_y = b.y; }
                if b.x + b.width > max_x { max_x = b.x + b.width; }
                if b.y + b.height > max_y { max_y = b.y + b.height; }
                found = true;
            }
        }
    }

    if found {
        Some(RectBounds { min_x, min_y, max_x, max_y })
    } else {
        None
    }
}

/// Scales, rotates, and translates a stroke.
/// Promotes `ShapeKind::Circle` to `ShapeKind::Ellipse` under non-uniform scaling (`scale_x != scale_y`).
pub fn transform_stroke(
    s: &mut Stroke,
    dx: f64,
    dy: f64,
    scale_x: f64,
    scale_y: f64,
    rotation_rad: f64,
    origin: XY,
) {
    if s.shape_kind == Some(ShapeKind::Circle) && (scale_x - scale_y).abs() > 1e-4 {
        s.shape_kind = Some(ShapeKind::Ellipse);
    }
    transform_points(&mut s.points, dx, dy, scale_x, scale_y, rotation_rad, origin);
}

pub fn transform_points(
    points: &mut [Point],
    dx: f64,
    dy: f64,
    scale_x: f64,
    scale_y: f64,
    rotation_rad: f64,
    origin: XY,
) {
    let cos_r = rotation_rad.cos();
    let sin_r = rotation_rad.sin();
    for p in points {
        let rx = (p.x - origin.x) * scale_x;
        let ry = (p.y - origin.y) * scale_y;
        let x_rot = rx * cos_r - ry * sin_r;
        let y_rot = rx * sin_r + ry * cos_r;
        p.x = origin.x + x_rot + dx;
        p.y = origin.y + y_rot + dy;
    }
}

/// Applies transformation across all selected strokes and blocks on a page.
pub fn transform_page_items(
    page: &mut NotePage,
    ids: &[String],
    dx: f64,
    dy: f64,
    scale_x: f64,
    scale_y: f64,
    rotation_rad: f64,
    origin: XY,
) {
    let id_set: std::collections::HashSet<&str> = ids.iter().map(|s| s.as_str()).collect();
    for s in &mut page.strokes {
        if id_set.contains(s.id.as_str()) {
            transform_stroke(s, dx, dy, scale_x, scale_y, rotation_rad, origin);
        }
    }
    let cos_r = rotation_rad.cos();
    let sin_r = rotation_rad.sin();
    let transform_box = |x: &mut f64, y: &mut f64, w: &mut f64, h: &mut f64, rot: &mut Option<f64>| {
        let cx = *x + *w * 0.5;
        let cy = *y + *h * 0.5;
        let rcx = (cx - origin.x) * scale_x;
        let rcy = (cy - origin.y) * scale_y;
        let new_cx = origin.x + (rcx * cos_r - rcy * sin_r) + dx;
        let new_cy = origin.y + (rcx * sin_r + rcy * cos_r) + dy;
        *w *= scale_x.abs();
        *h *= scale_y.abs();
        *x = new_cx - *w * 0.5;
        *y = new_cy - *h * 0.5;
        let cur_deg = rot.unwrap_or(0.0);
        *rot = Some(cur_deg + rotation_rad.to_degrees());
    };

    for b in &mut page.latex_blocks {
        if id_set.contains(b.id.as_str()) {
            transform_box(&mut b.x, &mut b.y, &mut b.width, &mut b.height, &mut b.rotation);
        }
    }
    if let Some(text_blocks) = &mut page.text_blocks {
        for b in text_blocks {
            if id_set.contains(b.id.as_str()) {
                let mut h = b.height.unwrap_or(b.font_size * 1.4);
                transform_box(&mut b.x, &mut b.y, &mut b.width, &mut h, &mut b.rotation);
                b.height = Some(h);
            }
        }
    }
    if let Some(image_blocks) = &mut page.image_blocks {
        for b in image_blocks {
            if id_set.contains(b.id.as_str()) {
                transform_box(&mut b.x, &mut b.y, &mut b.width, &mut b.height, &mut b.rotation);
            }
        }
    }
}
