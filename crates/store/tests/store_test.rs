use model::{NoteDocument, NotePage, PageSheet, PaperColor, PaperStyle, SCHEMA_VERSION};
use store::{AudioRecording, Folder, SqliteStore, Tag};

#[test]
fn test_store_notes_crud() {
    let store = SqliteStore::open_in_memory().expect("open store");

    let note = NoteDocument {
        id: "note_1".to_string(),
        title: "Grocery List".to_string(),
        subject_id: None,
        folder_id: None,
        tag_ids: None,
        created_at: 100.0,
        updated_at: 200.0,
        paper_style: PaperStyle::Ruled,
        paper_color: PaperColor::Name("white".to_string()),
        pattern_color: None,
        page_size: None,
        orientation: None,
        pages: vec![NotePage {
            id: "p1".to_string(),
            page_number: 1,
            strokes: Vec::new(),
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

    store.save_note(&note).expect("save note");

    let loaded = store
        .get_note("note_1")
        .expect("get note")
        .expect("should exist");
    assert_eq!(loaded.id, "note_1");
    assert_eq!(loaded.title, "Grocery List");

    let all = store.get_all_notes().expect("get all notes");
    assert_eq!(all.len(), 1);

    let deleted = store.delete_note("note_1").expect("delete note");
    assert!(deleted);
    let after_delete = store.get_note("note_1").expect("get note");
    assert!(after_delete.is_none());
}

#[test]
fn test_store_folders_and_tags() {
    let store = SqliteStore::open_in_memory().expect("open store");

    let folders = vec![
        Folder {
            id: "f1".to_string(),
            name: "Work".to_string(),
            parent_id: None,
            color: Some("#ff0000".to_string()),
            created_at: 10.0,
        },
        Folder {
            id: "f2".to_string(),
            name: "Personal".to_string(),
            parent_id: None,
            color: None,
            created_at: 20.0,
        },
    ];
    store.save_folders(&folders).expect("save folders");
    let loaded_folders = store.get_all_folders().expect("get folders");
    assert_eq!(loaded_folders.len(), 2);
    assert_eq!(loaded_folders[0].name, "Work");

    let tags = vec![Tag {
        id: "t1".to_string(),
        name: "Urgent".to_string(),
        color: "#f00".to_string(),
    }];
    store.save_tags(&tags).expect("save tags");
    let loaded_tags = store.get_all_tags().expect("get tags");
    assert_eq!(loaded_tags.len(), 1);
    assert_eq!(loaded_tags[0].name, "Urgent");
}

#[test]
fn test_store_files_and_thumbs() {
    let store = SqliteStore::open_in_memory().expect("open store");

    store
        .put_file("file1", "document.pdf", "application/pdf", b"PDF_DATA", None)
        .expect("put file");
    let f = store
        .get_file("file1")
        .expect("get file")
        .expect("file exists");
    assert_eq!(f.name, "document.pdf");
    assert_eq!(f.bytes, b"PDF_DATA");

    store
        .put_thumb("page1", "note1", b"THUMB_IMAGE")
        .expect("put thumb");
    let thumb = store
        .get_thumb("page1")
        .expect("get thumb")
        .expect("thumb exists");
    assert_eq!(thumb, b"THUMB_IMAGE");
}

#[test]
fn test_store_audio() {
    let store = SqliteStore::open_in_memory().expect("open store");

    let rec = AudioRecording {
        id: "a1".to_string(),
        note_id: "n1".to_string(),
        created_at: 50.0,
        duration_ms: 1000.0,
        mime_type: "audio/webm".to_string(),
    };
    store.save_audio(&rec, b"AUDIO_BYTES").expect("save audio");
    let (loaded_rec, bytes) = store
        .get_audio("a1")
        .expect("get audio")
        .expect("audio exists");
    assert_eq!(loaded_rec.id, "a1");
    assert_eq!(bytes, b"AUDIO_BYTES");
}

#[test]
fn test_store_backup_roundtrip() {
    let store = SqliteStore::open_in_memory().expect("open store");

    let note = NoteDocument {
        id: "note_bk".to_string(),
        title: "Backup Note".to_string(),
        subject_id: None,
        folder_id: None,
        tag_ids: None,
        created_at: 100.0,
        updated_at: 200.0,
        paper_style: PaperStyle::Grid,
        paper_color: PaperColor::Name("cream".to_string()),
        pattern_color: None,
        page_size: None,
        orientation: None,
        pages: vec![],
        sheets: vec![],
        schema_version: Some(SCHEMA_VERSION),
    };
    store.save_note(&note).expect("save note");
    store
        .put_file("f_bk", "test.txt", "text/plain", b"Hello Backup", None)
        .expect("put file");

    let backup = store.export_backup().expect("export backup");
    assert_eq!(backup.notes.len(), 1);
    assert_eq!(backup.notes[0].title, "Backup Note");
    assert_eq!(backup.files.as_ref().unwrap().len(), 1);

    // Import into fresh store
    let store2 = SqliteStore::open_in_memory().expect("open store 2");
    store2.import_backup(&backup).expect("import backup");
    let note2 = store2
        .get_note("note_bk")
        .expect("get note")
        .expect("exists");
    assert_eq!(note2.title, "Backup Note");
    let f2 = store2.get_file("f_bk").expect("get file").expect("exists");
    assert_eq!(f2.bytes, b"Hello Backup");
}

