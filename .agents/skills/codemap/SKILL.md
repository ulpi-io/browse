---
name: codemap
version: 1.0.1
description: |
  Hybrid vector+BM25 code search, symbol lookup, dependency analysis, PageRank importance scoring,
  coupling metrics, and circular dependency detection via the codemap CLI. Use when the user asks to
  search code, find symbols, analyze dependencies, find dependents, check coupling, view PageRank
  importance, detect circular dependencies, index a project, get file summaries, or explore
  architecture health. Wraps the @ulpi/codemap CLI (not MCP tools).
---

<EXTREMELY-IMPORTANT>
Before running ANY codemap command, you **ABSOLUTELY MUST**:

1. Run `codemap status` to check if the project is indexed
2. If not indexed, run `codemap init` + `codemap index`
3. Complete the MANDATORY FIRST RESPONSE PROTOCOL below

**Running codemap commands without an index = errors and empty results**
</EXTREMELY-IMPORTANT>

# codemap: Code Search & Architecture Analysis

## MANDATORY FIRST RESPONSE PROTOCOL

Before running ANY codemap command, complete this checklist:

### Step 1: Verify installation

```bash
codemap --version
```

If not installed, tell the user:

> `codemap` CLI is not installed. Install it with:
>
> ```bash
> npm install -g @ulpi/codemap
> ```

**Do NOT install anything automatically.** Wait for the user to confirm they have installed it before proceeding.

### Step 2: Check index status

```bash
codemap status
```

**If no index exists:**
```bash
codemap init
codemap index
```

### Step 3: Permissions (optional)

To avoid being prompted on every codemap command, tell the user they can add codemap permissions to `.claude/settings.local.json` under `permissions.allow`:

```json
"Bash(codemap:*)",
"Bash(codemap search:*)", "Bash(codemap symbols:*)",
"Bash(codemap index:*)", "Bash(codemap status:*)",
"Bash(codemap deps:*)", "Bash(codemap dependents:*)",
"Bash(codemap rank:*)", "Bash(codemap cycles:*)",
"Bash(codemap summary:*)", "Bash(codemap coupling:*)",
"Bash(codemap graph-stats:*)", "Bash(codemap config:*)",
"Bash(codemap init:*)", "Bash(codemap ignore:*)",
"Bash(codemap watch:*)", "Bash(codemap rebuild-depgraph:*)",
"Bash(codemap read:*)", "Bash(codemap serve:*)",
"Bash(codemap statusline:*)", "Bash(codemap update:*)"
```

**Do NOT modify settings files automatically.** Show the user the permissions and let them decide whether to add them.

## MCP Server (alternative to CLI)

Codemap can also run as an MCP server, giving AI agents direct tool access without Bash:

```bash
claude mcp add codemap codemap serve
```

This exposes tools like `mcp__codemap__search_code`, `mcp__codemap__search_symbols`, `mcp__codemap__get_file_summary`, `mcp__codemap__get_dependencies`, etc.

**CLI vs MCP:** The CLI skill (this file) uses Bash commands. MCP gives agents native tool calls. Both work — use whichever your agent setup prefers. The CLI skill works across all agents; MCP requires agent-specific configuration.

## Command Reference

| Command | What It Does | Key Flags |
|---------|-------------|-----------|
| `codemap search <query>` | Hybrid vector+BM25 code search | `-l N`, `--json` |
| `codemap symbols <query>` | Find functions, classes, types by name | `-l N`, `--json` |
| `codemap index` | Index project for search | `--full` |
| `codemap status` | Show index stats | `--json` |
| `codemap deps <file>` | Outgoing imports (what this file uses) | `--json` |
| `codemap dependents <file>` | Incoming imports (what uses this file) | `--json` |
| `codemap rank [file]` | PageRank importance scores | `-l N`, `--json` |
| `codemap cycles` | Detect circular dependencies | `--json` |
| `codemap summary <file>` | File overview with symbols and size | `--json` |
| `codemap coupling` | Afferent/efferent coupling & instability | `--module <path>`, `-l N`, `--json` |
| `codemap graph-stats` | Aggregate dependency graph statistics | `--json` |
| `codemap config list/get/set` | Manage configuration | |
| `codemap init` | First-time setup | `--provider`, `--force` |
| `codemap ignore` | Generate .codemapignore | `--force` |
| `codemap watch` | Live index updates on file change | `--debounce <ms>` |
| `codemap rebuild-depgraph` | Rebuild dep graph from scratch | `--json` |
| `codemap read <file>` | Read full source of a file (or line range) | `--start`, `--end` |
| `codemap serve` | Start MCP server over stdio | |
| `codemap statusline` | Install CodeMap status into Claude Code statusline | |
| `codemap update` | Update codemap to latest version | |

## When to Use Which Command

| What You Want | Command |
|---------------|---------|
| Find code that does X | `codemap search "X"` |
| Find function/class named X | `codemap symbols "X"` |
| What does this file depend on? | `codemap deps <file>` |
| What depends on this file? | `codemap dependents <file>` |
| Most important files in the project | `codemap rank` |
| Circular dependencies? | `codemap cycles` |
| Overview of a file | `codemap summary <file>` |
| Architecture health / coupling | `codemap coupling` |
| Project stats | `codemap graph-stats` |

## Common Workflows

### Understand a new codebase

```bash
codemap status              # Check index health
codemap graph-stats         # High-level architecture stats
codemap rank -l 10          # Top 10 most important files
codemap summary <top-file>  # Deep dive into each key file
```

### Impact analysis before refactoring

```bash
codemap dependents <file>           # What depends on this file?
codemap deps <file>                 # What does this file depend on?
codemap coupling --module <dir>     # Coupling metrics for the module
```

### Find and fix circular dependencies

```bash
codemap cycles                # Detect all cycles
codemap deps <file-in-cycle>  # Understand each file's imports
# Refactor to break the cycle
```

### Search for implementation patterns

```bash
codemap search "error handling"     # Find code by concept
codemap symbols "handleError"       # Find by exact name
```

## Failure Modes

### Index not built
**Symptom:** `codemap search` returns an error or no results
**Fix:** Run `codemap init` + `codemap index`

### Stale index
**Symptom:** Recently added files or symbols don't appear in results
**Fix:** Run `codemap index` to re-index (or `codemap index --full` for a complete rebuild)

### File not found
**Symptom:** `codemap deps <file>` or `codemap summary <file>` returns an error
**Fix:** Verify the file path is relative to the project root and the file exists

## Integration with Other Skills

- **`start`** — Check index status during session init; prompt indexing if stale
- **`find-bugs`** — Use `codemap rank` and `codemap coupling` to prioritize which files to audit
- **`plan-to-task-list-with-dag`** — Use `codemap dependents` for impact analysis when decomposing tasks
- **`code-simplify`** — Use `codemap cycles` to find circular deps worth refactoring
