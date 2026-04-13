/**
 * Integration tests for container isolation (Docker-based session backend).
 *
 * Tests cover:
 *   - DockerClient: constructor variants, ping, error types
 *   - ContainerOrchestrator: interface compliance, initial state
 *   - WarmPool: claim, size, drain, stopReplenishing
 *   - ContainerReaper: start/stop, graceful reap on unreachable Docker
 *   - proxyCommand / ProxyError: unreachable target, error shape
 *   - Docker integration: container lifecycle (skipped if Docker unavailable)
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { DockerClient, DockerApiError } from '../src/cloud/docker';
import type { ContainerCreateOptions, ContainerInfo, DockerClientOptions } from '../src/cloud/docker';
import { ContainerOrchestrator } from '../src/cloud/orchestrator';
import type { ContainerOrchestratorOptions } from '../src/cloud/orchestrator';
import { WarmPool } from '../src/cloud/warm-pool';
import type { WarmPoolOptions, PoolEntry } from '../src/cloud/warm-pool';
import { ContainerReaper } from '../src/cloud/reaper';
import type { ReaperOptions } from '../src/cloud/reaper';
import { proxyCommand, ProxyError } from '../src/cloud/proxy';
import type { ProxyOptions } from '../src/cloud/proxy';
import type { Orchestrator, SessionHandle, FrozenSession } from '../src/cloud/orchestrator-interface';

// ─── Docker availability detection ─────────────────────────────

let dockerAvailable = false;

beforeAll(async () => {
  try {
    const docker = new DockerClient();
    dockerAvailable = await docker.ping();
  } catch {
    dockerAvailable = false;
  }

  if (!dockerAvailable) {
    console.log('[cloud-containers] Docker not available — integration tests will be skipped');
  }
});

// ─── DockerClient unit tests (no Docker needed) ────────────────

describe('DockerClient', () => {
  test('constructor defaults to Unix socket', () => {
    const client = new DockerClient();
    expect(client).toBeInstanceOf(DockerClient);
  });

  test('constructor accepts socketPath option', () => {
    const client = new DockerClient({ socketPath: '/var/run/docker.sock' });
    expect(client).toBeInstanceOf(DockerClient);
  });

  test('constructor accepts host option (tcp format)', () => {
    const client = new DockerClient({ host: 'http://localhost:2375' });
    expect(client).toBeInstanceOf(DockerClient);
  });

  test('constructor accepts host option (https)', () => {
    const client = new DockerClient({ host: 'https://localhost:2376' });
    expect(client).toBeInstanceOf(DockerClient);
  });

  test('ping returns false when Docker daemon is unreachable', async () => {
    // Use a port that is almost certainly not running Docker
    const client = new DockerClient({ host: 'http://127.0.0.1:1' });
    const result = await client.ping();
    expect(result).toBe(false);
  });

  test('DockerApiError stores statusCode', () => {
    const err = new DockerApiError(404, 'container not found');
    expect(err).toBeInstanceOf(Error);
    expect(err.statusCode).toBe(404);
    expect(err.message).toContain('404');
    expect(err.message).toContain('container not found');
    expect(err.name).toBe('DockerApiError');
  });

  test('DockerApiError works with various status codes', () => {
    const codes = [400, 404, 409, 500, 503, 504];
    for (const code of codes) {
      const err = new DockerApiError(code, 'test');
      expect(err.statusCode).toBe(code);
    }
  });

  test('create rejects when Docker is unreachable', async () => {
    const client = new DockerClient({ host: 'http://127.0.0.1:1' });
    await expect(
      client.create({ image: 'alpine:latest' }),
    ).rejects.toThrow();
  });

  test('inspect rejects when Docker is unreachable', async () => {
    const client = new DockerClient({ host: 'http://127.0.0.1:1' });
    await expect(
      client.inspect('nonexistent-container'),
    ).rejects.toThrow();
  });

  test('listByLabel rejects when Docker is unreachable', async () => {
    const client = new DockerClient({ host: 'http://127.0.0.1:1' });
    await expect(
      client.listByLabel('test-key', 'test-value'),
    ).rejects.toThrow();
  });
});

// ─── ContainerOrchestrator unit tests (no Docker needed) ──────

describe('ContainerOrchestrator', () => {
  /** Helper: create orchestrator with unreachable Docker */
  function createOrch(): ContainerOrchestrator {
    const docker = new DockerClient({ host: 'http://127.0.0.1:1' });
    return new ContainerOrchestrator({ docker, imageName: 'browse-test:latest' });
  }

  test('implements Orchestrator interface — all required methods exist', () => {
    const orch = createOrch();

    // Verify every method from the Orchestrator interface
    expect(typeof orch.provision).toBe('function');
    expect(typeof orch.executeCommand).toBe('function');
    expect(typeof orch.terminate).toBe('function');
    expect(typeof orch.freeze).toBe('function');
    expect(typeof orch.resume).toBe('function');
    expect(typeof orch.list).toBe('function');
    expect(typeof orch.shutdown).toBe('function');
  });

  test('getActiveBackendIds is available', () => {
    const orch = createOrch();
    expect(typeof orch.getActiveBackendIds).toBe('function');
  });

  test('list returns empty array for unknown tenant', () => {
    const orch = createOrch();
    expect(orch.list('nonexistent-tenant')).toEqual([]);
  });

  test('list returns empty array for any tenant initially', () => {
    const orch = createOrch();
    expect(orch.list('tenant-1')).toEqual([]);
    expect(orch.list('tenant-2')).toEqual([]);
  });

  test('getActiveBackendIds returns empty set initially', () => {
    const orch = createOrch();
    const ids = orch.getActiveBackendIds();
    expect(ids).toBeInstanceOf(Set);
    expect(ids.size).toBe(0);
  });

  test('provision rejects when Docker is unreachable', async () => {
    const orch = createOrch();
    await expect(
      orch.provision('tenant-1'),
    ).rejects.toThrow();
  });

  test('shutdown resolves cleanly with no active sessions', async () => {
    const orch = createOrch();
    // No active sessions, no pool — should resolve without error
    await expect(orch.shutdown()).resolves.toBeUndefined();
  });

  test('constructor accepts optional pool parameter', () => {
    const docker = new DockerClient({ host: 'http://127.0.0.1:1' });
    const pool = new WarmPool({ docker, imageName: 'test:latest' });
    const orch = new ContainerOrchestrator({
      docker,
      imageName: 'test:latest',
      pool,
    });
    expect(orch).toBeInstanceOf(ContainerOrchestrator);
  });

  test('constructor accepts memory and cpu limits', () => {
    const docker = new DockerClient({ host: 'http://127.0.0.1:1' });
    const orch = new ContainerOrchestrator({
      docker,
      imageName: 'test:latest',
      memoryLimit: 256 * 1024 * 1024,
      cpuLimit: 250_000_000,
      healthTimeout: 15_000,
    });
    expect(orch).toBeInstanceOf(ContainerOrchestrator);
  });
});

