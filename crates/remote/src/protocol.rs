//! Binary Wire Protocol for OpenNote Ultra-Low-Latency Vector Mirroring.
//!
//! Little-endian 8-byte header followed by binary payload.

use bytes::{BufMut, Bytes, BytesMut};

pub const MAGIC: u16 = 0x4F4E; // "ON" in LE: [0x4E, 0x4F]
pub const PROTOCOL_VERSION: u8 = 0x01;
pub const HEADER_LEN: usize = 8;
pub const MAX_PAYLOAD_LEN: usize = 16 * 1024 * 1024; // 16 MB

pub const FNV_OFFSET_BASIS: u128 = 0x6c62272e07bb014262b821756295c58d;
pub const FNV_PRIME: u128 = 0x0000000001000000000000000000013b;

/// 128-bit FNV-1a PIN hash (encoded as little-endian 16 bytes).
pub fn hash_pin(pin: &str) -> [u8; 16] {
    let mut hash = FNV_OFFSET_BASIS;
    for &b in pin.as_bytes() {
        hash ^= b as u128;
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash.to_le_bytes()
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum ProtocolError {
    #[error("Truncated header: expected 8 bytes, got {0}")]
    TruncatedHeader(usize),
    #[error("Invalid magic: expected 0x4F4E, got 0x{0:04X}")]
    InvalidMagic(u16),
    #[error("Invalid version: expected 1, got {0}")]
    InvalidVersion(u8),
    #[error("Unknown message type: 0x{0:02X}")]
    UnknownMsgType(u8),
    #[error("Payload too large: {0} bytes (max 16 MB)")]
    PayloadTooLarge(u32),
    #[error("Truncated payload: expected {expected} bytes, got {got}")]
    TruncatedPayload { expected: usize, got: usize },
    #[error("Trailing garbage: {0} bytes")]
    TrailingBytes(usize),
    #[error("Invalid UTF-8 in string field: {0}")]
    InvalidUtf8(String),
    #[error("Point count mismatch: header says {expected}, buffer has {got}")]
    InvalidPointCount { expected: usize, got: usize },
    #[error("Decompression failed: {0}")]
    DecompressError(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum MsgType {
    Handshake = 0x01,
    Camera = 0x02,
    StrokeLiveAdd = 0x03,
    StrokeCommit = 0x04,
    LaserPointer = 0x05,
    DocumentSync = 0x06,
}

impl TryFrom<u8> for MsgType {
    type Error = ProtocolError;
    fn try_from(val: u8) -> Result<Self, Self::Error> {
        match val {
            0x01 => Ok(MsgType::Handshake),
            0x02 => Ok(MsgType::Camera),
            0x03 => Ok(MsgType::StrokeLiveAdd),
            0x04 => Ok(MsgType::StrokeCommit),
            0x05 => Ok(MsgType::LaserPointer),
            0x06 => Ok(MsgType::DocumentSync),
            other => Err(ProtocolError::UnknownMsgType(other)),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum ToolType {
    Pen = 0,
    Pencil = 1,
    Highlighter = 2,
    Eraser = 3,
}

impl From<u8> for ToolType {
    fn from(val: u8) -> Self {
        match val {
            0 => ToolType::Pen,
            1 => ToolType::Pencil,
            2 => ToolType::Highlighter,
            3 => ToolType::Eraser,
            _ => ToolType::Pen,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct HandshakePayload {
    pub client_version: u32,
    pub display_dpi: f32,
    pub auth_token_hash: [u8; 16],
}

pub const CAMERA_FLAG_IN_MOTION: u32 = 1 << 0;
pub const CAMERA_FLAG_MOMENTUM_GLIDE: u32 = 1 << 1;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CameraPayload {
    pub timestamp_us: u64,
    pub x: f32,
    pub y: f32,
    pub zoom: f32,
    pub rotation: f32,
    pub flags: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PointData {
    pub x: f32,
    pub y: f32,
    pub pressure: f32,
    pub t_ms: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StrokeLiveAddPayload {
    pub stroke_id: u32,
    pub tool_type: ToolType,
    pub color_rgba: u32,
    pub base_width: f32,
    pub points: Vec<PointData>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StrokeCommitPayload {
    pub stroke_id: u32,
    pub page_id: String,
    pub stroke_key: u64,
    pub bbox: [f32; 4],
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LaserPointerPayload {
    pub x: f32,
    pub y: f32,
    pub intensity: f32,
    pub color_rgba: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DocumentSyncPayload {
    pub raw_scene: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Packet {
    Handshake(HandshakePayload),
    Camera(CameraPayload),
    StrokeLiveAdd(StrokeLiveAddPayload),
    StrokeCommit(StrokeCommitPayload),
    LaserPointer(LaserPointerPayload),
    DocumentSync(DocumentSyncPayload),
}

impl Packet {
    pub fn msg_type(&self) -> MsgType {
        match self {
            Packet::Handshake(_) => MsgType::Handshake,
            Packet::Camera(_) => MsgType::Camera,
            Packet::StrokeLiveAdd(_) => MsgType::StrokeLiveAdd,
            Packet::StrokeCommit(_) => MsgType::StrokeCommit,
            Packet::LaserPointer(_) => MsgType::LaserPointer,
            Packet::DocumentSync(_) => MsgType::DocumentSync,
        }
    }

    pub fn encode(&self) -> Bytes {
        let mut buf = BytesMut::with_capacity(128);
        self.encode_into(&mut buf);
        buf.freeze()
    }

    pub fn encode_into(&self, buf: &mut BytesMut) {
        let msg_type = self.msg_type() as u8;

        match self {
            Packet::Handshake(p) => {
                buf.reserve(HEADER_LEN + 24);
                buf.put_u16_le(MAGIC);
                buf.put_u8(PROTOCOL_VERSION);
                buf.put_u8(msg_type);
                buf.put_u32_le(24);
                buf.put_u32_le(p.client_version);
                buf.put_f32_le(p.display_dpi);
                buf.put_slice(&p.auth_token_hash);
            }
            Packet::Camera(p) => {
                buf.reserve(HEADER_LEN + 28);
                buf.put_u16_le(MAGIC);
                buf.put_u8(PROTOCOL_VERSION);
                buf.put_u8(msg_type);
                buf.put_u32_le(28);
                buf.put_u64_le(p.timestamp_us);
                buf.put_f32_le(p.x);
                buf.put_f32_le(p.y);
                buf.put_f32_le(p.zoom);
                buf.put_f32_le(p.rotation);
                buf.put_u32_le(p.flags);
            }
            Packet::StrokeLiveAdd(p) => {
                let point_count = p.points.len() as u16;
                let payload_len = 15 + (point_count as usize) * 16;
                buf.reserve(HEADER_LEN + payload_len);
                buf.put_u16_le(MAGIC);
                buf.put_u8(PROTOCOL_VERSION);
                buf.put_u8(msg_type);
                buf.put_u32_le(payload_len as u32);
                buf.put_u32_le(p.stroke_id);
                buf.put_u8(p.tool_type as u8);
                buf.put_u32_le(p.color_rgba);
                buf.put_f32_le(p.base_width);
                buf.put_u16_le(point_count);
                for pt in &p.points {
                    buf.put_f32_le(pt.x);
                    buf.put_f32_le(pt.y);
                    buf.put_f32_le(pt.pressure);
                    buf.put_f32_le(pt.t_ms);
                }
            }
            Packet::StrokeCommit(p) => {
                let page_bytes = p.page_id.as_bytes();
                let page_id_len = page_bytes.len() as u16;
                let payload_len = 30 + (page_id_len as usize);
                buf.reserve(HEADER_LEN + payload_len);
                buf.put_u16_le(MAGIC);
                buf.put_u8(PROTOCOL_VERSION);
                buf.put_u8(msg_type);
                buf.put_u32_le(payload_len as u32);
                buf.put_u32_le(p.stroke_id);
                buf.put_u16_le(page_id_len);
                buf.put_slice(page_bytes);
                buf.put_u64_le(p.stroke_key);
                for b in &p.bbox {
                    buf.put_f32_le(*b);
                }
            }
            Packet::LaserPointer(p) => {
                buf.reserve(HEADER_LEN + 16);
                buf.put_u16_le(MAGIC);
                buf.put_u8(PROTOCOL_VERSION);
                buf.put_u8(msg_type);
                buf.put_u32_le(16);
                buf.put_f32_le(p.x);
                buf.put_f32_le(p.y);
                buf.put_f32_le(p.intensity);
                buf.put_u32_le(p.color_rgba);
            }
            Packet::DocumentSync(p) => {
                let compressed = lz4_flex::compress_prepend_size(&p.raw_scene);
                let payload_len = compressed.len();
                buf.reserve(HEADER_LEN + payload_len);
                buf.put_u16_le(MAGIC);
                buf.put_u8(PROTOCOL_VERSION);
                buf.put_u8(msg_type);
                buf.put_u32_le(payload_len as u32);
                buf.put_slice(&compressed);
            }
        }
    }

    pub fn decode(input: &[u8]) -> Result<Self, ProtocolError> {
        if input.len() < HEADER_LEN {
            return Err(ProtocolError::TruncatedHeader(input.len()));
        }

        let magic = u16::from_le_bytes([input[0], input[1]]);
        if magic != MAGIC {
            return Err(ProtocolError::InvalidMagic(magic));
        }

        let version = input[2];
        if version != PROTOCOL_VERSION {
            return Err(ProtocolError::InvalidVersion(version));
        }

        let msg_type = MsgType::try_from(input[3])?;
        let payload_len = u32::from_le_bytes([input[4], input[5], input[6], input[7]]) as usize;

        if payload_len > MAX_PAYLOAD_LEN {
            return Err(ProtocolError::PayloadTooLarge(payload_len as u32));
        }

        let total_expected = HEADER_LEN + payload_len;
        if input.len() < total_expected {
            return Err(ProtocolError::TruncatedPayload {
                expected: total_expected,
                got: input.len(),
            });
        }
        if input.len() > total_expected {
            return Err(ProtocolError::TrailingBytes(input.len() - total_expected));
        }

        let p = &input[HEADER_LEN..total_expected];

        match msg_type {
            MsgType::Handshake => {
                if p.len() != 24 {
                    return Err(ProtocolError::TruncatedPayload {
                        expected: 24,
                        got: p.len(),
                    });
                }
                let client_version = u32::from_le_bytes([p[0], p[1], p[2], p[3]]);
                let display_dpi = f32::from_le_bytes([p[4], p[5], p[6], p[7]]);
                let mut auth_token_hash = [0u8; 16];
                auth_token_hash.copy_from_slice(&p[8..24]);
                Ok(Packet::Handshake(HandshakePayload {
                    client_version,
                    display_dpi,
                    auth_token_hash,
                }))
            }
            MsgType::Camera => {
                if p.len() != 28 {
                    return Err(ProtocolError::TruncatedPayload {
                        expected: 28,
                        got: p.len(),
                    });
                }
                let timestamp_us =
                    u64::from_le_bytes([p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7]]);
                let x = f32::from_le_bytes([p[8], p[9], p[10], p[11]]);
                let y = f32::from_le_bytes([p[12], p[13], p[14], p[15]]);
                let zoom = f32::from_le_bytes([p[16], p[17], p[18], p[19]]);
                let rotation = f32::from_le_bytes([p[20], p[21], p[22], p[23]]);
                let flags = u32::from_le_bytes([p[24], p[25], p[26], p[27]]);
                Ok(Packet::Camera(CameraPayload {
                    timestamp_us,
                    x,
                    y,
                    zoom,
                    rotation,
                    flags,
                }))
            }
            MsgType::StrokeLiveAdd => {
                if p.len() < 15 {
                    return Err(ProtocolError::TruncatedPayload {
                        expected: 15,
                        got: p.len(),
                    });
                }
                let stroke_id = u32::from_le_bytes([p[0], p[1], p[2], p[3]]);
                let tool_type = ToolType::from(p[4]);
                let color_rgba = u32::from_le_bytes([p[5], p[6], p[7], p[8]]);
                let base_width = f32::from_le_bytes([p[9], p[10], p[11], p[12]]);
                let point_count = u16::from_le_bytes([p[13], p[14]]) as usize;
                let expected_bytes = 15 + point_count * 16;
                if p.len() != expected_bytes {
                    return Err(ProtocolError::InvalidPointCount {
                        expected: point_count,
                        got: (p.len() - 15) / 16,
                    });
                }
                let mut points = Vec::with_capacity(point_count);
                for i in 0..point_count {
                    let off = 15 + i * 16;
                    let x = f32::from_le_bytes([p[off], p[off + 1], p[off + 2], p[off + 3]]);
                    let y = f32::from_le_bytes([p[off + 4], p[off + 5], p[off + 6], p[off + 7]]);
                    let pressure =
                        f32::from_le_bytes([p[off + 8], p[off + 9], p[off + 10], p[off + 11]]);
                    let t_ms =
                        f32::from_le_bytes([p[off + 12], p[off + 13], p[off + 14], p[off + 15]]);
                    points.push(PointData {
                        x,
                        y,
                        pressure,
                        t_ms,
                    });
                }
                Ok(Packet::StrokeLiveAdd(StrokeLiveAddPayload {
                    stroke_id,
                    tool_type,
                    color_rgba,
                    base_width,
                    points,
                }))
            }
            MsgType::StrokeCommit => {
                if p.len() < 30 {
                    return Err(ProtocolError::TruncatedPayload {
                        expected: 30,
                        got: p.len(),
                    });
                }
                let stroke_id = u32::from_le_bytes([p[0], p[1], p[2], p[3]]);
                let page_id_len = u16::from_le_bytes([p[4], p[5]]) as usize;
                let expected_len = 30 + page_id_len;
                if p.len() != expected_len {
                    return Err(ProtocolError::TruncatedPayload {
                        expected: expected_len,
                        got: p.len(),
                    });
                }
                let page_id_bytes = &p[6..6 + page_id_len];
                let page_id = std::str::from_utf8(page_id_bytes)
                    .map_err(|e| ProtocolError::InvalidUtf8(e.to_string()))?
                    .to_string();
                let off = 6 + page_id_len;
                let stroke_key = u64::from_le_bytes([
                    p[off],
                    p[off + 1],
                    p[off + 2],
                    p[off + 3],
                    p[off + 4],
                    p[off + 5],
                    p[off + 6],
                    p[off + 7],
                ]);
                let bbox = [
                    f32::from_le_bytes([p[off + 8], p[off + 9], p[off + 10], p[off + 11]]),
                    f32::from_le_bytes([p[off + 12], p[off + 13], p[off + 14], p[off + 15]]),
                    f32::from_le_bytes([p[off + 16], p[off + 17], p[off + 18], p[off + 19]]),
                    f32::from_le_bytes([p[off + 20], p[off + 21], p[off + 22], p[off + 23]]),
                ];
                Ok(Packet::StrokeCommit(StrokeCommitPayload {
                    stroke_id,
                    page_id,
                    stroke_key,
                    bbox,
                }))
            }
            MsgType::LaserPointer => {
                if p.len() != 16 {
                    return Err(ProtocolError::TruncatedPayload {
                        expected: 16,
                        got: p.len(),
                    });
                }
                let x = f32::from_le_bytes([p[0], p[1], p[2], p[3]]);
                let y = f32::from_le_bytes([p[4], p[5], p[6], p[7]]);
                let intensity = f32::from_le_bytes([p[8], p[9], p[10], p[11]]);
                let color_rgba = u32::from_le_bytes([p[12], p[13], p[14], p[15]]);
                Ok(Packet::LaserPointer(LaserPointerPayload {
                    x,
                    y,
                    intensity,
                    color_rgba,
                }))
            }
            MsgType::DocumentSync => {
                let raw_scene = lz4_flex::decompress_size_prepended(p)
                    .map_err(|e| ProtocolError::DecompressError(e.to_string()))?;
                Ok(Packet::DocumentSync(DocumentSyncPayload { raw_scene }))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_pin_hash_8492() {
        let hash = hash_pin("8492");
        assert_eq!(hash.len(), 16);
        // Verify deterministic reproduction
        assert_eq!(hash, hash_pin("8492"));
        assert_ne!(hash, hash_pin("8493"));
    }

    #[test]
    fn roundtrip_handshake() {
        let packet = Packet::Handshake(HandshakePayload {
            client_version: 1,
            display_dpi: 264.0,
            auth_token_hash: hash_pin("8492"),
        });
        let encoded = packet.encode();
        assert_eq!(encoded.len(), HEADER_LEN + 24);
        let decoded = Packet::decode(&encoded).expect("decode handshake");
        assert_eq!(packet, decoded);
    }

    #[test]
    fn roundtrip_camera() {
        let packet = Packet::Camera(CameraPayload {
            timestamp_us: 1234567890123,
            x: 100.5,
            y: 250.25,
            zoom: 1.5,
            rotation: 0.05,
            flags: CAMERA_FLAG_IN_MOTION | CAMERA_FLAG_MOMENTUM_GLIDE,
        });
        let encoded = packet.encode();
        assert_eq!(encoded.len(), HEADER_LEN + 28);
        let decoded = Packet::decode(&encoded).expect("decode camera");
        assert_eq!(packet, decoded);
    }

    #[test]
    fn roundtrip_stroke_live_add() {
        let packet = Packet::StrokeLiveAdd(StrokeLiveAddPayload {
            stroke_id: 42,
            tool_type: ToolType::Pencil,
            color_rgba: 0x1A2B3CFF,
            base_width: 3.5,
            points: vec![
                PointData {
                    x: 10.0,
                    y: 20.0,
                    pressure: 0.5,
                    t_ms: 100.0,
                },
                PointData {
                    x: 12.0,
                    y: 22.0,
                    pressure: 0.8,
                    t_ms: 108.33,
                },
            ],
        });
        let encoded = packet.encode();
        assert_eq!(encoded.len(), HEADER_LEN + 15 + 2 * 16);
        let decoded = Packet::decode(&encoded).expect("decode live add");
        assert_eq!(packet, decoded);
    }

    #[test]
    fn roundtrip_stroke_commit() {
        let packet = Packet::StrokeCommit(StrokeCommitPayload {
            stroke_id: 42,
            page_id: "page-uuid-123".to_string(),
            stroke_key: 9876543210,
            bbox: [10.0, 20.0, 150.0, 200.0],
        });
        let encoded = packet.encode();
        assert_eq!(encoded.len(), HEADER_LEN + 30 + "page-uuid-123".len());
        let decoded = Packet::decode(&encoded).expect("decode commit");
        assert_eq!(packet, decoded);
    }

    #[test]
    fn roundtrip_laser_pointer() {
        let packet = Packet::LaserPointer(LaserPointerPayload {
            x: 500.0,
            y: 400.0,
            intensity: 0.95,
            color_rgba: 0xFF0000FF,
        });
        let encoded = packet.encode();
        assert_eq!(encoded.len(), HEADER_LEN + 16);
        let decoded = Packet::decode(&encoded).expect("decode laser");
        assert_eq!(packet, decoded);
    }

    #[test]
    fn roundtrip_document_sync() {
        let raw = vec![0xAB, 0xCD, 0xEF, 0x01, 0x23, 0x45, 0x67, 0x89];
        let packet = Packet::DocumentSync(DocumentSyncPayload {
            raw_scene: raw.clone(),
        });
        let encoded = packet.encode();
        let decoded = Packet::decode(&encoded).expect("decode document sync");
        assert_eq!(packet, decoded);
    }

    #[test]
    fn rejection_cases() {
        // Truncated header
        assert_eq!(
            Packet::decode(&[0x4E, 0x4F, 0x01]),
            Err(ProtocolError::TruncatedHeader(3))
        );

        // Invalid magic
        assert_eq!(
            Packet::decode(&[0x00, 0x00, 0x01, 0x01, 0, 0, 0, 0]),
            Err(ProtocolError::InvalidMagic(0x0000))
        );

        // Invalid version
        assert_eq!(
            Packet::decode(&[0x4E, 0x4F, 0x99, 0x01, 0, 0, 0, 0]),
            Err(ProtocolError::InvalidVersion(0x99))
        );

        // Unknown msg type
        assert_eq!(
            Packet::decode(&[0x4E, 0x4F, 0x01, 0xFF, 0, 0, 0, 0]),
            Err(ProtocolError::UnknownMsgType(0xFF))
        );

        // Oversized payload
        let mut big = vec![0x4E, 0x4F, 0x01, 0x01];
        big.extend_from_slice(&(MAX_PAYLOAD_LEN as u32 + 1).to_le_bytes());
        assert_eq!(
            Packet::decode(&big),
            Err(ProtocolError::PayloadTooLarge(MAX_PAYLOAD_LEN as u32 + 1))
        );

        // Truncated payload
        let mut trunc = vec![0x4E, 0x4F, 0x01, 0x01, 24, 0, 0, 0];
        trunc.extend_from_slice(&[0u8; 10]); // only 10 bytes instead of 24
        assert_eq!(
            Packet::decode(&trunc),
            Err(ProtocolError::TruncatedPayload {
                expected: 32,
                got: 18
            })
        );

        // Trailing garbage bytes
        let mut extra = Packet::LaserPointer(LaserPointerPayload {
            x: 0.0,
            y: 0.0,
            intensity: 1.0,
            color_rgba: 0,
        })
        .encode()
        .to_vec();
        extra.push(0xDE);
        extra.push(0xAD);
        assert_eq!(Packet::decode(&extra), Err(ProtocolError::TrailingBytes(2)));

        // Invalid UTF-8 in stroke commit
        let mut bad_utf8 = vec![0x4E, 0x4F, 0x01, 0x04];
        let p_len = 30 + 2; // page_id_len = 2
        bad_utf8.extend_from_slice(&(p_len as u32).to_le_bytes());
        bad_utf8.extend_from_slice(&1u32.to_le_bytes()); // stroke_id
        bad_utf8.extend_from_slice(&2u16.to_le_bytes()); // page_id_len
        bad_utf8.extend_from_slice(&[0xFF, 0xFE]); // invalid UTF-8
        bad_utf8.extend_from_slice(&0u64.to_le_bytes()); // stroke_key
        bad_utf8.extend_from_slice(&[0u8; 16]); // bbox
        assert!(matches!(
            Packet::decode(&bad_utf8),
            Err(ProtocolError::InvalidUtf8(_))
        ));
    }
}
