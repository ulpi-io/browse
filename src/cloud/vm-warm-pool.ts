/**
 * VM warm pool — pre-cloned paused VMs ready for near-instant claiming.
 *
 * Unlike the container warm pool (which pre-starts containers and waits
 * for health checks), the VM warm pool clones from the golden snapshot
 * and immediately pauses the VMs. Claiming a VM is just a resume call
 * — sub-100ms startup.
 *
 * Pool lifecycle:
 *   1. startReplenishing() fills the pool to targetSize and keeps it full
 *   2. claim() takes a paused VM from the pool (FIFO)
 *   3. replenish() runs periodically and on-demand when pool drops below 50%
 *   4. drain() stops all paused VMs and clears the pool
 *
 * Paused VMs consume memory but no CPU — much cheaper than running containers.
 * The golden snapshot must be built before the pool can fill.
 *
 * All clones share the same auth token from the golden snapshot build.
 * The caller (VmOrchestrator) is responsible for resuming the VM,
 * setting up networking, and running health checks.
 */

import * as crypto from 'crypto';
import { FirecrackerClient } from './firecracker';
import { GoldenSnapshotManager } from './golden-snapshot';

// ─── Constants ─────────────────────────────────────────────────

const DEFAULT_TARGET_SIZE = 10;
const DEFAULT_REPLENISH_INTERVAL_MS = 30_000;
const DEFAULT_BROWSE_PORT = 9400;
const POOL_REPLENISH_THRESHOLD = 0.5; // trigger replenish at 50%

// ─── Types ─────────────────────────────────────────────────────

export interface VmWarmPoolOptions {
  /** Firecracker client */
  firecracker: FirecrackerClient;
  /** Golden snapshot manager (must be ready before pool can fill) */
  golden: GoldenSnapshotManager;
  /** Target pool size (default 10 -- VMs are cheap to hold paused) */
  targetSize?: number;
  /** Replenish check interval in ms (default 30000) */
  replenishInterval?: number;
  /** Browse server port in the VM (default 9400) */
  browsePort?: number;
}

export interface VmPoolEntry {
  /** Firecracker VM ID */
  vmId: string;
  /** Auth token (set during golden build, same for all clones) */
  token: string;
  /** When this clone was created */
  createdAt: string;
}

// ─── VmWarmPool ───────────────────────────────────────────────

export class VmWarmPool {
  private firecracker: FirecrackerClient;
  private golden: GoldenSnapshotManager;
  private targetSize: number;
  private replenishInterval: number;
  private browsePort: number;

  private pool: VmPoolEntry[] = [];
  private replenishTimer: ReturnType<typeof setInterval> | null = null;
  private isReplenishing = false;

