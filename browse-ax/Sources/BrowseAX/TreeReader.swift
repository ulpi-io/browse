import Cocoa

// MARK: - AppNode (mirrors src/app/types.ts AppNode)

struct Frame {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct AppNode {
    let path: [Int]
    let role: String
    let label: String
    let value: String?
    let frame: Frame
    let enabled: Bool
    let focused: Bool
    let selected: Bool
    let editable: Bool
    let actions: [String]
    let children: [AppNode]
}

// MARK: - PathWalkResult

enum PathWalkError: Error {
    case noWindow
    case outOfBounds(path: [Int], failedIndex: Int, childCount: Int)
}

struct PathWalkResult {
    let element: AXUIElement
    let path: [Int]
}

// MARK: - TreeReader

final class TreeReader {
    let pid: pid_t
    let maxDepth: Int
    let appElement: AXUIElement

    init(pid: pid_t, maxDepth: Int) {
        self.pid = pid
        self.maxDepth = maxDepth
        self.appElement = AXUIElementCreateApplication(pid)
    }

    /// Read the full accessibility tree starting from the frontmost window.
    /// Falls back to the application element if no window is found.
    func readTree() -> AppNode {
        let windowElement = getFrontmostWindow() ?? appElement
        return buildNode(element: windowElement, path: [], depth: 0)
    }

    /// Walk the AX tree from the frontmost window following child indices.
    /// Returns the AXUIElement at the given path or throws a descriptive error.
    func walkToElement(path: [Int]) throws -> PathWalkResult {
        guard let windowElement = getFrontmostWindow() else {
            throw PathWalkError.noWindow
        }

        if path.isEmpty {
            return PathWalkResult(element: windowElement, path: path)
        }

        var current = windowElement
        for (stepIndex, childIndex) in path.enumerated() {
            guard let children = copyAttribute(of: current, name: kAXChildrenAttribute) as? [AXUIElement] else {
                throw PathWalkError.outOfBounds(path: path, failedIndex: stepIndex, childCount: 0)
            }

            guard childIndex >= 0 && childIndex < children.count else {
                throw PathWalkError.outOfBounds(path: path, failedIndex: stepIndex, childCount: children.count)
            }

            current = children[childIndex]
        }

        return PathWalkResult(element: current, path: path)
    }

    /// Get the frontmost window element, or nil if none found.
    func getFrontmostWindow() -> AXUIElement? {
        // Try focused window first
        if let focused = copyAttribute(of: appElement, name: kAXFocusedWindowAttribute) as? AXUIElement {
            return focused
        }

        // Fall back to first AXWindow in children
        guard let children = copyAttribute(of: appElement, name: kAXChildrenAttribute) as? [AXUIElement] else {
            return nil
        }

        for child in children {
            if let role = copyAttribute(of: child, name: kAXRoleAttribute) as? String,
               role == "AXWindow" {
                return child
            }
        }

        return nil
    }

    // MARK: - Tree Traversal

    private func buildNode(element: AXUIElement, path: [Int], depth: Int) -> AppNode {
        let role = (copyAttribute(of: element, name: kAXRoleAttribute) as? String) ?? "AXUnknown"
        let label = resolveLabel(element: element)
        let value = resolveValue(element: element)
        let frame = resolveFrame(element: element)
        let enabled = resolveEnabled(element: element)
        let focused = resolveBool(element: element, attribute: kAXFocusedAttribute)
        let selected = resolveBool(element: element, attribute: kAXSelectedAttribute)
        let editable = resolveEditable(element: element, role: role)
        let actions = resolveActions(element: element)

        var children: [AppNode] = []
        if depth < maxDepth {
            children = resolveChildren(element: element, parentPath: path, depth: depth)
        }

        return AppNode(
            path: path,
            role: role,
            label: label,
            value: value,
            frame: frame,
            enabled: enabled,
            focused: focused,
            selected: selected,
            editable: editable,
            actions: actions,
            children: children
        )
    }

