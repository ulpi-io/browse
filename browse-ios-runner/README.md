# browse-ios-runner

A lightweight SwiftUI app that runs inside the iOS Simulator and exposes an HTTP-based RPC server for UI automation. This is the in-simulator counterpart to the host-side `src/app/ios/` bridge.

## Architecture

```
Host (macOS, Node.js)                    iOS Simulator
+-------------------+                   +---------------------+
| src/app/ios/      |   HTTP (9820)     | BrowseRunner.app    |
|   bridge.ts  ---- | ----------------> |   RunnerServer      |
|   controller.ts   |   JSON RPC        |   (NWListener)      |
|   manager.ts      |                   |                     |
|   protocol.ts     |                   |   AccessibilityTree |
+-------------------+                   |   ActionExecutor    |
                                        |   ScreenshotCap     |
                                        +---------------------+
                                                  |
                                                  v
                                        +---------------------+
                                        | Target App          |
                                        | (via XCUITest APIs) |
                                        +---------------------+
```

### How It Works

1. **Host starts the runner**: The bridge (`src/app/ios/bridge.ts`) uses `simctl launch` to start BrowseRunner in the simulator, passing the target app's bundle ID and runner port as environment variables.

2. **Runner hosts HTTP server**: On launch, BrowseRunner starts an HTTP server on the configured port (default 9820). The simulator's network stack makes this port accessible on `127.0.0.1` from the host.

3. **RPC over HTTP**: The host sends JSON POST requests to endpoints like `/tree`, `/action`, `/state`, etc. The runner responds with JSON matching the protocol defined in `src/app/ios/protocol.ts`.

4. **Accessibility tree traversal**: The runner uses XCUITest-style accessibility APIs to walk the UI element tree of the target app, converting each element to the `RawIOSNode` format.

5. **Actions**: Tap, type, set-value, and press commands are executed through the accessibility system on the corresponding element at the given tree path.

## RPC Endpoints

| Endpoint | Method | Request Body | Response |
|----------|--------|-------------|----------|
| `/health` | GET | -- | `{ "status": "ok" }` |
| `/tree` | POST | -- | `{ "success": true, "data": RawIOSNode }` |
| `/action` | POST | `{ "path": [0,1,2], "actionName": "tap" }` | `{ "success": true }` |
| `/set-value` | POST | `{ "path": [0,1,2], "value": "hello" }` | `{ "success": true }` |
| `/type` | POST | `{ "text": "hello world" }` | `{ "success": true }` |
| `/press` | POST | `{ "key": "return" }` | `{ "success": true }` |
| `/screenshot` | POST | `{ "outputPath": "/tmp/shot.png" }` | `{ "success": true }` |
| `/state` | POST | -- | `{ "success": true, "data": IOSState }` |

## Building

> **Note**: The Xcode project (.xcodeproj) must be created in Xcode since .pbxproj files cannot be generated programmatically in a reliable way.

### Create the Xcode Project

1. Open Xcode
2. File > New > Project > iOS > App
3. Product Name: `BrowseRunner`
4. Bundle Identifier: `io.ulpi.browse-ios-runner`
5. Interface: SwiftUI
6. Language: Swift
7. Save to this directory (`browse-ios-runner/`)

### Project Structure (to implement)

```
BrowseRunner/
  BrowseRunnerApp.swift      App entry point — starts HTTP server on launch
  RunnerServer.swift         NWListener-based HTTP server (port from env)
  AccessibilityWalker.swift  Walks the AX tree, builds RawIOSNode JSON
  ActionExecutor.swift       Executes tap/type/setValue on elements by path
  ScreenshotCapture.swift    Captures window screenshot via UIGraphicsRenderer
  Models/
    RawIOSNode.swift         Codable struct matching protocol.ts RawIOSNode
    IOSState.swift           Codable struct matching protocol.ts IOSState
    RunnerResponse.swift     Generic response envelope { success, data?, error? }
```

### Build and Install

```bash
# Build for simulator
xcodebuild \
  -project BrowseRunner.xcodeproj \
  -scheme BrowseRunner \
  -sdk iphonesimulator \
  -configuration Debug \
  -derivedDataPath .build

# Install into a booted simulator
xcrun simctl install booted .build/Build/Products/Debug-iphonesimulator/BrowseRunner.app
```

### Or use the automated flow

```bash
# browse handles install + launch automatically:
browse --platform ios --app com.example.myapp snapshot
```

## Environment Variables (read by runner on launch)

| Variable | Default | Purpose |
|----------|---------|---------|
| `BROWSE_TARGET_BUNDLE_ID` | -- | Bundle ID of the app to instrument |
| `BROWSE_RUNNER_PORT` | 9820 | HTTP server port |

These are passed via `simctl launch` environment injection:
```bash
xcrun simctl launch <UDID> io.ulpi.browse-ios-runner \
  SIMCTL_CHILD_BROWSE_TARGET_BUNDLE_ID=com.example.myapp \
  SIMCTL_CHILD_BROWSE_RUNNER_PORT=9820
```

## Protocol Types

The TypeScript protocol definitions live in `src/app/ios/protocol.ts`. The Swift runner must produce JSON that exactly matches these types. See that file for the canonical type definitions.

## Port Forwarding

iOS Simulator networking automatically makes ports bound to `0.0.0.0` or `127.0.0.1` inside the simulator accessible on the host's `127.0.0.1`. No explicit port forwarding is needed.

## Limitations

- **Simulator only**: Real iOS devices require a different approach (WebDriverAgent or similar). This runner targets the Simulator for development/CI workflows.
- **Single target app**: Each runner instance instruments one app. To automate multiple apps, launch multiple runner instances on different ports.
- **XCUITest dependency**: The runner needs entitlements to access the accessibility tree of other apps. In the simulator, this is generally available without special signing.
