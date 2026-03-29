import Foundation
import FlyingFox
import XCTest

// MARK: - HTTP Server

/// Async HTTP server built on FlyingFox for the XCUITest runner.
///
/// Runs inside the XCUITest process, listening on a configurable port.
/// Uses `onMain {}` to dispatch XCUITest API calls to the main thread
/// via DispatchQueue.main + withCheckedContinuation, since @MainActor
/// doesn't execute reliably inside XCUITest async contexts.
final class RunnerServer {

    private let port: UInt16
    private var handlers: [String: any HTTPHandler] = [:]

    init(port: UInt16 = 9820) {
        self.port = port
    }

    func route(_ path: String, handler: some HTTPHandler) {
        handlers[path] = handler
    }

    func start() async throws {
        let server = HTTPServer(
            address: try .inet(ip4: "127.0.0.1", port: port),
            timeout: 100
        )

        for (path, handler) in handlers {
            await server.appendRoute(HTTPRoute(path), to: handler)
        }

        NSLog("[BrowseRunner] HTTP server listening on port %d", port)
        try await server.run()
    }
}

// MARK: - Main Thread Dispatch

/// Dispatch a block to the main thread and await its result.
/// XCUITest APIs must run on the main thread. We can't use @MainActor
/// because the Swift concurrency main actor executor doesn't drain
/// reliably inside XCUITest async test methods. Instead we use
/// DispatchQueue.main + withCheckedContinuation, which always works.
func onMain<T: Sendable>(_ block: @escaping @Sendable () -> T) async -> T {
    await withCheckedContinuation { continuation in
        DispatchQueue.main.async {
            continuation.resume(returning: block())
        }
    }
}

// MARK: - JSON Response Helpers

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

struct HealthHandler: HTTPHandler {
    func handleRequest(_ request: FlyingFox.HTTPRequest) async throws -> FlyingFox.HTTPResponse {
        return JSONResponse.success(["status": "healthy"])
    }
}

struct ConfigureHandler: HTTPHandler {
    let context: RunnerContext

    func handleRequest(_ request: FlyingFox.HTTPRequest) async throws -> FlyingFox.HTTPResponse {
        let body = try await request.bodyData
        guard let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let bundleId = json["targetBundleId"] as? String else {
            return JSONResponse.error("Expected: {\"targetBundleId\": \"com.apple.Preferences\"}")
        }

        await onMain {
            context.targetBundleId = bundleId
            context.targetApp = XCUIApplication(bundleIdentifier: bundleId)
        }
        NSLog("[BrowseRunner] Target app switched to: %@", bundleId)
        return JSONResponse.success(["configured": bundleId])
    }
}

struct TreeHandler: HTTPHandler {
    let context: RunnerContext

    func handleRequest(_ request: FlyingFox.HTTPRequest) async throws -> FlyingFox.HTTPResponse {
        let tree = await onMain {
            TreeBuilder.buildTree(from: context.targetApp)
        }
        guard let data = try? JSONEncoder().encode(tree),
              let dict = try? JSONSerialization.jsonObject(with: data) else {
            return JSONResponse.error("Failed to encode tree")
        }
        return JSONResponse.success(dict)
    }
}

struct ActionRouteHandler: HTTPHandler {
    let context: RunnerContext

    func handleRequest(_ request: FlyingFox.HTTPRequest) async throws -> FlyingFox.HTTPResponse {
        let body = try await request.bodyData
        guard let req = try? JSONDecoder().decode(ActionRequest.self, from: body) else {
            return JSONResponse.error("Invalid request body. Expected: {\"path\":[0,1],\"actionName\":\"tap\"}")
        }
        let result = await onMain {
            ActionHandler.performAction(app: context.targetApp, path: req.path, actionName: req.actionName)
        }
        if let ok = result["success"] as? Bool, ok {
            return JSONResponse.success(result)
        } else {
            return JSONResponse.error(result["error"] as? String ?? "Action failed")
        }
    }
}

