//! The page's draw list: its z-layers of strokes turned into the ops of the page's WebGL ink.
//!
//! TypeScript counterparts: `src/editor/zorder.ts` (`zLayers`: the page's items in z-order, ink
//! grouped into layers between blocks) and CanvasPage.tsx (each layer drawn as `drawStrokes`
//! draws it: highlighters, then fills, then ink, then arrowheads); the ops themselves are
//! `src/ink/glInk.ts`'s `Builder` (a highlighter laid on as one see-through shape; opaque strokes
//! of one colour in a row as one coverage run, so their overlapping capsules never darken; a
//! see-through stroke alone; a shape's fill by even-odd stencil; an arrowhead as a flat triangle).

use bytemuck::{Pod, Zeroable};
use model::Stroke;
use renderer::builder::{build_stroke_ops, FillMode, RenderOp, RenderOpKind};
use renderer::capsule::Capsule;
use renderer::color::Rgba;

/// Page px to device px: d = (a x + c y + ox, b x + d y + oy) (glInk's `GlTransform`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Transform {
    pub a: f32,
    pub b: f32,
    pub c: f32,
    pub d: f32,
    pub ox: f32,
    pub oy: f32,
}

impl Transform {
    pub fn scale(k: f32, ox: f32, oy: f32) -> Self {
        Transform {
            a: k,
            b: 0.0,
            c: 0.0,
            d: k,
            ox,
            oy,
        }
    }
    /// Device px per page px.
    pub fn px(&self) -> f32 {
        (self.a * self.d - self.b * self.c).abs().sqrt().max(1e-6)
    }
    pub(crate) fn apply(&self, x: f32, y: f32) -> (f32, f32) {
        (
            self.a * x + self.c * y + self.ox,
            self.b * x + self.d * y + self.oy,
        )
    }
}

/// A box in page px.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PageBox {
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct CapInst {
    a: [f32; 3],
    b: [f32; 3],
    col: [f32; 4],
}

#[derive(Clone, Debug)]
pub enum Op {
    /// A coverage run (max blend), composited once in `col` (straight alpha).
    See {
        first: u32,
        count: u32,
        col: [f32; 4],
        bx: PageBox,
    },
    /// An even-odd fill of `count` flat vertices (a triangle list) from `first`; then the box
    /// (6 flat vertices at `box_first`) in `col`, erased (hole), or `hatch_count` capsules from
    /// `hatch_first` under the stencil.
    Fill {
        first: u32,
        count: u32,
        mode: FillMode,
        col: [f32; 4],
        bx: PageBox,
        box_first: u32,
        hatch_first: u32,
        hatch_count: u32,
    },
    /// Plain triangles in `col` (arrowheads).
    Flat {
        first: u32,
        count: u32,
        col: [f32; 4],
        bx: PageBox,
    },
}

/// The page's draw list; `caps` and `flat` are the GPU buffers' contents.
#[derive(Clone, Debug, Default)]
pub struct Scene {
    pub caps: Vec<CapInst>,
    pub flat: Vec<[f32; 2]>,
    pub ops: Vec<Op>,
}

const fn rgba(c: Rgba) -> [f32; 4] {
    [c.r, c.g, c.b, c.a]
}

fn box_of_caps(caps: &[Capsule]) -> PageBox {
    let mut b = PageBox {
        x0: f32::INFINITY,
        y0: f32::INFINITY,
        x1: f32::NEG_INFINITY,
        y1: f32::NEG_INFINITY,
    };
    for c in caps {
        let (x0, y0, x1, y1) = c.bounds();
        b.x0 = b.x0.min(x0 as f32);
        b.y0 = b.y0.min(y0 as f32);
        b.x1 = b.x1.max(x1 as f32);
        b.y1 = b.y1.max(y1 as f32);
    }
    b
}

impl Scene {
    /// The scene of `layers` (bottom first, strokes in page order within a layer), drawn per
    /// layer in drawStrokes' order: highlighters, fills, ink, arrowheads.
    pub fn build(layers: &[&[Stroke]]) -> Scene {
        let ops: Vec<Vec<Vec<RenderOp>>> = layers
            .iter()
            .map(|l| l.iter().map(build_stroke_ops).collect())
            .collect();
        let refs: Vec<Vec<&[RenderOp]>> = ops
            .iter()
            .map(|l| l.iter().map(|o| o.as_slice()).collect())
            .collect();
        Scene::from_ops(&refs)
    }

