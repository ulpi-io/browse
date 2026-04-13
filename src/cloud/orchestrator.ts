/**
 * Container orchestrator — Docker-based session isolation.
 *
 * Implements the Orchestrator interface using DockerClient.
 * Each session runs in its own Docker container with:
 *   - Memory and CPU limits
 *   - Its own browse server on port 9400
 *   - A known auth token (set via BROWSE_AUTH_TOKEN env var)
 *   - Labels for tenant tracking and orphan detection
 *
 * The gateway proxies commands to each container's internal
 * browse server via the proxyCommand() HTTP function.
 */

import * as crypto from 'crypto';
import { DockerClient, type ContainerInfo } from './docker';
import type { Orchestrator, SessionHandle, FrozenSession } from './orchestrator-interface';
import { proxyCommand } from './proxy';

// ─── Constants ─────────────────────────────────────────────────

const DEFAULT_MEMORY_LIMIT = 512 * 1024 * 1024;    // 512 MB
const DEFAULT_CPU_LIMIT = 500_000_000;               // 0.5 CPU (nanoCPUs)
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const CONTAINER_BROWSE_PORT = 9400;
const CONTAINER_IDLE_TIMEOUT_MS = 300_000;           // 5 min (containers are cheaper to restart)
const LABEL_PREFIX = 'browse-cloud';
const FROZEN_IMAGE_REPO = 'browse-session-frozen';

// ─── Types ─────────────────────────────────────────────────────

export interface ContainerOrchestratorOptions {
  /** Docker client instance */
  docker: DockerClient;
  /** Docker image name for session containers */
  imageName: string;
  /** Memory limit per container in bytes (default 512 MB) */
  memoryLimit?: number;
  /** CPU limit in nanoCPUs (default 0.5 CPU = 500_000_000) */
  cpuLimit?: number;
  /** Container health check timeout in ms (default 30000) */
  healthTimeout?: number;
}

// ─── ContainerOrchestrator ─────────────────────────────────────

export class ContainerOrchestrator implements Orchestrator {
  private docker: DockerClient;
  private imageName: string;
  private memoryLimit: number;
  private cpuLimit: number;
  private healthTimeout: number;

  /** Active session handles keyed by sessionId */
  private handles = new Map<string, SessionHandle>();
  /** Session ID sets keyed by tenantId */
  private tenantHandles = new Map<string, Set<string>>();

  constructor(opts: ContainerOrchestratorOptions) {
    this.docker = opts.docker;
    this.imageName = opts.imageName;
    this.memoryLimit = opts.memoryLimit ?? DEFAULT_MEMORY_LIMIT;
    this.cpuLimit = opts.cpuLimit ?? DEFAULT_CPU_LIMIT;
    this.healthTimeout = opts.healthTimeout ?? DEFAULT_HEALTH_TIMEOUT_MS;
  }

  // ── Orchestrator interface ───────────────────────────────────

  async provision(
    tenantId: string,
    opts?: { sessionId?: string; allowedDomains?: string },
  ): Promise<SessionHandle> {
    const shortId = opts?.sessionId || crypto.randomUUID();
    const sessionId = `tenant:${tenantId}:session:${shortId}`;
    const internalToken = crypto.randomUUID();

    // Build container env vars
    const env = [
      '__BROWSE_SERVER_MODE=1',
      `BROWSE_PORT=${CONTAINER_BROWSE_PORT}`,
      `BROWSE_IDLE_TIMEOUT=${CONTAINER_IDLE_TIMEOUT_MS}`,
      `BROWSE_AUTH_TOKEN=${internalToken}`,
    ];

    if (opts?.allowedDomains) {
      env.push(`BROWSE_ALLOWED_DOMAINS=${opts.allowedDomains}`);
    }

    // Create container
    const containerId = await this.docker.create({
      image: this.imageName,
      env,
      labels: {
        [LABEL_PREFIX]: 'true',
        [`${LABEL_PREFIX}.tenant`]: tenantId,
        [`${LABEL_PREFIX}.session`]: sessionId,
        [`${LABEL_PREFIX}.created`]: new Date().toISOString(),
      },
      memory: this.memoryLimit,
      nanoCpus: this.cpuLimit,
    });

    // Start and wait for healthy
    await this.docker.start(containerId);
    const info = await this.docker.waitForHealthy(containerId, this.healthTimeout);

    // Build handle
    const handle: SessionHandle = {
      sessionId,
      tenantId,
      internalAddress: `${info.ipAddress}:${CONTAINER_BROWSE_PORT}`,
      internalToken,
      backendId: containerId,
      createdAt: new Date().toISOString(),
    };

    this.trackHandle(handle);
    return handle;
  }

