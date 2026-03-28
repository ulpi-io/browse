import Cocoa

// MARK: - Keyboard Handler (TASK-027)

/// Handles `type` and `press` commands using CGEvent keyboard events.
enum KeyboardHandler {

    // MARK: - Key Code Map

    /// Map of named keys to CGKeyCode values.
    private static let keyCodeMap: [String: CGKeyCode] = [
        "return": 36,
        "enter": 36,
        "tab": 48,
        "space": 49,
        "escape": 53,
        "delete": 51,
        "backspace": 51,
        "forwarddelete": 117,
        "uparrow": 126,
        "up": 126,
        "downarrow": 125,
        "down": 125,
        "leftarrow": 123,
        "left": 123,
        "rightarrow": 124,
        "right": 124,
        "home": 115,
        "end": 119,
        "pageup": 116,
        "pagedown": 121,
        "f1": 122,
        "f2": 120,
        "f3": 99,
        "f4": 118,
        "f5": 96,
        "f6": 97,
        "f7": 98,
        "f8": 100,
        "f9": 101,
        "f10": 109,
        "f11": 103,
        "f12": 111,
        "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3,
        "g": 5, "h": 4, "i": 34, "j": 38, "k": 40, "l": 37,
        "m": 46, "n": 45, "o": 31, "p": 35, "q": 12, "r": 15,
        "s": 1, "t": 17, "u": 32, "v": 9, "w": 13, "x": 7,
        "y": 16, "z": 6,
        "0": 29, "1": 18, "2": 19, "3": 20, "4": 21,
        "5": 23, "6": 22, "7": 26, "8": 28, "9": 25,
        "-": 27, "=": 24, "[": 33, "]": 30, "\\": 42,
        ";": 41, "'": 39, ",": 43, ".": 47, "/": 44,
        "`": 50,
    ]

    // MARK: - Public API

    /// Type a string of text by sending individual key events to the target process.
    /// - Parameters:
    ///   - reader: TreeReader with the target app
    ///   - text: The text string to type
    /// - Returns: JSON string with success/error result
    static func typeText(reader: TreeReader, text: String) -> String {
        // Check if app has a focused element
        let focused = reader.copyAttribute(
            of: reader.appElement, name: kAXFocusedUIElementAttribute
        )
        if focused == nil {
            return JSONOutput.failureJSON("No focused element")
        }

        let pid = reader.pid

        for char in text {
            let charStr = String(char).lowercased()
            let needsShift = char.isUppercase || isShiftedCharacter(char)

            if let keyCode = keyCodeMap[charStr] {
                sendKeyEvent(keyCode: keyCode, keyDown: true, pid: pid, shift: needsShift)
                sendKeyEvent(keyCode: keyCode, keyDown: false, pid: pid, shift: needsShift)
            } else if let keyCode = keyCodeForShiftedChar(char) {
                sendKeyEvent(keyCode: keyCode, keyDown: true, pid: pid, shift: true)
                sendKeyEvent(keyCode: keyCode, keyDown: false, pid: pid, shift: true)
            } else {
                // For characters not in our map, try Unicode input via CGEvent
                sendUnicodeChar(char, pid: pid)
            }

            // Small delay between keystrokes for reliability
            usleep(5000) // 5ms
        }

        return JSONOutput.successJSON()
    }

    /// Press a single named key (e.g. "Enter", "Tab", "Escape").
    /// - Parameters:
    ///   - reader: TreeReader with the target app
    ///   - keyName: The key name to press
    /// - Returns: JSON string with success/error result
    static func pressKey(reader: TreeReader, keyName: String) -> String {
        // Check if app has a focused element
        let focused = reader.copyAttribute(
            of: reader.appElement, name: kAXFocusedUIElementAttribute
        )
        if focused == nil {
            return JSONOutput.failureJSON("No focused element")
        }

        let lowered = keyName.lowercased()
        guard let keyCode = keyCodeMap[lowered] else {
            return JSONOutput.failureJSON("Unknown key: '\(keyName)'")
        }

        let pid = reader.pid
        sendKeyEvent(keyCode: keyCode, keyDown: true, pid: pid, shift: false)
        sendKeyEvent(keyCode: keyCode, keyDown: false, pid: pid, shift: false)

        return JSONOutput.successJSON()
    }

    // MARK: - Private Helpers

    private static func sendKeyEvent(keyCode: CGKeyCode, keyDown: Bool, pid: pid_t, shift: Bool) {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: keyDown) else {
            return
        }

        if shift {
            event.flags = .maskShift
        }

        // Post the event directly to the target process
        event.postToPid(pid)
    }

    private static func sendUnicodeChar(_ char: Character, pid: pid_t) {
        let utf16 = Array(String(char).utf16)
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true) else {
            return
        }
        event.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
        event.postToPid(pid)

        guard let upEvent = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
            return
        }
        upEvent.postToPid(pid)
    }

    private static func isShiftedCharacter(_ char: Character) -> Bool {
        let shifted: Set<Character> = [
            "~", "!", "@", "#", "$", "%", "^", "&", "*", "(", ")",
            "_", "+", "{", "}", "|", ":", "\"", "<", ">", "?"
        ]
        return shifted.contains(char)
    }

    /// Get the base key code for a shifted character (e.g. "!" -> keyCode for "1").
    private static func keyCodeForShiftedChar(_ char: Character) -> CGKeyCode? {
        let shiftMap: [Character: String] = [
            "~": "`", "!": "1", "@": "2", "#": "3", "$": "4",
            "%": "5", "^": "6", "&": "7", "*": "8", "(": "9",
            ")": "0", "_": "-", "+": "=", "{": "[", "}": "]",
            "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".",
            "?": "/",
        ]
        guard let base = shiftMap[char] else { return nil }
        return keyCodeMap[base]
    }
}
