#!/bin/bash
set -euo pipefail

# macOS DMG Builder
# Builds a Release archive from an Xcode project and packages it as a DMG.
#
# Required env vars:
#   APP_NAME        — Display name for the .app and DMG volume (e.g. "MyApp")
#   SCHEME          — Xcode scheme to build
#
# Optional env vars:
#   PROJECT         — .xcodeproj path (auto-detected if only one exists)
#   WORKSPACE       — .xcworkspace path (takes precedence over PROJECT)
#   INFO_PLIST      — Path to Info.plist for version injection (auto-detected from scheme dir)
#   EXPORT_OPTIONS  — Path to ExportOptions.plist (default: scripts/ExportOptions.plist)
#   TEAM_ID         — Apple Development Team ID (omit for Xcode-managed signing)
#   VERSION_FILE    — Path to VERSION file (default: VERSION). Set to "none" to skip version management.
#   USE_XCODEGEN    — Set to "1" to run xcodegen before building
#   DMG_BACKGROUND  — Path to DMG background image (optional)

# This script lives in .claude/skills/build-dmg/helpers/ — NOT in the project tree.
# The agent runs it from the project root, so pwd is the project root.
PROJECT_ROOT="${PROJECT_ROOT:-$(pwd)}"
cd "$PROJECT_ROOT"

# --- Validate required vars ---
if [ -z "${APP_NAME:-}" ]; then
    echo "ERROR: APP_NAME is required (e.g. APP_NAME=MyApp)"
    exit 1
fi
if [ -z "${SCHEME:-}" ]; then
    echo "ERROR: SCHEME is required (e.g. SCHEME=MyApp)"
    exit 1
fi

# --- Auto-detect project ---
if [ -n "${WORKSPACE:-}" ]; then
    BUILD_SRC="-workspace $WORKSPACE"
elif [ -n "${PROJECT:-}" ]; then
    BUILD_SRC="-project $PROJECT"
else
    PROJ_COUNT=$(find . -maxdepth 1 -name "*.xcodeproj" | wc -l | tr -d ' ')
    if [ "$PROJ_COUNT" -eq 1 ]; then
        DETECTED_PROJ=$(find . -maxdepth 1 -name "*.xcodeproj" -print -quit)
        BUILD_SRC="-project $DETECTED_PROJ"
        echo "Auto-detected project: $DETECTED_PROJ"
    elif [ "$PROJ_COUNT" -eq 0 ]; then
        WS_COUNT=$(find . -maxdepth 1 -name "*.xcworkspace" | wc -l | tr -d ' ')
        if [ "$WS_COUNT" -eq 1 ]; then
            DETECTED_WS=$(find . -maxdepth 1 -name "*.xcworkspace" -print -quit)
            BUILD_SRC="-workspace $DETECTED_WS"
            echo "Auto-detected workspace: $DETECTED_WS"
        else
            echo "ERROR: No .xcodeproj found. Set PROJECT or WORKSPACE."
            exit 1
        fi
    else
        echo "ERROR: Multiple .xcodeproj found. Set PROJECT explicitly."
        exit 1
    fi
fi

# --- Defaults ---
EXPORT_OPTIONS="${EXPORT_OPTIONS:-scripts/ExportOptions.plist}"
VERSION_FILE="${VERSION_FILE:-VERSION}"
USE_XCODEGEN="${USE_XCODEGEN:-0}"

BUILD_DIR="build/dmg-staging"
ARCHIVE_PATH="build/${SCHEME}.xcarchive"
EXPORT_DIR="build/export"

# --- Version ---
if [ "$VERSION_FILE" != "none" ] && [ -f "$VERSION_FILE" ]; then
    VERSION=$(cat "$VERSION_FILE" | tr -d '[:space:]')
else
    VERSION="${VERSION:-1.0.0}"
fi
BUILD_NUMBER=$(date +%Y%m%d%H)
DMG_NAME="${APP_NAME}-${VERSION}-b${BUILD_NUMBER}.dmg"

echo "Building ${APP_NAME} ${VERSION} (build ${BUILD_NUMBER})..."

# --- Clean previous artifacts ---
rm -rf "$BUILD_DIR" "$ARCHIVE_PATH" "$EXPORT_DIR"
mkdir -p "$BUILD_DIR"

# --- Inject version into Info.plist (if available) ---
if [ -z "${INFO_PLIST:-}" ]; then
    # Try common locations
    for candidate in "${SCHEME}/Info.plist" "${APP_NAME}/Info.plist"; do
        if [ -f "$candidate" ]; then
            INFO_PLIST="$candidate"
            break
        fi
    done
fi

RESTORE_PLIST=0
if [ -n "${INFO_PLIST:-}" ] && [ -f "$INFO_PLIST" ]; then
    ORIG_VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$INFO_PLIST" 2>/dev/null || echo "")
    ORIG_BUILD=$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$INFO_PLIST" 2>/dev/null || echo "")

    if [ -n "$ORIG_VERSION" ]; then
        /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$INFO_PLIST"
        /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUMBER" "$INFO_PLIST"
        RESTORE_PLIST=1
    fi
