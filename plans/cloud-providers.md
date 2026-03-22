# Plan: Cloud Providers (Browserless + Browserbase)

> Generated: 2026-03-22
> Branch: `feat/cloud-providers`
> Mode: EXPANSION

## Overview

Add `provider` command for managing cloud browser API keys (encrypted vault) and `--provider` flag for connecting to Browserless and Browserbase. API keys stored encrypted in `.browse/providers/` — never visible to agents. Reuses existing AuthVault encryption pattern.

## Scope Challenge

Existing infrastructure covers 80%:
- `BROWSE_CDP_URL` + `connectOverCDP()` in `server.ts:494-497` — fully working
- `AuthVault` in `src/auth-vault.ts` — AES-256-GCM encryption, save/load/list/delete pattern
- `resolveEncryptionKey()` in `src/encryption.ts` — auto-generated or env var key
- `sanitizeName()` in `src/sanitize.ts` — path-safe names

What's new:
- `src/cloud-providers.ts` — provider registry with Browserless + Browserbase implementations
- `provider save/list/delete` commands in meta.ts
- `--provider` flag in cli.ts → resolves CDP URL before spawning server

EXPANSION mode: full vault, both providers, management commands, tests, docs.

## Architecture

```
browse --provider browserbase goto https://example.com
      │
      ▼
  src/cli.ts ──── TASK-003 (--provider flag, resolve CDP URL)
      │
      ├── src/cloud-providers.ts ──── TASK-001 (provider registry)
      │     ├── ProviderVault (save/load/list/delete encrypted keys)
      │     ├── browserless: token → wss://chrome.browserless.io?token=X
      │     └── browserbase: apiKey → POST /v1/sessions → wss://connect...
      │
      ▼
  BROWSE_CDP_URL passed to server spawn env
      │
      ▼
  src/server.ts (existing) → connectOverCDP(cdpUrl) → Browser
      │
  src/commands/meta.ts ──── TASK-002 (provider save/list/delete commands)
      │
  test/features.test.ts ──── TASK-004 (tests)
      │
  docs ──────────────────── TASK-005 (SKILL.md, README, CHANGELOG)
```

## Existing Code Leverage

| Sub-problem | Existing Code | Action |
|------------|---------------|--------|
| CDP connection | `src/server.ts:494-497` connectOverCDP | Reuse as-is |
| Encryption | `src/encryption.ts` encrypt/decrypt/resolveEncryptionKey | Reuse as-is |
| Vault pattern | `src/auth-vault.ts` AuthVault class | Study + adapt |
| Path sanitization | `src/sanitize.ts` sanitizeName | Reuse as-is |
| CLI flag parsing | `src/cli.ts` --session/--profile extraction | Reuse pattern |
| Subcommand dispatch | `src/commands/meta.ts` auth/profile/record cases | Reuse pattern |

## Tasks

### TASK-001: Cloud provider registry + vault

Create `src/cloud-providers.ts` with:

**ProviderVault** (reuses encryption from `src/encryption.ts`):
```typescript
import { resolveEncryptionKey, encrypt, decrypt } from './encryption';
import { sanitizeName } from './sanitize';

interface StoredProvider {
  name: string;
  encrypted: true;
  iv: string;
  authTag: string;
  data: string;  // encrypted API key
  createdAt: string;
}

export class ProviderVault {
  private dir: string;
  private key: Buffer;

  constructor(localDir: string) {
    this.dir = path.join(localDir, 'providers');
    this.key = resolveEncryptionKey(localDir);
  }

  save(name: string, apiKey: string): void { ... }
  load(name: string): string { ... }  // returns decrypted API key
  list(): Array<{ name: string; createdAt: string }> { ... }
  delete(name: string): void { ... }
}
```

