import Foundation

// MARK: - JSON Serialization

/// Produces JSON output matching the AppNode interface from src/app/types.ts.
/// Uses manual serialization to avoid Codable boilerplate and ensure exact field ordering.
enum JSONOutput {

    /// Serialize an AppNode tree to a JSON string.
    static func serialize(node: AppNode) -> String {
        let obj = nodeToJSONObject(node)
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else {
            return "{}"
        }
        return String(data: data, encoding: .utf8) ?? "{}"
    }

    /// Produce a JSON-formatted error string.
    static func errorJSON(_ message: String) -> String {
        let escaped = escapeJSONString(message)
        return "{\"error\":\"\(escaped)\"}"
    }

    /// Produce a JSON success result.
    static func successJSON() -> String {
        return "{\"success\":true}"
    }

    /// Produce a JSON failure result with error message.
    static func failureJSON(_ message: String) -> String {
        let escaped = escapeJSONString(message)
        return "{\"success\":false,\"error\":\"\(escaped)\"}"
    }

    /// Serialize a dictionary to a JSON string.
    static func serializeDictionary(_ dict: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys]) else {
            return "{}"
        }
        return String(data: data, encoding: .utf8) ?? "{}"
    }

    // MARK: - Internal

    private static func nodeToJSONObject(_ node: AppNode) -> [String: Any] {
        var obj: [String: Any] = [
            "path": node.path,
            "role": node.role,
            "label": node.label,
            "frame": [
                "x": node.frame.x,
                "y": node.frame.y,
                "width": node.frame.width,
                "height": node.frame.height
            ],
            "enabled": node.enabled,
            "focused": node.focused,
            "selected": node.selected,
            "editable": node.editable,
            "actions": node.actions,
            "children": node.children.map { nodeToJSONObject($0) }
        ]

        // value is nullable — include as NSNull when nil to match the contract
        if let value = node.value {
            obj["value"] = value
        } else {
            obj["value"] = NSNull()
        }

        return obj
    }

    private static func escapeJSONString(_ str: String) -> String {
        var result = ""
        result.reserveCapacity(str.count)
        for char in str {
            switch char {
            case "\"": result += "\\\""
            case "\\": result += "\\\\"
            case "\n": result += "\\n"
            case "\r": result += "\\r"
            case "\t": result += "\\t"
            default:
                result.append(char)
            }
        }
        return result
    }
}
