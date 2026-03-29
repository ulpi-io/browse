import XCTest

// MARK: - Action Handler

/// Executes actions on XCUIElements resolved by tree path.
///
/// Supports tap, double-tap, long-press, swipe, and value setting.
/// All actions resolve the target element using `TreeBuilder.resolveElement`.
enum ActionHandler {

    // MARK: - Perform Action

    /// Perform a named action on the element at the given tree path.
    ///
    /// Supported actions:
    ///   - `tap` / `press` — single tap
    ///   - `doubleTap` — double tap
    ///   - `longPress` — long press (1 second)
    ///   - `swipeUp`, `swipeDown`, `swipeLeft`, `swipeRight` — swipe gestures
    ///   - `twoFingerTap` — two-finger tap
    ///
    /// - Parameters:
    ///   - app: The XCUIApplication to search in.
    ///   - path: Tree path (array of child indices) to the target element.
    ///   - actionName: Name of the action to perform.
    /// - Returns: A dictionary with `success` and optional `error` keys.
    static func performAction(
        app: XCUIApplication,
        path: [Int],
        actionName: String
    ) -> [String: Any] {
        guard let element = TreeBuilder.resolveElement(in: app, path: path) else {
            return [
                "success": false,
                "error": "Element not found at path \(path). Run /tree to refresh the element hierarchy.",
            ]
        }

        guard element.exists else {
            return [
                "success": false,
                "error": "Element at path \(path) no longer exists. The UI may have changed.",
            ]
        }

        switch actionName.lowercased() {
        case "tap", "press", "axpress":
            element.tap()

        case "doubletap":
            element.doubleTap()

        case "longpress":
            element.press(forDuration: 1.0)

        case "swipeup":
            let upTarget = swipeTarget(for: element, in: app)
            coordinateSwipe(upTarget, direction: "up")

        case "swipedown":
            let downTarget = swipeTarget(for: element, in: app)
            coordinateSwipe(downTarget, direction: "down")

        case "swipeleft":
            let leftTarget = swipeTarget(for: element, in: app)
            coordinateSwipe(leftTarget, direction: "left")

        case "swiperight":
            let rightTarget = swipeTarget(for: element, in: app)
            coordinateSwipe(rightTarget, direction: "right")

        case "twofingertap":
            element.twoFingerTap()

        case "forcetap":
            // Use coordinate-based tap for elements that may not be directly tappable
            let coordinate = element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            coordinate.tap()

        default:
            return [
                "success": false,
                "error": "Unknown action '\(actionName)'. Supported: tap, doubleTap, longPress, swipeUp, swipeDown, swipeLeft, swipeRight, twoFingerTap, forceTap",
            ]
        }
        return ["success": true]
    }

    // MARK: - Swipe Target Resolution

    /// When swiping on the app root (XCUIApplication), find the first scrollable
    /// descendant so the swipe actually scrolls content (e.g. WebView, ScrollView, Table).
    /// Falls back to the original element if no scrollable descendant is found.
    private static func swipeTarget(for element: XCUIElement, in app: XCUIApplication) -> XCUIElement {
        // Only apply smart resolution when the target is the root app element
        guard element.elementType == .application else { return element }

        // Prioritized list of scrollable element types
        let scrollableTypes: [XCUIElement.ElementType] = [.webView, .scrollView, .table, .collectionView]
        for type in scrollableTypes {
            let match = app.descendants(matching: type).firstMatch
            if match.exists {
                return match
            }
        }
        return element
    }

    /// Perform a coordinate-based swipe on the given element.
    /// Uses XCUICoordinate press-and-drag which reliably scrolls WebViews
    /// and other content that doesn't respond to element.swipeUp().
    private static func coordinateSwipe(_ element: XCUIElement, direction: String) {
        // Swipe across the middle 60% of the element for a reliable scroll
        let start: CGVector
        let end: CGVector
        switch direction {
        case "up":    start = CGVector(dx: 0.5, dy: 0.75); end = CGVector(dx: 0.5, dy: 0.25)
        case "down":  start = CGVector(dx: 0.5, dy: 0.25); end = CGVector(dx: 0.5, dy: 0.75)
        case "left":  start = CGVector(dx: 0.75, dy: 0.5); end = CGVector(dx: 0.25, dy: 0.5)
        case "right": start = CGVector(dx: 0.25, dy: 0.5); end = CGVector(dx: 0.75, dy: 0.5)
        default: element.swipeUp(); return
        }
        let startCoord = element.coordinate(withNormalizedOffset: start)
        let endCoord = element.coordinate(withNormalizedOffset: end)
        startCoord.press(forDuration: 0.05, thenDragTo: endCoord)
    }