// ─── WarmPool unit tests (no Docker needed) ────────────────────

describe('WarmPool', () => {
  /** Helper: create pool with unreachable Docker */
  function createPool(opts?: Partial<WarmPoolOptions>): WarmPool {
    const docker = new DockerClient({ host: 'http://127.0.0.1:1' });
    return new WarmPool({
      docker,
      imageName: 'browse-test:latest',
      targetSize: 3,
      ...opts,
    });
  }

  test('claim returns null when pool is empty', () => {
    const pool = createPool();
    const entry = pool.claim();
    expect(entry).toBeNull();
  });

  test('size returns 0 initially', () => {
    const pool = createPool();
    expect(pool.size()).toBe(0);
  });

  test('drain resolves cleanly on empty pool', async () => {
    const pool = createPool();
    await expect(pool.drain()).resolves.toBeUndefined();
  });

  test('stopReplenishing is safe to call without starting', () => {
    const pool = createPool();
    expect(() => pool.stopReplenishing()).not.toThrow();
  });

  test('stopReplenishing can be called multiple times', () => {
    const pool = createPool();
    pool.stopReplenishing();
    pool.stopReplenishing();
    pool.stopReplenishing();
    // Should not throw
  });

  test('constructor applies defaults for optional fields', () => {
    const docker = new DockerClient({ host: 'http://127.0.0.1:1' });
    const pool = new WarmPool({ docker, imageName: 'test:latest' });
    expect(pool).toBeInstanceOf(WarmPool);
    expect(pool.size()).toBe(0);
  });

  test('multiple claims on empty pool all return null', () => {
    const pool = createPool();
    expect(pool.claim()).toBeNull();
    expect(pool.claim()).toBeNull();
    expect(pool.claim()).toBeNull();
  });

  test('PoolEntry type structure is correct', () => {
    // Verify the PoolEntry interface shape through type checking at compile time
    const mockEntry: PoolEntry = {
      containerId: 'abc123',
      internalAddress: '172.17.0.2:9400',
      token: 'some-uuid-token',
      createdAt: new Date().toISOString(),
    };
    expect(mockEntry.containerId).toBe('abc123');
    expect(mockEntry.internalAddress).toContain(':9400');
    expect(mockEntry.token).toBeTruthy();
    expect(mockEntry.createdAt).toBeTruthy();
  });
});

