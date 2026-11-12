use crate::sheets::{letter_sheets_for, new_id, surface_from_pages};
use crate::types::{NoteDocument, NotePage, SCHEMA_VERSION};

pub fn create_blank_page(page_number: usize) -> NotePage {
    NotePage {
        id: new_id("page"),
        page_number,
        strokes: Vec::new(),
        latex_blocks: Vec::new(),
        text_blocks: Some(Vec::new()),
        image_blocks: Some(Vec::new()),
    }
}

pub fn migrate_note(mut n: NoteDocument) -> NoteDocument {
    if let Some(subject_id) = n.subject_id.take() {
        if n.folder_id.is_none() {
            n.folder_id = Some(subject_id);
        }
    }

    if n.schema_version == Some(SCHEMA_VERSION) && !n.sheets.is_empty() {
        return n;
    }

    let source = if n.pages.is_empty() {
        vec![create_blank_page(1)]
    } else {
        n.pages
    };

    let base = NoteDocument {
        id: n.id,
        title: n.title,
        subject_id: None,
        folder_id: n.folder_id,
        tag_ids: n.tag_ids,
        created_at: n.created_at,
        updated_at: n.updated_at,
        paper_style: n.paper_style,
        paper_color: n.paper_color,
        pattern_color: n.pattern_color,
        page_size: n.page_size,
        orientation: n.orientation,
        pages: Vec::new(),
        sheets: Vec::new(),
        schema_version: Some(SCHEMA_VERSION),
    };

    if n.schema_version == Some(3) || n.schema_version == Some(SCHEMA_VERSION) {
        let mut surface = source.into_iter().next().unwrap_or_else(|| create_blank_page(1));
        surface.page_number = 1;
        let sheets = letter_sheets_for(&surface);
        NoteDocument {
            pages: vec![surface],
            sheets,
            ..base
        }
    } else {
        let (surface, sheets) = surface_from_pages(&base, &source);
        NoteDocument {
            pages: vec![surface],
            sheets,
            ..base
        }
    }
}
