import XCTest

// MARK: - BrowseRunner UI Tests

/// Main XCUITest class that hosts the HTTP server and routes RPC calls
/// to the appropriate handlers.
///
/// This is not a traditional test suite. It contains a single "test" method
/// that starts the HTTP server and blocks indefinitely, serving requests
/// from the browse host bridge. The test process acts as an automation
/// server, receiving commands over HTTP and executing them against the
/// target application via XCUITest APIs.
///
/// The target app's bundle ID is read from the `BROWSE_TARGET_BUNDLE_ID`
/// environment variable (injected via simctl launch). If not set, the
/// runner instruments its own host app (BrowseRunnerApp).
final class BrowseRunnerUITests: XCTestCase {

    /// The target application under test.
    private var targetApp: XCUIApplication!

    /// The runner's HTTP server.
    private var server: RunnerServer!

    /// The target app's bundle ID for state reporting.
    private var targetBundleId: String = ""

    // MARK: - Setup

    override func setUp() {
        super.setUp()
        continueAfterFailure = true

        // Resolve the target bundle ID from the environment.
        // When launched via simctl, environment variables are prefixed with
        // SIMCTL_CHILD_ but the test process receives them without the prefix.
        let envBundleId = ProcessInfo.processInfo.environment["BROWSE_TARGET_BUNDLE_ID"]
        targetBundleId = envBundleId ?? "io.ulpi.browse-ios-runner"

        // XCUITest always needs the host app to be launched first.
        // XCUIApplication() targets the host app (BrowseRunnerApp).
        let hostApp = XCUIApplication()
        hostApp.launch()

        // If targeting a different app, create a handle to it and launch it.
        if targetBundleId != "io.ulpi.browse-ios-runner" {
            targetApp = XCUIApplication(bundleIdentifier: targetBundleId)
            targetApp.launch()
        } else {
            targetApp = hostApp
        }
    }

    // MARK: - Server Test

