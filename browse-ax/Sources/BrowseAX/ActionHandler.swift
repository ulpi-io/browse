import Cocoa

// MARK: - Action Handler (TASK-026)

/// Handles `action` and `set-value` commands against AX elements.
enum ActionHandler {

    /// Perform an accessibility action on the element at the given path.
    /// - Parameters:
    ///   - reader: TreeReader with the target app
    ///   - path: JSON array of child indices to walk
    ///   - actionName: AX action name (e.g. "AXPress", "AXShowMenu")
    /// - Returns: JSON string with success/error result
    static func performAction(reader: TreeReader, path: [Int], actionName: String) -> String {
        let element: AXUIElement
        do {
            let result = try reader.walkToElement(path: path)
            element = result.element
        } catch let error as PathWalkError {
            return JSONOutput.failureJSON(pathWalkErrorMessage(error))
        } catch {
            return JSONOutput.failureJSON("Unexpected error: \(error)")
        }

        // Verify the action is supported
        var actionNames: CFArray?
        let listResult = AXUIElementCopyActionNames(element, &actionNames)
        let supportedNames = (listResult == .success) ? (actionNames as? [String] ?? []) : []

        // If AXPress is requested but not supported, fall back to coordinate-based click
        if actionName == "AXPress" && !supportedNames.contains("AXPress") {
            return coordinateClick(element: element, path: path)
        }

        if !supportedNames.contains(actionName) {
            let pathStr = formatPath(path)
            return JSONOutput.failureJSON(
                "Action '\(actionName)' not supported by element at path \(pathStr)"
            )
        }

        let axResult = AXUIElementPerformAction(element, actionName as CFString)
        if axResult == .success {
            return JSONOutput.successJSON()
        } else {
            let pathStr = formatPath(path)
            return JSONOutput.failureJSON(
                "Failed to perform action '\(actionName)' on element at path \(pathStr) (error: \(axResult.rawValue))"
            )
        }
    }

    /// Set the value of an editable element at the given path.
    /// - Parameters:
    ///   - reader: TreeReader with the target app
    ///   - path: JSON array of child indices to walk
    ///   - value: The string value to set
    /// - Returns: JSON string with success/error result
    static func setValue(reader: TreeReader, path: [Int], value: String) -> String {
        let element: AXUIElement
        do {
            let result = try reader.walkToElement(path: path)
            element = result.element
        } catch let error as PathWalkError {
            return JSONOutput.failureJSON(pathWalkErrorMessage(error))
        } catch {
            return JSONOutput.failureJSON("Unexpected error: \(error)")
        }

        // Check if the element's role suggests editability
        let role = reader.copyAttribute(of: element, name: kAXRoleAttribute) as? String ?? ""
        let editableRoles: Set<String> = [
            "AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"
        ]
        if !editableRoles.contains(role) {
            return JSONOutput.failureJSON("Element is not editable")
        }

        let axResult = AXUIElementSetAttributeValue(
            element,
            kAXValueAttribute as CFString,
            value as CFTypeRef
        )
        if axResult == .success {
            return JSONOutput.successJSON()
        } else {
            return JSONOutput.failureJSON(
                "Failed to set value on element (error: \(axResult.rawValue))"
            )
        }
    }

    // MARK: - Helpers

    /// Parse a JSON string like "[0,2,1]" into an array of integers.
    static func parsePath(_ jsonString: String) -> [Int]? {
        guard let data = jsonString.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data) as? [Int] else {
            return nil
        }
        return parsed
    }

    static func pathWalkErrorMessage(_ error: PathWalkError) -> String {
        switch error {
        case .noWindow:
            return "No accessible window found for the target application"
        case let .outOfBounds(path, _, childCount):
            let pathStr = formatPath(path)
            return "Element not found at path \(pathStr). Node has \(childCount) children."
        }
    }

    static func formatPath(_ path: [Int]) -> String {
        return "[" + path.map { String($0) }.joined(separator: ",") + "]"
    }

    /// Fall back to a coordinate-based click when AXPress isn't supported.
    /// Gets the element's frame and posts a CGEvent mouse click at its center.
    private static func coordinateClick(element: AXUIElement, path: [Int]) -> String {
        var posValue: CFTypeRef?
        var sizeValue: CFTypeRef?
        let posResult = AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posValue)
        let sizeResult = AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue)

        guard posResult == .success, sizeResult == .success,
              let posVal = posValue, let sizeVal = sizeValue else {
            let pathStr = formatPath(path)
            return JSONOutput.failureJSON(
                "Cannot click element at path \(pathStr): no position/size available"
            )
        }

        var position = CGPoint.zero
        var size = CGSize.zero
        AXValueGetValue(posVal as! AXValue, .cgPoint, &position)
        AXValueGetValue(sizeVal as! AXValue, .cgSize, &size)

        let center = CGPoint(x: position.x + size.width / 2, y: position.y + size.height / 2)

        guard let mouseDown = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown,
                                       mouseCursorPosition: center, mouseButton: .left),
              let mouseUp = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp,
                                     mouseCursorPosition: center, mouseButton: .left) else {
            return JSONOutput.failureJSON("Failed to create mouse click events")
        }

        mouseDown.post(tap: .cghidEventTap)
        usleep(50_000) // 50ms between down and up
        mouseUp.post(tap: .cghidEventTap)

        return JSONOutput.successJSON()
    }
}
