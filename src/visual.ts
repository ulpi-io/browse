/**
 * Visual evaluation infrastructure -- captures visual layout state and
 * detects common visual anomalies in the rendered page.
 *
 * Architecture:
 *   1. Single page.evaluate() call collects all landmarks and issues
 *   2. Landmark scan: header, nav, main, footer, section, article,
 *      plus ARIA role equivalents (dialog, alert, banner, navigation,
 *      main, contentinfo)
 *   3. Anomaly detection: contrast, overlap, overflow-x, overflow-hidden,
 *      viewport bleed
 *   4. Pure data out -- no DOM mutation, no side effects
 *
 * Used by the `visual` command (TASK-020) and the `expect` command
 * for visual assertion checks.
 */

import type { Page } from 'playwright';

// ─── Public Types ───────────────────────────────────────────────

export interface Landmark {
  tag: string;
  role?: string;
  y: number;
  height: number;
  position: string;
  zIndex: number;
  background: string;
  childSummary: string;
}

export interface VisualIssue {
  type: 'contrast' | 'overlap' | 'overflow-x' | 'overflow-hidden' | 'viewport-bleed';
  element: string;
  details: string;
  y: number;
  severity: 'critical' | 'warning';
}

export interface VisualReport {
  viewport: { width: number; height: number };
  bodyHeight: number;
  landmarks: Landmark[];
  issues: VisualIssue[];
}

// ─── Color Utilities (exported for testing) ─────────────────────

/** Named CSS colors -- subset covering the most common ones. */
const NAMED_COLORS: Record<string, [number, number, number]> = {
  black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0],
  green: [0, 128, 0], blue: [0, 0, 255], yellow: [255, 255, 0],
  cyan: [0, 255, 255], magenta: [255, 0, 255], orange: [255, 165, 0],
  purple: [128, 0, 128], gray: [128, 128, 128], grey: [128, 128, 128],
  silver: [192, 192, 192], maroon: [128, 0, 0], olive: [128, 128, 0],
  lime: [0, 255, 0], teal: [0, 128, 128], navy: [0, 0, 128],
  aqua: [0, 255, 255], fuchsia: [255, 0, 255],
  transparent: [0, 0, 0], // alpha handled separately
};

/**
 * Parse a CSS color string to {r, g, b, a}.
 * Supports: rgb(), rgba(), #fff, #ffffff, #rrggbbaa, named colors.
 * Returns null for unparseable values (gradients, currentcolor, etc.).
 */
export function parseColor(str: string): { r: number; g: number; b: number; a: number } | null {
  if (!str || str === 'currentcolor' || str === 'inherit') return null;

  const s = str.trim().toLowerCase();

  // rgb(r, g, b) or rgba(r, g, b, a)
  const rgbMatch = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/);
  if (rgbMatch) {
    return {
      r: parseInt(rgbMatch[1], 10),
      g: parseInt(rgbMatch[2], 10),
      b: parseInt(rgbMatch[3], 10),
      a: rgbMatch[4] !== undefined ? parseFloat(rgbMatch[4]) : 1,
    };
  }

  // Modern rgb(r g b / a) syntax
  const rgbSpaceMatch = s.match(/^rgba?\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+%?))?\s*\)$/);
  if (rgbSpaceMatch) {
    let a = 1;
    if (rgbSpaceMatch[4] !== undefined) {
      const raw = rgbSpaceMatch[4];
      a = raw.endsWith('%') ? parseFloat(raw) / 100 : parseFloat(raw);
    }
    return {
      r: parseInt(rgbSpaceMatch[1], 10),
      g: parseInt(rgbSpaceMatch[2], 10),
      b: parseInt(rgbSpaceMatch[3], 10),
      a,
    };
  }

  // Hex: #rgb, #rgba, #rrggbb, #rrggbbaa
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    if (hex.length === 3) {
      return {
        r: parseInt(hex[0] + hex[0], 16),
        g: parseInt(hex[1] + hex[1], 16),
        b: parseInt(hex[2] + hex[2], 16),
        a: 1,
      };
    }
    if (hex.length === 4) {
      return {
        r: parseInt(hex[0] + hex[0], 16),
        g: parseInt(hex[1] + hex[1], 16),
        b: parseInt(hex[2] + hex[2], 16),
        a: parseInt(hex[3] + hex[3], 16) / 255,
      };
    }
    if (hex.length === 6) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: 1,
      };
    }
    if (hex.length === 8) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: parseInt(hex.slice(6, 8), 16) / 255,
      };
    }
    return null;
  }

  // Named colors
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const named = NAMED_COLORS[s];
  if (named) return { r: named[0], g: named[1], b: named[2], a: 1 };

  // Gradients, var(), etc. -- unparseable
  return null;
}

