use ink::spline::{catmull_rom_beziers, flatten_beziers};
use ink::{dash_pattern, dash_runs, stroke_geometry, stroke_width, DOT};
use model::{LineStyle, ShapeKind, Stroke};
use nib::geometry::XY;

pub const GL_TOLERANCE: f64 = 0.015;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Capsule {
    pub ax: f64,
    pub ay: f64,
    pub ra: f64,
    pub bx: f64,
    pub by: f64,
    pub rb: f64,
}

impl Capsule {
    pub fn new(ax: f64, ay: f64, ra: f64, bx: f64, by: f64, rb: f64) -> Self {
        Self {
            ax,
            ay,
            ra,
            bx,
            by,
            rb,
        }
    }

    #[inline]
    pub fn bounds(&self) -> (f64, f64, f64, f64) {
        let r = self.ra.max(self.rb);
        let min_x = (self.ax - r).min(self.bx - r);
        let min_y = (self.ay - r).min(self.by - r);
        let max_x = (self.ax + r).max(self.bx + r);
        let max_y = (self.ay + r).max(self.by + r);
        (min_x, min_y, max_x, max_y)
    }
}

#[inline]
pub fn cro(x: (f64, f64), y: (f64, f64)) -> f64 {
    x.0 * y.1 - x.1 * y.0
}

/// Distance to the outline of two circles and the lines tangent to both (negative inside).
#[inline]
pub fn sd_piece(px: f64, py: f64, pax: f64, pay: f64, pbx: f64, pby: f64, ra: f64, rb: f64) -> f64 {
    let bax = pbx - pax;
    let bay = pby - pay;
    let h = bax * bax + bay * bay;
    let dr = ra - rb;
    if h <= dr * dr + 1e-9 {
        return if ra >= rb {
            let dx = px - pax;
            let dy = py - pay;
            (dx * dx + dy * dy).sqrt() - ra
        } else {
            let dx = px - pbx;
            let dy = py - pby;
            (dx * dx + dy * dy).sqrt() - rb
        };
    }
    let rx = px - pax;
    let ry = py - pay;
    let mut qx = (rx * bay - ry * bax) / h;
    let qy = (rx * bax + ry * bay) / h;
    qx = qx.abs();

    let cx = (h - dr * dr).max(0.0).sqrt();
    let cy = dr;

    let k = cro((cx, cy), (qx, qy));
    let m = cx * qx + cy * qy;
    let n = qx * qx + qy * qy;

    if k < 0.0 {
        return (h * n).sqrt() - ra;
    }
    if k > cx {
        return (h * (n + 1.0 - 2.0 * qy)).max(0.0).sqrt() - rb;
    }
    m - ra
}

