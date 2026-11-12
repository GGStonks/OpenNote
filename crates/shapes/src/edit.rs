use nib::geometry::JsMath;
use ink::stroke_geometry;
use model::{Point, ShapeKind, Stroke};
use nib::geometry::XY;
use std::collections::HashSet;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum HandleRole {
    Vertex,
    Center,
    AxisA,
    AxisB,
    Curve,
    End,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ShapeHandle {
    pub x: f64,
    pub y: f64,
    pub role: HandleRole,
    pub index: isize,
    pub anchor: Option<XY>,
}

const MIN_END_SPAN: f64 = 4.0;
const MAX_CURVE_HANDLES: usize = 12;

fn dist(a: XY, b: XY) -> f64 {
    (a.x - b.x).js_hypot(a.y - b.y)
}

fn centroid(pts: &[XY]) -> XY {
    if pts.is_empty() {
        return XY { x: 0.0, y: 0.0 };
    }
    let mut x = 0.0;
    let mut y = 0.0;
    for p in pts {
        x += p.x;
        y += p.y;
    }
    XY {
        x: x / pts.len() as f64,
        y: y / pts.len() as f64,
    }
}

fn curve_handle_indices(n: usize, closed: bool) -> Vec<usize> {
    if n <= MAX_CURVE_HANDLES {
        return (0..n).collect();
    }
    let count = if closed {
        MAX_CURVE_HANDLES
    } else {
        MAX_CURVE_HANDLES - 1
    };
    let mut out = Vec::new();
    for k in 0..count {
        out.push(((k * if closed { n } else { n - 1 }) as f64 / count as f64).round() as usize);
    }
    if !closed {
        out.push(n - 1);
    }
    let set: HashSet<usize> = out.into_iter().collect();
    let mut sorted: Vec<usize> = set.into_iter().collect();
    sorted.sort();
    sorted
}

pub fn shape_handles(s: &Stroke) -> Option<Vec<ShapeHandle>> {
    let is_shape = s.is_shape.unwrap_or(false);
    let closed = s.closed.unwrap_or(false);

    if !is_shape
        && (s.tool == "pen" || s.tool == "highlighter")
        && !closed
        && s.points.len() > 1
    {
        let g = stroke_geometry(s);
        let line = &g.pts;
        if let (Some(a), Some(b)) = (line.first(), line.last()) {
            let a_xy = XY { x: a.x, y: a.y };
            let b_xy = XY { x: b.x, y: b.y };
            if dist(a_xy, b_xy) >= MIN_END_SPAN {
                return Some(vec![
                    ShapeHandle {
                        x: a.x,
                        y: a.y,
                        role: HandleRole::End,
                        index: 0,
                        anchor: Some(b_xy),
                    },
                    ShapeHandle {
                        x: b.x,
                        y: b.y,
                        role: HandleRole::End,
                        index: (s.points.len() - 1) as isize,
                        anchor: Some(a_xy),
                    },
                ]);
            }
        }
        return None;
    }

    if !is_shape || s.tool != "pen" || s.points.is_empty() {
        return None;
    }

    let pts = &s.points;
    let h = |p: XY, role: HandleRole, index: isize| ShapeHandle {
        x: p.x,
        y: p.y,
        role,
        index,
        anchor: None,
    };

    let pts_xy: Vec<XY> = pts.iter().map(|p| XY { x: p.x, y: p.y }).collect();

    match s.shape_kind {
        Some(ShapeKind::Point)
        | Some(ShapeKind::Line)
        | Some(ShapeKind::Polyline)
        | Some(ShapeKind::Triangle)
        | Some(ShapeKind::Polygon)
        | Some(ShapeKind::Rectangle) => {
            Some(pts_xy.into_iter().enumerate().map(|(i, p)| h(p, HandleRole::Vertex, i as isize)).collect())
        }
        Some(ShapeKind::Arrow) => {
            if pts.len() >= 2 {
                Some(vec![
                    h(pts_xy[0], HandleRole::Vertex, 0),
                    h(pts_xy[1], HandleRole::Vertex, 1),
                ])
            } else {
                None
            }
        }
        Some(ShapeKind::Circle) => {
            let c = centroid(&pts_xy);
            Some(vec![h(c, HandleRole::Center, -1), h(pts_xy[0], HandleRole::AxisA, 0)])
        }
        Some(ShapeKind::Ellipse) => {
            let c = centroid(&pts_xy);
            let b_idx = pts.len() / 4;
            Some(vec![
                h(c, HandleRole::Center, -1),
                h(pts_xy[0], HandleRole::AxisA, 0),
                h(pts_xy[b_idx], HandleRole::AxisB, b_idx as isize),
            ])
        }
        Some(ShapeKind::Curve) => {
            let is_closed = closed && pts.len() > 2;
            let indices = curve_handle_indices(pts.len(), is_closed);
            Some(indices.into_iter().map(|i| h(pts_xy[i], HandleRole::Curve, i as isize)).collect())
        }
        _ => None,
    }
}

pub fn ellipse_points(c: XY, a: XY, rb: f64, n: usize) -> Vec<Point> {
    let ra = (a.x).js_hypot(a.y);
    let ux = if ra > 0.0 { a.x / ra } else { 1.0 };
    let uy = if ra > 0.0 { a.y / ra } else { 0.0 };
    let vx = -uy;
    let vy = ux;
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let t = (i as f64 / n as f64) * std::f64::consts::PI * 2.0;
        let ct = t.cos();
        let st = t.sin();
        out.push(Point {
            x: c.x + ra * ct * ux + rb * st * vx,
            y: c.y + ra * ct * uy + rb * st * vy,
            pressure: 0.5,
            t: None,
            alt: None,
            az: None,
        });
    }
    out
}

