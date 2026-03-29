import XCTest

final class BrowseRunnerUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = true
    }

    func testRunServer() async throws {
        let portString = ProcessInfo.processInfo.environment["BROWSE_RUNNER_PORT"] ?? "9820"
        let port = UInt16(portString) ?? 9820

        let envBundleId = ProcessInfo.processInfo.environment["BROWSE_TARGET_BUNDLE_ID"]
        let targetBundleId = envBundleId ?? "io.ulpi.browse-ios-runner"

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

        NSLog("[BrowseRunner] Server starting on port %u, target: %@", port, targetBundleId)
        try await server.start()
    }
}