pub fn cap_keep(pts: &[XY], radii: &[f64]) -> Vec<bool> {
    let n = pts.len();
    if n <= 2 {
        return vec![true; n];
    }
    let mut keep = vec![false; n];
    keep[0] = true;
    keep[n - 1] = true;

    let mut stack = vec![(0, n - 1)];
    while let Some((i, j)) = stack.pop() {
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
            let err = (ex * ex + ey * ey).sqrt().max(er.abs());
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

pub fn chain_caps(out: &mut Vec<Capsule>, pts: &[XY], radii: &[f64]) {
    let n = pts.len();
    if n == 0 {
        return;
    }
    if n == 1 {
        out.push(Capsule::new(
            pts[0].x, pts[0].y, radii[0], pts[0].x, pts[0].y, radii[0],
        ));
        return;
    }
    let keep = cap_keep(pts, radii);
    let mut prev = 0;
    for k in 1..n {
        if !keep[k] {
            continue;
        }
        out.push(Capsule::new(
            pts[prev].x, pts[prev].y, radii[prev], pts[k].x, pts[k].y, radii[k],
        ));
        prev = k;
    }
}

pub fn highlighter_dash(ls: Option<LineStyle>, w: f64) -> Option<Vec<f64>> {
    let style = ls.unwrap_or(LineStyle::Solid);
    if style == LineStyle::Solid {
        return None;
    }
    match style {
        LineStyle::Dotted => Some(vec![DOT, w * 1.6]),
        LineStyle::Dashdot => Some(vec![w, w * 1.2, DOT, w * 1.2]),
        LineStyle::Longdash => Some(vec![w * 2.4, w * 1.6]),
        _ => Some(vec![w, w * 1.6]),
    }
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

pub fn stroke_gl_geometry(s: &Stroke) -> (Vec<Capsule>, Option<Vec<XY>>, Option<[XY; 3]>) {
    let mut caps = Vec::new();
    let mut area = None;
    let mut arrow = None;

    if s.points.is_empty() {
        return (caps, area, arrow);
    }

    let pts_xy: Vec<XY> = s.points.iter().map(|p| XY { x: p.x, y: p.y }).collect();
    let closed = s.closed.unwrap_or(false) && s.points.len() > 2;
    let fillable = closed && s.fill.is_some() && s.fill != Some(model::FillType::None);
    let is_highlighter = s.tool == "highlighter";
    let is_shape = s.is_shape.unwrap_or(false);

    if s.shape_kind == Some(ShapeKind::Point) {
        let p = pts_xy[0];
        let r = 2.5f64.max(s.width * 1.7);
        caps.push(Capsule::new(p.x, p.y, r, p.x, p.y, r));
    } else if s.shape_kind == Some(ShapeKind::Curve) {
        let bez = catmull_rom_beziers(&pts_xy, closed);
        let mut line = flatten_beziers(&bez, 1.0);
        if closed && line.len() > 1 && (line[0].x != line[line.len() - 1].x || line[0].y != line[line.len() - 1].y) {
            line.push(line[0]);
        }
        let width = if is_highlighter { s.width * 5.5 } else { stroke_width(s) };
        stroke_caps(&mut caps, &line, width, s.line_style, is_highlighter, s);
        if fillable {
            area = Some(line);
        }
    } else if !is_shape {
        let g = stroke_geometry(s);
        let g_pts_xy: Vec<XY> = g.pts.iter().map(|p| XY { x: p.x, y: p.y }).collect();
        if is_highlighter {
            let width = s.width * 5.5;
            stroke_caps(&mut caps, &g_pts_xy, width, s.line_style, true, s);
        } else if let Some(widths) = &g.widths {
            let radii: Vec<f64> = widths.iter().map(|w| w / 2.0).collect();
            if let Some((pattern, dot_scale)) = ink::hand_dash(s.line_style, s.width) {
                let runs = dash_runs(&g_pts_xy, &radii, &pattern, s.dash_offset.unwrap_or(0.0), dot_scale);
                for r in runs {
                    chain_caps(&mut caps, &r.pts, &r.radii);
                }
            } else {
                chain_caps(&mut caps, &g_pts_xy, &radii);
            }
        } else {
            let width = stroke_width(s);
            stroke_caps(&mut caps, &g_pts_xy, width, s.line_style, false, s);
        }
        if fillable {
            area = Some(g_pts_xy);
        }
    } else {
        let line = if closed {
            let mut l = pts_xy.clone();
            l.push(pts_xy[0]);
            l
        } else {
            pts_xy.clone()
        };
        let width = if is_highlighter { s.width * 5.5 } else { stroke_width(s) };
        stroke_caps(&mut caps, &line, width, s.line_style, is_highlighter, s);
        if fillable {
            area = Some(pts_xy.clone());
        }
    }

    if s.arrow.unwrap_or(false) && !closed && s.shape_kind != Some(ShapeKind::Point) && pts_xy.len() > 1 {
        arrow = arrow_head(&pts_xy, s);
    }

    if s.fill_only.unwrap_or(false) && !is_highlighter {
        caps.clear();
    }

    (caps, area, arrow)
}

fn stroke_caps(
    out: &mut Vec<Capsule>,
    pts: &[XY],
    width: f64,
    ls: Option<LineStyle>,
    is_highlighter: bool,
    s: &Stroke,
) {
    if pts.is_empty() {
        return;
    }
    let r = width / 2.0;
    if pts.len() == 1 {
        out.push(Capsule::new(pts[0].x, pts[0].y, r, pts[0].x + 0.01, pts[0].y, r));
        return;
    }
    let style = ls.unwrap_or(LineStyle::Solid);
    if style == LineStyle::Solid {
        let radii = vec![r; pts.len()];
        chain_caps(out, pts, &radii);
        return;
    }

    let pattern = if is_highlighter {
        highlighter_dash(ls, width)
    } else {
        dash_pattern(ls, s.width)
    };

    if let Some(pat) = pattern {
        let dot_scale = if style == LineStyle::Dotted { 1.8 } else { 1.0 };
        let radii = vec![r; pts.len()];
        let runs = dash_runs(pts, &radii, &pat, s.dash_offset.unwrap_or(0.0), dot_scale);
        for run in runs {
            chain_caps(out, &run.pts, &run.radii);
        }
    } else {
        let radii = vec![r; pts.len()];
        chain_caps(out, pts, &radii);
    }
}
