//! Design tokens for cross-platform OpenNote UI.
//!
//! Provides type-safe definitions for colors, corner radii, spacing, typography,
//! material layers (Liquid Glass), and spring motion physics.

use super::color::Color;
use serde::{Deserialize, Serialize};

/// Target platform style family.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum PlatformKind {
    /// Apple Human Interface Guidelines: Liquid Glass material, concentric squircles, editorial warmth.
    Apple,
    /// Android Material 3 Expressive: tonal surface ladders, shape contrast, spring physics with overshoot.
    Android,
}

/// Theme appearance variant.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ThemeVariant {
    Light,
    Dark,
}

/// Material layer properties for translucent floating chrome vs opaque content.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MaterialLayer {
    /// Whether this material behaves as Apple Liquid Glass (translucent blurred surface).
    pub is_liquid_glass: bool,
    /// Backdrop blur radius in logical pixels (24.0..32.0 for Apple floating chrome; 0.0 for opaque).
    pub backdrop_blur_px: f32,
    /// Specular inner border width in logical pixels (1.0 for Apple Liquid Glass; 0.0 for Android).
    pub specular_border_width: f32,
    /// Specular inner border color.
    pub specular_border_color: Color,
    /// Background fill tint of the floating chrome (translucent for Liquid Glass, tonal for Android).
    pub surface_fill: Color,
    /// Shadow blur and alpha (kept subtle and restrained).
    pub shadow_blur_px: f32,
    pub shadow_color: Color,
}

/// Semantic color palette adhering strictly to the redesign specification.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ColorTokens {
    /// Primary note canvas background (strictly opaque for legibility).
    /// Apple Light: #FAF9F6; Apple Dark: #161618.
    /// Android: surface_container_lowest (#FFFFFF light / #0F1115 dark).
    pub canvas_background: Color,

    /// Secondary background for lists and sidebars.
    /// Android: surface_container_low (#F4F6FA light / #171A21 dark).
    pub surface_background: Color,

    /// Elevated surface for floating pills, cards, modal sheets, and toolbars.
    /// Android: surface_container_high (#E8ECF4 light / #222630 dark).
    pub surface_elevated: Color,

    /// Primary text/ink color for headings and body content.
    /// Apple Light: #1D1D1F; Apple Dark: #F5F5F7.
    pub text_primary: Color,

    /// Secondary metadata text (timestamps, word counts, folder labels).
    /// Apple: #6E6E73.
    pub text_secondary: Color,

    /// Tertiary / muted placeholder text.
    pub text_muted: Color,

    /// Restrained semantic accent color for active icons, cursors, and primary selections.
    /// Apple: Warm Amber #D97706 or Apple Blue #007AFF.
    /// Android: Dynamic primary seed tone.
    pub accent: Color,

    /// Subtle background tint for selected items, hover states, and active pills.
    pub accent_subtle: Color,

    /// Floating chrome material configuration.
    pub floating_chrome: MaterialLayer,
}

/// Geometry and squircle corner radii in logical pixels (lp).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CornerRadii {
    /// Small elements: checkboxes, inline tags (4.0..6.0 lp).
    pub small: f32,
    /// Cards, sidebar items, and row selection pills (12.0 lp for Apple; 20.0..24.0 lp for Android).
    pub card: f32,
    /// Active list row floating pill (12.0 lp on Apple; morphing squircle on Android).
    pub row_pill: f32,
    /// Floating toolbars, popovers, and modal sheets (20.0..24.0 lp).
    pub toolbar_sheet: f32,
    /// Full capsule / squircle rounding (999.0 lp) for search inputs, action pills, and floating selection bar.
    pub capsule: f32,
    /// Android Expressive FAB: oversized rounded-square resting radius (16.0..20.0 lp).
    pub fab_resting: f32,
    /// Android Expressive FAB: pressed / morphing radius.
    pub fab_pressed: f32,
    /// Active filter chip / formatting button morphing radius (normal vs selected).
    pub chip_normal: f32,
    pub chip_selected: f32,
}

