# RFC: Ultra-Low-Latency Real-Time Canvas Mirroring (iPad/Tablet to PC)

**Status:** Draft Proposal for Architectural Review  
**Target Reviewer:** Neon (Lead Architect / Design Agent)  
**Author:** Antigravity / Engineering Agent  
**Date:** 2026-11-21  
**Target Platform:** OpenNote Core (`crates/canvas`, `crates/viewport`, `crates/native`, new `crates/remote`)  

---

## 1. Executive Summary & Objective

The objective is to enable real-time screen and canvas mirroring of OpenNote from an iPad (with Apple Pencil) or an Android tablet (with S-Pen / active stylus) to a PC (Windows, macOS, Linux).

The system must satisfy two primary use cases with the highest possible visual fluidity and lowest latency:
1. **Live Presentation Mode (Tablet → PC):** What is drawn, navigated, or zoomed on the tablet appears instantaneously on the PC monitor or projector (lossless, 120–240 Hz, clean presentation view, zero UI clutter, laser-pointer hover).
2. **Graphics Tablet / Digitizer Mode (Tablet as PC Input):** The tablet functions as an ultra-responsive wireless drawing tablet for the PC, streaming high-frequency pen telemetry (pressure, tilt, coordinates) with sub-frame latency.

### The Core Architectural Insight: Vector Streaming vs. Video Capture
Standard screen mirroring tools (Apple AirPlay, Miracast, VNC, Chrome Remote Desktop, Duet Display) use **framebuffer video capture** (H.264 / HEVC / WebRTC Video). This approach is fundamentally unsuitable for handwriting and precision sketching:
- **Encoding/Decoding Latency:** Video encoding on mobile GPUs adds 15–35 ms; network streaming adds 5–10 ms; video decoding and composition on PC adds 15–30 ms. Total glass-to-glass latency is **40–80 ms**, which feels sluggish and disconnected.
- **Visual Artifacts:** Video compression algorithms blur fine handwriting lines, create ringing around high-contrast ink, and introduce temporal ghosting during fast scrolling.
- **Resource Drain:** Video encoding consumes significant mobile GPU compute and battery power, heating up the tablet and throttling the 120 Hz display down to 60 Hz.
- **Bandwidth:** Video streaming requires 10–30 Mbps of continuous local network bandwidth.

**OpenNote’s Solution: Native Vector Delta Replay in Rust**  
Because OpenNote’s core graphics pipeline is written in Rust (`crates/canvas` with `wgpu`, `crates/viewport` with 120 Hz camera math), we do not need to stream pixels. We stream **raw vector stroke events and camera matrices**:
- **Bandwidth:** < 5 KB/s while drawing at 120 Hz; 0 KB/s when idle (vs. 20,000 KB/s for video).
- **Latency:** **< 5–8 ms** end-to-end over local Wi-Fi or USB tether.
- **Visual Quality:** Infinite resolution (lossless vector rendering on 4K / 8K PC monitors).
- **Framerate:** Rendered natively on the PC GPU at the PC monitor’s maximum refresh rate (120 Hz, 144 Hz, 240 Hz, or 360 Hz) independent of the tablet’s refresh rate.

---

## 2. System Architecture & Topology

```
┌─────────────────────────────────────────────────────────────┐
│                 TRANSMITTER (iPad / Android)                │
│                                                             │
│   Touch/Stylus Event (Apple Pencil / S-Pen)                 │
│         │ (240 Hz hardware scan)                            │
│         ▼                                                   │
│   crates/viewport ───────► crates/native                    │
│   (Camera tick, pan, zoom) (Live stroke buffer)             │
│         │                         │                         │
│         └───────────┬─────────────┘                         │
│                     ▼                                       │
│             crates/remote (Broadcaster)                     │
│             - Zero-alloc binary serialization               │
│             - Embedded tokio-tungstenite WebSocket server   │
│             - Local UDP multicast / mDNS advertisement      │
└─────────────────────┬───────────────────────────────────────┘
                      │
         Local Network (Wi-Fi 5/6 GHz or USB Tunnel)
         Packets: Binary Deltas (~32 - 128 bytes each)
         Latency: ~1 - 2 ms
                      │
┌─────────────────────▼───────────────────────────────────────┐
│                    RECEIVER (PC Client)                     │
│                                                             │
│  Option A: Zero-Install Web Receiver (Chrome / Edge / FF)   │
│  - Connects to http://<tablet-ip>:<port>                    │
│  - WebGPU / WebGL vector renderer                           │
│                                                             │
│  Option B: Native Rust Desktop Client (opennote-desktop)    │
│  - crates/canvas running directly with wgpu on desktop GPU  │
│  - 144 Hz / 240 Hz V-Sync presentation                     │
│  - Dedicated Presentation Mode / OBS Window Source          │
└─────────────────────────────────────────────────────────────┘
```

