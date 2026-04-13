/**
 * Shared orchestrator interface for session isolation backends.
 *
 * Both ContainerOrchestrator (Docker) and VmOrchestrator (microVM)
 * implement this contract. The cloud gateway selects a backend at
 * startup via BROWSE_CLOUD_ISOLATION env var.
 *
 * Design invariants:
 *   - One orchestrator instance per gateway process
 *   - Session IDs are tenant-scoped: `tenant:<tenantId>:session:<id>`
 *   - Each session maps 1:1 to an isolated backend (container or VM)
 *   - Freeze/resume allows session persistence across compute recycling
 */

// ─── Handle types ──────────────────────────────────────────────

/** Handle to a provisioned session (container or VM). */
export interface SessionHandle {
  /** Unique session ID (tenant-scoped) */
  sessionId: string;
  /** Tenant that owns this session */
  tenantId: string;
  /** Internal address for command proxying (e.g. '172.17.0.2:9400') */
  internalAddress: string;
  /** Auth token for the internal browse server */
  internalToken: string;
  /** Backend-specific ID (container ID, VM ID) */
  backendId: string;
  /** When the session was provisioned (ISO 8601) */
  createdAt: string;
}

/** Frozen session metadata — persisted after compute is released. */
export interface FrozenSession {
  sessionId: string;
  tenantId: string;
  /** Backend-specific snapshot reference (image ID, snapshot path) */
  snapshotRef: string;
  /** When the session was frozen (ISO 8601) */
  frozenAt: string;
  /** Auth token from the original session — must be reused on resume
   *  because VM snapshots restore with the same in-process token. */
  internalToken?: string;
  /** Allowed domains from the original session — must be reapplied on resume. */
  allowedDomains?: string;
}

// ─── Orchestrator contract ─────────────────────────────────────

/** Common orchestrator interface — container and VM backends implement this. */
export interface Orchestrator {
  /** Provision a new isolated session. */
  provision(
    tenantId: string,
    opts?: { sessionId?: string; allowedDomains?: string },
  ): Promise<SessionHandle>;

  /** Execute a browse command on a provisioned session. */
  executeCommand(
    handle: SessionHandle,
    command: string,
    args: string[],
  ): Promise<string>;

  /** Terminate a session and clean up its resources. */
  terminate(handle: SessionHandle): Promise<void>;

  /** Freeze a session (save state, release compute). */
  freeze(handle: SessionHandle): Promise<FrozenSession>;

  /** Resume a frozen session. */
  resume(tenantId: string, frozen: FrozenSession): Promise<SessionHandle>;

  /** List active sessions for a tenant. */
  list(tenantId: string): SessionHandle[];

  /** Shut down the orchestrator and clean up all resources. */
  shutdown(): Promise<void>;
}