/// Spacing, dimensions, and reading column bounds.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SpacingTokens {
    /// Centered reading column maximum width: 680.0 lp.
    pub reading_column_max_width: f32,
    /// Horizontal padding on reading column: 24.0..48.0 lp.
    pub reading_column_padding_min_h: f32,
    pub reading_column_padding_max_h: f32,
    /// Paragraph bottom spacing margin: 14.0 lp.
    pub paragraph_margin_bottom: f32,
    /// Generous note list row height: 48.0..56.0 lp.
    pub list_row_height: f32,
    /// Horizontal inset for list rows so they float as rounded pills: 8.0 lp.
    pub list_row_inset_h: f32,
    /// Android card gap in list view: 12.0 lp.
    pub card_gap: f32,
    /// Standard vector icon size: 18.0..20.0 lp.
    pub icon_size: f32,
    /// Standard vector icon stroke width: 1.5 lp.
    pub icon_stroke_width: f32,
    /// Floating toolbar vertical offset from anchor: 8.0 lp.
    pub floating_toolbar_offset: f32,
}

/// Typography styling and scale.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TypographyTokens {
    /// UI chrome font family (SF Pro / Inter on Apple; Plus Jakarta Sans / Roboto Flex on Android).
    pub font_family_ui: String,
    /// Note title and body font family (New York / Newsreader / Lora serif, or humanist sans).
    pub font_family_body: String,
    /// Body text line-height multiplier: 1.65.
    pub line_height_body: f32,
    /// Heading line-height multiplier: 1.25.
    pub line_height_heading: f32,
    /// UI Chrome tracking: -0.01em on Apple.
    pub ui_tracking_em: f32,
    /// Display title size (28.0..32.0 sp).
    pub font_size_display: f32,
    /// Heading 1 size (24.0 sp).
    pub font_size_h1: f32,
    /// Heading 2 size (20.0 sp).
    pub font_size_h2: f32,
    /// Heading 3 size (17.0 sp).
    pub font_size_h3: f32,
    /// Body text size (15.0..16.0 sp).
    pub font_size_body: f32,
    /// Metadata / caption size (13.0 sp).
    pub font_size_caption: f32,
}

/// Spring motion physics configuration for fluid animations.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SpringConfig {
    /// Spring stiffness constant.
    pub stiffness: f32,
    /// Damping coefficient.
    pub damping: f32,
    /// Damping ratio (zeta).
    /// 1.0 = critically damped (no overshoot, Apple HIG standard).
    /// ~0.75 = underdamped (playful expressive bounce, Android M3 Expressive).
    pub damping_ratio: f32,
    /// Mass of moving UI element (default 1.0).
    pub mass: f32,
}

impl SpringConfig {
    /// Step the spring physics simulation from current position and velocity toward target.
    /// Returns (new_position, new_velocity, is_settled).
    pub fn step(
        &self,
        current_pos: f32,
        current_vel: f32,
        target_pos: f32,
        dt_seconds: f32,
    ) -> (f32, f32, bool) {
        let displacement = current_pos - target_pos;
        let spring_force = -self.stiffness * displacement;
        let damping_force = -self.damping * current_vel;
        let acceleration = (spring_force + damping_force) / self.mass.max(0.001);

        let new_vel = current_vel + acceleration * dt_seconds;
        let new_pos = current_pos + new_vel * dt_seconds;

        let settled = (new_pos - target_pos).abs() < 0.25 && new_vel.abs() < 0.5;
        if settled {
            (target_pos, 0.0, true)
        } else {
            (new_pos, new_vel, false)
        }
    }
}

/// Complete theme token bundle for a platform and appearance variant.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ThemeTokens {
    pub platform: PlatformKind,
    pub variant: ThemeVariant,
    pub colors: ColorTokens,
    pub radii: CornerRadii,
    pub spacing: SpacingTokens,
    pub typography: TypographyTokens,
    pub spring: SpringConfig,
}
