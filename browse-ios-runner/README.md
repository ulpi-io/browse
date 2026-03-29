# browse-ios-runner

A lightweight XCUITest-based runner that hosts an HTTP server inside the iOS Simulator, exposing the accessibility tree and UI actions via JSON RPC. This is the in-simulator counterpart to the host-side `src/app/ios/` bridge.

## Architecture

```
Host (macOS, Node.js)                    iOS Simulator
+-------------------+                   +---------------------+
| src/app/ios/      |   HTTP (9820)     | XCUITest process    |
|   bridge.ts  ---- | ----------------> |   RunnerServer      |
|   controller.ts   |   JSON RPC        |   (NWListener)      |
|   manager.ts      |                   |                     |
|   protocol.ts     |                   |   TreeBuilder       |
+-------------------+                   |   ActionHandler     |
                                        |   StateHandler      |
                                        |   ScreenshotHandler |
                                        +---------------------+
                                                  |
                                                  v
                                        +---------------------+
                                        | Target App          |
                                        | (via XCUITest APIs) |
                                        +---------------------+
```

### How It Works

1. **Host starts the test**: The bridge (`src/app/ios/bridge.ts`) uses `xcodebuild test` to run `BrowseRunnerUITests` in the simulator. The test process hosts the HTTP server.

2. **XCUITest hosts HTTP server**: The `testRunServer()` method starts an `NWListener`-based HTTP server on the configured port (default 9820) and blocks forever. The server handles JSON RPC requests on its own dispatch queue.

3. **RPC over HTTP**: The host sends JSON POST requests to endpoints like `/tree`, `/action`, `/state`, etc. The runner responds with JSON matching the protocol defined in `src/app/ios/protocol.ts`.

4. **Accessibility tree traversal**: `TreeBuilder` walks the XCUIApplication element hierarchy using `children(matching: .any)`, converting each `XCUIElement` to the `RawIOSNode` JSON format.

5. **Actions**: Tap, type, set-value, and press commands are executed through XCUIElement methods on elements resolved by tree path (array of child indices).

## Project Structure

```
browse-ios-runner/
  project.yml                          XcodeGen project spec
  build.sh                             Build + optional install script
  README.md                            This file
  BrowseRunnerApp/
    BrowseRunnerApp.swift              Minimal SwiftUI host app (required by XCUITest)
  BrowseRunnerUITests/
    BrowseRunnerUITests.swift          XCUITest entry point — starts server, registers routes
    RunnerServer.swift                 NWListener-based HTTP server
    TreeBuilder.swift                  Walk XCUIApplication hierarchy -> RawIOSNode JSON
    ActionHandler.swift                Tap, setValue, typeText, pressKey
    StateHandler.swift                 Capture IOSState (title, keyboard, orientation, etc.)
    ScreenshotHandler.swift            Capture app screenshot -> PNG file
    Models.swift                       Codable structs matching protocol.ts types
```

## RPC Endpoints

| Endpoint | Method | Request Body | Response |
|----------|--------|-------------|----------|
| `/health` | GET | -- | `{ "success": true, "data": { "status": "healthy" } }` |
| `/tree` | POST | -- | `{ "success": true, "data": RawIOSNode }` |
| `/action` | POST | `{ "path": [0,1,2], "actionName": "tap" }` | `{ "success": true }` |
| `/set-value` | POST | `{ "path": [0,1,2], "value": "hello" }` | `{ "success": true }` |
| `/type` | POST | `{ "text": "hello world" }` | `{ "success": true }` |
| `/press` | POST | `{ "key": "return" }` | `{ "success": true }` |
| `/screenshot` | POST | `{ "outputPath": "/tmp/shot.png" }` | `{ "success": true }` |
| `/state` | POST | -- | `{ "success": true, "data": IOSState }` |

### Supported Actions

| Action Name | Description |
|------------|-------------|
| `tap` / `press` / `AXPress` | Single tap on element |
| `doubleTap` | Double tap |
| `longPress` | Long press (1 second hold) |
| `swipeUp` / `swipeDown` / `swipeLeft` / `swipeRight` | Swipe gestures |
| `twoFingerTap` | Two-finger tap |
| `forceTap` | Coordinate-based tap (for elements not directly tappable) |

