# Plan: MCP Server Mode

> Generated: 2026-03-22
> Branch: `feat/mcp-server`
> Mode: EXPANSION

## Overview

Add `browse --mcp` mode that runs browse as an MCP (Model Context Protocol) server over stdio. This makes browse available to Cursor, Windsurf, Cline, OpenCode, and any MCP-compatible editor — not just agents that can run Bash. Each browse command becomes an MCP tool with typed parameters. The browser lifecycle is managed within the MCP process (no separate HTTP server needed).

## Scope Challenge

No existing MCP code in the codebase. The MCP SDK (`@modelcontextprotocol/sdk` v1.27.1) handles JSON-RPC framing over stdio. Our command handlers (`handleReadCommand`, `handleWriteCommand`, `handleMetaCommand`) all take `(command, args[], bm)` and return `Promise<string>` — the MCP adapter maps tool calls to these handlers. No changes needed to any existing command handler. New code: ~300 lines in `src/mcp.ts` + CLI flag wiring. EXPANSION mode for comprehensive tool definitions and tests.

## Architecture

```
MCP Client (Cursor / Windsurf / Cline)
  │
  │ JSON-RPC over stdio
  ▼
src/mcp.ts (TASK-001, TASK-002)
  │  MCP Server (StdioServerTransport)
  │  ├── tools/list → return tool definitions
  │  └── tools/call → dispatch to command handlers
  │
  ├── handleReadCommand(cmd, args, bm, buffers)    ← existing
  ├── handleWriteCommand(cmd, args, bm, domainFilter)  ← existing
  └── handleMetaCommand(cmd, args, bm, shutdown, ...)   ← existing
        │
        ▼
  BrowserManager → Chromium (headless)

src/cli.ts (TASK-003)
  │  Detect --mcp flag → import('./mcp') instead of HTTP client
  │
dist/browse.cjs (TASK-004)
  │  Built with esbuild, --mcp works in compiled binary

SKILL.md + README (TASK-005)
  │  MCP setup instructions for Cursor/Windsurf/Cline

test/mcp.test.ts (TASK-006)
  │  Tool listing, command dispatch, error handling
```

## Existing Code Leverage

| Sub-problem | Existing Code | Action |
|------------|---------------|--------|
| Command dispatch | `server.ts:308-328` (READ/WRITE/META routing) | Reuse pattern |
| Command handler signatures | `handleReadCommand(cmd, args, bm, buffers)` | Call directly |
| Browser lifecycle | `BrowserManager.launch()` at browser-manager.ts:261 | Reuse |
| Session buffers | `SessionBuffers` class at buffers.ts | Create instance |
| Error rewriting | `rewriteError()` at server.ts:229 | Extract to shared module |
| Command sets | `READ_COMMANDS`, `WRITE_COMMANDS`, `META_COMMANDS` at server.ts:142-173 | Extract to shared module |
| CLI flag extraction | `cli.ts:550-710` | Add --mcp before server check |

## Tasks

### TASK-000: Extract shared code from server.ts

Extract `rewriteError()` function and `READ_COMMANDS`/`WRITE_COMMANDS`/`META_COMMANDS` sets from `src/server.ts` into a new shared module `src/command-registry.ts`. Both `server.ts` and the new `mcp.ts` will import from this module.

**`src/command-registry.ts` exports:**
- `rewriteError(msg: string): string` — AI-friendly error rewriting (move from server.ts:229-263)
- `READ_COMMANDS: Set<string>` — (move from server.ts:142-148)
- `WRITE_COMMANDS: Set<string>` — (move from server.ts:150-160)
- `META_COMMANDS: Set<string>` — (move from server.ts:162-173)

Update `src/server.ts` to import these from `command-registry.ts` instead of defining them inline. Pure refactor — no behavior change.

**Type:** refactor
**Effort:** S

**Acceptance Criteria:**
- [ ] `src/command-registry.ts` exports all 4 items
- [ ] `src/server.ts` imports from `command-registry.ts` — no inline definitions
- [ ] All existing tests pass unchanged (pure refactor)
- [ ] `npm run build` succeeds

**Agent:** general-purpose

**Priority:** P0

---

### TASK-001: Define MCP tool schemas

