# Plan: Phase 9 — Container Isolation Per Session

> Generated: 2026-04-13
> Branch: `feat/container-isolation`
> Mode: EXPANSION
> Review: claude
> Linked plans: phase8-cloud-api-layer, phase10-microvm-snapshot-restore

## Overview

Replace the single-process multi-session model with per-session container isolation. Each cloud session gets its own Docker container running the browse server, providing OS-level isolation between tenants. The cloud gateway (Phase 8) becomes an orchestrator that provisions, routes to, and manages containers via Docker Engine API. Warm container pools minimize cold start latency. Container resource limits (CPU, memory, network) enforce fair usage. Phase 9 of 10 in the browse roadmap.

## Scope Challenge

Phase 8's cloud server runs all sessions in one Node.js process sharing one Chromium instance via SessionManager. This works for trusted single-tenant use but lacks isolation for multi-tenant: a Chromium crash in one session kills all sessions, memory leaks affect neighbors, and browser-level exploits could escape the BrowserContext sandbox. Container isolation solves all three by giving each session its own Chromium process in its own container. The key architectural change: the gateway no longer calls SessionManager.getOrCreate() directly — it provisions a container, then proxies HTTP commands to the container's internal browse server.

## Prerequisites

- Phase 8 cloud API gateway exists with auth, session provisioning, and WebSocket streaming (prerequisite)
- Docker Engine API accessible on the host (external: Docker Desktop or Docker CE)
- Browse server can run inside a container with Chromium (external: Playwright Docker images exist)
- Node.js http module can proxy requests to container-internal servers (already-true)

## Non-Goals

- MicroVM isolation (Phase 10)
- Kubernetes orchestration (Docker-only for now)
- Geographic distribution / multi-region
- Custom Chromium builds per container
- GPU passthrough for WebGL-heavy sites
- Container image caching / registry management
- Live migration of containers between hosts

## Contracts

| Boundary | Producer | Consumer | Shape / API | Consistency / Recovery Rule |
|----------|----------|----------|-------------|------------------------------|
| Gateway → Container Orchestrator | `src/cloud/orchestrator.ts` | `src/cloud/server.ts` | `ContainerOrchestrator { provision, terminate, freeze, resume, list }` | Orchestrator owns container lifecycle. Gateway never talks to Docker directly. |
| Orchestrator → Docker Engine API | `src/cloud/docker.ts` | `src/cloud/orchestrator.ts` | `DockerClient { create, start, stop, remove, inspect, listByLabel, commit }` | All containers labeled with browse-cloud metadata for orphan detection |
| Gateway → Container (proxy) | `src/cloud/proxy.ts` | Container-internal browse server | HTTP proxy: forward POST /command with auth token | Each container has its own internal auth token stored at provision time |
| Warm Pool → Orchestrator | `src/cloud/warm-pool.ts` | `src/cloud/orchestrator.ts` | `WarmPool { claim, replenish, size, drain }` | Pool maintains N pre-started containers (default 5). claim() returns in <100ms. |

## Architecture

```
Cloud API Gateway (Phase 8)
    │
    ├── BROWSE_CLOUD_ISOLATION=container
    │
    ▼
ContainerOrchestrator                    TASK-003
    │
    ├── provision() ──► WarmPool         TASK-004
    │     │               │
    │     │  claim() ◄────┘ (pre-started container)
    │     │  OR
    │     └─ DockerClient.create()       TASK-002
    │          │
    │          ▼
    │     Docker Engine API
    │          │
    │          ▼
    │     browse-session container        TASK-001
    │     ┌─────────────────────────┐
    │     │ Alpine + Chromium        │
    │     │ browse server :9400     │
    │     │ (single session)        │
    │     └─────────────────────────┘
    │
    ├── executeCommand() ──► proxy.ts ──► container :9400/command
    │
    ├── freeze() ──► docker commit ──► snapshot image     TASK-005
    │
    ├── resume() ──► docker create from snapshot ──► start
    │
    └── reaper ──► scan orphaned containers ──► remove    TASK-005
```

## Existing Code Leverage

