use nib::geometry::JsMath;
use model::{Point, ShapeKind, Stroke};
use std::f64::consts::PI;

#[derive(Clone, Debug, PartialEq)]
pub struct SnappedShape {
    pub kind: ShapeKind,
    pub points: Vec<Point>,
    pub closed: bool,
    pub confidence: f64,
    pub regular: Option<bool>,
    pub fit_error: Option<f64>,
}

fn pt(x: f64, y: f64, pressure: f64) -> Point {
    Point {
        x,
        y,
        pressure,
        t: None,
        alt: None,
        az: None,
    }
}

pub fn path_length(pts: &[Point]) -> f64 {
    let mut l = 0.0;
    for i in 1..pts.len() {
        l += (pts[i].x - pts[i - 1].x).js_hypot(pts[i].y - pts[i - 1].y);
    }
    l
}

pub fn resample(pts: &[Point], n: usize) -> Vec<Point> {
    let total = path_length(pts);
    if total == 0.0 || pts.len() < 2 {
        return pts.to_vec();
    }
    let step = total / (n - 1) as f64;
    let mut out: Vec<Point> = vec![pts[0]];
    let mut acc = 0.0;
    let mut prev = pts[0];

    for i in 1..pts.len() {
        let cur = pts[i];
        let mut d = (cur.x - prev.x).js_hypot(cur.y - prev.y);
        while acc + d >= step && d > 0.0 {
            let t = (step - acc) / d;
            let q = pt(
                prev.x + (cur.x - prev.x) * t,
                prev.y + (cur.y - prev.y) * t,
                prev.pressure,
            );
            out.push(q);
            prev = q;
            d = (cur.x - prev.x).js_hypot(cur.y - prev.y);
            acc = 0.0;
        }
        acc += d;
        prev = cur;
    }
    while out.len() < n {
        out.push(*pts.last().unwrap());
    }
    out.truncate(n);
    out
}

