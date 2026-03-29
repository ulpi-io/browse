import XCTest

// MARK: - Tree Builder

/// Walks the XCUIApplication element hierarchy and builds a `RawIOSNode` tree.
///
/// Uses XCUIElement's accessibility properties to map each element to the JSON
/// format expected by `src/app/ios/protocol.ts`. The tree is depth-first,
/// with children ordered by index within each element type group.
enum TreeBuilder {

    /// Build the full accessibility tree for the given application.
    /// Uses snapshot().dictionaryRepresentation for a fast single-IPC-call tree fetch
    /// (same technique as Maestro). Falls back to element-by-element walk on failure.
    static func buildTree(from app: XCUIApplication) -> RawIOSNode {
        do {
            let snapshot = try app.snapshot()
            let dict = snapshot.dictionaryRepresentation
            return nodeFromSnapshot(dict)
        } catch {
            NSLog("[BrowseRunner] Snapshot API failed (\(error.localizedDescription)), falling back to element walk")
            return walkElement(app)
        }
    }

    /// Convert a snapshot dictionary to a RawIOSNode recursively.
    private static func nodeFromSnapshot(_ dict: [XCUIElement.AttributeName: Any]) -> RawIOSNode {
        let elementType = (dict[.elementType] as? Int).flatMap { mapElementType($0) } ?? "other"
        let label = dict[.label] as? String ?? ""
        let value = dict[.value] as? String ?? ""
        let identifier = dict[.identifier] as? String ?? ""
        let placeholderValue = dict[.placeholderValue] as? String ?? ""
        let isEnabled = dict[.enabled] as? Bool ?? true
        let hasFocus = dict[.hasFocus] as? Bool ?? false
        let isSelected = dict[.selected] as? Bool ?? false

        // Frame from snapshot
        var frame = NodeFrame(x: 0, y: 0, width: 0, height: 0)
        if let frameDict = dict[.frame] as? [String: Double] {
            frame = NodeFrame(
                x: frameDict["X"] ?? 0,
                y: frameDict["Y"] ?? 0,
                width: frameDict["Width"] ?? 0,
                height: frameDict["Height"] ?? 0
            )
        }

        // Traits
        var traits: [String] = []
        if let traitValue = dict[XCUIElement.AttributeName(rawValue: "traits")] as? UInt64 {
            traits = mapSnapshotTraits(traitValue)
        }

        // Children
        var children: [RawIOSNode] = []
        if let childDicts = dict[.children] as? [[XCUIElement.AttributeName: Any]] {
            children = childDicts.map { nodeFromSnapshot($0) }
        }

        return RawIOSNode(
            elementType: elementType,
            identifier: identifier,
            label: label,
            value: value,
            placeholderValue: placeholderValue,
            frame: frame,
            isEnabled: isEnabled,
            isSelected: isSelected,
            hasFocus: hasFocus,
            traits: traits,
            children: children
        )
    }

    /// Map XCUIElement.ElementType raw value to string.
    private static func mapElementType(_ rawValue: Int) -> String {
        // These values match XCUIElement.ElementType rawValue
        switch rawValue {
        case 0: return "any"
        case 1: return "other"
        case 2: return "application"
        case 3: return "group"
        case 4: return "window"
        case 5: return "sheet"
        case 6: return "drawer"
        case 7: return "alert"
        case 8: return "dialog"
        case 9: return "button"
        case 10: return "radioButton"
        case 11: return "radioGroup"
        case 12: return "checkBox"
        case 13: return "disclosureTriangle"
        case 14: return "popUpButton"
        case 15: return "comboBox"
        case 16: return "menuButton"
        case 17: return "toolbarButton"
        case 18: return "popover"
        case 19: return "keyboard"
        case 20: return "key"
        case 21: return "navigationBar"
        case 22: return "tabBar"
        case 23: return "tabGroup"
        case 24: return "toolbar"
        case 25: return "statusBar"
        case 26: return "table"
        case 27: return "tableRow"
        case 28: return "tableColumn"
        case 29: return "outline"
        case 30: return "outlineRow"
        case 31: return "browser"
        case 32: return "collectionView"
        case 33: return "slider"
        case 34: return "pageIndicator"
        case 35: return "progressIndicator"
        case 36: return "activityIndicator"
        case 37: return "segmentedControl"
        case 38: return "picker"
        case 39: return "pickerWheel"
        case 40: return "switch"
        case 41: return "toggle"
        case 42: return "link"
        case 43: return "image"
        case 44: return "icon"
        case 45: return "searchField"
        case 46: return "scrollView"
        case 47: return "scrollBar"
        case 48: return "staticText"
        case 49: return "textField"
        case 50: return "secureTextField"
        case 51: return "datePicker"
        case 52: return "textView"
        case 53: return "menu"
        case 54: return "menuItem"
        case 55: return "menuBar"
        case 56: return "menuBarItem"
        case 57: return "map"
        case 58: return "webView"
        case 59: return "incrementArrow"
        case 60: return "decrementArrow"
        case 61: return "timeline"
        case 62: return "ratingIndicator"
        case 63: return "valueIndicator"
        case 64: return "splitGroup"
        case 65: return "splitter"
        case 66: return "relevanceIndicator"
        case 67: return "colorWell"
        case 68: return "helpTag"
        case 69: return "matte"
        case 70: return "dockItem"
        case 71: return "ruler"
        case 72: return "rulerMarker"
        case 73: return "grid"
        case 74: return "levelIndicator"
        case 75: return "cell"
        case 76: return "layoutArea"
        case 77: return "layoutItem"
        case 78: return "handle"
        case 79: return "stepper"
        case 80: return "tab"
        default: return "other"
        }
    }

    /// Map snapshot trait bitmask to string array.
    private static func mapSnapshotTraits(_ value: UInt64) -> [String] {
        var traits: [String] = []
        if value & (1 << 0) != 0 { traits.append("button") }
        if value & (1 << 1) != 0 { traits.append("link") }
        if value & (1 << 2) != 0 { traits.append("image") }
        if value & (1 << 3) != 0 { traits.append("selected") }
        if value & (1 << 4) != 0 { traits.append("playsSound") }
        if value & (1 << 5) != 0 { traits.append("keyboardKey") }
        if value & (1 << 6) != 0 { traits.append("staticText") }
        if value & (1 << 7) != 0 { traits.append("summaryElement") }
        if value & (1 << 8) != 0 { traits.append("notEnabled") }
        if value & (1 << 9) != 0 { traits.append("updatesFrequently") }
        if value & (1 << 12) != 0 { traits.append("searchField") }
        if value & (1 << 13) != 0 { traits.append("startsMediaSession") }
        if value & (1 << 14) != 0 { traits.append("adjustable") }
        if value & (1 << 15) != 0 { traits.append("allowsDirectInteraction") }
        if value & (1 << 16) != 0 { traits.append("causesPageTurn") }
        if value & (1 << 17) != 0 { traits.append("tabBar") }
        return traits
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