**Provider implementations:**
```typescript
interface CloudProvider {
  name: string;
  getCdpUrl(apiKey: string): Promise<{ cdpUrl: string; sessionId?: string }>;
  cleanup?(apiKey: string, sessionId: string): Promise<void>;
}

const providers: Record<string, CloudProvider> = {
  browserless: {
    name: 'Browserless',
    async getCdpUrl(token) {
      // Browserless: direct WebSocket, no session creation needed
      // Supports wss://production-sfo.browserless.io for specific regions via BROWSERLESS_URL env
      const baseUrl = process.env.BROWSERLESS_URL || 'wss://production-sfo.browserless.io';
      return { cdpUrl: `${baseUrl}?token=${token}` };
    }
  },
  browserbase: {
    name: 'Browserbase',
    async getCdpUrl(apiKey) {
      // Browserbase: REST API creates session, returns connectUrl with auth baked in
      // Requires BROWSERBASE_PROJECT_ID env var
      const projectId = process.env.BROWSERBASE_PROJECT_ID;
      if (!projectId) throw new Error(
        'Set BROWSERBASE_PROJECT_ID env var. Find it at https://browserbase.com/settings'
      );
      const res = await fetch('https://api.browserbase.com/v1/sessions', {
        method: 'POST',
        headers: { 'x-bb-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Browserbase API error ${res.status}: ${body}`);
      }
      const session = await res.json() as { id: string; connectUrl: string };
      // connectUrl already includes auth: wss://connect.browserbase.com?sessionId=X&apiKey=Y
      return { cdpUrl: session.connectUrl, sessionId: session.id };
    },
    async cleanup(apiKey, sessionId) {
      // Best-effort: close the Browserbase session on server shutdown
      await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}`, {
        method: 'POST',
        headers: { 'x-bb-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'REQUEST_RELEASE' }),
      }).catch(() => {});
    }
  },
};

export function getProvider(name: string): CloudProvider { ... }
export function listProviders(): string[] { return Object.keys(providers); }

export async function resolveProviderCdpUrl(
  providerName: string, localDir: string
): Promise<string> {
  const vault = new ProviderVault(localDir);
  const apiKey = vault.load(providerName);
  const provider = getProvider(providerName);
  return provider.getCdpUrl(apiKey);
}
```

**Files:** `src/cloud-providers.ts` (create)

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] ProviderVault encrypts API keys with AES-256-GCM (same as AuthVault)
- [ ] `save()` writes to `.browse/providers/<name>.json` with mode 0o600
- [ ] `load()` decrypts and returns the API key
- [ ] Browserless returns correct WebSocket URL with token
- [ ] Browserbase calls REST API and returns WebSocket URL with session ID
- [ ] Browserbase `cleanup()` deletes session on server shutdown (best-effort)
- [ ] `resolveProviderCdpUrl()` returns `{ cdpUrl, sessionId?, cleanup? }` so CLI can pass session info to server
- [ ] Missing provider throws clear error with available providers listed

**Agent:** nodejs-cli-senior-engineer

**Priority:** P0

---

### TASK-002: Provider management commands

Add `provider` to `META_COMMANDS` in `src/server.ts`. Implement handler in `src/commands/meta.ts`:

```
browse provider save browserless <api-key>     # encrypt and store
browse provider save browserbase <api-key>     # encrypt and store
browse provider list                           # show saved providers
browse provider delete browserless             # remove
```

Pattern: follow `case 'auth':` handler in meta.ts.

**Files:** `src/commands/meta.ts`, `src/server.ts`

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `provider save browserless <key>` encrypts and saves
- [ ] `provider save` with unknown provider throws error listing valid providers
- [ ] `provider list` shows saved providers without exposing keys
- [ ] `provider delete` removes the encrypted file
- [ ] `provider delete` non-existent throws clear error

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-001
**Priority:** P1

---

### TASK-003: --provider CLI flag

Add `--provider <name>` flag to `src/cli.ts`:

1. Extract `--provider` from args (same pattern as `--session`, `--profile`)
2. Validate mutual exclusion with `--cdp` and `--connect` (can't use both)
3. Before spawning server: call `resolveProviderCdpUrl()` to get the CDP URL
4. Pass as `BROWSE_CDP_URL` env var to the server process

```typescript
if (providerName) {
  const { resolveProviderCdpUrl } = await import('./cloud-providers');
  const cdpUrl = await resolveProviderCdpUrl(providerName, LOCAL_DIR);
  cliFlags.cdpUrl = cdpUrl;
}
```

Also add `--provider` to help text and `findCommandIndex` value-flag list.

**Files:** `src/cli.ts`

**Type:** feature
**Effort:** S

**Acceptance Criteria:**
- [ ] `--provider browserless` resolves CDP URL from vault and passes to server
- [ ] `--provider` + `--cdp` throws mutual exclusion error
- [ ] `--provider` with no saved key throws "Run 'browse provider save browserless <key>' first"
- [ ] Help text documents `--provider <name>`

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-001
**Priority:** P1

---

### TASK-004: Integration tests

Test provider vault save/load/list/delete and URL resolution.

Note: can't test actual Browserless/Browserbase connections (need real API keys). Test the vault encryption and URL construction only.

**Files:** `test/features.test.ts`

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] Test: `provider save` encrypts key, file exists with mode 0o600
- [ ] Test: `provider list` shows saved provider
- [ ] Test: `provider delete` removes file
- [ ] Test: `provider save` unknown provider throws
- [ ] Test: Browserless URL construction returns correct format
- [ ] Test: `--provider` + `--cdp` mutual exclusion
- [ ] All existing tests pass

**Agent:** nodejs-cli-senior-engineer

**Depends on:** TASK-002, TASK-003
**Priority:** P2

---

### TASK-005: Documentation

Update SKILL.md, README, CHANGELOG with provider commands.

**skill/SKILL.md:**
```bash
# Cloud providers (encrypted API keys, never visible to agents)
browse provider save browserbase <api-key>
browse --provider browserbase goto https://example.com
browse provider list
browse provider delete browserbase
```

**README.md:** Add to command reference + Options table

**CHANGELOG.md:** Add version entry

**Files:** `skill/SKILL.md`, `README.md`, `CHANGELOG.md`

**Type:** docs
**Effort:** S

**Acceptance Criteria:**
- [ ] Provider commands documented with all subcommands
- [ ] `--provider` flag in Options table
- [ ] CHANGELOG updated
- [ ] Security note: "API keys encrypted at rest, never in agent-visible output"

**Agent:** general-purpose

**Depends on:** TASK-004
**Priority:** P3

---

## Failure Modes

| Risk | Affected Tasks | Mitigation |
|------|---------------|------------|
| Browserbase API changes | TASK-001 | Use versioned API endpoint (/v1/). Log full error response for debugging. |
| Browserbase requires BROWSERBASE_PROJECT_ID | TASK-001 | Check env var, throw clear error with setup instructions. |
| Browserless token invalid | TASK-003 | Server's connectOverCDP will fail with clear WebSocket error. |
| Provider key not saved | TASK-003 | Throw "Run 'browse provider save <name> <key>' first" with link to docs. |
| Encryption key mismatch (different machine) | TASK-001 | Same behavior as AuthVault — use BROWSE_ENCRYPTION_KEY env var for portability. |
| `--provider` + `--cdp` conflict | TASK-003 | Validate mutual exclusion early, throw clear error. |

## Test Coverage Map

| New Codepath | Covering Task | Test Type |
|-------------|--------------|-----------|
| Vault save/load/delete (encryption) | TASK-004 | integration |
| Provider URL construction | TASK-004 | integration |
| Provider list command | TASK-004 | integration |
| --provider flag + mutual exclusion | TASK-004 | integration |
| Missing provider error | TASK-004 | integration |

## Task Dependencies

```json
{
  "TASK-001": [],
  "TASK-002": ["TASK-001"],
  "TASK-003": ["TASK-001"],
  "TASK-004": ["TASK-002", "TASK-003"],
  "TASK-005": ["TASK-004"]
}
```
