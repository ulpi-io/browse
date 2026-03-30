import SwiftUI

@main
struct BrowseRunnerApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                .preferredColorScheme(.dark)
        }
    }
}

// MARK: - Theme

private enum Theme {
    static let background = Color.black
    static let cardFill = Color(white: 0.067)
    static let cardBorder = Color(white: 0.133)
    static let divider = Color(white: 0.118)
    static let primaryText = Color.white
    static let secondaryText = Color.white.opacity(0.4)
    static let tertiaryText = Color.white.opacity(0.25)
    static let connectedGreen = Color(red: 0.133, green: 0.773, blue: 0.369)
    static let disconnectedRed = Color(red: 0.937, green: 0.267, blue: 0.267)
    static let staleOpacity: Double = 0.45
}

// MARK: - Content View

struct ContentView: View {
    @StateObject private var store = RunnerStatusStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()

            VStack(spacing: 0) {
                HeaderView(store: store)

                Theme.divider.frame(height: 1)
                    .padding(.horizontal, 24)
                    .padding(.top, 12)

                TargetAppCard(store: store)
                    .padding(.top, 16)

                StateGrid(store: store)
                    .padding(.top, 16)

                Spacer(minLength: 0)

                FooterView()
                    .padding(.top, 24)
                    .padding(.bottom, 16)
            }
            .padding(.horizontal, 24)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .onChange(of: scenePhase) { newPhase in
            switch newPhase {
            case .active:
                store.start()
            case .background, .inactive:
                store.stop()
            @unknown default:
                break
            }
        }
    }
}

// MARK: - Header

private struct HeaderView: View {
    @ObservedObject var store: RunnerStatusStore

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 0) {
                HStack(spacing: 14) {
                    AppIconView(isConnected: store.isConnected)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("BrowseRunner")
                            .font(.system(size: 20, weight: .bold))
                            .foregroundStyle(Theme.primaryText)
                            .fixedSize()
                        Text("v\(store.version)")
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(Theme.secondaryText)
                    }
                }
                .layoutPriority(1)

                Spacer(minLength: 8)

                VStack(alignment: .trailing, spacing: 4) {
                    ConnectionBadge(isConnected: store.isConnected)
                    PortBadge(port: store.port)
                }
            }

            Text("iOS automation runner")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color.white.opacity(0.3))
        }
    }
}

// MARK: - App Icon

private struct AppIconView: View {
    let isConnected: Bool
    private var accent: Color { isConnected ? Theme.connectedGreen : Theme.disconnectedRed }

    var body: some View {
        Text(">_")
            .font(.system(size: 15, weight: .bold, design: .monospaced))
            .foregroundStyle(accent)
            .frame(width: 42, height: 42)
            .background(
                RoundedRectangle(cornerRadius: 11)
                    .fill(Theme.cardFill)
                    .overlay(
                        RoundedRectangle(cornerRadius: 11)
                            .strokeBorder(accent.opacity(0.3), lineWidth: 1)
                    )
            )
    }
}

// MARK: - Connection Badge

private struct ConnectionBadge: View {
    let isConnected: Bool
    @State private var pulse = false
    private var color: Color { isConnected ? Theme.connectedGreen : Theme.disconnectedRed }

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)
                .shadow(color: isConnected ? color.opacity(pulse ? 0.5 : 0.1) : .clear,
                        radius: isConnected ? (pulse ? 6 : 2) : 0)
                .animation(isConnected ? .easeInOut(duration: 2).repeatForever(autoreverses: true) : .default,
                           value: pulse)
                .onAppear { pulse = true }

            Text(isConnected ? "Connected" : "Disconnected")
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .foregroundStyle(color)
                .fixedSize()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(color.opacity(0.1))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(color.opacity(0.25), lineWidth: 1))
        )
        .fixedSize()
    }
}

// MARK: - Port Badge

private struct PortBadge: View {
    let port: Int

    var body: some View {
        Text(":\(String(port))")
            .font(.system(size: 11, weight: .medium, design: .monospaced))
            .foregroundStyle(Color.white.opacity(0.5))
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(Theme.cardFill)
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.cardBorder, lineWidth: 1))
            )
    }
}

// MARK: - Target App Card

private struct TargetAppCard: View {
    @ObservedObject var store: RunnerStatusStore
    private var stale: Bool { !store.isConnected && store.hasEverConnected }
    private var empty: Bool { !store.isConnected && !store.hasEverConnected }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel(title: "TARGET APP")

