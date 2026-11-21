//! Apple Human Interface Guidelines: Liquid Glass & Craft theme definitions.

use super::color::Color;
use super::tokens::*;

impl ThemeTokens {
    /// Apple Platforms (macOS & iOS) — Light Mode ("Liquid Glass & Craft").
    pub fn apple_light() -> Self {
        Self {
            platform: PlatformKind::Apple,
            variant: ThemeVariant::Light,
            colors: ColorTokens {
                // Content Layer strictly opaque for maximum legibility: warm paper #FAF9F6
                canvas_background: Color::from_hex("#FAF9F6")
                    .unwrap_or(Color::rgb(0.98, 0.976, 0.965)),
                // Subtle warm off-white for sidebars / lists
                surface_background: Color::from_hex("#F3F2EE")
                    .unwrap_or(Color::rgb(0.953, 0.949, 0.933)),
                // Elevated surface
                surface_elevated: Color::from_hex("#FFFFFF").unwrap_or(Color::WHITE),
                // Primary high-craft ink #1D1D1F
                text_primary: Color::from_hex("#1D1D1F").unwrap_or(Color::rgb(0.114, 0.114, 0.122)),
                // Secondary metadata #6E6E73
                text_secondary: Color::from_hex("#6E6E73")
                    .unwrap_or(Color::rgb(0.431, 0.431, 0.451)),
                // Muted caption
                text_muted: Color::from_hex("#8E8E93").unwrap_or(Color::rgb(0.557, 0.557, 0.576)),
                // Restrained Warm Amber accent #D97706 (optional Apple Blue #007AFF)
                accent: Color::from_hex("#D97706").unwrap_or(Color::rgb(0.851, 0.467, 0.024)),
                // Subtle translucent amber tint for selected pills
                accent_subtle: Color::rgba(0.851, 0.467, 0.024, 0.12),
                floating_chrome: MaterialLayer {
                    is_liquid_glass: true,
                    backdrop_blur_px: 28.0,
                    specular_border_width: 1.0,
                    // Subtle specular inner border rgba(255, 255, 255, 0.22)
                    specular_border_color: Color::rgba(1.0, 1.0, 1.0, 0.22),
                    surface_fill: Color::rgba(0.98, 0.976, 0.965, 0.78),
                    shadow_blur_px: 18.0,
                    shadow_color: Color::rgba(0.0, 0.0, 0.0, 0.07),
                },
            },
            radii: CornerRadii {
                small: 6.0,
                card: 12.0,
                row_pill: 12.0,
                toolbar_sheet: 22.0,
                capsule: 999.0,
                fab_resting: 16.0,
                fab_pressed: 20.0,
                chip_normal: 10.0,
                chip_selected: 12.0,
            },
            spacing: SpacingTokens {
                reading_column_max_width: 680.0,
                reading_column_padding_min_h: 24.0,
                reading_column_padding_max_h: 48.0,
                paragraph_margin_bottom: 14.0,
                list_row_height: 52.0,
                list_row_inset_h: 8.0,
                card_gap: 8.0,
                icon_size: 19.0,
                icon_stroke_width: 1.5,
                floating_toolbar_offset: 8.0,
            },
            typography: TypographyTokens {
                font_family_ui: "SF Pro, Inter, system-ui, sans-serif".into(),
                font_family_body: "New York, Newsreader, Lora, Georgia, serif".into(),
                line_height_body: 1.65,
                line_height_heading: 1.25,
                ui_tracking_em: -0.01,
                font_size_display: 30.0,
                font_size_h1: 24.0,
                font_size_h2: 20.0,
                font_size_h3: 17.0,
                font_size_body: 16.0,
                font_size_caption: 13.0,
            },
            spring: SpringConfig {
                stiffness: 300.0,
                damping: 28.0,
                damping_ratio: 1.0, // critically damped
                mass: 1.0,
            },
        }
    }

    /// Apple Platforms (macOS & iOS) — Dark Mode ("Liquid Glass & Craft").
    pub fn apple_dark() -> Self {
        Self {
            platform: PlatformKind::Apple,
            variant: ThemeVariant::Dark,
            colors: ColorTokens {
                // Content Layer strictly opaque: deep warm charcoal #161618
                canvas_background: Color::from_hex("#161618")
                    .unwrap_or(Color::rgb(0.086, 0.086, 0.094)),
                // Elevated charcoal
                surface_background: Color::from_hex("#1C1C1E")
                    .unwrap_or(Color::rgb(0.11, 0.11, 0.118)),
                surface_elevated: Color::from_hex("#2C2C2E")
                    .unwrap_or(Color::rgb(0.173, 0.173, 0.18)),
                // Primary ink #F5F5F7
                text_primary: Color::from_hex("#F5F5F7").unwrap_or(Color::rgb(0.96, 0.96, 0.969)),
                // Secondary metadata #6E6E73 (or lightened for dark #8E8E93)
                text_secondary: Color::from_hex("#8E8E93")
                    .unwrap_or(Color::rgb(0.557, 0.557, 0.576)),
                text_muted: Color::from_hex("#636366").unwrap_or(Color::rgb(0.388, 0.388, 0.4)),
                // Warm Amber accent #F59E0B in dark mode
                accent: Color::from_hex("#F59E0B").unwrap_or(Color::rgb(0.961, 0.62, 0.043)),
                accent_subtle: Color::rgba(0.961, 0.62, 0.043, 0.16),
                floating_chrome: MaterialLayer {
                    is_liquid_glass: true,
                    backdrop_blur_px: 30.0,
                    specular_border_width: 1.0,
                    // Subtle specular inner border rgba(255, 255, 255, 0.08)
                    specular_border_color: Color::rgba(1.0, 1.0, 1.0, 0.08),
                    surface_fill: Color::rgba(0.086, 0.086, 0.094, 0.76),
                    shadow_blur_px: 24.0,
                    shadow_color: Color::rgba(0.0, 0.0, 0.0, 0.35),
                },
            },
            radii: CornerRadii {
                small: 6.0,
                card: 12.0,
                row_pill: 12.0,
                toolbar_sheet: 22.0,
                capsule: 999.0,
                fab_resting: 16.0,
                fab_pressed: 20.0,
                chip_normal: 10.0,
                chip_selected: 12.0,
            },
            spacing: SpacingTokens {
                reading_column_max_width: 680.0,
                reading_column_padding_min_h: 24.0,
                reading_column_padding_max_h: 48.0,
                paragraph_margin_bottom: 14.0,
                list_row_height: 52.0,
                list_row_inset_h: 8.0,
                card_gap: 8.0,
                icon_size: 19.0,
                icon_stroke_width: 1.5,
                floating_toolbar_offset: 8.0,
            },
            typography: TypographyTokens {
                font_family_ui: "SF Pro, Inter, system-ui, sans-serif".into(),
                font_family_body: "New York, Newsreader, Lora, Georgia, serif".into(),
                line_height_body: 1.65,
                line_height_heading: 1.25,
                ui_tracking_em: -0.01,
                font_size_display: 30.0,
                font_size_h1: 24.0,
                font_size_h2: 20.0,
                font_size_h3: 17.0,
                font_size_body: 16.0,
                font_size_caption: 13.0,
            },
            spring: SpringConfig {
                stiffness: 300.0,
                damping: 28.0,
                damping_ratio: 1.0,
                mass: 1.0,
            },
        }
    }
}
