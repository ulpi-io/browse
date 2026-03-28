/**
 * Inspection and analysis commands — snapshot, snapshot-diff, diff, frame, find, inspect, detect, coverage, perf-audit
 */

import type { BrowserTarget } from '../../browser/target';
import type { Session } from '../../session/manager';
import { handleSnapshot } from '../../browser/snapshot';
import { DEFAULTS } from '../../constants';
import * as Diff from 'diff';

/** Pad string right to width */
function padR(str: string, w: number): string {
  return str.length >= w ? str : str + ' '.repeat(w - str.length);
}
/** Pad string left to width */
function padL(str: string, w: number): string {
  return str.length >= w ? str : ' '.repeat(w - str.length) + str;
}

const LOCAL_DIR = process.env.BROWSE_LOCAL_DIR || '/tmp';

export async function handleInspectionCommand(
  command: string,
  args: string[],
  bm: BrowserTarget,
  currentSession?: Session,
): Promise<string> {
  switch (command) {
    case 'snapshot': {
      return await handleSnapshot(args, bm);
    }

    case 'snapshot-diff': {
      const previous = bm.getLastSnapshot();
      if (!previous) {
        return 'No previous snapshot to compare against. Run "snapshot" first.';
      }

      const snapshotArgs = bm.getLastSnapshotOpts();
      const current = await handleSnapshot(snapshotArgs, bm);

      if (!current || current === '(no accessible elements found)' || current === '(no interactive elements found)') {
        return 'Current page has no accessible elements to compare.';
      }

      const stripRefs = (text: string) => text.replace(/@e\d+ /g, '');
      const changes = Diff.diffLines(stripRefs(previous), stripRefs(current));
      const output: string[] = ['--- previous snapshot', '+++ current snapshot', ''];
      let hasChanges = false;

      for (const part of changes) {
        if (part.added || part.removed) hasChanges = true;
        const prefix = part.added ? '+' : part.removed ? '-' : ' ';
        const lines = part.value.split('\n').filter(l => l.length > 0);
        for (const line of lines) {
          output.push(`${prefix} ${line}`);
        }
      }

      if (!hasChanges) {
        return 'No changes detected between snapshots.';
      }

      return output.join('\n');
    }

    case 'diff': {
      const [url1, url2] = args;
      if (!url1 || !url2) throw new Error('Usage: browse diff <url1> <url2>');

      const extractText = () => {
        const body = document.body;
        if (!body) return '';
        const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG']);
        const lines: string[] = [];
        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            let el = node.parentElement;
            while (el && el !== body) {
              if (SKIP.has(el.tagName)) return NodeFilter.FILTER_REJECT;
              const style = getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
              el = el.parentElement;
            }
            return NodeFilter.FILTER_ACCEPT;
          },
        });
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const text = (node.textContent || '').trim();
          if (text) lines.push(text);
        }
        return lines.join('\n');
      };

      const previousTabId = bm.getActiveTabId();
      const tempTabId = await bm.newTab(url1);
      const tempPage = bm.getPage();

      let text1: string;
      let text2: string;
      try {
        text1 = await tempPage.evaluate(extractText);
        await tempPage.goto(url2, { waitUntil: 'domcontentloaded', timeout: DEFAULTS.COMMAND_TIMEOUT_MS });
        text2 = await tempPage.evaluate(extractText);
      } finally {
        await bm.closeTab(tempTabId);
        if (bm.hasTab(previousTabId)) {
          bm.switchTab(previousTabId);
        }
      }

      const changes = Diff.diffLines(text1, text2);
      const output: string[] = [`--- ${url1}`, `+++ ${url2}`, ''];

      for (const part of changes) {
        const prefix = part.added ? '+' : part.removed ? '-' : ' ';
        const lines = part.value.split('\n').filter(l => l.length > 0);
        for (const line of lines) {
          output.push(`${prefix} ${line}`);
        }
      }

      return output.join('\n');
    }

    case 'frame': {
      if (args[0] === 'main' || args[0] === 'top') {
        bm.resetFrame();
        return 'Switched to main frame';
      }
      const selector = args[0];
      if (!selector) throw new Error('Usage: browse frame <selector> | browse frame main');
      // Verify the iframe exists and is accessible
      const page = bm.getPage();
      const frameEl = page.locator(selector);
      const count = await frameEl.count();
      if (count === 0) throw new Error(`iframe not found: ${selector}`);
      const handle = await frameEl.elementHandle({ timeout: DEFAULTS.ACTION_TIMEOUT_MS });
      if (!handle) throw new Error(`iframe not found: ${selector}`);
      const frame = await handle.contentFrame();
      if (!frame) throw new Error(`Element ${selector} is not an iframe`);
      bm.setFrame(selector);
      return `Switched to frame: ${selector}`;
    }

    case 'find': {
      const root = bm.getLocatorRoot();
      const page = bm.getPage();
      const sub = args[0];
      if (!sub) throw new Error('Usage: browse find role|text|label|placeholder|testid|alt|title|first|last|nth <query>');
      const query = args[1];
      if (!query) throw new Error(`Usage: browse find ${sub} <query>`);

      let locator;
      switch (sub) {
        case 'role': {
          const nameOpt = args[2];
          locator = nameOpt ? root.getByRole(query as any, { name: nameOpt }) : root.getByRole(query as any);
          break;
        }
        case 'text':
          locator = root.getByText(query);
          break;
        case 'label':
          locator = root.getByLabel(query);
          break;
        case 'placeholder':
          locator = root.getByPlaceholder(query);
          break;
        case 'testid':
          locator = root.getByTestId(query);
          break;
        case 'alt':
          locator = root.getByAltText(query);
          break;
        case 'title':
          locator = root.getByTitle(query);
          break;
        case 'first': {
          locator = page.locator(query).first();
          const text = await locator.textContent({ timeout: 2000 }).catch(() => '') || '';
          const total = await page.locator(query).count();
          return `Found ${total} match(es), first: "${text.trim().slice(0, 100)}"`;
        }
        case 'last': {
          locator = page.locator(query).last();
          const text = await locator.textContent({ timeout: 2000 }).catch(() => '') || '';
          const total = await page.locator(query).count();
          return `Found ${total} match(es), last: "${text.trim().slice(0, 100)}"`;
        }
        case 'nth': {
          const n = parseInt(query, 10);
          const sel = args[2];
          if (isNaN(n) || !sel) throw new Error('Usage: browse find nth <index> <selector>');
          locator = page.locator(sel).nth(n);
          const text = await locator.textContent({ timeout: 2000 }).catch(() => '') || '';
          const total = await page.locator(sel).count();
          return `Found ${total} match(es), nth(${n}): "${text.trim().slice(0, 100)}"`;
        }
        default:
          throw new Error(`Unknown find type: ${sub}. Use role|text|label|placeholder|testid|alt|title|first|last|nth`);
      }

      const count2 = await locator.count();
      let firstText = '';
      if (count2 > 0) {
        try {
          firstText = (await locator.first().textContent({ timeout: 2000 })) || '';
          firstText = firstText.trim().slice(0, 100);
        } catch {}
      }
      return `Found ${count2} match(es)${firstText ? `: "${firstText}"` : ''}`;
    }

    case 'inspect': {
      const debugPort = parseInt(process.env.BROWSE_DEBUG_PORT || '0', 10);
      if (!debugPort) {
        throw new Error(
          'DevTools inspect requires BROWSE_DEBUG_PORT to be set.\n' +
          'Restart with: BROWSE_DEBUG_PORT=9222 browse restart\n' +
          'Then run: browse inspect'
        );
      }
      try {
        const resp = await fetch(`http://127.0.0.1:${debugPort}/json`, { signal: AbortSignal.timeout(2000) });
        const pages = await resp.json() as any[];
        const currentUrl = bm.getCurrentUrl();
        const target = pages.find((p: any) => p.url === currentUrl) || pages[0];
        if (!target) throw new Error('No debuggable pages found');
        return [
          `DevTools URL: ${target.devtoolsFrontendUrl}`,
          `Page: ${target.title} (${target.url})`,
          `WebSocket: ${target.webSocketDebuggerUrl}`,
        ].join('\n');
      } catch (err: any) {
        if (err.message.includes('BROWSE_DEBUG_PORT')) throw err;
        throw new Error(`Cannot reach Chrome debug port at ${debugPort}: ${err.message}`);
      }
    }

    case 'detect': {
      const page = bm.getPage();
      // Lazy import to avoid loading detection modules on server startup
      const { detectStack } = await import('../../detection');
      const buffers = currentSession?.buffers;
      const networkEntries = buffers?.networkBuffer || [];
      const fingerprint = await detectStack(page, networkEntries);

      // Format output
      const lines: string[] = [];

      // Stack section
      lines.push('Stack:');
      if (fingerprint.frameworks.length === 0) {
        lines.push('  No framework detected');
      } else {
        for (const fw of fingerprint.frameworks) {
          const version = fw.version ? ` ${fw.version}` : '';
          const mode = fw.buildMode ? ` (${fw.buildMode})` : '';
          const configParts = Object.entries(fw.config || {})
            .filter(([_, v]) => v !== null && v !== undefined && v !== false && v !== 0 && v !== '')
            .slice(0, 3)
            .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
          const configStr = configParts.length ? `, ${configParts.join(', ')}` : '';
          lines.push(`  ${fw.category.padEnd(18)} ${fw.name}${version}${mode}${configStr}`);

          // Show critical perf hints inline
          for (const hint of fw.perfHints.filter(h => h.severity === 'critical')) {
            lines.push(`    ! ${hint.message}`);
          }
        }
      }

      // Infrastructure section
      lines.push('');
      lines.push('Infrastructure:');
      const infra = fingerprint.infrastructure;
      lines.push(`  CDN:          ${infra.cdn.provider || 'none detected'}${infra.cdn.cacheStatus ? ` (cache: ${infra.cdn.cacheStatus})` : ''}`);
      lines.push(`  Protocol:     ${infra.protocol.dominant} (${Object.entries(infra.protocol.breakdown).map(([k, v]) => `${k}: ${v}%`).join(', ')})`);
      lines.push(`  Compression:  ${Object.entries(infra.compression.byType).map(([type, data]) => `${type}: ${data.brotli + data.gzip}% compressed`).join(', ') || 'no data'}`);
      lines.push(`  Cache rate:   ${infra.caching.hitRate}% (${infra.caching.cachedCount}/${infra.caching.totalResources} resources)`);
      lines.push(`  DNS origins:  ${infra.dns.uniqueOrigins} unique${infra.dns.missingPreconnect.length ? ` (${infra.dns.missingPreconnect.length} missing preconnect)` : ''}`);
      if (infra.serviceWorker.registered) {
        lines.push(`  SW:           active (${infra.serviceWorker.strategy || 'unknown strategy'})`);
      }
      lines.push(`  DOM:          ${infra.domComplexity.totalNodes.toLocaleString()} nodes, depth ${infra.domComplexity.maxDepth}${infra.domComplexity.largestSubtree ? `, largest: ${infra.domComplexity.largestSubtree.tag}${infra.domComplexity.largestSubtree.id ? '#' + infra.domComplexity.largestSubtree.id : ''} (${infra.domComplexity.largestSubtree.descendants} nodes)` : ''}`);

      // SaaS section (if detected)
      if (fingerprint.saas.length > 0) {
        lines.push('');
        lines.push('Platform:');
        for (const platform of fingerprint.saas) {
          lines.push(`  ${platform.name} (${platform.category})`);
          if (platform.apps.length > 0) {
            lines.push(`  Apps/Plugins: ${platform.apps.length}`);
            for (const app of platform.apps.slice(0, 5)) {
              lines.push(`    ${app.name.padEnd(25)} ${app.totalSizeKB}KB  ${app.loadTiming}`);
            }
            if (platform.apps.length > 5) lines.push(`    ... and ${platform.apps.length - 5} more`);
          }
        }
      }

      // Third-party section
      if (fingerprint.thirdParty.length > 0) {
        lines.push('');
        const totalTP = fingerprint.thirdParty.reduce((s, t) => s + t.totalSizeKB, 0);
        lines.push(`Third-Party (${totalTP}KB total):`);
        for (const tp of fingerprint.thirdParty.slice(0, 10)) {
          lines.push(`  ${tp.domain.padEnd(30)} ${String(tp.totalSizeKB + 'KB').padStart(8)}   ${String(tp.scriptCount).padStart(2)} scripts   ${tp.category}`);
        }
        if (fingerprint.thirdParty.length > 10) lines.push(`  ... and ${fingerprint.thirdParty.length - 10} more`);
      }

      return lines.join('\n');
    }

    case 'coverage': {
      const sub = args[0];
      if (!sub || !['start', 'stop'].includes(sub)) {
        throw new Error('Usage: browse coverage start | stop');
      }

      if (sub === 'start') {
        await bm.startCoverage();
        return 'Coverage collection started. Navigate to pages, then run "browse coverage stop" to see results.';
      }

      // sub === 'stop'
      const result = await bm.stopCoverage();

      const formatBytes = (bytes: number): string => {
        if (bytes < 1024) return `${bytes}B`;
        if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
      };

      const formatEntries = (entries: Array<{ url: string; totalBytes: number; usedBytes: number; unusedBytes: number; unusedPct: number }>, label: string): string => {
        if (!entries.length) return `${label}:\n  No coverage data\n`;
        const sorted = [...entries].sort((a, b) => b.unusedBytes - a.unusedBytes);
        const lines = sorted.map(e => {
          const name = e.url ? new URL(e.url).pathname.split('/').pop() || e.url : '[inline]';
          const total = formatBytes(e.totalBytes);
          const used = formatBytes(e.usedBytes);
          const pct = Math.round(e.unusedPct);
          const wasted = formatBytes(e.unusedBytes);
          return `  ${name.padEnd(30)} ${total.padStart(10)}   used: ${used.padStart(10)} (${(100 - pct + '%').padStart(4)})   wasted: ${wasted}`;
        });
        const totalBytes = entries.reduce((s, e) => s + e.totalBytes, 0);
        const usedBytes = entries.reduce((s, e) => s + e.usedBytes, 0);
        const wastedBytes = totalBytes - usedBytes;
        const wastedPct = totalBytes > 0 ? Math.round(wastedBytes / totalBytes * 100) : 0;
        lines.push(`  ${'Total'.padEnd(30)} ${formatBytes(totalBytes).padStart(10)}   used: ${formatBytes(usedBytes).padStart(10)} (${(100 - wastedPct + '%').padStart(4)})   wasted: ${formatBytes(wastedBytes)}`);
        return `${label}:\n${lines.join('\n')}\n`;
      };

      const sections: string[] = [];
      sections.push(formatEntries(result.js, 'JavaScript'));
      sections.push(formatEntries(result.css, 'CSS'));

      // Grand total
      const allEntries = [...result.js, ...result.css];
      if (allEntries.length > 0) {
        const grandTotal = allEntries.reduce((s, e) => s + e.totalBytes, 0);
        const grandUsed = allEntries.reduce((s, e) => s + e.usedBytes, 0);
        const grandWasted = grandTotal - grandUsed;
        const grandPct = grandTotal > 0 ? Math.round(grandWasted / grandTotal * 100) : 0;
        sections.push(`Grand Total: ${formatBytes(grandTotal)}   used: ${formatBytes(grandUsed)} (${100 - grandPct}%)   wasted: ${formatBytes(grandWasted)} (${grandPct}%)`);
      }

      return sections.join('\n');
    }

    case 'perf-audit': {
      // Check for subcommands before falling through to default audit
      const subcommand = args[0];

      // ── save [name] ──────────────────────────────────────────────────────
      if (subcommand === 'save') {
        const subArgs = args.slice(1);
        const flags = new Set(subArgs.filter(a => a.startsWith('--')));
        const positionalArgs = subArgs.filter(a => !a.startsWith('--'));
        const jsonOutput = flags.has('--json');
        const options = {
          includeCoverage: !flags.has('--no-coverage'),
          includeDetection: !flags.has('--no-detect'),
        };

        // Separate name from URL: last positional that looks like a URL is navigated to
        let name: string | undefined;
        let url: string | undefined;
        for (const arg of positionalArgs) {
          if (arg.startsWith('http://') || arg.startsWith('https://')) {
            url = arg;
          } else {
            name = arg;
          }
        }

        if (url) {
          const { handleWriteCommand } = await import('../write');
          await handleWriteCommand('goto', [url], bm, currentSession?.domainFilter);
        }

        const { runPerfAudit } = await import('../../perf-audit');
        const { formatPerfAudit } = await import('../../perf-audit/formatter');
        const { saveAudit } = await import('../../perf-audit/persist');

        const networkEntries = currentSession?.buffers?.networkBuffer || [];
        const report = await runPerfAudit(bm, networkEntries, options);

        // Auto-generate name from current page URL if not provided
        if (!name) {
          try {
            const pageUrl = new URL(bm.getCurrentUrl());
            const host = pageUrl.hostname.replace(/\./g, '-');
            const date = new Date().toISOString().slice(0, 10);
            name = `${host}-${date}`;
          } catch {
            name = `audit-${new Date().toISOString().slice(0, 10)}`;
          }
        }

        const filePath = saveAudit(LOCAL_DIR, name, report);
        const formatted = formatPerfAudit(report, jsonOutput);
        return `${formatted}\n\nAudit saved: ${filePath}`;
      }

      // ── compare <baseline> [current] ─────────────────────────────────────
      if (subcommand === 'compare') {
        if (!args[1]) throw new Error('Usage: browse perf-audit compare <baseline> [current]');

        const subArgs = args.slice(1);
        const flags = new Set(subArgs.filter(a => a.startsWith('--')));
        const positionalArgs = subArgs.filter(a => !a.startsWith('--'));
        const jsonOutput = flags.has('--json');

        const { loadAudit } = await import('../../perf-audit/persist');
        const { diffAuditReports } = await import('../../perf-audit/diff');
        const { formatAuditDiff } = await import('../../perf-audit/formatter');

        const baseline = loadAudit(LOCAL_DIR, positionalArgs[0]);

        let current;
        if (positionalArgs[1]) {
          current = loadAudit(LOCAL_DIR, positionalArgs[1]);
        } else {
          // Run a live audit as the current snapshot
          const options = {
            includeCoverage: !flags.has('--no-coverage'),
            includeDetection: !flags.has('--no-detect'),
          };
          const { runPerfAudit } = await import('../../perf-audit');
          const networkEntries = currentSession?.buffers?.networkBuffer || [];
          current = await runPerfAudit(bm, networkEntries, options);
        }

        const diff = diffAuditReports(baseline, current);
        return formatAuditDiff(diff, jsonOutput);
      }

      // ── list ─────────────────────────────────────────────────────────────
      if (subcommand === 'list') {
        const { listAudits } = await import('../../perf-audit/persist');
        const entries = listAudits(LOCAL_DIR);
        if (entries.length === 0) return '(no saved audits)';

        const lines: string[] = [];
        lines.push(`${padR('Name', 40)} ${padL('Size', 10)} ${'Date'}`);
        for (const e of entries) {
          const sizeStr = e.sizeBytes < 1024
            ? `${e.sizeBytes}B`
            : `${Math.round(e.sizeBytes / 1024)}KB`;
          const dateStr = e.date.slice(0, 19).replace('T', ' ');
          lines.push(`${padR(e.name, 40)} ${padL(sizeStr, 10)} ${dateStr}`);
        }
        return lines.join('\n');
      }

      // ── delete <name> ────────────────────────────────────────────────────
      if (subcommand === 'delete') {
        if (!args[1]) throw new Error('Usage: browse perf-audit delete <name>');
        const { deleteAudit } = await import('../../perf-audit/persist');
        deleteAudit(LOCAL_DIR, args[1]);
        return `Audit deleted: ${args[1]}`;
      }

      // ── Default: run audit (existing behavior) ───────────────────────────
      {
        const flags = new Set(args.filter(a => a.startsWith('--')));
        const positionalArgs = args.filter(a => !a.startsWith('--'));
        const url = positionalArgs[0];

        const options = {
          includeCoverage: !flags.has('--no-coverage'),
          includeDetection: !flags.has('--no-detect'),
        };
        const jsonOutput = flags.has('--json');

        if (url) {
          const { handleWriteCommand } = await import('../write');
          await handleWriteCommand('goto', [url], bm, currentSession?.domainFilter);
        }

        const { runPerfAudit } = await import('../../perf-audit');
        const { formatPerfAudit } = await import('../../perf-audit/formatter');

        const networkEntries = currentSession?.buffers?.networkBuffer || [];
        const report = await runPerfAudit(bm, networkEntries, options);

        return formatPerfAudit(report, jsonOutput);
      }
    }

    case 'api': {
      const method = (args[0] || '').toUpperCase();
      if (!method || !args[1]) throw new Error('Usage: browse api <method> <url> [--body <json>] [--header <k:v>]');
      const url = args[1];

      // Parse --body and --header flags
      let body: string | undefined;
      const headers: Record<string, string> = {};
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--body' && args[i + 1]) {
          body = args[++i];
        } else if (args[i] === '--header' && args[i + 1]) {
          const hdr = args[++i];
          const colonIdx = hdr.indexOf(':');
          if (colonIdx > 0) {
            headers[hdr.slice(0, colonIdx).trim()] = hdr.slice(colonIdx + 1).trim();
          }
        }
      }

      // If body is provided and no Content-Type set, default to JSON
      if (body && !headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
      }

      const page = bm.getPage();
      const result = await page.evaluate(async ({ method, url, body, headers }) => {
        try {
          const opts: RequestInit = { method, headers };
          if (body) opts.body = body;
          const res = await fetch(url, opts);
          const contentType = res.headers.get('content-type') || '';
          const resHeaders: Record<string, string> = {};
          res.headers.forEach((v, k) => { resHeaders[k] = v; });

          let resBody: string;
          if (contentType.includes('json')) {
            try {
              resBody = JSON.stringify(await res.json(), null, 2);
            } catch {
              resBody = await res.text();
            }
          } else {
            resBody = await res.text();
          }

          return {
            ok: true,
            status: res.status,
            statusText: res.statusText,
            headers: resHeaders,
            body: resBody,
          };
        } catch (err: any) {
          return { ok: false, error: err.message || String(err) };
        }
      }, { method, url, body, headers });

      if (!result.ok) {
        if (result.error?.includes('Failed to fetch') || result.error?.includes('NetworkError')) {
          throw new Error(`Connection refused: ${url}. Is the API server running?`);
        }
        if (result.error?.includes('CORS') || result.error?.includes('blocked')) {
          throw new Error(`CORS blocked: origin mismatch. Navigate to the API's origin first, or use the --header flag.`);
        }
        throw new Error(`API request failed: ${result.error}`);
      }

      const lines: string[] = [];
      lines.push(`${result.status} ${result.statusText}`);
      lines.push('');
      for (const [k, v] of Object.entries(result.headers || {})) {
        lines.push(`${k}: ${v}`);
      }
      lines.push('');
      lines.push(result.body || '');
      return lines.join('\n');
    }

    default:
      throw new Error(`Unknown inspection command: ${command}`);
  }
}