fn dist_to_seg(p: Point, a: Point, b: Point) -> f64 {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let l2 = dx * dx + dy * dy;
    let t = if l2 > 0.0 {
        (((p.x - a.x) * dx + (p.y - a.y) * dy) / l2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    (p.x - (a.x + t * dx)).js_hypot(p.y - (a.y + t * dy))
}

fn rdp(pts: &[Point], eps: f64) -> Vec<Point> {
    let n = pts.len();
    if n < 3 {
        return pts.to_vec();
    }
    let mut keep = vec![false; n];
    keep[0] = true;
    keep[n - 1] = true;

    let mut stack = Vec::with_capacity(16);
    stack.push((0, n - 1));

    while let Some((start, end)) = stack.pop() {
        if end <= start + 1 {
            continue;
        }
        let mut max_d = 0.0;
        let mut idx = start;
        for i in (start + 1)..end {
            let d = dist_to_seg(pts[i], pts[start], pts[end]);
            if d > max_d {
                max_d = d;
                idx = i;
            }
        }
        if max_d > eps {
            keep[idx] = true;
            stack.push((start, idx));
            stack.push((idx, end));
        }
    }

    pts.iter()
        .enumerate()
        .filter_map(|(i, p)| if keep[i] { Some(*p) } else { None })
        .collect()
}

fn polyline_error(pts: &[Point], poly: &[Point], closed: bool) -> f64 {
    if poly.is_empty() || pts.is_empty() {
        return 0.0;
    }
    let closing_seg = if closed && poly.len() > 1 {
        Some((*poly.last().unwrap(), poly[0]))
    } else {
        None
    };
    let mut sum = 0.0;
    for p in pts {
        let mut best = f64::INFINITY;
        for w in poly.windows(2) {
            let d = dist_to_seg(*p, w[0], w[1]);
            if d < best {
                best = d;
            }
        }
        if let Some((a, b)) = closing_seg {
            let d = dist_to_seg(*p, a, b);
            if d < best {
                best = d;
            }
        }
        sum += best;
    }
    sum / pts.len() as f64
}

fn angle_at(a: Point, b: Point, c: Point) -> f64 {
    let v1x = a.x - b.x;
    let v1y = a.y - b.y;
    let v2x = c.x - b.x;
    let v2y = c.y - b.y;
    let m = v1x.js_hypot(v1y) * v2x.js_hypot(v2y);
    if m == 0.0 {
        return PI;
    }
    ((v1x * v2x + v1y * v2y) / m).clamp(-1.0, 1.0).acos()
}

struct BBox {
    diag: f64,
}

fn bbox(pts: &[Point]) -> BBox {
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for p in pts {
        min_x = min_x.min(p.x);
        max_x = max_x.max(p.x);
        min_y = min_y.min(p.y);
        max_y = max_y.max(p.y);
    }
    BBox {
        diag: (max_x - min_x).js_hypot(max_y - min_y),
    }
}

fn detect_line(pts: &[Point], len: f64) -> Option<SnappedShape> {
    let a = pts[0];
    let b = pts[pts.len() - 1];
    let chord = (b.x - a.x).js_hypot(b.y - a.y);
    if chord < 12.0 {
        return None;
    }
    let mut max_dev = 0.0f64;
    for p in pts {
        max_dev = max_dev.max(dist_to_seg(*p, a, b));
    }
    let rel = max_dev / chord;
    let straightness = chord / len;
    if rel > 0.11 || straightness < 0.86 {
        return None;
    }

    let mut end = b;
    let ang = (b.y - a.y).atan2(b.x - a.x);
    let snap_tol = (4.0 * PI) / 180.0;
    for target in [0.0, PI / 2.0, PI, -PI / 2.0, -PI] {
        if (ang - target).abs() < snap_tol {
            end = if target.sin().abs() > 0.5 {
                pt(a.x, b.y, 0.5)
            } else {
                pt(b.x, a.y, 0.5)
            };
        }
    }
    Some(SnappedShape {
        kind: ShapeKind::Line,
        points: vec![pt(a.x, a.y, 0.5), pt(end.x, end.y, 0.5)],
        closed: false,
        confidence: 1.0 - (rel / 0.11) * 0.8,
        regular: None,
        fit_error: None,
    })
}

struct ParabolaFit {
    a_coef: f64,
    b_coef: f64,
    c_coef: f64,
    c_ang: f64,
    s_ang: f64,
    u0: f64,
    u1: f64,
    travel: f64,
    rms: f64,
}

fn fit_parabola(pts: &[Point], ang: f64) -> Option<ParabolaFit> {
    if pts.is_empty() {
        return None;
    }
    let c_ang = ang.cos();
    let s_ang = ang.sin();

    let mut s0 = 0.0;
    let mut s1 = 0.0;
    let mut s2 = 0.0;
    let mut s3 = 0.0;
    let mut s4 = 0.0;
    let mut t0 = 0.0;
    let mut t1 = 0.0;
    let mut t2 = 0.0;

    let mut travel = 0.0;
    let mut prev_u: Option<f64> = None;

    for p in pts {
        let u = p.x * c_ang + p.y * s_ang;
        let v = -p.x * s_ang + p.y * c_ang;
        let u2 = u * u;
        s0 += 1.0;
        s1 += u;
        s2 += u2;
        s3 += u2 * u;
        s4 += u2 * u2;
        t0 += v;
        t1 += u * v;
        t2 += u2 * v;
        if let Some(pu) = prev_u {
            travel += (u - pu).abs();
        }
        prev_u = Some(u);
    }

    let det3 = |m: &[f64; 9]| {
        m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6])
            + m[2] * (m[3] * m[7] - m[4] * m[6])
    };
    let d = det3(&[s4, s3, s2, s3, s2, s1, s2, s1, s0]);
    if !d.is_finite() || d.abs() < 1e-9 {
        return None;
    }
    let a_coef = det3(&[t2, s3, s2, t1, s2, s1, t0, s1, s0]) / d;
    let b_coef = det3(&[s4, t2, s2, s3, t1, s1, s2, t0, s0]) / d;
    let c_coef = det3(&[s4, s3, t2, s3, s2, t1, s2, s1, t0]) / d;

    let mut err = 0.0;
    for p in pts {
        let u = p.x * c_ang + p.y * s_ang;
        let v = -p.x * s_ang + p.y * c_ang;
        let pred = a_coef * u * u + b_coef * u + c_coef;
        err += (v - pred).powi(2);
    }
    let rms = (err / pts.len() as f64).sqrt();

    let u0 = pts[0].x * c_ang + pts[0].y * s_ang;
    let u1 = pts.last()?.x * c_ang + pts.last()?.y * s_ang;

    Some(ParabolaFit {
        a_coef,
        b_coef,
        c_coef,
        c_ang,
        s_ang,
        u0,
        u1,
        travel,
        rms,
    })
}

