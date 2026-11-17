//! Clean, custom-drawn vector checkboxes and bullet markers.
//!
//! Eliminates standard HTML form inputs in favor of GPU-rendered vector controls
//! with concentric squircle rounding and smooth SVG checkmarks.

use crate::theme::color::Color;
use crate::theme::tokens::*;
use serde::{Deserialize, Serialize};

/// Checkbox selection state.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CheckboxState {
    Unchecked,
    Checked,
    Indeterminate,
}

/// Custom-drawn vector checkbox.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct VectorCheckbox {
    pub state: CheckboxState,
    pub size: f32,          // standard 18.0 lp
    pub corner_radius: f32, // concentric squircle 5.0 lp
    pub stroke_width: f32,  // 1.5 lp
}

impl Default for VectorCheckbox {
    fn default() -> Self {
        Self {
            state: CheckboxState::Unchecked,
            size: 18.0,
            corner_radius: 5.0,
            stroke_width: 1.5,
        }
    }
}

impl VectorCheckbox {
    pub fn toggle(&mut self) {
        self.state = match self.state {
            CheckboxState::Unchecked => CheckboxState::Checked,
            CheckboxState::Checked => CheckboxState::Unchecked,
            CheckboxState::Indeterminate => CheckboxState::Checked,
        };
    }

    /// SVG path string for the checkmark when in Checked state.
    pub fn checkmark_svg_path(&self) -> &'static str {
        // Precise vector checkmark scaled for 18x18 box
        "M 4.5 9.5 L 7.5 12.5 L 13.5 5.5"
    }

    /// SVG path string for the dash when in Indeterminate state.
    pub fn indeterminate_svg_path(&self) -> &'static str {
        "M 5.0 9.0 L 13.0 9.0"
    }

    /// Colors for the checkbox box and check icon.
    pub fn colors(&self, tokens: &ThemeTokens) -> (Color, Color, Color) {
        // Returns (box_fill, box_stroke, icon_color)
        match self.state {
            CheckboxState::Unchecked => (
                Color::TRANSPARENT,
                tokens.colors.text_secondary,
                Color::TRANSPARENT,
            ),
            CheckboxState::Checked => (
                tokens.colors.accent,
                tokens.colors.accent,
                if tokens.variant == ThemeVariant::Light {
                    Color::WHITE
                } else {
                    Color::from_hex("#161618").unwrap_or(Color::BLACK)
                },
            ),
            CheckboxState::Indeterminate => (
                tokens.colors.accent_subtle,
                tokens.colors.accent,
                tokens.colors.accent,
            ),
        }
    }
}

/// Custom-drawn bullet markers for unordered and ordered lists.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum BulletStyle {
    /// Solid circular disc (level 0).
    Disc,
    /// Hollow ring / circle (level 1).
    Circle,
    /// Rounded squircle square (level 2).
    Square,
    /// Ordered numeric list.
    Number(usize),
}

/// Bullet marker layout and vector geometry.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct VectorBullet {
    pub style: BulletStyle,
    pub size: f32,
    pub x: f32,
    pub y: f32,
}

impl VectorBullet {
    pub fn for_level(level: usize, y_center: f32, x_start: f32) -> Self {
        let style = match level % 3 {
            0 => BulletStyle::Disc,
            1 => BulletStyle::Circle,
            _ => BulletStyle::Square,
        };
        let size = match style {
            BulletStyle::Disc => 6.0,
            BulletStyle::Circle => 6.0,
            BulletStyle::Square => 5.0,
            BulletStyle::Number(_) => 14.0,
        };
        Self {
            style,
            size,
            x: x_start,
            y: y_center,
        }
    }

    pub fn for_number(number: usize, y_center: f32, x_start: f32) -> Self {
        Self {
            style: BulletStyle::Number(number),
            size: 14.0,
            x: x_start,
            y: y_center,
        }
    }

    /// Color of the bullet marker.
    pub fn color(&self, tokens: &ThemeTokens) -> Color {
        tokens.colors.text_secondary
    }
}
