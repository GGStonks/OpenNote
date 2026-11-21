use model::{
    LatexBlock, NoteDocument, NotePage, PageOrientation, PageSheet, PageSize, PaperColor,
    PaperStyle, TextBlock, PAGE_HEIGHT, PAGE_WIDTH, SCHEMA_VERSION,
};

pub fn import_plain_text(content: &str, title: &str) -> NoteDocument {
    let margin_x = 72.0;
    let margin_y = 72.0;
    let width = PAGE_WIDTH - 2.0 * margin_x;
    let font_size = 14.0;
    let line_count = content.lines().count().max(1);
    let height = font_size * 1.4 * line_count as f64;

    let tb = TextBlock {
        id: "txt_block_1".to_string(),
        x: margin_x,
        y: margin_y,
        width,
        height: Some(height),
        text: content.to_string(),
        font_size,
        color: "#111827".to_string(),
        bold: None,
        italic: None,
        underline: None,
        font_family: None,
        align: None,
        line_height: None,
        strike: None,
        spans: None,
        paras: None,
        background: None,
        radius: None,
        padding: None,
        rotation: None,
        created_at: 0.0,
    };

    let page_count = (((margin_y + height) / PAGE_HEIGHT).floor() as usize + 1).max(1);
    let sheets = (0..page_count)
        .map(|i| PageSheet {
            id: format!("sheet_{}", i),
            paper_style: Some(PaperStyle::Ruled),
            paper_color: Some(PaperColor::Name("white".to_string())),
            pattern_color: None,
            size: Some(PageSize::Letter),
            orientation: Some(PageOrientation::Portrait),
            width: None,
            height: None,
            pdf: None,
            bookmarked: None,
        })
        .collect();

    let page = NotePage {
        id: "page_1".to_string(),
        page_number: 1,
        strokes: Vec::new(),
        latex_blocks: Vec::new(),
        text_blocks: Some(vec![tb]),
        image_blocks: Some(Vec::new()),
    };

    NoteDocument {
        id: format!("doc_{}", title.replace(' ', "_")),
        title: title.to_string(),
        subject_id: None,
        folder_id: None,
        tag_ids: None,
        created_at: 0.0,
        updated_at: 0.0,
        paper_style: PaperStyle::Ruled,
        paper_color: PaperColor::Name("white".to_string()),
        pattern_color: None,
        page_size: Some(PageSize::Letter),
        orientation: Some(PageOrientation::Portrait),
        pages: vec![page],
        sheets,
        schema_version: Some(SCHEMA_VERSION),
    }
}

pub fn import_latex_file(content: &str, title: &str) -> NoteDocument {
    // If it's a snippet or full doc, place as LatexBlock
    let lb = LatexBlock {
        id: "latex_block_1".to_string(),
        x: 72.0,
        y: 72.0,
        width: 500.0,
        height: 120.0,
        scale: None,
        stretch_x: None,
        latex_code: content.trim().to_string(),
        is_tikz: Some(content.contains("\\begin{tikzpicture}")),
        tikz_svg: None,
        tikz_svg_source: None,
        color: None,
        rotation: None,
        created_at: 0.0,
    };

    let page = NotePage {
        id: "page_1".to_string(),
        page_number: 1,
        strokes: Vec::new(),
        latex_blocks: vec![lb],
        text_blocks: Some(Vec::new()),
        image_blocks: Some(Vec::new()),
    };

    let sheet = PageSheet {
        id: "sheet_1".to_string(),
        paper_style: Some(PaperStyle::Blank),
        paper_color: Some(PaperColor::Name("white".to_string())),
        pattern_color: None,
        size: Some(PageSize::Letter),
        orientation: Some(PageOrientation::Portrait),
        width: None,
        height: None,
        pdf: None,
        bookmarked: None,
    };

    NoteDocument {
        id: format!("latex_{}", title.replace(' ', "_")),
        title: title.to_string(),
        subject_id: None,
        folder_id: None,
        tag_ids: None,
        created_at: 0.0,
        updated_at: 0.0,
        paper_style: PaperStyle::Blank,
        paper_color: PaperColor::Name("white".to_string()),
        pattern_color: None,
        page_size: Some(PageSize::Letter),
        orientation: Some(PageOrientation::Portrait),
        pages: vec![page],
        sheets: vec![sheet],
        schema_version: Some(SCHEMA_VERSION),
    }
}
