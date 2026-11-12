use model::{
    export_backup_json, export_opennote_zip, import_backup_json, import_opennote_zip,
    migrate_note, pack_note, unpack_note, LibraryBackup, ModeledKind, NoteDocument, NotePage,
    PageSheet, PaperColor, PaperStyle, Point, Stroke, SCHEMA_VERSION,
};
use serde_json::Value;
use std::fs;
use std::io::Cursor;
use std::path::Path;

#[test]
fn test_storage_roundtrip_recordings() {
    let rec_dir = Path::new("../../bench/recordings");
    let rec_dir = if rec_dir.exists() {
        rec_dir
    } else {
        Path::new("bench/recordings")
    };

    let mut all_strokes: Vec<Stroke> = Vec::new();
    let mut stroke_idx = 0;

    let mut entries: Vec<_> = fs::read_dir(rec_dir)
        .expect("bench/recordings should exist")
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("json"))
        .collect();
    entries.sort_by_key(|e| e.path());

    for entry in entries {
        let content = fs::read_to_string(entry.path()).expect("read recording");
        let val: Value = serde_json::from_str(&content).expect("parse recording json");
        if let Some(strokes_arr) = val.get("strokes").and_then(|s| s.as_array()) {
            for s in strokes_arr {
                if let Some(samples) = s.get("samples").and_then(|s| s.as_array()) {
                    let points: Vec<Point> = samples
                        .iter()
                        .enumerate()
                        .map(|(j, sample)| {
                            let arr = sample.as_array().expect("sample is array");
                            let x = arr[0].as_f64().unwrap();
                            let y = arr[1].as_f64().unwrap();
                            let t = if j % 3 != 0 {
                                Some(arr[2].as_f64().unwrap())
                            } else {
                                None
                            };
                            let pressure = arr[3].as_f64().unwrap();
                            let alt = if j % 5 != 0 {
                                Some(arr[5].as_f64().unwrap())
                            } else {
                                None
                            };
                            let az = if j % 7 != 0 {
                                Some(arr[6].as_f64().unwrap())
                            } else {
                                None
                            };
                            Point {
                                x,
                                y,
                                pressure,
                                t,
                                alt,
                                az,
                            }
                        })
                        .collect();

                    let modeled = if stroke_idx % 4 == 0 {
                        Some(ModeledKind::Variable)
                    } else {
                        None
                    };
                    let rotation = if stroke_idx % 4 == 0 {
                        Some(15.0)
                    } else {
                        None
                    };

                    all_strokes.push(Stroke {
                        id: format!("s{}", stroke_idx),
                        tool: "pen".to_string(),
                        color: "#111".to_string(),
                        width: 1.5,
                        opacity: 1.0,
                        points,
                        line_style: None,
                        pen_style: None,
                        is_shape: None,
                        closed: None,
                        shape_kind: None,
                        fill: None,
                        fill_color: None,
                        fill_opacity: None,
                        arrow: None,
                        modeled,
                        pen_end: None,
                        rotation,
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

    // Add empty stroke
    all_strokes.push(Stroke {
        id: "empty".to_string(),
        tool: "highlighter".to_string(),
        color: "#ff0".to_string(),
        width: 8.0,
        opacity: 0.4,
        points: Vec::new(),
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
        created_at: None,
        highlight_alpha: None,
        dash_offset: None,
        fill_only: None,
    });

    let total_points: usize = all_strokes.iter().map(|s| s.points.len()).sum();
    println!(
        "Loaded {} strokes with {} total points from recordings",
        all_strokes.len(),
        total_points
    );
    assert!(total_points > 30000, "Should have loaded recording points");

    let note = NoteDocument {
        id: "n".to_string(),
        title: "t".to_string(),
        subject_id: None,
        folder_id: None,
        tag_ids: None,
        created_at: 1.0,
        updated_at: 2.0,
        paper_style: PaperStyle::Ruled,
        paper_color: PaperColor::Name("white".to_string()),
        pattern_color: None,
        page_size: None,
        orientation: None,
        pages: vec![
            NotePage {
                id: "p1".to_string(),
                page_number: 1,
                strokes: all_strokes,
                latex_blocks: Vec::new(),
                text_blocks: Some(Vec::new()),
                image_blocks: Some(Vec::new()),
            },
            NotePage {
                id: "p2".to_string(),
                page_number: 2,
                strokes: Vec::new(),
                latex_blocks: Vec::new(),
                text_blocks: Some(Vec::new()),
                image_blocks: Some(Vec::new()),
            },
        ],
        sheets: vec![PageSheet {
            id: "sh".to_string(),
            paper_style: None,
            paper_color: None,
            pattern_color: None,
            size: None,
            orientation: None,
            width: None,
            height: None,
            pdf: None,
            bookmarked: None,
        }],
        schema_version: Some(SCHEMA_VERSION),
    };

    // Test pack -> unpack roundtrip
    let packed = pack_note(&note);
    let unpacked = unpack_note(&packed);
    assert_eq!(note, unpacked, "Pack -> unpack round-trip exact match");

    // Test JSON serialization of packed note
    let json = serde_json::to_string(&packed).expect("serialize packed note");
    let deserialized_packed: model::StoredNoteDocument =
        serde_json::from_str(&json).expect("deserialize packed note");
    let unpacked_from_json = unpack_note(&deserialized_packed);
    assert_eq!(
        note, unpacked_from_json,
        "JSON serialize -> deserialize -> unpack exact match"
    );
}

#[test]
fn test_zip_and_backup_roundtrip() {
    let note = NoteDocument {
        id: "note_1".to_string(),
        title: "Test Note".to_string(),
        subject_id: None,
        folder_id: None,
        tag_ids: Some(vec!["tag1".to_string()]),
        created_at: 100.0,
        updated_at: 200.0,
        paper_style: PaperStyle::Grid,
        paper_color: PaperColor::Name("yellow".to_string()),
        pattern_color: None,
        page_size: None,
        orientation: None,
        pages: vec![NotePage {
            id: "p1".to_string(),
            page_number: 1,
            strokes: vec![Stroke {
                id: "s1".to_string(),
                tool: "pen".to_string(),
                color: "#ff0000".to_string(),
                width: 2.0,
                opacity: 1.0,
                points: vec![Point {
                    x: 10.0,
                    y: 20.0,
                    pressure: 0.5,
                    t: Some(10.0),
                    alt: None,
                    az: None,
                }],
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
                created_at: None,
                highlight_alpha: None,
                dash_offset: None,
                fill_only: None,
            }],
            latex_blocks: Vec::new(),
            text_blocks: None,
            image_blocks: None,
        }],
        sheets: vec![PageSheet {
            id: "sh1".to_string(),
            paper_style: None,
            paper_color: None,
            pattern_color: None,
            size: None,
            orientation: None,
            width: None,
            height: None,
            pdf: None,
            bookmarked: None,
        }],
        schema_version: Some(SCHEMA_VERSION),
    };

    let backup = LibraryBackup {
        format: "opennote-backup".to_string(),
        version: 2,
        exported_at: 1234567.0,
        subjects: None,
        folders: Some(Vec::new()),
        tags: Some(Vec::new()),
        notes: vec![note.clone()],
        files: None,
    };

    // JSON export / import
    let json = export_backup_json(&backup).expect("export json");
    let imported_backup = import_backup_json(&json).expect("import json");
    assert_eq!(imported_backup.notes.len(), 1);
    assert_eq!(imported_backup.notes[0].id, note.id);
    assert_eq!(imported_backup.notes[0].title, note.title);

    // Zip export / import
    let mut zip_buffer = Cursor::new(Vec::new());
    export_opennote_zip(&mut zip_buffer, &backup).expect("export zip");

    zip_buffer.set_position(0);
    let imported_zip = import_opennote_zip(&mut zip_buffer).expect("import zip");
    assert_eq!(imported_zip.notes.len(), 1);
    assert_eq!(imported_zip.notes[0].id, note.id);
    assert_eq!(imported_zip.notes[0].title, note.title);
}

#[test]
fn test_schema_migration() {
    let old_v1_note = NoteDocument {
        id: "old".to_string(),
        title: "Old Note".to_string(),
        subject_id: Some("subj_123".to_string()),
        folder_id: None,
        tag_ids: None,
        created_at: 10.0,
        updated_at: 20.0,
        paper_style: PaperStyle::Ruled,
        paper_color: PaperColor::Name("white".to_string()),
        pattern_color: None,
        page_size: None,
        orientation: None,
        pages: vec![NotePage {
            id: "page1".to_string(),
            page_number: 1,
            strokes: vec![],
            latex_blocks: vec![],
            text_blocks: None,
            image_blocks: None,
        }],
        sheets: vec![],
        schema_version: None, // old version
    };

    let migrated = migrate_note(old_v1_note);
    assert_eq!(migrated.schema_version, Some(SCHEMA_VERSION));
    assert_eq!(migrated.folder_id, Some("subj_123".to_string()));
    assert_eq!(migrated.subject_id, None);
    assert!(!migrated.sheets.is_empty(), "Sheets should be generated");
}
