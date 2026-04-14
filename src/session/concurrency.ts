/**
 * ConcurrencyLimiter — caps concurrent operations per session.
 * Excess requests queue with a timeout.
 */

export class ConcurrencyLimitError extends Error {
  constructor(sessionId: string, timeoutMs: number) {
    super(`Concurrency limit reached for session ${sessionId} — queued request timed out after ${timeoutMs}ms`);
    this.name = 'ConcurrencyLimitError';
  }
}

export class ConcurrencyLimiter {
  private sessions = new Map<string, { active: number; queue: Array<{ resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }> }>();

  constructor(private maxConcurrent: number = 6) {}

  /** Get stats for a session. */
  getStats(sessionId: string): { active: number; queued: number } {
    const state = this.sessions.get(sessionId);
    return { active: state?.active ?? 0, queued: state?.queue.length ?? 0 };
  }

  /** Acquire a slot. Resolves when a slot is available. Rejects on timeout. */
  acquire(sessionId: string, timeoutMs = 30_000): Promise<void> {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { active: 0, queue: [] };
      this.sessions.set(sessionId, state);
    }

    if (state.active < this.maxConcurrent) {
      state.active++;
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const entry = {
        resolve: () => { state!.active++; resolve(); },
        reject,
        timer: setTimeout(() => {
          const idx = state!.queue.indexOf(entry);
          if (idx !== -1) state!.queue.splice(idx, 1);
          reject(new ConcurrencyLimitError(sessionId, timeoutMs));
        }, timeoutMs),
      };
      state!.queue.push(entry);
    });
  }

  /** Release a slot, allowing the next queued request to proceed. */
  release(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.active--;
    if (state.queue.length > 0) {
      const entry = state.queue.shift()!;
      clearTimeout(entry.timer);
      entry.resolve();
    }
    if (state.active === 0 && state.queue.length === 0) {
      this.sessions.delete(sessionId);
    }
  }

  /** Drain all queued requests for a session. Call before closing. */
  drain(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    for (const entry of state.queue) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`Session ${sessionId} closing — concurrency queue drained`));
    }
    state.queue = [];
    this.sessions.delete(sessionId);
  }
}

/**
 * Convenience wrapper: acquire, run operation, release.
 */
export async function withUserLimit<T>(
  limiter: ConcurrencyLimiter,
  sessionId: string,
  operation: () => Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  await limiter.acquire(sessionId, timeoutMs);
  try {
    return await operation();
  } finally {
    limiter.release(sessionId);
  }
}
