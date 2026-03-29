import Cocoa

// MARK: - State Handler (TASK-027)

/// Handles the `state` command — lightweight state probe returning window info,
/// focused element path, element count, and app name.
enum StateHandler {

    /// Probe the target application's accessibility state.
    /// - Parameter reader: TreeReader with the target app
    /// - Returns: JSON string with state information
    static func probeState(reader: TreeReader) -> String {
        let pid = reader.pid

        // App name
        let appName = resolveAppName(pid: pid)

        // Window title from focused or first window
        let windowTitle = resolveWindowTitle(reader: reader)

        // Window count
        let windowCount = resolveWindowCount(reader: reader)

        // Check if window is minimized
        if windowCount > 0 && windowTitle == nil {
            // Might be minimized — check via CGWindowList
            if isAnyWindowMinimized(pid: pid) {
                return JSONOutput.failureJSON("Window is minimized. Restore it first.")
            }
        }

        // Focused element path
        let focusedPath = resolveFocusedPath(reader: reader)

        // Element count (lightweight: walk the tree counting nodes)
        let elementCount = countElements(reader: reader)

        // Build result
        var result: [String: Any] = [
            "appName": appName ?? NSNull(),
            "windowTitle": windowTitle ?? NSNull(),
            "windowCount": windowCount,
            "elementCount": elementCount,
        ]

        if let path = focusedPath {
            result["focusedPath"] = path
        } else {
            result["focusedPath"] = NSNull()
        }

        return JSONOutput.serializeDictionary(result)
    }

    // MARK: - Private Helpers

    private static func resolveAppName(pid: pid_t) -> String? {
        let workspace = NSWorkspace.shared
        let app = workspace.runningApplications.first { $0.processIdentifier == pid }
        return app?.localizedName
    }

    private static func resolveWindowTitle(reader: TreeReader) -> String? {
        guard let window = reader.getFrontmostWindow() else { return nil }
        return reader.copyAttribute(of: window, name: kAXTitleAttribute) as? String
    }

    private static func resolveWindowCount(reader: TreeReader) -> Int {
        guard let children = reader.copyAttribute(
            of: reader.appElement, name: kAXChildrenAttribute
        ) as? [AXUIElement] else {
            return 0
        }

        var count = 0
        for child in children {
            if let role = reader.copyAttribute(of: child, name: kAXRoleAttribute) as? String,
               role == "AXWindow" {
                count += 1
            }
        }
        return count
    }

    /// Find the path of the currently focused element by walking the tree.
    private static func resolveFocusedPath(reader: TreeReader) -> [Int]? {
        guard let focusedRaw = reader.copyAttribute(
            of: reader.appElement, name: kAXFocusedUIElementAttribute
        ) else {
            return nil
        }
        let focusedElement = focusedRaw as! AXUIElement

        // Walk the tree from the window to find the focused element's path
        guard let window = reader.getFrontmostWindow() else { return nil }

        return findPathToElement(
            current: window,
            target: focusedElement,
            currentPath: [],
            reader: reader,
            maxDepth: 30
        )
    }

    /// Recursively search for a target element and return its path.
    private static func findPathToElement(
        current: AXUIElement,
        target: AXUIElement,
        currentPath: [Int],
        reader: TreeReader,
        maxDepth: Int
    ) -> [Int]? {
        // Compare by checking if these are the same AX element
        if CFEqual(current, target) {
            return currentPath
        }

        guard maxDepth > 0 else { return nil }

        guard let children = reader.copyAttribute(
            of: current, name: kAXChildrenAttribute
        ) as? [AXUIElement] else {
            return nil
        }

        for (index, child) in children.enumerated() {
            let childPath = currentPath + [index]
            if let found = findPathToElement(
                current: child,
                target: target,
                currentPath: childPath,
                reader: reader,
                maxDepth: maxDepth - 1
            ) {
                return found
            }
        }

        return nil
    }

    /// Count all elements in the tree (lightweight traversal).
    private static func countElements(reader: TreeReader) -> Int {
        guard let window = reader.getFrontmostWindow() else { return 0 }
        return countNode(element: window, reader: reader, maxDepth: 30)
    }

    private static func countNode(element: AXUIElement, reader: TreeReader, maxDepth: Int) -> Int {
        var count = 1 // Count self
        guard maxDepth > 0 else { return count }

        guard let children = reader.copyAttribute(
            of: element, name: kAXChildrenAttribute
        ) as? [AXUIElement] else {
            return count
        }

        for child in children {
            count += countNode(element: child, reader: reader, maxDepth: maxDepth - 1)
        }
        return count
    }

    private static func isAnyWindowMinimized(pid: pid_t) -> Bool {
        guard let windowList = CGWindowListCopyWindowInfo(
            [.optionAll, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]] else {
            return false
        }

        let appWindows = windowList.filter { info in
            guard let ownerPID = info[kCGWindowOwnerPID as String] as? Int32 else {
                return false
            }
            return ownerPID == pid
        }

        for window in appWindows {
            let isOnScreen = window[kCGWindowIsOnscreen as String] as? Bool ?? false
            if !isOnScreen {
                return true
            }
        }
        return false
    }
}
