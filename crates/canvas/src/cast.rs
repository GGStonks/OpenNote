//! What the cast's viewer (crates/remote `viewer.html`) draws: the pages near the view, their paper
//! and their ink, as the canvas holds them, in one binary snapshot (little endian, f32 unless
//! said). The viewer places them with the canvas's own surface transform (the camera packets), so
//! a PC shows what the device's screen shows.
//!
//! ```text
//! u32 MAGIC, u32 VERSION
//! f32 device width, height (px), device px per view unit (the live pen points' unit)
//! f32 x4 desk colour (straight rgba 0..1; alpha 0: none)
//! u32 pages, each:
//!   f64 x2 `at` (surface px)
//!   u8 has paper; then f32 width, height; u32 style; f32 x2 origin; f32 x4 base;
//!      f32 x4 x6 pattern colours (Paper::pattern_colors)
//!   u32 capsules, each f32 ax, ay, ar, bx, by, br (page px)
//!   u32 flat vertices, each f32 x, y
//!   u32 ops, each: u8 kind (0 ink run, 1 fill, 2 triangles); f32 x4 colour; u32 first, count;
//!      a fill also u8 mode (0 solid, 1 hole, 2 hatch), u32 box first, hatch first, hatch count
//! ```
//!
//! Pictures are left out (the viewer draws their place as nothing).

use crate::paper::Paper;
use crate::scene::{Op, Scene};
use renderer::builder::FillMode;
use renderer::color::Rgba;

pub const MAGIC: u32 = 0x4443_4E4F; // "ONCD"
pub const VERSION: u32 = 1;

/// One placement: where it sits on the surface, its paper, its scene (when the canvas has it).
pub struct CastPage<'a> {
    pub at: [f64; 2],
    pub paper: Option<&'a Paper>,
    pub scene: Option<&'a Scene>,
}

struct W(Vec<u8>);

impl W {
    fn u8(&mut self, v: u8) {
        self.0.push(v);
    }
    fn u32(&mut self, v: u32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn f32(&mut self, v: f32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn f64(&mut self, v: f64) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn rgba(&mut self, c: [f32; 4]) {
        for v in c {
            self.f32(v);
        }
    }
}

/// The snapshot of `pages` for a device screen of `device` px (`view_px` device px per view unit).
pub fn encode(device: [f32; 2], view_px: f32, clear: Option<Rgba>, pages: &[CastPage]) -> Vec<u8> {
    let caps: usize = pages.iter().filter_map(|p| p.scene).map(|s| s.caps.len()).sum();
    let mut w = W(Vec::with_capacity(64 + pages.len() * 160 + caps * 24));
    w.u32(MAGIC);
    w.u32(VERSION);
    w.f32(device[0]);
    w.f32(device[1]);
    w.f32(view_px);
    w.rgba(clear.map_or([0.0; 4], |c| [c.r, c.g, c.b, c.a]));
    w.u32(pages.len() as u32);
    for p in pages {
        w.f64(p.at[0]);
        w.f64(p.at[1]);
        match p.paper {
            Some(pp) => {
                w.u8(1);
                w.f32(pp.width);
                w.f32(pp.height);
                w.u32(pp.style);
                w.f32(pp.origin[0]);
                w.f32(pp.origin[1]);
                w.rgba(pp.base);
                for c in pp.pattern_colors() {
                    w.rgba(c);
                }
            }
            None => w.u8(0),
        }
        let empty = Scene::default();
        let s = p.scene.unwrap_or(&empty);
        w.u32(s.caps.len() as u32);
        for c in &s.caps {
            let (a, b) = c.ends();
            for v in a.into_iter().chain(b) {
                w.f32(v);
            }
        }
        w.u32(s.flat.len() as u32);
        for v in &s.flat {
            w.f32(v[0]);
            w.f32(v[1]);
        }
        let ops: Vec<&Op> = s.ops.iter().filter(|o| !matches!(o, Op::Image { .. })).collect();
        w.u32(ops.len() as u32);
        for op in ops {
            match op {
                Op::See {
                    first, count, col, ..
                } => {
                    w.u8(0);
                    w.rgba(*col);
                    w.u32(*first);
                    w.u32(*count);
                }
                Op::Fill {
                    first,
                    count,
                    mode,
                    col,
                    box_first,
                    hatch_first,
                    hatch_count,
                    ..
                } => {
                    w.u8(1);
                    w.rgba(*col);
                    w.u32(*first);
                    w.u32(*count);
                    w.u8(match mode {
                        FillMode::Solid => 0,
                        FillMode::Hole => 1,
                        FillMode::Hatch => 2,
                    });
                    w.u32(*box_first);
                    w.u32(*hatch_first);
                    w.u32(*hatch_count);
                }
                Op::Flat {
                    first, count, col, ..
                } => {
                    w.u8(2);
                    w.rgba(*col);
                    w.u32(*first);
                    w.u32(*count);
                }
                Op::Image { .. } => unreachable!("left out above"),
            }
        }
    }
    w.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use model::{Point, Stroke};

    #[test]
    fn a_page_with_ink_is_encoded_whole() {
        let stroke = Stroke {
            id: "s".into(),
            color: "#1d4ed8".into(),
            width: 3.0,
            points: (0..=10)
                .map(|i| Point {
                    x: 10.0 + i as f64 * 8.0,
                    y: 40.0,
                    pressure: 0.5,
                    t: Some(i as f64 * 8.0),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        };
        let scene = Scene::build(&[&[stroke]]);
        assert!(!scene.caps.is_empty());
        let paper = Paper {
            width: 600.0,
            height: 800.0,
            style: 1,
            base: [1.0, 1.0, 1.0, 1.0],
            dark: false,
            pattern: None,
            origin: [0.0, 0.0],
        };
        let bytes = encode(
            [1640.0, 2360.0],
            2.0,
            Some(Rgba::WHITE),
            &[CastPage {
                at: [12.0, 900.0],
                paper: Some(&paper),
                scene: Some(&scene),
            }],
        );
        let u32_at = |i: usize| u32::from_le_bytes(bytes[i..i + 4].try_into().unwrap());
        assert_eq!((u32_at(0), u32_at(4)), (MAGIC, VERSION));
        assert_eq!(u32_at(36), 1, "one page");
        // Header 36, page count 4, page: at 16, paper 1 + 4*5 + 16 + 96, caps count 4 + 24 each, flat count
        // 4 + 8 each, ops count 4 + each op.
        let caps_at = 40 + 16 + 1 + 20 + 16 + 96;
        assert_eq!(u32_at(caps_at) as usize, scene.caps.len());
        let flat_at = caps_at + 4 + scene.caps.len() * 24;
        assert_eq!(u32_at(flat_at) as usize, scene.flat.len());
        let ops_at = flat_at + 4 + scene.flat.len() * 8;
        assert_eq!(u32_at(ops_at) as usize, scene.ops.len());
    }
}
