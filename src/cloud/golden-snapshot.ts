/**
 * Golden snapshot manager — builds and manages a pre-warmed VM snapshot
 * for near-instant (<200ms) VM provisioning via Firecracker restore.
 *
 * Golden snapshot flow:
 *   1. build()    — boot a fresh VM, launch Chromium, wait for health,
 *                   pause, snapshot memory + state to disk
 *   2. clone(id)  — restore a new VM from the golden snapshot
 *   3. rebuild()  — delete old snapshot and rebuild from scratch
 *
 * The golden snapshot captures a fully-booted VM with Chromium running
 * and the browse server healthy. Cloning from this snapshot skips the
 * entire boot + browser launch sequence (~5-10s → <200ms).
 *
 * Host setup requirements (for health-check mode):
 *   - Tap device `tap-golden` with host IP 172.16.0.1/24
 *   - iptables/nftables rules for NAT if the VM needs internet
 *   - VmConfig.network must be set with tapDevice: 'tap-golden'
 *
 * Without network, the manager waits a fixed boot time (5s) instead.
 *
 * Snapshot files are stored at 0o600 for security:
 *   {snapshotDir}/snapshot           — VM state (CPU, devices)
 *   {snapshotDir}/memory             — Full memory image (~memSizeMb)
 *   {snapshotDir}/golden-metadata.json — Build metadata for validation
 */

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { FirecrackerClient, type VmConfig } from './firecracker';

// ─── Constants ─────────────────────────────────────────────────

const DEFAULT_SNAPSHOT_DIR = '/var/lib/browse-cloud/golden';
const DEFAULT_MEM_SIZE_MB = 512;
const DEFAULT_VCPU_COUNT = 1;
const DEFAULT_BROWSE_PORT = 9400;
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 500;
const NO_NETWORK_BOOT_WAIT_MS = 5000;
const GOLDEN_BUILD_VM_IP = '172.16.0.100';
const METADATA_VERSION = 1;

// ─── Types ─────────────────────────────────────────────────────

export interface GoldenSnapshotOptions {
  /** Firecracker client */
  firecracker: FirecrackerClient;
  /** Path to vmlinux kernel */
  kernelPath: string;
  /** Path to rootfs ext4 image */
  rootfsPath: string;
  /** Directory to store golden snapshot files (default /var/lib/browse-cloud/golden) */
  snapshotDir?: string;
  /** Memory per VM in MB (default 512) */
  memSizeMb?: number;
  /** vCPUs per VM (default 1) */
  vcpuCount?: number;
  /** Browse server port inside VM (default 9400) */
  browsePort?: number;
  /** Health check timeout for the golden VM in ms (default 30000) */
  healthTimeout?: number;
  /** Network config for the golden build VM (optional — skips health check if absent) */
  network?: VmConfig['network'];
}

interface GoldenMetadata {
  version: number;
  builtAt: string;
  kernelPath: string;
  rootfsPath: string;
  memSizeMb: number;
  vcpuCount: number;
  browsePort: number;
  buildDurationMs: number;
}

// ─── GoldenSnapshotManager ────────────────────────────────────

export class GoldenSnapshotManager {
  private firecracker: FirecrackerClient;
  private kernelPath: string;
  private rootfsPath: string;
  private snapshotDir: string;
  private memSizeMb: number;
  private vcpuCount: number;
  private browsePort: number;
  private healthTimeout: number;
  private network: VmConfig['network'] | undefined;

  private ready = false;
  private snapshotPath: string;
  private memPath: string;
  private metadataPath: string;

