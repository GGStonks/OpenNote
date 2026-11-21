//! OpenNote Cross-Platform Native UI Architecture & Redesign.
//!
//! Provides fluid, modern native UI components, Apple Liquid Glass material layers,
//! Android Material 3 Expressive tonal elevation ladders, responsive centered reading
//! column layouts, selection-triggered floating formatting bars, and clean vector controls.

#![allow(clippy::all)]
pub mod formatting;
pub mod icons;
pub mod layout;
pub mod theme;

pub use formatting::{
    BulletStyle, CheckboxState, FloatingSelectionPill, FormatAction, SlashCommandItem,
    SlashCommandKind, SlashCommandPopover, TextSelection, VectorBullet, VectorCheckbox,
};
pub use icons::{get_icon, VectorIcon};
pub use layout::{
    BottomBarGeometry, FabGeometry, LayoutMode, LayoutShell, ReadingColumnGeometry, ShellGeometry,
    SidebarState,
};
pub use theme::{
    hct_to_rgb, rgb_to_hct, Color, ColorTokens, CornerRadii, MaterialLayer, PlatformKind,
    PlatformStyle, SpacingTokens, SpringConfig, ThemeProvider, ThemeTokens, ThemeVariant,
    TonalPalette, TypographyTokens,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_apple_light_tokens() {
        let t = ThemeTokens::apple_light();
        assert_eq!(t.platform, PlatformKind::Apple);
        assert_eq!(t.variant, ThemeVariant::Light);

        // Opaque warm paper canvas: #FAF9F6
        assert_eq!(t.colors.canvas_background.to_hex(), "#faf9f6");
        // Primary high-craft ink: #1D1D1F
        assert_eq!(t.colors.text_primary.to_hex(), "#1d1d1f");
        // Secondary metadata: #6E6E73
        assert_eq!(t.colors.text_secondary.to_hex(), "#6e6e73");
        // Warm Amber accent: #D97706
        assert_eq!(t.colors.accent.to_hex(), "#d97706");

        // Liquid Glass material layer
        assert!(t.colors.floating_chrome.is_liquid_glass);
        assert_eq!(t.colors.floating_chrome.backdrop_blur_px, 28.0);
        assert_eq!(t.colors.floating_chrome.specular_border_width, 1.0);
        assert!((t.colors.floating_chrome.specular_border_color.a - 0.22).abs() < 0.01);

        // Concentric squircle radii
        assert_eq!(t.radii.card, 12.0);
        assert_eq!(t.radii.row_pill, 12.0);
        assert_eq!(t.radii.capsule, 999.0);

        // Centered reading column bounds & spacing
        assert_eq!(t.spacing.reading_column_max_width, 680.0);
        assert_eq!(t.spacing.paragraph_margin_bottom, 14.0);
        assert_eq!(t.spacing.list_row_inset_h, 8.0);

        // Line-height multipliers
        assert_eq!(t.typography.line_height_body, 1.65);
        assert_eq!(t.typography.line_height_heading, 1.25);
        assert_eq!(t.typography.ui_tracking_em, -0.01);

        // Critically damped spring physics (damping ratio = 1.0)
        assert_eq!(t.spring.damping_ratio, 1.0);
        assert_eq!(t.spring.stiffness, 300.0);
    }

    #[test]
    fn test_apple_dark_tokens() {
        let t = ThemeTokens::apple_dark();
        assert_eq!(t.platform, PlatformKind::Apple);
        assert_eq!(t.variant, ThemeVariant::Dark);

        // Deep warm charcoal canvas: #161618
        assert_eq!(t.colors.canvas_background.to_hex(), "#161618");
        // Primary text: #F5F5F7
        assert_eq!(t.colors.text_primary.to_hex(), "#f5f5f7");
        // Specular inner border in dark mode: rgba(255, 255, 255, 0.08)
        assert!((t.colors.floating_chrome.specular_border_color.a - 0.08).abs() < 0.01);
    }

    #[test]
    fn test_android_expressive_light_tokens() {
        let t = ThemeTokens::android_expressive_light();
        assert_eq!(t.platform, PlatformKind::Android);
        assert_eq!(t.variant, ThemeVariant::Light);

        // Tonal Surface Ladder: lowest=#FFFFFF, low=#F4F6FA, high=#E8ECF4
        assert_eq!(t.colors.canvas_background.to_hex(), "#ffffff");
        assert_eq!(t.colors.surface_background.to_hex(), "#f4f6fa");
        assert_eq!(t.colors.surface_elevated.to_hex(), "#e8ecf4");

        // Strictly NO divider lines / border lines
        assert_eq!(t.colors.floating_chrome.specular_border_width, 0.0);
        assert!(!t.colors.floating_chrome.is_liquid_glass);

        // Expressive Shape Contrast: cards 22.0 lp, gap 12.0 lp, FAB 18.0 lp
        assert_eq!(t.radii.card, 22.0);
        assert_eq!(t.spacing.card_gap, 12.0);
        assert_eq!(t.radii.fab_resting, 18.0);
        assert_eq!(t.radii.chip_normal, 8.0);
        assert_eq!(t.radii.chip_selected, 16.0);

        // Expressive spring physics with slight overshoot (damping_ratio ~0.75)
        assert_eq!(t.spring.damping_ratio, 0.75);
    }

    #[test]
    fn test_android_expressive_dark_tokens() {
        let t = ThemeTokens::android_expressive_dark();
        assert_eq!(t.platform, PlatformKind::Android);
        assert_eq!(t.variant, ThemeVariant::Dark);

        // Tonal Surface Ladder Dark: lowest=#0F1115, low=#171A21, high=#222630
        assert_eq!(t.colors.canvas_background.to_hex(), "#0f1115");
        assert_eq!(t.colors.surface_background.to_hex(), "#171a21");
        assert_eq!(t.colors.surface_elevated.to_hex(), "#222630");
        assert_eq!(t.colors.text_primary.to_hex(), "#e2e2e9");
    }

    #[test]
    fn test_hct_tonal_palette_generation() {
        let seed = Color::from_hex("#2563EB").unwrap(); // Blue seed
        let palette = TonalPalette::from_seed(seed);

        // Tone 100 should be near pure white
        assert!(
            palette.tone_100.r > 0.95 && palette.tone_100.g > 0.95 && palette.tone_100.b > 0.95
        );
        // Tone 4 should be deep near-black surface_container_lowest
        assert!(palette.tone_4.r < 0.15 && palette.tone_4.g < 0.15 && palette.tone_4.b < 0.15);
        // Tone 40 should be richer than tone 90
        assert!(palette.tone_40.b > palette.tone_40.r);
    }

    #[test]
    fn test_layout_shell_desktop_centered_reading_column() {
        let tokens = ThemeTokens::apple_light();
        let shell = LayoutShell::new(1440.0, 900.0);

        assert_eq!(
            shell.compute_geometry(&tokens).layout_mode,
            LayoutMode::Desktop
        );

        let geom = shell.compute_geometry(&tokens);
        // Reading column width must never exceed 680.0 lp
        assert_eq!(geom.reading_column.width, 680.0);
        // Reading column must be centered in available space
        let sidebar_w = shell.sidebar.current_width;
        let expected_x = sidebar_w + (1440.0 - sidebar_w - 680.0) / 2.0;
        assert_eq!(geom.reading_column.x, expected_x);
        assert!(geom.sidebar_bounds.is_some());
        assert!(geom.bottom_bar.is_none());
    }

    #[test]
    fn test_layout_shell_mobile_apple() {
        let tokens = ThemeTokens::apple_light();
        let shell = LayoutShell::new(390.0, 844.0); // iPhone 14/15 viewport

        let geom = shell.compute_geometry(&tokens);
        assert_eq!(geom.layout_mode, LayoutMode::Mobile);
        assert!(geom.sidebar_bounds.is_none());

        // Floating Liquid Glass bottom action capsule pill
        let bar = geom
            .bottom_bar
            .expect("Apple mobile should have bottom action pill");
        assert!(bar.is_liquid_glass);
        assert_eq!(bar.height, 56.0);
        assert_eq!(bar.corner_radius, 999.0);
        assert!(geom.fab.is_none());
    }

    #[test]
    fn test_layout_shell_mobile_android() {
        let tokens = ThemeTokens::android_expressive_light();
        let shell = LayoutShell::new(412.0, 915.0); // Pixel 7/8 viewport

        let geom = shell.compute_geometry(&tokens);
        assert_eq!(geom.layout_mode, LayoutMode::Mobile);

        // Tonal floating toolbar + Expressive FAB
        let bar = geom
            .bottom_bar
            .expect("Android mobile should have tonal bottom bar");
        assert!(!bar.is_liquid_glass);
        assert_eq!(bar.height, 64.0);

        let fab = geom.fab.expect("Android mobile should have expressive FAB");
        assert_eq!(fab.size, 56.0);
        assert_eq!(fab.corner_radius, 18.0);
    }

    #[test]
    fn test_floating_selection_pill_visibility() {
        let tokens = ThemeTokens::apple_light();
        let mut pill = FloatingSelectionPill::default();

        // 1. Initially hidden
        assert!(!pill.is_visible);

        // 2. Empty selection does NOT trigger pill
        let empty_sel = TextSelection {
            start: 10,
            end: 10,
            bounds: [100.0, 200.0, 0.0, 20.0],
        };
        pill.update_selection(Some(&empty_sel), 1200.0, 800.0, &tokens);
        assert!(!pill.is_visible);

        // 3. Active selection (len > 0) triggers floating pill
        let active_sel = TextSelection {
            start: 10,
            end: 25,
            bounds: [200.0, 300.0, 150.0, 24.0],
        };
        pill.update_selection(Some(&active_sel), 1200.0, 800.0, &tokens);
        assert!(pill.is_visible);
        assert_eq!(pill.bounds[3], 40.0); // height 40 lp
                                          // Positioned above selection (300 - 40 - 8 = 252)
        assert_eq!(pill.bounds[1], 252.0);

        // 4. Clearing selection dismisses pill
        pill.update_selection(None, 1200.0, 800.0, &tokens);
        assert!(!pill.is_visible);
    }

    #[test]
    fn test_slash_command_popover_workflow() {
        let tokens = ThemeTokens::apple_light();
        let mut popover = SlashCommandPopover::default();

        popover.open_at(150.0, 220.0, 1000.0, 800.0, &tokens);
        assert!(popover.is_open);
        assert_eq!(popover.filtered_items().len(), 10);

        // Filter query "math"
        popover.query = "math".into();
        let filtered = popover.filtered_items();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].kind, SlashCommandKind::MathFormula);

        let committed = popover.commit_selection();
        assert_eq!(committed, Some(SlashCommandKind::MathFormula));
        assert!(!popover.is_open);
    }

    #[test]
    fn test_vector_controls() {
        let tokens = ThemeTokens::apple_light();
        let mut cb = VectorCheckbox::default();
        assert_eq!(cb.state, CheckboxState::Unchecked);

        let (fill, stroke, icon) = cb.colors(&tokens);
        assert_eq!(fill, Color::TRANSPARENT);
        assert_eq!(stroke.to_hex(), "#6e6e73");
        assert_eq!(icon, Color::TRANSPARENT);

        cb.toggle();
        assert_eq!(cb.state, CheckboxState::Checked);
        let (fill_checked, _, icon_checked) = cb.colors(&tokens);
        assert_eq!(fill_checked.to_hex(), "#d97706"); // Apple Warm Amber
        assert_eq!(icon_checked, Color::WHITE);
        assert!(!cb.checkmark_svg_path().is_empty());

        let bullet0 = VectorBullet::for_level(0, 100.0, 50.0);
        assert_eq!(bullet0.style, BulletStyle::Disc);
        let bullet1 = VectorBullet::for_level(1, 120.0, 50.0);
        assert_eq!(bullet1.style, BulletStyle::Circle);
    }

    #[test]
    fn test_spring_physics() {
        let spring = SpringConfig {
            stiffness: 300.0,
            damping: 28.0,
            damping_ratio: 1.0,
            mass: 1.0,
        };

        let mut pos = 0.0;
        let mut vel = 0.0;
        let target = 100.0;
        let dt = 1.0 / 60.0;

        for _ in 0..120 {
            let (new_pos, new_vel, settled) = spring.step(pos, vel, target, dt);
            pos = new_pos;
            vel = new_vel;
            if settled {
                break;
            }
        }

        assert!((pos - 100.0).abs() < 0.5);
    }
}
