import Foundation

// MARK: - RawIOSNode

/// Matches the `RawIOSNode` type in `src/app/ios/protocol.ts`.
/// Represents a single node in the iOS accessibility tree.
struct RawIOSNode: Encodable {
    let elementType: String
    let identifier: String
    let label: String
    let value: String
    let placeholderValue: String
    let frame: NodeFrame
    let isEnabled: Bool
    let isSelected: Bool
    let hasFocus: Bool
    let traits: [String]
    let children: [RawIOSNode]
}

/// Bounding frame in screen coordinates.
struct NodeFrame: Encodable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

// MARK: - IOSState

/// Matches the `IOSState` type in `src/app/ios/protocol.ts`.
/// Lightweight state snapshot from the runner.
struct IOSState: Encodable {
    let bundleId: String
    let screenTitle: String
    let elementCount: Int
    let alertPresent: Bool
    let keyboardVisible: Bool
    let orientation: String
    let statusBarTime: String
}

// MARK: - Action Request

/// JSON body for `POST /action`.
struct ActionRequest: Decodable {
    let path: [Int]
    let actionName: String
}

// MARK: - SetValue Request

/// JSON body for `POST /set-value`.
struct SetValueRequest: Decodable {
    let path: [Int]
    let value: String
}

// MARK: - Type Request

/// JSON body for `POST /type`.
struct TypeRequest: Decodable {
    let text: String
}

// MARK: - Press Request

/// JSON body for `POST /press`.
struct PressRequest: Decodable {
    let key: String
}

// MARK: - Screenshot Request

/// JSON body for `POST /screenshot`.
struct ScreenshotRequest: Decodable {
    let outputPath: String
}