fn detect_parabola(pts: &[Point], diag: f64) -> Option<SnappedShape> {
    if diag < 24.0 {
        return None;
    }
    let a = pts[0];
    let b = pts[pts.len() - 1];
    let chord = (b.x - a.x).js_hypot(b.y - a.y);
    let mut sag = 0.0f64;
    for p in pts {
        sag = sag.max(dist_to_seg(*p, a, b));
    }
    if sag < 0.07 * chord.max(1.0) {
        return None;
    }

    let mut best: Option<ParabolaFit> = None;
    let mut best_deg = 0;
    for deg in (0..180).step_by(10) {
        let ang = (deg as f64 * PI) / 180.0;
        if let Some(f) = fit_parabola(pts, ang) {
            if best.as_ref().map_or(true, |b| f.rms < b.rms) {
                best = Some(f);
                best_deg = deg;
            }
        }
    }
    for delta in [-8, -6, -4, -2, 2, 4, 6, 8] {
        let deg = (best_deg as i32 + delta).rem_euclid(180) as usize;
        let ang = (deg as f64 * PI) / 180.0;
        if let Some(f) = fit_parabola(pts, ang) {
            if best.as_ref().map_or(true, |b| f.rms < b.rms) {
                best = Some(f);
            }
        }
    }
    let mut f = best?;
    let best_ang = f.s_ang.atan2(f.c_ang).rem_euclid(PI);
    let axis_snap = (8.0 * PI) / 180.0;
    for t in [0.0, PI / 2.0, PI] {
        if (best_ang - t).abs() < axis_snap {
            if let Some(f2) = fit_parabola(pts, t % PI) {
                if f2.rms < f.rms * 1.25 + 0.002 * diag {
                    f = f2;
                }
            }
        }
    }

    if f.rms / diag > 0.022 || f.a_coef.abs() < 1e-9 {
        return None;
    }

    let u0 = f.u0;
    let u1 = f.u1;
    if f.travel > 1.12 * (u1 - u0).abs() || (u1 - u0).abs() < 0.3 * diag {
        return None;
    }

    let parabola_points = 9;
    let out: Vec<Point> = (0..parabola_points)
        .map(|i| {
            let u = u0 + ((u1 - u0) * i as f64) / (parabola_points - 1) as f64;
            let v = f.a_coef * u * u + f.b_coef * u + f.c_coef;
            pt(
                u * f.c_ang - v * f.s_ang,
                u * f.s_ang + v * f.c_ang,
                0.5,
            )
        })
        .collect();

    let dense: Vec<Point> = (0..49)
        .map(|i| {
            let u = u0 + ((u1 - u0) * i as f64) / 48.0;
            let v = f.a_coef * u * u + f.b_coef * u + f.c_coef;
            pt(
                u * f.c_ang - v * f.s_ang,
                u * f.s_ang + v * f.c_ang,
                0.5,
            )
        })
        .collect();
    let err = polyline_error(pts, &dense, false) / diag;
    Some(SnappedShape {
        kind: ShapeKind::Curve,
        points: out,
        closed: false,
        confidence: 1.0 - (f.rms / diag) / 0.022,
        regular: None,
        fit_error: Some(err),
    })
}

