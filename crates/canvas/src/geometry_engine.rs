//! Geometry Engine: High-precision 2D math, clipping, polygon testing, and transformations.

/// A 2D point / vector in double precision.
#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Vec2d {
    pub x: f64,
    pub y: f64,
}

impl Vec2d {
    #[inline]
    pub const fn new(x: f64, y: f64) -> Self {
        Vec2d { x, y }
    }

    #[inline]
    pub fn add(self, rhs: Vec2d) -> Vec2d {
        Vec2d { x: self.x + rhs.x, y: self.y + rhs.y }
    }

    #[inline]
    pub fn sub(self, rhs: Vec2d) -> Vec2d {
        Vec2d { x: self.x - rhs.x, y: self.y - rhs.y }
    }

    #[inline]
    pub fn scale(self, k: f64) -> Vec2d {
        Vec2d { x: self.x * k, y: self.y * k }
    }

    #[inline]
    pub fn dot(self, rhs: Vec2d) -> f64 {
        self.x * rhs.x + self.y * rhs.y
    }

    #[inline]
    pub fn cross(self, rhs: Vec2d) -> f64 {
        self.x * rhs.y - self.y * rhs.x
    }

    #[inline]
    pub fn length_sq(self) -> f64 {
        self.x * self.x + self.y * self.y
    }

    #[inline]
    pub fn length(self) -> f64 {
        self.length_sq().sqrt()
    }

    #[inline]
    pub fn distance(self, rhs: Vec2d) -> f64 {
        self.sub(rhs).length()
    }

    #[inline]
    pub fn distance_sq(self, rhs: Vec2d) -> f64 {
        self.sub(rhs).length_sq()
    }

    #[inline]
    pub fn normalize(self) -> Vec2d {
        let len = self.length();
        if len > 1e-12 {
            self.scale(1.0 / len)
        } else {
            Vec2d::new(0.0, 0.0)
        }
    }

    #[inline]
    pub fn rotate(self, rad: f64) -> Vec2d {
        let c = rad.cos();
        let s = rad.sin();
        Vec2d {
            x: self.x * c - self.y * s,
            y: self.x * s + self.y * c,
        }
    }

    #[inline]
    pub fn lerp(self, rhs: Vec2d, t: f64) -> Vec2d {
        Vec2d {
            x: self.x + (rhs.x - self.x) * t,
            y: self.y + (rhs.y - self.y) * t,
        }
    }
}

/// Axis-aligned bounding box in double precision.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct RectBounds {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

impl Default for RectBounds {
    fn default() -> Self {
        RectBounds {
            min_x: f64::INFINITY,
            min_y: f64::INFINITY,
            max_x: f64::NEG_INFINITY,
            max_y: f64::NEG_INFINITY,
        }
    }
}

impl RectBounds {
    #[inline]
    pub const fn new(min_x: f64, min_y: f64, max_x: f64, max_y: f64) -> Self {
        RectBounds { min_x, min_y, max_x, max_y }
    }

    #[inline]
    pub fn from_point(p: Vec2d) -> Self {
        RectBounds {
            min_x: p.x,
            min_y: p.y,
            max_x: p.x,
            max_y: p.y,
        }
    }

    #[inline]
    pub fn from_points(pts: &[Vec2d]) -> Self {
        let mut b = RectBounds::default();
        for p in pts {
            b.include(*p);
        }
        b
    }

    #[inline]
    pub fn width(&self) -> f64 {
        (self.max_x - self.min_x).max(0.0)
    }

    #[inline]
    pub fn height(&self) -> f64 {
        (self.max_y - self.min_y).max(0.0)
    }

    #[inline]
    pub fn center(&self) -> Vec2d {
        Vec2d::new((self.min_x + self.max_x) * 0.5, (self.min_y + self.max_y) * 0.5)
    }

    #[inline]
    pub fn include(&mut self, p: Vec2d) {
        if p.x < self.min_x { self.min_x = p.x; }
        if p.y < self.min_y { self.min_y = p.y; }
        if p.x > self.max_x { self.max_x = p.x; }
        if p.y > self.max_y { self.max_y = p.y; }
    }

    #[inline]
    pub fn union(&self, other: &RectBounds) -> RectBounds {
        RectBounds {
            min_x: self.min_x.min(other.min_x),
            min_y: self.min_y.min(other.min_y),
            max_x: self.max_x.max(other.max_x),
            max_y: self.max_y.max(other.max_y),
        }
    }

    #[inline]
    pub fn pad(&self, margin: f64) -> RectBounds {
        RectBounds {
            min_x: self.min_x - margin,
            min_y: self.min_y - margin,
            max_x: self.max_x + margin,
            max_y: self.max_y + margin,
        }
    }

