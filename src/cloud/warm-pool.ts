/**
 * Warm container pool — pre-started containers ready for instant claiming.
 *
 * Maintains a pool of Docker containers that have already been started
 * and passed health checks. When a session is provisioned, the orchestrator
 * can claim a container from the pool instead of creating one from scratch,
 * reducing session startup latency from ~5s to near-zero.
 *
 * Pool lifecycle:
 *   1. startReplenishing() fills the pool to targetSize and keeps it full
 *   2. claim() takes a container from the pool (FIFO)
 *   3. replenish() runs periodically and on-demand when pool drops below 50%
 *   4. drain() stops all pool containers and clears the pool
 *
 * Pool containers use a longer idle timeout (10 min) than session containers
 * (5 min) to allow more time before self-exit while waiting to be claimed.
 */

import * as crypto from 'crypto';
import { DockerClient } from './docker';

// ─── Constants ─────────────────────────────────────────────────

const DEFAULT_TARGET_SIZE = 5;
const DEFAULT_REPLENISH_INTERVAL_MS = 30_000;
const DEFAULT_MEMORY_LIMIT = 512 * 1024 * 1024;      // 512 MB
const DEFAULT_CPU_LIMIT = 500_000_000;                 // 0.5 CPU (nanoCPUs)
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const POOL_IDLE_TIMEOUT_MS = 600_000;                  // 10 min
const CONTAINER_BROWSE_PORT = 9400;
const POOL_REPLENISH_THRESHOLD = 0.5;                  // trigger replenish at 50%

// ─── Types ─────────────────────────────────────────────────────

export interface WarmPoolOptions {
  /** Docker client instance */
  docker: DockerClient;
  /** Docker image name */
  imageName: string;
  /** Target pool size (default 5) */
  targetSize?: number;
  /** Replenish interval in ms (default 30000) */
  replenishInterval?: number;
  /** Memory limit per container in bytes (default 512MB) */
  memoryLimit?: number;
  /** CPU limit in nanoCPUs (default 500000000) */
  cpuLimit?: number;
  /** Health check timeout in ms (default 30000) */
  healthTimeout?: number;
}

export interface PoolEntry {
  containerId: string;
  internalAddress: string;
  token: string;
  createdAt: string;
}

// ─── WarmPool ──────────────────────────────────────────────────

export class WarmPool {
  private docker: DockerClient;
  private imageName: string;
  private targetSize: number;
  private replenishInterval: number;
  private memoryLimit: number;
  private cpuLimit: number;
  private healthTimeout: number;

  private pool: PoolEntry[] = [];
  private replenishTimer: ReturnType<typeof setInterval> | null = null;
  private isReplenishing = false;

  constructor(opts: WarmPoolOptions) {
    this.docker = opts.docker;
    this.imageName = opts.imageName;
    this.targetSize = opts.targetSize ?? DEFAULT_TARGET_SIZE;
    this.replenishInterval = opts.replenishInterval ?? DEFAULT_REPLENISH_INTERVAL_MS;
    this.memoryLimit = opts.memoryLimit ?? DEFAULT_MEMORY_LIMIT;
    this.cpuLimit = opts.cpuLimit ?? DEFAULT_CPU_LIMIT;
    this.healthTimeout = opts.healthTimeout ?? DEFAULT_HEALTH_TIMEOUT_MS;
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Claim a pre-started container from the pool.
   * Returns container info or null if the pool is empty.
   * Triggers background replenish if pool drops below 50% of target.
   */
  claim(): PoolEntry | null {
    const entry = this.pool.shift() ?? null;

    if (entry) {
      console.log(
        `[browse-pool] Claimed container ${entry.containerId.slice(0, 12)}, ` +
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
   * Creates containers in parallel. Failures are logged but not thrown.
   * Skips if already replenishing (guard against concurrent runs).
   */
  async replenish(): Promise<void> {
    if (this.isReplenishing) return;

    const needed = this.targetSize - this.pool.length;
    if (needed <= 0) return;

    this.isReplenishing = true;
    console.log(`[browse-pool] Replenishing ${needed} container(s) (pool: ${this.pool.length}/${this.targetSize})`);

    try {
      const promises = Array.from({ length: needed }, () => this.createPoolContainer());
      const results = await Promise.allSettled(promises);

      let added = 0;
      for (const result of results) {
        if (result.status === 'fulfilled') {
          this.pool.push(result.value);
          added++;
        } else {
          console.log(`[browse-pool] Failed to create pool container: ${result.reason}`);
        }
      }

      if (added > 0) {
        console.log(`[browse-pool] Added ${added} container(s), pool: ${this.pool.length}/${this.targetSize}`);
      }
    } finally {
      this.isReplenishing = false;
    }
  }

  /** Current number of ready containers in the pool. */
  size(): number {
    return this.pool.length;
  }

  /**
   * Drain the pool — stop and remove all pool containers.
   * Clears the replenish timer. Best-effort cleanup.
   */
  async drain(): Promise<void> {
    this.stopReplenishing();

    const entries = this.pool.splice(0);
    if (entries.length === 0) return;

    console.log(`[browse-pool] Draining ${entries.length} pool container(s)`);

    await Promise.allSettled(
      entries.map(async (entry) => {
        try {
          await this.docker.stop(entry.containerId, 5);
        } catch {
          // Container may already be stopped
        }
        try {
          await this.docker.remove(entry.containerId, true);
        } catch {
          // Container may already be removed
        }
      }),
    );

    console.log('[browse-pool] Pool drained');
  }

  /**
   * Start the periodic replenish timer.
   * Fills the pool immediately on first call.
   */
  startReplenishing(): void {
    // Fill pool immediately
    void this.replenish();

    // Start periodic replenish
    if (this.replenishTimer === null) {
      this.replenishTimer = setInterval(() => {
        void this.replenish();
      }, this.replenishInterval);

      // Unref the timer so it doesn't keep the process alive
      if (this.replenishTimer && typeof this.replenishTimer === 'object' && 'unref' in this.replenishTimer) {
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
   * Create a single pool container: generate token, create, start,
   * wait for healthy, inspect for IP address.
   */
  private async createPoolContainer(): Promise<PoolEntry> {
    const token = crypto.randomUUID();

    const containerId = await this.docker.create({
      image: this.imageName,
      env: [
        '__BROWSE_SERVER_MODE=1',
        `BROWSE_PORT=${CONTAINER_BROWSE_PORT}`,
        `BROWSE_IDLE_TIMEOUT=${POOL_IDLE_TIMEOUT_MS}`,
        `BROWSE_AUTH_TOKEN=${token}`,
      ],
      labels: {
        'browse-cloud': 'true',
        'browse-pool': 'warm',
      },
      memory: this.memoryLimit,
      nanoCpus: this.cpuLimit,
    });

    await this.docker.start(containerId);
    const info = await this.docker.waitForHealthy(containerId, this.healthTimeout);

    return {
      containerId,
      internalAddress: `${info.ipAddress}:${CONTAINER_BROWSE_PORT}`,
      token,
      createdAt: new Date().toISOString(),
    };
  }
}