fn detect_arrow(pts: &[Point], diag: f64) -> Option<SnappedShape> {
    let v = rdp(pts, 4.0f64.max(diag * 0.05));
    if v.len() < 4 || v.len() > 6 {
        return None;
    }
    let shaft_len = (v[1].x - v[0].x).js_hypot(v[1].y - v[0].y);
    let total = path_length(&v);
    if shaft_len < 0.45 * total || shaft_len < 30.0 {
        return None;
    }
    let tip = v[1];
    let dir = (v[1].y - v[0].y).atan2(v[1].x - v[0].x);

    let mut wings: Vec<(Point, f64)> = Vec::new();
    for w in &v[2..] {
        let d = (w.x - tip.x).js_hypot(w.y - tip.y);
        if d < 0.06 * shaft_len || d > 0.6 * shaft_len {
            continue;
        }
        let back = (w.y - tip.y).atan2(w.x - tip.x) - (dir + PI);
        let rel = back.sin().atan2(back.cos());
        if rel.abs() > (12.0 * PI) / 180.0 && rel.abs() < (80.0 * PI) / 180.0 {
            wings.push((*w, rel.signum()));
        }
    }
    let left = wings.iter().find(|w| w.1 > 0.0);
    let right = wings.iter().find(|w| w.1 < 0.0);
    if left.is_none() || right.is_none() {
        return None;
    }
    let head_len = (shaft_len * 0.3).min(
        ((left.unwrap().0.x - tip.x).js_hypot(left.unwrap().0.y - tip.y)
            + (right.unwrap().0.x - tip.x).js_hypot(right.unwrap().0.y - tip.y))
            / 2.0,
    );
    let spread = (28.0 * PI) / 180.0;
    let w1 = pt(
        tip.x + head_len * (dir + PI - spread).cos(),
        tip.y + head_len * (dir + PI - spread).sin(),
        0.5,
    );
    let w2 = pt(
        tip.x + head_len * (dir + PI + spread).cos(),
        tip.y + head_len * (dir + PI + spread).sin(),
        0.5,
    );

    Some(SnappedShape {
        kind: ShapeKind::Arrow,
        points: vec![pt(v[0].x, v[0].y, 0.5), pt(tip.x, tip.y, 0.5), w1, pt(tip.x, tip.y, 0.5), w2],
        closed: false,
        confidence: 0.8,
        regular: None,
        fit_error: None,
    })
}

