import XCTest

// MARK: - Tree Builder

/// Walks the XCUIApplication element hierarchy and builds a `RawIOSNode` tree.
///
/// Uses XCUIElement's accessibility properties to map each element to the JSON
/// format expected by `src/app/ios/protocol.ts`. The tree is depth-first,
/// with children ordered by index within each element type group.
enum TreeBuilder {

    /// Build the full accessibility tree for the given application.
    /// Returns the root `RawIOSNode` representing the application element.
    static func buildTree(from app: XCUIApplication) -> RawIOSNode {
        return walkElement(app)
    }

    /// Count the total number of elements in the tree rooted at the given element.
    /// Uses a lightweight query to avoid rebuilding the full node tree.
    static func countElements(in app: XCUIApplication) -> Int {
        return app.descendants(matching: .any).count
    }

    /// Resolve an element at a given tree path (array of child indices).
    ///
    /// The path `[0]` is the root (application). `[0, 2]` is the third child
    /// of the root. This matches how the bridge's `convertTree` assigns paths.
    static func resolveElement(in app: XCUIApplication, path: [Int]) -> XCUIElement? {
        guard !path.isEmpty else { return nil }

        // Path[0] is always 0 (the root = app itself).
        // Subsequent indices are child positions.
        var current: XCUIElement = app
        for childIndex in path.dropFirst() {
            let children = current.children(matching: .any)
            guard childIndex >= 0, childIndex < children.count else {
                return nil
            }
            current = children.element(boundBy: childIndex)
        }

        return current
    }

    // MARK: - Private

    /// Recursively walk an XCUIElement and its children.
    private static func walkElement(_ element: XCUIElement) -> RawIOSNode {
        let children = element.children(matching: .any)
        var childNodes: [RawIOSNode] = []
        for i in 0..<children.count {
            let child = children.element(boundBy: i)
            // Only include elements that exist in the hierarchy.
            // Skip elements that are not hittable and have no label/identifier
            // to reduce noise in the tree.
            if child.exists {
                childNodes.append(walkElement(child))
            }
        }

        let frame = element.frame
        let nodeFrame = NodeFrame(
            x: Double(frame.origin.x),
            y: Double(frame.origin.y),
            width: Double(frame.size.width),
            height: Double(frame.size.height)
        )

        return RawIOSNode(
            elementType: mapElementType(element.elementType),
            identifier: element.identifier,
            label: element.label,
            value: stringValue(of: element),
            placeholderValue: element.placeholderValue ?? "",
            frame: nodeFrame,
            isEnabled: element.isEnabled,
            isSelected: element.isSelected,
            hasFocus: element.hasFocus,
            traits: mapTraits(element.elementType),
            children: childNodes
        )
    }

    /// Extract the string value from an element.
    /// XCUIElement.value is `Any?`, so we coerce to String.
    private static func stringValue(of element: XCUIElement) -> String {
        guard let val = element.value else { return "" }
        if let str = val as? String { return str }
        if let num = val as? NSNumber { return num.stringValue }
        return String(describing: val)
    }

    /// Map XCUIElement.ElementType to the string name expected by protocol.ts.
    /// These names match the keys in `IOS_ROLE_MAP` on the TypeScript side.
    private static func mapElementType(_ type: XCUIElement.ElementType) -> String {
        switch type {
        case .application:         return "application"
        case .button:              return "button"
        case .staticText:          return "staticText"
        case .textField:           return "textField"
        case .secureTextField:     return "secureTextField"
        case .textView:            return "textView"
        case .image:               return "image"
        case .switch:              return "switch"
        case .toggle:              return "toggle"
        case .slider:              return "slider"
        case .stepper:             return "stepper"
        case .picker:              return "picker"
        case .segmentedControl:    return "segmentedControl"
        case .link:                return "link"
        case .cell:                return "cell"
        case .table:               return "table"
        case .collectionView:      return "collectionView"
        case .scrollView:          return "scrollView"
        case .navigationBar:       return "navigationBar"
        case .toolbar:             return "toolbar"
        case .tabBar:              return "tabBar"
        case .alert:               return "alert"
        case .sheet:               return "sheet"
        case .popover:             return "popover"
        case .window:              return "window"
        case .webView:             return "webView"
        case .map:                 return "map"
        case .group:               return "group"
        case .icon:                return "icon"
        case .searchField:         return "searchField"
        case .activityIndicator:   return "activityIndicator"
        case .progressIndicator:   return "progressIndicator"
        case .menu:                return "menu"
        case .menuItem:            return "menuItem"
        case .tab:                 return "tab"
        case .key:                 return "key"
        case .keyboard:            return "keyboard"
        case .other:               return "other"
        default:                   return "other"
        }
    }

    /// Derive trait names from the element type.
    /// On iOS, XCUIElement doesn't directly expose UIAccessibilityTraits,
    /// so we infer traits from the element type.
    private static func mapTraits(_ type: XCUIElement.ElementType) -> [String] {
        switch type {
        case .button:           return ["button"]
        case .link:             return ["link"]
        case .staticText:       return ["staticText"]
        case .image:            return ["image"]
        case .searchField:      return ["searchField"]
        case .switch, .toggle:  return ["button"]
        case .slider:           return ["adjustable"]
        case .tab:              return ["button", "tab"]
        default:                return []
        }
    }
}
