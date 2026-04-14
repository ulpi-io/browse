import { describe, test, expect } from 'vitest';
import { TabLock, TabLockTimeoutError } from '../src/session/tab-lock';
import { ConcurrencyLimiter, ConcurrencyLimitError, withUserLimit } from '../src/session/concurrency';

describe('TabLock', () => {
  test('acquire and release allows sequential access', async () => {
    const lock = new TabLock();
    await lock.acquire();
    expect(lock.isLocked()).toBe(true);
    lock.release();
    expect(lock.isLocked()).toBe(false);
  });

  test('second acquire waits until first releases', async () => {
    const lock = new TabLock();
    const order: number[] = [];

    await lock.acquire();
    order.push(1);

    const p2 = lock.acquire().then(() => { order.push(2); });
    // p2 should be waiting
    await new Promise(r => setTimeout(r, 50));
    expect(order).toEqual([1]);

    lock.release();
    await p2;
    expect(order).toEqual([1, 2]);
    lock.release();
  });

  test('acquire rejects on timeout', async () => {
    const lock = new TabLock();
    await lock.acquire();

    await expect(lock.acquire(100)).rejects.toThrow(TabLockTimeoutError);
    lock.release();
  });

  test('drain rejects all queued waiters', async () => {
    const lock = new TabLock();
    await lock.acquire();

    const p1 = lock.acquire().catch(e => e.message);
    const p2 = lock.acquire().catch(e => e.message);

    lock.drain();

    const [m1, m2] = await Promise.all([p1, p2]);
    expect(m1).toContain('drained');
    expect(m2).toContain('drained');
  });

  test('isLocked returns correct state', async () => {
    const lock = new TabLock();
    expect(lock.isLocked()).toBe(false);
    await lock.acquire();
    expect(lock.isLocked()).toBe(true);
    lock.release();
    expect(lock.isLocked()).toBe(false);
  });
});

describe('ConcurrencyLimiter', () => {
  test('allows up to maxConcurrent simultaneous acquires', async () => {
    const limiter = new ConcurrencyLimiter(2);
    await limiter.acquire('s1');
    await limiter.acquire('s1');
    expect(limiter.getStats('s1').active).toBe(2);
    limiter.release('s1');
    limiter.release('s1');
  });

  test('queues excess requests', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire('s1');

    let resolved = false;
    const p = limiter.acquire('s1').then(() => { resolved = true; });
    await new Promise(r => setTimeout(r, 50));
    expect(resolved).toBe(false);
    expect(limiter.getStats('s1').queued).toBe(1);

    limiter.release('s1');
    await p;
    expect(resolved).toBe(true);
    limiter.release('s1');
  });

  test('queue timeout rejects with ConcurrencyLimitError', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire('s1');

    await expect(limiter.acquire('s1', 100)).rejects.toThrow(ConcurrencyLimitError);
    limiter.release('s1');
  });

  test('drain rejects all queued for session', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire('s1');

    const p = limiter.acquire('s1').catch(e => e.message);
    limiter.drain('s1');

    expect(await p).toContain('drained');
  });

  test('different sessions have independent limits', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire('s1');
    await limiter.acquire('s2'); // should not block
    expect(limiter.getStats('s1').active).toBe(1);
    expect(limiter.getStats('s2').active).toBe(1);
    limiter.release('s1');
    limiter.release('s2');
  });

  test('getStats returns zeros for unknown session', () => {
    const limiter = new ConcurrencyLimiter(2);
    expect(limiter.getStats('unknown')).toEqual({ active: 0, queued: 0 });
  });
});

describe('withUserLimit', () => {
  test('acquires, runs operation, and releases', async () => {
    const limiter = new ConcurrencyLimiter(1);
    const result = await withUserLimit(limiter, 's1', async () => {
      expect(limiter.getStats('s1').active).toBe(1);
      return 'done';
    });
    expect(result).toBe('done');
    expect(limiter.getStats('s1').active).toBe(0);
  });

  test('releases on error', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await expect(withUserLimit(limiter, 's1', async () => {
      throw new Error('fail');
    })).rejects.toThrow('fail');
    expect(limiter.getStats('s1').active).toBe(0);
  });
});
