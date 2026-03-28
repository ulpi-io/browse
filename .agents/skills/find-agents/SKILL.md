---
name: find-agents
description: Find, install, and manage AI agents across 43+ coding IDEs. Search the agentshq registry, install agents from GitHub repos or URLs, list/remove/update installed agents. Invoke via /find-agents or when user says "find an agent", "install agent", "search agents", "list agents", "remove agent", "update agents".
---

# Find Agents

Full CLI wrapper for [agentshq](https://agentshq.sh) -- the package manager for AI coding agents.

## When to Use

Activate this skill when the user:

- Wants to find or search for agents ("find me a React agent", "search for testing agents")
- Wants to install agents ("install the laravel expert agent", "add agents from owner/repo")
- Wants to manage agents ("list my agents", "remove web-design", "update all agents", "check for updates")
- Mentions agentshq, agent definitions, or AGENT.md files
- Asks what agents are available or installed

## Prerequisites

The `agentshq` CLI must be available. If it's not installed globally, use `npx agentshq` to run commands on-the-fly (no install needed).

Check availability:

```bash
npx agentshq --version
```

## Commands Reference

### Search for agents

```bash
# Interactive search (opens fzf-style picker)
npx agentshq find

# Search by keyword
npx agentshq find <query>
```

When the user asks to find agents, run the search and present results. If they pick one, install it.

### Install agents

```bash
# From a GitHub repo (discovers all agents in the repo)
npx agentshq add <owner>/<repo>

# Install a specific agent from a repo
npx agentshq add <owner>/<repo>@<agent-name>

# From any git URL
npx agentshq add https://github.com/owner/repo

# From a local directory
npx agentshq add ./path/to/agents

# Install globally (user-level, available in all projects)
npx agentshq add <source> -g

# Install to specific IDEs
npx agentshq add <source> --ide claude-code cursor windsurf

# Install all agents to all IDEs without prompts
npx agentshq add <source> --all

# List available agents in a repo without installing
npx agentshq add <source> --list
```

### List installed agents

```bash
# List project-level agents
npx agentshq list

# List global agents
npx agentshq list -g

# Filter by IDE
npx agentshq list --ide claude-code

# Machine-readable output
npx agentshq list --json
```

### Remove agents

```bash
# Interactive removal (shows picker)
npx agentshq remove

# Remove specific agent
npx agentshq remove <agent-name>

# Remove from global scope
npx agentshq remove <agent-name> -g

# Remove all agents
npx agentshq remove --all
```

### Check for updates

```bash
# Check which agents have updates available
npx agentshq check

# Update all agents to latest versions
npx agentshq update
```

### Create a new agent

```bash
# Scaffold a new AGENT.md
npx agentshq init <name>

# Create in current directory
npx agentshq init
```

## Behavior Guidelines

### When searching for agents

1. Run `npx agentshq find <query>` with the user's keywords
2. Present the results clearly -- name, description, source
3. Ask which agent(s) to install
4. Run the install command with appropriate flags

### When installing agents

1. Run `npx agentshq add <source>` with the appropriate source
2. If the user doesn't specify IDEs, the CLI will auto-detect installed IDEs and prompt
3. For non-interactive installs (CI, scripts), suggest `-y` or `--all` flags
4. After install, confirm what was installed and where

### When the user is unsure what they need

1. Ask what kind of task they're working on (React, Laravel, testing, DevOps, etc.)
2. Search with relevant keywords: `npx agentshq find <keyword>`
3. Recommend agents based on the results
4. Offer to install their picks

### Private repos

The CLI works with private repos using the same syntax. Privacy is automatic -- no telemetry or audit data is sent for private repos. The user just needs git access (SSH keys or `GITHUB_TOKEN`).

### Error handling

- If `npx agentshq` fails, check if Node.js >= 18 is available
- If a git clone fails, check network connectivity and repo access
- If no agents are found in a repo, suggest checking the repo has AGENT.md files
- If IDE detection finds nothing, suggest `--ide <name>` to specify manually

## Supported IDEs

The CLI supports 43+ IDEs. The most common ones:

| IDE | Format |
|-----|--------|
| Claude Code | `.md` with YAML frontmatter |
| Cursor | `AGENTS.md` sections |
| GitHub Copilot | `.agent.md` |
| Windsurf | `AGENTS.md` sections |
| Codex | `AGENTS.md` sections |
| Gemini CLI | `.md` with YAML frontmatter |
| Kiro | `.json` |
| Amp | `AGENTS.md` sections |
| Roo Code | `AGENTS.md` sections |

Agents are automatically translated to each IDE's native format on install.
