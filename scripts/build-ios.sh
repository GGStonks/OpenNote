#!/usr/bin/env bash
# Builds an (unsigned) OpenNote.ipa on Linux: native WKWebView shell (ios-native/OpenNoteShell.m)
# compiled with clang + ld64.lld against an iPhoneOS SDK, plus the web app from dist/.
# Sign/install with Sideloadly, AltStore/SideStore, or `zsign`/`ldid` + your certificate.
#
# Usage: scripts/build-ios.sh <output.ipa> [version] [build-number]
# Env:   IOS_SDK=/path/to/iPhoneOS16.5.sdk  (e.g. from https://github.com/theos/sdks)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:?usage: build-ios.sh <output.ipa> [version] [build]}"
VERSION="${2:-$(node -p "require('$ROOT/package.json').version")}"
BUILD="${3:-$(git -C "$ROOT" rev-list --count HEAD 2>/dev/null || echo 1)}"
IOS_SDK="${IOS_SDK:-$HOME/android-tools/ios-sdk/iPhoneOS16.5.sdk}"
MIN_IOS=15.0

[ -d "$IOS_SDK" ] || { echo "iPhoneOS SDK not found at $IOS_SDK (set IOS_SDK)"; exit 1; }
[ -f "$ROOT/dist/index.html" ] || { echo "dist/ missing: run npm run build first"; exit 1; }
SDK_VERSION="$(basename "$IOS_SDK" | sed -E 's/iPhoneOS([0-9.]+)\.sdk/\1/')"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
APP="$WORK/Payload/OpenNote.app"
mkdir -p "$APP"

echo "--> Compiling native shell (arm64, iOS $MIN_IOS+, SDK $SDK_VERSION)"
clang -target "arm64-apple-ios$MIN_IOS" -isysroot "$IOS_SDK" -fobjc-arc -fmodules -O2 \
  -Wall -Wno-unguarded-availability-new -c "$ROOT/ios-native/OpenNoteShell.m" -o "$WORK/OpenNoteShell.o"

echo "--> Linking Mach-O executable"
ld64.lld -arch arm64 -platform_version ios "$MIN_IOS" "$SDK_VERSION" -syslibroot "$IOS_SDK" \
  -dead_strip -lSystem -lobjc \
  -framework Foundation -framework UIKit -framework WebKit -framework QuartzCore \
  "$WORK/OpenNoteShell.o" -o "$APP/OpenNote"

echo "--> Assembling bundle"
sed -e "s/__VERSION__/$VERSION/" -e "s/__BUILD__/$BUILD/" \
    -e "s/<string>16.5<\/string>/<string>$SDK_VERSION<\/string>/" -e "s/iphoneos16.5/iphoneos$SDK_VERSION/" \
    "$ROOT/ios-native/Info.plist" > "$APP/Info.plist"
printf 'APPL????' > "$APP/PkgInfo"
cp -R "$ROOT/dist" "$APP/public"

ICON="$ROOT/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"
if [ -f "$ICON" ]; then
  python3 - "$ICON" "$APP" <<'PY'
import sys
from PIL import Image
src, app = sys.argv[1], sys.argv[2]
img = Image.open(src).convert('RGB')  # app icons must not have alpha
for name, px in [('AppIcon60x60@2x.png', 120), ('AppIcon60x60@3x.png', 180), ('AppIcon76x76@2x~ipad.png', 152),
                 ('AppIcon83.5x83.5@2x~ipad.png', 167), ('AppIcon76x76~ipad.png', 76)]:
    img.resize((px, px), Image.LANCZOS).save(f'{app}/{name}')
PY
fi

echo "--> Packaging $OUT"
mkdir -p "$(dirname "$OUT")"
OUT_ABS="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
rm -f "$OUT_ABS"
(cd "$WORK" && zip -qr -X "$OUT_ABS" Payload)
echo "    $(du -h "$OUT_ABS" | cut -f1)  $OUT_ABS"
