//! Android Target: Material 3 Expressive theme definitions.
//!
//! Features tonal elevation ladders (no divider borders), bold shape contrast,
//! oversized FABs with morphing corner radii, and playful spring motion with slight overshoot.

use super::color::Color;
use super::tokens::*;

impl ThemeTokens {
    /// Android (`target_os = "android"`) — Light Mode ("Material 3 Expressive").
    pub fn android_expressive_light() -> Self {
        Self {
            platform: PlatformKind::Android,
            variant: ThemeVariant::Light,
            colors: ColorTokens {
                // Tonal Surface Ladder: surface_container_lowest = #FFFFFF
                canvas_background: Color::from_hex("#FFFFFF").unwrap_or(Color::WHITE),
                // surface_container_low (Note List Background) = #F4F6FA
                surface_background: Color::from_hex("#F4F6FA")
                    .unwrap_or(Color::rgb(0.957, 0.965, 0.98)),
                // surface_container_high (Cards & Floating Toolbars) = #E8ECF4
                surface_elevated: Color::from_hex("#E8ECF4")
                    .unwrap_or(Color::rgb(0.91, 0.925, 0.957)),
                // Text primary
                text_primary: Color::from_hex("#191C20").unwrap_or(Color::rgb(0.098, 0.11, 0.125)),
                // Text secondary
                text_secondary: Color::from_hex("#43474E")
                    .unwrap_or(Color::rgb(0.263, 0.278, 0.306)),
                text_muted: Color::from_hex("#73777F").unwrap_or(Color::rgb(0.451, 0.467, 0.498)),
                // Expressive Primary Accent: M3 Indigo #2563EB or Deep Blue #005AC1
                accent: Color::from_hex("#005AC1").unwrap_or(Color::rgb(0.0, 0.353, 0.757)),
                accent_subtle: Color::from_hex("#D8E2FF").unwrap_or(Color::rgb(0.847, 0.886, 1.0)),
                floating_chrome: MaterialLayer {
                    is_liquid_glass: false,
                    backdrop_blur_px: 0.0, // Android uses pure tonal elevation, no backdrop blur
                    specular_border_width: 0.0, // Strictly NO divider/border lines
                    specular_border_color: Color::TRANSPARENT,
                    // surface_container_high
                    surface_fill: Color::from_hex("#E8ECF4")
                        .unwrap_or(Color::rgb(0.91, 0.925, 0.957)),
                    shadow_blur_px: 12.0,
                    shadow_color: Color::rgba(0.0, 0.0, 0.0, 0.10),
                },
            },
            radii: CornerRadii {
                small: 8.0,
                // Large soft rounding: 20.0..24.0 lp for note cards
                card: 22.0,
                row_pill: 16.0,
                toolbar_sheet: 24.0,
                capsule: 999.0,
                // Primary New Note FAB: oversized rounded-square (16.0..20.0 lp resting)
                fab_resting: 18.0,
                // Morphing on press
                fab_pressed: 28.0,
                // Active filter chips morphing from 8.0 lp to 16.0 lp
                chip_normal: 8.0,
                chip_selected: 16.0,
            },
            spacing: SpacingTokens {
                reading_column_max_width: 680.0,
                reading_column_padding_min_h: 24.0,
                reading_column_padding_max_h: 48.0,
                paragraph_margin_bottom: 14.0,
                list_row_height: 56.0,
                list_row_inset_h: 8.0,
                // 12.0 lp gap between cards in list view
                card_gap: 12.0,
                icon_size: 20.0,
                icon_stroke_width: 1.5,
                floating_toolbar_offset: 12.0,
            },
            typography: TypographyTokens {
                font_family_ui: "Plus Jakarta Sans, Roboto Flex, system-ui, sans-serif".into(),
                font_family_body: "Plus Jakarta Sans, Roboto Flex, system-ui, sans-serif".into(),
                line_height_body: 1.65,
                line_height_heading: 1.25,
                ui_tracking_em: 0.0,
                // Bold editorial scale: large display title (28.0..32.0 sp)
                font_size_display: 32.0,
                font_size_h1: 26.0,
                font_size_h2: 22.0,
                font_size_h3: 18.0,
                font_size_body: 16.0,
                font_size_caption: 13.0,
            },
            spring: SpringConfig {
                stiffness: 220.0,
                damping: 18.0,
                // Expressive spring transitions with slight overshoot (damping_ratio ~0.75)
                damping_ratio: 0.75,
                mass: 1.0,
            },
        }
    }

