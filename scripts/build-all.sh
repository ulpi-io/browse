#!/usr/bin/env bash
set -euo pipefail

# Build Node.js bundle via esbuild
OUTDIR="dist"
ENTRY="src/cli.ts"

mkdir -p "$OUTDIR"

echo "Building ${OUTDIR}/browse.js..."
npx esbuild "$ENTRY" \
  --bundle \
  --platform=node \
  --target=node18 \
  --outfile="$OUTDIR/browse.js" \
  --external:playwright \
  --external:playwright-core \
  --external:better-sqlite3 \
  --external:electron \
  --external:chromium-bidi

echo "  → $(wc -c < "$OUTDIR/browse.js" | tr -d ' ') bytes"

# Build Android instrumentation APK (if Android SDK and gradle available)
ANDROID_DIR="browse-android"
ANDROID_APK_SRC="$ANDROID_DIR/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
ANDROID_APK_DST="bin/browse-android.apk"

if [ -d "$ANDROID_DIR" ] && command -v java >/dev/null 2>&1; then
  echo ""
  echo "Building Android instrumentation APK..."
  if [ -f "$ANDROID_DIR/gradlew" ]; then
    (cd "$ANDROID_DIR" && ./gradlew :app:assembleDebugAndroidTest --no-daemon -q 2>&1) && {
      if [ -f "$ANDROID_APK_SRC" ]; then
        cp "$ANDROID_APK_SRC" "$ANDROID_APK_DST"
        echo "  → $ANDROID_APK_DST ($(wc -c < "$ANDROID_APK_DST" | tr -d ' ') bytes)"
      else
        echo "  ⚠ APK not found at $ANDROID_APK_SRC (build may have failed)"
      fi
    } || {
      echo "  ⚠ Android build failed (requires Android SDK). Skipping."
    }
  else
    echo "  ⚠ gradlew not found in $ANDROID_DIR. Skipping."
  fi
else
  echo ""
  echo "Skipping Android APK (no Android SDK or browse-android/ not found)"
fi

echo ""
echo "Run with: node $OUTDIR/browse.js"
