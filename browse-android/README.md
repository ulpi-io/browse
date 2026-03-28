# browse-android

On-device instrumentation driver for Android app automation.

The driver runs as an instrumentation test that starts an HTTP service inside
the Android emulator or physical device. The browse host adapter communicates
with it over `adb forward` (TCP port 7779 by default).

## Architecture

```
Host (Node.js)                        Device / Emulator
──────────────────────────────────    ────────────────────────────────────
src/app/android/bridge.ts             browse-android driver
  ensureAndroidBridge()               (instrumentation test process)
  createAndroidBridge(serial, pkg)
         │                                      │
         │   adb forward tcp:7779 tcp:7779       │
         │──────────────────────────────────────►│
         │                                      │
         │   HTTP POST /command                  │
         │──────────────────────────────────────►│
         │   { tree | action | setValue | … }    │
         │                                      │   UiAutomator
         │                                      │   AccessibilityNodeInfo
         │◄──────────────────────────────────────│
         │   { success, data }                   │
```

## Build Requirements

- Android SDK 34 (targetSdk)
- Android SDK 24+ on device / emulator (minSdk)
- Kotlin 1.9+
- Gradle 8.x

## Building

```bash
cd browse-android

# Build the instrumentation APK (debug)
./gradlew :app:assembleDebugAndroidTest

# The APK is at:
#   app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
```

## Installing and Running the Driver

The host adapter (`src/app/android/bridge.ts`) handles this automatically when
you start an Android session. For manual control:

```bash
# 1. Install the driver APK
adb install -t app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk

# 2. Start the instrumentation service (stays running until killed)
adb shell am instrument \
  -w -e targetPackage com.example.myapp \
  io.ulpi.browse.driver.test/androidx.test.runner.AndroidJUnitRunner

# 3. Forward the driver port to localhost
adb forward tcp:7779 tcp:7779

# 4. Use browse as normal
browse --session android snapshot
browse --session android tap @e3
```

## Protocol

The driver exposes a JSON-over-HTTP API on port 7779 (device-side):

| Method | Path | Body | Response |
|--------|------|------|----------|
| GET | /health | — | `{ status: "ok" }` |
| POST | /tree | — | `RawAndroidNode` |
| POST | /action | `{ path, action }` | `{ success, error? }` |
| POST | /setValue | `{ path, value }` | `{ success, error? }` |
| POST | /type | `{ text }` | `{ success, error? }` |
| POST | /press | `{ key }` | `{ success, error? }` |
| POST | /screenshot | `{ outputPath }` | `{ success, error? }` |
| GET | /state | — | `AndroidState` |

All `path` values are arrays of integer child indices tracing a node from
the root of the accessibility tree (matching `RawAndroidNode.path`).

## Supported Key Names (press command)

`ENTER`, `BACK`, `HOME`, `DPAD_UP`, `DPAD_DOWN`, `DPAD_LEFT`, `DPAD_RIGHT`,
`TAB`, `SPACE`, `DEL` (backspace), `FORWARD_DEL` (delete).

## Troubleshooting

**Driver does not start**
- Verify the target app is installed: `adb shell pm list packages | grep com.example.myapp`
- Check logcat: `adb logcat -s BrowseDriver`

**Connection refused on port 7779**
- Confirm `adb forward` is active: `adb forward --list`
- Re-run: `adb forward tcp:7779 tcp:7779`

**Tree returns empty**
- The target package must be in the foreground. Bring it to front:
  `adb shell monkey -p com.example.myapp -c android.intent.category.LAUNCHER 1`
