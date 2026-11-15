use nib::geometry::JsMath;
use ink::stroke_geometry;
use model::{Point, ShapeKind, Stroke};
use nib::geometry::XY;
use crate::recognition::{find_snap_target, SnapGuide, SnapKind, SnapOptions};

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HandleRole {
    Vertex,
    Center,
    AxisA,
    AxisB,
    Curve,
    End,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
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

fn centroid_points(pts: &[Point]) -> XY {
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
    let mut out = Vec::with_capacity(count + 1);
    let step_n = if closed { n } else { n - 1 };
    for k in 0..count {
        out.push(((k * step_n) as f64 / count as f64).round() as usize);
    }
    if !closed {
        out.push(n - 1);
    }
    out.dedup();
    out
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

    match s.shape_kind {
        Some(ShapeKind::Point)
        | Some(ShapeKind::Line)
        | Some(ShapeKind::Polyline)
        | Some(ShapeKind::Triangle)
        | Some(ShapeKind::Polygon)
        | Some(ShapeKind::Rectangle) => {
            Some(pts.iter().enumerate().map(|(i, p)| h(XY { x: p.x, y: p.y }, HandleRole::Vertex, i as isize)).collect())
        }
        Some(ShapeKind::Arrow) => {
            if pts.len() >= 2 {
                Some(vec![
                    h(XY { x: pts[0].x, y: pts[0].y }, HandleRole::Vertex, 0),
                    h(XY { x: pts[1].x, y: pts[1].y }, HandleRole::Vertex, 1),
                ])
            } else {
                None
            }
        }
        Some(ShapeKind::Circle) => {
            let c = centroid_points(pts);
            Some(vec![h(c, HandleRole::Center, -1), h(XY { x: pts[0].x, y: pts[0].y }, HandleRole::AxisA, 0)])
        }
        Some(ShapeKind::Ellipse) => {
            let c = centroid_points(pts);
            let b_idx = pts.len() / 4;
            Some(vec![
                h(c, HandleRole::Center, -1),
                h(XY { x: pts[0].x, y: pts[0].y }, HandleRole::AxisA, 0),
                h(XY { x: pts[b_idx].x, y: pts[b_idx].y }, HandleRole::AxisB, b_idx as isize),
            ])
        }
        Some(ShapeKind::Curve) => {
            let is_closed = closed && pts.len() > 2;
            let indices = curve_handle_indices(pts.len(), is_closed);
            Some(indices.into_iter().map(|i| h(XY { x: pts[i].x, y: pts[i].y }, HandleRole::Curve, i as isize)).collect())
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

pub fn move_shape_handle(
    orig: &Stroke,
    handle: &ShapeHandle,
    target: XY,
    page: Option<&model::NotePage>,
    opts: Option<&SnapOptions>,
) -> (Stroke, Option<SnapGuide>) {
    let mut to = target;
    let mut guide = None;

    // 1. Context snapping (objects / grid)
    if let Some(o) = opts {
        if let Some(g) = find_snap_target(target, page, Some(&orig.id), o) {
            to = g.at;
            guide = Some(g);
        }
    }

    // 2. Angle snapping for Line, Arrow, or open stroke ends (0, 45, 90, 135, 180, etc.)
    if guide.is_none() {
        let anchor_pt = if handle.role == HandleRole::End {
            handle.anchor
        } else if (orig.shape_kind == Some(ShapeKind::Line) || orig.shape_kind == Some(ShapeKind::Arrow)) && orig.points.len() >= 2 {
            if handle.index == 0 {
                Some(XY { x: orig.points[1].x, y: orig.points[1].y })
            } else {
                Some(XY { x: orig.points[0].x, y: orig.points[0].y })
            }
        } else {
            None
        };

        if let Some(anc) = anchor_pt {
            let dx = to.x - anc.x;
            let dy = to.y - anc.y;
            let len = dx.js_hypot(dy);
            if len > 8.0 {
                let ang = dy.atan2(dx);
                let pi = std::f64::consts::PI;
                let step = pi / 4.0; // 45 degrees
                let snapped_ang = (ang / step).round() * step;
                if (ang - snapped_ang).abs() < (6.0 * pi) / 180.0 {
                    to = XY {
                        x: anc.x + len * snapped_ang.cos(),
                        y: anc.y + len * snapped_ang.sin(),
                    };
                    guide = Some(SnapGuide {
                        at: to,
                        kind: SnapKind::Angle,
                        line: Some([anc, to]),
                    });
                }
            }
        }
    }

    // 3. Move the handle
    if handle.role == HandleRole::End && handle.anchor.is_some() {
        let st = swing_about(orig, handle.anchor.unwrap(), XY { x: handle.x, y: handle.y }, to);
        return (st, guide);
    }

    let pts = &orig.points;
    let kind = orig.shape_kind;
    let dx = to.x - handle.x;
    let dy = to.y - handle.y;

    let res = match kind {
        Some(ShapeKind::Point)
        | Some(ShapeKind::Line)
        | Some(ShapeKind::Polyline)
        | Some(ShapeKind::Triangle)
        | Some(ShapeKind::Polygon) => {
            let mut new_pts = pts.clone();
            let idx = handle.index as usize;
            if idx < new_pts.len() {
                new_pts[idx].x = to.x;
                new_pts[idx].y = to.y;
            }
            let mut st = orig.clone();
            st.points = new_pts;
            st
        }

        Some(ShapeKind::Arrow) => {
            let mut new_pts = pts.clone();
            if new_pts.len() < 5 {
                let idx = handle.index as usize;
                if idx < new_pts.len() {
                    new_pts[idx].x = to.x;
                    new_pts[idx].y = to.y;
                }
            } else {
                let tail = if handle.index == 0 { to } else { XY { x: new_pts[0].x, y: new_pts[0].y } };
                let tip = if handle.index == 1 { to } else { XY { x: new_pts[1].x, y: new_pts[1].y } };
                let head_len = dist(XY { x: new_pts[2].x, y: new_pts[2].y }, XY { x: new_pts[1].x, y: new_pts[1].y });
                let spread = (28.0 * std::f64::consts::PI) / 180.0;
                let dir = (tip.y - tail.y).atan2(tip.x - tail.x);
                let pi = std::f64::consts::PI;

                new_pts[0].x = tail.x;
                new_pts[0].y = tail.y;
                new_pts[1].x = tip.x;
                new_pts[1].y = tip.y;
                new_pts[2].x = tip.x + head_len * (dir + pi - spread).cos();
                new_pts[2].y = tip.y + head_len * (dir + pi - spread).sin();
                new_pts[3].x = tip.x;
                new_pts[3].y = tip.y;
                new_pts[4].x = tip.x + head_len * (dir + pi + spread).cos();
                new_pts[4].y = tip.y + head_len * (dir + pi + spread).sin();
            }
            let mut st = orig.clone();
            st.points = new_pts;
            st
        }

        Some(ShapeKind::Rectangle) => {
            if pts.len() != 4 {
                let mut new_pts = pts.clone();
                let idx = handle.index as usize;
                if idx < new_pts.len() {
                    new_pts[idx].x = to.x;
                    new_pts[idx].y = to.y;
                }
                let mut st = orig.clone();
                st.points = new_pts;
                st
            } else {
                let idx = handle.index as usize % 4;
                let opp_idx = (idx + 2) % 4;
                let opp = pts[opp_idx];

                let lu = dist(XY { x: pts[1].x, y: pts[1].y }, XY { x: pts[0].x, y: pts[0].y }).max(1e-4);
                let ux = (pts[1].x - pts[0].x) / lu;
                let uy = (pts[1].y - pts[0].y) / lu;
                let vx = -uy;
                let vy = ux;

                let d_opp_x = to.x - opp.x;
                let d_opp_y = to.y - opp.y;
                let du = d_opp_x * ux + d_opp_y * uy;
                let dv = d_opp_x * vx + d_opp_y * vy;

                let mut new_pts = pts.clone();
                new_pts[opp_idx] = opp;
                new_pts[idx] = Point { x: opp.x + du * ux + dv * vx, y: opp.y + du * uy + dv * vy, pressure: 0.5, t: None, alt: None, az: None };
                let adj1 = (idx + 1) % 4;
                let adj2 = (idx + 3) % 4;
                let adj1_is_u = (pts[adj1].x - opp.x) * ux + (pts[adj1].y - opp.y) * uy;
                if adj1_is_u.abs() > 1e-4 {
                    new_pts[adj1] = Point { x: opp.x + du * ux, y: opp.y + du * uy, pressure: 0.5, t: None, alt: None, az: None };
                    new_pts[adj2] = Point { x: opp.x + dv * vx, y: opp.y + dv * vy, pressure: 0.5, t: None, alt: None, az: None };
                } else {
                    new_pts[adj1] = Point { x: opp.x + dv * vx, y: opp.y + dv * vy, pressure: 0.5, t: None, alt: None, az: None };
                    new_pts[adj2] = Point { x: opp.x + du * ux, y: opp.y + du * uy, pressure: 0.5, t: None, alt: None, az: None };
                }

                let mut st = orig.clone();
                st.points = new_pts;
                st
            }
        }

        Some(ShapeKind::Circle) | Some(ShapeKind::Ellipse) => {
            let c = centroid_points(pts);
            let n = pts.len();
            let a = XY { x: pts[0].x - c.x, y: pts[0].y - c.y };
            let qb = pts[(n / 4) % n];
            let rb = (qb.x - c.x).js_hypot(qb.y - c.y);

            let new_points = if handle.role == HandleRole::Center {
                pts.iter().map(|p| Point { x: p.x + dx, y: p.y + dy, pressure: p.pressure, t: p.t, alt: p.alt, az: p.az }).collect()
            } else if handle.role == HandleRole::AxisA {
                let na = XY { x: to.x - c.x, y: to.y - c.y };
                let ra = na.x.js_hypot(na.y);
                if ra < 2.0 {
                    pts.clone()
                } else {
                    ellipse_points(c, na, if kind == Some(ShapeKind::Circle) { ra } else { rb }, n)
                }
            } else {
                let ra = a.x.js_hypot(a.y).max(1e-4);
                let nb = (((to.x - c.x) * -a.y + (to.y - c.y) * a.x) / ra).abs();
                if nb < 2.0 {
                    pts.clone()
                } else {
                    ellipse_points(c, a, nb, n)
                }
            };
            let mut st = orig.clone();
            st.points = new_points;
            st
        }

        Some(ShapeKind::Curve) => {
            let closed = orig.closed.unwrap_or(false) && pts.len() > 2;
            let n = pts.len();
            let handles = curve_handle_indices(n, closed);
            let hi = handles.iter().position(|&x| x == handle.index as usize).unwrap_or(0);
            let prev = if hi > 0 {
                handles[hi - 1] as isize
            } else if closed {
                handles[handles.len() - 1] as isize - n as isize
            } else {
                handle.index
            };
            let next = if hi < handles.len() - 1 {
                handles[hi + 1] as isize
            } else if closed {
                handles[0] as isize + n as isize
            } else {
                handle.index
            };
            let left = (handle.index - prev).max(1) as f64;
            let right = (next - handle.index).max(1) as f64;

            let pi = std::f64::consts::PI;
            let mut new_pts = pts.clone();
            for (i, p) in new_pts.iter_mut().enumerate() {
                let mut off = i as isize - handle.index;
                if closed {
                    if off > (n / 2) as isize { off -= n as isize; }
                    if off < -((n / 2) as isize) { off += n as isize; }
                }
                let span = if off < 0 { left } else { right };
                let t = off.abs() as f64 / span;
                if t < 1.0 {
                    let w = 0.5 * (1.0 + (pi * t).cos());
                    p.x += dx * w;
                    p.y += dy * w;
                }
            }
            let mut st = orig.clone();
            st.points = new_pts;
            st
        }

        _ => orig.clone(),
    };

    (res, guide)
}

fn swing_about(orig: &Stroke, anchor: XY, from: XY, to: XY) -> Stroke {
    let fx = from.x - anchor.x;
    let fy = from.y - anchor.y;
    let f2 = fx * fx + fy * fy;
    if f2 < 1e-9 {
        return orig.clone();
    }
    let tx = to.x - anchor.x;
    let ty = to.y - anchor.y;
    let c = (tx * fx + ty * fy) / f2;
    let sn = (ty * fx - tx * fy) / f2;
    let points = orig.points.iter().map(|p| {
        let x = p.x - anchor.x;
        let y = p.y - anchor.y;
        Point {
            x: anchor.x + c * x - sn * y,
            y: anchor.y + sn * x + c * y,
            pressure: p.pressure,
            t: p.t,
            alt: p.alt,
            az: p.az,
        }
    }).collect();
    let turned = (sn.atan2(c) * 180.0) / std::f64::consts::PI;
    let rotation = ((orig.rotation.unwrap_or(0.0) + turned) % 360.0 + 360.0) % 360.0;
    let mut out = orig.clone();
    out.points = points;
    if turned.abs() > 1e-6 || orig.rotation.is_some() {
        out.rotation = Some(rotation);
    }
    out
}

