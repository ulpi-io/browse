import SwiftUI

/// Minimal host app required for XCUITest.
///
/// BrowseRunner's real logic lives in the UI test bundle (BrowseRunnerUITests).
/// This app is just the required host target -- XCUITest cannot run without a
/// host application. The app does nothing except display a status message.
@main
struct BrowseRunnerApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

struct ContentView: View {
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "antenna.radiowaves.left.and.right")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)
            Text("BrowseRunner")
                .font(.title2)
                .fontWeight(.semibold)
            Text("Host app for browse UI test runner.\nThe HTTP server runs in the UI test process.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
    }
}
