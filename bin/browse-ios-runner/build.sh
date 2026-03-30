#!/bin/bash
set -euo pipefail

# build.sh — Build the BrowseRunner XCUITest bundle.
#
# Prerequisites:
#   - Xcode installed (xcrun, xcodebuild)
#   - xcodegen installed: brew install xcodegen
#
# Usage:
#   cd browse-ios-runner && ./build.sh
#   ./build.sh --install        # Also install to booted simulator
#   ./build.sh --install <UDID> # Install to specific simulator

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

DERIVED_DATA=".build"
SCHEME="BrowseRunnerUITests"
SDK="iphonesimulator"
CONFIGURATION="Debug"

# ── Step 1: Generate Xcode project from project.yml ──

if ! command -v xcodegen &> /dev/null; then
    echo "Error: xcodegen not found. Install with: brew install xcodegen"
    exit 1
fi

echo "==> Generating Xcode project..."
xcodegen generate --spec project.yml

# ── Step 2: Build the UI test bundle ──

echo "==> Building BrowseRunner..."
xcodebuild \
    -project BrowseRunner.xcodeproj \
    -scheme BrowseRunnerApp \
    -sdk "$SDK" \
    -configuration "$CONFIGURATION" \
    -derivedDataPath "$DERIVED_DATA" \
    -destination "generic/platform=iOS Simulator" \
    build-for-testing \
    CODE_SIGN_IDENTITY="" \
    CODE_SIGNING_ALLOWED=NO \
    2>&1 | tail -20

BUILD_DIR="$DERIVED_DATA/Build/Products/$CONFIGURATION-$SDK"
APP_PATH="$BUILD_DIR/BrowseRunnerApp.app"
TEST_RUNNER="$BUILD_DIR/BrowseRunnerUITests-Runner.app"

if [ ! -d "$APP_PATH" ]; then
    echo "Error: Build failed — $APP_PATH not found"
    exit 1
fi

echo "==> Build successful"
echo "    App:         $APP_PATH"
echo "    Test runner: $TEST_RUNNER"

# ── Step 3: Optional install ──

if [[ "${1:-}" == "--install" ]]; then
    UDID="${2:-booted}"
    echo "==> Installing to simulator ($UDID)..."
    xcrun simctl install "$UDID" "$APP_PATH"
    if [ -d "$TEST_RUNNER" ]; then
        xcrun simctl install "$UDID" "$TEST_RUNNER"
    fi
    echo "==> Installed successfully"
fi

echo ""
echo "To run the test server in a booted simulator:"
echo "  xcodebuild \\"
echo "    -project BrowseRunner.xcodeproj \\"
echo "    -scheme BrowseRunnerUITests \\"
echo "    -sdk iphonesimulator \\"
echo "    -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \\"
echo "    -derivedDataPath .build \\"
echo "    test-without-building"
