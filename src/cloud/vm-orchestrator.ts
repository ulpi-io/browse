/**
 * VM orchestrator — Firecracker microVM-based session isolation.
 *
 * Implements the Orchestrator interface using FirecrackerClient.
 * Each session runs in its own microVM with:
 *   - Dedicated kernel + rootfs image
 *   - Its own browse server on port 9400
 *   - A known auth token (passed via kernel boot args or init script)
 *   - Network isolation via tap devices
 *
 * The gateway proxies commands to each VM's internal browse server
 * via the proxyCommand() HTTP function.
 *
 * IP assignment: simplified counter-based scheme using 172.16.0.0/24.
 * Host-side tap devices all share 172.16.0.1; each guest gets
 * 172.16.0.{N} where N increments per VM. Production deployments
 * should use proper network namespaces with per-VM subnets.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { FirecrackerClient, type VmConfig } from './firecracker';
import type { Orchestrator, SessionHandle, FrozenSession } from './orchestrator-interface';
import { proxyCommand } from './proxy';

// ─── Constants ─────────────────────────────────────────────────

const DEFAULT_MEM_SIZE_MB = 512;
const DEFAULT_VCPU_COUNT = 1;
const DEFAULT_BROWSE_PORT = 9400;
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const DEFAULT_SNAPSHOT_DIR = '/var/lib/browse-cloud/snapshots';
const HEALTH_POLL_INTERVAL_MS = 200;

// ─── Types ─────────────────────────────────────────────────────

export interface VmOrchestratorOptions {
  /** Firecracker client */
  firecracker: FirecrackerClient;
  /** Path to vmlinux kernel */
  kernelPath: string;
  /** Path to rootfs ext4 image */
  rootfsPath: string;
  /** Memory per VM in MB (default 512) */
  memSizeMb?: number;
  /** vCPUs per VM (default 1) */
  vcpuCount?: number;
  /** Browse server port inside VM (default 9400) */
  browsePort?: number;
  /** Health check timeout in ms (default 30000) */
  healthTimeout?: number;
  /** Directory for snapshot files (default /var/lib/browse-cloud/snapshots) */
  snapshotDir?: string;
  /** Optional warm pool (compatible with WarmPool.claim/drain interface) */
  pool?: { claim(): { internalAddress: string; token: string; vmId: string } | null; drain(): Promise<void> } | null;
}

/** Extended handle that tracks the VM ID alongside the standard SessionHandle fields. */
interface VmSessionHandle extends SessionHandle {
  vmId: string;
}

// ─── VmOrchestrator ───────────────────────────────────────────

export class VmOrchestrator implements Orchestrator {
  private firecracker: FirecrackerClient;
  private kernelPath: string;
  private rootfsPath: string;
  private memSizeMb: number;
  private vcpuCount: number;
  private browsePort: number;
  private healthTimeout: number;
  private snapshotDir: string;
  private pool: VmOrchestratorOptions['pool'];

  /** Active session handles keyed by sessionId */
  private handles = new Map<string, VmSessionHandle>();
  /** Session ID sets keyed by tenantId */
  private tenantHandles = new Map<string, Set<string>>();

  /**
   * Counter-based IP suffix for guest IPs.
   * Starts at 2 (172.16.0.2) and increments per VM.
   * Wraps at 254 to stay within a /24 subnet.
   *
   * NOTE: This simplified scheme assumes no more than ~252 concurrent VMs.
   * Production deployments should use per-VM network namespaces with
   * dedicated subnets (e.g., 172.16.{X}.2 per VM).
   */
  private nextIpSuffix = 2;

  constructor(opts: VmOrchestratorOptions) {
    this.firecracker = opts.firecracker;
    this.kernelPath = opts.kernelPath;
    this.rootfsPath = opts.rootfsPath;
    this.memSizeMb = opts.memSizeMb ?? DEFAULT_MEM_SIZE_MB;
    this.vcpuCount = opts.vcpuCount ?? DEFAULT_VCPU_COUNT;
    this.browsePort = opts.browsePort ?? DEFAULT_BROWSE_PORT;
    this.healthTimeout = opts.healthTimeout ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.snapshotDir = opts.snapshotDir ?? DEFAULT_SNAPSHOT_DIR;
    this.pool = opts.pool ?? null;
  }

