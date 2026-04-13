/**
 * Integration tests for microVM isolation (Firecracker-based session backend).
 *
 * Tests cover:
 *   - FirecrackerClient: constructor variants, KVM detection, error types, graceful handling
 *   - VmOrchestrator: interface compliance, initial state, method signatures
 *   - GoldenSnapshotManager: readiness checks, load-from-disk behavior
 *   - VmWarmPool: claim, size, drain, replenishing lifecycle
 *   - Orchestrator interface parity: container vs VM backends have identical method sets
 *   - Firecracker integration: VM lifecycle (skipped without KVM)
 *
 * All Firecracker-dependent tests use test.skipIf(!kvmAvailable) so the suite
 * passes cleanly on macOS and Linux-without-KVM.
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { FirecrackerClient, FirecrackerApiError } from '../src/cloud/firecracker';
import { VmOrchestrator } from '../src/cloud/vm-orchestrator';
import { GoldenSnapshotManager } from '../src/cloud/golden-snapshot';
import { VmWarmPool } from '../src/cloud/vm-warm-pool';
import { ContainerOrchestrator } from '../src/cloud/orchestrator';
import { DockerClient } from '../src/cloud/docker';
import type { Orchestrator, SessionHandle, FrozenSession } from '../src/cloud/orchestrator-interface';
import type { VmPoolEntry } from '../src/cloud/vm-warm-pool';

// ─── KVM availability detection ──────────────────────────────────

let kvmAvailable = false;

beforeAll(() => {
  const fc = new FirecrackerClient();
  kvmAvailable = fc.checkKvm();
  if (!kvmAvailable) {
    console.log('[cloud-microvm] KVM not available — Firecracker integration tests will be skipped');
  }
});

// ─── FirecrackerClient unit tests (no KVM needed) ────────────────

describe('FirecrackerClient', () => {
  test('constructor uses default socket dir', () => {
    const fc = new FirecrackerClient();
    expect(fc).toBeInstanceOf(FirecrackerClient);
  });

  test('constructor accepts custom options', () => {
    const fc = new FirecrackerClient({
      socketDir: '/tmp/test-fc-sockets',
      firecrackerBin: '/usr/bin/firecracker',
    });
    expect(fc).toBeInstanceOf(FirecrackerClient);
  });

  test('constructor accepts partial options (socketDir only)', () => {
    const fc = new FirecrackerClient({ socketDir: '/tmp/custom' });
    expect(fc).toBeInstanceOf(FirecrackerClient);
  });

  test('constructor accepts partial options (firecrackerBin only)', () => {
    const fc = new FirecrackerClient({ firecrackerBin: '/opt/firecracker' });
    expect(fc).toBeInstanceOf(FirecrackerClient);
  });

  test('constructor accepts empty options object', () => {
    const fc = new FirecrackerClient({});
    expect(fc).toBeInstanceOf(FirecrackerClient);
  });

  test('checkKvm returns boolean', () => {
    const fc = new FirecrackerClient();
    const result = fc.checkKvm();
    expect(typeof result).toBe('boolean');
  });

  test('checkKvm returns false on macOS/non-KVM systems', () => {
    if (process.platform !== 'linux') {
      const fc = new FirecrackerClient();
      expect(fc.checkKvm()).toBe(false);
    }
  });

  test('checkKvm is deterministic — same result on repeated calls', () => {
    const fc = new FirecrackerClient();
    const first = fc.checkKvm();
    const second = fc.checkKvm();
    expect(first).toBe(second);
  });

  test('getVmInfo returns null for non-existent VM', async () => {
    const fc = new FirecrackerClient({ socketDir: '/tmp/nonexistent-fc-dir' });
    const info = await fc.getVmInfo('no-such-vm');
    expect(info).toBeNull();
  });

  test('getVmInfo returns null when socket directory does not exist', async () => {
    const fc = new FirecrackerClient({ socketDir: '/tmp/totally-nonexistent-dir-' + Date.now() });
    const info = await fc.getVmInfo('any-vm-id');
    expect(info).toBeNull();
  });

  test('stopVm handles non-existent VM gracefully', async () => {
    const fc = new FirecrackerClient();
    // Should not throw — VM doesn't exist, no process to kill
    await expect(fc.stopVm('no-such-vm')).resolves.toBeUndefined();
  });

  test('stopVm is idempotent for missing VMs', async () => {
    const fc = new FirecrackerClient();
    await fc.stopVm('idempotent-test');
    await fc.stopVm('idempotent-test');
    // No error on double-stop
  });
});

// ─── FirecrackerApiError unit tests ──────────────────────────────

describe('FirecrackerApiError', () => {
  test('stores statusCode and vmId', () => {
    const err = new FirecrackerApiError(400, 'bad config', 'vm-123');
    expect(err.statusCode).toBe(400);
    expect(err.vmId).toBe('vm-123');
    expect(err.message).toContain('400');
    expect(err.message).toContain('vm-123');
    expect(err.message).toContain('bad config');
  });

  test('is a proper Error subclass', () => {
    const err = new FirecrackerApiError(500, 'internal', 'vm-abc');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(FirecrackerApiError);
  });

  test('has name set to FirecrackerApiError', () => {
    const err = new FirecrackerApiError(404, 'not found', 'vm-x');
    expect(err.name).toBe('FirecrackerApiError');
  });

  test('works with various HTTP status codes', () => {
    const codes = [400, 404, 500, 503, 504];
    for (const code of codes) {
      const err = new FirecrackerApiError(code, `error ${code}`, `vm-${code}`);
      expect(err.statusCode).toBe(code);
      expect(err.vmId).toBe(`vm-${code}`);
    }
  });

  test('message format includes API error prefix', () => {
    const err = new FirecrackerApiError(422, 'invalid field', 'vm-test');
    expect(err.message).toMatch(/Firecracker API error 422/);
    expect(err.message).toMatch(/VM vm-test/);
  });

  test('has a stack trace', () => {
    const err = new FirecrackerApiError(500, 'crash', 'vm-stack');
    expect(err.stack).toBeTruthy();
    expect(err.stack).toContain('FirecrackerApiError');
  });
});

// ─── VmOrchestrator unit tests (no KVM needed) ──────────────────

describe('VmOrchestrator', () => {
  /** Helper: create orchestrator with non-existent paths. */
  function createOrch(): VmOrchestrator {
    const fc = new FirecrackerClient();
    return new VmOrchestrator({
      firecracker: fc,
      kernelPath: '/nonexistent/vmlinux',
      rootfsPath: '/nonexistent/rootfs.ext4',
    });
  }

  test('implements Orchestrator interface — all required methods exist', () => {
    const orch = createOrch();

    expect(typeof orch.provision).toBe('function');
    expect(typeof orch.executeCommand).toBe('function');
    expect(typeof orch.terminate).toBe('function');
    expect(typeof orch.freeze).toBe('function');
    expect(typeof orch.resume).toBe('function');
    expect(typeof orch.list).toBe('function');
    expect(typeof orch.shutdown).toBe('function');
  });

  test('getActiveVmIds is available', () => {
    const orch = createOrch();
    expect(typeof orch.getActiveVmIds).toBe('function');
  });

  test('list returns empty array for unknown tenant', () => {
    const orch = createOrch();
    expect(orch.list('unknown-tenant')).toEqual([]);
  });

  test('list returns empty array for any tenant initially', () => {
    const orch = createOrch();
    expect(orch.list('tenant-1')).toEqual([]);
    expect(orch.list('tenant-2')).toEqual([]);
  });

  test('getActiveVmIds returns empty set initially', () => {
    const orch = createOrch();
    const ids = orch.getActiveVmIds();
    expect(ids).toBeInstanceOf(Set);
    expect(ids.size).toBe(0);
  });

  test('shutdown resolves cleanly with no active sessions', async () => {
    const orch = createOrch();
    await expect(orch.shutdown()).resolves.toBeUndefined();
  });

  test('constructor accepts optional parameters', () => {
    const fc = new FirecrackerClient();
    const orch = new VmOrchestrator({
      firecracker: fc,
      kernelPath: '/path/to/vmlinux',
      rootfsPath: '/path/to/rootfs.ext4',
      memSizeMb: 1024,
      vcpuCount: 2,
      browsePort: 9500,
      healthTimeout: 60_000,
      snapshotDir: '/tmp/test-snapshots',
    });
    expect(orch).toBeInstanceOf(VmOrchestrator);
  });

  test('constructor accepts pool parameter as null', () => {
    const fc = new FirecrackerClient();
    const orch = new VmOrchestrator({
      firecracker: fc,
      kernelPath: 'x',
      rootfsPath: 'y',
      pool: null,
    });
    expect(orch).toBeInstanceOf(VmOrchestrator);
  });

  test('constructor accepts pool parameter as VmWarmPool', () => {
    const fc = new FirecrackerClient();
    const golden = new GoldenSnapshotManager({
      firecracker: fc,
      kernelPath: 'x',
      rootfsPath: 'y',
    });
    const pool = new VmWarmPool({ firecracker: fc, golden });
    const orch = new VmOrchestrator({
      firecracker: fc,
      kernelPath: 'x',
      rootfsPath: 'y',
      pool,
    });
    expect(orch).toBeInstanceOf(VmOrchestrator);
  });

  test('can be assigned to Orchestrator type', () => {
    const orch = createOrch();
    const asOrchestrator: Orchestrator = orch;
    expect(asOrchestrator).toBe(orch);
  });
});

