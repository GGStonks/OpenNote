use crate::migration::migrate_note;
use crate::types::{LibraryBackup, NoteDocument};
use std::io::{Read, Seek, Write};
use zip::write::SimpleFileOptions;
use zip::{ZipArchive, ZipWriter};

#[derive(Debug)]
pub enum CodecError {
    Json(serde_json::Error),
    Zip(zip::result::ZipError),
    Io(std::io::Error),
    InvalidFormat(String),
}

impl From<serde_json::Error> for CodecError {
    fn from(e: serde_json::Error) -> Self {
        CodecError::Json(e)
    }
}

impl From<zip::result::ZipError> for CodecError {
    fn from(e: zip::result::ZipError) -> Self {
        CodecError::Zip(e)
    }
}

impl From<std::io::Error> for CodecError {
    fn from(e: std::io::Error) -> Self {
        CodecError::Io(e)
    }
}

pub fn export_backup_json(backup: &LibraryBackup) -> Result<String, CodecError> {
    Ok(serde_json::to_string(backup)?)
}

pub fn import_backup_json(json_str: &str) -> Result<LibraryBackup, CodecError> {
    let value: serde_json::Value = serde_json::from_str(json_str)?;

    if value.get("format").and_then(|f| f.as_str()) == Some("opennote-backup") {
        let mut backup: LibraryBackup = serde_json::from_value(value)?;
        backup.notes = backup.notes.into_iter().map(migrate_note).collect();
        Ok(backup)
    } else if value.get("pages").is_some() && value.get("id").is_some() {
        let note: NoteDocument = serde_json::from_value(value)?;
        let migrated = migrate_note(note);
        Ok(LibraryBackup {
            format: "opennote-backup".to_string(),
            version: 2,
            exported_at: 0.0,
            subjects: None,
            folders: Some(Vec::new()),
            tags: Some(Vec::new()),
            notes: vec![migrated],
            files: None,
        })
    } else {
        Err(CodecError::InvalidFormat(
            "Payload is neither an OpenNote backup nor a single NoteDocument".to_string(),
        ))
    }
}

pub fn export_opennote_zip<W: Write + Seek>(
    writer: W,
    backup: &LibraryBackup,
) -> Result<(), CodecError> {
    let mut zip = ZipWriter::new(writer);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    zip.start_file("backup.json", options)?;
    let json = serde_json::to_vec_pretty(backup)?;
    zip.write_all(&json)?;

    if let Some(files) = &backup.files {
        for file in files {
            if let Ok(bytes) = base64::Engine::decode(
                &base64::engine::general_purpose::STANDARD,
                &file.base64,
            ) {
                let filename = format!("files/{}", file.id);
                zip.start_file(filename, options)?;
                zip.write_all(&bytes)?;
            }
        }
    }

    zip.finish()?;
    Ok(())
}

pub fn import_opennote_zip<R: Read + Seek>(reader: R) -> Result<LibraryBackup, CodecError> {
    let mut zip = ZipArchive::new(reader)?;

    let mut backup_content = String::new();
    let has_backup = zip.by_name("backup.json").is_ok();
    let has_note = !has_backup && zip.by_name("note.json").is_ok();

    if has_backup {
        let mut file = zip.by_name("backup.json")?;
        file.read_to_string(&mut backup_content)?;
    } else if has_note {
        let mut file = zip.by_name("note.json")?;
        file.read_to_string(&mut backup_content)?;
    } else {
        return Err(CodecError::InvalidFormat(
            "Missing backup.json or note.json in zip archive".to_string(),
        ));
    }

    import_backup_json(&backup_content)
}

