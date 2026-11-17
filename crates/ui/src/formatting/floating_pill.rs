//! Selection-triggered floating formatting pill.
//!
//! Replaces rigid, permanent top formatting toolbars. Appears strictly only
//! when text selection length > 0, floating directly above the selection.

use crate::theme::tokens::*;
use serde::{Deserialize, Serialize};

/// Contextual formatting action triggered from the floating selection pill.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum FormatAction {
    Bold,
    Italic,
    Strikethrough,
    Code,
    Link,
    Highlight,
    Heading1,
    Heading2,
    Formula,
}

impl FormatAction {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Bold => "Bold",
            Self::Italic => "Italic",
            Self::Strikethrough => "Strikethrough",
            Self::Code => "Code",
            Self::Link => "Link",
            Self::Highlight => "Highlight",
            Self::Heading1 => "Heading 1",
            Self::Heading2 => "Heading 2",
            Self::Formula => "Formula",
        }
    }

    pub fn icon_name(&self) -> &'static str {
        match self {
            Self::Bold => "bold",
            Self::Italic => "italic",
            Self::Strikethrough => "strikethrough",
            Self::Code => "code",
            Self::Link => "link",
            Self::Highlight => "highlighter",
            Self::Heading1 => "heading-1",
            Self::Heading2 => "heading-2",
            Self::Formula => "sigma",
        }
    }
}

/// Active text selection bounds in logical pixels.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct TextSelection {
    pub start: usize,
    pub end: usize,
    /// Bounding rect of selection: [x, y, width, height]
    pub bounds: [f32; 4],
}

impl TextSelection {
    pub fn len(&self) -> usize {
        if self.end > self.start {
            self.end - self.start
        } else {
            0
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Floating selection pill widget state.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FloatingSelectionPill {
    pub is_visible: bool,
    /// Pill bounding box: [x, y, width, height]
    pub bounds: [f32; 4],
    /// Current opacity [0.0..1.0] for spring entry/exit
    pub opacity: f32,
    /// Available actions in this pill
    pub actions: Vec<FormatAction>,
    /// Currently active formatting styles in the selected range
    pub active_styles: Vec<FormatAction>,
}

impl Default for FloatingSelectionPill {
    fn default() -> Self {
        Self {
            is_visible: false,
            bounds: [0.0, 0.0, 310.0, 40.0],
            opacity: 0.0,
            actions: vec![
                FormatAction::Bold,
                FormatAction::Italic,
                FormatAction::Strikethrough,
                FormatAction::Code,
                FormatAction::Highlight,
                FormatAction::Link,
                FormatAction::Heading1,
                FormatAction::Formula,
            ],
            active_styles: Vec::new(),
        }
    }
}

impl FloatingSelectionPill {
    /// Update visibility and position based on current selection and viewport.
    pub fn update_selection(
        &mut self,
        selection: Option<&TextSelection>,
        viewport_width: f32,
        viewport_height: f32,
        tokens: &ThemeTokens,
    ) {
        match selection {
            Some(sel) if !sel.is_empty() => {
                self.is_visible = true;
                self.opacity = 1.0;

                let pill_w = 310.0_f32.min(viewport_width - 32.0);
                let pill_h = 40.0_f32;
                let offset_y = tokens.spacing.floating_toolbar_offset; // 8.0 lp

                // Center above the selection bounds
                let [sel_x, sel_y, sel_w, _sel_h] = sel.bounds;
                let mut pill_x = sel_x + (sel_w - pill_w) / 2.0;
                let mut pill_y = sel_y - pill_h - offset_y;

                // Clamp to viewport bounds with 16.0 lp safety margin
                pill_x = pill_x.clamp(16.0, (viewport_width - pill_w - 16.0).max(16.0));
                if pill_y < 16.0 {
                    // If clipping off top edge, position below the selection
                    pill_y = sel_y + sel.bounds[3] + offset_y;
                }
                pill_y = pill_y.clamp(16.0, (viewport_height - pill_h - 16.0).max(16.0));

                self.bounds = [pill_x, pill_y, pill_w, pill_h];
            }
            _ => {
                self.is_visible = false;
                self.opacity = 0.0;
            }
        }
    }

    /// Advance spring animation for pill appearance / dismissal.
    pub fn step_spring(&mut self, spring: &SpringConfig, dt: f32) {
        let target_opacity = if self.is_visible { 1.0 } else { 0.0 };
        let (new_opacity, _, _) = spring.step(self.opacity, 0.0, target_opacity, dt);
        self.opacity = new_opacity.clamp(0.0, 1.0);
    }
}
