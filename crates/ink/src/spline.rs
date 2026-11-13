use nib::geometry::JsMath;
use nib::geometry::XY;

pub type Bezier = [XY; 4];

fn sub(a: XY, b: XY) -> XY {
    XY {
        x: a.x - b.x,
        y: a.y - b.y,
    }
}

fn add(a: XY, b: XY) -> XY {
    XY {
        x: a.x + b.x,
        y: a.y + b.y,
    }
}

fn mul(a: XY, k: f64) -> XY {
    XY {
        x: a.x * k,
        y: a.y * k,
    }
}

fn dot(a: XY, b: XY) -> f64 {
    a.x * b.x + a.y * b.y
}

fn len(a: XY) -> f64 {
    a.x.js_hypot(a.y)
}

fn dist(a: XY, b: XY) -> f64 {
    (a.x - b.x).js_hypot(a.y - b.y)
}

fn norm(a: XY) -> XY {
    let l = len(a);
    if l > 1e-9 {
        XY {
            x: a.x / l,
            y: a.y / l,
        }
    } else {
        XY { x: 0.0, y: 0.0 }
    }
}

fn dedupe(points: &[XY], closed: bool) -> Vec<XY> {
    let mut out: Vec<XY> = Vec::new();
    for &p in points {
        if out.is_empty() || dist(*out.last().unwrap(), p) > 0.01 {
            out.push(p);
        }
    }
    if closed {
        while out.len() > 2 && dist(out[0], *out.last().unwrap()) < 0.01 {
            out.pop();
        }
    }
    out
}

pub fn catmull_rom_beziers(input: &[XY], closed: bool) -> Vec<Bezier> {
    let pts = dedupe(input, closed);
    let n = pts.len();
    if n < 2 {
        return Vec::new();
    }
    if n == 2 {
        let a = pts[0];
        let b = pts[1];
        return vec![[
            a,
            XY {
                x: a.x + (b.x - a.x) / 3.0,
                y: a.y + (b.y - a.y) / 3.0,
            },
            XY {
                x: a.x + (2.0 * (b.x - a.x)) / 3.0,
                y: a.y + (2.0 * (b.y - a.y)) / 3.0,
            },
            b,
        ]];
    }

    let alpha = 0.5;
    let mut out = Vec::new();
    let segs = if closed { n } else { n - 1 };

    for i in 0..segs {
        let p1 = pts[i % n];
        let p2 = pts[(i + 1) % n];
        let p0 = if closed {
            pts[(i + n - 1) % n]
        } else if i == 0 {
            p1
        } else {
            pts[i - 1]
        };
        let p3 = if closed {
            pts[(i + 2) % n]
        } else if i >= n - 2 {
            p2
        } else {
            pts[i + 2]
        };

        let d1 = 1e-4f64.max(dist(p0, p1));
        let d2 = 1e-4f64.max(dist(p1, p2));
        let d3 = 1e-4f64.max(dist(p2, p3));

        let t1 = d1.powf(alpha);
        let t2 = d2.powf(alpha);
        let t3 = d3.powf(alpha);

        let t12 = t1 + t2;
        let t23 = t2 + t3;

        let dx2 = p2.x - p1.x;
        let dy2 = p2.y - p1.y;

        let (m1x, m1y) = (
            (p1.x - p0.x) / t1 - (p2.x - p0.x) / t12,
            (p1.y - p0.y) / t1 - (p2.y - p0.y) / t12,
        );

        let (m2x, m2y) = (
            (p3.x - p2.x) / t3 - (p3.x - p1.x) / t23,
            (p3.y - p2.y) / t3 - (p3.y - p1.y) / t23,
        );

        // For open curves, terminate endpoints via quadratic Bézier degree elevation
        // (starts/ends with natural curvature directly at terminal points with zero tangent overshoot,
        // without flattening into an artificial straight piece).
        let (c1x, c1y) = if !closed && i == 0 {
            (
                p1.x + (dx2 - t2 * m2x) / 3.0,
                p1.y + (dy2 - t2 * m2y) / 3.0,
            )
        } else {
            (
                p1.x + (dx2 + t2 * m1x) / 3.0,
                p1.y + (dy2 + t2 * m1y) / 3.0,
            )
        };

        let (c2x, c2y) = if !closed && i >= n - 2 {
            (
                p2.x - (dx2 - t2 * m1x) / 3.0,
                p2.y - (dy2 - t2 * m1y) / 3.0,
            )
        } else {
            (
                p2.x - (dx2 + t2 * m2x) / 3.0,
                p2.y - (dy2 + t2 * m2y) / 3.0,
            )
        };

        out.push([
            p1,
            XY { x: c1x, y: c1y },
            XY { x: c2x, y: c2y },
            p2,
        ]);
    }
    out
}

