//! 1€ Filter (One-Euro Filter) for adaptive stylus jitter stabilization.
//!
//! Casiez et al., 2012: Adaptive low-pass filter with velocity-scaled cutoff.
//! Low velocity -> low cutoff (heavy jitter removal for slow handwriting).
//! High velocity -> high cutoff (virtually zero phase lag for fast strokes).

#[derive(Clone, Copy, Debug)]
pub struct LowPassFilter {
    hat_x_prev: f64,
    pub initialized: bool,
}

impl Default for LowPassFilter {
    fn default() -> Self {
        Self::new()
    }
}

impl LowPassFilter {
    pub fn new() -> Self {
        Self {
            hat_x_prev: 0.0,
            initialized: false,
        }
    }

    pub fn filter(&mut self, x: f64, alpha: f64) -> f64 {
        if !self.initialized {
            self.hat_x_prev = x;
            self.initialized = true;
            return x;
        }
        let hat_x = alpha * x + (1.0 - alpha) * self.hat_x_prev;
        self.hat_x_prev = hat_x;
        hat_x
    }

    pub fn last_value(&self) -> f64 {
        self.hat_x_prev
    }

    pub fn reset(&mut self) {
        self.initialized = false;
        self.hat_x_prev = 0.0;
    }
}

#[derive(Clone, Copy, Debug)]
pub struct OneEuroFilter {
    min_cutoff: f64,
    beta: f64,
    d_cutoff: f64,
    x_filter: LowPassFilter,
    dx_filter: LowPassFilter,
    last_time: Option<f64>,
}

impl OneEuroFilter {
    pub fn new(min_cutoff: f64, beta: f64, d_cutoff: f64) -> Self {
        Self {
            min_cutoff,
            beta,
            d_cutoff,
            x_filter: LowPassFilter::new(),
            dx_filter: LowPassFilter::new(),
            last_time: None,
        }
    }

    pub fn default_stylus() -> Self {
        // High-precision tuning for 120-240 Hz digital pens:
        // Slow handwriting -> min_cutoff = 1.0 Hz (heavy jitter removal)
        // Fast stroke -> beta = 0.05 scales cutoff up to 30-100 Hz (virtually zero phase lag)
        Self::new(1.0, 0.05, 1.0)
    }

    fn alpha(rate: f64, cutoff: f64) -> f64 {
        let tau = 1.0 / (2.0 * std::f64::consts::PI * cutoff);
        let te = 1.0 / rate;
        1.0 / (1.0 + tau / te)
    }

    pub fn filter(&mut self, x: f64, timestamp_s: f64) -> f64 {
        let dt = match self.last_time {
            Some(prev) => (timestamp_s - prev).clamp(0.0005, 0.05), // clamp to 0.5ms..50ms
            None => 1.0 / 120.0,
        };
        self.last_time = Some(timestamp_s);

        let rate = 1.0 / dt;

        let dx = if self.x_filter.initialized {
            (x - self.x_filter.last_value()) * rate
        } else {
            0.0
        };

        let edx = self.dx_filter.filter(dx, Self::alpha(rate, self.d_cutoff));
        let cutoff = self.min_cutoff + self.beta * edx.abs();
        self.x_filter.filter(x, Self::alpha(rate, cutoff))
    }

    pub fn reset(&mut self) {
        self.x_filter.reset();
        self.dx_filter.reset();
        self.last_time = None;
    }
}

#[derive(Clone, Copy, Debug)]
pub struct OneEuroPointFilter {
    x_filt: OneEuroFilter,
    y_filt: OneEuroFilter,
    p_filt: OneEuroFilter,
}

impl Default for OneEuroPointFilter {
    fn default() -> Self {
        Self::default_stylus()
    }
}

impl OneEuroPointFilter {
    pub fn new(min_cutoff: f64, beta: f64, d_cutoff: f64) -> Self {
        Self {
            x_filt: OneEuroFilter::new(min_cutoff, beta, d_cutoff),
            y_filt: OneEuroFilter::new(min_cutoff, beta, d_cutoff),
            p_filt: OneEuroFilter::new(min_cutoff, beta, d_cutoff),
        }
    }

    pub fn default_stylus() -> Self {
        Self {
            x_filt: OneEuroFilter::default_stylus(),
            y_filt: OneEuroFilter::default_stylus(),
            p_filt: OneEuroFilter::new(2.0, 0.01, 1.0),
        }
    }

    pub fn filter(&mut self, x: f64, y: f64, pressure: f64, timestamp_s: f64) -> (f64, f64, f64) {
        let fx = self.x_filt.filter(x, timestamp_s);
        let fy = self.y_filt.filter(y, timestamp_s);
        let fp = self.p_filt.filter(pressure, timestamp_s).clamp(0.0, 1.0);
        (fx, fy, fp)
    }

    pub fn reset(&mut self) {
        self.x_filt.reset();
        self.y_filt.reset();
        self.p_filt.reset();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_euro_stabilization() {
        let mut filter = OneEuroFilter::default_stylus();
        let mut t = 0.0;
        let dt = 1.0 / 120.0;

        // Slow movement with high jitter
        for i in 0..60 {
            t += dt;
            let raw = 100.0 + (if i % 2 == 0 { 0.5 } else { -0.5 });
            let smooth = filter.filter(raw, t);
            assert!((smooth - 100.0).abs() <= 0.5);
            if i > 5 {
                // After initial warmup, jitter is heavily attenuated
                assert!((smooth - 100.0).abs() < 0.35);
            }
        }

        // Fast stroke: should track closely with low latency once motion establishes
        for i in 0..60 {
            t += dt;
            let raw = 100.0 + (i as f64) * 5.0;
            let smooth = filter.filter(raw, t);
            if i > 15 {
                assert!(
                    (smooth - raw).abs() < 5.0,
                    "lag at step {i}: {}",
                    (smooth - raw).abs()
                );
            }
        }
    }
}
