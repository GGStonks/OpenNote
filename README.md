# OpenNote

<div align="center">
  <h3>The Universal, Offline-First Notability Clone</h3>
  <p><b>Native iPad & Android Support • Notes2LaTeX Math • PDEDraw TikZ Vector Diagrams • Apple Pencil & S-Pen Engine</b></p>
</div>

---

## 📖 Overview

**OpenNote** is a cross-platform, native, offline-first notebook application engineered to replicate and elevate the **Notability** user experience. It runs completely offline on **iOS (iPad)** and **Android (Tablets & Phones)** without any web browser dependencies.

OpenNote integrates:
1. **Pencil & Stylus Engine**: Low-latency, pressure-sensitive handwriting with `perfect-freehand`, sub-pixel smoothing, and palm rejection for Apple Pencil and Android S-Pen.
2. **Transparent Vector SVG Math (Notes2LaTeX)**: Convert handwritten formulas into crisp, transparent-background vector LaTeX mathematics that blend directly into the paper without window frames or cards.
3. **TikZ Vector Diagram Architecture (PDEDraw)**: Integrated geometric shape recognition, lasso transformation engine, and TikZ compiler adapted from GGStonks' PDEDraw. Hand-drawn diagrams are converted to pure vector SVG graphics and compilable TikZ code.
4. **Notability Home & Library**: Subjects, Dividers, multi-page continuous vertical scrolling, grid/ruled/dot/blank paper templates, and customizable colors (White, Cream, Yellow, Dark).
5. **Complete Offline Persistence**: Notes, strokes, and vector objects are stored locally using IndexedDB and native SQLite/filesystem storage.

---

## 🚀 Running on iOS (iPad & iPhone)

OpenNote includes a preconfigured native Xcode project (`ios/App/App.xcodeproj` and `ios/App/App.xcworkspace`).

### Option A: Via Xcode (Recommended for Mac Users)

1. **Prerequisites**: macOS with Xcode 15+ installed.
2. **Open the project**:
   ```bash
   cd OpenNote
   npm install
   npm run build
   npx cap sync ios
   npx cap open ios
   ```
   *Or open `ios/App/App.xcworkspace` directly in Xcode.*
3. **Configure Signing**:
   - In Xcode, select the **App** project in the left sidebar.
   - Go to **Signing & Capabilities**.
   - Under **Team**, select your Apple ID (a free personal Apple ID works, no paid developer account required).
4. **Deploy**:
   - Connect your iPad via USB or Wi-Fi.
   - Select your iPad as the run destination in the top toolbar.
   - Press **Cmd + R** (or click the Play button) to build and install.
   - On your iPad: Go to *Settings > General > VPN & Device Management* and trust your developer certificate.

### Option B: Sideloading (AltStore / SideStore / Sideloadly)

1. In Xcode: *Product > Archive*, then export as an **Ad-Hoc / Development IPA**.
2. Install the `.ipa` onto your iPad using **AltStore**, **SideStore**, or **Sideloadly** (works on Windows, macOS, and Linux).

---

## 🤖 Running on Android (Tablets & Phones)

OpenNote includes a preconfigured native Android Gradle project in the `android/` directory.

### Option A: Via Android Studio (Recommended)

1. **Prerequisites**: Android Studio with Android SDK 34+.
2. **Open the project**:
   ```bash
   cd OpenNote
   npm install
   npm run build
   npx cap sync android
   npx cap open android
   ```
   *Or launch Android Studio and select "Open" -> choose the `OpenNote/android` directory.*
3. **Deploy to Device**:
   - Connect your Android tablet/phone via USB with **USB Debugging** enabled in Developer Options.
   - Select your device in the toolbar.
   - Click the green **Run** button (Shift + F10). The APK will build and install automatically.

### Option B: Command Line APK Build

You can build the APK directly using Gradle without opening the GUI:
```bash
cd OpenNote/android
./gradlew assembleDebug
```
The compiled APK is generated at:
```
android/app/build/outputs/apk/debug/app-debug.apk
```
Install it onto any connected device:
```bash
adb install android/app/build/outputs/apk/debug/app-debug.apk
```
*Or transfer `app-debug.apk` to your tablet via USB/Google Drive/Email and tap to install.*

---

## 🧰 Core Features & Toolset

### 1. Drawing & Handwriting
- **Pen Tool**: Pressure-responsive Bezier strokes with dynamic tapering.
- **Highlighter Tool**: Semi-transparent yellow/color highlighter rendered behind pen ink.
- **Eraser Tool**: Radial stroke eraser that removes entire strokes upon contact.
- **Palm Rejection**: Dedicated Stylus-Only mode toggle (`stylusOnlyMode`) rejecting all capacitive finger touches while allowing Apple Pencil / S-Pen drawing.

