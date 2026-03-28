/**
 * Custom audit rules — project-local declarative audit extensions.
 *
 * Loads .browse/rules/*.json and applies them alongside built-in audit checks.
 * Rules are declarative JSON, not executable code — no eval/plugin hooks.
 *
 * Supported rule kinds:
 *   - metric-threshold: for perf-audit (e.g., "LCP must be under 2000ms")
 *   - selector-count: for a11y-audit (e.g., "no more than 0 images without alt")
 */

import * as fs from 'fs';
import * as path from 'path';

export interface CustomRule {
  /** Rule version (currently 1) */
  version: 1;
  /** Human-readable rule name */
  name: string;
  /** Which audit this rule extends */
  target: 'perf-audit' | 'a11y-audit';
  /** Rule kind */
  kind: 'metric-threshold' | 'selector-count';
  /** For metric-threshold: metric key (e.g., 'lcp') */
  metric?: string;
  /** For metric-threshold: maximum allowed value */
  threshold?: number;
  /** For selector-count: CSS selector to count */
  selector?: string;
  /** For selector-count: maximum allowed count (0 = must not exist) */
  maxCount?: number;
  /** Severity when the rule fails */
  severity?: 'critical' | 'warning';
}

export interface RuleResult {
  rule: CustomRule;
  passed: boolean;
  actual: string;
  source: string;
}

/**
 * Load custom rules from .browse/rules/*.json
 */
export function loadCustomRules(localDir: string): { rules: CustomRule[]; warnings: string[] } {
  const rulesDir = path.join(localDir, 'rules');
  const rules: CustomRule[] = [];
  const warnings: string[] = [];

  if (!fs.existsSync(rulesDir)) return { rules, warnings };

  for (const file of fs.readdirSync(rulesDir)) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(rulesDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (data.version !== 1) {
        warnings.push(`${file}: unsupported rule version ${data.version}`);
        continue;
      }
      if (!data.name || !data.target || !data.kind) {
        warnings.push(`${file}: missing required fields (name, target, kind)`);
        continue;
      }
      if (data.target !== 'perf-audit' && data.target !== 'a11y-audit') {
        warnings.push(`${file}: invalid target '${data.target}' (expected perf-audit or a11y-audit)`);
        continue;
      }
      if (data.kind !== 'metric-threshold' && data.kind !== 'selector-count') {
        warnings.push(`${file}: unknown rule kind '${data.kind}'`);
        continue;
      }
      (data as any).__source = file;
      rules.push(data as CustomRule);
    } catch (err: any) {
      warnings.push(`${file}: ${err.message}`);
    }
  }

  return { rules, warnings };
}

/**
 * Evaluate metric-threshold rules against perf-audit metrics.
 */
export function evaluateMetricRules(
  rules: CustomRule[],
  metrics: Record<string, number | null>,
): RuleResult[] {
  return rules
    .filter(r => r.kind === 'metric-threshold' && r.metric)
    .map(r => {
      const value = metrics[r.metric!.toLowerCase()];
      if (value == null) {
        return { rule: r, passed: true, actual: 'not measured', source: (r as any).__source || '' };
      }
      const passed = value <= (r.threshold ?? Infinity);
      return { rule: r, passed, actual: String(value), source: (r as any).__source || '' };
    });
}

/**
 * Evaluate selector-count rules against page state.
 */
export async function evaluateSelectorRules(
  rules: CustomRule[],
  page: any,
): Promise<RuleResult[]> {
  const results: RuleResult[] = [];
  for (const r of rules.filter(r => r.kind === 'selector-count' && r.selector)) {
    try {
      const count = await page.locator(r.selector!).count();
      const passed = count <= (r.maxCount ?? 0);
      results.push({ rule: r, passed, actual: String(count), source: (r as any).__source || '' });
    } catch {
      results.push({ rule: r, passed: true, actual: 'selector error', source: (r as any).__source || '' });
    }
  }
  return results;
}