    /// The main "test" — starts the HTTP server and blocks forever.
    ///
    /// This is invoked by `xcodebuild test` and keeps the test process alive
    /// so the HTTP server can serve requests. The test never "finishes" on
    /// its own; it is terminated externally when the browse session ends.
    func testRunServer() throws {
        let portString = ProcessInfo.processInfo.environment["BROWSE_RUNNER_PORT"] ?? "9820"
        let port = UInt16(portString) ?? 9820

        server = try RunnerServer(port: port)
        registerRoutes()
        server.start()

        NSLog("[BrowseRunner] Server started on port %u, target app: %@", port, targetBundleId)

        // Keep the main thread alive and responsive using RunLoop.
        // This allows DispatchQueue.main.async callbacks from the HTTP server
        // to execute (XCUITest APIs require main thread access).
        // The test will be terminated externally when no longer needed.
        while true {
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 1.0))
        }
    }

    // MARK: - Route Registration

    private func registerRoutes() {

        // GET /health — simple health check
        server.route("/health") { _ in
            return .success(["status": "healthy"])
        }

        // POST /configure — set the target app bundle ID at runtime
        server.route("/configure") { [weak self] request in
            guard let self = self else { return .error("Runner deallocated") }
            guard let body = request.body,
                  let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                  let bundleId = json["targetBundleId"] as? String else {
                return .error("Expected: {\"targetBundleId\": \"com.apple.Preferences\"}")
            }

            self.targetBundleId = bundleId
            if bundleId != "io.ulpi.browse-ios-runner" {
                self.targetApp = XCUIApplication(bundleIdentifier: bundleId)
                self.targetApp.launch()
            }
            NSLog("[BrowseRunner] Target app switched to: %@", bundleId)
            return .success(["configured": bundleId])
        }

        // POST /tree — full accessibility tree
        server.route("/tree") { [weak self] _ in
            guard let self = self else { return .error("Runner deallocated") }
            let tree = TreeBuilder.buildTree(from: self.targetApp)
            guard let data = try? JSONEncoder().encode(tree),
                  let dict = try? JSONSerialization.jsonObject(with: data) else {
                return .error("Failed to encode tree")
            }
            return .success(dict)
        }

        // POST /action — perform action on element
        server.route("/action") { [weak self] request in
            guard let self = self else { return .error("Runner deallocated") }
            guard let body = request.body else {
                return .error("Missing request body")
            }
            guard let req = try? JSONDecoder().decode(ActionRequest.self, from: body) else {
                return .error("Invalid request body. Expected: {\"path\":[0,1],\"actionName\":\"tap\"}")
            }
            let result = ActionHandler.performAction(
                app: self.targetApp,
                path: req.path,
                actionName: req.actionName
            )
            if let success = result["success"] as? Bool, success {
                return .success(result)
            } else {
                let errorMsg = result["error"] as? String ?? "Action failed"
                return .error(errorMsg)
            }
        }

        // POST /set-value — set text value on element
        server.route("/set-value") { [weak self] request in
            guard let self = self else { return .error("Runner deallocated") }
            guard let body = request.body else {
                return .error("Missing request body")
            }
            guard let req = try? JSONDecoder().decode(SetValueRequest.self, from: body) else {
                return .error("Invalid request body. Expected: {\"path\":[0,1],\"value\":\"text\"}")
            }
            let result = ActionHandler.setValue(
                app: self.targetApp,
                path: req.path,
                value: req.value
            )
            if let success = result["success"] as? Bool, success {
                return .success(result)
            } else {
                let errorMsg = result["error"] as? String ?? "Set value failed"
                return .error(errorMsg)
            }
        }

        // POST /type — type text via keyboard
        server.route("/type") { [weak self] request in
            guard let self = self else { return .error("Runner deallocated") }
            guard let body = request.body else {
                return .error("Missing request body")
            }
            guard let req = try? JSONDecoder().decode(TypeRequest.self, from: body) else {
                return .error("Invalid request body. Expected: {\"text\":\"hello\"}")
            }
            let result = ActionHandler.typeText(app: self.targetApp, text: req.text)
            if let success = result["success"] as? Bool, success {
                return .success(result)
            } else {
                let errorMsg = result["error"] as? String ?? "Type failed"
                return .error(errorMsg)
            }
        }

        // POST /press — press a key
        server.route("/press") { [weak self] request in
            guard let self = self else { return .error("Runner deallocated") }
            guard let body = request.body else {
                return .error("Missing request body")
            }
            guard let req = try? JSONDecoder().decode(PressRequest.self, from: body) else {
                return .error("Invalid request body. Expected: {\"key\":\"return\"}")
            }
            let result = ActionHandler.pressKey(app: self.targetApp, key: req.key)
            if let success = result["success"] as? Bool, success {
                return .success(result)
            } else {
                let errorMsg = result["error"] as? String ?? "Press key failed"
                return .error(errorMsg)
            }
        }

        // POST /screenshot — capture and save screenshot
        server.route("/screenshot") { [weak self] request in
            guard let self = self else { return .error("Runner deallocated") }
            guard let body = request.body else {
                return .error("Missing request body")
            }
            guard let req = try? JSONDecoder().decode(ScreenshotRequest.self, from: body) else {
                return .error("Invalid request body. Expected: {\"outputPath\":\"/tmp/shot.png\"}")
            }
            let result = ScreenshotHandler.captureScreenshot(
                app: self.targetApp,
                outputPath: req.outputPath
            )
            if let success = result["success"] as? Bool, success {
                return .success(result)
            } else {
                let errorMsg = result["error"] as? String ?? "Screenshot failed"
                return .error(errorMsg)
            }
        }

        // POST /state — lightweight state snapshot
        server.route("/state") { [weak self] _ in
            guard let self = self else { return .error("Runner deallocated") }
            let state = StateHandler.captureState(
                app: self.targetApp,
                bundleId: self.targetBundleId
            )
            guard let data = try? JSONEncoder().encode(state),
                  let dict = try? JSONSerialization.jsonObject(with: data) else {
                return .error("Failed to encode state")
            }
            return .success(dict)
        }
    }
}