  constructor(opts: VmWarmPoolOptions) {
    this.firecracker = opts.firecracker;
    this.golden = opts.golden;
    this.targetSize = opts.targetSize ?? DEFAULT_TARGET_SIZE;
    this.replenishInterval = opts.replenishInterval ?? DEFAULT_REPLENISH_INTERVAL_MS;
    this.browsePort = opts.browsePort ?? DEFAULT_BROWSE_PORT;
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Claim a pre-cloned paused VM from the pool.
   * Returns VM info or null if the pool is empty.
   * Triggers background replenish if pool drops below 50% of target.
   *
   * The caller is responsible for:
   *   - Setting up the tap device / network for the VM
   *   - Resuming the VM via firecracker.resumeVm()
   *   - Waiting for the browse server health check
   */
  claim(): VmPoolEntry | null {
    const entry = this.pool.shift() ?? null;

    if (entry) {
      console.log(
        `[browse-vm-pool] Claimed VM ${entry.vmId}, ` +
        `pool: ${this.pool.length}/${this.targetSize}`,
      );

      // Trigger background replenish if below threshold
      if (this.pool.length < this.targetSize * POOL_REPLENISH_THRESHOLD) {
        void this.replenish();
      }
    }

    return entry;
  }

  /**
   * Replenish the pool to target size.
   * Clones VMs from the golden snapshot in parallel.
   * Each clone is paused immediately after creation to save CPU.
   *
   * Skips if:
   *   - Already replenishing (guard against concurrent runs)
   *   - Golden snapshot is not ready
   *   - Pool is already at target size
   */
  async replenish(): Promise<void> {
    if (this.isReplenishing) return;

    if (!this.golden.isReady()) {
      console.log('[browse-vm-pool] Golden snapshot not ready, skipping replenish');
      return;
    }

    const needed = this.targetSize - this.pool.length;
    if (needed <= 0) return;

    this.isReplenishing = true;
    console.log(
      `[browse-vm-pool] Replenishing ${needed} VM(s) ` +
      `(pool: ${this.pool.length}/${this.targetSize})`,
    );

    try {
      const promises = Array.from({ length: needed }, () => this.createPoolVm());
      const results = await Promise.allSettled(promises);

      let added = 0;
      for (const result of results) {
        if (result.status === 'fulfilled') {
          this.pool.push(result.value);
          added++;
        } else {
          console.log(
            `[browse-vm-pool] Failed to create pool VM: ${result.reason}`,
          );
        }
      }

      if (added > 0) {
        console.log(
          `[browse-vm-pool] Added ${added} VM(s), ` +
          `pool: ${this.pool.length}/${this.targetSize}`,
        );
      }
    } finally {
      this.isReplenishing = false;
    }
  }

  /** Current number of paused VMs ready in the pool. */
  size(): number {
    return this.pool.length;
  }

  /**
   * Drain the pool -- stop all paused VMs and clear the pool.
   * Clears the replenish timer. All operations are best-effort.
   */
  async drain(): Promise<void> {
    this.stopReplenishing();

    const entries = this.pool.splice(0);
    if (entries.length === 0) return;

    console.log(`[browse-vm-pool] Draining ${entries.length} pool VM(s)`);

    await Promise.allSettled(
      entries.map(async (entry) => {
        try {
          await this.firecracker.stopVm(entry.vmId);
        } catch {
          // VM may already be stopped -- ignore
        }
      }),
    );

    console.log('[browse-vm-pool] Pool drained');
  }

  /**
   * Start the periodic replenish timer.
   * If the golden snapshot is not ready, logs a warning and returns
   * without starting. Can be called again later when golden is ready.
   * Fills the pool immediately on first successful call.
   */
  startReplenishing(): void {
    if (!this.golden.isReady()) {
      console.log(
        '[browse-vm-pool] Golden snapshot not ready, cannot start replenishing. ' +
        'Call startReplenishing() again after golden.build() completes.',
      );
      return;
    }

    // Fill pool immediately
    void this.replenish();

    // Start periodic replenish
    if (this.replenishTimer === null) {
      this.replenishTimer = setInterval(() => {
        void this.replenish();
      }, this.replenishInterval);

      // Unref the timer so it doesn't keep the process alive
      if (
        this.replenishTimer &&
        typeof this.replenishTimer === 'object' &&
        'unref' in this.replenishTimer
      ) {
        this.replenishTimer.unref();
      }
    }
  }

  /** Stop the periodic replenish timer. */
  stopReplenishing(): void {
    if (this.replenishTimer !== null) {
      clearInterval(this.replenishTimer);
      this.replenishTimer = null;
    }
  }

  // ── Private helpers ─────────────────────────────────────────

  /**
   * Create a single pool VM: clone from golden snapshot, then pause.
   *
   * golden.clone() calls restoreVm() which spawns a Firecracker process,
   * loads the snapshot, and resumes the VM. We immediately pause it so
   * it consumes memory but no CPU while waiting to be claimed.
   *
   * The auth token is shared across all clones since they all inherit
   * the same browse server state from the golden snapshot.
   */
  private async createPoolVm(): Promise<VmPoolEntry> {
    const vmId = `vm-pool-${crypto.randomUUID().slice(0, 8)}`;

    // Clone from golden snapshot (VM comes out running after restore)
    await this.golden.clone(vmId);

    // Immediately pause -- save CPU while waiting to be claimed
    await this.firecracker.pauseVm(vmId);

    // The golden snapshot was built with a known BROWSE_AUTH_TOKEN
    // injected via boot args. All clones inherit this token since the
    // browse server's in-memory state is captured in the snapshot.
    // GoldenSnapshotManager.authToken exposes it.
    return {
      vmId,
      token: this.golden.authToken,
      createdAt: new Date().toISOString(),
    };
  }
}
