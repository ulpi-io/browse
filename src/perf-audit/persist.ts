/**
 * Persistence layer for perf-audit reports.
 *
 * Saves, loads, lists, and deletes JSON report files under
 * `<localDir>/audits/`.  Follows the same patterns as the
 * `state save/load/list` implementation in `commands/meta.ts`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { sanitizeName } from '../sanitize';
import type { PerfAuditReport } from './index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function auditsDir(localDir: string): string {
  return path.join(localDir, 'audits');
}

function auditPath(localDir: string, name: string): string {
  return path.join(auditsDir(localDir), `${sanitizeName(name)}.json`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist a perf-audit report as pretty-printed JSON.
 *
 * Creates the `audits/` directory if it does not exist.
 * Returns the absolute path of the written file.
 */
export function saveAudit(
  localDir: string,
  name: string,
  report: PerfAuditReport,
): string {
  const dir = auditsDir(localDir);
  fs.mkdirSync(dir, { recursive: true });

  const filePath = auditPath(localDir, name);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2), { mode: 0o600 });
  return filePath;
}

/**
 * Load a previously-saved perf-audit report by name.
 *
 * Throws a descriptive error when the file does not exist so the
 * caller (or the AI agent) knows exactly what to do next.
 */
export function loadAudit(
  localDir: string,
  name: string,
): PerfAuditReport {
  const filePath = auditPath(localDir, name);
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Audit not found: ${filePath}. Run "browse perf-audit save ${name}" first.`,
    );
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PerfAuditReport;
}

/**
 * List every saved audit report.
 *
 * Returns an empty array (no crash) when the `audits/` directory
 * does not yet exist.  Results are sorted newest-first.
 */
export function listAudits(
  localDir: string,
): Array<{ name: string; sizeBytes: number; date: string }> {
  const dir = auditsDir(localDir);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) return [];

  const entries = files.map((file) => {
    const fp = path.join(dir, file);
    const stat = fs.statSync(fp);
    return {
      name: file.replace('.json', ''),
      sizeBytes: stat.size,
      date: new Date(stat.mtimeMs).toISOString(),
    };
  });

  // Sort newest first
  entries.sort((a, b) => b.date.localeCompare(a.date));
  return entries;
}

/**
 * Delete a saved audit report by name.
 *
 * Throws when the file does not exist.
 */
export function deleteAudit(localDir: string, name: string): void {
  const filePath = auditPath(localDir, name);
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Audit not found: ${filePath}. Nothing to delete.`,
    );
  }
  fs.unlinkSync(filePath);
}
