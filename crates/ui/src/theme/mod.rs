//! Theming module: design tokens, Apple Liquid Glass, Android Material 3 Expressive,
//! HCT dynamic tonal palette generator, and PlatformStyle provider.

pub mod android;
pub mod apple;
pub mod color;
pub mod hct;
pub mod provider;
pub mod tokens;

pub use color::Color;
pub use hct::{hct_to_rgb, rgb_to_hct, TonalPalette};
pub use provider::{PlatformStyle, ThemeProvider};
pub use tokens::{
    ColorTokens, CornerRadii, MaterialLayer, PlatformKind, SpacingTokens, SpringConfig,
    ThemeTokens, ThemeVariant, TypographyTokens,
};
