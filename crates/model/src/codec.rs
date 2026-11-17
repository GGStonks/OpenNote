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

fn deserialize_note_value(value: serde_json::Value) -> Result<NoteDocument, CodecError> {
    let has_pts = value
        .get("pages")
        .and_then(|p| p.as_array())
        .map(|pages| {
            pages.iter().any(|page| {
                page.get("strokes")
                    .and_then(|s| s.as_array())
                    .map(|strokes| {
                        strokes.iter().any(|st| st.get("pts").is_some())
                    })
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false);

    if has_pts {
        let stored: crate::packed::StoredNoteDocument = serde_json::from_value(value)?;
        Ok(crate::packed::unpack_note(&stored))
    } else {
        let note: NoteDocument = serde_json::from_value(value)?;
        Ok(note)
    }
}

pub fn import_backup_json(json_str: &str) -> Result<LibraryBackup, CodecError> {
    let mut value: serde_json::Value = serde_json::from_str(json_str)?;

    if value.get("format").and_then(|f| f.as_str()) == Some("opennote-backup") {
        let notes_val = value.get_mut("notes").and_then(|n| n.as_array_mut());
        let notes: Vec<NoteDocument> = if let Some(notes_arr) = notes_val {
            let mut res = Vec::with_capacity(notes_arr.len());
            for n in notes_arr.drain(..) {
                res.push(migrate_note(deserialize_note_value(n)?));
            }
            res
        } else {
            Vec::new()
        };

        let mut backup: LibraryBackup = serde_json::from_value(value)?;
        backup.notes = notes;
        Ok(backup)
    } else if value.get("pages").is_some() && value.get("id").is_some() {
        let files: Option<Vec<crate::types::BackupFile>> = match value.get("files") {
            None => None,
            Some(f) => Some(serde_json::from_value(f.clone())?),
        };
        let note = deserialize_note_value(value)?;
        let migrated = migrate_note(note);
        Ok(LibraryBackup {
            format: "opennote-backup".to_string(),
            version: 2,
            exported_at: 0.0,
            subjects: None,
            folders: Some(Vec::new()),
            tags: Some(Vec::new()),
            notes: vec![migrated],
            files,
        })
    } else {
        Err(CodecError::InvalidFormat(
            "Payload is neither an OpenNote backup nor a single NoteDocument".to_string(),
        ))
    }
}

pub fn export_note_json(
    note: &NoteDocument,
    files: Option<&[crate::types::BackupFile]>,
) -> Result<String, CodecError> {
    let mut val = serde_json::to_value(note)?;
    if let Some(files) = files {
        if !files.is_empty() {
            if let Some(map) = val.as_object_mut() {
                map.insert("files".to_string(), serde_json::to_value(files)?);
            }
        }
    }
    Ok(serde_json::to_string(&val)?)
}

pub fn export_packed_note_json(
    note: &NoteDocument,
    files: Option<&[crate::types::BackupFile]>,
) -> Result<String, CodecError> {
    let stored = crate::packed::pack_note(note);
    let mut val = serde_json::to_value(&stored)?;
    if let Some(files) = files {
        if !files.is_empty() {
            if let Some(map) = val.as_object_mut() {
                map.insert("files".to_string(), serde_json::to_value(files)?);
            }
        }
    }
    Ok(serde_json::to_string(&val)?)
}

pub fn import_note_json(
    json_str: &str,
) -> Result<(NoteDocument, Option<Vec<crate::types::BackupFile>>), CodecError> {
    let value: serde_json::Value = serde_json::from_str(json_str)?;
    if value.get("pages").is_none() || value.get("id").is_none() {
        return Err(CodecError::InvalidFormat(
            "Payload is not a single NoteDocument".to_string(),
        ));
    }
    let files: Option<Vec<crate::types::BackupFile>> = match value.get("files") {
        None => None,
        Some(f) => Some(serde_json::from_value(f.clone())?),
    };
    let note = deserialize_note_value(value)?;
    Ok((migrate_note(note), files))
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

