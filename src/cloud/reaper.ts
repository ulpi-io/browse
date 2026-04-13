/**
 * Orphan container reaper — detects and removes containers with no
 * matching session in the gateway.
 *
 * Safety net for crash recovery: if the gateway process dies, its
 * containers survive. On the next gateway startup the reaper finds
 * orphaned containers (those not tracked by the orchestrator) and
 * removes them after a configurable grace period.
 *
 * All operations are best-effort — the reaper never throws from reap().
 */

import { DockerClient, type ContainerInfo } from './docker';

// ─── Constants ─────────────────────────────────────────────────

const DEFAULT_MIN_AGE_MS = 300_000;        // 5 minutes
const DEFAULT_INTERVAL_MS = 60_000;        // 60 seconds
const LABEL_PREFIX = 'browse-cloud';

// ─── Types ─────────────────────────────────────────────────────

export interface ReaperOptions {
  /** Docker client */
  docker: DockerClient;
  /** Function that returns active session backend IDs */
  getActiveIds: () => Set<string>;
  /** Minimum age before reaping (ms, default 300000 = 5 min) */
  minAgeMs?: number;
  /** Reap interval (ms, default 60000 = 60s) */
  intervalMs?: number;
  /** Also reap committed snapshot images older than TTL (ms, default 3600000 = 1 hour) */
  snapshotTtlMs?: number;
}

// ─── ContainerReaper ───────────────────────────────────────────

export class ContainerReaper {
  private docker: DockerClient;
  private getActiveIds: () => Set<string>;
  private minAgeMs: number;
  private intervalMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: ReaperOptions) {
    this.docker = opts.docker;
    this.getActiveIds = opts.getActiveIds;
    this.minAgeMs = opts.minAgeMs ?? DEFAULT_MIN_AGE_MS;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    // snapshotTtlMs accepted but not used yet — see TODO below
  }

  /** Start the periodic reap interval. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.reap().catch(() => {});
    }, this.intervalMs);
    // Don't keep the process alive just for the reaper
    this.timer.unref();
    console.log(`[browse-reaper] Started (interval=${this.intervalMs}ms, minAge=${this.minAgeMs}ms)`);
  }

  /** Stop the periodic reap interval. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[browse-reaper] Stopped');
    }
  }

  /** Run one reap cycle. Returns counts of reaped resources. */
  async reap(): Promise<{ containers: number; images: number }> {
    let containers = 0;
    const images = 0;

    try {
      containers = await this.reapContainers();
    } catch (err: any) {
      console.log(`[browse-reaper] Container reap error: ${err.message}`);
    }

    // TODO: Snapshot image reaping — DockerClient does not yet have
    // image list/remove methods. Add when image lifecycle is implemented.

    if (containers > 0) {
      console.log(`[browse-reaper] Reaped ${containers} orphan container(s)`);
    }

    return { containers, images };
  }

  /** Alias for reap() — convenient for one-shot manual invocation. */
  async reapOnce(): Promise<{ containers: number }> {
    const result = await this.reap();
    return { containers: result.containers };
  }

  // ── Internal ────────────────────────────────────────────────

  private async reapContainers(): Promise<number> {
    const containers = await this.docker.listByLabel(LABEL_PREFIX, 'true');
    const activeIds = this.getActiveIds();
    const now = Date.now();
    let reaped = 0;

    for (const container of containers) {
      // Skip containers that the orchestrator is actively tracking
      if (activeIds.has(container.id)) continue;

      // Skip containers that are too young (grace period)
      const age = this.containerAge(container, now);
      if (age < this.minAgeMs) continue;

      // Orphan detected — stop and remove (best-effort)
      try {
        console.log(
          `[browse-reaper] Reaping orphan container ${container.id.slice(0, 12)} ` +
          `(name=${container.name}, age=${Math.round(age / 1000)}s)`,
        );
        await this.docker.stop(container.id, 5).catch(() => {});
        await this.docker.remove(container.id, true);
        reaped++;
      } catch (err: any) {
        console.log(
          `[browse-reaper] Failed to reap container ${container.id.slice(0, 12)}: ${err.message}`,
        );
      }
    }

    return reaped;
  }

  /** Calculate container age in ms from the browse-cloud.created label. */
  private containerAge(info: ContainerInfo, now: number): number {
    const createdLabel = info.labels[`${LABEL_PREFIX}.created`];
    if (createdLabel) {
      const createdMs = new Date(createdLabel).getTime();
      if (!isNaN(createdMs)) {
        return now - createdMs;
      }
    }

    // If no valid created label, treat as old enough to reap
    // (use minAgeMs as the assumed age so it passes the threshold)
    return this.minAgeMs;
  }
}