    private func resolveChildren(element: AXUIElement, parentPath: [Int], depth: Int) -> [AppNode] {
        guard let axChildren = copyAttribute(of: element, name: kAXChildrenAttribute) as? [AXUIElement] else {
            return []
        }

        var nodes: [AppNode] = []
        for (index, child) in axChildren.enumerated() {
            let childPath = parentPath + [index]
            let node = buildNode(element: child, path: childPath, depth: depth + 1)
            nodes.append(node)
        }
        return nodes
    }

    // MARK: - Attribute Helpers

    /// Generic AX attribute reader. Returns nil on failure.
    func copyAttribute(of element: AXUIElement, name: String) -> AnyObject? {
        var value: AnyObject?
        let result = AXUIElementCopyAttributeValue(element, name as CFString, &value)
        guard result == .success else { return nil }
        return value
    }

    /// Resolve a human-readable label: prefer AXTitle, then AXDescription, then AXRoleDescription.
    private func resolveLabel(element: AXUIElement) -> String {
        if let title = copyAttribute(of: element, name: kAXTitleAttribute) as? String, !title.isEmpty {
            return title
        }
        if let desc = copyAttribute(of: element, name: kAXDescriptionAttribute) as? String, !desc.isEmpty {
            return desc
        }
        if let roleDesc = copyAttribute(of: element, name: kAXRoleDescriptionAttribute) as? String, !roleDesc.isEmpty {
            return roleDesc
        }
        return ""
    }

    /// Resolve the element value as a string.
    private func resolveValue(element: AXUIElement) -> String? {
        guard let raw = copyAttribute(of: element, name: kAXValueAttribute) else { return nil }

        if let str = raw as? String {
            return str
        }
        if let num = raw as? NSNumber {
            return num.stringValue
        }
        // For attributed strings
        if CFGetTypeID(raw) == CFAttributedStringGetTypeID() {
            let attrStr = raw as! NSAttributedString
            return attrStr.string
        }
        return nil
    }

    /// Resolve the bounding frame in screen coordinates.
    private func resolveFrame(element: AXUIElement) -> Frame {
        var positionValue: AnyObject?
        var sizeValue: AnyObject?

        let posResult = AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionValue)
        let sizeResult = AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue)

        var position = CGPoint.zero
        var size = CGSize.zero

        if posResult == .success, let posVal = positionValue {
            AXValueGetValue(posVal as! AXValue, .cgPoint, &position)
        }
        if sizeResult == .success, let sizeVal = sizeValue {
            AXValueGetValue(sizeVal as! AXValue, .cgSize, &size)
        }

        return Frame(
            x: Double(position.x),
            y: Double(position.y),
            width: Double(size.width),
            height: Double(size.height)
        )
    }

    /// Resolve enabled state. Defaults to true if the attribute is absent.
    private func resolveEnabled(element: AXUIElement) -> Bool {
        guard let val = copyAttribute(of: element, name: kAXEnabledAttribute) as? Bool else {
            return true
        }
        return val
    }

    /// Resolve a boolean attribute. Defaults to false if absent.
    private func resolveBool(element: AXUIElement, attribute attrName: String) -> Bool {
        guard let val = copyAttribute(of: element, name: attrName) as? Bool else {
            return false
        }
        return val
    }

    /// Determine if the element is editable (text fields, text areas).
    private func resolveEditable(element: AXUIElement, role: String) -> Bool {
        let editableRoles: Set<String> = [
            "AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"
        ]
        return editableRoles.contains(role)
    }

    /// Get the list of available AX actions.
    private func resolveActions(element: AXUIElement) -> [String] {
        var actionNames: CFArray?
        let result = AXUIElementCopyActionNames(element, &actionNames)
        guard result == .success, let names = actionNames as? [String] else {
            return []
        }
        return names
    }
}
