import XCTest

final class BrowseRunnerUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = true
        executionTimeAllowance = 86400
    }

    /// Synchronous test that keeps the main thread alive via RunLoop.
    /// The FlyingFox server runs in a detached Task on a background thread.
    /// XCUITest API calls hop to the main thread via DispatchQueue.main +
    /// withCheckedContinuation (the `onMain` helper in RunnerServer.swift).
    /// RunLoop.current.run(until:) drains the main dispatch queue each iteration.
    func testRunServer() throws {
        let portString = ProcessInfo.processInfo.environment["BROWSE_RUNNER_PORT"] ?? "9820"
        let port = UInt16(portString) ?? 9820

        let envBundleId = ProcessInfo.processInfo.environment["BROWSE_TARGET_BUNDLE_ID"]
        let targetBundleId = envBundleId ?? "io.ulpi.browse-ios-runner"

        // Setup on main thread (synchronous — no actor issues)
        let hostApp = XCUIApplication()
        hostApp.launch()

        let targetApp: XCUIApplication
        if targetBundleId != "io.ulpi.browse-ios-runner" {
            targetApp = XCUIApplication(bundleIdentifier: targetBundleId)
            targetApp.activate()
        } else {
            targetApp = hostApp
        }

        let context = RunnerContext(targetApp: targetApp, targetBundleId: targetBundleId)
        let server = RunnerServer(port: port)

        server.route("/health", handler: HealthHandler())
        server.route("/configure", handler: ConfigureHandler(context: context))
        server.route("/tree", handler: TreeHandler(context: context))
        server.route("/action", handler: ActionRouteHandler(context: context))
        server.route("/set-value", handler: SetValueRouteHandler(context: context))
        server.route("/type", handler: TypeRouteHandler(context: context))
        server.route("/press", handler: PressRouteHandler(context: context))
        server.route("/screenshot", handler: ScreenshotRouteHandler(context: context))
        server.route("/state", handler: StateRouteHandler(context: context))

        NSLog("[BrowseRunner] Starting server on port %u, target: %@", port, targetBundleId)

        // Start FlyingFox on a background thread
        Task.detached {
            try await server.start()
        }

        // Pump the main RunLoop forever — this is what allows
        // DispatchQueue.main.async blocks (from onMain) to execute.
        while true {
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
        }
    }
}