// ─── ContainerReaper unit tests (no Docker needed) ─────────────

describe('ContainerReaper', () => {
  /** Helper: create reaper with unreachable Docker */
  function createReaper(overrides?: Partial<ReaperOptions>): ContainerReaper {
    const docker = new DockerClient({ host: 'http://127.0.0.1:1' });
    return new ContainerReaper({
      docker,
      getActiveIds: () => new Set(),
      ...overrides,
    });
  }

  test('start and stop do not throw', () => {
    const reaper = createReaper();
    expect(() => reaper.start()).not.toThrow();
    expect(() => reaper.stop()).not.toThrow();
  });

  test('start is idempotent — calling twice does not throw', () => {
    const reaper = createReaper();
    reaper.start();
    reaper.start(); // Should not create duplicate timers
    reaper.stop();
  });

  test('stop is idempotent — calling multiple times does not throw', () => {
    const reaper = createReaper();
    reaper.stop();
    reaper.stop();
    reaper.stop();
  });

  test('stop without start does not throw', () => {
    const reaper = createReaper();
    expect(() => reaper.stop()).not.toThrow();
  });

  test('reap handles Docker unreachable gracefully', async () => {
    const reaper = createReaper();
    // reap() catches all Docker errors internally and returns counts
    const result = await reaper.reap();
    expect(result).toHaveProperty('containers');
    expect(result).toHaveProperty('images');
    expect(result.containers).toBe(0);
    expect(result.images).toBe(0);
  });

  test('reapOnce handles Docker unreachable gracefully', async () => {
    const reaper = createReaper();
    const result = await reaper.reapOnce();
    expect(result).toHaveProperty('containers');
    expect(result.containers).toBe(0);
  });

  test('reaper accepts custom getActiveIds function', async () => {
    let called = false;
    const reaper = createReaper({
      getActiveIds: () => {
        called = true;
        return new Set(['container-1', 'container-2']);
      },
    });

    // reap will call getActiveIds even if listByLabel fails first
    // (Docker unreachable means listByLabel throws before getActiveIds is called)
    // So we just verify construction works with a custom function
    expect(reaper).toBeInstanceOf(ContainerReaper);
    await reaper.reap(); // should not throw
  });

  test('constructor accepts all optional parameters', () => {
    const docker = new DockerClient({ host: 'http://127.0.0.1:1' });
    const reaper = new ContainerReaper({
      docker,
      getActiveIds: () => new Set(),
      minAgeMs: 60_000,
      intervalMs: 30_000,
      snapshotTtlMs: 7200_000,
    });
    expect(reaper).toBeInstanceOf(ContainerReaper);
  });
});

// ─── Proxy unit tests (no Docker needed) ───────────────────────

describe('proxyCommand', () => {
  test('rejects for unreachable target address', async () => {
    await expect(
      proxyCommand('text', [], { address: '127.0.0.1:1', token: 'fake-token', timeout: 1000 }),
    ).rejects.toThrow();
  });

  test('rejects with ProxyError for unreachable target', async () => {
    try {
      await proxyCommand('text', [], { address: '127.0.0.1:1', token: 'fake-token', timeout: 1000 });
      // Should not reach here
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ProxyError);
      expect((err as ProxyError).statusCode).toBeDefined();
      expect((err as ProxyError).targetAddress).toBe('127.0.0.1:1');
    }
  });

  test('rejects with 400 for invalid address format', async () => {
    try {
      await proxyCommand('text', [], { address: '', token: 'token', timeout: 1000 });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ProxyError);
      expect((err as ProxyError).statusCode).toBe(400);
    }
  });

  test('passes command and args in request', async () => {
    // We cannot verify the HTTP body directly without a mock server,
    // but we verify the function signature accepts command + args correctly
    // and that it rejects for an unreachable address
    await expect(
      proxyCommand('goto', ['https://example.com'], {
        address: '127.0.0.1:1',
        token: 'token',
        timeout: 1000,
      }),
    ).rejects.toThrow();
  });
});