Create `src/mcp-tools.ts` with tool definitions for all browse commands. Each tool has a name, description, and JSON Schema for its parameters.

Group tools by category to keep the tool list scannable:
- Navigation: `browse_goto`, `browse_back`, `browse_forward`, `browse_reload`, `browse_url`
- Content: `browse_text`, `browse_html`, `browse_links`, `browse_forms`, `browse_accessibility`
- Snapshot: `browse_snapshot` (with flags as params: interactive, compact, cursor, depth, selector, viewport, full)
- Interaction: `browse_click`, `browse_fill`, `browse_select`, `browse_hover`, etc.
- And so on for all ~80 commands

Design decision: use **one tool per command** (not one mega-tool). MCP clients show each tool separately — agents can see exactly what's available.

**Tool descriptions MUST be actionable, not generic.** Every description should tell the agent:
- What the tool does (action)
- When to use it (context)
- What it returns (output)

Bad: `"Navigate to a URL"` — too vague
Good: `"Navigate to a URL and wait for the page to load. Returns the HTTP status code. Always call browse_wait_network_idle after this for dynamic pages."`

Examples of proper descriptions:

```typescript
{
  name: "browse_goto",
  description: "Navigate to a URL. Returns HTTP status code. For dynamic/SPA pages, call browse_wait with network_idle after this to ensure content is fully loaded.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Full URL including protocol (e.g. https://example.com)" }
    },
    required: ["url"]
  }
}

{
  name: "browse_snapshot",
  description: "Get the page's accessibility tree with element refs (@e1, @e2...). Use these refs as selectors in click, fill, hover, and other interaction tools. Use interactive=true for a compact list of only clickable/fillable elements (recommended). Re-run after navigation — refs are invalidated on page change.",
  inputSchema: {
    type: "object",
    properties: {
      interactive: { type: "boolean", description: "Only show interactive elements (buttons, links, inputs) — terse flat list, minimal tokens" },
      compact: { type: "boolean", description: "Remove empty structural elements from the tree" },
      cursor: { type: "boolean", description: "Include cursor-interactive elements (divs with onclick, cursor:pointer) that ARIA misses" },
      depth: { type: "number", description: "Limit tree depth to N levels" },
      selector: { type: "string", description: "Scope snapshot to elements matching this CSS selector" },
      viewport: { type: "boolean", description: "Only include elements visible in the current viewport" },
      full: { type: "boolean", description: "Full indented tree with props and children (verbose, use with interactive)" }
    }
  }
}

{
  name: "browse_click",
  description: "Click an element. Use @ref from a previous snapshot (e.g. @e3) or a CSS selector. After clicking, the page may navigate or update — re-run browse_snapshot if you need to interact with new elements.",
  inputSchema: {
    type: "object",
    properties: {
      selector: { type: "string", description: "CSS selector (e.g. button.submit) or @ref from snapshot (e.g. @e3). Use [id=foo] instead of #foo." }
    },
    required: ["selector"]
  }
}

{
  name: "browse_text",
  description: "Get the visible text content of the current page. Returns clean text without scripts, styles, or hidden elements. Use this to read page content after navigation.",
  inputSchema: { type: "object", properties: {} }
}

{
  name: "browse_fill",
  description: "Clear an input field and type new text into it. Use @ref from snapshot or CSS selector. For password fields, the value is sent to the browser but never logged.",
  inputSchema: {
    type: "object",
    properties: {
      selector: { type: "string", description: "CSS selector or @ref (e.g. @e4)" },
      value: { type: "string", description: "Text to fill into the input" }
    },
    required: ["selector", "value"]
  }
}

{
  name: "browse_screenshot",
  description: "Take a screenshot of the current viewport. Returns the file path. To view the screenshot, use your file reading tool on the returned path. For full-page screenshots, set full=true.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Output file path (default: .browse/sessions/default/screenshot.png)" },
      full: { type: "boolean", description: "Capture entire scrollable page, not just viewport" },
      selector: { type: "string", description: "Screenshot only this element (@ref or CSS selector)" },
      clip: { type: "string", description: "Clip region as x,y,width,height (e.g. 0,0,400,300)" }
    }
  }
}

{
  name: "browse_wait",
  description: "Wait for a condition before proceeding. Use after navigation or actions that trigger page changes. Supports waiting for: elements to appear/disappear, text content, URL patterns, network idle, JavaScript conditions, or a fixed time.",
  inputSchema: {
    type: "object",
    properties: {
      selector: { type: "string", description: "CSS selector or @ref to wait for" },
      state: { type: "string", enum: ["visible", "hidden"], description: "Wait for element to appear (visible) or disappear (hidden)" },
      text: { type: "string", description: "Wait for this text to appear in the page body" },
      fn: { type: "string", description: "JavaScript expression to evaluate — waits until it returns truthy" },
      url: { type: "string", description: "URL pattern to wait for (glob supported, e.g. **/dashboard)" },
      network_idle: { type: "boolean", description: "Wait for no network requests for 500ms" },
      load: { type: "string", enum: ["load", "domcontentloaded", "networkidle"], description: "Wait for page load state" },
      ms: { type: "number", description: "Wait for a fixed number of milliseconds" }
    }
  }
}
```