### Components Breakdown

1. **Broadcaster (`crates/remote`):**
   - Lightweight Rust module linked into `opennote_native`.
   - Starts an asynchronous, low-footprint WebSocket/TCP server on a local ephemeral port (e.g., `38400`).
   - Hooks into:
     - `CanvasHost::live_add`: broadcasts in-progress pen points as they are sampled.
     - `CanvasHost::live_commit`: broadcasts completed stroke geometries.
     - `Viewport::tick`: broadcasts camera viewport matrices `[x, y, zoom, rotation]`.
     - `Scene`: provides initial snapshot when a new client connects or when switching pages.

2. **Discovery & Frictionless Pairing:**
   - **mDNS / Bonjour Service:** Tablet advertises `_opennote-mirror._tcp.local` on the local subnet.
   - **Visual QR Code:** OpenNote tablet UI displays a "Mirror to PC" popover showing a QR code and URL (e.g., `http://192.168.1.145:38400/?pin=8492`).
   - Scanning or typing the URL in any PC browser immediately opens the live mirror viewer.
   - **Wired USB Fallback:** For high-security environments, classrooms without Wi-Fi, or zero-jitter requirements:
     - Android: ADB port forward (`adb forward tcp:38400 tcp:38400`).
     - iOS: USBMuxd tunnel (`iproxy 38400 38400` or peer USB socket).

3. **PC Receiver Targets:**
   - **Target 1: Web Viewer (Zero-Install):** Built-in static web page served by the tablet's embedded Rust HTTP server. Anyone on the same network can view the notes by opening the URL.
   - **Target 2: Native Desktop Binary (`crates/desktop`):** A standalone lightweight Rust binary using `wgpu` and `winit`, reusing `crates/canvas` for desktop-grade performance, multi-monitor presentation view, and OBS Studio capture.

---

## 3. Binary Wire Protocol Specification

To achieve minimum serialization overhead and maximum network efficiency, all streaming packets are serialized as compact binary buffers (little-endian).

### Packet Header (8 Bytes)
| Byte Offset | Field | Type | Description |
|---|---|---|---|
| 0..1 | `magic` | `u16` | Fixed magic bytes `0x4F4E` ("ON") |
| 2 | `version` | `u8` | Protocol version (`0x01`) |
| 3 | `msg_type`| `u8` | Message type ID (see below) |
| 4..7 | `payload_len` | `u32` | Byte length of the following payload |

### Message Types (`msg_type`)

#### `0x01`: Handshake / Hello
Sent by client upon connection; acknowledged by tablet with session configuration:
```rust
struct HandshakePayload {
    client_version: u32,
    display_dpi: f32,
    auth_token_hash: [u8; 16],
}
```

#### `0x02`: Camera Transform Update (28 Bytes)
Sent on every camera tick whenever position or zoom changes:
```rust
struct CameraPayload {
    timestamp_us: u64,
    x: f32,          // Viewport origin X in canvas units
    y: f32,          // Viewport origin Y in canvas units
    zoom: f32,       // Current zoom scale (e.g. 1.0 = 100%)
    rotation: f32,   // Rotation in radians
    flags: u32,      // Bit 0: IsInMotion, Bit 1: IsMomentumGlide
}
```

#### `0x03`: Live Stroke Delta (`StrokeLiveAdd`)
Sent immediately when pen points are recorded by the digitizer (up to 120–240 times per second):
```rust
struct StrokeLiveAddPayload {
    stroke_id: u32,
    tool_type: u8,       // 0: Pen, 1: Pencil, 2: Highlighter, 3: Eraser
    color_rgba: u32,     // Packed 32-bit RGBA
    base_width: f32,     // Base stroke thickness
    point_count: u16,    // Number of points in this delta packet
    // Followed by `point_count` entries of:
    // struct PointData {
    //     x: f32,
    //     y: f32,
    //     pressure: f32, // 0.0 .. 1.0
    //     t_ms: f32,     // Relative timestamp in ms
    // }
}
```

#### `0x04`: Stroke Commit (`StrokeCommit`)
Sent when the stylus leaves the screen to finalize the stroke geometry and insert into permanent document scene:
```rust
struct StrokeCommitPayload {
    stroke_id: u32,
    page_id_len: u16,
    // page_id: [u8; page_id_len]
    // stroke_key: u64,
    // bbox: [f32; 4] (min_x, min_y, max_x, max_y)
}
```

#### `0x05`: Laser Pointer / Hover Cursor (16 Bytes)
Allows the tablet stylus hover or finger touch to display an animated pointer on the PC screen:
```rust
struct LaserPointerPayload {
    x: f32,
    y: f32,
    intensity: f32, // 0.0 = hidden, 1.0 = bright pointer
    color_rgba: u32,
}
```

