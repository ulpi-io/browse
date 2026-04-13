/**
 * Firecracker microVM API client — minimal HTTP client for VM lifecycle.
 *
 * Firecracker exposes a REST API over a Unix socket (one per VM).
 * Socket path: {socketDir}/firecracker-{vmId}.sock
 *
 * Uses native Node.js `http` module with `socketPath` option — no external deps.
 *
 * API reference: https://github.com/firecracker-microvm/firecracker/blob/main/src/api_server/swagger/firecracker.yaml
 *
 * Key Firecracker API conventions:
 *   - Configuration endpoints use PUT (not POST)
 *   - VM must be configured before starting (boot source, drives, etc.)
 *   - Snapshot/restore requires the VM to be paused first
 *   - Each Firecracker process manages exactly one microVM
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';

// ─── Constants ─────────────────────────────────────────────────

const DEFAULT_SOCKET_DIR = '/tmp';
const DEFAULT_FIRECRACKER_BIN = 'firecracker';
const SOCKET_POLL_INTERVAL_MS = 50;
const SOCKET_TIMEOUT_MS = 5000;
const STOP_TIMEOUT_MS = 5000;
const DEFAULT_BOOT_ARGS = 'console=ttyS0 reboot=k panic=1 pci=off';
const MAC_PREFIX = 'AA:FC:00';

// ─── Types ─────────────────────────────────────────────────────

export interface VmConfig {
  /** vCPU count (default 1) */
  vcpuCount?: number;
  /** Memory size in MB (default 512) */
  memSizeMb?: number;
  /** Path to vmlinux kernel binary */
  kernelPath: string;
  /** Kernel boot arguments */
  bootArgs?: string;
  /** Path to rootfs ext4 image */
  rootfsPath: string;
  /** Whether rootfs is read-only (default true — use overlay for writes) */
  rootfsReadOnly?: boolean;
  /** Network interface config */
  network?: {
    /** Host tap device name */
    tapDevice: string;
    /** Guest MAC address (auto-generated if not provided) */
    macAddress?: string;
  };
}

export interface FirecrackerClientOptions {
  /** Directory for Firecracker sockets (default /tmp) */
  socketDir?: string;
  /** Path to Firecracker binary (default: 'firecracker' on PATH) */
  firecrackerBin?: string;
}

// ─── Errors ────────────────────────────────────────────────────

export class FirecrackerApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public vmId: string,
  ) {
    super(`Firecracker API error ${statusCode} (VM ${vmId}): ${message}`);
    this.name = 'FirecrackerApiError';
  }
}

// ─── Internal types ────────────────────────────────────────────

interface RequestResult<T> {
  statusCode: number;
  body: T;
}

/** Firecracker /vm response shape. */
interface VmInfoResponse {
  state: string;
}

// ─── FirecrackerClient ─────────────────────────────────────────

export class FirecrackerClient {
  private socketDir: string;
  private firecrackerBin: string;
  private processes: Map<string, ChildProcess> = new Map();

  constructor(opts: FirecrackerClientOptions = {}) {
    this.socketDir = opts.socketDir ?? DEFAULT_SOCKET_DIR;
    this.firecrackerBin = opts.firecrackerBin ?? DEFAULT_FIRECRACKER_BIN;
  }

  // ── KVM availability ──────────────────────────────────────────

