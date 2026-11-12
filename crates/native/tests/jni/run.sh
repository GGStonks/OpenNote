#!/usr/bin/env bash
# Calls the Android JNI entry point (Java_com_opennote_app_OpenNoteRustPlugin_nativeCall) from a JVM
# on the PC: the library built for the host with the `jni` feature, a stand-in class of the same name.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
JAVA_HOME="${JAVA_HOME:-$HOME/android-tools/jdk-21}"
cargo build --release -q -p opennote_native --features jni --manifest-path "$ROOT/Cargo.toml"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
"$JAVA_HOME/bin/javac" -d "$OUT" "$(dirname "$0")/com/opennote/app/OpenNoteRustPlugin.java"
"$JAVA_HOME/bin/java" -cp "$OUT" com.opennote.app.OpenNoteRustPlugin "$ROOT/target/release/libopennote_native.so"
