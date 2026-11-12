#!/usr/bin/env bash
IOS_SDK="${IOS_SDK:-$HOME/android-tools/ios-sdk/iPhoneOS16.5.sdk}"
MIN_IOS=15.0
SDK_VER=16.5

exec clang -target arm64-apple-ios$MIN_IOS \
  -isysroot "$IOS_SDK" \
  -fuse-ld=/usr/bin/ld64.lld \
  -Wl,-platform_version,ios,$MIN_IOS,$SDK_VER \
  -Wl,-arch,arm64 \
  "$@"