  constructor(opts: GoldenSnapshotOptions) {
    this.firecracker = opts.firecracker;
    this.kernelPath = opts.kernelPath;
    this.rootfsPath = opts.rootfsPath;
    this.snapshotDir = opts.snapshotDir ?? DEFAULT_SNAPSHOT_DIR;
    this.memSizeMb = opts.memSizeMb ?? DEFAULT_MEM_SIZE_MB;
    this.vcpuCount = opts.vcpuCount ?? DEFAULT_VCPU_COUNT;
    this.browsePort = opts.browsePort ?? DEFAULT_BROWSE_PORT;
    this.healthTimeout = opts.healthTimeout ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.network = opts.network;

    this.snapshotPath = path.join(this.snapshotDir, 'snapshot');
    this.memPath = path.join(this.snapshotDir, 'memory');
    this.metadataPath = path.join(this.snapshotDir, 'golden-metadata.json');
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Build the golden snapshot from scratch.
   *
   * Boots a fresh VM, waits for the browse server to become healthy
   * (or waits a fixed time if no network is configured), pauses the VM,
   * and snapshots its memory + state to disk.
   *
   * This is a heavy operation (~10-30s) and should only be done once
   * or when kernel/rootfs changes require a rebuild.
   */
  async build(): Promise<void> {
    const startTime = Date.now();
    const vmId = `golden-build-${Date.now()}`;

    console.log('[browse-golden] Building golden snapshot...');
    console.log(`[browse-golden]   kernel:  ${this.kernelPath}`);
    console.log(`[browse-golden]   rootfs:  ${this.rootfsPath}`);
    console.log(`[browse-golden]   memory:  ${this.memSizeMb} MB`);
    console.log(`[browse-golden]   vcpus:   ${this.vcpuCount}`);
    console.log(`[browse-golden]   output:  ${this.snapshotDir}`);

    // Ensure snapshot directory exists
    fs.mkdirSync(this.snapshotDir, { recursive: true, mode: 0o700 });

    const vmConfig: VmConfig = {
      kernelPath: this.kernelPath,
      rootfsPath: this.rootfsPath,
      memSizeMb: this.memSizeMb,
      vcpuCount: this.vcpuCount,
      network: this.network,
    };

    try {
      // 1. Create and start the VM
      console.log(`[browse-golden] Creating VM ${vmId}...`);
      await this.firecracker.createVm(vmId, vmConfig);

      console.log(`[browse-golden] Starting VM ${vmId}...`);
      await this.firecracker.startVm(vmId);

      // 2. Wait for the browse server to become healthy
      if (this.network) {
        console.log(
          `[browse-golden] Waiting for browse server health at ` +
          `${GOLDEN_BUILD_VM_IP}:${this.browsePort}...`,
        );
        await this.waitForHealth(GOLDEN_BUILD_VM_IP, this.browsePort, this.healthTimeout);
        console.log('[browse-golden] Browse server is healthy');
      } else {
        console.log(
          `[browse-golden] No network configured — waiting ${NO_NETWORK_BOOT_WAIT_MS}ms ` +
          `for server boot...`,
        );
        await sleep(NO_NETWORK_BOOT_WAIT_MS);
        console.log('[browse-golden] Boot wait complete');
      }

      // 3. Pause the VM before snapshotting
      console.log(`[browse-golden] Pausing VM ${vmId}...`);
      await this.firecracker.pauseVm(vmId);

      // 4. Create the snapshot
      console.log('[browse-golden] Creating snapshot...');
      await this.firecracker.snapshotVm(vmId, this.snapshotPath, this.memPath);

      // Set restrictive permissions on snapshot files
      fs.chmodSync(this.snapshotPath, 0o600);
      fs.chmodSync(this.memPath, 0o600);

      // 5. Stop the build VM — no longer needed
      console.log(`[browse-golden] Stopping build VM ${vmId}...`);
      await this.firecracker.stopVm(vmId);

      // 6. Write metadata
      const buildDurationMs = Date.now() - startTime;
      const metadata: GoldenMetadata = {
        version: METADATA_VERSION,
        builtAt: new Date().toISOString(),
        kernelPath: this.kernelPath,
        rootfsPath: this.rootfsPath,
        memSizeMb: this.memSizeMb,
        vcpuCount: this.vcpuCount,
        browsePort: this.browsePort,
        buildDurationMs,
      };

      fs.writeFileSync(this.metadataPath, JSON.stringify(metadata, null, 2), {
        mode: 0o600,
      });

      this.ready = true;
      console.log(
        `[browse-golden] Golden snapshot built in ${buildDurationMs}ms`,
      );
    } catch (err) {
      // Best-effort cleanup of the build VM on failure
      console.log(`[browse-golden] Build failed, cleaning up VM ${vmId}...`);
      await this.firecracker.stopVm(vmId).catch(() => {});
      throw err;
    }
  }

  /**
   * Create a new VM from the golden snapshot.
   *
   * Calls `firecracker.restoreVm()` which spawns a new Firecracker process,
   * loads the snapshot, and resumes the VM. The restored VM is fully running
   * with the browse server ready after this call.
   *
   * @param vmId - Unique identifier for the cloned VM
   */
  async clone(vmId: string): Promise<void> {
    if (!this.ready) {
      throw new Error(
        '[browse-golden] Cannot clone — golden snapshot not ready. ' +
        'Call build() or loadFromDisk() first.',
      );
    }

    const startTime = Date.now();
    console.log(`[browse-golden] Cloning VM ${vmId} from golden snapshot...`);

    await this.firecracker.restoreVm(vmId, this.snapshotPath, this.memPath);

    const cloneDurationMs = Date.now() - startTime;
    console.log(`[browse-golden] VM ${vmId} cloned in ${cloneDurationMs}ms`);
  }

  /**
   * Rebuild the golden snapshot from scratch.
   *
   * Deletes existing snapshot files and builds a new one.
   * Use this when kernel or rootfs has been updated.
   */
  async rebuild(): Promise<void> {
    console.log('[browse-golden] Rebuilding golden snapshot...');

    // Delete existing snapshot files
    this.deleteSnapshotFiles();
    this.ready = false;

    await this.build();
  }

  /**
   * Check if the golden snapshot is ready for cloning.
   *
   * Returns true if the snapshot has been built or loaded from disk,
   * AND the snapshot files still exist on disk.
   */
  isReady(): boolean {
    if (this.ready) {
      // Verify files still exist (may have been deleted externally)
      return this.snapshotFilesExist();
    }
    return false;
  }

  /**
   * Attempt to load an existing golden snapshot from disk.
   *
   * If snapshot files and metadata exist from a previous build,
   * loads them without rebuilding. This allows recovery after
   * a gateway restart without the cost of a full rebuild.
   *
   * @returns true if a valid snapshot was found and loaded
   */
  loadFromDisk(): boolean {
    if (!this.snapshotFilesExist()) {
      return false;
    }

    try {
      const raw = fs.readFileSync(this.metadataPath, 'utf8');
      const metadata = JSON.parse(raw) as GoldenMetadata;

      // Validate metadata version
      if (metadata.version !== METADATA_VERSION) {
        console.log(
          `[browse-golden] Stale metadata version ${metadata.version}, ` +
          `expected ${METADATA_VERSION} — snapshot needs rebuild`,
        );
        return false;
      }

      // Validate that kernel and rootfs paths match current config
      if (metadata.kernelPath !== this.kernelPath) {
        console.log(
          '[browse-golden] Kernel path mismatch — snapshot needs rebuild ' +
          `(snapshot: ${metadata.kernelPath}, current: ${this.kernelPath})`,
        );
        return false;
      }

      if (metadata.rootfsPath !== this.rootfsPath) {
        console.log(
          '[browse-golden] Rootfs path mismatch — snapshot needs rebuild ' +
          `(snapshot: ${metadata.rootfsPath}, current: ${this.rootfsPath})`,
        );
        return false;
      }

      this.ready = true;
      console.log(
        `[browse-golden] Loaded existing golden snapshot ` +
        `(built ${metadata.builtAt}, took ${metadata.buildDurationMs}ms)`,
      );
      return true;
    } catch (err) {
      console.log(
        `[browse-golden] Failed to load metadata: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  // ── Private helpers ─────────────────────────────────────────

  /**
   * Poll the browse server health endpoint until it responds 200
   * or the timeout is exceeded.
   */
  private waitForHealth(ip: string, port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    return new Promise<void>((resolve, reject) => {
      const attempt = (): void => {
        if (Date.now() > deadline) {
          reject(new Error(
            `[browse-golden] Health check timed out after ${timeoutMs}ms ` +
            `(http://${ip}:${port}/health)`,
          ));
          return;
        }

        const req = http.request(
          {
            hostname: ip,
            port,
            path: '/health',
            method: 'GET',
            timeout: 2000,
          },
          (res) => {
            // Consume the response body to free resources
            res.resume();
            if (res.statusCode === 200) {
              resolve();
            } else {
              setTimeout(attempt, HEALTH_POLL_INTERVAL_MS);
            }
          },
        );

        req.on('error', () => {
          // Connection refused, timeout, etc. — keep polling
          setTimeout(attempt, HEALTH_POLL_INTERVAL_MS);
        });

        req.on('timeout', () => {
          req.destroy();
          setTimeout(attempt, HEALTH_POLL_INTERVAL_MS);
        });

        req.end();
      };

      attempt();
    });
  }

  /** Check if all three snapshot files exist on disk. */
  private snapshotFilesExist(): boolean {
    try {
      fs.accessSync(this.snapshotPath, fs.constants.F_OK);
      fs.accessSync(this.memPath, fs.constants.F_OK);
      fs.accessSync(this.metadataPath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** Delete snapshot files (best-effort). */
  private deleteSnapshotFiles(): void {
    for (const filePath of [this.snapshotPath, this.memPath, this.metadataPath]) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // File doesn't exist or already removed — fine
      }
    }
  }
}

// ─── Utilities ────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