pub fn bezier_point(b: Bezier, t: f64) -> XY {
    let mt = 1.0 - t;
    let a = mt * mt * mt;
    let c1 = 3.0 * mt * mt * t;
    let c2 = 3.0 * mt * t * t;
    let d = t * t * t;
    XY {
        x: a * b[0].x + c1 * b[1].x + c2 * b[2].x + d * b[3].x,
        y: a * b[0].y + c1 * b[1].y + c2 * b[2].y + d * b[3].y,
    }
}

pub fn flatten_beziers(segs: &[Bezier], step: f64) -> Vec<XY> {
    let mut out: Vec<XY> = Vec::new();
    for b in segs {
        let l = dist(b[0], b[1]) + dist(b[1], b[2]) + dist(b[2], b[3]);
        let n = 2usize.max((l / step).ceil() as usize);
        let start_i = if out.is_empty() { 0 } else { 1 };
        for i in start_i..=n {
            out.push(bezier_point(*b, i as f64 / n as f64));
        }
    }
    out
}

fn bezier_d1(b: Bezier, t: f64) -> XY {
    let mt = 1.0 - t;
    add(
        add(mul(sub(b[1], b[0]), 3.0 * mt * mt), mul(sub(b[2], b[1]), 6.0 * mt * t)),
        mul(sub(b[3], b[2]), 3.0 * t * t),
    )
}

fn bezier_d2(b: Bezier, t: f64) -> XY {
    add(
        mul(add(sub(b[2], mul(b[1], 2.0)), b[0]), 6.0 * (1.0 - t)),
        mul(add(sub(b[3], mul(b[2], 2.0)), b[1]), 6.0 * t),
    )
}

fn chord_params(pts: &[XY]) -> Vec<f64> {
    let mut u = vec![0.0];
    for i in 1..pts.len() {
        u.push(u[i - 1] + dist(pts[i], pts[i - 1]));
    }
    let total = if u[u.len() - 1] != 0.0 {
        u[u.len() - 1]
    } else {
        1.0
    };
    u.into_iter().map(|v| v / total).collect()
}

fn generate_bezier(pts: &[XY], u: &[f64], t_hat1: XY, t_hat2: XY) -> Bezier {
    let first = pts[0];
    let last = pts[pts.len() - 1];
    let mut c00 = 0.0;
    let mut c01 = 0.0;
    let mut c11 = 0.0;
    let mut x0 = 0.0;
    let mut x1 = 0.0;

    for (i, &pt) in pts.iter().enumerate() {
        let t = u[i];
        let mt = 1.0 - t;
        let b0 = mt * mt * mt;
        let b1 = 3.0 * mt * mt * t;
        let b2 = 3.0 * mt * t * t;
        let b3 = t * t * t;
        let a1 = mul(t_hat1, b1);
        let a2 = mul(t_hat2, b2);
        c00 += dot(a1, a1);
        c01 += dot(a1, a2);
        c11 += dot(a2, a2);
        let tmp = sub(pt, add(mul(first, b0 + b1), mul(last, b2 + b3)));
        x0 += dot(a1, tmp);
        x1 += dot(a2, tmp);
    }

    let det = c00 * c11 - c01 * c01;
    let mut alpha1 = if det != 0.0 {
        (x0 * c11 - x1 * c01) / det
    } else {
        0.0
    };
    let mut alpha2 = if det != 0.0 {
        (c00 * x1 - c01 * x0) / det
    } else {
        0.0
    };

    let seg_len = dist(first, last);
    let eps = 1e-6 * seg_len;
    if alpha1 < eps || alpha2 < eps || alpha1 > seg_len * 2.0 || alpha2 > seg_len * 2.0 {
        alpha1 = seg_len / 3.0;
        alpha2 = seg_len / 3.0;
    }

    [
        first,
        add(first, mul(t_hat1, alpha1)),
        add(last, mul(t_hat2, alpha2)),
        last,
    ]
}

