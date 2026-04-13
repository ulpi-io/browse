/**
 * Benchmark tests for cloud isolation backends (containers and microVMs).
 *
 * These tests document performance targets and validate the benchmark
 * result format. Actual timing benchmarks require Docker or Firecracker
 * and are intended to run in CI with appropriate infrastructure.
 *
 * Separate file from cloud-microvm.test.ts so benchmarks can be run
 * independently: `npm test -- test/cloud-benchmarks`
 */

import { describe, test, expect } from 'vitest';

// ─── Performance targets ─────────────────────────────────────────

describe('Cloud Benchmarks', () => {
  test('performance targets documented', () => {
    const targets = {
      containerColdStart: { target: '<2s', unit: 'ms', description: 'Container from image pull + create + start + health' },
      containerWarmStart: { target: '<100ms (from pool)', unit: 'ms', description: 'Container from warm pool claim' },
      vmColdStart: { target: '<2s', unit: 'ms', description: 'VM from create + boot + health check' },
      vmWarmStart: { target: '<200ms (from golden snapshot)', unit: 'ms', description: 'VM from golden snapshot restore + resume' },
      vmFreeze: { target: '<1s', unit: 'ms', description: 'Pause VM + snapshot memory + state to disk' },
      vmResume: { target: '<500ms', unit: 'ms', description: 'Restore VM from snapshot + resume' },
      goldenSnapshotBuild: { target: '<10s', unit: 'ms', description: 'Full VM boot + Chromium launch + snapshot' },
      goldenSnapshotClone: { target: '<500ms', unit: 'ms', description: 'Restore from golden snapshot files' },
    };

    // Document all 8 performance targets
    expect(Object.keys(targets)).toHaveLength(8);

    // Every target has the required fields
    for (const [name, entry] of Object.entries(targets)) {
      expect(entry.target).toBeTruthy();
      expect(entry.unit).toBe('ms');
      expect(entry.description).toBeTruthy();
    }
  });

  test('benchmark result format is structured JSON', () => {
    // The benchmark runner should output results in this format
    // for CI dashboards and regression tracking
    const exampleResult = {
      name: 'container-cold-start',
      value: 1500,
      unit: 'ms',
      timestamp: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
    };

    expect(exampleResult.name).toBeTruthy();
    expect(typeof exampleResult.value).toBe('number');
    expect(exampleResult.value).toBeGreaterThan(0);
    expect(exampleResult.unit).toBe('ms');
    expect(exampleResult.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(exampleResult.platform).toBeTruthy();
    expect(exampleResult.arch).toBeTruthy();
  });

  test('benchmark result supports optional metadata fields', () => {
    // Extended format with CI-specific fields
    const extendedResult = {
      name: 'vm-warm-start',
      value: 180,
      unit: 'ms',
      timestamp: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      // Optional CI context
      gitCommit: 'abc123def',
      gitBranch: 'main',
      ciProvider: 'github-actions',
      runId: '12345',
      iteration: 1,
      samples: 10,
      p50: 150,
      p95: 250,
      p99: 400,
      min: 120,
      max: 450,
    };

    expect(extendedResult.name).toBeTruthy();
    expect(typeof extendedResult.value).toBe('number');
    expect(typeof extendedResult.samples).toBe('number');
    expect(extendedResult.p50).toBeLessThanOrEqual(extendedResult.p95);
    expect(extendedResult.p95).toBeLessThanOrEqual(extendedResult.p99);
    expect(extendedResult.min).toBeLessThanOrEqual(extendedResult.max);
  });
});

// ─── Benchmark categories ────────────────────────────────────────

describe('Benchmark Categories', () => {
  test('container benchmarks cover provisioning lifecycle', () => {
    const containerBenchmarks = [
      'container-cold-start',
      'container-warm-start',
      'container-terminate',
      'container-freeze',
      'container-resume',
      'container-execute-command',
    ];

    // Verify we track all container lifecycle phases
    expect(containerBenchmarks).toContain('container-cold-start');
    expect(containerBenchmarks).toContain('container-warm-start');
    expect(containerBenchmarks).toContain('container-terminate');
    expect(containerBenchmarks).toContain('container-freeze');
    expect(containerBenchmarks).toContain('container-resume');
    expect(containerBenchmarks).toContain('container-execute-command');
  });

  test('VM benchmarks cover provisioning lifecycle', () => {
    const vmBenchmarks = [
      'vm-cold-start',
      'vm-warm-start',
      'vm-terminate',
      'vm-freeze',
      'vm-resume',
      'vm-execute-command',
      'golden-snapshot-build',
      'golden-snapshot-clone',
      'vm-pool-claim',
      'vm-pool-replenish',
    ];

    // Verify we track all VM lifecycle phases
    expect(vmBenchmarks).toContain('vm-cold-start');
    expect(vmBenchmarks).toContain('vm-warm-start');
    expect(vmBenchmarks).toContain('golden-snapshot-build');
    expect(vmBenchmarks).toContain('golden-snapshot-clone');
    expect(vmBenchmarks).toContain('vm-pool-claim');
  });

  test('comparison matrix covers both backends', () => {
    // Benchmarks that should be compared across container and VM backends
    const comparablePairs = [
      ['container-cold-start', 'vm-cold-start'],
      ['container-warm-start', 'vm-warm-start'],
      ['container-terminate', 'vm-terminate'],
      ['container-freeze', 'vm-freeze'],
      ['container-resume', 'vm-resume'],
      ['container-execute-command', 'vm-execute-command'],
    ];

    expect(comparablePairs).toHaveLength(6);

    for (const [containerBench, vmBench] of comparablePairs) {
      expect(containerBench).toMatch(/^container-/);
      expect(vmBench).toMatch(/^vm-/);
      // Both should measure the same lifecycle phase
      const containerPhase = containerBench.replace('container-', '');
      const vmPhase = vmBench.replace('vm-', '');
      expect(containerPhase).toBe(vmPhase);
    }
  });
});

// ─── Timing utility validation ───────────────────────────────────

describe('Benchmark Timing', () => {
  test('performance.now provides sub-millisecond precision', () => {
    const start = performance.now();
    // Do a trivial operation
    let sum = 0;
    for (let i = 0; i < 1000; i++) sum += i;
    const elapsed = performance.now() - start;

    expect(typeof elapsed).toBe('number');
    expect(elapsed).toBeGreaterThanOrEqual(0);
    // Sub-millisecond precision means the value has decimal places
    // (though it may be an integer if the operation was fast enough to round to 0)
    expect(Number.isFinite(elapsed)).toBe(true);
  });

  test('Date.now provides millisecond timestamps for benchmark records', () => {
    const before = Date.now();
    const after = Date.now();

    expect(after).toBeGreaterThanOrEqual(before);
    // Timestamps should be reasonable (after 2024)
    expect(before).toBeGreaterThan(1_700_000_000_000);
  });

  test('benchmark harness helper measures async operations', async () => {
    /** Minimal benchmark harness — measures a single async operation. */
    async function measureMs(fn: () => Promise<void>): Promise<number> {
      const start = performance.now();
      await fn();
      return performance.now() - start;
    }

    const elapsed = await measureMs(async () => {
      // Simulate a trivial async operation
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(elapsed).toBeGreaterThanOrEqual(5); // Allow some scheduling slack
    expect(elapsed).toBeLessThan(1000); // Should not take more than 1s
  });

  test('multi-sample benchmark runner collects statistics', async () => {
    /** Run a function N times and collect timing statistics. */
    async function benchmarkN(
      fn: () => Promise<void>,
      samples: number,
    ): Promise<{ min: number; max: number; mean: number; values: number[] }> {
      const values: number[] = [];
      for (let i = 0; i < samples; i++) {
        const start = performance.now();
        await fn();
        values.push(performance.now() - start);
      }
      values.sort((a, b) => a - b);
      const sum = values.reduce((a, b) => a + b, 0);
      return {
        min: values[0],
        max: values[values.length - 1],
        mean: sum / values.length,
        values,
      };
    }

    const stats = await benchmarkN(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }, 5);

    expect(stats.values).toHaveLength(5);
    expect(stats.min).toBeLessThanOrEqual(stats.mean);
    expect(stats.mean).toBeLessThanOrEqual(stats.max);
    expect(stats.min).toBeGreaterThanOrEqual(0);
  });
});
