//! A page's paper. TypeScript counterpart: CanvasPage.tsx `paperBackground` (the CSS paper the
//! page draws under its ink): the colours and the lattice origin are decided here from what the
//! page knows, the pattern itself in `shaders.wgsl` `fs_paper`.

use crate::gpu::Uniforms;
use model::{PaperColor, PaperStyle};
use renderer::color::Rgba;

/// A page's paper, as the app's `paperBackground` (CanvasPage.tsx) draws it: the colours and the
/// lattice origin are decided here from what the page knows (its hex colour, whether it is dark,
/// a chosen pattern colour), the pattern itself in `fs_paper`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Paper {
    pub width: f32,
    pub height: f32,
    /// 0 blank, 1 ruled, 2 narrow, 3 lines, 4 narrowLines, 5 grid, 6 graph, 7 dots.
    pub style: u32,
    pub base: [f32; 4],
    pub dark: bool,
    /// A chosen pattern colour (rgb 0..1), else the defaults.
    pub pattern: Option<[f32; 3]>,
    /// Where the page sits on the surface (page px): grids and dots line up across pages.
    pub origin: [f32; 2],
}

impl Paper {
    /// The paper of a note's `PaperStyle` and `PaperColor` (the model's names and hex colours, as
    /// `paperBackground` reads them).
    pub fn from_style_and_color(
        style: PaperStyle,
        color: &PaperColor,
        width: f32,
        height: f32,
        origin: [f32; 2],
        pattern: Option<[f32; 3]>,
    ) -> Self {
        let base = Rgba::parse(color.hex(), 1.0);
        let style = match style {
            PaperStyle::Blank => 0,
            PaperStyle::Ruled => 1,
            PaperStyle::Narrow => 2,
            PaperStyle::Lines => 3,
            PaperStyle::NarrowLines => 4,
            PaperStyle::Grid => 5,
            PaperStyle::Graph => 6,
            PaperStyle::Dots => 7,
        };
        Paper {
            width,
            height,
            style,
            base: [base.r, base.g, base.b, base.a],
            dark: color.is_dark(),
            pattern,
            origin,
        }
    }

    pub fn style_code(name: &str) -> u32 {
        match name {
            "ruled" => 1,
            "narrow" => 2,
            "lines" => 3,
            "narrowLines" => 4,
            "grid" => 5,
            "graph" => 6,
            "dots" => 7,
            _ => 0,
        }
    }

    /// Whether the paper can be drawn: a finite box of positive size (at most `MAX_SIZE` page px a
    /// side), finite colours and origin.
    pub fn is_drawable(&self) -> bool {
        let fin = |v: &[f32]| v.iter().all(|x| x.is_finite());
        self.width > 0.0
            && self.height > 0.0
            && self.width <= Self::MAX_SIZE
            && self.height <= Self::MAX_SIZE
            && fin(&self.base)
            && fin(&self.origin)
            && self.pattern.is_none_or(|p| fin(&p))
    }

    /// The largest paper side drawn, page px (a sheet is at most a few thousand).
    pub const MAX_SIZE: f32 = 1e6;

    pub(crate) fn uniforms(&self, base: &Uniforms) -> Uniforms {
        let [line, margin, grid, major, minor, dot] = self.pattern_colors();
        Uniforms {
            p_style: self.style,
            p_lw: 1.0,
            p_origin: self.origin,
            p_size: [self.width, self.height],
            p_pad: [1.3, 0.0],
            p_base: self.base,
            p_line: line,
            p_margin: margin,
            p_grid: grid,
            p_major: major,
            p_minor: minor,
            p_dot: dot,
            ..*base
        }
    }

    /// The pattern's colours (straight rgba): ruled lines, the margin, grid lines, graph majors and
    /// minors, dots. The shader's (`fs_paper`) and the cast viewer's.
    pub fn pattern_colors(&self) -> [[f32; 4]; 6] {
        let c = |r: f32, g: f32, b: f32, a: f32| [r / 255.0, g / 255.0, b / 255.0, a];
        let dark = self.dark;
        // paperBackground's `ink`: a chosen colour at three times the alpha (capped), else the defaults.
        let ink = |a: f32, light: [f32; 4], on_dark: [f32; 4]| match self.pattern {
            Some(pc) => [pc[0], pc[1], pc[2], (a * 3.0).min(1.0)],
            None => {
                if dark {
                    on_dark
                } else {
                    light
                }
            }
        };
        let line = match self.pattern {
            Some(_) => ink(0.22, [0.0; 4], [0.0; 4]),
            None => {
                if dark {
                    c(255.0, 255.0, 255.0, 0.13)
                } else {
                    c(59.0, 130.0, 246.0, 0.22)
                }
            }
        };
        let grid = ink(
            if dark { 0.09 } else { 0.08 },
            c(0.0, 0.0, 0.0, 0.08),
            c(255.0, 255.0, 255.0, 0.09),
        );
        let margin = if dark {
            c(239.0, 68.0, 68.0, 0.35)
        } else {
            c(239.0, 68.0, 68.0, 0.4)
        };
        let major = ink(
            if dark { 0.16 } else { 0.13 },
            c(0.0, 0.0, 0.0, 0.13),
            c(255.0, 255.0, 255.0, 0.16),
        );
        let minor = match self.pattern {
            Some(pc) => [pc[0], pc[1], pc[2], 0.15],
            None => {
                if dark {
                    c(255.0, 255.0, 255.0, 0.06)
                } else {
                    c(0.0, 0.0, 0.0, 0.05)
                }
            }
        };
        let dot = match self.pattern {
            Some(pc) => [pc[0], pc[1], pc[2], 0.7],
            None => {
                if dark {
                    c(255.0, 255.0, 255.0, 0.28)
                } else {
                    c(0.0, 0.0, 0.0, 0.22)
                }
            }
        };
        [line, margin, grid, major, minor, dot]
    }
}
