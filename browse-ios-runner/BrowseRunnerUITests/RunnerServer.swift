import Foundation
import FlyingFox
import XCTest

// MARK: - HTTP Server

/// Async HTTP server built on FlyingFox for the XCUITest runner.
///
/// Runs inside the XCUITest process, listening on a configurable port.
/// Routes incoming HTTP requests to handler closures registered per path.
/// Uses `@MainActor` handlers so XCUITest APIs run on the main thread
/// automatically via Swift concurrency — no semaphores or RunLoop needed.
final class RunnerServer {

    // MARK: Properties

    private let port: UInt16
    private var server: HTTPServer?

    /// The registered route handlers, keyed by path (e.g. "/health").
    /// Populated before `start()` is called.
    private var handlers: [String: any HTTPHandler] = [:]

    // MARK: Init

    init(port: UInt16 = 9820) {
        self.port = port
    }

    // MARK: Route Registration

    /// Register a handler for a given path.
    /// Must be called before `start()`.
    func route(_ path: String, handler: some HTTPHandler) {
        handlers[path] = handler
    }

    // MARK: Start

    /// Start the HTTP server. This method blocks (awaits) indefinitely,
    /// serving requests until the process is terminated.
    func start() async throws {
        let server = HTTPServer(
            address: try .inet(ip4: "127.0.0.1", port: port),
            timeout: 100
        )
        self.server = server

        for (path, handler) in handlers {
            await server.appendRoute(HTTPRoute(path), to: handler)
        }

        NSLog("[BrowseRunner] HTTP server listening on port %d", port)
        try await server.run()
    }
}

// MARK: - JSON Response Helpers

/// Convenience helpers for building JSON HTTP responses.
enum JSONResponse {

    static func success(_ data: Any? = nil) -> FlyingFox.HTTPResponse {
        var obj: [String: Any] = ["success": true]
        if let data = data {
            obj["data"] = data
        }
        return jsonResponse(obj, status: 200)
    }

    static func error(_ message: String, status: Int = 400) -> FlyingFox.HTTPResponse {
        return jsonResponse(["success": false, "error": message], status: status)
    }

    private static func jsonResponse(_ object: Any, status: Int) -> FlyingFox.HTTPResponse {
        let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
        return FlyingFox.HTTPResponse(
            statusCode: HTTPStatusCode(status, phrase: ""),
            headers: [HTTPHeader("Content-Type"): "application/json"],
            body: data
        )
    }
}

// MARK: - Route Handlers

/// Health check handler — lightweight, does not need `@MainActor`.
struct HealthHandler: HTTPHandler {
    func handleRequest(_ request: FlyingFox.HTTPRequest) async throws -> FlyingFox.HTTPResponse {
        return JSONResponse.success(["status": "healthy"])
    }
}

/// Configure handler — switches the target app at runtime.
/// Must run on `@MainActor` because it accesses XCUIApplication.
@MainActor
struct ConfigureHandler: HTTPHandler {
    let context: RunnerContext

    func handleRequest(_ request: FlyingFox.HTTPRequest) async throws -> FlyingFox.HTTPResponse {
        let body = try await request.bodyData
        guard let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let bundleId = json["targetBundleId"] as? String else {
            return JSONResponse.error("Expected: {\"targetBundleId\": \"com.apple.Preferences\"}")
        }

        context.targetBundleId = bundleId
        context.targetApp = XCUIApplication(bundleIdentifier: bundleId)
        NSLog("[BrowseRunner] Target app switched to: %@", bundleId)
        return JSONResponse.success(["configured": bundleId])
    }
}

/// Tree handler — builds the full accessibility tree.
@MainActor
struct TreeHandler: HTTPHandler {
    let context: RunnerContext

    func handleRequest(_ request: FlyingFox.HTTPRequest) async throws -> FlyingFox.HTTPResponse {
        let tree = TreeBuilder.buildTree(from: context.targetApp)
        guard let data = try? JSONEncoder().encode(tree),
              let dict = try? JSONSerialization.jsonObject(with: data) else {
            return JSONResponse.error("Failed to encode tree")
        }
        return JSONResponse.success(dict)
    }
}

/// Action handler — performs an action on an element by tree path.
@MainActor
struct ActionRouteHandler: HTTPHandler {
    let context: RunnerContext

    func handleRequest(_ request: FlyingFox.HTTPRequest) async throws -> FlyingFox.HTTPResponse {
        let body = try await request.bodyData
        guard let req = try? JSONDecoder().decode(ActionRequest.self, from: body) else {
            return JSONResponse.error("Invalid request body. Expected: {\"path\":[0,1],\"actionName\":\"tap\"}")
        }
        let result = ActionHandler.performAction(
            app: context.targetApp,
            path: req.path,
            actionName: req.actionName
        )
        if let ok = result["success"] as? Bool, ok {
            return JSONResponse.success(result)
        } else {
            let msg = result["error"] as? String ?? "Action failed"
            return JSONResponse.error(msg)
        }
    }
}

