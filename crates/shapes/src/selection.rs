use ink::inside_polygon;
use model::{NotePage, Point};
use nib::geometry::XY;

pub fn points_in_lasso(lasso: &[XY], item_points: &[Point]) -> bool {
    if lasso.len() < 3 || item_points.is_empty() {
        return false;
    }
    item_points
        .iter()
        .all(|p| inside_polygon(p.x, p.y, lasso))
}

pub fn lasso_select_strokes(lasso: &[XY], page: &NotePage) -> Vec<String> {
    if lasso.len() < 3 {
        return Vec::new();
    }
    let mut selected = Vec::new();
    for s in &page.strokes {
        if !s.points.is_empty() && points_in_lasso(lasso, &s.points) {
            selected.push(s.id.clone());
        }
    }
    selected
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