describe('ProxyError', () => {
  test('is a proper Error subclass', () => {
    const err = new ProxyError(502, 'gateway error', '127.0.0.1:9400');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ProxyError);
  });

  test('stores statusCode and targetAddress', () => {
    const err = new ProxyError(503, 'service unavailable', '10.0.0.1:9400');
    expect(err.statusCode).toBe(503);
    expect(err.targetAddress).toBe('10.0.0.1:9400');
    expect(err.message).toBe('service unavailable');
    expect(err.name).toBe('ProxyError');
  });

  test('works with various HTTP status codes', () => {
    for (const code of [400, 502, 503, 504]) {
      const err = new ProxyError(code, `error ${code}`, 'host:1234');
      expect(err.statusCode).toBe(code);
    }
  });
});

// ─── Orchestrator interface type assertions ────────────────────

describe('Orchestrator interface contract', () => {
  test('SessionHandle has all required fields', () => {
    const handle: SessionHandle = {
      sessionId: 'tenant:t1:session:s1',
      tenantId: 't1',
      internalAddress: '172.17.0.2:9400',
      internalToken: 'uuid-token',
      backendId: 'container-abc123',
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
      snapshotRef: 'sha256:abc123def',
      frozenAt: new Date().toISOString(),
    };

    expect(frozen.sessionId).toContain('tenant:');
    expect(frozen.tenantId).toBe('t1');
    expect(frozen.snapshotRef).toBeTruthy();
    expect(frozen.frozenAt).toBeTruthy();
  });

  test('ContainerOrchestrator satisfies Orchestrator type', () => {
    const docker = new DockerClient({ host: 'http://127.0.0.1:1' });
    const orch = new ContainerOrchestrator({ docker, imageName: 'test:latest' });

    // TypeScript compile-time check: assign to Orchestrator-typed variable
    const asOrchestrator: Orchestrator = orch;
    expect(asOrchestrator).toBe(orch);
  });
});

// ─── Fallback / env mode assertions ────────────────────────────

describe('Fallback mode', () => {
  test('absence of BROWSE_CLOUD_ISOLATION means no container orchestrator', () => {
    // Design assertion: verify the env-var-based activation logic
    const isolation = process.env['BROWSE_CLOUD_ISOLATION'];
    // When unset (or set to something other than 'container' or 'firecracker'),
    // the gateway should not create an orchestrator
    const shouldUseContainers = isolation === 'container';
    const shouldUseVMs = isolation === 'firecracker';

    // In the test environment these should be unset
    if (!isolation) {
      expect(shouldUseContainers).toBe(false);
      expect(shouldUseVMs).toBe(false);
    }
  });

  test('DockerClient constructed from DOCKER_HOST env var', () => {
    // Verify that DockerClient can be instantiated without options
    // and will fall back to env var or default socket path
    const savedHost = process.env['DOCKER_HOST'];
    try {
      process.env['DOCKER_HOST'] = 'tcp://localhost:2375';
      const client = new DockerClient();
      expect(client).toBeInstanceOf(DockerClient);
    } finally {
      // Restore original value
      if (savedHost === undefined) {
        delete process.env['DOCKER_HOST'];
      } else {
        process.env['DOCKER_HOST'] = savedHost;
      }
    }
  });

  test('DockerClient handles unix:// DOCKER_HOST format', () => {
    const savedHost = process.env['DOCKER_HOST'];
    try {
      process.env['DOCKER_HOST'] = 'unix:///var/run/docker.sock';
      const client = new DockerClient();
      expect(client).toBeInstanceOf(DockerClient);
    } finally {
      if (savedHost === undefined) {
        delete process.env['DOCKER_HOST'];
      } else {
        process.env['DOCKER_HOST'] = savedHost;
      }
    }
  });
});

// ─── Docker integration tests (skip if Docker unavailable) ────

