/**
 * TabLock — session-level command serialization mutex.
 *
 * Serializes all commands within a session to prevent CDP state corruption
 * from concurrent operations on shared mutable state (activeTabId, refMap).
 *
 * Despite the name, this is a session-level lock, not per-tab.
 * Per-tab parallelism requires per-request tab pinning (future work).
 */

export class TabLockTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Command lock timeout after ${timeoutMs}ms — another command is still running in this session`);
    this.name = 'TabLockTimeoutError';
  }
}

export class TabLock {
  private queue: Array<{ resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  private active = false;

  /** Whether the lock is currently held. */
  isLocked(): boolean {
    return this.active;
  }

  /** Acquire the lock. Returns when the lock is obtained. Rejects on timeout. */
  acquire(timeoutMs = 30_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const idx = this.queue.indexOf(entry);
          if (idx !== -1) this.queue.splice(idx, 1);
          reject(new TabLockTimeoutError(timeoutMs));
        }, timeoutMs),
      };
      this.queue.push(entry);
      this._tryNext();
    });
  }

  /** Release the lock, allowing the next queued waiter to proceed. */
  release(): void {
    this.active = false;
    this._tryNext();
  }

  /** Drain the queue — reject all waiters. Call before closing a session. */
  drain(): void {
    this.active = true; // prevent new acquisitions
    for (const entry of this.queue) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Session closing — command lock drained'));
    }
    this.queue = [];
  }

  private _tryNext(): void {
    if (this.active || this.queue.length === 0) return;
    this.active = true;
    const entry = this.queue.shift()!;
    clearTimeout(entry.timer);
    entry.resolve();
  }
}
