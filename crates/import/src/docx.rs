use model::{
    NoteDocument, NotePage, PageOrientation, PageSheet, PageSize, PaperColor, PaperStyle,
    TextBlock, TextSpan, PAGE_HEIGHT, PAGE_WIDTH, SCHEMA_VERSION,
};
use quick_xml::events::Event;
use quick_xml::reader::Reader;
use std::collections::HashMap;
use std::io::{Cursor, Read};
use thiserror::Error;
use zip::ZipArchive;

#[derive(Error, Debug)]
pub enum DocxError {
    #[error("Zip error: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("XML error: {0}")]
    Xml(#[from] quick_xml::Error),
    #[error("Invalid document")]
    Invalid,
}

#[derive(Clone, Debug, Default)]
struct RunStyle {
    bold: bool,
    italic: bool,
    underline: bool,
    strike: bool,
    size: Option<f64>,
    color: Option<String>,
}

pub fn import_docx(bytes: &[u8], title: &str) -> Result<NoteDocument, DocxError> {
    let mut zip = ZipArchive::new(Cursor::new(bytes))?;

    // Read media relationships
    let mut rels: HashMap<String, String> = HashMap::new();
    if let Ok(mut file) = zip.by_name("word/_rels/document.xml.rels") {
        let mut xml = String::new();
        file.read_to_string(&mut xml)?;
        let mut reader = Reader::from_str(&xml);
        let mut buf = Vec::new();
        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                    if e.name().as_ref() == b"Relationship" {
                        let mut id = String::new();
                        let mut target = String::new();
                        for attr in e.attributes().flatten() {
                            if attr.key.as_ref() == b"Id" {
                                id = String::from_utf8_lossy(&attr.value).to_string();
                            } else if attr.key.as_ref() == b"Target" {
                                target = String::from_utf8_lossy(&attr.value).to_string();
                            }
                        }
                        if !id.is_empty() && !target.is_empty() {
                            rels.insert(id, target);
                        }
                    }
                }
                Ok(Event::Eof) => break,
                Err(e) => return Err(DocxError::Xml(e)),
                _ => {}
            }
            buf.clear();
        }
    }

    // Read main document
    let mut doc_file = zip.by_name("word/document.xml")?;
    let mut doc_xml = String::new();
    doc_file.read_to_string(&mut doc_xml)?;

    let mut reader = Reader::from_str(&doc_xml);
    let mut buf = Vec::new();

    let mut paragraphs: Vec<(String, Vec<TextSpan>)> = Vec::new();
    let mut current_p_text = String::new();
    let mut current_spans: Vec<TextSpan> = Vec::new();

    let mut in_t = false;
    let mut in_rpr = false;
    let mut cur_run_style = RunStyle::default();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => match e.name().as_ref() {
                b"w:p" => {
                    current_p_text.clear();
                    current_spans.clear();
                }
                b"w:r" => {
                    cur_run_style = RunStyle::default();
                }
                b"w:rPr" => {
                    in_rpr = true;
                }
                b"w:b" if in_rpr => {
                    cur_run_style.bold = true;
                }
                b"w:i" if in_rpr => {
                    cur_run_style.italic = true;
                }
                b"w:u" if in_rpr => {
                    cur_run_style.underline = true;
                }
                b"w:strike" if in_rpr => {
                    cur_run_style.strike = true;
                }
                b"w:sz" if in_rpr => {
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref() == b"w:val" {
                            if let Ok(half_pts) = std::str::from_utf8(&attr.value)
                                .unwrap_or("24")
                                .parse::<f64>()
                            {
                                cur_run_style.size = Some(half_pts / 2.0);
                            }
                        }
                    }
                }
                b"w:color" if in_rpr => {
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref() == b"w:val" {
                            let val = String::from_utf8_lossy(&attr.value);
                            if val != "auto" {
                                cur_run_style.color = Some(format!("#{}", val));
                            }
                        }
                    }
                }
                b"w:t" => {
                    in_t = true;
                }
                _ => {}
            },
            Ok(Event::Empty(ref e)) => {
                if in_rpr {
                    match e.name().as_ref() {
                        b"w:b" => cur_run_style.bold = true,
                        b"w:i" => cur_run_style.italic = true,
                        b"w:u" => cur_run_style.underline = true,
                        b"w:strike" => cur_run_style.strike = true,
                        b"w:sz" => {
                            for attr in e.attributes().flatten() {
                                if attr.key.as_ref() == b"w:val" {
                                    if let Ok(half_pts) = std::str::from_utf8(&attr.value)
                                        .unwrap_or("24")
                                        .parse::<f64>()
                                    {
                                        cur_run_style.size = Some(half_pts / 2.0);
                                    }
                                }
                            }
                        }
                        b"w:color" => {
                            for attr in e.attributes().flatten() {
                                if attr.key.as_ref() == b"w:val" {
                                    let val = String::from_utf8_lossy(&attr.value);
                                    if val != "auto" {
                                        cur_run_style.color = Some(format!("#{}", val));
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            Ok(Event::Text(ref e)) if in_t => {
                if let Ok(t) = e.unescape() {
                    let start = current_p_text.len();
                    current_p_text.push_str(&t);
                    let end = current_p_text.len();
                    if cur_run_style.bold
                        || cur_run_style.italic
                        || cur_run_style.underline
                        || cur_run_style.strike
                        || cur_run_style.color.is_some()
                        || cur_run_style.size.is_some()
                    {
                        current_spans.push(TextSpan {
                            start,
                            end,
                            bold: if cur_run_style.bold { Some(true) } else { None },
                            italic: if cur_run_style.italic {
                                Some(true)
                            } else {
                                None
                            },
                            underline: if cur_run_style.underline {
                                Some(true)
                            } else {
                                None
                            },
                            strike: if cur_run_style.strike {
                                Some(true)
                            } else {
                                None
                            },
                            color: cur_run_style.color.clone(),
                            font: None,
                            size: cur_run_style.size,
                        });
                    }
                }
            }
            Ok(Event::End(ref e)) => match e.name().as_ref() {
                b"w:t" => in_t = false,
                b"w:rPr" => in_rpr = false,
                b"w:p" => {
                    if !current_p_text.is_empty() {
                        paragraphs.push((current_p_text.clone(), current_spans.clone()));
                    }
                }
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(e) => return Err(DocxError::Xml(e)),
            _ => {}
        }
        buf.clear();
    }

    let mut text_blocks = Vec::new();
    let mut cur_y = 50.0;
    let margin_x = 72.0;
    let width = PAGE_WIDTH - 2.0 * margin_x;

    for (i, (text, spans)) in paragraphs.into_iter().enumerate() {
        let lines = text.split('\n').count().max(1);
        let font_size = 14.0;
        let h = font_size * 1.4 * lines as f64 + 10.0;

        text_blocks.push(TextBlock {
            id: format!("docx_txt_{}", i),
            x: margin_x,
            y: cur_y,
            width,
            height: Some(h),
            text,
            font_size,
            color: "#111827".to_string(),
            bold: None,
            italic: None,
            underline: None,
            font_family: None,
            align: None,
            line_height: None,
            strike: None,
            spans: if spans.is_empty() { None } else { Some(spans) },
            paras: None,
            background: None,
            radius: None,
            padding: None,
            rotation: None,
            created_at: i as f64,
        });

        cur_y += h + 10.0;
    }

    let page_count = ((cur_y / PAGE_HEIGHT).floor() as usize + 1).max(1);
    let sheets = (0..page_count)
        .map(|i| PageSheet {
            id: format!("docx_sheet_{}", i),
            paper_style: Some(PaperStyle::Blank),
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
        id: "docx_page_1".to_string(),
        page_number: 1,
        strokes: Vec::new(),
        latex_blocks: Vec::new(),
        text_blocks: Some(text_blocks),
        image_blocks: Some(Vec::new()),
    };

    Ok(NoteDocument {
        id: format!("docx_{}", title.replace(' ', "_")),
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
        sheets,
        schema_version: Some(SCHEMA_VERSION),
    })
}
