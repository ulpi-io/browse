# Swift Bug Patterns

> Detect: `.swift` files, `Package.swift` (SwiftPM), `.xcodeproj`/`.xcworkspace`, `import UIKit`/`import SwiftUI`/`import Vapor`.

## Optionals & Nil Safety

### Force unwrapping crashes

```swift
// BUG: Force unwrap crashes if nil
let name = user.name! // crash if user.name is nil

// FIX: Safe unwrap
guard let name = user.name else {
    return .failure(.userNameMissing)
}

// Or if-let
if let name = user.name {
    display(name)
}

// Optional chaining for access
let length = user.name?.count ?? 0
```

### Implicitly unwrapped optionals — deferred initialization trap

```swift
// BUG: IUO accessed before initialization
class ViewController: UIViewController {
    var tableView: UITableView! // implicitly unwrapped

    func setupData() {
        tableView.reloadData() // crash if called before viewDidLoad
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        tableView = UITableView()
    }
}

// FIX: Use lazy or make it a regular optional
class ViewController: UIViewController {
    lazy var tableView: UITableView = {
        let tv = UITableView()
        tv.delegate = self
        return tv
    }()
}
```

## Memory Management

### Retain cycles — closures capture self strongly

```swift
// BUG: Retain cycle — self holds closure, closure holds self
class ViewController: UIViewController {
    var onComplete: (() -> Void)?

    func start() {
        onComplete = {
            self.finish() // strong reference to self → cycle
        }
    }
}

// FIX: Capture list with weak self
onComplete = { [weak self] in
    self?.finish()
}
```

### Timer retain cycle

```swift
// BUG: Timer retains target — ViewController never deallocates
class ViewController: UIViewController {
    var timer: Timer?

    override func viewDidLoad() {
        timer = Timer.scheduledTimer(timeInterval: 1, target: self,
            selector: #selector(tick), userInfo: nil, repeats: true)
        // Timer retains self → self retains timer → cycle
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        timer?.invalidate() // must invalidate to break cycle
    }
}
```

## Concurrency (Swift Concurrency)

### Actor isolation — accessing actor state from non-isolated context

```swift
// BUG: Accessing actor property without await
actor UserStore {
    var users: [User] = []
}

func printUsers(store: UserStore) {
    print(store.users) // compiler error in strict concurrency mode
}

// FIX: Await actor access
func printUsers(store: UserStore) async {
    let users = await store.users
    print(users)
}
```

### Task cancellation — not checking for cancellation

```swift
// BUG: Long-running task ignores cancellation
func fetchAllPages() async throws -> [Page] {
    var pages: [Page] = []
    for i in 1...100 {
        pages.append(try await fetchPage(i)) // runs all 100 even if cancelled
    }
    return pages
}

// FIX: Check for cancellation
func fetchAllPages() async throws -> [Page] {
    var pages: [Page] = []
    for i in 1...100 {
        try Task.checkCancellation() // throws if task was cancelled
        pages.append(try await fetchPage(i))
    }
    return pages
}
```

### Data races with @Sendable closures

```swift
// BUG: Mutable state captured in @Sendable closure
var count = 0
await withTaskGroup(of: Void.self) { group in
    for _ in 0..<100 {
        group.addTask {
            count += 1 // data race! count is not Sendable
        }
    }
}

// FIX: Use actor or atomic
actor Counter {
    var count = 0
    func increment() { count += 1 }
}
```

## UIKit Bugs

### Main thread — UI updates must be on main thread

```swift
// BUG: UI update from background thread → crash or visual glitch
URLSession.shared.dataTask(with: url) { data, _, _ in
    self.label.text = "Done" // background thread!
}.resume()

// FIX: Dispatch to main
URLSession.shared.dataTask(with: url) { data, _, _ in
    DispatchQueue.main.async {
        self.label.text = "Done"
    }
}.resume()

// Swift Concurrency equivalent
Task {
    let data = try await URLSession.shared.data(from: url)
    await MainActor.run {
        label.text = "Done"
    }
}
```

## SwiftUI Bugs

### @State initialized in init — doesn't update

```swift
// BUG: @State set in init never updates when parent passes new value
struct DetailView: View {
    @State var name: String

    init(name: String) {
        _name = State(initialValue: name) // only sets once!
    }
}

// FIX: Use @Binding for two-way, or let/computed for read-only
struct DetailView: View {
    let name: String // if read-only, just use let
    // or
    @Binding var name: String // if parent should control it
}
```

### ObservableObject — forgetting @Published

```swift
// BUG: View doesn't update when property changes
class ViewModel: ObservableObject {
    var items: [Item] = [] // missing @Published!
}

// FIX: Add @Published
class ViewModel: ObservableObject {
    @Published var items: [Item] = []
}
```

## Codable Bugs

### JSON key mismatch — silent nil or crash

```swift
// BUG: API returns "user_name" but struct expects "userName"
struct User: Codable {
    let userName: String // doesn't match "user_name" in JSON → nil or decode error
}

// FIX: CodingKeys
struct User: Codable {
    let userName: String

    enum CodingKeys: String, CodingKey {
        case userName = "user_name"
    }
}

// Or use keyDecodingStrategy
let decoder = JSONDecoder()
decoder.keyDecodingStrategy = .convertFromSnakeCase
```

## Testing Patterns

```swift
import XCTest

class UserServiceTests: XCTestCase {
    func testNilUserReturnsError() async throws {
        let service = UserService(repository: MockRepository(user: nil))
        let result = await service.getUser(id: "nonexistent")
        XCTAssertNil(result)
    }

    func testConcurrentAccessDoesNotCrash() async {
        let store = UserStore()
        await withTaskGroup(of: Void.self) { group in
            for i in 0..<100 {
                group.addTask { await store.add(User(id: "\(i)")) }
                group.addTask { _ = await store.count }
            }
        }
    }
}
```

## Framework Gotchas

| Gotcha                                          | Detail                                    |
| ----------------------------------------------- | ----------------------------------------- |
| Force unwrap (`!`) is the #1 crash cause        | Always use `guard let` or `if let`        |
| Closures capture `self` strongly by default     | Use `[weak self]` in escaping closures    |
| `@State` initializer only runs once             | Don't use `@State` for props from parent  |
| `DispatchQueue.main.async` for UI updates       | Or `@MainActor` in Swift Concurrency      |
| `Codable` fails silently on key mismatch        | Use `CodingKeys` or `keyDecodingStrategy` |
| `Timer` retains its target                      | Must `invalidate()` to break cycle        |
| `struct` is value type, `class` is reference    | Mutations on structs create copies        |
| `async let` vs `await` — parallel vs sequential | `async let` runs concurrently             |
