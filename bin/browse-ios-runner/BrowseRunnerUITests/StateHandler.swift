import XCTest

// MARK: - State Handler

/// Captures lightweight state from the running application for action-context probes.
///
/// Produces an `IOSState` matching the TypeScript `IOSState` type in `protocol.ts`.
enum StateHandler {

    /// Capture the current state of the application.
    ///
    /// - Parameters:
    ///   - app: The XCUIApplication to inspect.
    ///   - bundleId: The target app's bundle identifier.
    /// - Returns: An `IOSState` reflecting the current screen.
    static func captureState(app: XCUIApplication, bundleId: String) -> IOSState {
        let screenTitle = resolveScreenTitle(app: app)
        let elementCount = TreeBuilder.countElements(in: app)
        let alertPresent = app.alerts.count > 0 || app.sheets.count > 0
        let keyboardVisible = app.keyboards.count > 0
        let orientation = currentOrientation()
        let statusBarTime = resolveStatusBarTime(app: app)

        return IOSState(
            bundleId: bundleId,
            screenTitle: screenTitle,
            elementCount: elementCount,
            alertPresent: alertPresent,
            keyboardVisible: keyboardVisible,
            orientation: orientation,
            statusBarTime: statusBarTime
        )
    }

    // MARK: - Private

    /// Attempt to find the current screen title.
    /// Checks navigation bars first, then falls back to the app title.
    private static func resolveScreenTitle(app: XCUIApplication) -> String {
        // Check navigation bars for a title
        let navBars = app.navigationBars
        if navBars.count > 0 {
            let firstBar = navBars.element(boundBy: 0)
            let barIdentifier = firstBar.identifier
            if !barIdentifier.isEmpty {
                return barIdentifier
            }
            // Try to find a static text child that acts as the title
            let texts = firstBar.staticTexts
            if texts.count > 0 {
                let titleText = texts.element(boundBy: 0).label
                if !titleText.isEmpty {
                    return titleText
                }
            }
        }

        // Fall back to the app label
        return app.label
    }

    /// Get the current device orientation as a string.
    private static func currentOrientation() -> String {
        let orientation = XCUIDevice.shared.orientation
        switch orientation {
        case .landscapeLeft, .landscapeRight:
            return "landscape"
        default:
            return "portrait"
        }
    }

    /// Attempt to read the status bar time.
    /// On iOS simulators, the status bar time can be read from the status bar element.
    private static func resolveStatusBarTime(app: XCUIApplication) -> String {
        // The status bar is accessible via the springboard, not the app.
        // As a fallback, return the current time.
        let formatter = DateFormatter()
        formatter.dateFormat = "h:mm a"
        return formatter.string(from: Date())
    }
}