| Sub-problem | Existing Code | Action |
|------------|---------------|--------|
| Browse server inside container | `src/server.ts` | Reuse as-is |
| Session state freeze/resume | `src/session/persist.ts` (Phase 8 extensions) | Reuse |
| Cloud auth and tenant isolation | `src/cloud/auth.ts`, `src/cloud/sessions.ts` (Phase 8) | Extend |
| Health check endpoint | `src/server.ts /health` | Reuse as-is |
| Playwright Docker images | `mcr.microsoft.com/playwright` | Reuse (external) |

## Tasks

### TASK-001: Dockerfile and container image for browse sessions

Create `docker/Dockerfile.session` — the container image that runs a single browse session. Based on `mcr.microsoft.com/playwright:v1.52.0-noble` with browse server bundle, production deps, and health check. Resource defaults: 512MB memory, 0.5 CPU.

Also create `docker/docker-compose.cloud.yml` for local development and `docker/.dockerignore`.

**Type:** infra
**Effort:** M

**Acceptance Criteria:**
- [ ] `docker build -f docker/Dockerfile.session -t browse-session .` succeeds and produces an image under 1.2GB
- [ ] `docker run browse-session` starts and responds to GET /health within 5 seconds
- [ ] Container exits cleanly when BROWSE_IDLE_TIMEOUT fires after 5 minutes of inactivity

**Write Scope:** `docker/Dockerfile.session`, `docker/docker-compose.cloud.yml`, `docker/.dockerignore`
**Validation:** `docker build -f docker/Dockerfile.session -t browse-session .`

**Agent:** devops-docker-senior-engineer
**Review:** claude
**Priority:** P0

---

### TASK-002: Docker Engine API client

Create `src/cloud/docker.ts` — minimal Docker Engine API client using Node.js native http module (no external deps). Talks to Docker daemon via Unix socket or TCP (`DOCKER_HOST`).

Methods: `create`, `start`, `stop`, `remove`, `inspect`, `listByLabel`, `waitForHealthy`, `commit`.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] DockerClient.create() + start() + waitForHealthy() provisions a container that responds to health checks
- [ ] DockerClient.stop() + remove() cleans up the container with no orphans
- [ ] DockerClient works via both Unix socket and TCP (DOCKER_HOST)
- [ ] Unit tests verify HTTP request building, label filtering, and error handling without Docker

**Write Scope:** `src/cloud/docker.ts`, `src/cloud/index.ts`
**Validation:** `npx tsc --noEmit`

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P0

---

### TASK-003: Container orchestrator, shared interface, and command proxy

First, create the shared `Orchestrator` interface in `src/cloud/orchestrator-interface.ts` — this is the abstraction that both ContainerOrchestrator (this phase) and VmOrchestrator (Phase 10) implement. Defines: `provision()`, `executeCommand()`, `terminate()`, `freeze()`, `resume()`, `list()`.

Then create `src/cloud/orchestrator.ts` (ContainerOrchestrator implementing the interface) and `src/cloud/proxy.ts` (HTTP proxy utility for forwarding to container-internal browse servers).

Update `src/cloud/server.ts` (Phase 8) to use ContainerOrchestrator via the Orchestrator interface when `BROWSE_CLOUD_ISOLATION=container`.

**Type:** feature
**Effort:** L

**Acceptance Criteria:**
- [ ] provision() creates a container, waits for health, and executeCommand() proxies a 'goto' + 'text' flow with correct results
- [ ] terminate() stops the container and subsequent executeCommand() returns a clear 'session terminated' error
- [ ] Gateway with BROWSE_CLOUD_ISOLATION=container routes through ContainerOrchestrator; unset uses direct SessionManager

**Write Scope:** `src/cloud/orchestrator.ts`, `src/cloud/proxy.ts`, `src/cloud/server.ts`
**Validation:** `npx tsc --noEmit`

**Depends on:** TASK-001, TASK-002
**Agent:** express-senior-engineer
**Review:** claude
**Priority:** P1

---

### TASK-004: Warm container pool

Create `src/cloud/warm-pool.ts` — pre-starts containers to minimize cold start latency. `claim()` returns a ready container in <100ms. `replenish()` maintains pool at target size (default 5). Integrates with ContainerOrchestrator: provision() tries pool first.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] claim() returns a healthy container in under 100ms when pool is populated
- [ ] Pool replenishes to target size within 60s of being depleted below 50%
- [ ] drain() on shutdown stops and removes all pool containers with no orphans