fn detect_ellipse(pts: &[Point]) -> Option<SnappedShape> {
    let n = pts.len() as f64;
    let mut cx = 0.0;
    let mut cy = 0.0;
    for p in pts {
        cx += p.x;
        cy += p.y;
    }
    cx /= n;
    cy /= n;

    let mut sxx = 0.0;
    let mut syy = 0.0;
    let mut sxy = 0.0;
    for p in pts {
        let dx = p.x - cx;
        let dy = p.y - cy;
        sxx += dx * dx;
        syy += dy * dy;
        sxy += dx * dy;
    }
    sxx /= n;
    syy /= n;
    sxy /= n;

    let tr = sxx + syy;
    let det = sxx * syy - sxy * sxy;
    let disc = (tr * tr / 4.0 - det).max(0.0).sqrt();
    let l1 = tr / 2.0 + disc;
    let l2 = tr / 2.0 - disc;
    let mut theta = 0.5 * (2.0 * sxy).atan2(sxx - syy);
    let mut a = (2.0 * l1).sqrt();
    let mut b = (2.0 * l2.max(0.0)).sqrt();
    if a < 8.0 || b < 4.0 {
        return None;
    }

    let mut err = 0.0;
    let c = theta.cos();
    let s = theta.sin();
    for p in pts {
        let dx = p.x - cx;
        let dy = p.y - cy;
        let u = (dx * c + dy * s) / a;
        let w = (-dx * s + dy * c) / b;
        err += (u.js_hypot(w) - 1.0).abs();
    }
    err /= n;
    if err > 0.16 {
        return None;
    }

    let mut kind = ShapeKind::Ellipse;
    if b / a > 0.86 {
        a = (a + b) / 2.0;
        b = a;
        theta = 0.0;
        kind = ShapeKind::Circle;
    } else {
        let deg = (((theta * 180.0) / PI + 180.0) % 90.0).abs();
        if deg < 7.0 || deg > 83.0 {
            theta = (theta / (PI / 2.0)).round() * (PI / 2.0);
        }
    }

    let steps = 72;
    let ct = theta.cos();
    let st = theta.sin();
    let mut out = Vec::with_capacity(steps);
    for i in 0..steps {
        let t = (i as f64 / steps as f64) * PI * 2.0;
        let x = a * t.cos();
        let y = b * t.sin();
        out.push(pt(cx + x * ct - y * st, cy + x * st + y * ct, 0.5));
    }
    Some(SnappedShape {
        kind,
        points: out,
        closed: true,
        confidence: 1.0 - err / 0.16,
        regular: None,
        fit_error: None,
    })
}

fn clean_vertices(v: &[Point], closed: bool) -> Vec<Point> {
    let mut out = v.to_vec();
    let flat = (150.0 * PI) / 180.0;
    let mut changed = true;

    while changed && out.len() > if closed { 3 } else { 2 } {
        changed = false;
        let n = out.len();
        let mut perim = 0.0;
        let start_i = if closed { 0 } else { 1 };
        for i in start_i..n {
            let prev = (i + n - 1) % n;
            perim += (out[i].x - out[prev].x).js_hypot(out[i].y - out[prev].y);
        }

        let mut worst = None;
        let mut worst_ang = flat;
        let end_i = if closed { n } else { n - 1 };
        for i in start_i..end_i {
            let prev = (i + n - 1) % n;
            let next = (i + 1) % n;
            let a = angle_at(out[prev], out[i], out[next]);
            if a > worst_ang {
                worst_ang = a;
                worst = Some(i);
            }
        }
        if let Some(idx) = worst {
            out.remove(idx);
            changed = true;
            continue;
        }

        let mut short_idx = None;
        let mut short_len = 0.07 * perim;
        for i in 0..end_i {
            let a = out[i];
            let b = out[(i + 1) % n];
            let l = (b.x - a.x).js_hypot(b.y - a.y);
            if l < short_len {
                short_len = l;
                short_idx = Some(i);
            }
        }
        if let Some(idx) = short_idx {
            let j = (idx + 1) % n;
            if !closed && idx == 0 {
                out.remove(1);
            } else if !closed && j == n - 1 {
                out.remove(idx);
            } else {
                out[idx] = pt((out[idx].x + out[j].x) / 2.0, (out[idx].y + out[j].y) / 2.0, 0.5);
                out.remove(j);
            }
            changed = true;
        }
    }
    out
}

