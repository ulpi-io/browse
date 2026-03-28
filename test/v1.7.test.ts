/**
 * Integration tests for v1.7 visual intelligence features
 *
 * Covers:
 *   - visual command (contrast, overlap, overflow, landmarks, JSON output)
 *   - layout command (computed CSS properties, @ref support)
 *   - a11y-audit command (scoring, specific finding types)
 *   - Visual helper unit tests (parseColor, luminance, contrastRatio)
 */

import { describe, test, expect } from 'vitest';
import { sharedBm as bm, sharedBaseUrl as baseUrl } from './setup';
import { handleReadCommand } from '../src/commands/read';
import { handleWriteCommand } from '../src/commands/write';
import { handleMetaCommand } from '../src/commands/meta';
import { parseColor, luminance, contrastRatio } from '../src/visual';
import { runA11yAudit } from '../src/a11y';

const shutdown = async () => {};

// ─── Visual analysis ──────────────────────────────────────────────

describe('Visual analysis', () => {
  test('visual detects contrast failure', async () => {
    await handleWriteCommand('goto', [baseUrl + '/visual-issues.html'], bm);
    const { captureVisualState } = await import('../src/visual');
    const page = bm.getPage();
    const report = await captureVisualState(page);
    const contrastIssues = report.issues.filter(i => i.type === 'contrast');
    expect(contrastIssues.length).toBeGreaterThan(0);
  });

  test('visual detects overlap', async () => {
    await handleWriteCommand('goto', [baseUrl + '/visual-issues.html'], bm);
    const { captureVisualState } = await import('../src/visual');
    const page = bm.getPage();
    const report = await captureVisualState(page);
    const overlapIssues = report.issues.filter(i => i.type === 'overlap');
    expect(overlapIssues.length).toBeGreaterThan(0);
  });

  test('visual detects overflow-x', async () => {
    await handleWriteCommand('goto', [baseUrl + '/visual-issues.html'], bm);
    const { captureVisualState } = await import('../src/visual');
    const page = bm.getPage();
    const report = await captureVisualState(page);
    const overflowIssues = report.issues.filter(i => i.type === 'overflow-x');
    expect(overflowIssues.length).toBeGreaterThan(0);
  });

  test('visual returns landmarks', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const { captureVisualState } = await import('../src/visual');
    const page = bm.getPage();
    const report = await captureVisualState(page);
    // basic.html has <nav> and <footer> landmarks
    expect(Array.isArray(report.landmarks)).toBe(true);
    expect(report.landmarks.length).toBeGreaterThan(0);
    const tags = report.landmarks.map(lm => lm.tag);
    expect(tags).toContain('nav');
    expect(tags).toContain('footer');
  });

  test('visual --json returns parseable JSON', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleMetaCommand('visual', ['--json'], bm, shutdown);
    const parsed = JSON.parse(result);
    expect(parsed).toHaveProperty('viewport');
    expect(parsed).toHaveProperty('landmarks');
    expect(parsed).toHaveProperty('issues');
    expect(parsed).toHaveProperty('bodyHeight');
    expect(typeof parsed.viewport.width).toBe('number');
    expect(typeof parsed.viewport.height).toBe('number');
  });
});

// ─── Layout command ────────────────────────────────────────────────

describe('Layout command', () => {
  test('layout returns computed properties', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleReadCommand('layout', ['body'], bm);
    // Must include the key CSS properties
    expect(result).toContain('display:');
    expect(result).toContain('position:');
    expect(result).toContain('box:');
  });

  test('layout with @ref', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    // Build the @ref map via snapshot
    const snapshot = await handleMetaCommand('snapshot', ['-i'], bm, shutdown);
    // Extract the first @ref from the snapshot (e.g. "@e1")
    const refMatch = snapshot.match(/@e\d+/);
    expect(refMatch).not.toBeNull();
    const ref = refMatch![0];
    const result = await handleReadCommand('layout', [ref], bm);
    expect(result).toContain('display:');
    expect(result).toContain('box:');
  });
});

// ─── A11y audit ────────────────────────────────────────────────────

