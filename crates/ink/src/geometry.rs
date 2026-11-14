use nib::geometry::JsMath;
use crate::ink_width::ink_widths;
use crate::smoothing::settled_smooth;
use model::{ModeledKind, PenStyle, Point, Stroke};
use nib::geometry::{has_real_pressure, thin_modeled_indices, InkPoint, ModeledPoint, XY};
use nib::nib::nib_stroke;
use std::f64::consts::PI;

#[derive(Clone, Debug, PartialEq)]
pub struct InkGeometry {
    pub pts: Vec<ModeledPoint>,
    pub widths: Option<Vec<f64>>,
    pub width: f64,
}

pub fn stroke_width(s: &Stroke) -> f64 {
    let pen_style = s.pen_style.unwrap_or(PenStyle::Fountain);
    let is_shape = s.is_shape.unwrap_or(false);
    s.width * (if pen_style == PenStyle::Ballpoint && !is_shape { 1.5 } else { 1.4 })
}

pub fn is_variable_width(s: &Stroke) -> bool {
    let pen_style = s.pen_style.unwrap_or(PenStyle::Fountain);
    let is_shape = s.is_shape.unwrap_or(false);
    s.tool == "pen" && pen_style == PenStyle::Fountain && !is_shape
}

pub fn pen_end(s: &Stroke) -> Option<Point> {
    if s.pen_end.unwrap_or(false)
        && s.modeled.is_none()
        && !s.is_shape.unwrap_or(false)
        && s.points.len() > 1
    {
        s.points.last().copied()
    } else {
        None
    }
}

const LIFT_TURN_COS: f64 = 0.0;

pub fn without_backward_lift(pts: &[Point]) -> Vec<Point> {
    let n = pts.len();
    if n < 3 {
        return pts.to_vec();
    }
    let mut end_idx = n;
    while end_idx > 1 && !(pts[end_idx - 1].pressure > 0.0) {
        end_idx -= 1;
    }
    let lift_idx = if end_idx < n { end_idx } else { n - 1 };
    if lift_idx < 2 || !(pts[lift_idx - 1].pressure > 0.0) {
        return pts.to_vec();
    }

    let mut j = lift_idx - 1;
    let mut d = 0.0;
    while j > 0 && d < 6.0 {
        d += (pts[j].x - pts[j - 1].x).js_hypot(pts[j].y - pts[j - 1].y);
        j -= 1;
    }
    let bx = pts[lift_idx - 1].x - pts[j].x;
    let by = pts[lift_idx - 1].y - pts[j].y;
    let bl = bx.js_hypot(by);

    let lx = pts[n - 1].x - pts[lift_idx - 1].x;
    let ly = pts[n - 1].y - pts[lift_idx - 1].y;
    let ll = lx.js_hypot(ly);

    if bl < 1.0 || ll < 0.05 {
        return pts.to_vec();
    }
    if (bx * lx + by * ly) / (bl * ll) < LIFT_TURN_COS {
        pts[0..lift_idx].to_vec()
    } else {
        pts.to_vec()
    }
}

/// Minimal pressure floor below which coordinates are susceptible to digitizer centroid liftoff jitter.
pub const LIFTOFF_PRESSURE_FLOOR: f64 = 0.05;

/// Filters liftoff jitter on stylus strokes (Mechanism 2):
/// If pressure drops below `LIFTOFF_PRESSURE_FLOOR` during the final frames before liftoff,
/// ignores (x, y) coordinate jitter (keeps the last stable coordinate) while preserving
/// the tapering pressure so stroke width finishes cleanly without digitizer centroid wobble.
pub fn filter_liftoff_jitter(pts: &[Point]) -> Vec<Point> {
    if pts.len() < 3 {
        return pts.to_vec();
    }
    let mut out = pts.to_vec();
    let n = out.len();

    let mut stable_idx = n - 1;
    while stable_idx > 0 && out[stable_idx].pressure < LIFTOFF_PRESSURE_FLOOR {
        stable_idx -= 1;
    }

    if stable_idx < n - 1 {
        let stable_x = out[stable_idx].x;
        let stable_y = out[stable_idx].y;
        for i in (stable_idx + 1)..n {
            out[i].x = stable_x;
            out[i].y = stable_y;
        }
    }

    out
}

pub fn engine_points(s: &Stroke) -> Vec<Point> {
    let pts = if pen_end(s).is_some() {
        &s.points[0..s.points.len().saturating_sub(1)]
    } else {
        &s.points[..]
    };
    if s.modeled.is_some() || s.is_shape.unwrap_or(false) {
        return pts.to_vec();
    }

    let ink_pts: Vec<InkPoint> = pts
        .iter()
        .map(|p| InkPoint {
            x: p.x,
            y: p.y,
            pressure: p.pressure,
            t: p.t,
        })
        .collect();

    if !has_real_pressure(&ink_pts) {
        return without_backward_lift(pts);
    }

    let mut k = pts.len();
    while k > 1 && !(pts[k - 1].pressure > 0.0) {
        k -= 1;
    }
    pts[0..k].to_vec()
}

