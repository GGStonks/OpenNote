//! Standardized vector icon registry (Lucide & Phosphor style).
//!
//! Designed for rendering at 1.5px stroke width and 18.0–20.0 lp size.

/// Vector icon definition with SVG path data.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VectorIcon {
    pub name: &'static str,
    pub path_data: &'static str,
    pub view_box: (u32, u32),
}

impl VectorIcon {
    pub const fn new(name: &'static str, path_data: &'static str) -> Self {
        Self {
            name,
            path_data,
            view_box: (24, 24),
        }
    }
}

pub const ICON_BOLD: VectorIcon = VectorIcon::new(
    "bold",
    "M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z",
);

pub const ICON_ITALIC: VectorIcon = VectorIcon::new(
    "italic",
    "M19 4h-9 M14 20H5 M15 4L9 20",
);

pub const ICON_STRIKETHROUGH: VectorIcon = VectorIcon::new(
    "strikethrough",
    "M16 4H9a3 3 0 0 0-2.83 4 M4 12h16 M14 16a3 3 0 0 1-3 3H7",
);

pub const ICON_CODE: VectorIcon = VectorIcon::new(
    "code",
    "M16 18l6-6-6-6 M8 6l-6 6 6 6",
);

pub const ICON_LINK: VectorIcon = VectorIcon::new(
    "link",
    "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71 M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
);

pub const ICON_HIGHLIGHTER: VectorIcon = VectorIcon::new(
    "highlighter",
    "M9 11l-6 6v3h3l6-6 M22 5.5a2.12 2.12 0 0 0-3-3L13 8.5l3 3L22 5.5z",
);

pub const ICON_HEADING_1: VectorIcon = VectorIcon::new(
    "heading-1",
    "M4 12h8 M4 18V6 M12 18V6 M17 12l3-2v8",
);

pub const ICON_HEADING_2: VectorIcon = VectorIcon::new(
    "heading-2",
    "M4 12h8 M4 18V6 M12 18V6 M21 18h-4c0-4 4-3 4-6a2 2 0 0 0-4-1",
);

pub const ICON_HEADING_3: VectorIcon = VectorIcon::new(
    "heading-3",
    "M4 12h8 M4 18V6 M12 18V6 M17.5 10.5c.83-.83 2-1 3-.5a2 2 0 0 1 0 3.5c-.8.4-1.5.5-1.5.5s.7.1 1.5.5a2 2 0 0 1 0 3.5c-1 .5-2.17.33-3-.5",
);

pub const ICON_SIGMA: VectorIcon = VectorIcon::new(
    "sigma",
    "M18 7V4H6l7 8-7 8h12v-3",
);

pub const ICON_LIST: VectorIcon = VectorIcon::new(
    "list",
    "M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01",
);

pub const ICON_CHECK_SQUARE: VectorIcon = VectorIcon::new(
    "check-square",
    "M9 11l3 3L22 4 M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
);

pub const ICON_PEN_TOOL: VectorIcon = VectorIcon::new(
    "pen-tool",
    "M12 19l7-7 3 3-7 7-3-3z M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z M2 2l7.586 7.586 M11 13a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
);

pub const ICON_SEARCH: VectorIcon = VectorIcon::new(
    "search",
    "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.35-4.35",
);

pub const ICON_SIDEBAR: VectorIcon = VectorIcon::new(
    "sidebar",
    "M3 3h18a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm6 0v18",
);

pub const ICON_PLUS: VectorIcon = VectorIcon::new(
    "plus",
    "M12 5v14 M5 12h14",
);

pub const ICON_MORE_HORIZONTAL: VectorIcon = VectorIcon::new(
    "more-horizontal",
    "M12 12h.01 M19 12h.01 M5 12h.01",
);

pub const ICON_FILE_TEXT: VectorIcon = VectorIcon::new(
    "file-text",
    "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8",
);

/// Lookup icon by name.
pub fn get_icon(name: &str) -> Option<VectorIcon> {
    match name {
        "bold" => Some(ICON_BOLD),
        "italic" => Some(ICON_ITALIC),
        "strikethrough" => Some(ICON_STRIKETHROUGH),
        "code" => Some(ICON_CODE),
        "link" => Some(ICON_LINK),
        "highlighter" => Some(ICON_HIGHLIGHTER),
        "heading-1" => Some(ICON_HEADING_1),
        "heading-2" => Some(ICON_HEADING_2),
        "heading-3" => Some(ICON_HEADING_3),
        "sigma" => Some(ICON_SIGMA),
        "list" => Some(ICON_LIST),
        "check-square" => Some(ICON_CHECK_SQUARE),
        "pen-tool" => Some(ICON_PEN_TOOL),
        "search" => Some(ICON_SEARCH),
        "sidebar" => Some(ICON_SIDEBAR),
        "plus" => Some(ICON_PLUS),
        "more-horizontal" => Some(ICON_MORE_HORIZONTAL),
        "file-text" => Some(ICON_FILE_TEXT),
        _ => None,
    }
}