  /**
   * Check if /dev/kvm exists and is accessible (read + write).
   * Returns true on Linux with KVM, false on macOS/Windows/Linux-without-KVM.
   */
  checkKvm(): boolean {
    try {
      fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  // ── VM lifecycle ──────────────────────────────────────────────

  /**
   * Create and configure a microVM (does not start it).
   *
   * Spawns a new Firecracker process, waits for the API socket,
   * then configures the VM via REST API calls.
   */
  async createVm(vmId: string, config: VmConfig): Promise<void> {
    const sockPath = this.socketPath(vmId);

    // Clean up stale socket if it exists
    this.cleanupSocket(sockPath);

    // Spawn Firecracker process
    const proc = spawn(
      this.firecrackerBin,
      ['--api-sock', sockPath],
      { stdio: 'pipe', detached: true },
    );

    // Unref so Node.js can exit without waiting for Firecracker.
    // Cast stdio streams through `any` — Node's Readable/Writable types
    // don't expose unref() but the underlying net.Socket does at runtime.
    proc.unref();
    if (proc.stdout) (proc.stdout as any).unref();
    if (proc.stderr) (proc.stderr as any).unref();
    if (proc.stdin) (proc.stdin as any).unref();

    this.processes.set(vmId, proc);

    // Handle early crash before socket appears
    let earlyError: Error | undefined;
    const onEarlyExit = (code: number | null, signal: string | null): void => {
      earlyError = new FirecrackerApiError(
        500,
        `Firecracker process exited early (code=${code}, signal=${signal})`,
        vmId,
      );
    };
    proc.once('error', (err) => {
      earlyError = new FirecrackerApiError(500, `Failed to spawn Firecracker: ${err.message}`, vmId);
    });
    proc.once('exit', onEarlyExit);

    try {
      // Wait for socket to appear
      await this.waitForSocket(sockPath, SOCKET_TIMEOUT_MS, earlyError);
    } catch (err) {
      // Cleanup on failure
      this.processes.delete(vmId);
      this.killProcess(proc);
      this.cleanupSocket(sockPath);
      throw err;
    } finally {
      proc.removeListener('exit', onEarlyExit);
    }

    // Configure the VM via Firecracker REST API
    try {
      // 1. Machine config
      await this.apiRequest(vmId, 'PUT', '/machine-config', {
        vcpu_count: config.vcpuCount ?? 1,
        mem_size_mib: config.memSizeMb ?? 512,
      });

      // 2. Boot source
      await this.apiRequest(vmId, 'PUT', '/boot-source', {
        kernel_image_path: config.kernelPath,
        boot_args: config.bootArgs ?? DEFAULT_BOOT_ARGS,
      });

      // 3. Root filesystem drive
      await this.apiRequest(vmId, 'PUT', '/drives/rootfs', {
        drive_id: 'rootfs',
        path_on_host: config.rootfsPath,
        is_root_device: true,
        is_read_only: config.rootfsReadOnly ?? true,
      });

      // 4. Network interface (optional)
      if (config.network) {
        await this.apiRequest(vmId, 'PUT', '/network-interfaces/eth0', {
          iface_id: 'eth0',
          host_dev_name: config.network.tapDevice,
          guest_mac: config.network.macAddress ?? generateMac(),
        });
      }
    } catch (err) {
      // Cleanup on configuration failure
      await this.stopVm(vmId).catch(() => {});
      throw err;
    }
  }

  /**
   * Start a configured VM (issues InstanceStart action).
   * The VM must already be created via createVm().
   */
  async startVm(vmId: string): Promise<void> {
    await this.apiRequest(vmId, 'PUT', '/actions', {
      action_type: 'InstanceStart',
    });
  }

  /**
   * Pause a running VM.
   */
  async pauseVm(vmId: string): Promise<void> {
    await this.apiRequest(vmId, 'PATCH', '/vm', {
      state: 'Paused',
    });
  }

  /**
   * Resume a paused VM.
   */
  async resumeVm(vmId: string): Promise<void> {
    await this.apiRequest(vmId, 'PATCH', '/vm', {
      state: 'Resumed',
    });
  }

  /**
   * Create a full snapshot of a paused VM.
   *
   * Caller must pause the VM first — Firecracker requires this.
   * Creates both a VM state file and a memory file.
   *
   * @param vmId - ID of the (paused) VM
   * @param snapshotPath - Where to write the VM state snapshot
   * @param memPath - Where to write the memory file
   */
  async snapshotVm(vmId: string, snapshotPath: string, memPath: string): Promise<void> {
    await this.apiRequest(vmId, 'PUT', '/snapshot/create', {
      snapshot_type: 'Full',
      snapshot_path: snapshotPath,
      mem_file_path: memPath,
    });
  }

  /**
   * Restore a VM from a snapshot.
   *
   * Spawns a NEW Firecracker process, loads the snapshot, and resumes.
   * Any existing Firecracker process for this vmId is stopped first.
   *
   * @param vmId - ID for the restored VM
   * @param snapshotPath - Path to the VM state snapshot file
   * @param memPath - Path to the memory file
   */
  async restoreVm(vmId: string, snapshotPath: string, memPath: string): Promise<void> {
    // Stop any existing process for this vmId
    if (this.processes.has(vmId)) {
      await this.stopVm(vmId).catch(() => {});
    }

    const sockPath = this.socketPath(vmId);
    this.cleanupSocket(sockPath);

    // Spawn a fresh Firecracker process
    const proc = spawn(
      this.firecrackerBin,
      ['--api-sock', sockPath],
      { stdio: 'pipe', detached: true },
    );

    proc.unref();
    if (proc.stdout) (proc.stdout as any).unref();
    if (proc.stderr) (proc.stderr as any).unref();
    if (proc.stdin) (proc.stdin as any).unref();

    this.processes.set(vmId, proc);

    let earlyError: Error | undefined;
    const onEarlyExit = (code: number | null, signal: string | null): void => {
      earlyError = new FirecrackerApiError(
        500,
        `Firecracker process exited early during restore (code=${code}, signal=${signal})`,
        vmId,
      );
    };
    proc.once('error', (err) => {
      earlyError = new FirecrackerApiError(500, `Failed to spawn Firecracker: ${err.message}`, vmId);
    });
    proc.once('exit', onEarlyExit);

    try {
      await this.waitForSocket(sockPath, SOCKET_TIMEOUT_MS, earlyError);
    } catch (err) {
      this.processes.delete(vmId);
      this.killProcess(proc);
      this.cleanupSocket(sockPath);
      throw err;
    } finally {
      proc.removeListener('exit', onEarlyExit);
    }

    try {
      // Load the snapshot
      await this.apiRequest(vmId, 'PUT', '/snapshot/load', {
        snapshot_path: snapshotPath,
        mem_file_path: memPath,
      });

      // Resume the restored VM (Firecracker-specific: restored VMs start paused)
      await this.apiRequest(vmId, 'PUT', '/actions', {
        action_type: 'InstanceResume',
      });
    } catch (err) {
      await this.stopVm(vmId).catch(() => {});
      throw err;
    }
  }

  /**
   * Stop a VM and clean up its resources.
   *
   * Sends SIGTERM, waits up to 5s, then SIGKILL if still running.
   * Cleans up the socket file and removes the process from tracking.
   */
  async stopVm(vmId: string): Promise<void> {
    const proc = this.processes.get(vmId);
    const sockPath = this.socketPath(vmId);

    if (proc) {
      await this.gracefulKill(proc, vmId);
      this.processes.delete(vmId);
    }

    this.cleanupSocket(sockPath);
  }

  /**
   * Get VM info from the Firecracker API.
   *
   * Returns the VM state or null if the socket doesn't exist
   * (meaning the VM is not running or doesn't exist).
   */
  async getVmInfo(vmId: string): Promise<{ state: string } | null> {
    const sockPath = this.socketPath(vmId);

    // Quick check: does the socket exist?
    try {
      fs.accessSync(sockPath, fs.constants.F_OK);
    } catch {
      return null;
    }

    try {
      const result = await this.apiRequest<VmInfoResponse>(vmId, 'GET', '/vm');
      return { state: result.state };
    } catch {
      return null;
    }
  }

  // ── Private helpers ───────────────────────────────────────────

  /** Compute the socket path for a given VM ID. */
  private socketPath(vmId: string): string {
    return path.join(this.socketDir, `firecracker-${vmId}.sock`);
  }

  /**
   * Send an HTTP request over the Unix socket for a specific VM.
   *
   * Follows the same pattern as DockerClient's private request method
   * but always uses a Unix socket (one per VM).
   */
  private apiRequest<T = unknown>(
    vmId: string,
    method: string,
    apiPath: string,
    body?: unknown,
  ): Promise<T> {
    const sockPath = this.socketPath(vmId);
    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };
    let payload: string | undefined;

    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }

    return new Promise<T>((resolve, reject) => {
      const req = http.request(
        {
          socketPath: sockPath,
          path: apiPath,
          method,
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const statusCode = res.statusCode ?? 500;
            const rawBody = Buffer.concat(chunks).toString('utf8');

            if (statusCode < 200 || statusCode >= 300) {
              // Firecracker returns { fault_message: "..." } on error
              let errMsg = rawBody;
              try {
                const parsed = JSON.parse(rawBody) as { fault_message?: string };
                if (parsed.fault_message) errMsg = parsed.fault_message;
              } catch { /* use raw body */ }
              reject(new FirecrackerApiError(statusCode, errMsg, vmId));
              return;
            }

            // Some endpoints return 204 No Content
            if (!rawBody || statusCode === 204) {
              resolve(undefined as unknown as T);
              return;
            }

            try {
              const parsed = JSON.parse(rawBody) as T;
              resolve(parsed);
            } catch {
              reject(
                new FirecrackerApiError(
                  statusCode,
                  `Invalid JSON response: ${rawBody.slice(0, 200)}`,
                  vmId,
                ),
              );
            }
          });
        },
      );

      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
          reject(
            new FirecrackerApiError(
              503,
              `Firecracker API not reachable (socket: ${sockPath}): ${err.message}`,
              vmId,
            ),
          );
        } else {
          reject(err);
        }
      });

      if (payload) req.write(payload);
      req.end();
    });
  }

  /**
   * Poll for a Unix socket file to appear on disk.
   *
   * Firecracker creates the socket after the process starts — there's
   * a brief window where the socket doesn't exist yet.
   */
  private async waitForSocket(
    sockPath: string,
    timeoutMs: number,
    earlyError?: Error | undefined,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      // Check if the Firecracker process died before the socket appeared
      if (earlyError) throw earlyError;

      try {
        fs.accessSync(sockPath, fs.constants.F_OK);
        return; // Socket exists
      } catch {
        // Not yet — keep polling
      }

      await sleep(SOCKET_POLL_INTERVAL_MS);
    }

    throw new FirecrackerApiError(
      504,
      `Timed out waiting for API socket (${timeoutMs}ms): ${sockPath}`,
      'unknown',
    );
  }

  /**
   * Send SIGTERM, wait up to STOP_TIMEOUT_MS, then SIGKILL if still alive.
   */
  private gracefulKill(proc: ChildProcess, vmId: string): Promise<void> {
    return new Promise<void>((resolve) => {
      // Already dead?
      if (proc.exitCode !== null || proc.killed) {
        resolve();
        return;
      }

      let resolved = false;
      const onExit = (): void => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };

      proc.once('exit', onExit);

      // Send SIGTERM for graceful shutdown
      try {
        proc.kill('SIGTERM');
      } catch {
        // Process already dead — race condition
        resolved = true;
        resolve();
        return;
      }

      // Escalate to SIGKILL after timeout
      setTimeout(() => {
        if (!resolved) {
          try {
            proc.kill('SIGKILL');
          } catch {
            // Already dead
          }
          // Give SIGKILL a moment to take effect
          setTimeout(() => {
            proc.removeListener('exit', onExit);
            resolved = true;
            resolve();
          }, 200);
        }
      }, STOP_TIMEOUT_MS);
    });
  }

  /** Kill a process immediately (used during cleanup on spawn failure). */
  private killProcess(proc: ChildProcess): void {
    try {
      proc.kill('SIGKILL');
    } catch {
      // Already dead
    }
  }

  /** Remove a socket file if it exists. */
  private cleanupSocket(sockPath: string): void {
    try {
      fs.unlinkSync(sockPath);
    } catch {
      // Doesn't exist or already removed — fine
    }
  }
}

// ─── Utilities ─────────────────────────────────────────────────

/**
 * Generate a random MAC address with the AA:FC:00 prefix.
 *
 * AA:FC prefix is locally-administered (LAA bit set) and identifies
 * Firecracker VMs. The remaining 3 octets are random.
 */
function generateMac(): string {
  const octets = Array.from({ length: 3 }, () =>
    Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, '0')
      .toUpperCase(),
  );
  return `${MAC_PREFIX}:${octets.join(':')}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
