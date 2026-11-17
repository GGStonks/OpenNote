//! Type-safe, serializable UI Color type with hex parsing, formatting, and blending.

use renderer::color::Rgba;
use serde::{Deserialize, Serialize};

/// High-precision RGBA color for UI surfaces, text, borders, and materials.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Color {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

impl Color {
    pub const WHITE: Self = Self { r: 1.0, g: 1.0, b: 1.0, a: 1.0 };
    pub const BLACK: Self = Self { r: 0.0, g: 0.0, b: 0.0, a: 1.0 };
    pub const TRANSPARENT: Self = Self { r: 0.0, g: 0.0, b: 0.0, a: 0.0 };

    pub const fn new(r: f32, g: f32, b: f32, a: f32) -> Self {
        Self { r, g, b, a }
    }

    pub const fn rgb(r: f32, g: f32, b: f32) -> Self {
        Self { r, g, b, a: 1.0 }
    }

    pub const fn rgba(r: f32, g: f32, b: f32, a: f32) -> Self {
        Self { r, g, b, a }
    }

    pub fn with_alpha(mut self, a: f32) -> Self {
        self.a = a.clamp(0.0, 1.0);
        self
    }

    /// Parse hex color like "#FAF9F6", "#161618", or "#FFF".
    pub fn from_hex(s: &str) -> Option<Self> {
        let s = s.trim();
        let hex = s.strip_prefix('#').unwrap_or(s);
        if hex.len() == 6 {
            let r = u8::from_str_radix(&hex[0..2], 16).ok()? as f32 / 255.0;
            let g = u8::from_str_radix(&hex[2..4], 16).ok()? as f32 / 255.0;
            let b = u8::from_str_radix(&hex[4..6], 16).ok()? as f32 / 255.0;
            Some(Self::rgb(r, g, b))
        } else if hex.len() == 8 {
            let r = u8::from_str_radix(&hex[0..2], 16).ok()? as f32 / 255.0;
            let g = u8::from_str_radix(&hex[2..4], 16).ok()? as f32 / 255.0;
            let b = u8::from_str_radix(&hex[4..6], 16).ok()? as f32 / 255.0;
            let a = u8::from_str_radix(&hex[6..8], 16).ok()? as f32 / 255.0;
            Some(Self::rgba(r, g, b, a))
        } else if hex.len() == 3 {
            let r = (u8::from_str_radix(&hex[0..1], 16).ok()? * 17) as f32 / 255.0;
            let g = (u8::from_str_radix(&hex[1..2], 16).ok()? * 17) as f32 / 255.0;
            let b = (u8::from_str_radix(&hex[2..3], 16).ok()? * 17) as f32 / 255.0;
            Some(Self::rgb(r, g, b))
        } else {
            None
        }
    }

    /// Format as lowercase #rrggbb hex string.
    pub fn to_hex(&self) -> String {
        let r = (self.r.clamp(0.0, 1.0) * 255.0).round() as u8;
        let g = (self.g.clamp(0.0, 1.0) * 255.0).round() as u8;
        let b = (self.b.clamp(0.0, 1.0) * 255.0).round() as u8;
        format!("#{:02x}{:02x}{:02x}", r, g, b)
    }

    /// Format as rgba(...) CSS / shader string.
    pub fn to_rgba_string(&self) -> String {
        let r = (self.r.clamp(0.0, 1.0) * 255.0).round() as u8;
        let g = (self.g.clamp(0.0, 1.0) * 255.0).round() as u8;
        let b = (self.b.clamp(0.0, 1.0) * 255.0).round() as u8;
        format!("rgba({}, {}, {}, {:.2})", r, g, b, self.a)
    }
}

impl From<Rgba> for Color {
    fn from(c: Rgba) -> Self {
        Self {
            r: c.r,
            g: c.g,
            b: c.b,
            a: c.a,
        }
    }
}

impl From<Color> for Rgba {
    fn from(c: Color) -> Self {
        Rgba::new(c.r, c.g, c.b, c.a)
    }
}