fn reparameterize(b: Bezier, pts: &[XY], u: &[f64]) -> Vec<f64> {
    u.iter()
        .enumerate()
        .map(|(i, &t)| {
            let d = sub(bezier_point(b, t), pts[i]);
            let d1 = bezier_d1(b, t);
            let d2 = bezier_d2(b, t);
            let den = dot(d1, d1) + dot(d, d2);
            if den.abs() < 1e-12 {
                t
            } else {
                (t - dot(d, d1) / den).clamp(0.0, 1.0)
            }
        })
        .collect()
}

fn max_error(b: Bezier, pts: &[XY], u: &[f64]) -> (f64, usize) {
    let mut err = 0.0;
    let mut index = pts.len() / 2;
    for i in 1..pts.len() - 1 {
        let d = dist(bezier_point(b, u[i]), pts[i]);
        if d > err {
            err = d;
            index = i;
        }
    }
    (err, index)
}

fn fit_cubic(
    pts: &[XY],
    t_hat1: XY,
    t_hat2: XY,
    tol: f64,
    out: &mut Vec<Bezier>,
    depth: usize,
) {
    if pts.len() == 2 {
        let l = dist(pts[0], pts[1]) / 3.0;
        out.push([
            pts[0],
            add(pts[0], mul(t_hat1, l)),
            add(pts[1], mul(t_hat2, l)),
            pts[1],
        ]);
        return;
    }

    let mut u = chord_params(pts);
    let mut b = generate_bezier(pts, &u, t_hat1, t_hat2);
    let (mut err, mut index) = max_error(b, pts, &u);
    if err <= tol {
        out.push(b);
        return;
    }
    if err <= tol * 4.0 {
        for _ in 0..6 {
            u = reparameterize(b, pts, &u);
            b = generate_bezier(pts, &u, t_hat1, t_hat2);
            let (new_err, new_idx) = max_error(b, pts, &u);
            err = new_err;
            index = new_idx;
            if err <= tol {
                out.push(b);
                return;
            }
        }
    }
    if depth > 24 {
        out.push(b);
        return;
    }

    index = index.clamp(1, pts.len() - 2);
    let center = norm(sub(pts[index - 1], pts[index + 1]));
    fit_cubic(&pts[0..=index], t_hat1, center, tol, out, depth + 1);
    fit_cubic(&pts[index..], mul(center, -1.0), t_hat2, tol, out, depth + 1);
}

pub fn fit_beziers(input: &[XY], tol: f64, closed: bool) -> Vec<Bezier> {
    let mut pts = dedupe(input, false);
    if closed && pts.len() > 2 && dist(pts[0], *pts.last().unwrap()) > 0.01 {
        pts.push(pts[0]);
    }
    if pts.len() < 2 {
        return Vec::new();
    }
    let n = pts.len();
    let tangent = |a: XY, b: XY| norm(sub(b, a));

    let (t1, t2) = if closed && n > 3 {
        let c = norm(sub(pts[1], pts[n - 2]));
        (c, mul(c, -1.0))
    } else {
        let t1 = tangent(pts[0], pts[2.min(n - 1)]);
        let t2 = tangent(pts[n - 1], pts[(n - 1).saturating_sub(2)]);
        (t1, t2)
    };

    let mut out = Vec::new();
    fit_cubic(&pts, t1, t2, tol, &mut out, 0);
    out
}

pub fn end_tangent(segs: &[Bezier]) -> Option<(XY, XY)> {
    let last = segs.last()?;
    for c in [last[2], last[1], last[0]] {
        if dist(c, last[3]) > 0.5 {
            return Some((last[3], c));
        }
    }
    None
}

