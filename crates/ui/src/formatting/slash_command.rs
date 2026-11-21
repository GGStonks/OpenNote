//! Slash-command popover (`/`) for inserting blocks and headings on empty lines.
//!
//! Replaces permanent top ribbon inserters with an inline contextual palette.

use crate::theme::tokens::*;
use serde::{Deserialize, Serialize};

/// Block or style insert command.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SlashCommandKind {
    Heading1,
    Heading2,
    Heading3,
    BulletedList,
    CheckboxList,
    CodeBlock,
    MathFormula,
    DrawingCanvas,
    Callout,
    Divider,
}

impl SlashCommandKind {
    pub fn title(&self) -> &'static str {
        match self {
            Self::Heading1 => "Heading 1",
            Self::Heading2 => "Heading 2",
            Self::Heading3 => "Heading 3",
            Self::BulletedList => "Bulleted List",
            Self::CheckboxList => "To-do Task List",
            Self::CodeBlock => "Code Block",
            Self::MathFormula => "LaTeX Formula",
            Self::DrawingCanvas => "Ink Drawing Canvas",
            Self::Callout => "Callout Note",
            Self::Divider => "Divider Line",
        }
    }

    pub fn description(&self) -> &'static str {
        match self {
            Self::Heading1 => "Large section heading",
            Self::Heading2 => "Medium subsection heading",
            Self::Heading3 => "Small section heading",
            Self::BulletedList => "Create an unordered list",
            Self::CheckboxList => "Interactive task checklist",
            Self::CodeBlock => "Code snippet with syntax highlight",
            Self::MathFormula => "Mathematical equation via Typst / LaTeX",
            Self::DrawingCanvas => "Embedded 240Hz stylus sketch",
            Self::Callout => "Highlighted note or tip box",
            Self::Divider => "Visual horizontal separation",
        }
    }

    pub fn icon_name(&self) -> &'static str {
        match self {
            Self::Heading1 => "heading-1",
            Self::Heading2 => "heading-2",
            Self::Heading3 => "heading-3",
            Self::BulletedList => "list",
            Self::CheckboxList => "check-square",
            Self::CodeBlock => "code",
            Self::MathFormula => "sigma",
            Self::DrawingCanvas => "pen-tool",
            Self::Callout => "info",
            Self::Divider => "minus",
        }
    }

    pub fn matches_query(&self, query: &str) -> bool {
        if query.is_empty() {
            return true;
        }
        let q = query.to_lowercase();
        self.title().to_lowercase().contains(&q) || self.description().to_lowercase().contains(&q)
    }
}

/// Slash command item entry.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SlashCommandItem {
    pub kind: SlashCommandKind,
    pub title: &'static str,
    pub description: &'static str,
    pub icon_name: &'static str,
}

/// Slash command popover state.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SlashCommandPopover {
    pub is_open: bool,
    pub query: String,
    pub selected_index: usize,
    /// Bounding rectangle [x, y, w, h] in logical pixels
    pub bounds: [f32; 4],
}

impl Default for SlashCommandPopover {
    fn default() -> Self {
        Self {
            is_open: false,
            query: String::new(),
            selected_index: 0,
            bounds: [0.0, 0.0, 260.0, 320.0],
        }
    }
}

impl SlashCommandPopover {
    /// Open the slash popover at cursor coordinates [x, y].
    pub fn open_at(
        &mut self,
        cursor_x: f32,
        cursor_y: f32,
        viewport_w: f32,
        viewport_h: f32,
        tokens: &ThemeTokens,
    ) {
        self.is_open = true;
        self.query.clear();
        self.selected_index = 0;

        let w = 260.0_f32;
        let h = 320.0_f32;
        let offset = tokens.spacing.floating_toolbar_offset;

        let mut x = cursor_x;
        let mut y = cursor_y + offset;

        // Clamp to viewport
        x = x.clamp(16.0, (viewport_w - w - 16.0).max(16.0));
        if y + h > viewport_h - 16.0 {
            y = (cursor_y - h - offset).max(16.0);
        }

        self.bounds = [x, y, w, h];
    }

    pub fn close(&mut self) {
        self.is_open = false;
        self.query.clear();
        self.selected_index = 0;
    }

    /// Return filtered list of available commands.
    pub fn filtered_items(&self) -> Vec<SlashCommandItem> {
        let all_kinds = [
            SlashCommandKind::Heading1,
            SlashCommandKind::Heading2,
            SlashCommandKind::Heading3,
            SlashCommandKind::BulletedList,
            SlashCommandKind::CheckboxList,
            SlashCommandKind::CodeBlock,
            SlashCommandKind::MathFormula,
            SlashCommandKind::DrawingCanvas,
            SlashCommandKind::Callout,
            SlashCommandKind::Divider,
        ];

        all_kinds
            .into_iter()
            .filter(|k| k.matches_query(&self.query))
            .map(|k| SlashCommandItem {
                kind: k,
                title: k.title(),
                description: k.description(),
                icon_name: k.icon_name(),
            })
            .collect()
    }

    /// Move selection up.
    pub fn move_up(&mut self) {
        let count = self.filtered_items().len();
        if count > 0 {
            if self.selected_index == 0 {
                self.selected_index = count - 1;
            } else {
                self.selected_index -= 1;
            }
        }
    }

    /// Move selection down.
    pub fn move_down(&mut self) {
        let count = self.filtered_items().len();
        if count > 0 {
            self.selected_index = (self.selected_index + 1) % count;
        }
    }

    /// Select current item and return chosen kind.
    pub fn commit_selection(&mut self) -> Option<SlashCommandKind> {
        let items = self.filtered_items();
        if self.selected_index < items.len() {
            let kind = items[self.selected_index].kind;
            self.close();
            Some(kind)
        } else {
            None
        }
    }
}
