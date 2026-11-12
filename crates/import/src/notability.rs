use crate::flatbuffer::FlatBuffer;
use model::{
    NoteDocument, NotePage, PageOrientation, PageSheet, PageSize, PaperColor, PaperStyle, Point,
    Stroke, TextBlock, SCHEMA_VERSION,
};
use std::io::{Cursor, Read};
use thiserror::Error;
use zip::ZipArchive;

#[derive(Error, Debug)]
pub enum NotabilityError {
    #[error("Zip error: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("Plist error: {0}")]
    Plist(#[from] plist::Error),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Invalid notability note: {0}")]
    Invalid(String),
}

pub fn import_notability(bytes: &[u8], filename: &str) -> Result<NoteDocument, NotabilityError> {
    let mut zip = ZipArchive::new(Cursor::new(bytes))?;

    // Check if it has noteBundle (.ntb)
    let has_ntb = (0..zip.len()).any(|i| {
        zip.by_index(i)
            .map(|f| f.name().ends_with("noteBundle"))
            .unwrap_or(false)
    });

    if has_ntb {
        return import_ntb_bundle(&mut zip, filename);
    }

    // Check if it has Session.plist (.note)
    let has_plist = (0..zip.len()).any(|i| {
        zip.by_index(i)
            .map(|f| f.name().ends_with("Session.plist"))
            .unwrap_or(false)
    });

    if has_plist {
        return import_note_plist(&mut zip, filename);
    }

    Err(NotabilityError::Invalid(
        "Neither noteBundle nor Session.plist found in archive".to_string(),
    ))
}

fn import_ntb_bundle(
    zip: &mut ZipArchive<Cursor<&[u8]>>,
    filename: &str,
) -> Result<NoteDocument, NotabilityError> {
    let mut bundle_bytes = Vec::new();
    {
        let bundle_name = if zip.by_name("noteBundle").is_ok() {
            "noteBundle"
        } else {
            "note/noteBundle"
        };
        let mut bundle_file = zip.by_name(bundle_name)?;
        bundle_file.read_to_end(&mut bundle_bytes)?;
    }

    let fb = FlatBuffer::new(&bundle_bytes);
    let root = fb
        .root()
        .ok_or_else(|| NotabilityError::Invalid("Damaged noteBundle root".to_string()))?;

    let records = fb.tables(Some(root), 6);
    let mut strokes: Vec<Stroke> = Vec::new();
    let mut text_blocks: Vec<TextBlock> = Vec::new();

    let mut stroke_idx = 0;
    for r in records {
        let rec_type = fb.u8_at(Some(r), 4).unwrap_or(0);
        let p = fb.r#ref(Some(r), 5);
        if p.is_none() {
            continue;
        }

        // Record type 15 = INK
        if rec_type == 15 {
            let pts_raw = fb.points(p, 0);
            if pts_raw.len() >= 2 {
                let pts: Vec<Point> = pts_raw
                    .into_iter()
                    .map(|xy| Point {
                        x: xy[0] as f64,
                        y: xy[1] as f64,
                        pressure: 0.5,
                        t: None,
                        alt: None,
                        az: None,
                    })
                    .collect();

                let color_rgba = fb.rgba(p, 2).unwrap_or([0, 0, 0, 255]);
                let color_hex = format!(
                    "#{:02x}{:02x}{:02x}",
                    color_rgba[0], color_rgba[1], color_rgba[2]
                );

                strokes.push(Stroke {
                    id: format!("ntb_s_{}", stroke_idx),
                    tool: "pen".to_string(),
                    color: color_hex,
                    width: 2.0,
                    opacity: color_rgba[3] as f64 / 255.0,
                    points: pts,
                    line_style: None,
                    pen_style: None,
                    is_shape: None,
                    closed: None,
                    shape_kind: None,
                    fill: None,
                    fill_color: None,
                    fill_opacity: None,
                    arrow: None,
                    modeled: None,
                    pen_end: None,
                    rotation: None,
                    created_at: Some(stroke_idx as f64),
                    highlight_alpha: None,
                    dash_offset: None,
                    fill_only: None,
                });
                stroke_idx += 1;
            }
        } else if rec_type == 8 {
            // TEXT record
            if let Some(text_content) = fb.string(p, 0) {
                if !text_content.trim().is_empty() {
                    let pos = fb.pair(p, 1).unwrap_or([72.0, 72.0]);
                    text_blocks.push(TextBlock {
                        id: format!("ntb_txt_{}", text_blocks.len()),
                        x: pos[0] as f64,
                        y: pos[1] as f64,
                        width: 400.0,
                        height: None,
                        text: text_content,
                        font_size: 14.0,
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
                    });
                }
            }
        }
    }

    let page = NotePage {
        id: "ntb_page_1".to_string(),
        page_number: 1,
        strokes,
        latex_blocks: Vec::new(),
        text_blocks: Some(text_blocks),
        image_blocks: Some(Vec::new()),
    };

    let sheet = PageSheet {
        id: "ntb_sheet_1".to_string(),
        paper_style: Some(PaperStyle::Ruled),
        paper_color: Some(PaperColor::Name("white".to_string())),
        pattern_color: None,
        size: Some(PageSize::Letter),
        orientation: Some(PageOrientation::Portrait),
        width: None,
        height: None,
        pdf: None,
        bookmarked: None,
    };

    Ok(NoteDocument {
        id: format!("ntb_{}", filename.replace('.', "_")),
        title: filename.to_string(),
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
        sheets: vec![sheet],
        schema_version: Some(SCHEMA_VERSION),
    })
}

fn import_note_plist(
    zip: &mut ZipArchive<Cursor<&[u8]>>,
    filename: &str,
) -> Result<NoteDocument, NotabilityError> {
    let mut plist_bytes = Vec::new();
    {
        let plist_name = if zip.by_name("Session.plist").is_ok() {
            "Session.plist"
        } else {
            "Session/Session.plist"
        };
        let mut plist_file = zip.by_name(plist_name)?;
        plist_file.read_to_end(&mut plist_bytes)?;
    }

    let plist_val: plist::Value = plist::Value::from_reader(Cursor::new(&plist_bytes))?;

    let mut strokes = Vec::new();
    let mut stroke_idx = 0;

    // In Session.plist (keyed archive), objects are stored in "$objects"
    if let Some(dict) = plist_val.as_dictionary() {
        if let Some(objects) = dict.get("$objects").and_then(|o| o.as_array()) {
            for obj in objects {
                if let Some(obj_dict) = obj.as_dictionary() {
                    // Check if it's an ink curve
                    if let Some(pts_data) = obj_dict.get("points").and_then(|p| p.as_data()) {
                        let mut pts = Vec::new();
                        let mut o = 0;
                        while o + 8 <= pts_data.len() {
                            let x = f32::from_le_bytes([
                                pts_data[o],
                                pts_data[o + 1],
                                pts_data[o + 2],
                                pts_data[o + 3],
                            ]) as f64;
                            let y = f32::from_le_bytes([
                                pts_data[o + 4],
                                pts_data[o + 5],
                                pts_data[o + 6],
                                pts_data[o + 7],
                            ]) as f64;
                            pts.push(Point {
                                x,
                                y,
                                pressure: 0.5,
                                t: None,
                                alt: None,
                                az: None,
                            });
                            o += 8;
                        }
                        if pts.len() >= 2 {
                            strokes.push(Stroke {
                                id: format!("note_s_{}", stroke_idx),
                                tool: "pen".to_string(),
                                color: "#000000".to_string(),
                                width: 2.0,
                                opacity: 1.0,
                                points: pts,
                                line_style: None,
                                pen_style: None,
                                is_shape: None,
                                closed: None,
                                shape_kind: None,
                                fill: None,
                                fill_color: None,
                                fill_opacity: None,
                                arrow: None,
                                modeled: None,
                                pen_end: None,
                                rotation: None,
                                created_at: Some(stroke_idx as f64),
                                highlight_alpha: None,
                                dash_offset: None,
                                fill_only: None,
                            });
                            stroke_idx += 1;
                        }
                    }
                }
            }
        }
    }

    let page = NotePage {
        id: "note_page_1".to_string(),
        page_number: 1,
        strokes,
        latex_blocks: Vec::new(),
        text_blocks: Some(Vec::new()),
        image_blocks: Some(Vec::new()),
    };

    let sheet = PageSheet {
        id: "note_sheet_1".to_string(),
        paper_style: Some(PaperStyle::Ruled),
        paper_color: Some(PaperColor::Name("white".to_string())),
        pattern_color: None,
        size: Some(PageSize::Letter),
        orientation: Some(PageOrientation::Portrait),
        width: None,
        height: None,
        pdf: None,
        bookmarked: None,
    };

    Ok(NoteDocument {
        id: format!("note_{}", filename.replace('.', "_")),
        title: filename.to_string(),
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
        sheets: vec![sheet],
        schema_version: Some(SCHEMA_VERSION),
    })
}
