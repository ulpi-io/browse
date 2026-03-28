---
name: secrets
version: 0.1.1
description: Credential management for AI coding agents — encrypted vault, CLI injection, MCP shim
---

# Secrets CLI

Manage credentials for AI coding agents. Stores secrets in an encrypted local vault and injects them transparently into CLI tools and MCP servers.

## When to use

- User asks about API keys, tokens, credentials, or authentication
- User wants to connect MCP servers that need credentials
- User asks how to securely manage secrets for AI tools

## Commands

| Command | Description |
|---------|-------------|
| `secrets add <service>` | Store credentials (interactive prompt — never pass tokens as CLI arguments) |
| `secrets remove <service>` | Remove stored credentials |
| `secrets list` | List stored services (no values shown) |
| `secrets show <service>` | Show masked credentials (do not use `--reveal` — secret values must never appear in agent output) |
| `secrets rotate <service>` | Update credential values |
| `secrets enable <service>` | Enable MCP server in .mcp.json |
| `secrets disable <service>` | Remove MCP server from .mcp.json |
| `secrets init` | Auto-detect agents, write hooks + MCP entries |
| `secrets status` | Overview of vault, hooks, agents |
| `secrets mcp <service>` | Run MCP server with credential injection |
| `secrets registry list` | List available service definitions |

## Common workflows

### Add GitHub credentials and enable MCP
```bash
secrets add github    # interactive prompt — never pass tokens as CLI arguments
secrets enable github
```

### Initialize for a project
```bash
secrets init
```

### Check what's configured
```bash
secrets status
```

## Safety rules

- **Never pass secret values as CLI arguments** — use `secrets add <service>` interactively so tokens don't appear in shell history or agent output
- **Never use `--reveal`** — secret values must never appear in agent context or conversation output
- **Never echo, log, or include secret values in responses** — only reference services by name

## Built-in services

github, anthropic, openai, aws, slack, jira, google-cloud, vercel, stripe, linear
