//! The line being written, computed in the shell from its own pen samples (native live ink).
//!
//! The page (src/components/CanvasPage.tsx) turns each shell sample into a point and feeds the ink
//! engine; the shell used to wait for that line (`u` messages, src/ink/nativeInk.ts) and drew a
//! straight lead from its end to the pen meanwhile. Now the shell computes the same line here, on
//! every touch event, from the very values it sends the page (the formatted numbers, parsed back),
//! with the page's arithmetic (`toPoint`, `ingestSamples`, `nativeInputRef`):
//!
//! - page px: `((clientX - left) * w) / rw`, `((clientY - top) * h) / rh` (the canvas's rect and
//!   size, sent by the page);
//! - time: `round(((t * 1000 + offset) - start) * 10) / 10` ms, `start` the stroke's first sample
//!   (`offset`: nativePencil's per-touch clock offset);
//! - pressure: the force clamped to 0..1, 0 while lifting (no force);
//! - the first sample goes to the engine as it is, later ones through the densifier;
//! - the width follows the pressure only once a sample had real force (not 0, not 0.5).
//!
//! The line is SmoothLiveStroke's, in Rust (crates/ink, the TypeScript one point for point:
//! crates/ink/tests/reference.rs), sent as the shell's `u` would get it: view units
//! (`ox + x * k`), radius `(width / 2) * k`.

use ink::{SampleDensifier, SmoothLiveStroke};
use model::Point;

/// What the page sends with `r` (crates/native/src/lib.rs `opennote_live_new`).
#[derive(Clone, Copy, Debug)]
pub struct LiveParams {
    pub left: f64,
    pub top: f64,
    pub w: f64,
    pub rw: f64,
    pub h: f64,
    pub rh: f64,
    /// performance.now() minus the shell's clock (ms), fixed for the touch.
    pub offset: f64,
    /// The stroke's first sample's time on the page's clock (ms).
    pub start: f64,
    pub ox: f64,
    pub oy: f64,
    pub k: f64,
    /// The drawn width (strokeWidth).
    pub width: f64,
    /// The pen draws variable width at all (isVariableWidth: the fountain pen).
    pub variable: bool,
}

pub struct Live {
    p: LiveParams,
    started: bool,
    real: bool,
    dense: SampleDensifier,
    model: SmoothLiveStroke,
    sent: usize,
}

/// JavaScript's Math.round (halves up, also below zero).
fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 {
        f + 1.0
    } else {
        f
    }
}

impl Live {
    pub fn new(p: LiveParams) -> Self {
        Live { p, started: false, real: false, dense: SampleDensifier::new(), model: SmoothLiveStroke::new(), sent: 0 }
    }

    /// The page's time for a sample (shell clock `t` in s), as nativePencil + toPoint compute it.
    pub fn page_time(&self, t: f64) -> f64 {
        t * 1000.0 + self.p.offset
    }

    /// A shell sample: position in view points / CSS px, force as sent (unclamped), time in s.
    pub fn add(&mut self, x: f64, y: f64, force: f64, t: f64) {
        let force = force.clamp(0.0, 1.0);
        let pt = Point {
            x: ((x - self.p.left) * self.p.w) / self.p.rw,
            y: ((y - self.p.top) * self.p.h) / self.p.rh,
            pressure: if force > 0.0 { force } else { 0.0 },
            t: Some(js_round((self.page_time(t) - self.p.start) * 10.0) / 10.0),
            ..Default::default()
        };
        if force > 0.0 && force != 0.5 {
            self.real = true;
        }
        if !self.started {
            self.started = true;
            self.model.add(pt.x, pt.y, pt.t.unwrap_or(0.0), pt.pressure);
            self.dense.push(pt);
            return;
        }
        for q in self.dense.push(pt) {
            self.model.add(q.x, q.y, q.t.unwrap_or(0.0), q.pressure);
        }
    }

    /// The line to draw, as a `u` message carries it: the settled points added since the last call
    /// (`fresh` of them), then the provisional rest; each x, y (view units) and radius.
    pub fn update(&mut self, out: &mut Vec<f64>) -> usize {
        out.clear();
        let line = self.model.line(self.p.width, self.p.variable && self.real);
        let p = &self.p;
        let fresh = line.final_pts.len().saturating_sub(self.sent);
        for i in self.sent.min(line.final_pts.len())..line.final_pts.len() {
            let q = &line.final_pts[i];
            out.extend([p.ox + q.x * p.k, p.oy + q.y * p.k, (line.final_w[i] / 2.0) * p.k]);
        }
        self.sent = line.final_pts.len();
        for (q, w) in line.rest_pts.iter().zip(&line.rest_w) {
            out.extend([p.ox + q.x * p.k, p.oy + q.y * p.k, (w / 2.0) * p.k]);
        }
        fresh
    }
}
