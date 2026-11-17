use model::{
    export_backup_json, export_packed_note_json, import_backup_json, import_note_json, pack_note,
    unpack_note, BackupFile, Folder, LibraryBackup, ModeledKind, NoteDocument, NotePage, PageSheet,
    PaperColor, PaperStyle, PdfPageRef, Point, Stroke, Tag, SCHEMA_VERSION,
};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

fn get_workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crates dir")
        .parent()
        .expect("workspace root")
        .to_path_buf()
}

fn get_storage_dir() -> PathBuf {
    get_workspace_root().join("bench/rust-ref/storage")
}

fn get_recordings_dir() -> PathBuf {
    get_workspace_root().join("bench/recordings")
}

fn build_expected_strokes() -> Vec<Stroke> {
    let rec_dir = get_recordings_dir();
    let mut entries: Vec<_> = fs::read_dir(&rec_dir)
        .expect("bench/recordings should exist")
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("json"))
        .collect();
    entries.sort_by_key(|e| e.path());

    let mut strokes: Vec<Stroke> = Vec::new();
    let mut stroke_idx = 0;

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

                    strokes.push(Stroke {
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

    // Empty stroke
    strokes.push(Stroke {
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

    strokes
}

fn build_expected_note_and_backup() -> (NoteDocument, LibraryBackup) {
    let strokes = build_expected_strokes();
    let note = NoteDocument {
        id: "note_storage_roundtrip".to_string(),
        title: "Storage Roundtrip Note".to_string(),
        subject_id: None,
        folder_id: Some("folder_1".to_string()),
        tag_ids: Some(vec!["tag_1".to_string()]),
        created_at: 1000.0,
        updated_at: 2000.0,
        paper_style: PaperStyle::Ruled,
        paper_color: PaperColor::Name("white".to_string()),
        pattern_color: None,
        page_size: None,
        orientation: None,
        pages: vec![
            NotePage {
                id: "p1".to_string(),
                page_number: 1,
                strokes,
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
        sheets: vec![
            PageSheet {
                id: "sh1".to_string(),
                paper_style: None,
                paper_color: None,
                pattern_color: None,
                size: None,
                orientation: None,
                width: None,
                height: None,
                pdf: Some(PdfPageRef {
                    file: "pdf_file_1".to_string(),
                    page: 1,
                }),
                bookmarked: None,
            },
            PageSheet {
                id: "sh2".to_string(),
                paper_style: None,
                paper_color: None,
                pattern_color: None,
                size: None,
                orientation: None,
                width: None,
                height: None,
                pdf: None,
                bookmarked: None,
            },
        ],
        schema_version: Some(SCHEMA_VERSION),
    };

    let pdf_file = BackupFile {
        id: "pdf_file_1".to_string(),
        name: Some("test_document.pdf".to_string()),
        mime: Some("application/pdf".to_string()),
        base64: "JVBERi0xLjQgbW9jayBwZGYgY29udGVudCBmb3Igc3RvcmFnZSByb3VuZHRyaXAgdGVzdA==".to_string(),
        password: None,
    };

    let backup = LibraryBackup {
        format: "opennote-backup".to_string(),
        version: 2,
        exported_at: 1700000000000.0,
        subjects: None,
        folders: Some(vec![Folder {
            id: "folder_1".to_string(),
            name: "Work".to_string(),
            parent_id: None,
            color: Some("#3b82f6".to_string()),
            created_at: 1000.0,
        }]),
        tags: Some(vec![Tag {
            id: "tag_1".to_string(),
            name: "Important".to_string(),
            color: "#ef4444".to_string(),
        }]),
        notes: vec![note.clone()],
        files: Some(vec![pdf_file]),
    };

    (note, backup)
}

#[test]
fn test_ts_roundtrip_backup_and_opennote() {
    let storage_dir = get_storage_dir();
    let backup_path = storage_dir.join("backup.json");
    let note_path = storage_dir.join("note.opennote");

    if !backup_path.exists() || !note_path.exists() {
        fs::create_dir_all(&storage_dir).expect("create storage dir");
        let (note, backup) = build_expected_note_and_backup();
        let backup_json = export_backup_json(&backup).expect("export backup");
        fs::write(&backup_path, backup_json).expect("write backup.json");
        let note_json =
            export_packed_note_json(&note, backup.files.as_deref()).expect("export packed note");
        fs::write(&note_path, note_json).expect("write note.opennote");
    }

    assert!(
        backup_path.exists(),
        "backup.json must exist in {:?}",
        storage_dir
    );
    assert!(
        note_path.exists(),
        "note.opennote must exist in {:?}",
        storage_dir
    );

    // 1. Read TS-written backup.json
    let backup_str = fs::read_to_string(&backup_path).expect("read backup.json");
    let backup = import_backup_json(&backup_str).expect("parse TS backup.json");

    assert_eq!(backup.format, "opennote-backup");
    assert_eq!(backup.version, 2);
    assert!(backup.folders.is_some(), "backup should contain folders");
    let folders = backup.folders.as_ref().unwrap();
    assert_eq!(folders.len(), 1);
    assert_eq!(folders[0].id, "folder_1");
    assert_eq!(folders[0].name, "Work");

    assert!(backup.tags.is_some(), "backup should contain tags");
    let tags = backup.tags.as_ref().unwrap();
    assert_eq!(tags.len(), 1);
    assert_eq!(tags[0].id, "tag_1");
    assert_eq!(tags[0].name, "Important");

    assert!(backup.files.is_some(), "backup should contain files");
    let files = backup.files.as_ref().unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].id, "pdf_file_1");
    assert_eq!(files[0].name.as_deref(), Some("test_document.pdf"));
    assert_eq!(files[0].mime.as_deref(), Some("application/pdf"));

    assert_eq!(backup.notes.len(), 1);
    let note_from_backup = &backup.notes[0];

    // 2. Read TS-written note.opennote
    let note_str = fs::read_to_string(&note_path).expect("read note.opennote");
    let (note_from_file, files_from_file) =
        import_note_json(&note_str).expect("parse TS note.opennote");

    assert_eq!(files_from_file.as_ref(), Some(files));
    assert_eq!(note_from_file, *note_from_backup);

    // 3. Verify strokes and points against bench/recordings
    let expected_strokes = build_expected_strokes();
    let total_points: usize = expected_strokes.iter().map(|s| s.points.len()).sum();
    assert!(total_points > 30000);

    // Verify stroke by stroke and point by point exact match
    assert_eq!(
        note_from_backup.pages[0].strokes.len(),
        expected_strokes.len(),
        "Stroke count match"
    );
    for (i, (actual, expected)) in note_from_backup.pages[0]
        .strokes
        .iter()
        .zip(expected_strokes.iter())
        .enumerate()
    {
        assert_eq!(actual.id, expected.id, "Stroke {} id match", i);
        assert_eq!(actual.tool, expected.tool, "Stroke {} tool match", i);
        assert_eq!(actual.color, expected.color, "Stroke {} color match", i);
        assert_eq!(actual.width, expected.width, "Stroke {} width match", i);
        assert_eq!(actual.opacity, expected.opacity, "Stroke {} opacity match", i);
        assert_eq!(actual.modeled, expected.modeled, "Stroke {} modeled match", i);
        assert_eq!(actual.rotation, expected.rotation, "Stroke {} rotation match", i);
        assert_eq!(
            actual.created_at, expected.created_at,
            "Stroke {} created_at match",
            i
        );
        assert_eq!(
            actual.points.len(),
            expected.points.len(),
            "Stroke {} point count match",
            i
        );
        assert_eq!(actual.points, expected.points, "Stroke {} points match", i);
    }

    // Sheets match
    assert_eq!(note_from_backup.sheets.len(), 2);
    assert_eq!(
        note_from_backup.sheets[0].pdf.as_ref().map(|p| p.file.as_str()),
        Some("pdf_file_1")
    );

    // 4. Test pack / unpack round-trip in Rust on this note
    let packed = pack_note(note_from_backup);
    let unpacked = unpack_note(&packed);
    assert_eq!(
        *note_from_backup, unpacked,
        "Rust pack -> unpack exact round-trip"
    );

    // 5. Rust writes both back
    let rust_backup_json = export_backup_json(&backup).expect("export backup json");
    fs::write(storage_dir.join("backup.rust.json"), rust_backup_json)
        .expect("write backup.rust.json");

    let rust_note_json =
        export_packed_note_json(note_from_backup, backup.files.as_deref())
            .expect("export note json");
    fs::write(storage_dir.join("note.rust.opennote"), rust_note_json)
        .expect("write note.rust.opennote");
}
