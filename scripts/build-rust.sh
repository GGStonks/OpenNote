#!/usr/bin/env bash
# Builds the app's Rust library (crates/native) for the devices:
#   android  libopennote_native.so for arm64-v8a, armeabi-v7a and x86_64 (emulators, Chromebooks)
#            into android/app/src/main/jniLibs/
#            (git-ignored; loaded by OpenNoteRustPlugin.java)
#   ios      target/aarch64-apple-ios/release/libopennote_native.a (linked by scripts/build-ios.sh)
# Usage: scripts/build-rust.sh [android] [ios]   (both when none is named)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
TARGETS=("$@")
[ ${#TARGETS[@]} -eq 0 ] && TARGETS=(android ios)

for t in "${TARGETS[@]}"; do
  case "$t" in
    android)
      # cargo-ndk reads the NDK from the environment, not from .cargo/config.toml's [env].
      export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$HOME/android-tools/sdk/ndk/27.2.12479018}"
      echo "--> Rust for Android (arm64-v8a, armeabi-v7a, x86_64)"
      cargo ndk -t arm64-v8a -t armeabi-v7a -t x86_64 -o android/app/src/main/jniLibs build --release -p opennote_native --features jni
      for abi in arm64-v8a armeabi-v7a x86_64; do
        [ -s "android/app/src/main/jniLibs/$abi/libopennote_native.so" ] || { echo "missing $abi/libopennote_native.so"; exit 1; }
      done
      ;;
    ios)
      echo "--> Rust for iOS (aarch64-apple-ios)"
      cargo build --release --target aarch64-apple-ios -p opennote_native
      [ -s target/aarch64-apple-ios/release/libopennote_native.a ] || { echo "missing libopennote_native.a"; exit 1; }
      ;;
    *) echo "unknown target $t (android, ios)"; exit 1 ;;
  esac
done
