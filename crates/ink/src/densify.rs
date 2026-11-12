use nib::geometry::JsMath;
use model::Point;
use std::f64::consts::PI;

const GAP: f64 = 3.0;
const STEP: f64 = 1.5;
const BASE: f64 = 1.5;
const MAX_TURN: f64 = (45.0 * PI) / 180.0;
const MIN_SKEW: f64 = (10.0 * PI) / 180.0;
const STILL_PX: f64 = 0.2;
const STILL_MS: f64 = 6.0;
const MAX_DT: f64 = 10.0;
const FILL_DT: f64 = 5.0;

#[derive(Clone, Copy, Debug, PartialEq)]
struct V {
    x: f64,
    y: f64,
}

#[derive(Clone, Debug, Default)]
pub struct SampleDensifier {
    last: Option<Point>,
    held: Option<Point>,
    hist: Vec<V>,
    dir: Option<V>,
}

impl SampleDensifier {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, pt: Point) -> Vec<Point> {
        let prev = match self.last {
            None => {
                self.last = Some(pt);
                self.hist = vec![V { x: pt.x, y: pt.y }];
                return vec![pt];
            }
            Some(p) => p,
        };

        if (pt.x - prev.x).abs() < STILL_PX && (pt.y - prev.y).abs() < STILL_PX {
            let dt = pt.t.unwrap_or(0.0) - prev.t.unwrap_or(0.0);
            if dt < STILL_MS {
                self.held = Some(pt);
                return Vec::new();
            }
            self.held = None;
            self.last = Some(pt);
            return vec![pt];
        }

        let mut lead = Vec::new();
        let mut a = prev;
        if let Some(held) = self.held {
            if held.t.unwrap_or(0.0) > prev.t.unwrap_or(0.0) {
                a = held;
                lead.push(a);
            }
        }
        self.held = None;
        self.last = Some(pt);
        let filled = self.fill(a, pt);
        lead.extend(filled);
        lead
    }

    fn fill(&mut self, a: Point, pt: Point) -> Vec<Point> {
        let cx = pt.x - a.x;
        let cy = pt.y - a.y;
        let l = cx.js_hypot(cy);
        if l < 1e-6 {
            return vec![pt];
        }

        let chord = V {
            x: cx / l,
            y: cy / l,
        };

        let mut end = chord;
        if self.hist.len() >= 2 {
            let p0 = self.hist[self.hist.len() - 2];
            let p1 = self.hist[self.hist.len() - 1];
            let ux = p1.x - p0.x;
            let uy = p1.y - p0.y;
            let wx = pt.x - p0.x;
            let wy = pt.y - p0.y;
            let ang = (ux * wy - uy * wx).atan2(ux * wx + uy * wy);
            if ang.abs() < PI / 3.0 {
                let c = ang.cos();
                let s = ang.sin();
                end = V {
                    x: chord.x * c - chord.y * s,
                    y: chord.x * s + chord.y * c,
                };
            }
        }

        let start = self.dir.unwrap_or(chord);
        let tp = self.hist.last();
        if tp.is_none() || (pt.x - tp.unwrap().x).js_hypot(pt.y - tp.unwrap().y) >= BASE {
            self.hist.push(V { x: pt.x, y: pt.y });
            if self.hist.len() > 3 {
                self.hist.remove(0);
            }
        }

        let angle = |u: V, v: V| (u.x * v.y - u.y * v.x).atan2(u.x * v.x + u.y * v.y);
        let a1 = angle(start, chord);
        let a2 = angle(chord, end);
        let arc = a1.abs() < MAX_TURN
            && a2.abs() < MAX_TURN
            && (a1 - a2).abs() <= MIN_SKEW.max(0.6 * a1.abs().max(a2.abs()));

        self.dir = Some(end);
        let ta = a.t.unwrap_or(0.0);
        let tb = pt.t.unwrap_or(ta);
        let inked = pt.pressure > 0.0 && a.pressure > 0.0;

        if (l <= GAP || !inked) && tb - ta <= MAX_DT {
            return vec![pt];
        }

        let curved = arc && inked;
        let n = if inked {
            (l / STEP).ceil() as usize
        } else {
            1
        }
        .max(((tb - ta) / FILL_DT).ceil() as usize);

        let mut out = Vec::with_capacity(n);
        for k in 1..n {
            let s = k as f64 / n as f64;
            let s2 = s * s;
            let s3 = s2 * s;
            let h00 = 2.0 * s3 - 3.0 * s2 + 1.0;
            let h10 = s3 - 2.0 * s2 + s;
            let h01 = -2.0 * s3 + 3.0 * s2;
            let h11 = s3 - s2;

            let x = if curved {
                h00 * a.x + h10 * l * start.x + h01 * pt.x + h11 * l * end.x
            } else {
                a.x + cx * s
            };
            let y = if curved {
                h00 * a.y + h10 * l * start.y + h01 * pt.y + h11 * l * end.y
            } else {
                a.y + cy * s
            };
            let t = Some(ta + (tb - ta) * s);
            let pressure = if inked {
                a.pressure + (pt.pressure - a.pressure) * s
            } else {
                0.0
            };

            out.push(Point {
                x,
                y,
                pressure,
                t,
                alt: pt.alt,
                az: pt.az,
            });
        }
        out.push(pt);
        out
    }
}

