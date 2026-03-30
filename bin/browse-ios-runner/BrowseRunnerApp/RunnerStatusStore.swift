import Foundation
import SwiftUI

// MARK: - Decode Models

struct RunnerEnvelope<T: Decodable>: Decodable {
    let success: Bool
    let data: T?
    let error: String?
}

struct RunnerHealthData: Decodable {
    let status: String
}

struct RunnerStateData: Decodable {
    let bundleId: String
    let screenTitle: String
    let elementCount: Int
    let alertPresent: Bool
    let keyboardVisible: Bool
    let orientation: String
    let statusBarTime: String
}

// MARK: - RunnerStatusStore

@MainActor
final class RunnerStatusStore: ObservableObject {

    // MARK: Connection

    @Published var isConnected: Bool = false
    @Published var hasEverConnected: Bool = false
    @Published var isLoading: Bool = false
    @Published var lastError: String?

    // MARK: State fields

    @Published var bundleId: String? = nil
    @Published var screenTitle: String? = nil
    @Published var elementCount: Int? = nil
    @Published var orientation: String? = nil
    @Published var keyboardVisible: Bool? = nil
    @Published var alertPresent: Bool? = nil
    @Published var lastSync: Date? = nil

    // MARK: Server info

    let port: Int = 9820
    let version: String = {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
    }()
    let launchTime: Date = Date()

    // MARK: Private

    private var pollingTask: Task<Void, Never>?
    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 4
        config.timeoutIntervalForResource = 5
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    private let baseURL = "http://127.0.0.1:9820"

    // MARK: Lifecycle

    func start() {
        guard pollingTask == nil else { return }
        pollingTask = Task { [weak self] in
            guard let self else { return }
            await self.refresh()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                guard !Task.isCancelled else { break }
                await self.refresh()
            }
        }
    }

    func stop() {
        pollingTask?.cancel()
        pollingTask = nil
    }

    func refresh() async {
        isLoading = true
        defer { isLoading = false }

        do {
            let healthURL = URL(string: "\(baseURL)/health")!
            let (healthData, _) = try await session.data(from: healthURL)
            let envelope = try JSONDecoder().decode(RunnerEnvelope<RunnerHealthData>.self, from: healthData)

            guard envelope.success, envelope.data?.status == "healthy" else {
                isConnected = false
                lastError = envelope.error ?? "Unhealthy"
                return
            }
        } catch {
            isConnected = false
            lastError = error.localizedDescription
            return
        }

        do {
            let stateURL = URL(string: "\(baseURL)/state")!
            let (stateData, _) = try await session.data(from: stateURL)
            let envelope = try JSONDecoder().decode(RunnerEnvelope<RunnerStateData>.self, from: stateData)

            guard envelope.success, let state = envelope.data else {
                isConnected = false
                lastError = envelope.error ?? "No state data"
                return
            }

            isConnected = true
            hasEverConnected = true
            lastError = nil
            bundleId = state.bundleId
            screenTitle = state.screenTitle
            elementCount = state.elementCount
            orientation = state.orientation
            keyboardVisible = state.keyboardVisible
            alertPresent = state.alertPresent
            lastSync = Date()
        } catch {
            isConnected = false
            lastError = error.localizedDescription
        }
    }
}