**Write Scope:** `src/cloud/warm-pool.ts`, `src/cloud/orchestrator.ts`
**Validation:** `npx tsc --noEmit`

**Depends on:** TASK-002, TASK-003
**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P1

---

### TASK-005: Container freeze/resume and orphan reaper

Add container-level freeze/resume to the orchestrator (docker commit for freeze, create from snapshot image for resume). Create `src/cloud/reaper.ts` for orphan container cleanup — scans every 60s for containers with `browse-cloud` label that don't match active sessions.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] freeze() commits container state to an image, stops the container, and stores snapshot metadata
- [ ] resume() creates a new container from the snapshot image and the browse server comes up healthy with preserved page state
- [ ] Reaper detects and removes orphaned containers running >5 minutes with no matching gateway session

**Write Scope:** `src/cloud/reaper.ts`, `src/cloud/orchestrator.ts`
**Validation:** `npx tsc --noEmit`

**Depends on:** TASK-003
**Agent:** devops-docker-senior-engineer
**Review:** claude
**Priority:** P2

---

### TASK-006: Container isolation integration tests

Create `test/cloud-containers.test.ts` with 7 test scenarios: container lifecycle, warm pool, freeze/resume, tenant isolation, resource limits, orphan reaper, fallback mode. Tests skip gracefully when Docker is not available.

**Type:** test
**Effort:** L

**Acceptance Criteria:**
- [ ] All 7 test scenarios pass when Docker is available
- [ ] Tests skip gracefully with descriptive message when Docker is not available
- [ ] Freeze/resume test proves cookies and URL survive the round-trip across container recreation

**Write Scope:** `test/cloud-containers.test.ts`
**Validation:** `npm test -- test/cloud-containers`

**Depends on:** TASK-003, TASK-004, TASK-005
**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P2

---

## Failure Modes

| Risk | Affected Tasks | Mitigation |
|------|---------------|------------|
| Docker socket not available | TASK-002 | Support Unix socket + TCP. Test both paths. |
| Container startup >2s | TASK-004 | Warm pool of pre-started containers |
| Orphaned containers from gateway crash | TASK-005 | Label-based reaper scans every 60s |
| Port exhaustion | TASK-003 | Docker internal network, not host ports |
| Container OOM kills | TASK-001 | 512MB memory limit, no restart policy |
| State loss on container death | TASK-003 | Gateway catches exit, marks terminated, client provisions new |

## Ship Cut

- **Minimum shippable:** TASK-001 + TASK-002 + TASK-003 = per-session container isolation with command proxying
- **Full Phase 9:** All 6 tasks = containers + warm pool + freeze/resume + reaper + tests
- **Not shippable without Phase 10:** enterprise-grade isolation (needs microVM)

## Test Coverage Map

| New Codepath | Covering Task | Test Type |
|-------------|--------------|-----------|
| Docker client lifecycle | TASK-002 | integration |
| Container provision + health check | TASK-003 | integration |
| Command proxy gateway → container | TASK-003 | integration |
| Warm pool claim/replenish | TASK-004 | unit |
| Container freeze/resume | TASK-005 | integration |
| Orphan container reaper | TASK-005 | unit |
| Resource limits enforced | TASK-001 | integration |
| E2E SDK → gateway → container → browse | TASK-006 | e2e |

## Execution Summary

| Item | Value |
|------|-------|
| Task Count | 6 |
| Layer Count | 4 |
| Critical Path | TASK-002 → TASK-003 → TASK-005 → TASK-006 |

### Parallel Layers

| Layer | Tasks | Notes |
|-------|-------|-------|
| 0 | TASK-001, TASK-002 | Independent: Dockerfile + Docker client |
| 1 | TASK-003 | Orchestrator + proxy (depends on both P0 tasks) |
| 2 | TASK-004, TASK-005 | Warm pool + freeze/reaper (parallel) |
| 3 | TASK-006 | Integration tests |

## Task Dependencies

```json
{
  "TASK-001": [],
  "TASK-002": [],
  "TASK-003": ["TASK-001", "TASK-002"],
  "TASK-004": ["TASK-002", "TASK-003"],
  "TASK-005": ["TASK-003"],
  "TASK-006": ["TASK-003", "TASK-004", "TASK-005"]
}
```
