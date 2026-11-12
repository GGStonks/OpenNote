use base64::prelude::*;
pub use model::*;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum StoreError {
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("JSON serialization error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Not found: {0}")]
    NotFound(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct StoredFile {
    pub id: String,
    pub name: String,
    pub mime: String,
    pub bytes: Vec<u8>,
    pub password: Option<String>,
    pub created_at: f64,
}

pub struct SqliteStore {
    conn: Connection,
}

impl SqliteStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let conn = Connection::open(path)?;
        let store = Self { conn };
        store.init_schema()?;
        Ok(store)
    }

    pub fn open_in_memory() -> Result<Self, StoreError> {
        let conn = Connection::open_in_memory()?;
        let store = Self { conn };
        store.init_schema()?;
        Ok(store)
    }

    fn init_schema(&self) -> Result<(), StoreError> {
        self.conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS notes (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                folder_id TEXT,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                data TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(updated_at DESC);

            CREATE TABLE IF NOT EXISTS folders (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                parent_id TEXT,
                color TEXT,
                created_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS tags (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                color TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS files (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                mime TEXT NOT NULL,
                bytes BLOB NOT NULL,
                password TEXT,
                created_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS audio (
                id TEXT PRIMARY KEY,
                note_id TEXT NOT NULL,
                created_at REAL NOT NULL,
                duration_ms REAL NOT NULL,
                mime_type TEXT NOT NULL,
                bytes BLOB NOT NULL
            );

            CREATE TABLE IF NOT EXISTS thumbs (
                page_id TEXT PRIMARY KEY,
                note_id TEXT NOT NULL,
                bytes BLOB NOT NULL,
                updated_at REAL NOT NULL
            );
            ",
        )?;
        Ok(())
    }

    pub fn save_note(&self, note: &NoteDocument) -> Result<(), StoreError> {
        let packed = pack_note(note);
        let data = serde_json::to_string(&packed)?;
        self.conn.execute(
            "INSERT OR REPLACE INTO notes (id, title, folder_id, created_at, updated_at, data)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                note.id,
                note.title,
                note.folder_id,
                note.created_at,
                note.updated_at,
                data
            ],
        )?;
        Ok(())
    }

    pub fn get_note(&self, id: &str) -> Result<Option<NoteDocument>, StoreError> {
        let mut stmt = self.conn.prepare("SELECT data FROM notes WHERE id = ?1")?;
        let res: Option<String> = stmt.query_row(params![id], |row| row.get(0)).optional()?;
        match res {
            None => Ok(None),
            Some(data) => {
                let stored: StoredNoteDocument = serde_json::from_str(&data)?;
                let doc = unpack_note(&stored);
                Ok(Some(migrate_note(doc)))
            }
        }
    }

    pub fn delete_note(&self, id: &str) -> Result<bool, StoreError> {
        let count = self
            .conn
            .execute("DELETE FROM notes WHERE id = ?1", params![id])?;
        Ok(count > 0)
    }

    pub fn get_all_notes(&self) -> Result<Vec<NoteDocument>, StoreError> {
        let mut stmt = self
            .conn
            .prepare("SELECT data FROM notes ORDER BY updated_at DESC")?;
        let rows = stmt.query_map([], |row| {
            let data: String = row.get(0)?;
            Ok(data)
        })?;

        let mut out = Vec::new();
        for r in rows {
            let data = r?;
            let stored: StoredNoteDocument = serde_json::from_str(&data)?;
            let doc = unpack_note(&stored);
            out.push(migrate_note(doc));
        }
        Ok(out)
    }

    pub fn save_folders(&self, folders: &[Folder]) -> Result<(), StoreError> {
        let tx = self.conn.unchecked_transaction()?;
        for f in folders {
            tx.execute(
                "INSERT OR REPLACE INTO folders (id, name, parent_id, color, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![f.id, f.name, f.parent_id, f.color, f.created_at],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn get_all_folders(&self) -> Result<Vec<Folder>, StoreError> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, name, parent_id, color, created_at FROM folders ORDER BY created_at ASC")?;
        let rows = stmt.query_map([], |row| {
            Ok(Folder {
                id: row.get(0)?,
                name: row.get(1)?,
                parent_id: row.get(2)?,
                color: row.get(3)?,
                created_at: row.get(4)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn delete_folder(&self, id: &str) -> Result<bool, StoreError> {
        let count = self
            .conn
            .execute("DELETE FROM folders WHERE id = ?1", params![id])?;
        Ok(count > 0)
    }

    pub fn save_tags(&self, tags: &[Tag]) -> Result<(), StoreError> {
        let tx = self.conn.unchecked_transaction()?;
        for t in tags {
            tx.execute(
                "INSERT OR REPLACE INTO tags (id, name, color) VALUES (?1, ?2, ?3)",
                params![t.id, t.name, t.color],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn get_all_tags(&self) -> Result<Vec<Tag>, StoreError> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, name, color FROM tags ORDER BY name ASC")?;
        let rows = stmt.query_map([], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn put_file(
        &self,
        id: &str,
        name: &str,
        mime: &str,
        bytes: &[u8],
        password: Option<&str>,
    ) -> Result<(), StoreError> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as f64;
        self.conn.execute(
            "INSERT OR REPLACE INTO files (id, name, mime, bytes, password, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, name, mime, bytes, password, now],
        )?;
        Ok(())
    }

    pub fn get_file(&self, id: &str) -> Result<Option<StoredFile>, StoreError> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, name, mime, bytes, password, created_at FROM files WHERE id = ?1")?;
        let res = stmt
            .query_row(params![id], |row| {
                Ok(StoredFile {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    mime: row.get(2)?,
                    bytes: row.get(3)?,
                    password: row.get(4)?,
                    created_at: row.get(5)?,
                })
            })
            .optional()?;
        Ok(res)
    }

    pub fn delete_file(&self, id: &str) -> Result<bool, StoreError> {
        let count = self
            .conn
            .execute("DELETE FROM files WHERE id = ?1", params![id])?;
        Ok(count > 0)
    }

    pub fn put_thumb(&self, page_id: &str, note_id: &str, bytes: &[u8]) -> Result<(), StoreError> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as f64;
        self.conn.execute(
            "INSERT OR REPLACE INTO thumbs (page_id, note_id, bytes, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![page_id, note_id, bytes, now],
        )?;
        Ok(())
    }

    pub fn get_thumb(&self, page_id: &str) -> Result<Option<Vec<u8>>, StoreError> {
        let mut stmt = self
            .conn
            .prepare("SELECT bytes FROM thumbs WHERE page_id = ?1")?;
        let res: Option<Vec<u8>> = stmt.query_row(params![page_id], |row| row.get(0)).optional()?;
        Ok(res)
    }

    pub fn save_audio(&self, audio: &AudioRecording, bytes: &[u8]) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT OR REPLACE INTO audio (id, note_id, created_at, duration_ms, mime_type, bytes)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                audio.id,
                audio.note_id,
                audio.created_at,
                audio.duration_ms,
                audio.mime_type,
                bytes
            ],
        )?;
        Ok(())
    }

    pub fn get_audio(&self, id: &str) -> Result<Option<(AudioRecording, Vec<u8>)>, StoreError> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, note_id, created_at, duration_ms, mime_type, bytes FROM audio WHERE id = ?1")?;
        let res = stmt
            .query_row(params![id], |row| {
                let rec = AudioRecording {
                    id: row.get(0)?,
                    note_id: row.get(1)?,
                    created_at: row.get(2)?,
                    duration_ms: row.get(3)?,
                    mime_type: row.get(4)?,
                };
                let bytes: Vec<u8> = row.get(5)?;
                Ok((rec, bytes))
            })
            .optional()?;
        Ok(res)
    }

    pub fn import_backup(&self, backup: &LibraryBackup) -> Result<usize, StoreError> {
        if let Some(folders) = &backup.folders {
            self.save_folders(folders)?;
        }
        if let Some(tags) = &backup.tags {
            self.save_tags(tags)?;
        }
        if let Some(files) = &backup.files {
            for f in files {
                if let Ok(bytes) = BASE64_STANDARD.decode(&f.base64) {
                    let name = f.name.as_deref().unwrap_or("file");
                    let mime = f.mime.as_deref().unwrap_or("application/octet-stream");
                    self.put_file(&f.id, name, mime, &bytes, f.password.as_deref())?;
                }
            }
        }
        for n in &backup.notes {
            self.save_note(&migrate_note(n.clone()))?;
        }
        Ok(backup.notes.len())
    }

    pub fn export_backup(&self) -> Result<LibraryBackup, StoreError> {
        let notes = self.get_all_notes()?;
        let folders = self.get_all_folders()?;
        let tags = self.get_all_tags()?;

        let mut stmt = self
            .conn
            .prepare("SELECT id, name, mime, bytes, password FROM files")?;
        let rows = stmt.query_map([], |row| {
            let id: String = row.get(0)?;
            let name: String = row.get(1)?;
            let mime: String = row.get(2)?;
            let bytes: Vec<u8> = row.get(3)?;
            let password: Option<String> = row.get(4)?;
            let b64 = BASE64_STANDARD.encode(&bytes);
            Ok(BackupFile {
                id,
                name: Some(name),
                mime: Some(mime),
                base64: b64,
                password,
            })
        })?;
        let mut files = Vec::new();
        for r in rows {
            files.push(r?);
        }

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as f64;

        Ok(LibraryBackup {
            format: "opennote-backup".to_string(),
            version: 2,
            exported_at: now,
            subjects: None,
            folders: Some(folders),
            tags: Some(tags),
            notes,
            files: Some(files),
        })
    }
}
