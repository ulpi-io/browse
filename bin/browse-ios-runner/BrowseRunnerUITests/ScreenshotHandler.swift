import XCTest

// MARK: - Screenshot Handler

/// Captures screenshots of the running application.
///
/// Uses XCUIScreen to capture the full simulator screen, then writes
/// the PNG data to the specified output path on the host filesystem.
/// (The simulator shares the host filesystem, so paths like `/tmp/` work.)
enum ScreenshotHandler {

    /// Capture a screenshot and save it to the specified path.
    ///
    /// - Parameters:
    ///   - app: The XCUIApplication (used for app-specific screenshots if needed).
    ///   - outputPath: Absolute path on the host filesystem to write the PNG file.
    /// - Returns: A dictionary with `success` and optional `error` keys.
    static func captureScreenshot(
        app: XCUIApplication,
        outputPath: String
    ) -> [String: Any] {
        let screenshot = app.screenshot()
        let pngData = screenshot.pngRepresentation

        do {
            try pngData.write(to: URL(fileURLWithPath: outputPath))
            return ["success": true]
        } catch {
            return [
                "success": false,
                "error": "Failed to write screenshot to \(outputPath): \(error.localizedDescription)",
            ]
        }
    }
}