            VStack(alignment: .leading, spacing: 14) {
                Text(store.bundleId ?? "No target")
                    .font(.system(size: 15, weight: .medium, design: .monospaced))
                    .foregroundStyle(Theme.primaryText)

                VStack(spacing: 8) {
                    DetailRow(label: "Current Screen", value: store.screenTitle ?? (empty ? "Unavailable" : "--"))
                    DetailRow(label: "Orientation", value: displayOrientation)
                    DetailRow(label: "Last Sync", value: formattedSync, mono: true)
                }
            }
            .padding(16)
            .background(
                RoundedRectangle(cornerRadius: 14)
                    .fill(Theme.cardFill)
                    .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.cardBorder, lineWidth: 1))
            )
            .opacity(stale ? Theme.staleOpacity : 1)
        }
    }

    private var displayOrientation: String {
        guard let o = store.orientation else { return "--" }
        return o.prefix(1).uppercased() + o.dropFirst()
    }

    private var formattedSync: String {
        guard let date = store.lastSync else { return "--" }
        let fmt = DateFormatter()
        fmt.dateFormat = "H:mm:ss"
        return fmt.string(from: date)
    }
}

// MARK: - Detail Row

private struct DetailRow: View {
    let label: String
    let value: String
    var mono: Bool = false

    var body: some View {
        HStack {
            Text(label)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.secondaryText)
            Spacer()
            Text(value)
                .font(.system(size: 12, weight: .medium, design: mono ? .monospaced : .default))
                .foregroundStyle(Theme.primaryText)
        }
    }
}

// MARK: - State Grid

private struct StateGrid: View {
    @ObservedObject var store: RunnerStatusStore
    private var stale: Bool { !store.isConnected && store.hasEverConnected }
    private var empty: Bool { !store.isConnected && !store.hasEverConnected }

    private let columns = [
        GridItem(.flexible(), spacing: 8),
        GridItem(.flexible(), spacing: 8),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel(title: "STATE")

            LazyVGrid(columns: columns, spacing: 8) {
                MetricCard(label: "ELEMENTS") {
                    Text(store.elementCount.map(String.init) ?? "--")
                        .font(.system(size: 26, weight: .bold, design: .monospaced))
                        .foregroundStyle(Theme.primaryText)
                }

                MetricCard(label: "UPTIME") {
                    TimelineView(.periodic(from: .now, by: 1)) { ctx in
                        Text(formatUptime(ctx.date.timeIntervalSince(store.launchTime)))
                            .font(.system(size: 26, weight: .bold, design: .monospaced))
                            .foregroundStyle(Theme.primaryText)
                    }
                }

                MetricCard(label: "KEYBOARD") {
                    StatusDot(label: displayKeyboard, active: store.keyboardVisible == true)
                }

                MetricCard(label: "ALERT") {
                    StatusDot(label: displayAlert, active: store.alertPresent == true)
                }
            }
            .opacity(stale ? Theme.staleOpacity : 1)
        }
    }

    private var displayKeyboard: String {
        guard let v = store.keyboardVisible else { return "--" }
        return v ? "Visible" : "Hidden"
    }

    private var displayAlert: String {
        guard let v = store.alertPresent else { return "--" }
        return v ? "Present" : "None"
    }

    private func formatUptime(_ interval: TimeInterval) -> String {
        let total = Int(max(0, interval))
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        return h > 0 ? "\(h)h \(m)m" : "\(m)m \(s)s"
    }
}

// MARK: - Metric Card

private struct MetricCard<Content: View>: View {
    let label: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label)
                .font(.system(size: 10, weight: .semibold))
                .tracking(0.5)
                .foregroundStyle(Theme.secondaryText)
                .textCase(.uppercase)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(Theme.cardFill)
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.cardBorder, lineWidth: 1))
        )
    }
}

// MARK: - Status Dot

private struct StatusDot: View {
    let label: String
    var active: Bool = false

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(Color.white.opacity(active ? 0.6 : 0.25))
                .frame(width: 6, height: 6)
            Text(label)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Color.white.opacity(0.5))
        }
    }
}

// MARK: - Section Label

private struct SectionLabel: View {
    let title: String

    var body: some View {
        Text(title)
            .font(.system(size: 10, weight: .semibold))
            .tracking(1)
            .foregroundStyle(Theme.tertiaryText)
            .textCase(.uppercase)
    }
}

// MARK: - Footer

private struct FooterView: View {
    var body: some View {
        VStack(spacing: 4) {
            Text("Commands are executed from browse CLI")
                .font(.system(size: 11))
                .foregroundStyle(Color.white.opacity(0.3))
            Text("This app shows runner health and current target state")
                .font(.system(size: 11))
                .foregroundStyle(Color.white.opacity(0.2))
        }
        .frame(maxWidth: .infinity)
        .multilineTextAlignment(.center)
    }
}
