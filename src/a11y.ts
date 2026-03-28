/**
 * Accessibility audit — WCAG 2.1 AA automated checks.
 *
 * Runs inside page.evaluate() for a single-pass audit.
 * Returns score (0-100) + findings with severity and element references.
 */

import type { Page } from 'playwright';

export interface A11yFinding {
  type: string;
  severity: 'critical' | 'warning' | 'info';
  element: string;
  details: string;
  y: number;
}

export interface A11yReport {
  score: number;
  findings: A11yFinding[];
  summary: {
    critical: number;
    warning: number;
    info: number;
  };
}

/**
 * Run a WCAG 2.1 AA accessibility audit on the current page.
 */
export async function runA11yAudit(page: Page): Promise<A11yReport> {
  const rawFindings = await page.evaluate(() => {
    const results: Array<{ type: string; severity: string; element: string; details: string; y: number }> = [];

    function descEl(el: Element): string {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : '';
      const cls = el.className && typeof el.className === 'string'
        ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
        : '';
      return `${tag}${id}${cls}`.slice(0, 60);
    }

    function getY(el: Element): number {
      try { return Math.round(el.getBoundingClientRect().top + window.scrollY); } catch { return 0; }
    }

    // ─── Missing lang attribute ─────────────────────────
    if (!document.documentElement.lang) {
      results.push({
        type: 'missing-lang',
        severity: 'critical',
        element: 'html',
        details: '<html> element has no lang attribute',
        y: 0,
      });
    }

    // ─── Images without alt ─────────────────────────────
    for (const img of document.querySelectorAll('img')) {
      if (!img.hasAttribute('alt')) {
        results.push({
          type: 'missing-alt',
          severity: 'critical',
          element: descEl(img),
          details: `Image has no alt attribute: ${(img as HTMLImageElement).src.slice(-40)}`,
          y: getY(img),
        });
      }
    }

    // ─── Inputs without labels ──────────────────────────
    for (const input of document.querySelectorAll('input, select, textarea')) {
      const inp = input as HTMLInputElement;
      if (inp.type === 'hidden' || inp.type === 'submit' || inp.type === 'button') continue;
      const hasLabel = inp.id && document.querySelector(`label[for="${inp.id}"]`);
      const hasAria = inp.getAttribute('aria-label') || inp.getAttribute('aria-labelledby');
      const hasTitle = inp.title;
      const hasPlaceholder = inp.placeholder; // Placeholder alone is insufficient but commonly used
      if (!hasLabel && !hasAria && !hasTitle) {
        results.push({
          type: 'no-label',
          severity: hasPlaceholder ? 'warning' : 'critical',
          element: descEl(input),
          details: `Input has no associated label${hasPlaceholder ? ' (placeholder is not a substitute)' : ''}`,
          y: getY(input),
        });
      }
    }

    // ─── Heading hierarchy ──────────────────────────────
    const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
    let lastLevel = 0;
    for (const h of headings) {
      const level = parseInt(h.tagName[1], 10);
      if (lastLevel > 0 && level > lastLevel + 1) {
        results.push({
          type: 'heading-skip',
          severity: 'warning',
          element: descEl(h),
          details: `Heading skips from h${lastLevel} to h${level}`,
          y: getY(h),
        });
      }
      lastLevel = level;
    }

    // ─── Touch targets too small ────────────────────────
    const interactive = document.querySelectorAll('a, button, input, select, textarea, [role=button], [tabindex]');
    for (const el of interactive) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && (rect.width < 44 || rect.height < 44)) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        results.push({
          type: 'small-target',
          severity: 'warning',
          element: descEl(el),
          details: `Touch target ${Math.round(rect.width)}x${Math.round(rect.height)}px (min 44x44px)`,
          y: getY(el),
        });
      }
    }

    // ─── Generic link text ──────────────────────────────
    const genericTexts = new Set(['click here', 'read more', 'learn more', 'here', 'more', 'link']);
    for (const a of document.querySelectorAll('a')) {
      const text = (a.textContent || '').trim().toLowerCase();
      if (genericTexts.has(text)) {
        results.push({
          type: 'generic-link',
          severity: 'warning',
          element: descEl(a),
          details: `Generic link text "${text}" — use descriptive text`,
          y: getY(a),
        });
      }
    }

    return results;
  });

  const findings = rawFindings as A11yFinding[];

  // Calculate score
  let score = 100;
  let critical = 0, warning = 0, info = 0;
  for (const f of findings) {
    if (f.severity === 'critical') { score -= 10; critical++; }
    else if (f.severity === 'warning') { score -= 3; warning++; }
    else { score -= 1; info++; }
  }
  score = Math.max(0, score);

  return {
    score,
    findings: findings as A11yFinding[],
    summary: { critical, warning, info },
  };
}

/**
 * Format a11y report as human-readable text.
 */
export function formatA11yReport(report: A11yReport, jsonMode = false): string {
  if (jsonMode) return JSON.stringify(report, null, 2);

  const lines: string[] = [];
  lines.push(`Accessibility Score: ${report.score}/100`);
  lines.push(`  Critical: ${report.summary.critical}  Warning: ${report.summary.warning}  Info: ${report.summary.info}`);

  if (report.findings.length === 0) {
    lines.push('\nNo accessibility issues detected.');
    return lines.join('\n');
  }

  lines.push('');
  for (const f of report.findings) {
    const marker = f.severity === 'critical' ? '✗' : f.severity === 'warning' ? '⚠' : 'ℹ';
    lines.push(`${marker} [${f.type}] ${f.element} — ${f.details}`);
  }

  return lines.join('\n');
}