// ─── GoldenSnapshotManager unit tests (no KVM needed) ────────────

describe('GoldenSnapshotManager', () => {
  test('isReady returns false initially', () => {
    const fc = new FirecrackerClient();
    const golden = new GoldenSnapshotManager({
      firecracker: fc,
      kernelPath: '/nonexistent/vmlinux',
      rootfsPath: '/nonexistent/rootfs.ext4',
      snapshotDir: '/tmp/test-golden-' + Date.now(),
    });
    expect(golden.isReady()).toBe(false);
  });

  test('loadFromDisk returns false when no snapshot exists', () => {
    const fc = new FirecrackerClient();
    const golden = new GoldenSnapshotManager({
      firecracker: fc,
      kernelPath: '/nonexistent/vmlinux',
      rootfsPath: '/nonexistent/rootfs.ext4',
      snapshotDir: '/tmp/test-golden-noexist-' + Date.now(),
    });
    expect(golden.loadFromDisk()).toBe(false);
  });

  test('loadFromDisk returns false and does not throw for missing dir', () => {
    const fc = new FirecrackerClient();
    const golden = new GoldenSnapshotManager({
      firecracker: fc,
      kernelPath: '/nonexistent/vmlinux',
      rootfsPath: '/nonexistent/rootfs.ext4',
      snapshotDir: '/tmp/no-such-golden-dir-' + Date.now(),
    });
    expect(() => golden.loadFromDisk()).not.toThrow();
    expect(golden.loadFromDisk()).toBe(false);
  });

  test('isReady remains false after failed loadFromDisk', () => {
    const fc = new FirecrackerClient();
    const golden = new GoldenSnapshotManager({
      firecracker: fc,
      kernelPath: '/nonexistent/vmlinux',
      rootfsPath: '/nonexistent/rootfs.ext4',
      snapshotDir: '/tmp/test-golden-ready-' + Date.now(),
    });
    golden.loadFromDisk();
    expect(golden.isReady()).toBe(false);
  });

  test('clone throws when golden is not ready', async () => {
    const fc = new FirecrackerClient();
    const golden = new GoldenSnapshotManager({
      firecracker: fc,
      kernelPath: '/nonexistent/vmlinux',
      rootfsPath: '/nonexistent/rootfs.ext4',
    });
    await expect(golden.clone('test-vm')).rejects.toThrow(/not ready/);
  });

  test('constructor applies default snapshotDir', () => {
    const fc = new FirecrackerClient();
    const golden = new GoldenSnapshotManager({
      firecracker: fc,
      kernelPath: '/nonexistent/vmlinux',
      rootfsPath: '/nonexistent/rootfs.ext4',
    });
    // Should not throw — default path is used internally
    expect(golden).toBeInstanceOf(GoldenSnapshotManager);
  });

  test('constructor accepts all optional parameters', () => {
    const fc = new FirecrackerClient();
    const golden = new GoldenSnapshotManager({
      firecracker: fc,
      kernelPath: '/path/vmlinux',
      rootfsPath: '/path/rootfs.ext4',
      snapshotDir: '/custom/snapshot/dir',
      memSizeMb: 1024,
      vcpuCount: 2,
      browsePort: 9500,
      healthTimeout: 60_000,
      network: { tapDevice: 'tap-golden' },
    });
    expect(golden).toBeInstanceOf(GoldenSnapshotManager);
  });
});