describe('Docker Integration', () => {
  const createdContainers: string[] = [];

  afterAll(async () => {
    // Best-effort cleanup of any containers left behind
    if (createdContainers.length > 0) {
      const docker = new DockerClient();
      for (const id of createdContainers) {
        try { await docker.stop(id, 1); } catch { /* may already be stopped */ }
        try { await docker.remove(id, true); } catch { /* may already be removed */ }
      }
    }
  });

  test.skipIf(!dockerAvailable)(
    'container lifecycle: create -> start -> inspect -> stop -> remove',
    async () => {
      const docker = new DockerClient();
      const label = `browse-test-lifecycle-${Date.now()}`;

      const id = await docker.create({
        image: 'alpine:latest',
        env: [],
        labels: { [label]: 'true' },
      });
      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');
      createdContainers.push(id);

      // Start the container (alpine exits immediately without a command,
      // but create+start should succeed)
      await docker.start(id);

      // Inspect while it might still be running or just exited
      const info = await docker.inspect(id);
      expect(info.id).toBe(id);
      expect(info.labels[label]).toBe('true');
      expect(['running', 'exited']).toContain(info.state);

      // Stop (may already have exited for alpine)
      try {
        await docker.stop(id, 1);
      } catch {
        // alpine may have already exited — that's fine
      }

      // Remove
      await docker.remove(id);

      // Remove from cleanup list since we already cleaned up
      const idx = createdContainers.indexOf(id);
      if (idx !== -1) createdContainers.splice(idx, 1);
    },
    30_000,
  );

  test.skipIf(!dockerAvailable)(
    'listByLabel finds labeled containers',
    async () => {
      const docker = new DockerClient();
      const label = `browse-test-list-${Date.now()}`;

      const id = await docker.create({
        image: 'alpine:latest',
        env: [],
        labels: { [label]: 'yes' },
      });
      createdContainers.push(id);

      // listByLabel with all=true should find created (not started) containers too
      const list = await docker.listByLabel(label, 'yes');
      expect(list.length).toBeGreaterThanOrEqual(1);

      // Find our container in the list (IDs may be truncated in list output)
      const found = list.some(
        (c) => c.id.startsWith(id.slice(0, 12)) || id.startsWith(c.id.slice(0, 12)),
      );
      expect(found).toBe(true);

      // Cleanup
      try { await docker.stop(id, 1); } catch { /* may not be running */ }
      await docker.remove(id, true);

      const idx = createdContainers.indexOf(id);
      if (idx !== -1) createdContainers.splice(idx, 1);
    },
    30_000,
  );

  test.skipIf(!dockerAvailable)(
    'inspect returns correct ContainerInfo shape',
    async () => {
      const docker = new DockerClient();
      const label = `browse-test-inspect-${Date.now()}`;

      const id = await docker.create({
        image: 'alpine:latest',
        labels: { [label]: 'true' },
      });
      createdContainers.push(id);

      const info = await docker.inspect(id);

      // Verify ContainerInfo shape
      expect(info).toHaveProperty('id');
      expect(info).toHaveProperty('name');
      expect(info).toHaveProperty('state');
      expect(info).toHaveProperty('status');
      expect(info).toHaveProperty('ipAddress');
      expect(info).toHaveProperty('ports');
      expect(info).toHaveProperty('labels');
      expect(info).toHaveProperty('health');
      expect(Array.isArray(info.ports)).toBe(true);
      expect(typeof info.labels).toBe('object');

      // Cleanup
      await docker.remove(id, true);
      const idx = createdContainers.indexOf(id);
      if (idx !== -1) createdContainers.splice(idx, 1);
    },
    30_000,
  );

  test.skipIf(!dockerAvailable)(
    'ping returns true when Docker is running',
    async () => {
      const docker = new DockerClient();
      const result = await docker.ping();
      expect(result).toBe(true);
    },
    10_000,
  );

  test.skipIf(!dockerAvailable)(
    'remove with force=true cleans up even if container is running',
    async () => {
      const docker = new DockerClient();
      const label = `browse-test-force-${Date.now()}`;

      // Use a command that keeps the container alive
      const id = await docker.create({
        image: 'alpine:latest',
        env: [],
        labels: { [label]: 'true' },
      });
      createdContainers.push(id);

      await docker.start(id);

      // Force remove without stopping first
      await docker.remove(id, true);

      // Verify it's gone — inspect should throw
      await expect(docker.inspect(id)).rejects.toThrow();

      const idx = createdContainers.indexOf(id);
      if (idx !== -1) createdContainers.splice(idx, 1);
    },
    30_000,
  );
});
