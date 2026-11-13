//! Critically damped spring-mass-damper filter for ink brush smoothing (Mechanism 4).
//!
//! When smoothing stylus input using virtual brush inertia or spring dynamics, an underdamped
//! system (damping ratio zeta < 1.0) oscillates past the target, producing a tail or hook on
//! lift-off. A critically damped system (zeta = 1.0) achieves the fastest approach to the touch
//! point with strictly zero oscillation and zero overshoot.
//!
//! On ACTION_UP / touchesEnded, extra frames of spring simulation are bypassed: the virtual brush
//! lerps directly from its current position to the final verified touch point and stops immediately.

use nib::geometry::XY;

#[derive(Clone, Copy, Debug)]
pub struct CriticallyDampedSpring {
    /// Angular frequency omega_0 (rad/s), controls responsiveness.
    pub omega: f64,
    /// Current position of the virtual brush.
    pub pos: XY,
    /// Current velocity of the virtual brush.
    pub vel: XY,
    /// Target touch position.
    pub target: XY,
}

impl CriticallyDampedSpring {
    pub fn new(initial_pos: XY, omega: f64) -> Self {
        Self {
            omega: omega.max(1e-3),
            pos: initial_pos,
            vel: XY { x: 0.0, y: 0.0 },
            target: initial_pos,
        }
    }

    /// Updates the target touch point.
    pub fn set_target(&mut self, target: XY) {
        self.target = target;
    }

    /// Simulates one time step `dt` (in seconds) under critical damping (zeta = 1.0).
    ///
    /// The analytical solution to the differential equation:
    ///   x''(t) + 2*omega*x'(t) + omega^2*(x(t) - target) = 0
    /// is:
    ///   e = pos - target
    ///   pos(dt) = target + (e + (vel + omega * e) * dt) * exp(-omega * dt)
    ///   vel(dt) = (vel - omega * (vel + omega * e) * dt) * exp(-omega * dt)
    ///
    /// This is mathematically guaranteed never to overshoot the target from rest.
    pub fn step(&mut self, dt: f64) -> XY {
        if dt <= 0.0 {
            return self.pos;
        }
        let exp_term = (-self.omega * dt).exp();

        let ex = self.pos.x - self.target.x;
        let ey = self.pos.y - self.target.y;

        let cx = self.vel.x + self.omega * ex;
        let cy = self.vel.y + self.omega * ey;

        let new_x = self.target.x + (ex + cx * dt) * exp_term;
        let new_y = self.target.y + (ey + cy * dt) * exp_term;

        let new_vx = (self.vel.x - self.omega * cx * dt) * exp_term;
        let new_vy = (self.vel.y - self.omega * cy * dt) * exp_term;

        self.pos = XY { x: new_x, y: new_y };
        self.vel = XY { x: new_vx, y: new_vy };
        self.pos
    }

    /// On ACTION_UP / touchesEnded:
    /// Instead of simulating extra frames (which causes overshooting tails),
    /// linearly interpolate (lerp) directly from current brush position to the last
    /// valid touch position with `n` subdivision steps and stop immediately.
    pub fn on_action_up_lerp(&mut self, last_touch: XY, steps: usize) -> Vec<XY> {
        let mut result = Vec::with_capacity(steps + 1);
        let start = self.pos;
        let n = steps.max(1);
        for s in 1..=n {
            let f = s as f64 / n as f64;
            result.push(XY {
                x: start.x + (last_touch.x - start.x) * f,
                y: start.y + (last_touch.y - start.y) * f,
            });
        }
        self.pos = last_touch;
        self.vel = XY { x: 0.0, y: 0.0 };
        self.target = last_touch;
        result
    }
}