struct SetValueRouteHandler: HTTPHandler {
    let context: RunnerContext

    func handleRequest(_ request: FlyingFox.HTTPRequest) async throws -> FlyingFox.HTTPResponse {
        let body = try await request.bodyData
        guard let req = try? JSONDecoder().decode(SetValueRequest.self, from: body) else {
            return JSONResponse.error("Invalid request body. Expected: {\"path\":[0,1],\"value\":\"text\"}")
        }
        let result = await onMain {
            ActionHandler.setValue(app: context.targetApp, path: req.path, value: req.value)
        }
        if let ok = result["success"] as? Bool, ok {
            return JSONResponse.success(result)
        } else {
            return JSONResponse.error(result["error"] as? String ?? "Set value failed")
        }
    }
}

struct TypeRouteHandler: HTTPHandler {
    let context: RunnerContext

    func handleRequest(_ request: FlyingFox.HTTPRequest) async throws -> FlyingFox.HTTPResponse {
        let body = try await request.bodyData
        guard let req = try? JSONDecoder().decode(TypeRequest.self, from: body) else {
            return JSONResponse.error("Invalid request body. Expected: {\"text\":\"hello\"}")
        }
        let result = await onMain {
            ActionHandler.typeText(app: context.targetApp, text: req.text)
        }
        if let ok = result["success"] as? Bool, ok {
            return JSONResponse.success(result)
        } else {
            return JSONResponse.error(result["error"] as? String ?? "Type failed")
        }
    }
}

struct PressRouteHandler: HTTPHandler {
    let context: RunnerContext

    func handleRequest(_ request: FlyingFox.HTTPRequest) async throws -> FlyingFox.HTTPResponse {
        let body = try await request.bodyData
        guard let req = try? JSONDecoder().decode(PressRequest.self, from: body) else {
            return JSONResponse.error("Invalid request body. Expected: {\"key\":\"return\"}")
        }
        let result = await onMain {
            ActionHandler.pressKey(app: context.targetApp, key: req.key)
        }
        if let ok = result["success"] as? Bool, ok {
            return JSONResponse.success(result)
        } else {
            return JSONResponse.error(result["error"] as? String ?? "Press key failed")
        }
    }
}

struct ScreenshotRouteHandler: HTTPHandler {
    let context: RunnerContext

    func handleRequest(_ request: FlyingFox.HTTPRequest) async throws -> FlyingFox.HTTPResponse {
        let body = try await request.bodyData
        guard let req = try? JSONDecoder().decode(ScreenshotRequest.self, from: body) else {
            return JSONResponse.error("Invalid request body. Expected: {\"outputPath\":\"/tmp/shot.png\"}")
        }
        let result = await onMain {
            ScreenshotHandler.captureScreenshot(app: context.targetApp, outputPath: req.outputPath)
        }
        if let ok = result["success"] as? Bool, ok {
            return JSONResponse.success(result)
        } else {
            return JSONResponse.error(result["error"] as? String ?? "Screenshot failed")
        }
    }
}

struct StateRouteHandler: HTTPHandler {
    let context: RunnerContext

    func handleRequest(_ request: FlyingFox.HTTPRequest) async throws -> FlyingFox.HTTPResponse {
        let state = await onMain {
            StateHandler.captureState(app: context.targetApp, bundleId: context.targetBundleId)
        }
        guard let data = try? JSONEncoder().encode(state),
              let dict = try? JSONSerialization.jsonObject(with: data) else {
            return JSONResponse.error("Failed to encode state")
        }
        return JSONResponse.success(dict)
    }
}

// MARK: - Runner Context

final class RunnerContext: @unchecked Sendable {
    var targetApp: XCUIApplication
    var targetBundleId: String

    init(targetApp: XCUIApplication, targetBundleId: String) {
        self.targetApp = targetApp
        self.targetBundleId = targetBundleId
    }
}
