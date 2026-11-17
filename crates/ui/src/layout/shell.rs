//! Fluid, responsive layout shell for Desktop, Tablet, and Mobile.
//!
//! Eliminates rigid top ribbons, 1px divider lines, and edge-to-edge stretched text.
//! Implements a centered 680 lp reading column, collapsible floating sidebars,
//! and platform-adaptive bottom navigation / expressive action bars.

use crate::theme::tokens::*;
use serde::{Deserialize, Serialize};

/// Breakpoint layout mode based on viewport dimensions.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum LayoutMode {
    /// Wide desktop display (>= 1024 lp): collapsible floating sidebar + centered reading column.
    Desktop,
    /// Tablet display (640 lp..1023 lp): collapsible floating drawer + centered reading column.
    Tablet,
    /// Mobile phone display (< 640 lp): edge-to-edge note feed with floating bottom action pill / FAB.
    Mobile,
}

impl LayoutMode {
    pub fn from_width(width: f32) -> Self {
        if width >= 1024.0 {
            Self::Desktop
        } else if width >= 640.0 {
            Self::Tablet
        } else {
            Self::Mobile
        }
    }
}

/// Floating sidebar animation and layout state.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SidebarState {
    pub is_collapsed: bool,
    pub target_width: f32,
    pub current_width: f32,
    pub velocity: f32,
    pub is_animating: bool,
    pub expanded_width: f32,
}

impl Default for SidebarState {
    fn default() -> Self {
        Self {
            is_collapsed: false,
            target_width: 280.0,
            current_width: 280.0,
            velocity: 0.0,
            is_animating: false,
            expanded_width: 280.0,
        }
    }
}

impl SidebarState {
    /// Toggle collapsed state with spring physics.
    pub fn toggle(&mut self) {
        self.set_collapsed(!self.is_collapsed);
    }

    pub fn set_collapsed(&mut self, collapsed: bool) {
        self.is_collapsed = collapsed;
        self.target_width = if collapsed { 0.0 } else { self.expanded_width };
        self.is_animating = (self.current_width - self.target_width).abs() > 0.5;
    }

    /// Advance spring animation by dt seconds.
    pub fn step_spring(&mut self, spring: &SpringConfig, dt: f32) {
        if !self.is_animating {
            return;
        }

        let (new_pos, new_vel, settled) =
            spring.step(self.current_width, self.velocity, self.target_width, dt);

        self.current_width = new_pos.max(0.0);
        self.velocity = new_vel;
        if settled {
            self.current_width = self.target_width;
            self.velocity = 0.0;
            self.is_animating = false;
        }
    }
}

/// Geometry of the centered distraction-free reading column.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReadingColumnGeometry {
    /// Left horizontal offset in logical pixels.
    pub x: f32,
    /// Width of the reading column (strictly <= 680.0 lp).
    pub width: f32,
    /// Left and right inner content padding.
    pub padding_h: f32,
    /// Usable inner text width.
    pub text_width: f32,
}

/// Floating bottom navigation or action bar geometry.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct BottomBarGeometry {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub corner_radius: f32,
    pub is_liquid_glass: bool,
}

/// Expressive Floating Action Button (FAB) geometry for Android.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct FabGeometry {
    pub x: f32,
    pub y: f32,
    pub size: f32,
    pub corner_radius: f32,
}

/// Calculated geometry for all primary shell components.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ShellGeometry {
    pub layout_mode: LayoutMode,
    pub viewport_width: f32,
    pub viewport_height: f32,
    pub sidebar_bounds: Option<[f32; 4]>, // [x, y, w, h]
    pub reading_column: ReadingColumnGeometry,
    pub bottom_bar: Option<BottomBarGeometry>,
    pub fab: Option<FabGeometry>,
}

/// Layout shell coordinator.
#[derive(Clone, Debug)]
pub struct LayoutShell {
    pub viewport_width: f32,
    pub viewport_height: f32,
    pub sidebar: SidebarState,
}

impl LayoutShell {
    pub fn new(viewport_width: f32, viewport_height: f32) -> Self {
        let mode = LayoutMode::from_width(viewport_width);
        let mut sidebar = SidebarState::default();
        if mode == LayoutMode::Mobile {
            // On mobile, sidebar starts collapsed
            sidebar.set_collapsed(true);
            sidebar.current_width = 0.0;
            sidebar.is_animating = false;
        }

        Self {
            viewport_width,
            viewport_height,
            sidebar,
        }
    }

