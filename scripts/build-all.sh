#!/usr/bin/env bash
set -euo pipefail

# Build all browse components:
#   1. Node.js bundle (esbuild)
#   2. macOS AX bridge (Swift)
#   3. Android driver APK (Gradle)
#   4. iOS runner source (copy for on-device build)

OUTDIR="dist"
BINDIR="bin"

mkdir -p "$OUTDIR" "$BINDIR"

# ─── 1. Node.js bundle ──────────────────────────────────────────

echo "=== Node.js bundle ==="
npm run build
echo "  → $OUTDIR/browse.cjs ($(wc -c < "$OUTDIR/browse.cjs" | tr -d ' ') bytes)"

# ─── 2. macOS AX bridge (Swift) ─────────────────────────────────

AX_DIR="browse-ax"
AX_BIN="$BINDIR/browse-ax"

if [ -d "$AX_DIR" ] && [ "$(uname)" = "Darwin" ]; then
  echo ""
  echo "=== macOS AX bridge ==="
  if [ -f "$AX_DIR/Package.swift" ]; then
    (cd "$AX_DIR" && swift build -c release 2>&1 | tail -1)
    AX_BUILD="$AX_DIR/.build/release/browse-ax"
    if [ -f "$AX_BUILD" ]; then
      cp "$AX_BUILD" "$AX_BIN"
      echo "  → $AX_BIN ($(wc -c < "$AX_BIN" | tr -d ' ') bytes)"
    else
      echo "  ⚠ browse-ax binary not found after build"
    fi
  else
    echo "  ⚠ Package.swift not found in $AX_DIR. Skipping."
  fi
else
  echo ""
  echo "Skipping macOS AX bridge (not macOS or $AX_DIR/ not found)"
fi

# ─── 3. Android driver APK ──────────────────────────────────────

ANDROID_DIR="browse-android"
ANDROID_APP_APK="$ANDROID_DIR/app/build/outputs/apk/debug/app-debug.apk"
ANDROID_TEST_APK="$ANDROID_DIR/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
ANDROID_APP_DST="$BINDIR/browse-android-app.apk"
ANDROID_TEST_DST="$BINDIR/browse-android.apk"

if [ -d "$ANDROID_DIR" ] && [ -f "$ANDROID_DIR/gradlew" ]; then
  echo ""
  echo "=== Android driver APK ==="

  # Ensure JAVA_HOME is set for Homebrew openjdk
  if [ -z "${JAVA_HOME:-}" ]; then
    for jdk in /opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
               /usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
               /opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home; do
      if [ -d "$jdk" ]; then
        export JAVA_HOME="$jdk"
        export PATH="$jdk/bin:$PATH"
        break
      fi
    done
  fi

  # Ensure ANDROID_HOME is set
  if [ -z "${ANDROID_HOME:-}" ]; then
    for sdk in "$HOME/Library/Android/sdk" \
               /opt/homebrew/share/android-commandlinetools \
               "$HOME/Android/Sdk"; do
      if [ -d "$sdk" ]; then
        export ANDROID_HOME="$sdk"
        break
      fi
    done
  fi

  if command -v java >/dev/null 2>&1 && [ -n "${ANDROID_HOME:-}" ]; then
    (cd "$ANDROID_DIR" && ./gradlew :app:assembleDebug :app:assembleDebugAndroidTest --no-daemon -q 2>&1) && {
      if [ -f "$ANDROID_APP_APK" ] && [ -f "$ANDROID_TEST_APK" ]; then
        cp "$ANDROID_APP_APK" "$ANDROID_APP_DST"
        cp "$ANDROID_TEST_APK" "$ANDROID_TEST_DST"
        echo "  → $ANDROID_APP_DST ($(wc -c < "$ANDROID_APP_DST" | tr -d ' ') bytes)"
        echo "  → $ANDROID_TEST_DST ($(wc -c < "$ANDROID_TEST_DST" | tr -d ' ') bytes)"
      else
        echo "  ⚠ APK files not found after build"
      fi
    } || {
      echo "  ⚠ Android build failed. Skipping."
    }
  else
    echo "  ⚠ Java or ANDROID_HOME not found. Skipping."
    echo "    Install: brew install openjdk@21 android-platform-tools"
  fi
else
  echo ""
  echo "Skipping Android APK ($ANDROID_DIR/ not found or no gradlew)"
fi

# ─── 4. iOS runner source ───────────────────────────────────────

IOS_DIR="browse-ios-runner"
IOS_DST="$BINDIR/browse-ios-runner"

if [ -d "$IOS_DIR" ]; then
  echo ""
  echo "=== iOS runner source ==="
  # Copy source files needed for on-device build (xcodebuild runs at sim start time)
  rm -rf "$IOS_DST"
  mkdir -p "$IOS_DST"
  cp -R "$IOS_DIR/BrowseRunnerApp" "$IOS_DST/"
  cp -R "$IOS_DIR/BrowseRunnerUITests" "$IOS_DST/"
  cp "$IOS_DIR/project.yml" "$IOS_DST/"
  if [ -f "$IOS_DIR/build.sh" ]; then
    cp "$IOS_DIR/build.sh" "$IOS_DST/"
  fi
  FILE_COUNT=$(find "$IOS_DST" -type f | wc -l | tr -d ' ')
  echo "  → $IOS_DST/ ($FILE_COUNT files)"
else
  echo ""
  echo "Skipping iOS runner ($IOS_DIR/ not found)"
fi

# ─── Summary ────────────────────────────────────────────────────

echo ""
echo "=== Build complete ==="
echo "Contents of $BINDIR/:"
ls -lh "$BINDIR/" 2>/dev/null || echo "  (empty)"
echo ""
echo "Contents of $OUTDIR/:"
ls -lh "$OUTDIR/"
