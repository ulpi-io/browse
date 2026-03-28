import Cocoa
import ImageIO
import UniformTypeIdentifiers

// MARK: - Screenshot Handler (TASK-027)

/// Handles `screenshot` command using CGWindowListCreateImage.
enum ScreenshotHandler {

    /// Capture the target application's frontmost window as a PNG file.
    /// - Parameters:
    ///   - reader: TreeReader with the target app (used for PID and window detection)
    ///   - outputPath: File path to save the PNG screenshot
    /// - Returns: JSON string with success/error result
    static func captureWindow(reader: TreeReader, outputPath: String) -> String {
        let pid = reader.pid

        // Find the frontmost window for this PID using CGWindowList
        guard let windowID = findFrontmostWindowID(pid: pid) else {
            return JSONOutput.failureJSON("No visible window found for the target application")
        }

        // Check if window is minimized
        if isWindowMinimized(windowID: windowID) {
            return JSONOutput.failureJSON("Window is minimized. Restore it first.")
        }

        // Capture the window image
        guard let image = CGWindowListCreateImage(
            .null,
            .optionIncludingWindow,
            windowID,
            [.boundsIgnoreFraming, .bestResolution]
        ) else {
            return JSONOutput.failureJSON("Failed to capture window screenshot")
        }

        // Write the image to PNG
        let url = URL(fileURLWithPath: outputPath)
        guard let destination = CGImageDestinationCreateWithURL(
            url as CFURL,
            UTType.png.identifier as CFString,
            1,
            nil
        ) else {
            return JSONOutput.failureJSON("Failed to create image destination at '\(outputPath)'")
        }

        CGImageDestinationAddImage(destination, image, nil)

        guard CGImageDestinationFinalize(destination) else {
            return JSONOutput.failureJSON("Failed to write PNG to '\(outputPath)'")
        }

        return JSONOutput.successJSON()
    }

    // MARK: - Private Helpers

    /// Find the frontmost (on-screen) window ID for a given PID.
    private static func findFrontmostWindowID(pid: pid_t) -> CGWindowID? {
        guard let windowList = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]] else {
            return nil
        }

        // Filter to windows belonging to our target PID
        let appWindows = windowList.filter { info in
            guard let ownerPID = info[kCGWindowOwnerPID as String] as? Int32 else {
                return false
            }
            return ownerPID == pid
        }

        // Prefer the first on-screen window (CGWindowListCopyWindowInfo returns front-to-back order)
        for window in appWindows {
            guard let windowID = window[kCGWindowNumber as String] as? CGWindowID else {
                continue
            }
            // Skip very small windows (menu bar items, etc.)
            if let bounds = window[kCGWindowBounds as String] as? [String: Any],
               let width = (bounds["Width"] as? NSNumber)?.doubleValue,
               let height = (bounds["Height"] as? NSNumber)?.doubleValue,
               width > 50 && height > 50 {
                return windowID
            }
        }

        // If no large window found, return the first window ID
        return appWindows.first?[kCGWindowNumber as String] as? CGWindowID
    }

    /// Check if a window is minimized by examining its on-screen status.
    private static func isWindowMinimized(windowID: CGWindowID) -> Bool {
        guard let windowList = CGWindowListCopyWindowInfo(
            [.optionAll, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]] else {
            return false
        }

        guard let windowInfo = windowList.first(where: {
            ($0[kCGWindowNumber as String] as? CGWindowID) == windowID
        }) else {
            return false
        }

        // If the window is not on screen, it is likely minimized
        let isOnScreen = windowInfo[kCGWindowIsOnscreen as String] as? Bool ?? false
        return !isOnScreen
    }
}