  // ── Orchestrator interface ───────────────────────────────────

  async provision(
    tenantId: string,
    opts?: { sessionId?: string; allowedDomains?: string },
  ): Promise<SessionHandle> {
    const shortId = opts?.sessionId || crypto.randomUUID();
    const sessionId = `tenant:${tenantId}:session:${shortId}`;

    // Try claiming a pre-started VM from the warm pool
    const poolEntry = this.pool?.claim() ?? null;
    if (poolEntry) {
      const handle: VmSessionHandle = {
        sessionId,
        tenantId,
        internalAddress: poolEntry.internalAddress,
        internalToken: poolEntry.token,
        backendId: poolEntry.vmId,
        vmId: poolEntry.vmId,
        createdAt: new Date().toISOString(),
      };
      this.trackHandle(handle);
      console.log(`[browse-cloud] Session "${sessionId}" claimed VM ${poolEntry.vmId} from pool`);
      return handle;
    }

    // Fall back to direct VM creation
    const vmId = `vm-${crypto.randomUUID().slice(0, 8)}`;
    const internalToken = crypto.randomUUID();
    const guestIp = this.allocateGuestIp();
    const tapDevice = `tap-${vmId.slice(0, 8)}`;

    // Create and configure the microVM
    await this.firecracker.createVm(vmId, {
      kernelPath: this.kernelPath,
      rootfsPath: this.rootfsPath,
      memSizeMb: this.memSizeMb,
      vcpuCount: this.vcpuCount,
      network: {
        tapDevice,
      },
    });

    // Start the VM
    await this.firecracker.startVm(vmId);

    // Wait for the browse server inside the VM to become healthy
    const internalAddress = `${guestIp}:${this.browsePort}`;
    try {
      await this.waitForHealth(guestIp, this.browsePort, this.healthTimeout);
    } catch (err) {
      // Clean up on health check failure
      await this.firecracker.stopVm(vmId).catch(() => {});
      throw err;
    }

    // Build handle
    const handle: VmSessionHandle = {
      sessionId,
      tenantId,
      internalAddress,
      internalToken,
      backendId: vmId,
      vmId,
      createdAt: new Date().toISOString(),
    };

    this.trackHandle(handle);
    console.log(`[browse-cloud] Session "${sessionId}" provisioned in VM ${vmId} (${internalAddress})`);
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
    const vmHandle = this.handles.get(handle.sessionId);
    const vmId = vmHandle?.vmId ?? handle.backendId;

    try {
      await this.firecracker.stopVm(vmId);
    } catch {
      // VM may already be stopped — ignore
    }

    this.untrackHandle(handle);
    console.log(`[browse-cloud] Session "${handle.sessionId}" terminated (VM ${vmId})`);
  }

  async freeze(handle: SessionHandle): Promise<FrozenSession> {
    const vmHandle = this.handles.get(handle.sessionId);
    const vmId = vmHandle?.vmId ?? handle.backendId;

    // Create snapshot directory
    const snapshotSessionDir = path.join(this.snapshotDir, handle.sessionId.replace(/:/g, '_'));
    fs.mkdirSync(snapshotSessionDir, { recursive: true });

    const snapshotPath = path.join(snapshotSessionDir, 'snapshot');
    const memPath = path.join(snapshotSessionDir, 'memory');

    // Pause the VM (required before snapshot)
    await this.firecracker.pauseVm(vmId);

    // Create full snapshot
    await this.firecracker.snapshotVm(vmId, snapshotPath, memPath);

    // Stop and clean up the running VM
    try {
      await this.firecracker.stopVm(vmId);
    } catch {
      // May already be stopped
    }

    this.untrackHandle(handle);

    const frozen: FrozenSession = {
      sessionId: handle.sessionId,
      tenantId: handle.tenantId,
      snapshotRef: snapshotSessionDir,
      frozenAt: new Date().toISOString(),
    };

    console.log(`[browse-cloud] Session "${handle.sessionId}" frozen to ${snapshotSessionDir}`);
    return frozen;
  }

