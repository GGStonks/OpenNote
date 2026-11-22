//! WebSocket and HTTP server for OpenNote Ultra-Low-Latency Vector Mirroring.

use std::io;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::protocol::Message;

use crate::protocol::{
    hash_pin, CameraPayload, DocumentSyncPayload, LaserPointerPayload, Packet, StrokeCommitPayload,
    StrokeLiveAddPayload,
};

pub const DEFAULT_PORT: u16 = 38400;
pub const BROADCAST_CAPACITY: usize = 1024;
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

type SnapshotProvider = Arc<dyn Fn() -> Option<Vec<u8>> + Send + Sync>;

#[derive(Clone)]
pub struct MirrorBroadcaster {
    pin: Arc<String>,
    expected_hash: Arc<[u8; 16]>,
    tx: broadcast::Sender<Bytes>,
    active_clients: Arc<AtomicUsize>,
    cached_camera: Arc<RwLock<Option<Bytes>>>,
    snapshot_provider: Arc<RwLock<Option<SnapshotProvider>>>,
}

impl MirrorBroadcaster {
    pub fn new(pin: impl Into<String>) -> Self {
        let pin = pin.into();
        let expected_hash = hash_pin(&pin);
        let (tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        MirrorBroadcaster {
            pin: Arc::new(pin),
            expected_hash: Arc::new(expected_hash),
            tx,
            active_clients: Arc::new(AtomicUsize::new(0)),
            cached_camera: Arc::new(RwLock::new(None)),
            snapshot_provider: Arc::new(RwLock::new(None)),
        }
    }

    /// Generates a random 4-digit numeric PIN.
    pub fn generate_random_pin() -> String {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(123456);
        let val = 1000 + (nanos % 9000);
        val.to_string()
    }

    pub fn pin(&self) -> &str {
        &self.pin
    }

    pub fn expected_hash(&self) -> [u8; 16] {
        *self.expected_hash
    }

    pub fn client_count(&self) -> usize {
        self.active_clients.load(Ordering::Relaxed)
    }

    pub fn receiver_count(&self) -> usize {
        self.tx.receiver_count()
    }

    pub fn set_snapshot_provider(&self, provider: Arc<dyn Fn() -> Option<Vec<u8>> + Send + Sync>) {
        if let Ok(mut p) = self.snapshot_provider.write() {
            *p = Some(provider);
        }
    }

    /// Broadcasts camera updates to connected viewers.
    /// Caches the latest camera packet for newly connecting viewers.
    pub fn broadcast_camera(&self, payload: CameraPayload) {
        let packet = Packet::Camera(payload);
        let encoded = packet.encode();

        // Always update cached camera for late-joining clients
        if let Ok(mut cache) = self.cached_camera.write() {
            *cache = Some(encoded.clone());
        }

        // Zero-work idle check: do not broadcast if no receivers
        if self.tx.receiver_count() == 0 {
            return;
        }

        let _ = self.tx.send(encoded);
    }

    /// Broadcasts real-time live stroke points.
    pub fn broadcast_live_points(&self, payload: StrokeLiveAddPayload) {
        if self.tx.receiver_count() == 0 {
            return;
        }
        let packet = Packet::StrokeLiveAdd(payload);
        let _ = self.tx.send(packet.encode());
    }

    /// Broadcasts stroke commit (finalization).
    pub fn broadcast_stroke_commit(&self, payload: StrokeCommitPayload) {
        if self.tx.receiver_count() == 0 {
            return;
        }
        let packet = Packet::StrokeCommit(payload);
        let _ = self.tx.send(packet.encode());
    }

    /// Broadcasts laser pointer movement.
    pub fn broadcast_laser(&self, payload: LaserPointerPayload) {
        if self.tx.receiver_count() == 0 {
            return;
        }
        let packet = Packet::LaserPointer(payload);
        let _ = self.tx.send(packet.encode());
    }

    /// Broadcasts full document / scene sync snapshot.
    pub fn broadcast_document_sync(&self, raw_scene: Vec<u8>) {
        if self.tx.receiver_count() == 0 {
            return;
        }
        let packet = Packet::DocumentSync(DocumentSyncPayload { raw_scene });
        let _ = self.tx.send(packet.encode());
    }

    /// Binds a TCP listener on `addr`. If `addr.port()` is busy, tries `port + 1` up to `port + 50`.
    pub async fn bind_listener(mut addr: SocketAddr) -> io::Result<(TcpListener, SocketAddr)> {
        let initial_port = addr.port();
        for offset in 0..50 {
            let port = initial_port.saturating_add(offset);
            addr.set_port(port);
            match TcpListener::bind(addr).await {
                Ok(listener) => {
                    let local_addr = listener.local_addr()?;
                    return Ok((listener, local_addr));
                }
                Err(e) if e.kind() == io::ErrorKind::AddrInUse => {
                    continue;
                }
                Err(e) => return Err(e),
            }
        }
        Err(io::Error::new(
            io::ErrorKind::AddrInUse,
            format!(
                "All ports in range {initial_port}..{} are busy",
                initial_port + 50
            ),
        ))
    }

    /// Serves on `addr`. Automatically moves to another port if busy.
    pub async fn serve(self, addr: SocketAddr) -> io::Result<()> {
        let (listener, local_addr) = Self::bind_listener(addr).await?;
        println!(
            "OpenNote Mirror server listening on http://{local_addr}/?pin={}",
            self.pin
        );
        self.serve_listener(listener).await
    }

    /// Serves incoming connections on an already bound `TcpListener`.
    pub async fn serve_listener(self, listener: TcpListener) -> io::Result<()> {
        loop {
            let (stream, peer_addr) = listener.accept().await?;
            let _ = stream.set_nodelay(true);

            let broadcaster = self.clone();
            tokio::spawn(async move {
                if let Err(e) = broadcaster.handle_connection(stream, peer_addr).await {
                    eprintln!("Mirror connection error from {peer_addr}: {e}");
                }
            });
        }
    }

    async fn handle_connection(
        &self,
        stream: TcpStream,
        _peer_addr: SocketAddr,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let _ = stream.set_nodelay(true);

        // Peek initial bytes to distinguish HTTP GET from WebSocket upgrade
        let mut peek_buf = [0u8; 1024];
        let peek_res = tokio::time::timeout(HANDSHAKE_TIMEOUT, stream.peek(&mut peek_buf)).await;
        let peek_len = match peek_res {
            Ok(Ok(n)) if n > 0 => n,
            _ => return Ok(()),
        };

        let req_header = String::from_utf8_lossy(&peek_buf[..peek_len]).to_lowercase();

        // If not a WebSocket upgrade, serve embedded HTML5 zero-install viewer
        if !req_header.contains("upgrade: websocket") {
            let html = include_str!("viewer.html");
            let response = format!(
                "HTTP/1.1 200 OK\r\n\
                 Content-Type: text/html; charset=utf-8\r\n\
                 Content-Length: {}\r\n\
                 Cache-Control: no-store\r\n\
                 Connection: close\r\n\r\n\
                 {}",
                html.len(),
                html
            );
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut stream = stream;
            // The request is read before the answer (it was only peeked): a socket closed with
            // bytes unread sends a reset, which browsers show as "The connection was reset"
            // instead of the page (3.0.1-3.0.5: casting never opened).
            let mut seen: Vec<u8> = Vec::with_capacity(1024);
            let mut buf = [0u8; 1024];
            let _ = tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
                while !seen.windows(4).any(|w| w == b"\r\n\r\n") && seen.len() < 64 * 1024 {
                    match stream.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => seen.extend_from_slice(&buf[..n]),
                    }
                }
            })
            .await;
            let _ = stream.write_all(response.as_bytes()).await;
            let _ = stream.flush().await;
            // A clean end of the answer (FIN), not a drop.
            let _ = stream.shutdown().await;
            return Ok(());
        }

        // Upgrade to WebSocket
        let ws_stream = tokio_tungstenite::accept_async(stream).await?;
        let (mut ws_sink, mut ws_src) = ws_stream.split();

        // Wait up to HANDSHAKE_TIMEOUT for Handshake packet (0x01)
        let handshake_res = tokio::time::timeout(HANDSHAKE_TIMEOUT, ws_src.next()).await;
        let first_msg = match handshake_res {
            Ok(Some(Ok(Message::Binary(bin)))) => bin,
            _ => {
                let _ = ws_sink.send(Message::Close(None)).await;
                return Ok(());
            }
        };

        let handshake_packet = match Packet::decode(&first_msg) {
            Ok(Packet::Handshake(h)) => h,
            _ => {
                let _ = ws_sink.send(Message::Close(None)).await;
                return Ok(());
            }
        };

        if handshake_packet.auth_token_hash != *self.expected_hash {
            let _ = ws_sink.send(Message::Close(None)).await;
            return Ok(());
        }

        // Subscribe to broadcast sender BEFORE sending snapshot and cached camera
        let mut rx = self.tx.subscribe();
        self.active_clients.fetch_add(1, Ordering::SeqCst);

        // Send initial DocumentSync snapshot if provider is set
        let snapshot_data = self
            .snapshot_provider
            .read()
            .ok()
            .and_then(|p| p.as_ref().and_then(|f| f()));
        if let Some(raw_scene) = snapshot_data {
            let sync_packet = Packet::DocumentSync(DocumentSyncPayload { raw_scene });
            let _ = ws_sink
                .send(Message::Binary(sync_packet.encode().to_vec()))
                .await;
        }

        // Send latest cached Camera packet
        let cached_cam = self.cached_camera.read().ok().and_then(|c| c.clone());
        if let Some(cam_bytes) = cached_cam {
            let _ = ws_sink.send(Message::Binary(cam_bytes.to_vec())).await;
        }

        // Broadcast loop
        loop {
            tokio::select! {
                recv_res = rx.recv() => {
                    match recv_res {
                        Ok(bytes) => {
                            if ws_sink.send(Message::Binary(bytes.to_vec())).await.is_err() {
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            // Client lagged behind: keep going without disconnecting
                            continue;
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            break;
                        }
                    }
                }
                msg_res = ws_src.next() => {
                    match msg_res {
                        Some(Ok(Message::Ping(p))) => {
                            if ws_sink.send(Message::Pong(p)).await.is_err() {
                                break;
                            }
                        }
                        Some(Ok(Message::Close(_))) | None => {
                            break;
                        }
                        Some(Err(_)) => {
                            break;
                        }
                        _ => {
                            // Ignore unsolicited client text/binary frames (read-only stream)
                        }
                    }
                }
            }
        }

        self.active_clients.fetch_sub(1, Ordering::SeqCst);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::*;
    use std::net::Ipv4Addr;

    /// A browser opening the cast's URL gets the whole viewer page and a clean close. 3.0.5 only
    /// peeked at the request: closing with it unread sent a TCP reset, and Firefox showed "The
    /// connection was reset" instead of the page.
    #[tokio::test]
    async fn a_browser_gets_the_viewer_page() {
        let broadcaster = MirrorBroadcaster::new("9000");
        let (listener, addr) =
            MirrorBroadcaster::bind_listener(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
                .await
                .expect("bind ephemeral");
        tokio::spawn(async move {
            let _ = broadcaster.serve_listener(listener).await;
        });
        let page = tokio::task::spawn_blocking(move || {
            use std::io::{Read, Write};
            let mut tcp = std::net::TcpStream::connect(addr).expect("connect");
            tcp.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let req = format!(
                "GET /?pin=9000 HTTP/1.1\r\nHost: {addr}\r\nUser-Agent: Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0\r\nAccept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\r\nAccept-Language: en-US,en;q=0.5\r\nAccept-Encoding: gzip, deflate\r\nConnection: keep-alive\r\nUpgrade-Insecure-Requests: 1\r\nPriority: u=0, i\r\n\r\n"
            );
            tcp.write_all(req.as_bytes()).unwrap();
            let mut out = Vec::new();
            tcp.read_to_end(&mut out).map(|_| out)
        })
        .await
        .unwrap()
        .expect("the page, then a clean close (no reset)");
        let text = String::from_utf8_lossy(&page);
        assert!(text.starts_with("HTTP/1.1 200 OK"), "{}", &text[..text.len().min(200)]);
        let body = text.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or("");
        assert_eq!(body.len(), include_str!("viewer.html").len(), "the whole viewer page");
    }

    #[tokio::test]
    async fn server_handshake_and_broadcast() {
        let broadcaster = MirrorBroadcaster::new("8492");
        let (listener, addr) =
            MirrorBroadcaster::bind_listener(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
                .await
                .expect("bind ephemeral");

        let b_clone = broadcaster.clone();
        tokio::spawn(async move {
            let _ = b_clone.serve_listener(listener).await;
        });

        // Connect as client via WebSocket
        let ws_url = format!("ws://{addr}/ws");
        let (ws_stream, _) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .expect("connect");
        let (mut sink, mut src) = ws_stream.split();

        // Send Handshake
        let handshake = Packet::Handshake(HandshakePayload {
            client_version: 1,
            display_dpi: 96.0,
            auth_token_hash: hash_pin("8492"),
        });
        sink.send(Message::Binary(handshake.encode().to_vec()))
            .await
            .expect("send handshake");

        // Broadcast a camera packet
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(broadcaster.client_count(), 1);

        let cam = CameraPayload {
            timestamp_us: 1000,
            x: 50.0,
            y: 50.0,
            zoom: 1.0,
            rotation: 0.0,
            flags: 0,
        };
        broadcaster.broadcast_camera(cam);

        // Receive on client
        let received = tokio::time::timeout(Duration::from_secs(2), src.next())
            .await
            .expect("timeout")
            .expect("some")
            .expect("ok");

        match received {
            Message::Binary(bin) => {
                let packet = Packet::decode(&bin).expect("decode");
                assert_eq!(packet, Packet::Camera(cam));
            }
            other => panic!("expected binary message, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn wrong_pin_is_rejected() {
        let broadcaster = MirrorBroadcaster::new("8492");
        let (listener, addr) =
            MirrorBroadcaster::bind_listener(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
                .await
                .expect("bind ephemeral");

        let b_clone = broadcaster.clone();
        tokio::spawn(async move {
            let _ = b_clone.serve_listener(listener).await;
        });

        let ws_url = format!("ws://{addr}/ws");
        let (ws_stream, _) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .expect("connect");
        let (mut sink, mut src) = ws_stream.split();

        // Send Handshake with wrong PIN
        let bad_handshake = Packet::Handshake(HandshakePayload {
            client_version: 1,
            display_dpi: 96.0,
            auth_token_hash: hash_pin("0000"),
        });
        sink.send(Message::Binary(bad_handshake.encode().to_vec()))
            .await
            .expect("send bad handshake");

        // Server should close connection
        let next_msg = tokio::time::timeout(Duration::from_secs(2), src.next()).await;
        match next_msg {
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) => {} // Correctly rejected
            Ok(other) => panic!("expected close or None, got {other:?}"),
            Err(_) => panic!("timed out waiting for rejection"),
        }
    }
}