fn regular_polygon(v: &[Point], pts: &[Point], diag: f64) -> Option<Vec<Point>> {
    let n = v.len();
    if n < 3 {
        return None;
    }
    let sides: Vec<f64> = (0..n)
        .map(|i| (v[(i + 1) % n].x - v[i].x).js_hypot(v[(i + 1) % n].y - v[i].y))
        .collect();
    let min_side = sides.iter().copied().fold(f64::INFINITY, f64::min);
    let max_side = sides.iter().copied().fold(0.0, f64::max);
    let corner = (PI * (n as f64 - 2.0)) / n as f64;

    let nearly_regular = min_side > 0.0
        && max_side <= 1.16 * min_side
        && (0..n).all(|i| {
            let prev = (i + n - 1) % n;
            let next = (i + 1) % n;
            (angle_at(v[prev], v[i], v[next]) - corner).abs() <= (13.0 * PI) / 180.0
        });

    let mut cx = 0.0;
    let mut cy = 0.0;
    let mut len = 0.0;
    for i in 0..pts.len() {
        cx += pts[i].x / pts.len() as f64;
        cy += pts[i].y / pts.len() as f64;
        let q = pts[(i + 1) % pts.len()];
        len += (q.x - pts[i].x).js_hypot(q.y - pts[i].y);
    }

    let mut area = 0.0;
    let mut sx = 0.0;
    let mut sy = 0.0;
    for i in 0..n {
        let next = (i + 1) % n;
        area += v[i].x * v[next].y - v[next].x * v[i].y;
        let a = n as f64 * (v[i].y - cy).atan2(v[i].x - cx);
        sx += a.cos();
        sy += a.sin();
    }
    let mut phase = sy.atan2(sx) / n as f64;
    let up = -PI / 2.0;
    let every = PI / n as f64;
    let snapped = up + ((phase - up) / every).round() * every;
    if (phase - snapped).abs() < (9.0 * PI) / 180.0 {
        phase = snapped;
    }

    let step = (if area < 0.0 { -1.0 } else { 1.0 }) * ((2.0 * PI) / n as f64);
    let r = len / (2.0 * n as f64 * (PI / n as f64).sin());
    let out: Vec<Point> = (0..n)
        .map(|i| {
            pt(
                cx + r * (phase + i as f64 * step).cos(),
                cy + r * (phase + i as f64 * step).sin(),
                0.5,
            )
        })
        .collect();

    if nearly_regular || polyline_error(pts, &out, true) / diag <= 0.026 {
        Some(out)
    } else {
        None
    }
}

fn detect_polygon(pts: &[Point], diag: f64, closed: bool) -> Option<SnappedShape> {
    let mut ring = pts.to_vec();
    if closed {
        ring.push(pts[0]);
    }
    let mut v = rdp(&ring, 5.0f64.max(diag * 0.085));
    if closed {
        v.pop();
    }
    v = clean_vertices(&v, closed);
    if closed && (v.len() < 3 || v.len() > 8) {
        return None;
    }
    if !closed && (v.len() < 3 || v.len() > 6) {
        return None;
    }
    let err = polyline_error(pts, &v, closed) / diag;
    let max_err = if closed { 0.05 } else { 0.035 };
    if err > max_err {
        return None;
    }

    let mut kind = if closed {
        if v.len() == 3 {
            ShapeKind::Triangle
        } else {
            ShapeKind::Polygon
        }
    } else {
        ShapeKind::Polyline
    };
    let mut out = v.clone();

    if closed {
        if let Some(reg) = regular_polygon(&v, pts, diag) {
            return Some(SnappedShape {
                kind: if v.len() == 4 {
                    ShapeKind::Rectangle
                } else {
                    kind
                },
                points: reg,
                closed,
                confidence: 1.0 - err / 0.05,
                regular: Some(true),
                fit_error: None,
            });
        }
    }

    if closed && v.len() == 4 {
        let right = (0..4).all(|i| {
            (angle_at(v[(i + 3) % 4], v[i], v[(i + 1) % 4]) - PI / 2.0).abs()
                < (18.0 * PI) / 180.0
        });
        if right {
            kind = ShapeKind::Rectangle;
            let mut best = 0.0;
            let mut ang = 0.0;
            for i in 0..4 {
                let a = v[i];
                let b = v[(i + 1) % 4];
                let l = (b.x - a.x).js_hypot(b.y - a.y);
                if l > best {
                    best = l;
                    ang = (b.y - a.y).atan2(b.x - a.x);
                }
            }
            ang = ((ang % (PI / 2.0)) + PI / 2.0) % (PI / 2.0);
            if ang < (8.0 * PI) / 180.0 || ang > (82.0 * PI) / 180.0 {
                ang = 0.0;
            }
            let c = ang.cos();
            let s = ang.sin();
            let mut mx = 0.0;
            let mut my = 0.0;
            for p in &v {
                mx += p.x / 4.0;
                my += p.y / 4.0;
            }
            let mut min_u = f64::INFINITY;
            let mut max_u = f64::NEG_INFINITY;
            let mut min_w = f64::INFINITY;
            let mut max_w = f64::NEG_INFINITY;
            for p in pts {
                let u = (p.x - mx) * c + (p.y - my) * s;
                let w = -(p.x - mx) * s + (p.y - my) * c;
                min_u = min_u.min(u);
                max_u = max_u.max(u);
                min_w = min_w.min(w);
                max_w = max_w.max(w);
            }
            let back = |u: f64, w: f64| pt(mx + u * c - w * s, my + u * s + w * c, 0.5);
            out = vec![
                back(min_u, min_w),
                back(max_u, min_w),
                back(max_u, max_w),
                back(min_u, max_w),
            ];
        }
    }

    Some(SnappedShape {
        kind,
        points: out,
        closed,
        confidence: 1.0 - err / 0.05,
        regular: None,
        fit_error: None,
    })
}