    // MARK: - Set Value

    /// Set the text value of an editable element at the given tree path.
    ///
    /// Clears the existing value first, then types the new value.
    /// The element must be a text field, text view, or search field.
    ///
    /// - Parameters:
    ///   - app: The XCUIApplication to search in.
    ///   - path: Tree path to the target element.
    ///   - value: The text to set.
    /// - Returns: A dictionary with `success` and optional `error` keys.
    static func setValue(
        app: XCUIApplication,
        path: [Int],
        value: String
    ) -> [String: Any] {
        guard let element = TreeBuilder.resolveElement(in: app, path: path) else {
            return [
                "success": false,
                "error": "Element not found at path \(path). Run /tree to refresh the element hierarchy.",
            ]
        }

        guard element.exists else {
            return [
                "success": false,
                "error": "Element at path \(path) no longer exists.",
            ]
        }

        // Tap to focus the element first
        element.tap()

        // Clear existing text: select all + delete
        // Use keyboard shortcut on iOS: triple-tap to select all, then type replacement
        let currentValue = element.value as? String ?? ""
        if !currentValue.isEmpty {
            // Select all text by tapping with enough taps to select all
            element.press(forDuration: 1.0)
            // Wait for the selection menu
            let selectAll = app.menuItems["Select All"]
            if selectAll.waitForExistence(timeout: 2.0) {
                selectAll.tap()
            }
        }

        // Type the new value
        element.typeText(value)

        return ["success": true]
    }

    // MARK: - Type Text

    /// Type text using the focused element or the application.
    ///
    /// The text is typed character by character through the keyboard.
    /// An element should already have focus before calling this.
    ///
    /// - Parameters:
    ///   - app: The XCUIApplication.
    ///   - text: The text to type.
    /// - Returns: A dictionary with `success` and optional `error` keys.
    static func typeText(
        app: XCUIApplication,
        text: String
    ) -> [String: Any] {
        app.typeText(text)
        return ["success": true]
    }

    // MARK: - Press Key

    /// Press a named key.
    ///
    /// Supported keys:
    ///   - `return` / `enter` — Return key
    ///   - `delete` / `backspace` — Delete backward
    ///   - `tab` — Tab key
    ///   - `escape` — Escape key
    ///   - `space` — Space bar
    ///   - `home` — Home button (via XCUIDevice)
    ///   - `volumeup`, `volumedown` — Volume buttons
    ///
    /// - Parameters:
    ///   - app: The XCUIApplication.
    ///   - key: The key name to press.
    /// - Returns: A dictionary with `success` and optional `error` keys.
    static func pressKey(
        app: XCUIApplication,
        key: String
    ) -> [String: Any] {
        switch key.lowercased() {
        case "return", "enter":
            app.typeText("\n")

        case "delete", "backspace":
            app.typeText(XCUIKeyboardKey.delete.rawValue)

        case "tab":
            app.typeText("\t")

        case "escape":
            // No direct escape key on iOS; try pressing the keyboard dismiss if visible
            if app.keyboards.count > 0 {
                app.typeText(XCUIKeyboardKey.escape.rawValue)
            }

        case "space":
            app.typeText(" ")

        case "home":
            XCUIDevice.shared.press(.home)

        case "volumeup":
            #if !targetEnvironment(simulator)
            XCUIDevice.shared.press(.volumeUp)
            #else
            return [
                "success": false,
                "error": "volumeUp is not available in the iOS Simulator.",
            ]
            #endif

        case "volumedown":
            #if !targetEnvironment(simulator)
            XCUIDevice.shared.press(.volumeDown)
            #else
            return [
                "success": false,
                "error": "volumeDown is not available in the iOS Simulator.",
            ]
            #endif

        default:
            // Try to type it as a single character
            if key.count == 1 {
                app.typeText(key)
            } else {
                return [
                    "success": false,
                    "error": "Unknown key '\(key)'. Supported: return, delete, tab, escape, space, home, volumeUp, volumeDown, or single characters.",
                ]
            }
        }

        return ["success": true]
    }
}