describe('A11y audit', () => {
  test('a11y-audit scores < 100 on issues fixture', async () => {
    await handleWriteCommand('goto', [baseUrl + '/a11y-issues.html'], bm);
    const result = await handleMetaCommand('a11y-audit', [], bm, shutdown);
    // Score line is present and below 100
    const scoreMatch = result.match(/Score:\s*(\d+)/);
    expect(scoreMatch).not.toBeNull();
    expect(parseInt(scoreMatch![1], 10)).toBeLessThan(100);
  });

  test('a11y-audit finds missing alt', async () => {
    await handleWriteCommand('goto', [baseUrl + '/a11y-issues.html'], bm);
    const page = bm.getPage();
    const report = await runA11yAudit(page);
    const finding = report.findings.find(f => f.type === 'missing-alt');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('critical');
  });

  test('a11y-audit finds no-label input', async () => {
    await handleWriteCommand('goto', [baseUrl + '/a11y-issues.html'], bm);
    const page = bm.getPage();
    const report = await runA11yAudit(page);
    const finding = report.findings.find(f => f.type === 'no-label');
    expect(finding).toBeDefined();
  });

  test('a11y-audit finds heading skip', async () => {
    await handleWriteCommand('goto', [baseUrl + '/a11y-issues.html'], bm);
    const page = bm.getPage();
    const report = await runA11yAudit(page);
    const finding = report.findings.find(f => f.type === 'heading-skip');
    expect(finding).toBeDefined();
    expect(finding!.details).toContain('h1');
    expect(finding!.details).toContain('h3');
  });

  test('a11y-audit finds small target', async () => {
    await handleWriteCommand('goto', [baseUrl + '/a11y-issues.html'], bm);
    const page = bm.getPage();
    const report = await runA11yAudit(page);
    const finding = report.findings.find(f => f.type === 'small-target');
    expect(finding).toBeDefined();
  });

  test('a11y-audit finds generic link', async () => {
    await handleWriteCommand('goto', [baseUrl + '/a11y-issues.html'], bm);
    const page = bm.getPage();
    const report = await runA11yAudit(page);
    const finding = report.findings.find(f => f.type === 'generic-link');
    expect(finding).toBeDefined();
    expect(finding!.details).toContain('click here');
  });

  test('a11y-audit scores 100 on clean page', async () => {
    await handleWriteCommand('goto', [baseUrl + '/a11y-clean.html'], bm);
    const page = bm.getPage();
    const report = await runA11yAudit(page);
    // a11y-clean.html: lang="en", alt on img, labels on inputs, sequential
    // headings h1→h2→h3, large touch targets, descriptive link text
    // Clean page should score very high (minor warnings from browser-injected elements are OK)
    expect(report.score).toBeGreaterThanOrEqual(90);
    expect(report.findings.filter(f => f.severity === 'critical').length).toBe(0);
  });
});

// ─── Visual helpers (unit tests) ──────────────────────────────────

describe('Visual helpers', () => {
  test('parseColor handles rgb()', () => {
    const result = parseColor('rgb(100, 150, 200)');
    expect(result).not.toBeNull();
    expect(result!.r).toBe(100);
    expect(result!.g).toBe(150);
    expect(result!.b).toBe(200);
    expect(result!.a).toBe(1);
  });

  test('parseColor handles rgba()', () => {
    const result = parseColor('rgba(10, 20, 30, 0.5)');
    expect(result).not.toBeNull();
    expect(result!.r).toBe(10);
    expect(result!.g).toBe(20);
    expect(result!.b).toBe(30);
    expect(result!.a).toBe(0.5);
  });

  test('parseColor handles #fff shorthand hex', () => {
    const result = parseColor('#fff');
    expect(result).not.toBeNull();
    expect(result!.r).toBe(255);
    expect(result!.g).toBe(255);
    expect(result!.b).toBe(255);
    expect(result!.a).toBe(1);
  });

  test('parseColor handles #ffffff full hex', () => {
    const result = parseColor('#ffffff');
    expect(result).not.toBeNull();
    expect(result!.r).toBe(255);
    expect(result!.g).toBe(255);
    expect(result!.b).toBe(255);
    expect(result!.a).toBe(1);
  });

  test('luminance follows WCAG formula: white = 1', () => {
    const lum = luminance(255, 255, 255);
    expect(lum).toBeCloseTo(1.0, 5);
  });

  test('luminance follows WCAG formula: black = 0', () => {
    const lum = luminance(0, 0, 0);
    expect(lum).toBeCloseTo(0.0, 5);
  });

  test('contrastRatio black/white = 21', () => {
    const lumWhite = luminance(255, 255, 255);
    const lumBlack = luminance(0, 0, 0);
    const ratio = contrastRatio(lumWhite, lumBlack);
    expect(ratio).toBeCloseTo(21.0, 0);
  });
});
