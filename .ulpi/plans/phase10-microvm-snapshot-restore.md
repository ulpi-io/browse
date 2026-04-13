# Plan: Phase 10 — MicroVM Isolation & Snapshot/Restore

> Generated: 2026-04-13
> Branch: `feat/microvm-snapshot-restore`
> Mode: EXPANSION
> Review: claude
> Linked plans: phase8-cloud-api-layer, phase9-container-isolation

## Overview

Replace Docker containers with Firecracker microVMs for VM-level session isolation with sub-second boot times and memory-snapshot-based freeze/restore. Each session runs in a dedicated microVM with its own Linux kernel — eliminating the shared-kernel attack surface of containers. Snapshot/restore captures the entire VM memory state (including Chromium's in-process state) and restores it in ~200ms, enabling instant session resume and cost-efficient hibernation. Warm VM pools with pre-booted Chromium reduce cold starts to near zero. Phase 10 of 10 in the browse roadmap.

## Scope Challenge

Phase 9 uses Docker containers — they share the host kernel, so a kernel exploit in Chromium could escape the container. Firecracker microVMs run a separate Linux kernel per session with KVM hardware virtualization, providing the same isolation as a full VM with <125ms boot time. The key architectural change: the ContainerOrchestrator (Phase 9) is replaced by a VmOrchestrator that talks to Firecracker's API socket instead of Docker's. The warm pool, proxy, and reaper patterns from Phase 9 carry over with minimal changes — the abstraction boundary is at the orchestrator level.

Firecracker requires: Linux host with KVM enabled, a rootfs image, and a kernel binary. This limits deployment to Linux hosts (no macOS/Windows). The gateway can still run on any OS — only the VM backend requires Linux+KVM.

## Prerequisites

- Phase 8 cloud API gateway with auth, session provisioning, SDK (prerequisite)
- Phase 9 container orchestrator pattern established (prerequisite)
- Firecracker binary available on Linux deployment hosts (external: v1.10+)
- KVM enabled on deployment hosts — /dev/kvm accessible (external)
- Linux kernel binary (vmlinux) for Firecracker guest (external)

## Non-Goals

- macOS/Windows microVM support (Firecracker is Linux-only)
- GPU passthrough for WebGL
- Live VM migration between hosts
- Custom kernel builds per tenant
- Nested virtualization
- VM-to-VM networking
- Kubernetes integration (direct Firecracker management only)
- Billing or metering system

## Contracts

| Boundary | Producer | Consumer | Shape / API | Consistency / Recovery Rule |
|----------|----------|----------|-------------|------------------------------|
| VmOrchestrator → Firecracker API | `src/cloud/firecracker.ts` | `src/cloud/vm-orchestrator.ts` | `FirecrackerClient { createVm, startVm, pauseVm, resumeVm, snapshotVm, restoreVm, stopVm }` | One API socket per VM at `/tmp/firecracker-<vmId>.sock` |
| VmOrchestrator → Gateway | `src/cloud/vm-orchestrator.ts` | `src/cloud/server.ts` | Same Orchestrator interface as ContainerOrchestrator | Gateway selects via BROWSE_CLOUD_ISOLATION=firecracker\|container\|none |
| VM Rootfs → Browse Session | `scripts/build-rootfs.sh` | Firecracker VM boot | ext4 rootfs: Alpine + Node.js + Chromium + browse server | Rootfs is immutable. Per-session state in writable overlay. |
| VM Warm Pool → VmOrchestrator | `src/cloud/vm-warm-pool.ts` | `provision()` | Same WarmPool interface as Phase 9 | Pools pre-booted VMs from golden snapshot. Clone time: ~200ms. |

## Architecture

```
Cloud API Gateway (Phase 8)
    │
    ├── BROWSE_CLOUD_ISOLATION=firecracker
    │
    ▼
VmOrchestrator                              TASK-003
    │
    ├── provision() ──► VmWarmPool          TASK-005
    │     │               │
    │     │  claim() ◄────┘ (resume paused VM)
    │     │  OR
    │     └─ GoldenSnapshot.clone()         TASK-004
    │          │
    │          ▼
    │     FirecrackerClient                  TASK-002
    │          │
    │          ▼
    │     Firecracker API socket
    │          │
    │          ▼
    │     MicroVM                            TASK-001
    │     ┌─────────────────────────────┐
    │     │ Linux kernel (vmlinux)       │
    │     │ Alpine rootfs (ext4)         │
    │     │   └── Node.js + Chromium     │
    │     │       └── browse server      │
    │     │           └── :9400          │
    │     └─────────────────────────────┘
    │          256-512MB RAM, 0.5 vCPU
    │
    ├── executeCommand() ──► proxy.ts ──► VM IP:9400/command
    │
    ├── freeze() ──► pause VM → memory snapshot → stop
    │
    └── resume() ──► restore from snapshot → resume → health check
```

## Existing Code Leverage

| Sub-problem | Existing Code | Action |
|------------|---------------|--------|
| Orchestrator interface | `src/cloud/orchestrator.ts` (Phase 9) | Extend (extract interface) |
| Command proxy | `src/cloud/proxy.ts` (Phase 9) | Reuse as-is |
| Warm pool pattern | `src/cloud/warm-pool.ts` (Phase 9) | Extend (snapshot-based) |
| Orphan reaper pattern | `src/cloud/reaper.ts` (Phase 9) | Extend (VM-aware) |
| Browse server inside VM | `src/server.ts` | Reuse as-is |
| Firecracker API spec | Firecracker swagger (external) | Reference |

## Tasks

### TASK-001: MicroVM rootfs image and kernel setup

Create `scripts/build-rootfs.sh` — builds ext4 rootfs for Firecracker. Alpine Linux base + Node.js 18 + Chromium + browse server bundle. Target: <800MB.

Create `scripts/download-kernel.sh` for Firecracker-compatible vmlinux kernel.

Create `docker/Makefile.microvm` with build targets.

**Type:** infra
**Effort:** L

**Acceptance Criteria:**
- [ ] build-rootfs.sh produces an ext4 image under 800MB containing Node.js, Chromium, and browse server bundle
- [ ] Firecracker can boot the rootfs + kernel combination and reach a shell
- [ ] Browse server starts inside the VM and responds to health check on the configured port

**Write Scope:** `scripts/build-rootfs.sh`, `scripts/download-kernel.sh`, `docker/Makefile.microvm`
**Validation:** `bash scripts/build-rootfs.sh && ls -lh rootfs.ext4`

**Agent:** devops-docker-senior-engineer
**Review:** claude
**Priority:** P0

---

### TASK-002: Firecracker API client

Create `src/cloud/firecracker.ts` — Node.js client for Firecracker REST API over Unix socket (one socket per VM).

Methods: `checkKvm()`, `createVm()`, `startVm()`, `pauseVm()`, `resumeVm()`, `snapshotVm()`, `restoreVm()`, `stopVm()`.

All communication via HTTP over Unix socket using Node.js http module.

**Type:** feature
**Effort:** L

**Acceptance Criteria:**
- [ ] checkKvm() returns true on Linux with /dev/kvm, false otherwise
- [ ] createVm() + startVm() boots a Firecracker VM reachable within 2 seconds
- [ ] snapshotVm() creates memory + state files; restoreVm() produces a running VM with identical state

**Write Scope:** `src/cloud/firecracker.ts`, `src/cloud/index.ts`
**Validation:** `npx tsc --noEmit`

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P0

---

### TASK-003: VM orchestrator implementing shared interface

Create `src/cloud/vm-orchestrator.ts` implementing the `Orchestrator` interface already defined in `src/cloud/orchestrator-interface.ts` (created in Phase 9 TASK-003). Uses FirecrackerClient for VM lifecycle.

Update gateway to select orchestrator based on `BROWSE_CLOUD_ISOLATION`: `firecracker` → VmOrchestrator, `container` → ContainerOrchestrator, `none` → direct SessionManager.

**Type:** feature
**Effort:** L

**Acceptance Criteria:**
- [ ] VmOrchestrator.provision() + executeCommand('goto') + executeCommand('text') returns page text through a Firecracker microVM
- [ ] Gateway with BROWSE_CLOUD_ISOLATION=firecracker uses VmOrchestrator; =container uses ContainerOrchestrator; =none uses direct SessionManager
- [ ] VmOrchestrator.freeze() + resume() preserves page URL and cookies across snapshot/restore

**Write Scope:** `src/cloud/vm-orchestrator.ts`, `src/cloud/orchestrator-interface.ts`, `src/cloud/server.ts`, `src/cloud/orchestrator.ts`
**Validation:** `npx tsc --noEmit`

**Depends on:** TASK-001, TASK-002
**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P1

---

### TASK-004: Golden snapshot and instant VM clone

Create `src/cloud/golden-snapshot.ts`. Builds a golden snapshot by: boot VM → launch Chromium → health check → pause → snapshot → stop. Instant clone restores from golden in ~200ms.

GoldenSnapshotManager: `build()`, `clone(vmId)`, `rebuild()`, `isReady()`.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] build() creates golden snapshot from a fresh VM with healthy Chromium in under 10 seconds
- [ ] clone() restores from golden snapshot and produces a healthy VM in under 500ms
- [ ] Cloned VM can immediately execute browse commands without additional initialization