### 2. Lasso Tool (PDEDraw Architecture)
- **Lasso Polygon Selection**: Draw a loop around strokes or math blocks. The point-in-polygon ray-casting algorithm selects enclosed items.
- **Move / Translate**: Drag anywhere inside the bounding box to move selected handwriting across the page.
- **Scale / Resize**: Drag the corner handle to dynamically scale selected strokes.
- **Auto-Shape Snap**: Detects lines, arrows, rectangles, ellipses, and triangles, instantly snapping rough drawings into perfect geometric vectors.
- **Line Style Toggle**: Switch stroke styles between **Solid**, **Dashed** (`---`), and **Dotted** (`···`).
- **Color Recoloring**: Recolor selected strokes with a single tap.
- **Duplicate & Delete**: Quick clone or deletion of selected strokes.

### 3. Transparent Vector LaTeX & TikZ Renderer
- **Frameless Vector Graphics**: LaTeX equations and TikZ diagrams render as pure vector graphics with **transparent backgrounds** (no white/gray container card, no shadow, no window border).
- **Interactive Manipulation**: Tap or lasso a rendered equation/diagram to display minimal bounding handles (Move, Copy LaTeX, Delete, Export).
- **Notes2LaTeX OCR**: Crop handwritten math or trigger full-page conversion to transcribe into compiled LaTeX formulas.
- **TikZ Vector Engine**: Translates geometric diagrams into compilable PGF/TikZ snippets and renders them immediately on the canvas as lossless vector SVG.

### 4. Export Capabilities
- **Export PDF (Print)**: Lossless high-resolution PDF document.
- **Export Vector SVG (.svg)**: Resolution-independent vector graphic containing all pages, ink strokes, and TikZ diagrams.
- **Export LaTeX (.tex)**: Compilable LaTeX document with `amsmath`, `amssymb`, and `tikz` packages included.
- **Export Markdown (.md)**: Compatible with Obsidian, Notion, and GitHub.

---

## ⚙️ Offline & VLM Configuration

OpenNote functions **100% offline** for all note-taking, sketching, lasso manipulation, and shape snapping features.

For **Notes2LaTeX** and complex **TikZ VLM transcription**:
- Default endpoint: `http://localhost:9191/v1/chat/completions` (or your local IP `http://192.168.1.26:9191/v1/chat/completions` / Tailscale `http://100.77.212.97:9191/v1`).
- Tap the **Settings** gear icon in OpenNote to configure the VLM Endpoint URL and Model Name (e.g. `qwen3-vl`).
- When offline or disconnected, OpenNote uses the client-side geometric TikZ engine (`shapeRecognition.ts`) and offline formula engine.

---

## 📁 Repository Structure

```
OpenNote/
├── android/                   # Native Android Studio / Gradle project
│   ├── app/
│   │   ├── src/main/AndroidManifest.xml
│   │   └── build.gradle
│   └── gradlew
├── ios/                       # Native iOS Xcode workspace
│   ├── App/
│   │   ├── App.xcodeproj
│   │   ├── App.xcworkspace
│   │   └── App/
├── src/
│   ├── components/
│   │   ├── CanvasPage.tsx     # HiDPI page canvas, Lasso & vector renderer
│   │   ├── LibraryView.tsx    # Notability Home / Subject library
│   │   ├── Toolbar.tsx        # Top tool bar & paper customization
│   │   ├── LatexModal.tsx     # LaTeX/TikZ transcription editor
│   │   ├── ExportModal.tsx    # PDF, SVG, TeX, MD export
│   │   └── SettingsModal.tsx  # VLM endpoint settings
│   ├── services/
│   │   ├── tikzService.ts     # PGF/TikZ to vector SVG compiler
│   │   ├── shapeRecognition.ts# PDEDraw geometric shape detector
│   │   └── latexService.ts    # Notes2LaTeX VLM pipeline
│   ├── ink/
│   │   └── strokeSmoother.ts  # perfect-freehand Apple Pencil ink engine
│   ├── storage/
│   │   └── db.ts              # Offline IndexedDB persistence
│   ├── types.ts               # Core data models
│   ├── App.tsx                # Main editor shell
│   └── main.tsx
├── capacitor.config.ts        # Capacitor native app configuration
├── package.json
└── vite.config.ts
```

---

## 📄 License

MIT License. Designed with inspiration from Notability and GGStonks' PDEDraw.
