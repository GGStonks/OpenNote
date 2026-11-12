use model::LineStyle;
use nib::geometry::XY;

pub const DOT: f64 = 0.1;
pub const HAND_DOT: f64 = 1.25;

pub fn dash_pattern(ls: Option<LineStyle>, w: f64) -> Option<Vec<f64>> {
    match ls {
        Some(LineStyle::Dashed) => Some(vec![w * 4.0, w * 3.0]),
        Some(LineStyle::Dotted) => Some(vec![DOT, w * 3.0]),
        Some(LineStyle::Dashdot) => Some(vec![w * 4.0, w * 2.4, DOT, w * 2.4]),
        Some(LineStyle::Longdash) => Some(vec![w * 9.0, w * 3.5]),
        _ => None,
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DashRun {
    pub pts: Vec<XY>,
    pub radii: Vec<f64>,
}

pub fn dash_runs(
    pts: &[XY],
    radii: &[f64],
    pattern: &[f64],
    offset: f64,
    dot_scale: f64,
) -> Vec<DashRun> {
    let mut runs: Vec<DashRun> = Vec::new();
    let n = pts.len();
    let m = pattern.len();
    let period: f64 = pattern.iter().sum();
    if n == 0 || !(period > 0.0) {
        return runs;
    }

    let mut phase = ((offset % period) + period) % period;
    let mut k = 0;
    while phase >= pattern[k] {
        phase -= pattern[k];
        k = (k + 1) % m;
    }

    let mut left = pattern[k] - phase;
    let on = |k: usize| k % 2 == 0;
    let dot = |k: usize| dot_scale != 1.0 && pattern[k] <= DOT;

    let mut cur: Option<DashRun> = None;
    if on(k) {
        if dot(k) {
            runs.push(DashRun {
                pts: vec![pts[0]],
                radii: vec![radii[0] * dot_scale],
            });
        } else {
            cur = Some(DashRun {
                pts: vec![pts[0]],
                radii: vec![radii[0]],
            });
        }
    }

    for i in 1..n {
        let a = pts[i - 1];
        let b = pts[i];
        let len = (b.x - a.x).hypot(b.y - a.y);
        let mut d = 0.0;

        while len - d > left {
            d += left;
            let t = d / len;
            let p = XY {
                x: a.x + (b.x - a.x) * t,
                y: a.y + (b.y - a.y) * t,
            };
            let r = radii[i - 1] + (radii[i] - radii[i - 1]) * t;

            if let Some(mut c) = cur.take() {
                c.pts.push(p);
                c.radii.push(r);
                runs.push(c);
            }

            k = (k + 1) % m;
            left = pattern[k];
            if on(k) {
                if dot(k) {
                    runs.push(DashRun {
                        pts: vec![p],
                        radii: vec![r * dot_scale],
                    });
                } else {
                    cur = Some(DashRun {
                        pts: vec![p],
                        radii: vec![r],
                    });
                }
            }
        }

        left -= len - d;
        if let Some(c) = &mut cur {
            c.pts.push(b);
            c.radii.push(radii[i]);
        }
    }

    if let Some(c) = cur {
        runs.push(c);
    }

    runs
}

pub fn hand_dash(ls: Option<LineStyle>, width: f64) -> Option<(Vec<f64>, f64)> {
    dash_pattern(ls, width).map(|p| (p, HAND_DOT))
}