#### `0x06`: Document / Page State Sync
Sent on initial connect or page navigation to synchronize existing strokes, images, and backgrounds. Compressed using LZ4 for instant page flips (< 10 ms transfer time for 5,000 strokes).

---

## 4. Latency Budget Analysis

| Stage | Mechanism | Duration |
|---|---|---|
| Stylus Capture | iPad / Android hardware scan (120 Hz / 240 Hz) | ~2.0 ms |
| Rust Buffer Append | `crates/native` touch handler, zero allocations | ~0.1 ms |
| Binary Encoding | Direct memory layout copy to socket buffer | ~0.1 ms |
| Network Transit | Local 5 GHz Wi-Fi or USB TCP socket | ~1.5 ms |
| PC Socket Receive | Tokio / Epoll non-blocking read on PC | ~0.2 ms |
| PC GPU Vertex Update | `crates/canvas` GPU buffer staging & instancing | ~0.8 ms |
| PC Display V-Sync | 144 Hz monitor presentation | ~2.0 – 6.9 ms |
| **Total Glass-to-Glass** | **Stylus tip to PC monitor photon** | **~6.7 – 11.6 ms** |

*Result:* Mirroring occurs within a single display frame. To the human eye, what is written on the iPad appears on the PC screen in real time with virtually zero perceptual lag.

---

## 5. Security & Isolation Model

1. **Local Network Boundary:**
   - The embedded server binds strictly to the local Wi-Fi / LAN IP. It does **not** rely on external cloud relay servers, WebRTC turn servers, or third-party cloud infrastructure. All data stays strictly inside the user's room/local network.
2. **One-Time Pairing PIN / Token:**
   - Every mirroring session generates a random 4-digit or 6-digit PIN.
   - Incoming WebSocket connections must supply the PIN in the handshake header. Unauthorized clients on the same Wi-Fi are rejected immediately.
3. **Read-Only by Default:**
   - Mirroring clients have view-only permissions by default to prevent accidental remote edits or vandalism during public presentations.

---

## 6. Implementation Plan & Work Breakdown for Neon

Neon should structure the implementation into four modular phases:

### Phase M1: `crates/remote` Protocol & Broadcaster
- Create standalone Rust crate `crates/remote`.
- Implement `tokio-tungstenite` lightweight async WebSocket server.
- Define zero-copy binary serialization/deserialization routines for packets `0x01` through `0x06`.
- Unit tests validating encode/decode symmetry and fuzz testing corrupted packets.

### Phase M2: Tablet Engine Hooks in `crates/native` & `crates/viewport`
- Add broadcast event publisher in `crates/viewport`: notify `crates/remote` on camera position changes.
- Add broadcast hook in `crates/native/src/live.rs` and `canvas_service.rs`: stream live stroke points and commits.
- Add UI toggle in OpenNote Settings / Topbar: "Screen Mirroring (Cast to PC)" with QR Code modal.

### Phase M3: PC Web Viewer (Zero-Install HTML5/WebGPU Client)
- Embed a lightweight static HTML5/Canvas/WebGPU receiver inside `crates/remote`.
- Renders incoming stroke vectors and camera moves smoothly with requestAnimationFrame interpolation.
- Fullscreen presenter mode toggle, laser pointer trail rendering.

### Phase M4: High-Performance Native Desktop Client (`opennote-desktop`)
- Build a lightweight desktop harness linking `crates/canvas` and `crates/viewport` on PC.
- Achieves 144 Hz / 240 Hz display synchronization with sub-1ms render passes.
- Support virtual display / OBS Studio window capture source.

---

## 7. Open Architectural Questions for Neon

1. **Reconciliation Strategy during Network Jitter:**
   - If a Wi-Fi packet drops, should the receiver request a sequence retransmit (TCP reliable stream) or fall back to immediate keyframe document state sync? (Recommended: TCP for local Wi-Fi since TCP retransmit on LAN takes < 2ms).
2. **Bi-directional Digitizer Mode (Tablet as PC Input):**
   - When the user wants the iPad to act as a drawing tablet for PC software (e.g., Photoshop/Krita on PC), should we emulate a virtual uinput / WinTab device driver on the PC, or keep it scoped within the OpenNote desktop ecosystem first?
3. **Integration with Upcoming C2/C3 Canvas Layers:**
   - How should embedded pictures (ImageBlocks) and PDF pages be synced to the PC receiver? (Recommended: Content-addressable hash cache, where images are sent once as PNG/WebP blobs and cached on the PC receiver).

---
*Ready for Neon review, formal specification, and implementation kickoff.*