    /// Resize viewport and adjust responsive state.
    pub fn resize(&mut self, width: f32, height: f32) {
        self.viewport_width = width;
        self.viewport_height = height;
        if LayoutMode::from_width(width) == LayoutMode::Mobile && !self.sidebar.is_collapsed {
            self.sidebar.set_collapsed(true);
        }
    }

    /// Compute complete shell geometry adhering to ThemeTokens specifications.
    pub fn compute_geometry(&self, tokens: &ThemeTokens) -> ShellGeometry {
        let mode = LayoutMode::from_width(self.viewport_width);
        let sidebar_w = self.sidebar.current_width;

        // 1. Sidebar Geometry (Floating squircle with inset, not a 1px bordered divider)
        let sidebar_bounds = if sidebar_w > 1.0 && mode != LayoutMode::Mobile {
            Some([
                12.0, // 12.0 lp floating inset from left
                12.0, // 12.0 lp floating inset from top
                sidebar_w - 12.0,
                self.viewport_height - 24.0, // floating above bottom edge
            ])
        } else {
            None
        };

        // 2. Centered Reading Column
        let available_w = if mode == LayoutMode::Mobile {
            self.viewport_width
        } else {
            (self.viewport_width - sidebar_w).max(320.0)
        };

        let max_reading_w = tokens.spacing.reading_column_max_width; // 680.0 lp
        let min_pad = tokens.spacing.reading_column_padding_min_h; // 24.0 lp

        let (content_w, offset_x, padding_h) = if available_w > max_reading_w + min_pad * 2.0 {
            let pad = ((available_w - max_reading_w) / 4.0).clamp(min_pad, tokens.spacing.reading_column_padding_max_h);
            let w = max_reading_w;
            let start_x = if mode == LayoutMode::Mobile {
                (available_w - w) / 2.0
            } else {
                sidebar_w + (available_w - w) / 2.0
            };
            (w, start_x, pad)
        } else {
            let pad = min_pad;
            let w = (available_w - pad * 2.0).max(280.0);
            let start_x = if mode == LayoutMode::Mobile {
                pad
            } else {
                sidebar_w + pad
            };
            (w, start_x, pad)
        };

        let reading_column = ReadingColumnGeometry {
            x: offset_x,
            width: content_w,
            padding_h,
            text_width: content_w - padding_h * 2.0,
        };

        // 3. Bottom Bar / Action Pill / FAB
        let (bottom_bar, fab) = match (mode, tokens.platform) {
            (LayoutMode::Mobile, PlatformKind::Apple) => {
                // Floating Liquid Glass capsule pill
                let bar_w = (self.viewport_width - 32.0).min(380.0);
                let bar_h = 56.0;
                let bar_x = (self.viewport_width - bar_w) / 2.0;
                let bar_y = self.viewport_height - bar_h - 16.0; // 16 lp above bottom
                (
                    Some(BottomBarGeometry {
                        x: bar_x,
                        y: bar_y,
                        width: bar_w,
                        height: bar_h,
                        corner_radius: tokens.radii.capsule, // 999.0 lp
                        is_liquid_glass: true,
                    }),
                    None,
                )
            }
            (LayoutMode::Mobile, PlatformKind::Android) => {
                // Tonal floating toolbar + Expressive FAB
                let bar_w = self.viewport_width - 24.0;
                let bar_h = 64.0;
                let bar_x = 12.0;
                let bar_y = self.viewport_height - bar_h - 12.0;

                let fab_size = 56.0;
                let fab_x = self.viewport_width - fab_size - 24.0;
                let fab_y = bar_y - fab_size - 16.0;

                (
                    Some(BottomBarGeometry {
                        x: bar_x,
                        y: bar_y,
                        width: bar_w,
                        height: bar_h,
                        corner_radius: tokens.radii.toolbar_sheet, // 24.0 lp
                        is_liquid_glass: false,
                    }),
                    Some(FabGeometry {
                        x: fab_x,
                        y: fab_y,
                        size: fab_size,
                        corner_radius: tokens.radii.fab_resting, // 18.0 lp
                    }),
                )
            }
            _ => (None, None),
        };

        ShellGeometry {
            layout_mode: mode,
            viewport_width: self.viewport_width,
            viewport_height: self.viewport_height,
            sidebar_bounds,
            reading_column,
            bottom_bar,
            fab,
        }
    }
}