Apply this standard to ALL tools. Each description should be 1-2 sentences that help the agent decide whether to use this tool and what to expect. Parameter descriptions should include examples and gotchas (like "use [id=foo] instead of #foo").

Export: `getToolDefinitions(): Tool[]` and `mapToolCallToCommand(name, params): { command: string, args: string[] }`.

**Type:** feature
**Effort:** L

**Acceptance Criteria:**
- [ ] Every command in READ_COMMANDS, WRITE_COMMANDS, META_COMMANDS has a corresponding MCP tool
- [ ] Every tool description explains what it does, when to use it, and what it returns (not just "runs X command")
- [ ] Every parameter description includes an example value or format
- [ ] `mapToolCallToCommand("browse_snapshot", { interactive: true, depth: 3 })` returns `{ command: "snapshot", args: ["-i", "-d", "3"] }`
- [ ] Tools with required params (e.g. browse_goto needs url) have `required` in schema
- [ ] Invalid tool name in mapToolCallToCommand throws clear error

**Agent:** general-purpose

**Priority:** P0

---

### TASK-002: Create MCP server module

Create `src/mcp.ts` — the MCP server entry point. Uses `@modelcontextprotocol/sdk` for JSON-RPC framing over stdio.

**Dependencies:** Install `@modelcontextprotocol/sdk` as a dependency in package.json.

**Main export:** `async function startMcpServer(): Promise<void>`

Flow:
1. Create `Server` from MCP SDK with server info `{ name: "browse", version: pkg.version }`
2. Launch `BrowserManager` (same as server.ts does for single-session mode)
3. Create `SessionBuffers` instance
4. Register `tools/list` handler → return `getToolDefinitions()` from TASK-001
5. Register `tools/call` handler:
   - Extract tool name and params
   - Call `mapToolCallToCommand(name, params)` → `{ command, args }`
   - Route to `handleReadCommand`/`handleWriteCommand`/`handleMetaCommand` (same routing as server.ts:308-328)
   - Default: return **plain text** as MCP content: `{ content: [{ type: "text", text: result }] }`
   - If `--json` flag was passed alongside `--mcp`: wrap in `{success, data, command}` JSON: `{ content: [{ type: "text", text: JSON.stringify({success: true, data: result, command}) }] }`
   - On error: `{ content: [{ type: "text", text: friendlyError }], isError: true }` (or JSON-wrapped if `--json`)
   - The user chooses the format at MCP config time: `browse --mcp` (plain text) or `browse --mcp --json` (structured JSON)
6. Connect via `StdioServerTransport` (reads stdin, writes stdout)
7. Handle SIGINT/SIGTERM → close browser, exit cleanly

Error handling: wrap every tool call in try/catch. Use `rewriteError()` from server.ts for AI-friendly error messages. Never crash the MCP server on a command error — return the error as content.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] `startMcpServer()` launches browser and connects to stdio
- [ ] `tools/list` returns all tool definitions
- [ ] `tools/call` for `browse_goto` returns plain text result by default ("Navigated to ...")
- [ ] `tools/call` with `--json` flag returns `{success, data, command}` wrapped result
- [ ] `tools/call` with invalid tool name returns error with `isError: true`
- [ ] `tools/call` for `browse_text` returns page text as content
- [ ] SIGINT closes browser cleanly

