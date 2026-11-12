use crate::capsule::{stroke_gl_geometry, Capsule};
use crate::color::Rgba;
use model::{FillType, Stroke};
use nib::geometry::XY;

#[derive(Clone, Debug, PartialEq)]
pub enum FillMode {
    Solid,
    Hole,
    Hatch,
}

#[derive(Clone, Debug)]
pub struct RenderOp {
    pub kind: RenderOpKind,
    pub color: Rgba,
    pub z_order: f64,
}

#[derive(Clone, Debug)]
pub enum RenderOpKind {
    Highlighter {
        caps: Vec<Capsule>,
    },
    Fill {
        area: Vec<XY>,
        mode: FillMode,
        hatch_caps: Vec<Capsule>,
    },
    Ink {
        caps: Vec<Capsule>,
    },
    Arrow {
        points: [XY; 3],
    },
    Glow {
        caps: Vec<Capsule>,
        radius: f64,
    },
}

const HATCH_SPACING: f64 = 8.0;

pub fn build_stroke_ops(s: &Stroke) -> Vec<RenderOp> {
    let mut ops = Vec::new();
    if s.points.is_empty() {
        return ops;
    }

    let (caps, area, arrow) = stroke_gl_geometry(s);
    let z = s.created_at.unwrap_or(0.0);
    let is_highlighter = s.tool == "highlighter";

    // 1. Highlighter
    if is_highlighter && !caps.is_empty() {
        let alpha = s.highlight_alpha.unwrap_or(0.35) as f32;
        let color = Rgba::parse(&s.color, alpha);
        ops.push(RenderOp {
            kind: RenderOpKind::Highlighter { caps: caps.clone() },
            color,
            z_order: z,
        });
        return ops;
    }

    // 2. Fill
    if let Some(poly) = area {
        if let Some(fill) = s.fill {
            if fill != FillType::None && poly.len() >= 3 {
                let (mode, fill_rgba) = match fill {
                    FillType::Solid => {
                        let c_str = s.fill_color.as_deref().unwrap_or(&s.color);
                        let a = s.fill_opacity.unwrap_or(0.22) as f32;
                        (FillMode::Solid, Rgba::parse(c_str, a))
                    }
                    FillType::Hole => (FillMode::Hole, Rgba::new(0.0, 0.0, 0.0, 1.0)),
                    _ => (FillMode::Hatch, Rgba::parse(&s.color, 0.5)),
                };

                let mut hatch_caps = Vec::new();
                if mode == FillMode::Hatch {
                    let mut min_x = f64::INFINITY;
                    let mut min_y = f64::INFINITY;
                    let mut max_x = f64::NEG_INFINITY;
                    let mut max_y = f64::NEG_INFINITY;
                    for p in &poly {
                        min_x = min_x.min(p.x);
                        min_y = min_y.min(p.y);
                        max_x = max_x.max(p.x);
                        max_y = max_y.max(p.y);
                    }
                    let h = max_y - min_y;
                    let r = 0.55;
                    let mut x = min_x - h;
                    while x < max_x + h {
                        if fill == FillType::NorthEast || fill == FillType::Crosshatch {
                            hatch_caps.push(Capsule::new(x, max_y, r, x + h, min_y, r));
                        }
                        if fill == FillType::NorthWest || fill == FillType::Crosshatch {
                            hatch_caps.push(Capsule::new(x, min_y, r, x + h, max_y, r));
                        }
                        x += HATCH_SPACING;
                    }
                }

                ops.push(RenderOp {
                    kind: RenderOpKind::Fill {
                        area: poly,
                        mode,
                        hatch_caps,
                    },
                    color: fill_rgba,
                    z_order: z,
                });
            }
        }
    }

    // 3. Ink
    if !caps.is_empty() {
        let alpha = s.opacity as f32;
        let color = Rgba::parse(&s.color, alpha);
        ops.push(RenderOp {
            kind: RenderOpKind::Ink { caps },
            color,
            z_order: z,
        });
    }

    // 4. Arrow
    if let Some(arr) = arrow {
        let alpha = s.opacity as f32;
        let color = Rgba::parse(&s.color, alpha);
        ops.push(RenderOp {
            kind: RenderOpKind::Arrow { points: arr },
            color,
            z_order: z,
        });
    }

    ops
}

pub fn build_glow_ops(strokes: &[Stroke], radius: f64, color: Rgba) -> Vec<RenderOp> {
    let mut ops = Vec::new();
    for s in strokes {
        let (caps, _, _) = stroke_gl_geometry(s);
        if !caps.is_empty() {
            ops.push(RenderOp {
                kind: RenderOpKind::Glow { caps, radius },
                color,
                z_order: -1.0,
            });
        }
    }
    ops
}