    /// The scene of strokes whose ops (`build_stroke_ops`, the costly part: each stroke's drawn
    /// line) are already made: `layers` of strokes, each stroke its ops. The shells keep each
    /// stroke's ops between scenes (crates/native `canvasSceneBin`), so a new stroke on a long
    /// note costs its own geometry, not the note's.
    pub fn from_ops(layers: &[Vec<&[RenderOp]>]) -> Scene {
        let mut sc = Scene::default();
        for layer in layers {
            let mut hl: Vec<Op> = Vec::new();
            let mut fills: Vec<Op> = Vec::new();
            let mut ink: Vec<Op> = Vec::new();
            let mut arrows: Vec<Op> = Vec::new();
            // The open opaque run: its op index in `ink`, its colour, and whether the capsules
            // pushed since are still contiguous with it.
            let mut run: Option<(usize, [f32; 4])> = None;
            for stroke in layer.iter() {
                for op in stroke.iter() {
                    match &op.kind {
                        RenderOpKind::Highlighter { caps } => {
                            run = None;
                            hl.push(Op::See {
                                first: sc.push_caps(caps, op.color),
                                count: caps.len() as u32,
                                col: rgba(op.color),
                                bx: box_of_caps(caps),
                            });
                        }
                        RenderOpKind::Fill {
                            area,
                            mode,
                            hatch_caps,
                        } => {
                            run = None;
                            if area.len() < 3 {
                                continue;
                            }
                            let bx = {
                                let mut b = PageBox {
                                    x0: f32::INFINITY,
                                    y0: f32::INFINITY,
                                    x1: f32::NEG_INFINITY,
                                    y1: f32::NEG_INFINITY,
                                };
                                for p in area {
                                    b.x0 = b.x0.min(p.x as f32);
                                    b.y0 = b.y0.min(p.y as f32);
                                    b.x1 = b.x1.max(p.x as f32);
                                    b.y1 = b.y1.max(p.y as f32);
                                }
                                b
                            };
                            // The fan from the first corner as a triangle list (each triangle flips the stencil).
                            let first = sc.flat.len() as u32;
                            let p0 = area[0];
                            for w in area.windows(2).skip(1) {
                                sc.flat.push([p0.x as f32, p0.y as f32]);
                                sc.flat.push([w[0].x as f32, w[0].y as f32]);
                                sc.flat.push([w[1].x as f32, w[1].y as f32]);
                            }
                            let count = sc.flat.len() as u32 - first;
                            let box_first = sc.flat.len() as u32;
                            for (x, y) in [
                                (bx.x0, bx.y0),
                                (bx.x1, bx.y0),
                                (bx.x0, bx.y1),
                                (bx.x1, bx.y0),
                                (bx.x1, bx.y1),
                                (bx.x0, bx.y1),
                            ] {
                                sc.flat.push([x, y]);
                            }
                            let hatch_first = sc.push_caps(hatch_caps, op.color);
                            fills.push(Op::Fill {
                                first,
                                count,
                                mode: mode.clone(),
                                col: rgba(op.color),
                                bx,
                                box_first,
                                hatch_first,
                                hatch_count: hatch_caps.len() as u32,
                            });
                        }
                        RenderOpKind::Ink { caps } => {
                            let col = rgba(op.color);
                            let first = sc.push_caps(caps, op.color);
                            let bx = box_of_caps(caps);
                            match run {
                                Some((i, rc)) if rc == col && col[3] >= 1.0 => {
                                    if let Op::See { count, bx: b, .. } = &mut ink[i] {
                                        *count += caps.len() as u32;
                                        b.x0 = b.x0.min(bx.x0);
                                        b.y0 = b.y0.min(bx.y0);
                                        b.x1 = b.x1.max(bx.x1);
                                        b.y1 = b.y1.max(bx.y1);
                                    }
                                }
                                _ => {
                                    ink.push(Op::See {
                                        first,
                                        count: caps.len() as u32,
                                        col,
                                        bx,
                                    });
                                    run = if col[3] >= 1.0 {
                                        Some((ink.len() - 1, col))
                                    } else {
                                        None
                                    };
                                }
                            }
                        }
                        RenderOpKind::Arrow { points } => {
                            if points.is_empty() {
                                continue;
                            }
                            let bx = {
                                let mut b = PageBox {
                                    x0: f32::INFINITY,
                                    y0: f32::INFINITY,
                                    x1: f32::NEG_INFINITY,
                                    y1: f32::NEG_INFINITY,
                                };
                                for p in points {
                                    b.x0 = b.x0.min(p.x as f32);
                                    b.y0 = b.y0.min(p.y as f32);
                                    b.x1 = b.x1.max(p.x as f32);
                                    b.y1 = b.y1.max(p.y as f32);
                                }
                                b
                            };
                            let first = sc.flat.len() as u32;
                            for p in points {
                                sc.flat.push([p.x as f32, p.y as f32]);
                            }
                            arrows.push(Op::Flat {
                                first,
                                count: 3,
                                col: rgba(op.color),
                                bx,
                            });
                        }
                        RenderOpKind::Glow { .. } => {}
                    }
                }
            }
            sc.ops.extend(hl);
            sc.ops.extend(fills);
            sc.ops.extend(ink);
            sc.ops.extend(arrows);
        }
        sc
    }

    fn push_caps(&mut self, caps: &[Capsule], col: Rgba) -> u32 {
        let first = self.caps.len() as u32;
        let c = rgba(col);
        for k in caps {
            self.caps.push(CapInst {
                a: [k.ax as f32, k.ay as f32, k.ra as f32],
                b: [k.bx as f32, k.by as f32, k.rb as f32],
                col: c,
            });
        }
        first
    }
}