fi

restore_plist() {
    if [ "$RESTORE_PLIST" -eq 1 ]; then
        /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $ORIG_VERSION" "$INFO_PLIST"
        /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $ORIG_BUILD" "$INFO_PLIST"
    fi
}
trap restore_plist EXIT

# --- Generate Xcode project (optional) ---
if [ "$USE_XCODEGEN" = "1" ]; then
    echo "Regenerating Xcode project..."
    xcodegen generate
fi

# --- Build signing flags ---
SIGN_FLAGS=()
if [ -n "${TEAM_ID:-}" ]; then
    SIGN_FLAGS+=(DEVELOPMENT_TEAM="$TEAM_ID")
fi
SIGN_FLAGS+=(CODE_SIGN_STYLE=Automatic CODE_SIGN_IDENTITY="Apple Development")

# --- Archive ---
echo "Archiving..."
xcodebuild archive \
    $BUILD_SRC \
    -scheme "$SCHEME" \
    -archivePath "$ARCHIVE_PATH" \
    -destination 'generic/platform=macOS' \
    "${SIGN_FLAGS[@]}" \
    MARKETING_VERSION="$VERSION" \
    CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
    ARCHS=arm64 \
    ONLY_ACTIVE_ARCH=NO \
    2>&1 | tail -20

# --- Export .app ---
echo "Exporting app..."
xcodebuild -exportArchive \
    -archivePath "$ARCHIVE_PATH" \
    -exportPath "$EXPORT_DIR" \
    -exportOptionsPlist "$EXPORT_OPTIONS" \
    2>&1 | tail -20

# --- Find the exported .app ---
APP_PATH=$(find "$EXPORT_DIR" -name "*.app" -maxdepth 1 | head -1)
if [ -z "$APP_PATH" ]; then
    echo "ERROR: No .app found in $EXPORT_DIR"
    exit 1
fi
echo "Found app: $(basename "$APP_PATH")"

# --- Stage DMG contents ---
cp -R "$APP_PATH" "$BUILD_DIR/${APP_NAME}.app"
ln -s /Applications "$BUILD_DIR/Applications"

# --- Create DMG ---
echo "Creating DMG..."
mkdir -p build
RW_DMG="build/${APP_NAME}-rw.dmg"
rm -f "$RW_DMG"

hdiutil create \
    -volname "$APP_NAME" \
    -srcfolder "$BUILD_DIR" \
    -ov -format UDRW \
    "$RW_DMG"

# --- Style the DMG window ---
echo "Styling DMG..."
MOUNT_DIR=$(hdiutil attach -readwrite -noverify "$RW_DMG" | grep '/Volumes/' | awk -F'\t' '{print $NF}')

if [ -n "${DMG_BACKGROUND:-}" ] && [ -f "$DMG_BACKGROUND" ]; then
    mkdir -p "$MOUNT_DIR/.background"
    cp "$DMG_BACKGROUND" "$MOUNT_DIR/.background/bg.png"
fi

osascript <<APPLESCRIPT
tell application "Finder"
    tell disk "${APP_NAME}"
        open
        set current view of container window to icon view
        set toolbar visible of container window to false
        set statusbar visible of container window to false
        set the bounds of container window to {100, 100, 640, 400}
        set viewOptions to the icon view options of container window
        set arrangement of viewOptions to not arranged
        set icon size of viewOptions to 100
        set background color of viewOptions to {65535, 65535, 65535}
        set position of item "${APP_NAME}.app" of container window to {140, 150}
        set position of item "Applications" of container window to {400, 150}
        close
    end tell
end tell
APPLESCRIPT

sync
hdiutil detach "$MOUNT_DIR" -quiet

# --- Convert to compressed read-only DMG ---
hdiutil convert "$RW_DMG" -format UDZO -o "build/$DMG_NAME"
rm -f "$RW_DMG"

# --- Clean up staging ---
rm -rf "$BUILD_DIR" "$ARCHIVE_PATH" "$EXPORT_DIR"

# --- Auto-bump minor version ---
if [ "$VERSION_FILE" != "none" ] && [ -f "$VERSION_FILE" ]; then
    IFS='.' read -r major minor patch <<< "$VERSION"
    NEXT_VERSION="${major}.$((minor + 1)).${patch}"
    echo "$NEXT_VERSION" > "$VERSION_FILE"
    echo ""
    echo "DMG created: build/$DMG_NAME"
    echo "  Version $VERSION (build $BUILD_NUMBER)"
    echo "  Next build will be $NEXT_VERSION"
else
    echo ""
    echo "DMG created: build/$DMG_NAME"
    echo "  Version $VERSION (build $BUILD_NUMBER)"
fi