    /// Android (`target_os = "android"`) — Dark Mode ("Material 3 Expressive").
    pub fn android_expressive_dark() -> Self {
        Self {
            platform: PlatformKind::Android,
            variant: ThemeVariant::Dark,
            colors: ColorTokens {
                // Tonal Surface Ladder: surface_container_lowest = #0F1115
                canvas_background: Color::from_hex("#0F1115")
                    .unwrap_or(Color::rgb(0.059, 0.067, 0.082)),
                // surface_container_low = #171A21
                surface_background: Color::from_hex("#171A21")
                    .unwrap_or(Color::rgb(0.09, 0.102, 0.129)),
                // surface_container_high = #222630
                surface_elevated: Color::from_hex("#222630")
                    .unwrap_or(Color::rgb(0.133, 0.149, 0.188)),
                // Text primary
                text_primary: Color::from_hex("#E2E2E9").unwrap_or(Color::rgb(0.886, 0.886, 0.914)),
                // Text secondary
                text_secondary: Color::from_hex("#8D9199").unwrap_or(Color::rgb(0.553, 0.569, 0.6)),
                text_muted: Color::from_hex("#595D65").unwrap_or(Color::rgb(0.349, 0.365, 0.396)),
                // Expressive Primary Accent Dark: M3 Expressive Blue #A8C7FA
                accent: Color::from_hex("#A8C7FA").unwrap_or(Color::rgb(0.659, 0.78, 0.98)),
                accent_subtle: Color::from_hex("#004A98").unwrap_or(Color::rgb(0.0, 0.29, 0.596)),
                floating_chrome: MaterialLayer {
                    is_liquid_glass: false,
                    backdrop_blur_px: 0.0,
                    specular_border_width: 0.0,
                    specular_border_color: Color::TRANSPARENT,
                    // surface_container_high
                    surface_fill: Color::from_hex("#222630")
                        .unwrap_or(Color::rgb(0.133, 0.149, 0.188)),
                    shadow_blur_px: 16.0,
                    shadow_color: Color::rgba(0.0, 0.0, 0.0, 0.40),
                },
            },
            radii: CornerRadii {
                small: 8.0,
                card: 22.0,
                row_pill: 16.0,
                toolbar_sheet: 24.0,
                capsule: 999.0,
                fab_resting: 18.0,
                fab_pressed: 28.0,
                chip_normal: 8.0,
                chip_selected: 16.0,
            },
            spacing: SpacingTokens {
                reading_column_max_width: 680.0,
                reading_column_padding_min_h: 24.0,
                reading_column_padding_max_h: 48.0,
                paragraph_margin_bottom: 14.0,
                list_row_height: 56.0,
                list_row_inset_h: 8.0,
                card_gap: 12.0,
                icon_size: 20.0,
                icon_stroke_width: 1.5,
                floating_toolbar_offset: 12.0,
            },
            typography: TypographyTokens {
                font_family_ui: "Plus Jakarta Sans, Roboto Flex, system-ui, sans-serif".into(),
                font_family_body: "Plus Jakarta Sans, Roboto Flex, system-ui, sans-serif".into(),
                line_height_body: 1.65,
                line_height_heading: 1.25,
                ui_tracking_em: 0.0,
                font_size_display: 32.0,
                font_size_h1: 26.0,
                font_size_h2: 22.0,
                font_size_h3: 18.0,
                font_size_body: 16.0,
                font_size_caption: 13.0,
            },
            spring: SpringConfig {
                stiffness: 220.0,
                damping: 18.0,
                damping_ratio: 0.75,
                mass: 1.0,
            },
        }
    }
}