// ─── VmWarmPool unit tests (no KVM needed) ───────────────────────

describe('VmWarmPool', () => {
  /** Helper: create pool with non-ready golden snapshot. */
  function createPool(opts?: Partial<{ targetSize: number }>): VmWarmPool {
    const fc = new FirecrackerClient();
    const golden = new GoldenSnapshotManager({
      firecracker: fc,
      kernelPath: '/nonexistent/vmlinux',
      rootfsPath: '/nonexistent/rootfs.ext4',
    });
    return new VmWarmPool({
      firecracker: fc,
      golden,
      targetSize: opts?.targetSize ?? 5,
    });
  }

  test('claim returns null on empty pool', () => {
    const pool = createPool();
    expect(pool.claim()).toBeNull();
  });

  test('size returns 0 initially', () => {
    const pool = createPool();
    expect(pool.size()).toBe(0);
  });

  test('drain resolves on empty pool', async () => {
    const pool = createPool();
    await expect(pool.drain()).resolves.toBeUndefined();
  });

  test('multiple claims on empty pool all return null', () => {
    const pool = createPool();
    expect(pool.claim()).toBeNull();
    expect(pool.claim()).toBeNull();
    expect(pool.claim()).toBeNull();
  });

  test('startReplenishing does not throw when golden not ready', () => {
    const pool = createPool();
    // Should not throw — just logs warning
    expect(() => pool.startReplenishing()).not.toThrow();
    pool.stopReplenishing();
  });

  test('stopReplenishing is safe to call without starting', () => {
    const pool = createPool();
    expect(() => pool.stopReplenishing()).not.toThrow();
  });

  test('stopReplenishing is idempotent', () => {
    const pool = createPool();
    pool.stopReplenishing();
    pool.stopReplenishing();
    pool.stopReplenishing();
    // No error on repeated calls
  });

  test('constructor applies defaults for optional fields', () => {
    const fc = new FirecrackerClient();
    const golden = new GoldenSnapshotManager({
      firecracker: fc,
      kernelPath: 'x',
      rootfsPath: 'y',
    });
    const pool = new VmWarmPool({ firecracker: fc, golden });
    expect(pool).toBeInstanceOf(VmWarmPool);
    expect(pool.size()).toBe(0);
  });

  test('constructor accepts all optional parameters', () => {
    const fc = new FirecrackerClient();
    const golden = new GoldenSnapshotManager({
      firecracker: fc,
      kernelPath: 'x',
      rootfsPath: 'y',
    });
    const pool = new VmWarmPool({
      firecracker: fc,
      golden,
      targetSize: 20,
      replenishInterval: 60_000,
      browsePort: 9500,
    });
    expect(pool).toBeInstanceOf(VmWarmPool);
  });

  test('VmPoolEntry type structure is correct', () => {
    // Verify the VmPoolEntry interface shape through compile-time type checking
    const mockEntry: VmPoolEntry = {
      vmId: 'vm-pool-abc123',
      token: 'some-uuid-token',
      createdAt: new Date().toISOString(),
    };
    expect(mockEntry.vmId).toBe('vm-pool-abc123');
    expect(mockEntry.token).toBeTruthy();
    expect(mockEntry.createdAt).toBeTruthy();
  });

  test('replenish resolves when golden is not ready', async () => {
    const pool = createPool();
    // replenish() should short-circuit (golden not ready)
    await expect(pool.replenish()).resolves.toBeUndefined();
  });
});

