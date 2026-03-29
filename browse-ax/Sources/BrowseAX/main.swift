import Cocoa

// MARK: - Argument Parsing

struct CLIArgs {
    let pid: pid_t
    let command: String
    let positionalArgs: [String]
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
    var positionalArgs: [String] = []
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
                browse-ax - macOS Accessibility tree reader & controller

                Usage:
                  browse-ax --pid <pid> tree [--depth <N>]
                  browse-ax --pid <pid> action <node-path-json> <action-name>
                  browse-ax --pid <pid> set-value <node-path-json> <value>
                  browse-ax --pid <pid> type <text>
                  browse-ax --pid <pid> press <key>
                  browse-ax --pid <pid> screenshot <path>
                  browse-ax --pid <pid> state

                Options:
                  --pid <pid>     Target application process ID
                  --depth <N>     Maximum tree depth for 'tree' command (default: 30)
                  --help, -h      Show this help

                Commands:
                  tree            Read the accessibility tree as JSON
                  action          Perform an AX action (e.g. AXPress) on an element
                  set-value       Set the value of an editable element
                  type            Type text into the focused element
                  press           Press a named key (Enter, Tab, Escape, etc.)
                  screenshot      Capture the target window as a PNG file
                  state           Lightweight state probe (window, focus, counts)
                """
            print(help)
            exit(0)

        default:
            if command == nil {
                command = args[i]
            } else {
                positionalArgs.append(args[i])
            }
        }
        i += 1
    }

    guard let resolvedPid = pid else {
        printErrorAndExit("--pid is required")
    }

    guard let resolvedCommand = command else {
        printErrorAndExit("Command is required (e.g. 'tree', 'action', 'set-value', 'type', 'press', 'screenshot', 'state')")
    }

    return CLIArgs(pid: resolvedPid, command: resolvedCommand, positionalArgs: positionalArgs, depth: depth)
}

// MARK: - Main

let cliArgs = parseArgs()

let supportedCommands: Set<String> = [
    "tree", "action", "set-value", "type", "press", "screenshot", "state"
]

guard supportedCommands.contains(cliArgs.command) else {
    printErrorAndExit(
        "Unknown command: \(cliArgs.command). Supported: \(supportedCommands.sorted().joined(separator: ", "))"
    )
}

// Validate process exists
let workspace = NSWorkspace.shared
let runningApps = workspace.runningApplications
let targetApp = runningApps.first { $0.processIdentifier == cliArgs.pid }

guard targetApp != nil else {
    printErrorAndExit("No process with PID \(cliArgs.pid)")
}

// Check accessibility permission — prompt the user if not yet granted
let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary
if !AXIsProcessTrustedWithOptions(options) {
    printErrorAndExit(
        "Accessibility permission required. A system dialog should have appeared — grant permission, then retry."
    )
}

// Create the tree reader (shared across all commands)
let reader = TreeReader(pid: cliArgs.pid, maxDepth: cliArgs.depth)

// MARK: - Command Dispatch

switch cliArgs.command {

case "tree":
    let tree = reader.readTree()
    let json = JSONOutput.serialize(node: tree)
    print(json)

case "action":
    guard cliArgs.positionalArgs.count >= 2 else {
        printErrorAndExit("Usage: browse-ax --pid <pid> action <node-path-json> <action-name>")
    }
    let pathJSON = cliArgs.positionalArgs[0]
    let actionName = cliArgs.positionalArgs[1]

    guard let path = ActionHandler.parsePath(pathJSON) else {
        printErrorAndExit("Invalid path JSON: '\(pathJSON)'. Expected format: [0,2,1]")
    }

    let result = ActionHandler.performAction(reader: reader, path: path, actionName: actionName)
    print(result)

case "set-value":
    guard cliArgs.positionalArgs.count >= 2 else {
        printErrorAndExit("Usage: browse-ax --pid <pid> set-value <node-path-json> <value>")
    }
    let pathJSON = cliArgs.positionalArgs[0]
    let value = cliArgs.positionalArgs[1]

    guard let path = ActionHandler.parsePath(pathJSON) else {
        printErrorAndExit("Invalid path JSON: '\(pathJSON)'. Expected format: [0,2,1]")
    }

    let result = ActionHandler.setValue(reader: reader, path: path, value: value)
    print(result)

case "type":
    guard cliArgs.positionalArgs.count >= 1 else {
        printErrorAndExit("Usage: browse-ax --pid <pid> type <text>")
    }
    let text = cliArgs.positionalArgs[0]
    let result = KeyboardHandler.typeText(reader: reader, text: text)
    print(result)

case "press":
    guard cliArgs.positionalArgs.count >= 1 else {
        printErrorAndExit("Usage: browse-ax --pid <pid> press <key>")
    }
    let keyName = cliArgs.positionalArgs[0]
    let result = KeyboardHandler.pressKey(reader: reader, keyName: keyName)
    print(result)

case "screenshot":
    guard cliArgs.positionalArgs.count >= 1 else {
        printErrorAndExit("Usage: browse-ax --pid <pid> screenshot <path>")
    }
    let outputPath = cliArgs.positionalArgs[0]
    let result = ScreenshotHandler.captureWindow(reader: reader, outputPath: outputPath)
    print(result)

case "state":
    let result = StateHandler.probeState(reader: reader)
    print(result)

default:
    printErrorAndExit("Unknown command: \(cliArgs.command)")
}