    #[inline]
    pub fn contains_point(&self, p: Vec2d) -> bool {
        p.x >= self.min_x && p.x <= self.max_x && p.y >= self.min_y && p.y <= self.max_y
    }

    #[inline]
    pub fn intersects(&self, other: &RectBounds) -> bool {
        self.min_x <= other.max_x && self.max_x >= other.min_x &&
        self.min_y <= other.max_y && self.max_y >= other.min_y
    }
}

/// Oriented Bounding Box (OBB) for selections, rotated shapes, and interactive transformation handles.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct OrientedBoundingBox {
    pub center: Vec2d,
    pub half_extents: Vec2d,
    pub rotation_rad: f64,
}

impl OrientedBoundingBox {
    pub fn from_aabb(aabb: &RectBounds) -> Self {
        OrientedBoundingBox {
            center: aabb.center(),
            half_extents: Vec2d::new(aabb.width() * 0.5, aabb.height() * 0.5),
            rotation_rad: 0.0,
        }
    }

    pub fn corners(&self) -> [Vec2d; 4] {
        let (hx, hy) = (self.half_extents.x, self.half_extents.y);
        let offsets = [
            Vec2d::new(-hx, -hy).rotate(self.rotation_rad),
            Vec2d::new(hx, -hy).rotate(self.rotation_rad),
            Vec2d::new(hx, hy).rotate(self.rotation_rad),
            Vec2d::new(-hx, hy).rotate(self.rotation_rad),
        ];
        [
            self.center.add(offsets[0]),
            self.center.add(offsets[1]),
            self.center.add(offsets[2]),
            self.center.add(offsets[3]),
        ]
    }

    /// Checks if a point is inside the oriented bounding box.
    pub fn contains_point(&self, p: Vec2d) -> bool {
        let d = p.sub(self.center).rotate(-self.rotation_rad);
        d.x.abs() <= self.half_extents.x && d.y.abs() <= self.half_extents.y
    }

    /// Checks if a point is strictly outside the selection (including a tolerance margin for handles/edges).
    pub fn is_point_outside(&self, p: Vec2d, margin: f64) -> bool {
        let d = p.sub(self.center).rotate(-self.rotation_rad);
        d.x.abs() > (self.half_extents.x + margin) || d.y.abs() > (self.half_extents.y + margin)
    }

    /// Returns the 8 resize/scale handles + 1 rotation handle in world coordinates.
    /// Handles:
    /// 0: Top-Left, 1: Top-Center, 2: Top-Right, 3: Middle-Right,
    /// 4: Bottom-Right, 5: Bottom-Center, 6: Bottom-Left, 7: Middle-Left,
    /// 8: Rotation (above Top-Center).
    pub fn handle_positions(&self, rot_offset: f64) -> [Vec2d; 9] {
        let (hx, hy) = (self.half_extents.x, self.half_extents.y);
        let local = [
            Vec2d::new(-hx, -hy), // 0: TL
            Vec2d::new(0.0, -hy), // 1: TC
            Vec2d::new(hx, -hy),  // 2: TR
            Vec2d::new(hx, 0.0),  // 3: MR
            Vec2d::new(hx, hy),   // 4: BR
            Vec2d::new(0.0, hy),  // 5: BC
            Vec2d::new(-hx, hy),  // 6: BL
            Vec2d::new(-hx, 0.0), // 7: ML
            Vec2d::new(0.0, -hy - rot_offset), // 8: Rotation
        ];
        let mut out = [Vec2d::default(); 9];
        for i in 0..9 {
            out[i] = self.center.add(local[i].rotate(self.rotation_rad));
        }
        out
    }

    /// Hit-tests handles given a hit radius.
    pub fn hit_test_handle(&self, p: Vec2d, hit_radius: f64) -> Option<usize> {
        let handles = self.handle_positions(24.0);
        let r_sq = hit_radius * hit_radius;
        for (i, h) in handles.iter().enumerate() {
            if p.distance_sq(*h) <= r_sq {
                return Some(i);
            }
        }
        None
    }
}

/// Distance from point p to line segment (a, b).
pub fn distance_to_segment(p: Vec2d, a: Vec2d, b: Vec2d) -> f64 {
    let ab = b.sub(a);
    let l2 = ab.length_sq();
    if l2 < 1e-12 {
        return p.distance(a);
    }
    let t = (p.sub(a).dot(ab) / l2).clamp(0.0, 1.0);
    p.distance(a.add(ab.scale(t)))
}
