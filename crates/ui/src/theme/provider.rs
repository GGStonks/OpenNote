//! Platform style trait and theme provider.
//!
//! Handles compile-time target switching with runtime preview override support.

use super::tokens::*;

/// Trait providing platform-specific styling decisions.
pub trait PlatformStyle {
    /// Return the active theme tokens.
    fn tokens(&self) -> &ThemeTokens;

    /// Whether this platform uses Apple Liquid Glass translucent floating chrome.
    fn is_liquid_glass(&self) -> bool {
        self.tokens().colors.floating_chrome.is_liquid_glass
    }

    /// Calculate the reading column width based on total viewport width.
    fn reading_column_width(&self, available_width: f32) -> f32 {
        let max_w = self.tokens().spacing.reading_column_max_width;
        let pad = self.tokens().spacing.reading_column_padding_min_h * 2.0;
        (available_width - pad).min(max_w).max(280.0)
    }

    /// Return corner radius for cards and floating sidebars.
    fn card_radius(&self) -> f32 {
        self.tokens().radii.card
    }

    /// Return corner radius for floating action pills.
    fn capsule_radius(&self) -> f32 {
        self.tokens().radii.capsule
    }
}

/// Dynamic Theme Provider with runtime platform and variant switching.
#[derive(Clone, Debug)]
pub struct ThemeProvider {
    tokens: ThemeTokens,
    runtime_override: Option<PlatformKind>,
}

impl Default for ThemeProvider {
    fn default() -> Self {
        Self::new(false)
    }
}

impl ThemeProvider {
    /// Create a new ThemeProvider adhering to compile-time target OS or default.
    pub fn new(dark: bool) -> Self {
        let tokens = Self::default_for_target(dark);
        Self {
            tokens,
            runtime_override: None,
        }
    }

    /// Determine default tokens via target_os cfg attributes.
    pub fn default_for_target(dark: bool) -> ThemeTokens {
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        {
            if dark {
                ThemeTokens::apple_dark()
            } else {
                ThemeTokens::apple_light()
            }
        }

        #[cfg(target_os = "android")]
        {
            if dark {
                ThemeTokens::android_expressive_dark()
            } else {
                ThemeTokens::android_expressive_light()
            }
        }

        #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
        {
            // Default desktop preview uses Apple Liquid Glass & Craft
            if dark {
                ThemeTokens::apple_dark()
            } else {
                ThemeTokens::apple_light()
            }
        }
    }

    /// Set runtime preview override (e.g. preview Android Material 3 on iOS or macOS).
    pub fn set_preview_platform(&mut self, platform: Option<PlatformKind>, dark: bool) {
        self.runtime_override = platform;
        match platform {
            Some(PlatformKind::Apple) => {
                self.tokens = if dark {
                    ThemeTokens::apple_dark()
                } else {
                    ThemeTokens::apple_light()
                };
            }
            Some(PlatformKind::Android) => {
                self.tokens = if dark {
                    ThemeTokens::android_expressive_dark()
                } else {
                    ThemeTokens::android_expressive_light()
                };
            }
            None => {
                self.tokens = Self::default_for_target(dark);
            }
        }
    }

    /// Toggle or set dark mode variant.
    pub fn set_dark_mode(&mut self, dark: bool) {
        let current_platform = self.tokens.platform;
        self.tokens = match current_platform {
            PlatformKind::Apple => {
                if dark {
                    ThemeTokens::apple_dark()
                } else {
                    ThemeTokens::apple_light()
                }
            }
            PlatformKind::Android => {
                if dark {
                    ThemeTokens::android_expressive_dark()
                } else {
                    ThemeTokens::android_expressive_light()
                }
            }
        };
    }

    /// Get current active platform kind.
    pub fn active_platform(&self) -> PlatformKind {
        self.tokens.platform
    }

    /// Get current active theme variant.
    pub fn active_variant(&self) -> ThemeVariant {
        self.tokens.variant
    }
}

impl PlatformStyle for ThemeProvider {
    fn tokens(&self) -> &ThemeTokens {
        &self.tokens
    }
}