/**
 * WCAG relative luminance of an sRGB color.
 * https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 */
export function luminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/**
 * WCAG contrast ratio between two relative luminance values.
 * Returns a value >= 1.0 (lighter over darker).
 */
export function contrastRatio(l1: number, l2: number): number {
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// ─── Report Formatter ───────────────────────────────────────────

/**
 * Format a VisualReport as human-readable text or JSON.
 */
export function formatVisualReport(report: VisualReport, jsonMode = false): string {
  if (jsonMode) return JSON.stringify(report, null, 2);

  const lines: string[] = [];
  lines.push(`Viewport: ${report.viewport.width}x${report.viewport.height}  Body height: ${report.bodyHeight}px`);

  // Landmarks
  if (report.landmarks.length > 0) {
    lines.push('');
    lines.push(`Landmarks (${report.landmarks.length}):`);
    for (const lm of report.landmarks) {
      const role = lm.role ? ` [${lm.role}]` : '';
      const pos = lm.position !== 'static' ? ` (${lm.position}, z:${lm.zIndex})` : '';
      lines.push(`  <${lm.tag}>${role} y:${lm.y} h:${lm.height}${pos} — ${lm.childSummary}`);
    }
  }

  // Issues
  const critical = report.issues.filter((i) => i.severity === 'critical');
  const warnings = report.issues.filter((i) => i.severity === 'warning');

  if (report.issues.length === 0) {
    lines.push('');
    lines.push('No visual issues detected.');
  } else {
    lines.push('');
    lines.push(`Issues: ${critical.length} critical, ${warnings.length} warning`);
    lines.push('');
    for (const issue of report.issues) {
      const marker = issue.severity === 'critical' ? 'CRITICAL' : 'WARNING';
      lines.push(`  [${marker}] ${issue.type}: ${issue.element}`);
      lines.push(`           ${issue.details}`);
    }
  }

  return lines.join('\n');
}

// ─── Main Capture Function ──────────────────────────────────────

/**
 * Capture visual layout state and detect anomalies.
 *
 * Runs a single page.evaluate() that:
 *   1. Scans for semantic landmarks and ARIA role elements
 *   2. Runs 5 anomaly detectors (contrast, overlap, overflow-x,
 *      overflow-hidden, viewport bleed)
 *   3. Returns a VisualReport with all findings
 */
export async function captureVisualState(page: Page): Promise<VisualReport> {
  return page.evaluate(() => {
    // ── Color utilities (duplicated inside evaluate for serialization) ──

    const NAMED: Record<string, [number, number, number]> = {
      black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0],
      green: [0, 128, 0], blue: [0, 0, 255], yellow: [255, 255, 0],
      cyan: [0, 255, 255], magenta: [255, 0, 255], orange: [255, 165, 0],
      purple: [128, 0, 128], gray: [128, 128, 128], grey: [128, 128, 128],
      silver: [192, 192, 192], maroon: [128, 0, 0], olive: [128, 128, 0],
      lime: [0, 255, 0], teal: [0, 128, 128], navy: [0, 0, 128],
      aqua: [0, 255, 255], fuchsia: [255, 0, 255],
    };

    function parseColor(str: string): { r: number; g: number; b: number; a: number } | null {
      if (!str || str === 'currentcolor' || str === 'inherit') return null;
      const s = str.trim().toLowerCase();

      const rgbMatch = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/);
      if (rgbMatch) {
        return {
          r: parseInt(rgbMatch[1], 10), g: parseInt(rgbMatch[2], 10),
          b: parseInt(rgbMatch[3], 10),
          a: rgbMatch[4] !== undefined ? parseFloat(rgbMatch[4]) : 1,
        };
      }

      const rgbSpaceMatch = s.match(/^rgba?\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+%?))?\s*\)$/);
      if (rgbSpaceMatch) {
        let a = 1;
        if (rgbSpaceMatch[4] !== undefined) {
          const raw = rgbSpaceMatch[4];
          a = raw.endsWith('%') ? parseFloat(raw) / 100 : parseFloat(raw);
        }
        return {
          r: parseInt(rgbSpaceMatch[1], 10), g: parseInt(rgbSpaceMatch[2], 10),
          b: parseInt(rgbSpaceMatch[3], 10), a,
        };
      }

      if (s.startsWith('#')) {
        const hex = s.slice(1);
        if (hex.length === 3) return { r: parseInt(hex[0] + hex[0], 16), g: parseInt(hex[1] + hex[1], 16), b: parseInt(hex[2] + hex[2], 16), a: 1 };
        if (hex.length === 4) return { r: parseInt(hex[0] + hex[0], 16), g: parseInt(hex[1] + hex[1], 16), b: parseInt(hex[2] + hex[2], 16), a: parseInt(hex[3] + hex[3], 16) / 255 };
        if (hex.length === 6) return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: 1 };
        if (hex.length === 8) return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: parseInt(hex.slice(6, 8), 16) / 255 };
        return null;
      }

      if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
      const named = NAMED[s];
      if (named) return { r: named[0], g: named[1], b: named[2], a: 1 };
      return null;
    }

    function wcagLuminance(r: number, g: number, b: number): number {
      const [rs, gs, bs] = [r, g, b].map((c) => {
        const s = c / 255;
        return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
    }

    function wcagContrastRatio(l1: number, l2: number): number {
      const lighter = Math.max(l1, l2);
      const darker = Math.min(l1, l2);
      return (lighter + 0.05) / (darker + 0.05);
    }

    /**
     * Walk ancestor chain to find the first element with a non-transparent
     * background color. Returns the computed color or null.
     */
    function getEffectiveBg(el: Element): { r: number; g: number; b: number; a: number } | null {
      let current: Element | null = el;
      while (current) {
        const style = getComputedStyle(current);
        const bg = style.backgroundColor;
        // Skip gradient/image backgrounds -- cannot determine a single color
        const bgImage = style.backgroundImage;
        if (bgImage && bgImage !== 'none') return null;

        const parsed = parseColor(bg);
        if (parsed && parsed.a > 0) {
          // If partially transparent, blend with parent
          if (parsed.a < 1) {
            const parentBg = current.parentElement ? getEffectiveBg(current.parentElement) : null;
            if (parentBg) {
              // Alpha composite: result = fg * a + bg * (1 - a)
              return {
                r: Math.round(parsed.r * parsed.a + parentBg.r * (1 - parsed.a)),
                g: Math.round(parsed.g * parsed.a + parentBg.g * (1 - parsed.a)),
                b: Math.round(parsed.b * parsed.a + parentBg.b * (1 - parsed.a)),
                a: 1,
              };
            }
            // No parent bg found -- assume white canvas
            return {
              r: Math.round(parsed.r * parsed.a + 255 * (1 - parsed.a)),
              g: Math.round(parsed.g * parsed.a + 255 * (1 - parsed.a)),
              b: Math.round(parsed.b * parsed.a + 255 * (1 - parsed.a)),
              a: 1,
            };
          }
          return parsed;
        }
        current = current.parentElement;
      }
      // Default: assume white page background
      return { r: 255, g: 255, b: 255, a: 1 };
    }

    /** Check if two bounding rectangles overlap. */
    function overlaps(
      r1: { left: number; top: number; right: number; bottom: number },
      r2: { left: number; top: number; right: number; bottom: number },
    ): boolean {
      return r1.left < r2.right && r1.right > r2.left &&
             r1.top < r2.bottom && r1.bottom > r2.top;
    }

    /** Short summary of an element's child structure. */
    function summarizeChildren(el: Element): string {
      const children = el.children;
      if (children.length === 0) {
        const text = (el.textContent || '').trim();
        return text ? `text: "${text.slice(0, 60)}"` : 'empty';
      }
      const tags: Record<string, number> = {};
      const limit = Math.min(children.length, 50); // cap scan
      for (let i = 0; i < limit; i++) {
        const tag = children[i].tagName.toLowerCase();
        tags[tag] = (tags[tag] || 0) + 1;
      }
      const parts = Object.entries(tags)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([tag, count]) => count > 1 ? `${tag} x${count}` : tag);
      if (children.length > limit) parts.push(`...+${children.length - limit}`);
      return parts.join(', ');
    }

    /** Describe an element for issue reporting. */
    function describeElement(el: Element): string {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : '';
      const cls = el.className && typeof el.className === 'string'
        ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
        : '';
      const text = (el.textContent || '').trim().slice(0, 30);
      const desc = `<${tag}${id}${cls}>`;
      return text ? `${desc} "${text}"` : desc;
    }

    // ── Landmark selectors ──────────────────────────────────────────

    const LANDMARK_TAGS = ['header', 'nav', 'main', 'footer', 'section', 'article'];
    const LANDMARK_ROLES = ['dialog', 'alert', 'banner', 'navigation', 'main', 'contentinfo'];

    // Build a single selector that covers both tag names and ARIA roles
    const tagSel = LANDMARK_TAGS.join(',');
    const roleSel = LANDMARK_ROLES.map((r) => `[role="${r}"]`).join(',');
    const landmarkSelector = `${tagSel},${roleSel}`;

    // ── Collect landmarks ───────────────────────────────────────────

    type LandmarkData = {
      tag: string;
      role?: string;
      y: number;
      height: number;
      position: string;
      zIndex: number;
      background: string;
      childSummary: string;
    };

    const landmarks: LandmarkData[] = [];
    const landmarkEls = document.querySelectorAll(landmarkSelector);

    for (const el of landmarkEls) {
      const style = getComputedStyle(el);
      if (style.display === 'none') continue;

      const rect = el.getBoundingClientRect();
      const role = el.getAttribute('role') || undefined;
      const zIndex = parseInt(style.zIndex, 10);

      landmarks.push({
        tag: el.tagName.toLowerCase(),
        role,
        y: Math.round(rect.top + window.scrollY),
        height: Math.round(rect.height),
        position: style.position,
        zIndex: isNaN(zIndex) ? 0 : zIndex,
        background: style.backgroundColor,
        childSummary: summarizeChildren(el),
      });
    }

    // ── Anomaly Detection ───────────────────────────────────────────

    type IssueData = {
      type: 'contrast' | 'overlap' | 'overflow-x' | 'overflow-hidden' | 'viewport-bleed';
      element: string;
      details: string;
      y: number;
      severity: 'critical' | 'warning';
    };

    const issues: IssueData[] = [];
    const MAX_ISSUES_PER_TYPE = 20; // Cap to avoid huge reports

    // ── 1. Contrast Detection ───────────────────────────────────────
    // Find text elements and check fg/bg contrast ratio.

    const contrastIssues: IssueData[] = [];
    const textWalker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const text = (node.textContent || '').trim();
          if (!text) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const style = getComputedStyle(parent);
          if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      },
    );

    const seenContrastElements = new Set<Element>();
    let textNode: Node | null;
    while ((textNode = textWalker.nextNode()) && contrastIssues.length < MAX_ISSUES_PER_TYPE) {
      const parent = textNode.parentElement!;
      if (seenContrastElements.has(parent)) continue;
      seenContrastElements.add(parent);

      const style = getComputedStyle(parent);
      const fgColor = parseColor(style.color);
      if (!fgColor) continue;

      const bgColor = getEffectiveBg(parent);
      if (!bgColor) continue; // gradient or image bg -- skip

      const fgLum = wcagLuminance(fgColor.r, fgColor.g, fgColor.b);
      const bgLum = wcagLuminance(bgColor.r, bgColor.g, bgColor.b);
      const ratio = wcagContrastRatio(fgLum, bgLum);

      // Determine if "large text" (>= 24px, or >= 18.66px bold)
      const fontSize = parseFloat(style.fontSize);
      const fontWeight = parseInt(style.fontWeight, 10) || (style.fontWeight === 'bold' ? 700 : 400);
      const isLargeText = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);

      const threshold = isLargeText ? 3.0 : 4.5;

      if (ratio < threshold) {
        const rect = parent.getBoundingClientRect();
        contrastIssues.push({
          type: 'contrast',
          element: describeElement(parent),
          details: `contrast ${ratio.toFixed(2)}:1 (need ${threshold}:1) — fg: ${style.color}, bg: ${style.backgroundColor}`,
          y: Math.round(rect.top + window.scrollY),
          severity: ratio < 2.0 ? 'critical' : 'warning',
        });
      }
    }
    issues.push(...contrastIssues);

    // ── 2. Overlap Detection ────────────────────────────────────────
    // Find positioned elements and check for unintended overlaps.

    const overlapIssues: IssueData[] = [];
    const positioned: Array<{ el: Element; rect: DOMRect; z: number }> = [];

    const allEls = document.body.querySelectorAll('*');
    for (const el of allEls) {
      const style = getComputedStyle(el);
      if (style.display === 'none') continue;
      const pos = style.position;
      if (pos === 'absolute' || pos === 'fixed' || pos === 'sticky') {
        const rect = el.getBoundingClientRect();
        // Skip zero-size elements
        if (rect.width === 0 || rect.height === 0) continue;
        const z = parseInt(style.zIndex, 10);
        positioned.push({ el, rect, z: isNaN(z) ? 0 : z });
      }
    }

    // Check pairs -- limit to avoid O(n^2) explosion on large pages
    const overlapLimit = Math.min(positioned.length, 100);
    for (let i = 0; i < overlapLimit && overlapIssues.length < MAX_ISSUES_PER_TYPE; i++) {
      for (let j = i + 1; j < overlapLimit && overlapIssues.length < MAX_ISSUES_PER_TYPE; j++) {
        const a = positioned[i];
        const b = positioned[j];

        // Skip if one contains the other (parent-child relationship)
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;

        if (overlaps(
          { left: a.rect.left, top: a.rect.top, right: a.rect.right, bottom: a.rect.bottom },
          { left: b.rect.left, top: b.rect.top, right: b.rect.right, bottom: b.rect.bottom },
        )) {
          // Flag when z-indices are equal (suggests unintended stacking)
          if (a.z === b.z) {
            overlapIssues.push({
              type: 'overlap',
              element: describeElement(a.el),
              details: `overlaps ${describeElement(b.el)} — both z-index: ${a.z}`,
              y: Math.round(Math.min(a.rect.top, b.rect.top) + window.scrollY),
              severity: 'warning',
            });
          }
        }
      }
    }
    issues.push(...overlapIssues);

    // ── 3. Overflow-X Detection ─────────────────────────────────────
    // Elements where scrollWidth > clientWidth + 2.

    const overflowXIssues: IssueData[] = [];
    for (const el of allEls) {
      if (overflowXIssues.length >= MAX_ISSUES_PER_TYPE) break;
      if (el.scrollWidth > el.clientWidth + 2) {
        const style = getComputedStyle(el);
        if (style.display === 'none') continue;
        // Skip elements that are intentionally scrollable (overflow: auto/scroll)
        if (style.overflowX === 'auto' || style.overflowX === 'scroll') continue;
        const rect = el.getBoundingClientRect();
        overflowXIssues.push({
          type: 'overflow-x',
          element: describeElement(el),
          details: `scrollWidth ${el.scrollWidth}px > clientWidth ${el.clientWidth}px (overflow: ${Math.round(el.scrollWidth - el.clientWidth)}px)`,
          y: Math.round(rect.top + window.scrollY),
          severity: 'warning',
        });
      }
    }
    issues.push(...overflowXIssues);

    // ── 4. Overflow-Hidden Detection ────────────────────────────────
    // Elements with overflow:hidden where content exceeds container.

    const overflowHiddenIssues: IssueData[] = [];
    for (const el of allEls) {
      if (overflowHiddenIssues.length >= MAX_ISSUES_PER_TYPE) break;
      const style = getComputedStyle(el);
      if (style.display === 'none') continue;
      if (style.overflow === 'hidden' || style.overflowY === 'hidden') {
        const contentHeight = el.scrollHeight;
        const elementHeight = el.clientHeight;
        // Only flag significant clipping (> 10px)
        if (contentHeight > elementHeight + 10) {
          const rect = el.getBoundingClientRect();
          overflowHiddenIssues.push({
            type: 'overflow-hidden',
            element: describeElement(el),
            details: `content height ${contentHeight}px exceeds container ${elementHeight}px (clipped: ${Math.round(contentHeight - elementHeight)}px)`,
            y: Math.round(rect.top + window.scrollY),
            severity: 'warning',
          });
        }
      }
    }
    issues.push(...overflowHiddenIssues);

    // ── 5. Viewport Bleed Detection ─────────────────────────────────
    // Elements with right edge > window.innerWidth.

    const viewportBleedIssues: IssueData[] = [];
    const vw = window.innerWidth;
    for (const el of allEls) {
      if (viewportBleedIssues.length >= MAX_ISSUES_PER_TYPE) break;
      const style = getComputedStyle(el);
      if (style.display === 'none') continue;
      const rect = el.getBoundingClientRect();
      // Skip zero-size elements and trivially small bleeds (< 1px)
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.right > vw + 1) {
        viewportBleedIssues.push({
          type: 'viewport-bleed',
          element: describeElement(el),
          details: `right edge at ${Math.round(rect.right)}px exceeds viewport width ${vw}px (bleed: ${Math.round(rect.right - vw)}px)`,
          y: Math.round(rect.top + window.scrollY),
          severity: rect.right - vw > 50 ? 'critical' : 'warning',
        });
      }
    }
    issues.push(...viewportBleedIssues);

    // ── Build report ────────────────────────────────────────────────

    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      bodyHeight: document.body.scrollHeight,
      landmarks,
      issues,
    };
  });
}