pub fn detect_shape(points: &[Point]) -> Option<SnappedShape> {
    if points.len() < 3 {
        return None;
    }
    let len = path_length(points);
    if len < 16.0 {
        return None;
    }
    let mut pts = resample(points, 96);
    let box_bounds = bbox(&pts);
    let start = pts[0];
    let mut near = pts.len() - 1;

    for i in (pts.len() * 6 / 10)..pts.len() {
        if (pts[i].x - start.x).js_hypot(pts[i].y - start.y)
            < (pts[near].x - start.x).js_hypot(pts[near].y - start.y)
        {
            near = i;
        }
    }
    let gap = (start.x - pts[near].x).js_hypot(start.y - pts[near].y);
    let closed = gap < 24.0f64.max(0.28 * box_bounds.diag) && len > 2.2 * box_bounds.diag * 0.5;
    if closed && near < pts.len() - 1 {
        pts = resample(&pts[0..=near], 96);
    }

    let mut candidates = Vec::new();
    if !closed {
        if let Some(line) = detect_line(&pts, len) {
            return Some(line);
        }
        if let Some(arrow) = detect_arrow(&pts, box_bounds.diag) {
            return Some(arrow);
        }
        let poly = detect_polygon(&pts, box_bounds.diag, false);
        if let Some(ref p) = poly {
            candidates.push(p.clone());
        }
        if let Some(parabola) = detect_parabola(&pts, box_bounds.diag) {
            if poly.is_none()
                || parabola.fit_error.unwrap_or(1.0)
                    <= polyline_error(&pts, &poly.unwrap().points, false) / box_bounds.diag
            {
                return Some(parabola);
            }
        }
    } else {
        if let Some(ell) = detect_ellipse(&pts) {
            candidates.push(ell);
        }
        if let Some(poly) = detect_polygon(&pts, box_bounds.diag, true) {
            candidates.push(poly);
        }
    }

    candidates.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap());
    let best = candidates.into_iter().next();
    if let Some(b) = best {
        if b.confidence > 0.2 {
            return Some(b);
        }
    }
    None
}

pub fn snap_stroke(stroke: &Stroke) -> Stroke {
    if stroke.tool != "pen" || stroke.is_shape.unwrap_or(false) {
        return stroke.clone();
    }
    let shape = detect_shape(&stroke.points);
    if let Some(s) = shape {
        let mut st = stroke.clone();
        st.points = s.points;
        st.is_shape = Some(true);
        st.closed = Some(s.closed);
        st.shape_kind = Some(s.kind);
        st.modeled = None;
        st.pen_end = None;
        st
    } else {
        stroke.clone()
    }
}
