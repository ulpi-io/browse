import Foundation

// MARK: - Argument Parsing

struct CLIArgs {
    let pid: pid_t
    let command: String
    let depth: Int
}

func printErrorAndExit(_ message: String) -> Never {
    let json = JSONOutput.errorJSON(message)
    FileHandle.standardError.write(Data((json + "\n").utf8))
    exit(1)
}

func parseArgs() -> CLIArgs {
    let args = CommandLine.arguments
    var pid: pid_t?
    var command: String?
    var depth: Int = 30
    var i = 1

    while i < args.count {
        switch args[i] {
        case "--pid":
            i += 1
            guard i < args.count else {
                printErrorAndExit("--pid requires a value")
            }
            guard let parsed = Int32(args[i]), parsed > 0 else {
                printErrorAndExit("PID must be a positive integer")
            }
            pid = parsed

        case "--depth":
            i += 1
            guard i < args.count else {
                printErrorAndExit("--depth requires a value")
            }
            guard let parsed = Int(args[i]), parsed > 0 else {
                printErrorAndExit("--depth must be a positive integer")
            }
            depth = parsed

        case "--help", "-h":
            let help = """
                browse-ax - macOS Accessibility tree reader

                Usage:
                  browse-ax --pid <pid> tree [--depth <N>]

                Options:
                  --pid <pid>     Target application process ID
                  --depth <N>     Maximum tree depth (default: 30)
                  --help, -h      Show this help
                """
            print(help)
            exit(0)

        default:
            if command == nil {
                command = args[i]
            } else {
                printErrorAndExit("Unknown argument: \(args[i])")
            }
        }
        i += 1
    }

    guard let resolvedPid = pid else {
        printErrorAndExit("--pid is required")
    }

    guard let resolvedCommand = command else {
        printErrorAndExit("Command is required (e.g. 'tree')")
    }

    return CLIArgs(pid: resolvedPid, command: resolvedCommand, depth: depth)
}

// MARK: - Main

let cliArgs = parseArgs()

guard cliArgs.command == "tree" else {
    printErrorAndExit("Unknown command: \(cliArgs.command). Supported: tree")
}

// Validate process exists
let workspace = NSWorkspace.shared
let runningApps = workspace.runningApplications
let targetApp = runningApps.first { $0.processIdentifier == cliArgs.pid }

guard targetApp != nil else {
    printErrorAndExit("No process with PID \(cliArgs.pid)")
}

// Check accessibility permission
guard AXIsProcessTrusted() else {
    printErrorAndExit(
        "Grant Accessibility permission in System Settings > Privacy & Security > Accessibility"
    )
}

// Read the tree
let reader = TreeReader(pid: cliArgs.pid, maxDepth: cliArgs.depth)
let tree = reader.readTree()

// Output JSON to stdout
let json = JSONOutput.serialize(node: tree)
print(json)
