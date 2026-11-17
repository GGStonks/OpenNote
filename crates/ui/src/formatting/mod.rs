//! Formatting module: selection-triggered floating pill, `/` slash command popover,
//! and clean custom-drawn vector checkboxes and bullets.

pub mod controls;
pub mod floating_pill;
pub mod slash_command;

pub use controls::{BulletStyle, CheckboxState, VectorBullet, VectorCheckbox};
pub use floating_pill::{FloatingSelectionPill, FormatAction, TextSelection};
pub use slash_command::{SlashCommandItem, SlashCommandKind, SlashCommandPopover};