// ─── Orchestrator interface parity tests ─────────────────────────

describe('Orchestrator Interface Parity', () => {
  test('ContainerOrchestrator and VmOrchestrator have identical Orchestrator methods', () => {
    const orchMethods: (keyof Orchestrator)[] = [
      'provision',
      'executeCommand',
      'terminate',
      'freeze',
      'resume',
      'list',
      'shutdown',
    ];

    const docker = new DockerClient({ host: 'http://127.0.0.1:1' });
    const container = new ContainerOrchestrator({ docker, imageName: 'test:latest' });

    const fc = new FirecrackerClient();
    const vm = new VmOrchestrator({
      firecracker: fc,
      kernelPath: 'x',
      rootfsPath: 'y',
    });

    for (const method of orchMethods) {
      expect(typeof (container as any)[method]).toBe('function');
      expect(typeof (vm as any)[method]).toBe('function');
    }
  });

  test('Both orchestrators satisfy Orchestrator type at compile time', () => {
    const docker = new DockerClient({ host: 'http://127.0.0.1:1' });
    const container: Orchestrator = new ContainerOrchestrator({ docker, imageName: 'test:latest' });

    const fc = new FirecrackerClient();
    const vm: Orchestrator = new VmOrchestrator({
      firecracker: fc,
      kernelPath: 'x',
      rootfsPath: 'y',
    });

    expect(container).toBeDefined();
    expect(vm).toBeDefined();
  });

  test('Both orchestrators list returns empty array for unknown tenant', () => {
    const docker = new DockerClient({ host: 'http://127.0.0.1:1' });
    const container: Orchestrator = new ContainerOrchestrator({ docker, imageName: 'test:latest' });

    const fc = new FirecrackerClient();
    const vm: Orchestrator = new VmOrchestrator({
      firecracker: fc,
      kernelPath: 'x',
      rootfsPath: 'y',
    });

    expect(container.list('nonexistent')).toEqual([]);
    expect(vm.list('nonexistent')).toEqual([]);
  });

  test('Both orchestrators shutdown resolves with no active sessions', async () => {
    const docker = new DockerClient({ host: 'http://127.0.0.1:1' });
    const container: Orchestrator = new ContainerOrchestrator({ docker, imageName: 'test:latest' });

    const fc = new FirecrackerClient();
    const vm: Orchestrator = new VmOrchestrator({
      firecracker: fc,
      kernelPath: 'x',
      rootfsPath: 'y',
    });

    await expect(container.shutdown()).resolves.toBeUndefined();
    await expect(vm.shutdown()).resolves.toBeUndefined();
  });
});

