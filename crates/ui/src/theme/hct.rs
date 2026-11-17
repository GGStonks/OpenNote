//! HCT (Hue, Chroma, Tone) and Material 3 Tonal Palette Generator.
//!
//! Generates harmonized surface container steps, primary, and tertiary accent
//! tones from any user-selected or wallpaper seed color.

use super::color::Color;
use serde::{Deserialize, Serialize};

/// Tonal step levels matching Material 3 specifications.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TonalPalette {
    pub seed: Color,
    pub tone_100: Color, // Pure White
    pub tone_96: Color,  // surface_container_low (light)
    pub tone_92: Color,  // surface_container (light)
    pub tone_90: Color,  // surface_container_high (light)
    pub tone_80: Color,  // primary / tertiary (dark mode)
    pub tone_40: Color,  // primary (light mode)
    pub tone_20: Color,  // on-primary (dark)
    pub tone_12: Color,  // surface_container_high (dark)
    pub tone_8: Color,   // surface_container_low (dark)
    pub tone_4: Color,   // surface_container_lowest (dark)
    pub tone_0: Color,   // Pure Black
}

impl TonalPalette {
    /// Generate a full Material 3 tonal palette from a seed color.
    pub fn from_seed(seed: Color) -> Self {
        let (hue, chroma, _) = rgb_to_hct(seed);

        Self {
            seed,
            tone_100: hct_to_rgb(hue, chroma * 0.1, 100.0),
            tone_96: hct_to_rgb(hue, chroma * 0.15, 96.0),
            tone_92: hct_to_rgb(hue, chroma * 0.20, 92.0),
            tone_90: hct_to_rgb(hue, chroma * 0.25, 90.0),
            tone_80: hct_to_rgb(hue, chroma * 0.90, 80.0),
            tone_40: hct_to_rgb(hue, chroma, 40.0),
            tone_20: hct_to_rgb(hue, chroma * 0.90, 20.0),
            tone_12: hct_to_rgb(hue, chroma * 0.25, 12.0),
            tone_8: hct_to_rgb(hue, chroma * 0.20, 8.0),
            tone_4: hct_to_rgb(hue, chroma * 0.15, 4.0),
            tone_0: hct_to_rgb(hue, chroma * 0.1, 0.0),
        }
    }
}

/// Convert sRGB to HCT (Hue in [0, 360], Chroma in [0, 120], Tone in [0, 100]).
pub fn rgb_to_hct(c: Color) -> (f32, f32, f32) {
    let r = srgb_to_linear(c.r);
    let g = srgb_to_linear(c.g);
    let b = srgb_to_linear(c.b);

    // CIE 1931 XYZ (D65)
    let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let x = 0.4124 * r + 0.3576 * g + 0.1805 * b;
    let z = 0.0193 * r + 0.1192 * g + 0.9505 * b;

    // Perceptual Tone L* (CIE LAB)
    let tone = if y > 216.0 / 24389.0 {
        116.0 * y.cbrt() - 16.0
    } else {
        (24389.0 / 27.0) * y
    };

    // LAB a*, b*
    let fx = lab_f(x / 0.95047);
    let fy = lab_f(y / 1.00000);
    let fz = lab_f(z / 1.08883);

    let a_star = 500.0 * (fx - fy);
    let b_star = 200.0 * (fy - fz);

    let chroma = (a_star * a_star + b_star * b_star).sqrt();
    let mut hue = b_star.atan2(a_star).to_degrees();
    if hue < 0.0 {
        hue += 360.0;
    }

    (hue, chroma.min(120.0), tone.clamp(0.0, 100.0))
}

/// Convert HCT back to Color.
pub fn hct_to_rgb(hue: f32, chroma: f32, tone: f32) -> Color {
    let tone = tone.clamp(0.0, 100.0);
    let chroma = chroma.max(0.0);
    let hue_rad = hue.to_radians();

    // From LAB
    let y = if tone > 8.0 {
        ((tone + 16.0) / 116.0).powi(3)
    } else {
        tone * (27.0 / 24389.0)
    };

    let a_star = chroma * hue_rad.cos();
    let b_star = chroma * hue_rad.sin();

    let fy = if y > 216.0 / 24389.0 {
        y.cbrt()
    } else {
        (24389.0 / 27.0) * y / 116.0 + 16.0 / 116.0
    };
    let fx = fy + a_star / 500.0;
    let fz = fy - b_star / 200.0;

    let x = lab_inv_f(fx) * 0.95047;
    let z = lab_inv_f(fz) * 1.08883;

    // Linear RGB
    let r_lin = 3.2406 * x - 1.5372 * y - 0.4986 * z;
    let g_lin = -0.9689 * x + 1.8758 * y + 0.0415 * z;
    let b_lin = 0.0557 * x - 0.2040 * y + 1.0570 * z;

    Color::rgb(
        linear_to_srgb(r_lin),
        linear_to_srgb(g_lin),
        linear_to_srgb(b_lin),
    )
}

#[inline]
fn lab_f(t: f32) -> f32 {
    if t > 216.0 / 24389.0 {
        t.cbrt()
    } else {
        (24389.0 / 27.0) * t / 116.0 + 16.0 / 116.0
    }
}

#[inline]
fn lab_inv_f(ft: f32) -> f32 {
    let ft3 = ft * ft * ft;
    if ft3 > 216.0 / 24389.0 {
        ft3
    } else {
        (116.0 * ft - 16.0) * (27.0 / 24389.0)
    }
}

#[inline]
fn srgb_to_linear(x: f32) -> f32 {
    let c = x.clamp(0.0, 1.0);
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

#[inline]
fn linear_to_srgb(x: f32) -> f32 {
    let c = x.clamp(0.0, 1.0);
    if c <= 0.0031308 {
        c * 12.92
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    }
}
