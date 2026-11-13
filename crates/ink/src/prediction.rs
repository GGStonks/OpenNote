//! Strict separation between committed touch geometry and temporary predicted touches (Mechanism 1).
//!
//! To hide display latency, future pen positions may be extrapolated during fast moves.
//! However, if predicted samples are mixed with committed points or left behind at stroke end,
//! fast upward flicks (e.g., the second leg of a "V") leave an extrapolated tail in mid-air.
//!
//! This module maintains a strict isolation barrier:
//! - `committed`: verified historical touch points only.
//! - `predicted`: temporary projected points, recomputed each frame while the pen is moving.
//! - `on_touch_ended`: completely purges the prediction buffer immediately, ensuring zero
//!   unverified coordinates reach final geometry.

use model::Point;

#[derive(Clone, Debug, Default)]
pub struct StrokePredictor {
    committed: Vec<Point>,
    predicted: Vec<Point>,
}

impl StrokePredictor {
    pub fn new() -> Self {
        Self::default()
    }

    /// Appends a verified historical sample.
    pub fn push_committed(&mut self, pt: Point) {
        self.committed.push(pt);
    }

    /// Returns the verified historical points.
    pub fn committed(&self) -> &[Point] {
        &self.committed
    }

    /// Computes temporary predicted geometry (up to 1 frame ahead, half-damped)
    /// only while pen is moving and not decelerating.
    pub fn update_prediction(&mut self, predicted_raw: Option<Point>) -> &[Point] {
        self.predicted.clear();
        let n = self.committed.len();
        if n < 3 {
            return &self.predicted;
        }
        let Some(q) = predicted_raw else {
            return &self.predicted;
        };

        let a = &self.committed[n - 3];
        let b = &self.committed[n - 2];
        let c = &self.committed[n - 1];

        let dt1 = (b.t.unwrap_or(0.0) - a.t.unwrap_or(0.0)).max(1.0);
        let dt2 = (c.t.unwrap_or(0.0) - b.t.unwrap_or(0.0)).max(1.0);

        let s1 = (b.x - a.x).hypot(b.y - a.y) / dt1;
        let s2 = (c.x - b.x).hypot(c.y - b.y) / dt2;

        // If decelerating, do not predict (avoids overshoot into corners/stops)
        if s2 < s1 * 0.9 {
            return &self.predicted;
        }

        // Half-damped prediction
        self.predicted.push(Point {
            x: c.x + (q.x - c.x) * 0.5,
            y: c.y + (q.y - c.y) * 0.5,
            pressure: c.pressure,
            t: q.t,
            alt: c.alt,
            az: c.az,
        });

        &self.predicted
    }

    /// On ACTION_UP / touchesEnded:
    /// Completely discards temporary predicted points and returns verified committed points only.
    pub fn on_touch_ended(&mut self) -> &[Point] {
        self.predicted.clear();
        &self.committed
    }

    /// Points to display live while pen is down: committed + temporary predicted.
    pub fn live_display_points(&self) -> Vec<Point> {
        let mut pts = self.committed.clone();
        pts.extend_from_slice(&self.predicted);
        pts
    }
}