pub fn modeled_line(points: &[Point], modeled: Option<ModeledKind>) -> Vec<ModeledPoint> {
    if modeled.is_some() {
        return points
            .iter()
            .map(|q| ModeledPoint {
                x: q.x,
                y: q.y,
                p: q.pressure,
                t: q.t.unwrap_or(0.0),
            })
            .collect();
    }
    let ink_pts: Vec<InkPoint> = points
        .iter()
        .map(|p| InkPoint {
            x: p.x,
            y: p.y,
            pressure: p.pressure,
            t: p.t,
        })
        .collect();
    nib_stroke(&ink_pts)
}

pub fn ink_geometry(points: &[Point], s: &Stroke) -> InkGeometry {
    let line = modeled_line(points, s.modeled);
    let kept_indices = thin_modeled_indices(&line, 0.35);
    let pts: Vec<ModeledPoint> = kept_indices.iter().map(|&i| line[i]).collect();
    let width = if s.tool == "highlighter" {
        s.width * 5.5
    } else {
        stroke_width(s)
    };

    let ink_pts: Vec<InkPoint> = points
        .iter()
        .map(|p| InkPoint {
            x: p.x,
            y: p.y,
            pressure: p.pressure,
            t: p.t,
        })
        .collect();

    let pressured = if s.modeled.is_some() {
        s.modeled != Some(ModeledKind::Uniform)
    } else {
        has_real_pressure(&ink_pts)
    };
    let share = s.modeled == Some(ModeledKind::Proportional);

    let mut widths = None;
    if is_variable_width(s) && pressured {
        if share {
            widths = Some(pts.iter().map(|p| width * 0.02f64.max(p.p)).collect());
        } else {
            let all = ink_widths(&line, width);
            if kept_indices.len() == line.len() {
                widths = Some(all);
            } else {
                widths = Some(
                    kept_indices
                        .iter()
                        .map(|&i| all[i.min(all.len().saturating_sub(1))])
                        .collect(),
                );
            }
        }
    }

    InkGeometry { pts, widths, width }
}

pub fn to_pen_end(mut g: InkGeometry, end: Option<Point>) -> InkGeometry {
    let last = g.pts.last().copied();
    if let (Some(e), Some(l)) = (end, last) {
        if (e.x - l.x).js_hypot(e.y - l.y) >= 0.05 {
            g.pts.push(ModeledPoint {
                x: e.x,
                y: e.y,
                p: l.p,
                t: l.t,
            });
            if let Some(w) = &mut g.widths {
                let last_w = w.last().copied().unwrap_or(g.width);
                w.push(last_w);
            }
        }
    }
    g
}

pub fn stroke_geometry(s: &Stroke) -> InkGeometry {
    let pts = engine_points(s);
    let mut g = ink_geometry(&pts, s);
    if s.modeled.is_none() && !s.is_shape.unwrap_or(false) {
        g.pts = settled_smooth(&g.pts);
    }
    to_pen_end(g, pen_end(s))
}

pub fn dist_to_polyline(p: XY, poly: &[XY]) -> (f64, usize) {
    if poly.len() <= 1 {
        let d = if let Some(first) = poly.first() {
            (p.x - first.x).js_hypot(p.y - first.y)
        } else {
            0.0
        };
        return (d, 0);
    }
    let mut best = f64::INFINITY;
    let mut bi = 0;
    for i in 1..poly.len() {
        let a = poly[i - 1];
        let b = poly[i];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let l2 = dx * dx + dy * dy;
        let u = if l2 > 0.0 {
            (((p.x - a.x) * dx + (p.y - a.y) * dy) / l2).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let d = (p.x - a.x - u * dx).js_hypot(p.y - a.y - u * dy);
        if d < best {
            best = d;
            bi = if u < 0.5 { i - 1 } else { i };
        }
    }
    (best, bi)
}

pub fn wobble(pts: &[XY]) -> (f64, usize) {
    if pts.is_empty() {
        return (0.0, 0);
    }
    let mut r = vec![pts[0]];
    let mut carry = 0.0;
    for i in 1..pts.len() {
        let a = pts[i - 1];
        let b = pts[i];
        let l = (b.x - a.x).js_hypot(b.y - a.y);
        let mut s = 1.0 - carry;
        while s <= l {
            r.push(XY {
                x: a.x + ((b.x - a.x) * s) / l,
                y: a.y + ((b.y - a.y) * s) / l,
            });
            s += 1.0;
        }
        carry = l - (s - 1.0);
    }

    let mut k = Vec::new();
    for i in 1..r.len().saturating_sub(1) {
        let t1 = (r[i].y - r[i - 1].y).atan2(r[i].x - r[i - 1].x);
        let t2 = (r[i + 1].y - r[i].y).atan2(r[i + 1].x - r[i].x);
        let mut d = t2 - t1;
        while d > PI {
            d -= 2.0 * PI;
        }
        while d < -PI {
            d += 2.0 * PI;
        }
        k.push(d);
    }

    let mut sum = 0.0;
    let mut n = 0;
    for i in 1..k.len() {
        if k[i].abs() > 0.7 || k[i - 1].abs() > 0.7 {
            continue;
        }
        sum += (k[i] - k[i - 1]).powi(2);
        n += 1;
    }
    (sum, n)
}

pub fn arcs(p: &[XY]) -> Vec<f64> {
    let mut a = vec![0.0; p.len()];
    for i in 1..p.len() {
        a[i] = a[i - 1] + (p[i].x - p[i - 1].x).js_hypot(p[i].y - p[i - 1].y);
    }
    a
}