**Write Scope:** `src/cloud/golden-snapshot.ts`
**Validation:** `npx tsc --noEmit`

**Depends on:** TASK-001, TASK-002
**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P1

---

### TASK-005: VM warm pool with snapshot-based provisioning

Create `src/cloud/vm-warm-pool.ts` — pre-clones from golden snapshot, keeps VMs paused. Claiming a VM just resumes it — sub-100ms. Pool target: 10 VMs (cheaper to hold paused than running containers).

Integrate with VmOrchestrator: provision() tries pool.claim() first.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] claim() resumes a paused VM from pool in under 100ms and browse server responds immediately
- [ ] replenish() fills pool using golden snapshot clones, all clones paused consuming minimal CPU
- [ ] VmOrchestrator.provision() uses pool when available, falls back to direct clone when empty

**Write Scope:** `src/cloud/vm-warm-pool.ts`, `src/cloud/vm-orchestrator.ts`
**Validation:** `npx tsc --noEmit`

**Depends on:** TASK-003, TASK-004
**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P2

---

### TASK-006: MicroVM integration tests and benchmarks

Create `test/cloud-microvm.test.ts` (6 correctness tests) and `test/cloud-benchmarks.test.ts` (latency measurements). Tests skip on non-Linux or without /dev/kvm.