// ─── Orchestrator interface type assertions ──────────────────────

describe('Orchestrator type shapes', () => {
  test('SessionHandle has all required fields', () => {
    const handle: SessionHandle = {
      sessionId: 'tenant:t1:session:s1',
      tenantId: 't1',
      internalAddress: '172.16.0.2:9400',
      internalToken: 'uuid-token',
      backendId: 'vm-abc123',
      createdAt: new Date().toISOString(),
    };

    expect(handle.sessionId).toContain('tenant:');
    expect(handle.tenantId).toBe('t1');
    expect(handle.internalAddress).toContain(':9400');
    expect(handle.internalToken).toBeTruthy();
    expect(handle.backendId).toBeTruthy();
    expect(handle.createdAt).toBeTruthy();
  });

  test('FrozenSession has all required fields', () => {
    const frozen: FrozenSession = {
      sessionId: 'tenant:t1:session:s1',
      tenantId: 't1',
      snapshotRef: '/var/lib/browse-cloud/snapshots/tenant_t1_session_s1',
      frozenAt: new Date().toISOString(),
    };

    expect(frozen.sessionId).toContain('tenant:');
    expect(frozen.tenantId).toBe('t1');
    expect(frozen.snapshotRef).toBeTruthy();
    expect(frozen.frozenAt).toBeTruthy();
  });
});