  async executeCommand(
    handle: SessionHandle,
    command: string,
    args: string[],
  ): Promise<string> {
    return proxyCommand(command, args, {
      address: handle.internalAddress,
      token: handle.internalToken,
    });
  }

  async terminate(handle: SessionHandle): Promise<void> {
    try {
      await this.docker.stop(handle.backendId, 5);
    } catch {
      // Container may already be stopped — ignore
    }

    try {
      await this.docker.remove(handle.backendId, true);
    } catch {
      // Container may already be removed — ignore
    }

    this.untrackHandle(handle);
  }

  async freeze(handle: SessionHandle): Promise<FrozenSession> {
    // Commit the container state to a new image
    const imageId = await this.docker.commit(
      handle.backendId,
      FROZEN_IMAGE_REPO,
      handle.sessionId,
    );

    // Stop and remove the running container
    try {
      await this.docker.stop(handle.backendId, 5);
    } catch {
      // May already be stopped
    }

    try {
      await this.docker.remove(handle.backendId, true);
    } catch {
      // May already be removed
    }

    this.untrackHandle(handle);

    return {
      sessionId: handle.sessionId,
      tenantId: handle.tenantId,
      snapshotRef: imageId,
      frozenAt: new Date().toISOString(),
    };
  }

  async resume(tenantId: string, frozen: FrozenSession): Promise<SessionHandle> {
    const internalToken = crypto.randomUUID();

    const env = [
      '__BROWSE_SERVER_MODE=1',
      `BROWSE_PORT=${CONTAINER_BROWSE_PORT}`,
      `BROWSE_IDLE_TIMEOUT=${CONTAINER_IDLE_TIMEOUT_MS}`,
      `BROWSE_AUTH_TOKEN=${internalToken}`,
    ];

    // Create container from the frozen snapshot image
    const containerId = await this.docker.create({
      image: frozen.snapshotRef,
      env,
      labels: {
        [LABEL_PREFIX]: 'true',
        [`${LABEL_PREFIX}.tenant`]: tenantId,
        [`${LABEL_PREFIX}.session`]: frozen.sessionId,
        [`${LABEL_PREFIX}.created`]: new Date().toISOString(),
        [`${LABEL_PREFIX}.resumed-from`]: frozen.snapshotRef,
      },
      memory: this.memoryLimit,
      nanoCpus: this.cpuLimit,
    });

    await this.docker.start(containerId);
    const info = await this.docker.waitForHealthy(containerId, this.healthTimeout);

    const handle: SessionHandle = {
      sessionId: frozen.sessionId,
      tenantId,
      internalAddress: `${info.ipAddress}:${CONTAINER_BROWSE_PORT}`,
      internalToken,
      backendId: containerId,
      createdAt: new Date().toISOString(),
    };

    this.trackHandle(handle);
    return handle;
  }

  list(tenantId: string): SessionHandle[] {
    const sessionIds = this.tenantHandles.get(tenantId);
    if (!sessionIds) return [];

    const result: SessionHandle[] = [];
    for (const id of sessionIds) {
      const handle = this.handles.get(id);
      if (handle) result.push(handle);
    }
    return result;
  }

  async shutdown(): Promise<void> {
    // Terminate all active sessions in parallel
    const handles = Array.from(this.handles.values());
    await Promise.allSettled(
      handles.map((h) => this.terminate(h)),
    );
  }

  // ── Internal tracking ────────────────────────────────────────

  private trackHandle(handle: SessionHandle): void {
    this.handles.set(handle.sessionId, handle);

    let tenantSet = this.tenantHandles.get(handle.tenantId);
    if (!tenantSet) {
      tenantSet = new Set();
      this.tenantHandles.set(handle.tenantId, tenantSet);
    }
    tenantSet.add(handle.sessionId);
  }

  private untrackHandle(handle: SessionHandle): void {
    this.handles.delete(handle.sessionId);

    const tenantSet = this.tenantHandles.get(handle.tenantId);
    if (tenantSet) {
      tenantSet.delete(handle.sessionId);
      if (tenantSet.size === 0) {
        this.tenantHandles.delete(handle.tenantId);
      }
    }
  }
}