  async resume(tenantId: string, frozen: FrozenSession): Promise<SessionHandle> {
    const vmId = `vm-${crypto.randomUUID().slice(0, 8)}`;
    const internalToken = crypto.randomUUID();
    const guestIp = this.allocateGuestIp();

    const snapshotPath = path.join(frozen.snapshotRef, 'snapshot');
    const memPath = path.join(frozen.snapshotRef, 'memory');

    // Restore from snapshot (spawns new Firecracker process + loads state)
    await this.firecracker.restoreVm(vmId, snapshotPath, memPath);

    // Wait for the browse server to be healthy after restore
    const internalAddress = `${guestIp}:${this.browsePort}`;
    try {
      await this.waitForHealth(guestIp, this.browsePort, this.healthTimeout);
    } catch (err) {
      await this.firecracker.stopVm(vmId).catch(() => {});
      throw err;
    }

    const handle: VmSessionHandle = {
      sessionId: frozen.sessionId,
      tenantId,
      internalAddress,
      internalToken,
      backendId: vmId,
      vmId,
      createdAt: new Date().toISOString(),
    };

    this.trackHandle(handle);
    console.log(`[browse-cloud] Session "${frozen.sessionId}" resumed in VM ${vmId} (${internalAddress})`);
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
    // Drain the warm pool first (if configured)
    if (this.pool) {
      try {
        await this.pool.drain();
      } catch {
        // Best-effort pool drain
      }
    }

    // Stop all active VMs in parallel
    const handles = Array.from(this.handles.values());
    await Promise.allSettled(
      handles.map((h) => this.firecracker.stopVm(h.vmId).catch(() => {})),
    );

    this.handles.clear();
    this.tenantHandles.clear();
  }

  // ── Public helpers (reaper integration) ─────────────────────

  /** Return all active VM IDs tracked by this orchestrator. */
  getActiveVmIds(): Set<string> {
    const ids = new Set<string>();
    for (const handle of this.handles.values()) {
      ids.add(handle.vmId);
    }
    return ids;
  }

  // ── Internal tracking ────────────────────────────────────────

  private trackHandle(handle: VmSessionHandle): void {
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

  // ── Network helpers ──────────────────────────────────────────

  /**
   * Allocate a guest IP address using counter-based scheme.
   *
   * Returns IPs in the 172.16.0.0/24 range starting from 172.16.0.2.
   * Wraps at 254 to avoid broadcast address.
   *
   * NOTE: Production should use per-VM network namespaces with
   * dedicated subnets for proper isolation.
   */
  private allocateGuestIp(): string {
    const suffix = this.nextIpSuffix;
    this.nextIpSuffix = this.nextIpSuffix >= 254 ? 2 : this.nextIpSuffix + 1;
    return `172.16.0.${suffix}`;
  }

  // ── Health check ─────────────────────────────────────────────

  /**
   * Poll the browse server's /health endpoint until it responds.
   *
   * Uses native http.get with a short timeout per attempt.
   * Throws if the server doesn't become healthy within the deadline.
   */
  private async waitForHealth(host: string, port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const healthy = await this.checkHealth(host, port);
      if (healthy) return;
      await sleep(HEALTH_POLL_INTERVAL_MS);
    }

    throw new Error(
      `VM health check timed out after ${timeoutMs}ms (${host}:${port})`,
    );
  }

  /**
   * Single health check attempt — returns true if the browse server
   * responds with HTTP 200, false otherwise.
   */
  private checkHealth(host: string, port: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const req = http.get(
        { hostname: host, port, path: '/health', timeout: 2000 },
        (res) => {
          // Consume response body to free the socket
          res.resume();
          resolve(res.statusCode === 200);
        },
      );

      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
  }
}

// ─── Utilities ─────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
