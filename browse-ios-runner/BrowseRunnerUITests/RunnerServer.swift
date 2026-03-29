import Foundation
import Network

// MARK: - HTTP Server

/// Lightweight HTTP server built on Network.framework (NWListener).
///
/// Runs inside the XCUITest process, listening on a configurable port.
/// Routes incoming HTTP requests to handler closures registered per path.
/// Designed for JSON-RPC communication with the browse host bridge.
final class RunnerServer: @unchecked Sendable {

    // MARK: Types

    struct HTTPRequest {
        let method: String
        let path: String
        let body: Data?
    }

    typealias Handler = (HTTPRequest) -> HTTPResponse

    struct HTTPResponse {
        let statusCode: Int
        let body: Data

        static func json(_ object: Any, status: Int = 200) -> HTTPResponse {
            let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
            return HTTPResponse(statusCode: status, body: data)
        }

        static func error(_ message: String, status: Int = 400) -> HTTPResponse {
            return json(["success": false, "error": message], status: status)
        }

        static func success(_ data: Any? = nil) -> HTTPResponse {
            var obj: [String: Any] = ["success": true]
            if let data = data {
                obj["data"] = data
            }
            return json(obj)
        }
    }

    // MARK: Properties

    private let listener: NWListener
    private let queue = DispatchQueue(label: "io.ulpi.browse-runner.server", qos: .userInitiated)
    private var handlers: [String: Handler] = [:]
    private let port: UInt16

    // MARK: Init

    init(port: UInt16 = 9820) throws {
        self.port = port
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        self.listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)
    }

    // MARK: Route Registration

    func route(_ path: String, handler: @escaping Handler) {
        handlers[path] = handler
    }

    // MARK: Start / Stop

    func start() {
        listener.stateUpdateHandler = { [port] state in
            switch state {
            case .ready:
                NSLog("[BrowseRunner] HTTP server listening on port %d", port)
            case .failed(let error):
                NSLog("[BrowseRunner] Server failed: %@", error.localizedDescription)
            default:
                break
            }
        }

        listener.newConnectionHandler = { [weak self] connection in
            self?.handleConnection(connection)
        }

        listener.start(queue: queue)
    }

    func stop() {
        listener.cancel()
    }

    // MARK: Connection Handling

    private func handleConnection(_ connection: NWConnection) {
        connection.start(queue: queue)
        receiveHTTPRequest(connection)
    }

    private func receiveHTTPRequest(_ connection: NWConnection) {
        // Read up to 1 MB
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1_048_576) {
            [weak self] content, _, isComplete, error in

            guard let self = self else {
                connection.cancel()
                return
            }

            if let error = error {
                NSLog("[BrowseRunner] Receive error: %@", error.localizedDescription)
                connection.cancel()
                return
            }

            guard let data = content, !data.isEmpty else {
                if isComplete {
                    connection.cancel()
                }
                return
            }

            let request = self.parseHTTPRequest(data)
            let response: HTTPResponse

            if let request = request, let handler = self.handlers[request.path] {
                response = handler(request)
            } else if let request = request {
                response = .error("Not found: \(request.path)", status: 404)
            } else {
                response = .error("Bad request", status: 400)
            }

            self.sendHTTPResponse(connection, response: response)
        }
    }

    // MARK: HTTP Parsing

    private func parseHTTPRequest(_ data: Data) -> HTTPRequest? {
        guard let raw = String(data: data, encoding: .utf8) else { return nil }

        // Split header and body
        let parts = raw.components(separatedBy: "\r\n\r\n")
        guard !parts.isEmpty else { return nil }

        let headerSection = parts[0]
        let lines = headerSection.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else { return nil }

        let tokens = requestLine.split(separator: " ")
        guard tokens.count >= 2 else { return nil }

        let method = String(tokens[0])
        let path = String(tokens[1])

        // Body is everything after the double CRLF
        var body: Data? = nil
        if parts.count > 1 {
            let bodyString = parts.dropFirst().joined(separator: "\r\n\r\n")
            if !bodyString.isEmpty {
                body = bodyString.data(using: .utf8)
            }
        }

        return HTTPRequest(method: method, path: path, body: body)
    }

    // MARK: HTTP Response

    private func sendHTTPResponse(_ connection: NWConnection, response: HTTPResponse) {
        var header = "HTTP/1.1 \(response.statusCode) \(statusText(response.statusCode))\r\n"
        header += "Content-Type: application/json\r\n"
        header += "Content-Length: \(response.body.count)\r\n"
        header += "Connection: close\r\n"
        header += "\r\n"

        var data = header.data(using: .utf8) ?? Data()
        data.append(response.body)

        connection.send(content: data, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    private func statusText(_ code: Int) -> String {
        switch code {
        case 200: return "OK"
        case 400: return "Bad Request"
        case 404: return "Not Found"
        case 500: return "Internal Server Error"
        default: return "Unknown"
        }
    }
}