Correctness: VM lifecycle, golden snapshot, freeze/resume, warm pool, orchestrator interface parity, resource isolation.

Benchmarks: cold start, warm start, freeze time, resume time — reported as structured JSON.

**Type:** test
**Effort:** L

**Acceptance Criteria:**
- [ ] All 6 correctness tests pass on Linux with KVM — skip with clear message on unsupported platforms
- [ ] Orchestrator parity test proves ContainerOrchestrator and VmOrchestrator produce identical command outputs
- [ ] Benchmark reports cold start <2s, warm start <200ms, freeze <1s, resume <500ms

**Write Scope:** `test/cloud-microvm.test.ts`, `test/cloud-benchmarks.test.ts`
**Validation:** `npm test -- test/cloud-microvm`

**Depends on:** TASK-003, TASK-004, TASK-005
**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P2

---

## Failure Modes

| Risk | Affected Tasks | Mitigation |
|------|---------------|------------|
| KVM not available on host | TASK-002 | checkKvm() at startup, automatic fallback to container isolation |
| Rootfs too large (>2GB) | TASK-001 | Alpine base (~50MB), minimal Chromium. Target <800MB. |
| Snapshot restore corrupt state | TASK-004 | Validate health within 5s. Discard and provision fresh on failure. |
| Memory snapshot files consume disk | TASK-004 | 512MB VM = 512MB max. Compress with zstd. Reaper deletes old snapshots. |
| Network config requires root | TASK-001 | Pre-create tap devices at host setup. Document requirements. |
| Firecracker version incompatibility | TASK-002 | Pin version. Validate at startup. |

## Ship Cut

- **Minimum shippable:** TASK-001 + TASK-002 + TASK-003 = microVM isolation with command proxying
- **Full Phase 10:** All 6 tasks = microVMs + golden snapshot + warm pool + tests + benchmarks
- **The moat:** snapshot/restore (TASK-004) + warm pool (TASK-005) = the competitive differentiator no one else has

## Test Coverage Map

| New Codepath | Covering Task | Test Type |
|-------------|--------------|-----------|
| Firecracker API client lifecycle | TASK-002 | integration |
| VM provision with browse health check | TASK-003 | integration |
| Command proxy gateway → VM | TASK-003 | integration |
| Golden snapshot creation and clone | TASK-004 | integration |
| VM freeze (memory snapshot) and restore | TASK-004 | integration |
| Warm VM pool claim/replenish | TASK-005 | unit |
| Orchestrator interface compatibility | TASK-003 | unit |
| E2E SDK → gateway → microVM → browse | TASK-006 | e2e |

## Execution Summary

| Item | Value |
|------|-------|
| Task Count | 6 |
| Layer Count | 4 |
| Critical Path | TASK-002 → TASK-003 → TASK-005 → TASK-006 |

### Parallel Layers

| Layer | Tasks | Notes |
|-------|-------|-------|
| 0 | TASK-001, TASK-002 | Independent: rootfs image + Firecracker client |
| 1 | TASK-003, TASK-004 | VM orchestrator + golden snapshot (parallel) |
| 2 | TASK-005 | Warm pool (depends on orchestrator + golden snapshot) |
| 3 | TASK-006 | Tests and benchmarks |

## Task Dependencies

```json
{
  "TASK-001": [],
  "TASK-002": [],
  "TASK-003": ["TASK-001", "TASK-002"],
  "TASK-004": ["TASK-001", "TASK-002"],
  "TASK-005": ["TASK-003", "TASK-004"],
  "TASK-006": ["TASK-003", "TASK-004", "TASK-005"]
}
```