/// Set-value handler — sets text on an element by tree path.
@MainActor
struct SetValueRouteHandler: HTTPHandler {
    let context: RunnerContext

    func handleRequest(_ request: FlyingFox.HTTPRequest) async throws -> FlyingFox.HTTPResponse {
        let body = try await request.bodyData
        guard let req = try? JSONDecoder().decode(SetValueRequest.self, from: body) else {
            return JSONResponse.error("Invalid request body. Expected: {\"path\":[0,1],\"value\":\"text\"}")
        }
        let result = ActionHandler.setValue(
            app: context.targetApp,
            path: req.path,
            value: req.value
        )
        if let ok = result["success"] as? Bool, ok {
            return JSONResponse.success(result)
        } else {
            let msg = result["error"] as? String ?? "Set value failed"
            return JSONResponse.error(msg)
        }
    }
}

/// Type handler — types text via the keyboard.
@MainActor
struct TypeRouteHandler: HTTPHandler {
    let context: RunnerContext

    func handleRequest(_ request: FlyingFox.HTTPRequest) async throws -> FlyingFox.HTTPResponse {
        let body = try await request.bodyData
        guard let req = try? JSONDecoder().decode(TypeRequest.self, from: body) else {
            return JSONResponse.error("Invalid request body. Expected: {\"text\":\"hello\"}")
        }
        let result = ActionHandler.typeText(app: context.targetApp, text: req.text)
        if let ok = result["success"] as? Bool, ok {
            return JSONResponse.success(result)
        } else {
            let msg = result["error"] as? String ?? "Type failed"
            return JSONResponse.error(msg)
        }
    }
}

/// Press handler — presses a named key.
@MainActor
struct PressRouteHandler: HTTPHandler {
    let context: RunnerContext

    func handleRequest(_ request: FlyingFox.HTTPRequest) async throws -> FlyingFox.HTTPResponse {
        let body = try await request.bodyData
        guard let req = try? JSONDecoder().decode(PressRequest.self, from: body) else {
            return JSONResponse.error("Invalid request body. Expected: {\"key\":\"return\"}")
        }
        let result = ActionHandler.pressKey(app: context.targetApp, key: req.key)
        if let ok = result["success"] as? Bool, ok {
            return JSONResponse.success(result)
        } else {
            let msg = result["error"] as? String ?? "Press key failed"
            return JSONResponse.error(msg)
        }
    }
}

/// Screenshot handler — captures and saves a screenshot.
@MainActor
struct ScreenshotRouteHandler: HTTPHandler {
    let context: RunnerContext

    func handleRequest(_ request: FlyingFox.HTTPRequest) async throws -> FlyingFox.HTTPResponse {
        let body = try await request.bodyData
        guard let req = try? JSONDecoder().decode(ScreenshotRequest.self, from: body) else {
            return JSONResponse.error("Invalid request body. Expected: {\"outputPath\":\"/tmp/shot.png\"}")
        }
        let result = ScreenshotHandler.captureScreenshot(
            app: context.targetApp,
            outputPath: req.outputPath
        )
        if let ok = result["success"] as? Bool, ok {
            return JSONResponse.success(result)
        } else {
            let msg = result["error"] as? String ?? "Screenshot failed"
            return JSONResponse.error(msg)
        }
    }
}

/// State handler — captures lightweight state snapshot.
@MainActor
struct StateRouteHandler: HTTPHandler {
    let context: RunnerContext

    func handleRequest(_ request: FlyingFox.HTTPRequest) async throws -> FlyingFox.HTTPResponse {
        let state = StateHandler.captureState(
            app: context.targetApp,
            bundleId: context.targetBundleId
        )
        guard let data = try? JSONEncoder().encode(state),
              let dict = try? JSONSerialization.jsonObject(with: data) else {
            return JSONResponse.error("Failed to encode state")
        }
        return JSONResponse.success(dict)
    }
}

// MARK: - Runner Context

/// Shared mutable context holding the target app and bundle ID.
/// Accessed from @MainActor handlers via MainActor.run inside each handler.
/// Marked @unchecked Sendable because all real access is serialized on the main thread.
final class RunnerContext: @unchecked Sendable {
    var targetApp: XCUIApplication
    var targetBundleId: String

    init(targetApp: XCUIApplication, targetBundleId: String) {
        self.targetApp = targetApp
        self.targetBundleId = targetBundleId
    }
}