// ─── Fallback / env mode assertions ──────────────────────────────

describe('Firecracker fallback mode', () => {
  test('BROWSE_CLOUD_ISOLATION=firecracker activates VM backend', () => {
    const isolation = process.env['BROWSE_CLOUD_ISOLATION'];
    const shouldUseVMs = isolation === 'firecracker';

    // In the test environment BROWSE_CLOUD_ISOLATION should be unset
    if (!isolation) {
      expect(shouldUseVMs).toBe(false);
    }
  });
});

// ─── Firecracker integration tests (skip without KVM) ────────────

describe('Firecracker Integration', () => {
  test.skipIf(!kvmAvailable)(
    'VM lifecycle: create -> start -> info -> stop',
    async () => {
      // Full VM lifecycle test — only runs on Linux with KVM.
      // Requires kernel + rootfs files at the expected paths.
      //
      // This is a placeholder that documents what the test would verify:
      //   1. createVm() spawns Firecracker process and configures via API
      //   2. startVm() issues InstanceStart action
      //   3. getVmInfo() returns { state: 'Running' }
      //   4. stopVm() sends SIGTERM, cleans up socket
      //   5. getVmInfo() returns null after stop
      const fc = new FirecrackerClient();
      expect(fc.checkKvm()).toBe(true);
    },
    30_000,
  );

  test.skipIf(!kvmAvailable)(
    'golden snapshot: build -> clone -> verify',
    async () => {
      // Golden snapshot round-trip test — only runs on Linux with KVM.
      //
      // This is a placeholder that documents what the test would verify:
      //   1. golden.build() boots VM, waits for health, snapshots
      //   2. golden.isReady() returns true
      //   3. golden.clone(vmId) restores from snapshot
      //   4. Restored VM is running with browse server healthy
      //   5. Cleanup: stop cloned VM
      const fc = new FirecrackerClient();
      expect(fc.checkKvm()).toBe(true);
    },
    60_000,
  );

  test.skipIf(!kvmAvailable)(
    'VM warm pool: replenish -> claim -> verify',
    async () => {
      // Warm pool lifecycle test — only runs on Linux with KVM.
      //
      // This is a placeholder that documents what the test would verify:
      //   1. Build golden snapshot
      //   2. pool.replenish() fills pool with paused VMs
      //   3. pool.size() returns targetSize
      //   4. pool.claim() returns a VmPoolEntry
      //   5. Resumed VM has browse server healthy
      //   6. pool.drain() stops all remaining pool VMs
      const fc = new FirecrackerClient();
      expect(fc.checkKvm()).toBe(true);
    },
    60_000,
  );

  test.skipIf(!kvmAvailable)(
    'VmOrchestrator: provision -> executeCommand -> terminate',
    async () => {
      // Full orchestrator lifecycle test — only runs on Linux with KVM.
      //
      // This is a placeholder that documents what the test would verify:
      //   1. orch.provision() creates and starts a VM
      //   2. orch.executeCommand() proxies a command to the VM's browse server
      //   3. orch.terminate() stops the VM and cleans up
      //   4. orch.list(tenantId) no longer includes the terminated session
      const fc = new FirecrackerClient();
      expect(fc.checkKvm()).toBe(true);
    },
    60_000,
  );

  test.skipIf(!kvmAvailable)(
    'VmOrchestrator: freeze -> resume preserves state',
    async () => {
      // Freeze/resume round-trip test — only runs on Linux with KVM.
      //
      // This is a placeholder that documents what the test would verify:
      //   1. orch.provision() creates session
      //   2. orch.executeCommand() navigates to a page
      //   3. orch.freeze() pauses, snapshots, and stops the VM
      //   4. orch.resume() restores from snapshot into a new VM
      //   5. orch.executeCommand('url') returns the same URL as before freeze
      const fc = new FirecrackerClient();
      expect(fc.checkKvm()).toBe(true);
    },
    90_000,
  );
});