**Agent:** general-purpose

**Depends on:** TASK-001
**Priority:** P1

---

### TASK-003: Wire --mcp flag in CLI

Modify `src/cli.ts` to detect `--mcp` flag and start MCP server instead of HTTP client mode.

Add early detection (before `main()` processes commands):
```typescript
// In the entry point section (line ~833)
if (process.argv.includes('--mcp')) {
  import('./mcp').then(m => m.startMcpServer());
} else if (process.env.__BROWSE_SERVER_MODE === '1') {
  import('./server');
} else {
  main().catch(...)
}
```

Also add `--mcp` to the help text and CLI flags section.

Do NOT add `--mcp` to the flag extraction logic — it's not passed to the server. It's detected before any other processing.

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse --mcp` starts MCP server (reads from stdin, writes to stdout)
- [ ] `browse --mcp` does NOT start the HTTP server
- [ ] `browse --help` shows `--mcp` in options
- [ ] `node dist/browse.cjs --mcp` works in compiled binary

**Agent:** general-purpose

**Depends on:** TASK-002
**Priority:** P1

---

### TASK-004: Add MCP SDK dependency and build integration

- `npm install @modelcontextprotocol/sdk` — add to dependencies in package.json
- Update esbuild build command in package.json to add `--external @modelcontextprotocol/sdk` (it's a runtime dependency, not bundled — users install it alongside browse)
- OR: bundle it (better for compiled binary). Test both approaches — if the SDK is small enough, bundle it. If it pulls in heavy deps, externalize.
- Verify `npm run build` succeeds with the new dependency
- Verify `node dist/browse.cjs --mcp` works (the built binary can import the SDK)

**Type:** infra
**Effort:** S

**Acceptance Criteria:**
- [ ] `npm run build` succeeds with MCP SDK
- [ ] `node dist/browse.cjs --mcp` starts without import errors
- [ ] Package size doesn't increase by more than 500KB (SDK is lightweight)
- [ ] Existing `browse goto` commands still work (no regression from new dep)

**Agent:** general-purpose

**Priority:** P0

---

### TASK-005: Documentation — SKILL.md, README, and MCP config examples

Update:

**README.md** — add MCP section:
```markdown
## MCP Server Mode

Use browse as an MCP server for Cursor, Windsurf, Cline, and other MCP-compatible editors:

### Cursor
Add to `.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "browse": {
      "command": "browse",
      "args": ["--mcp"]
    }
  }
}
```

### Claude Desktop
Add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "browse": {
      "command": "browse",
      "args": ["--mcp"]
    }
  }
}
```
```

**skill/SKILL.md** — add MCP note in CLI flags table:
```
| `--mcp` | Run as MCP server (for Cursor, Windsurf, Cline) |
```

**skill/references/commands.md** — add MCP section with config examples.

**features-comparison.md** — update MCP server mode row from `—` to `YES`.

**Type:** docs
**Effort:** S

**Acceptance Criteria:**
- [ ] README has MCP section with Cursor and Claude Desktop config examples
- [ ] SKILL.md CLI flags table includes `--mcp`
- [ ] features-comparison.md shows YES for MCP server mode

**Agent:** general-purpose

**Depends on:** TASK-003
**Priority:** P2

---

### TASK-006: Integration tests for MCP server

Create `test/mcp.test.ts` with tests that spawn the MCP server as a child process, send JSON-RPC messages via stdin, and verify responses on stdout.

Use the MCP SDK's `Client` + `StdioClientTransport` to talk to the server in tests (spawn `tsx src/mcp-entry.ts` or `node dist/browse.cjs --mcp` as child process).

Tests:
1. **tools/list** — verify returns array of tools, each has name starting with `browse_`, has inputSchema
2. **tool count** — verify tool count matches READ + WRITE + META command count
3. **browse_goto** — call with URL, verify returns navigation result
4. **browse_text** — after goto, call browse_text, verify returns page content
5. **browse_snapshot** — call with `{ interactive: true }`, verify returns refs
6. **browse_click** — after snapshot, click a ref, verify success
7. **invalid tool** — call nonexistent tool, verify error response (not crash)
8. **missing required param** — call browse_goto without url, verify error
9. **browse_screenshot** — call and verify returns file path
10. **server shutdown** — send SIGTERM, verify clean exit (no orphan Chromium)

