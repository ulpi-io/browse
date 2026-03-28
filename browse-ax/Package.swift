// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "browse-ax",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "browse-ax", path: "Sources/BrowseAX")
    ]
)