### Supported Keys (for `/press`)

| Key | Description |
|-----|-------------|
| `return` / `enter` | Return key |
| `delete` / `backspace` | Delete backward |
| `tab` | Tab key |
| `escape` | Escape / keyboard dismiss |
| `space` | Space bar |
| `home` | Home button (XCUIDevice) |
| `volumeUp` / `volumeDown` | Volume buttons |
| Single character | Typed directly |

## Building

### Prerequisites

- Xcode (with iOS Simulator runtime)
- [XcodeGen](https://github.com/yonaskolb/XcodeGen): `brew install xcodegen`

### Generate Xcode Project

```bash
cd browse-ios-runner
xcodegen generate --spec project.yml
```

### Build for Testing

```bash
xcodebuild \
  -project BrowseRunner.xcodeproj \
  -scheme BrowseRunnerApp \
  -sdk iphonesimulator \
  -configuration Debug \
  -derivedDataPath .build \
  -destination "generic/platform=iOS Simulator" \
  build-for-testing \
  CODE_SIGN_IDENTITY="" \
  CODE_SIGNING_ALLOWED=NO
```

### Or Use the Build Script

```bash
cd browse-ios-runner
./build.sh              # Build only
./build.sh --install    # Build + install to booted simulator
```

### Run the Test Server

```bash
xcodebuild \
  -project BrowseRunner.xcodeproj \
  -scheme BrowseRunnerUITests \
  -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  -derivedDataPath .build \
  test-without-building
```

This starts the test process which blocks forever, hosting the HTTP server on port 9820. The server is ready when you can reach:

```bash
curl http://127.0.0.1:9820/health
# {"success":true,"data":{"status":"healthy"}}
```

### Or use the automated flow

```bash
# browse handles build + install + launch automatically:
browse --platform ios --app com.example.myapp snapshot
```

## Environment Variables (read by runner on launch)

| Variable | Default | Purpose |
|----------|---------|---------|
| `BROWSE_TARGET_BUNDLE_ID` | `io.ulpi.browse-ios-runner` | Bundle ID of the app to instrument |
| `BROWSE_RUNNER_PORT` | `9820` | HTTP server port |

These are passed via `xcodebuild test` environment injection or via the bridge's simctl launch mechanism.

## Tree Path Addressing

Elements are addressed by their tree path -- an array of child indices from the root:

- `[0]` -- the application root
- `[0, 2]` -- the third child of the root
- `[0, 1, 0, 3]` -- navigating deeper into the hierarchy

The bridge's `convertTree()` function assigns paths depth-first, matching the order `TreeBuilder` walks the tree using `children(matching: .any)`.

## Protocol Types

The TypeScript protocol definitions live in `src/app/ios/protocol.ts`. The Swift runner produces JSON that exactly matches these types:

- **`RawIOSNode`** -- accessibility tree node with elementType, identifier, label, value, frame, traits, children
- **`IOSState`** -- lightweight state: bundleId, screenTitle, elementCount, alertPresent, keyboardVisible, orientation
- **`RunnerResponse<T>`** -- envelope: `{ success: boolean, data?: T, error?: string }`

## Port Forwarding

iOS Simulator networking automatically makes ports bound inside the simulator accessible on the host's `127.0.0.1`. No explicit port forwarding is needed.

## Limitations

- **Simulator only**: Real iOS devices require a different approach (WebDriverAgent or similar). This runner targets the Simulator for development/CI workflows.
- **Single target app**: Each runner instance instruments one app. To automate multiple apps, launch multiple runner instances on different ports.
- **Tree traversal performance**: Deep UI hierarchies (1000+ elements) may take 1-2 seconds to traverse. The bridge should cache the tree and refresh only when needed.
- **XCUITest threading**: XCUIElement operations execute on the main thread internally. The HTTP server runs on a separate dispatch queue, but handler closures that call XCUIElement methods will block on XCUITest's internal serialization.
