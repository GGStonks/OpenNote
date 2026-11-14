use nib::geometry::JsMath;
use crate::geometry::stroke_geometry;
use crate::spline::{catmull_rom_beziers, flatten_beziers};
use model::{ModeledKind, Point, ShapeKind, Stroke};
use nib::geometry::XY;
use std::collections::HashSet;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RectBounds {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

pub fn stroke_bounds(s: &Stroke) -> RectBounds {
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for p in &s.points {
        if p.x < min_x {
            min_x = p.x;
        }
        if p.y < min_y {
            min_y = p.y;
        }
        if p.x > max_x {
            max_x = p.x;
        }
        if p.y > max_y {
            max_y = p.y;
        }
    }
    let pad = if s.tool == "highlighter" {
        s.width * 3.0
    } else {
        s.width
    };
    RectBounds {
        min_x: min_x - pad,
        min_y: min_y - pad,
        max_x: max_x + pad,
        max_y: max_y + pad,
    }
}

pub fn dist_to_segment(px: f64, py: f64, a: XY, b: XY) -> f64 {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let len2 = dx * dx + dy * dy;
    let t = if len2 > 0.0 {
        (((px - a.x) * dx + (py - a.y) * dy) / len2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    (px - (a.x + t * dx)).js_hypot(py - (a.y + t * dy))
}

pub fn inside_polygon(x: f64, y: f64, poly: &[XY]) -> bool {
    let mut inside = false;
    let mut j = poly.len().saturating_sub(1);
    for i in 0..poly.len() {
        let a = poly[i];
        let b = poly[j];
        if (a.y > y) != (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x {
            inside = !inside;
        }
        j = i;
    }
    inside
}

pub fn stroke_hit_test(s: &Stroke, x: f64, y: f64, radius: f64) -> bool {
    let b = stroke_bounds(s);
    if x < b.min_x - radius || x > b.max_x + radius || y < b.min_y - radius || y > b.max_y + radius
    {
        return false;
    }
    let r = radius
        + (if s.tool == "highlighter" {
            s.width * 2.75
        } else {
            s.width * 0.9
        });
    let pts = &s.points;
    let xy_pts: Vec<XY> = pts.iter().map(|p| XY { x: p.x, y: p.y }).collect();

    if s.fill_only.unwrap_or(false) && pts.len() > 2 && inside_polygon(x, y, &xy_pts) {
        return true;
    }
    if pts.len() == 1 {
        let extra = if s.shape_kind == Some(ShapeKind::Point) {
            s.width
        } else {
            0.0
        };
        return (pts[0].x - x).js_hypot(pts[0].y - y) <= r + extra;
    }
    for i in 1..pts.len() {
        if dist_to_segment(x, y, xy_pts[i - 1], xy_pts[i]) <= r {
            return true;
        }
    }
    if s.closed.unwrap_or(false) && pts.len() > 2 {
        if dist_to_segment(x, y, *xy_pts.last().unwrap(), xy_pts[0]) <= r {
            return true;
        }
        if let Some(fill) = s.fill {
            if fill != model::FillType::None
                && fill != model::FillType::Hole
                && inside_polygon(x, y, &xy_pts)
            {
                return true;
            }
        }
    }
    false
}

fn lerp_point(a: Point, b: Point, t: f64) -> Point {
    Point {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        pressure: a.pressure + (b.pressure - a.pressure) * t,
        t: match (a.t, b.t) {
            (Some(at), Some(bt)) => Some(at + (bt - at) * t),
            (Some(at), None) => Some(at),
            (None, Some(bt)) => Some(bt),
            (None, None) => None,
        },
        alt: a.alt,
        az: a.az,
    }
}

pub fn circle_crossing(a: Point, b: Point, cx: f64, cy: f64, r: f64) -> Point {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let fx = a.x - cx;
    let fy = a.y - cy;
    let cap_a = dx * dx + dy * dy;
    let cap_b = 2.0 * (fx * dx + fy * dy);
    let cap_c = fx * fx + fy * fy - r * r;
    if cap_a < 1e-12 {
        return a;
    }
    let disc = (cap_b * cap_b - 4.0 * cap_a * cap_c).max(0.0);
    let t = (-cap_b - disc.sqrt()) / (2.0 * cap_a);
    lerp_point(a, b, t.clamp(0.0, 1.0))
}

fn circle_cuts(a: XY, b: XY, cx: f64, cy: f64, r: f64) -> Vec<f64> {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let fx = a.x - cx;
    let fy = a.y - cy;
    let cap_a = dx * dx + dy * dy;
    let cap_b = 2.0 * (fx * dx + fy * dy);
    let cap_c = fx * fx + fy * fy - r * r;
    if cap_a < 1e-12 {
        return Vec::new();
    }
    let disc = cap_b * cap_b - 4.0 * cap_a * cap_c;
    if disc <= 0.0 {
        return Vec::new();
    }
    let q = disc.sqrt();
    let mut out = Vec::new();
    let t1 = (-cap_b - q) / (2.0 * cap_a);
    let t2 = (-cap_b + q) / (2.0 * cap_a);
    for t in [t1, t2] {
        if t > 1e-9 && t < 1.0 - 1e-9 {
            out.push(t);
        }
    }
    out
}

fn densify_points(points: &[Point], closed: bool, step: f64) -> Vec<Point> {
    let mut src = points.to_vec();
    if closed && points.len() > 2 {
        src.push(points[0]);
    }
    let mut out = Vec::new();
    for i in 0..src.len() {
        if i > 0 {
            let a = src[i - 1];
            let b = src[i];
            let d = (b.x - a.x).js_hypot(b.y - a.y);
            let n = (d / step).floor() as usize;
            for k in 1..n {
                let t = k as f64 / n as f64;
                out.push(lerp_point(a, b, t));
            }
        }
        out.push(src[i]);
    }
    out
}

fn erase_shape(
    s: &Stroke,
    x: f64,
    y: f64,
    r: f64,
    make_id: &mut impl FnMut() -> String,
) -> Option<Vec<Stroke>> {
    let closed = s.closed.unwrap_or(false) && s.points.len() > 2;
    let src: Vec<Point> = if s.shape_kind == Some(ShapeKind::Curve) {
        let xy: Vec<XY> = s.points.iter().map(|p| XY { x: p.x, y: p.y }).collect();
        flatten_beziers(&catmull_rom_beziers(&xy, closed), 0.2)
            .into_iter()
            .map(|p| Point {
                x: p.x,
                y: p.y,
                pressure: 0.5,
                t: None,
                alt: None,
                az: None,
            })
            .collect()
    } else if closed {
        let mut v = s.points.clone();
        v.push(s.points[0]);
        v
    } else {
        s.points.clone()
    };

    if src.len() < 2 {
        return None;
    }
    let inside = |p: XY| (p.x - x).js_hypot(p.y - y) <= r;

    #[derive(Clone)]
    struct Run {
        points: Vec<Point>,
        offset: f64,
        first: bool,
        last: bool,
    }

    let mut runs: Vec<Run> = Vec::new();
    let mut cur: Option<Run> = if inside(XY {
        x: src[0].x,
        y: src[0].y,
    }) {
        None
    } else {
        Some(Run {
            points: vec![src[0]],
            offset: 0.0,
            first: true,
            last: false,
        })
    };
    let mut cut = false;
    let mut at = 0.0;

    for i in 1..src.len() {
        let a = src[i - 1];
        let b = src[i];
        let a_xy = XY { x: a.x, y: a.y };
        let b_xy = XY { x: b.x, y: b.y };
        let len = (b.x - a.x).js_hypot(b.y - a.y);

        for t in circle_cuts(a_xy, b_xy, x, y, r) {
            let p = lerp_point(a, b, t);
            cut = true;
            if let Some(mut c) = cur.take() {
                c.points.push(p);
                runs.push(c);
            } else {
                cur = Some(Run {
                    points: vec![p],
                    offset: at + len * t,
                    first: false,
                    last: false,
                });
            }
        }

        if let Some(c) = &mut cur {
            if !inside(b_xy) {
                c.points.push(b);
            } else {
                runs.push(cur.take().unwrap());
                cut = true;
            }
        } else if !inside(b_xy) {
            cur = Some(Run {
                points: vec![b],
                offset: at + len,
                first: false,
                last: false,
            });
        }
        at += len;
    }

    if let Some(mut c) = cur {
        c.last = true;
        runs.push(c);
    }

    if !cut && runs.len() == 1 && runs[0].first && runs[0].last {
        return None;
    }

    if closed && runs.len() > 1 && runs[0].first && runs.last().unwrap().last {
        let tail = runs.pop().unwrap();
        let head = runs.remove(0);
        let mut merged = tail.points;
        merged.extend(head.points.into_iter().skip(1));
        runs.insert(
            0,
            Run {
                points: merged,
                offset: tail.offset,
                first: false,
                last: false,
            },
        );
    }

    let created = s.created_at;
    let dashed = s.line_style.is_some() && s.line_style != Some(model::LineStyle::Solid);
    let mut out = Vec::new();

    if closed && s.fill.is_some() && s.fill != Some(model::FillType::None) {
        let mut fill_piece = s.clone();
        fill_piece.id = make_id();
        fill_piece.created_at = created;
        fill_piece.fill_only = Some(true);
        fill_piece.arrow = None;
        out.push(fill_piece);
    }

    for run in runs {
        let mut length = 0.0;
        for i in 1..run.points.len() {
            length += (run.points[i].x - run.points[i - 1].x)
                .js_hypot(run.points[i].y - run.points[i - 1].y);
        }
        if run.points.len() < 2 || length < 0.5 {
            continue;
        }

        let mut piece = s.clone();
        piece.id = make_id();
        piece.created_at = created;
        piece.points = run.points;
        piece.is_shape = Some(true);
        piece.shape_kind = Some(ShapeKind::Polyline);
        piece.closed = Some(false);
        piece.fill = None;
        piece.fill_only = None;
        piece.arrow = if run.last && !closed { s.arrow } else { None };

        if dashed {
            piece.dash_offset = Some(s.dash_offset.unwrap_or(0.0) + run.offset);
        } else {
            piece.dash_offset = None;
        }
        out.push(piece);
    }

    Some(out)
}

pub fn erase_strokes_partial(
    strokes: &[Stroke],
    x: f64,
    y: f64,
    radius: f64,
    mut make_id: impl FnMut() -> String,
    keep: Option<&HashSet<String>>,
) -> (Vec<Stroke>, bool) {
    let mut changed = false;
    let mut out: Vec<Stroke> = Vec::new();

    for s in strokes {
        if !stroke_hit_test(s, x, y, radius)
            || (s.fill_only.unwrap_or(false) && keep.map_or(false, |k| k.contains(&s.id)))
        {
            out.push(s.clone());
            continue;
        }
        if s.shape_kind == Some(ShapeKind::Point) || s.fill_only.unwrap_or(false) {
            changed = true;
            continue;
        }
        let r = radius + s.width * 0.6;
        if s.is_shape.unwrap_or(false) {
            let pieces = erase_shape(s, x, y, r, &mut make_id);
            match pieces {
                None => out.push(s.clone()),
                Some(p) => {
                    changed = true;
                    out.extend(p);
                }
            }
            continue;
        }

        // Handwriting
        let closed = s.closed.unwrap_or(false) && s.points.len() > 2;
        let g = stroke_geometry(s);
        let modeled = if s.modeled == Some(ModeledKind::Proportional) && g.widths.is_some() {
            Some(ModeledKind::Proportional)
        } else if g.widths.is_some() {
            Some(ModeledKind::Variable)
        } else {
            Some(ModeledKind::Uniform)
        };

        let g_pts: Vec<Point> = g
            .pts
            .iter()
            .map(|q| Point {
                x: q.x,
                y: q.y,
                pressure: q.p,
                t: Some(q.t),
                alt: None,
                az: None,
            })
            .collect();
        let pts = densify_points(&g_pts, closed, 1.0);
        let inside = |p: &Point| (p.x - x).js_hypot(p.y - y) <= r;

        if !pts.iter().any(inside) {
            out.push(s.clone());
            continue;
        }

        changed = true;
        let last_index = pts.len().saturating_sub(1);
        let dashed = s.line_style.is_some() && s.line_style != Some(model::LineStyle::Solid);

        struct HRun {
            points: Vec<Point>,
            offset: f64,
            first: bool,
            last: bool,
        }

        let mut runs: Vec<HRun> = Vec::new();
        let mut cur_points: Vec<Point> = Vec::new();
        let mut cur_first = false;
        let mut cur_from = 0.0;
        let mut cur_end = -1isize;
        let mut along = 0.0;

        let flush = |cur_points: &mut Vec<Point>,
                         cur_first: bool,
                         cur_end: isize,
                         cur_from: f64,
                         runs: &mut Vec<HRun>| {
            if cur_points.len() >= 2 {
                runs.push(HRun {
                    points: cur_points.clone(),
                    offset: cur_from,
                    first: cur_first,
                    last: cur_end == last_index as isize,
                });
            }
            cur_points.clear();
        };

        for (i, p) in pts.iter().enumerate() {
            let prev = if i > 0 { Some(pts[i - 1]) } else { None };
            let step = if let Some(pr) = prev {
                (p.x - pr.x).js_hypot(p.y - pr.y)
            } else {
                0.0
            };

            if inside(p) {
                if let Some(pr) = prev {
                    if !inside(&pr) && !cur_points.is_empty() {
                        cur_points.push(circle_crossing(pr, *p, x, y, r));
                    }
                }
                flush(&mut cur_points, cur_first, cur_end, cur_from, &mut runs);
            } else {
                if let Some(pr) = prev {
                    if inside(&pr) {
                        let c = circle_crossing(*p, pr, x, y, r);
                        cur_points.push(c);
                        cur_from = along + step - (p.x - c.x).js_hypot(p.y - c.y);
                        cur_first = false;
                    } else if cur_points.is_empty() {
                        cur_from = along + step;
                        cur_first = i == 0;
                    }
                } else if cur_points.is_empty() {
                    cur_from = along + step;
                    cur_first = true;
                }
                cur_points.push(*p);
                cur_end = i as isize;
            }
            along += step;
        }

        flush(&mut cur_points, cur_first, cur_end, cur_from, &mut runs);

        if closed && runs.len() > 1 && runs[0].first && runs.last().unwrap().last {
            let tail = runs.pop().unwrap();
            let head = runs.remove(0);
            let mut merged = tail.points;
            merged.extend(head.points.into_iter().skip(1));
            runs.insert(
                0,
                HRun {
                    points: merged,
                    offset: tail.offset,
                    first: false,
                    last: false,
                },
            );
        }

        if closed && s.fill.is_some() && s.fill != Some(model::FillType::None) {
            let mut fill_piece = s.clone();
            fill_piece.id = make_id();
            fill_piece.fill_only = Some(true);
            fill_piece.arrow = None;
            out.push(fill_piece);
        }

        for run in runs {
            let keeps_end = run.last && !closed;
            let mut piece = s.clone();
            piece.id = make_id();
            piece.points = run.points;
            piece.closed = Some(false);
            piece.fill = None;
            piece.arrow = if keeps_end { s.arrow } else { None };
            piece.modeled = modeled;
            piece.pen_end = None;
            if dashed {
                piece.dash_offset = Some(s.dash_offset.unwrap_or(0.0) + run.offset);
            } else {
                piece.dash_offset = None;
            }
            out.push(piece);
        }
    }

    (if changed { out } else { strokes.to_vec() }, changed)
}