Use a local test server (same `test/test-server.ts` fixture server) for navigation targets.

**Type:** test
**Effort:** L

**Acceptance Criteria:**
- [ ] All MCP protocol tests pass (tool listing, command execution, error handling)
- [ ] Tool count matches registered command count
- [ ] No orphan Chromium processes after tests
- [ ] Tests work with both `tsx` (dev) and compiled binary

**Agent:** general-purpose

**Depends on:** TASK-002, TASK-003, TASK-004
**Priority:** P2

---

### TASK-007: Snapshot tool returns structured refs

For the `browse_snapshot` MCP tool specifically, return structured data instead of plain text. MCP supports returning JSON content, which lets agents parse refs programmatically instead of regex-parsing text.

When called via MCP, `browse_snapshot` returns:
```json
{
  "content": [
    { "type": "text", "text": "@e1 [button] \"Submit\"\n@e2 [link] \"Home\"" },
    {
      "type": "resource",
      "resource": {
        "uri": "browse://refs",
        "mimeType": "application/json",
        "text": "{\"@e1\":{\"role\":\"button\",\"name\":\"Submit\"},\"@e2\":{\"role\":\"link\",\"name\":\"Home\"}}"
      }
    }
  ]
}
```

The text content is the same human-readable output. The resource is a structured JSON that agents can parse without regex. Both are returned — agents use whichever format suits them.

This requires modifying `src/mcp.ts` to detect `snapshot` commands and enhance the response with the ref map from BrowserManager.

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `browse_snapshot` via MCP returns both text content and structured ref resource
- [ ] Structured refs contain role and name for each ref
- [ ] Other commands still return plain text content only
- [ ] Non-MCP mode (CLI) is unaffected

**Agent:** general-purpose

**Depends on:** TASK-002
**Priority:** P2

---

## Failure Modes

| Risk | Affected Tasks | Mitigation |
|------|---------------|------------|
| MCP SDK too large for bundling | TASK-004 | Externalize with `--external`. Users install SDK alongside browse. Document in README. |
| stdio conflicts with server mode | TASK-002, TASK-003 | MCP mode is exclusive — `--mcp` skips HTTP server entirely. No conflict. |
| Tool count explosion (80+ tools overwhelms MCP client) | TASK-001 | Group related commands (e.g., all wait variants as params on one `browse_wait` tool). Target ~40 tools. |
| MCP client doesn't support `resource` content type | TASK-007 | Text content is always returned as primary. Resource is supplemental — clients that don't support it just ignore it. |
| Browser crash in MCP mode | TASK-002 | Catch disconnect event, return error to pending tool calls, attempt restart on next call. |
| `__BROWSE_SERVER_MODE` env var conflict | TASK-003 | `--mcp` is checked BEFORE `__BROWSE_SERVER_MODE`. No conflict. |
| Tests hang waiting for MCP server to start | TASK-006 | Use ready signal (first `tools/list` response) as startup confirmation. 10s timeout. |

## Test Coverage Map

| New Codepath | Covering Task | Test Type |
|-------------|--------------|-----------|
| command-registry.ts extraction | TASK-000 (existing tests) | regression |
| MCP tool definitions (schema generation) | TASK-006 | integration |
| MCP tool call → command dispatch | TASK-006 | integration |
| MCP error handling (invalid tool, missing params) | TASK-006 | integration |
| MCP server lifecycle (start, shutdown) | TASK-006 | integration |
| Snapshot structured refs via MCP | TASK-007 (manual) | manual |
| CLI --mcp flag detection | TASK-006 | integration |
| Build with MCP SDK | TASK-004 | build verification |

## Task Dependencies

```json
{
  "TASK-000": [],
  "TASK-001": ["TASK-000"],
  "TASK-002": ["TASK-001"],
  "TASK-003": ["TASK-002"],
  "TASK-004": [],
  "TASK-005": ["TASK-003"],
  "TASK-006": ["TASK-002", "TASK-003", "TASK-004"],
  "TASK-007": ["TASK-002"]
}
```
