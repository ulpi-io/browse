#!/usr/bin/env bun
/**
 * Benchmark: @ulpi/browse vs @playwright/mcp
 *
 * Measures what each tool dumps into an AI agent's context window
 * for the same pages. Runs in two phases (separate Chromium processes):
 *   Phase 1: @playwright/mcp — ariaSnapshot after navigate (in-process)
 *   Phase 2: @ulpi/browse — goto + snapshot -i (subprocess)
 *
 * Usage:
 *   bun run benchmark.ts                    # all sites
 *   bun run benchmark.ts --phase2-worker    # internal: subprocess mode
 *
 * Output: BENCHMARKS.md (overwritten with fresh data)
 */

import { chromium } from 'playwright';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// ─── Sites ──────────────────────────────────────────────────────

interface PageConfig { site: string; page: string; url: string }

const PAGES: PageConfig[] = [
  { site: 'mumzworld.com', page: 'Homepage', url: 'https://www.mumzworld.com' },
  { site: 'mumzworld.com', page: 'Search',   url: 'https://www.mumzworld.com/en/search?q=strollers' },
  { site: 'mumzworld.com', page: 'PDP',      url: 'https://www.mumzworld.com/en/doona-infant-car-seat-and-stroller-nitro-black-550850' },
  { site: 'amazon.com',    page: 'Homepage', url: 'https://www.amazon.com' },
  { site: 'amazon.com',    page: 'Search',   url: 'https://www.amazon.com/s?k=baby+stroller' },
  { site: 'ebay.com',      page: 'Homepage', url: 'https://www.ebay.com' },
  { site: 'ebay.com',      page: 'Search',   url: 'https://www.ebay.com/sch/i.html?_nkw=baby+stroller' },
  { site: 'ebay.com',      page: 'PDP',      url: 'https://www.ebay.com/itm/276855553922' },
  { site: 'nike.com',      page: 'Homepage', url: 'https://www.nike.com' },
  { site: 'nike.com',      page: 'Search',   url: 'https://www.nike.com/w?q=running+shoes' },
];

const SETTLE_MS = 2500;
const MIN_VALID_BYTES = 200; // pages returning less are bot-blocked

// ─── Helpers ────────────────────────────────────────────────────

function tokOf(bytes: number): number { return Math.round(bytes / 4); }
function fmtB(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(2)} MB`;
}
function fmtT(n: number): string { return `~${n.toLocaleString()}`; }

// ─── Data shape ─────────────────────────────────────────────────

interface Row {
  site: string; page: string;
  pw_nav: number; pw_html: number;
  br_goto: number; br_text: number; br_snap: number; br_snapI: number;
  br_links: number; br_forms: number;
}

// ═══════════════════════════════════════════════════════════════
// Phase 2 worker mode (runs in subprocess)
// ═══════════════════════════════════════════════════════════════

if (process.argv.includes('--phase2-worker')) {
  const { BrowserManager } = await import('./src/browser-manager');
  const { handleReadCommand } = await import('./src/commands/read');
  const { handleWriteCommand } = await import('./src/commands/write');
  const { handleMetaCommand } = await import('./src/commands/meta');

  const bm = new BrowserManager();
  await bm.launch();
  const shutdown = async () => {};
  const results: Record<string, any> = {};

  for (const pc of PAGES) {
    const key = `${pc.site}|${pc.page}`;
    try {
      const g = await handleWriteCommand('goto', [pc.url], bm);
      await Bun.sleep(SETTLE_MS);
      const text = await handleReadCommand('text', [], bm);
      const snap = await handleMetaCommand('snapshot', [], bm, shutdown);
      const snapI = await handleMetaCommand('snapshot', ['-i'], bm, shutdown);
      const links = await handleReadCommand('links', [], bm);
      const forms = await handleReadCommand('forms', [], bm);
      results[key] = { goto: g.length, text: text.length, snap: snap.length, snapI: snapI.length, links: links.length, forms: forms.length };
      console.error(`    ${pc.site.padEnd(18)} ${pc.page.padEnd(10)} snap-i: ${fmtB(snapI.length).padEnd(12)} text: ${fmtB(text.length)}`);
    } catch (e: any) {
      results[key] = { goto: 0, text: 0, snap: 0, snapI: 0, links: 0, forms: 0 };
      console.error(`    ${pc.site.padEnd(18)} ${pc.page.padEnd(10)} SKIP: ${e.message.slice(0, 50)}`);
    }
  }

  await Promise.race([bm.close().catch(() => {}), new Promise(r => setTimeout(r, 3000))]);
  // Output JSON to stdout for the parent to parse
  console.log(JSON.stringify(results));
  process.exit(0);
}

// ═══════════════════════════════════════════════════════════════
// Main orchestrator
// ═══════════════════════════════════════════════════════════════

async function phase1(): Promise<Map<string, { nav: number; html: number }>> {
  console.log('\n  Phase 1: @playwright/mcp (ariaSnapshot after navigate)\n');

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const page = await ctx.newPage();
  const data = new Map<string, { nav: number; html: number }>();

  for (const pc of PAGES) {
    const key = `${pc.site}|${pc.page}`;
    process.stdout.write(`    ${pc.site.padEnd(18)} ${pc.page.padEnd(10)} `);
    try {
      await page.goto(pc.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await new Promise(r => setTimeout(r, SETTLE_MS));
      const aria = await page.locator('body').ariaSnapshot().catch(() => '');
      const html = await page.content();
      const title = await page.title().catch(() => '');
      const nav = `Page URL: ${page.url()}\nPage title: ${title}\n\n${aria}`;
      data.set(key, { nav: nav.length, html: html.length });
      console.log(`nav: ${fmtB(nav.length).padEnd(12)} html: ${fmtB(html.length)}`);
    } catch (e: any) {
      data.set(key, { nav: 0, html: 0 });
      console.log(`SKIP: ${e.message.slice(0, 50)}`);
    }
  }

  await browser.close();
  return data;
}

function phase2(): Map<string, { goto: number; text: number; snap: number; snapI: number; links: number; forms: number }> {
  console.log('\n  Phase 2: @ulpi/browse (subprocess)\n');

  const stdout = execSync(`bun run ${path.resolve('benchmark.ts')} --phase2-worker`, {
    cwd: process.cwd(),
    timeout: 300000,
    stdio: ['ignore', 'pipe', 'inherit'],
  }).toString().trim();

  const raw = JSON.parse(stdout) as Record<string, any>;
  const data = new Map<string, any>();
  for (const [k, v] of Object.entries(raw)) data.set(k, v);
  return data;
}

// ─── Markdown generator ─────────────────────────────────────────

function buildMarkdown(rows: Row[]): string {
  const valid = rows.filter(r => r.pw_nav > MIN_VALID_BYTES && r.br_snapI > MIN_VALID_BYTES);
  const L: string[] = [];
  const w = (s: string) => L.push(s);

  w('# Benchmarks: @ulpi/browse vs @playwright/mcp');
  w('');
  w(`Measured ${new Date().toISOString().slice(0, 10)}. Same machine, same Chromium, same pages.`);
  w('');

  // Explainer
  w('## What Gets Dumped Into the AI Context');
  w('');
  w('**@playwright/mcp**: Every `browser_navigate`, `browser_click`, or `browser_type` returns the **full accessibility snapshot** — automatically, whether you need it or not.');
  w('');
  w('**@ulpi/browse**: `goto` returns a one-liner (`"Navigated to ... (200)"`). The agent **chooses** what to request: `text`, `snapshot -i`, `links`, `forms`, etc.');
  w('');

  // Summary table
  w('## Per-Page Token Cost');
  w('');
  w('| Site | Page | @playwright/mcp navigate | browse snapshot -i | Ratio |');
  w('|------|------|-------------------------:|-------------------:|------:|');

  let totalPW = 0, totalBR = 0;
  for (const r of valid) {
    const pwT = tokOf(r.pw_nav), brT = tokOf(r.br_snapI);
    const ratio = brT > 0 ? Math.round(pwT / brT) : 0;
    totalPW += pwT; totalBR += brT;
    w(`| ${r.site} | ${r.page} | ${fmtT(pwT)} | ${fmtT(brT)} | **${ratio}x** |`);
  }
  const totalRatio = totalBR > 0 ? Math.round(totalPW / totalBR) : 0;
  w(`| **TOTAL** | **${valid.length} pages** | **${fmtT(totalPW)}** | **${fmtT(totalBR)}** | **${totalRatio}x** |`);
  w('');
  w('`browse goto` alone costs ~10-25 tokens per navigation (one-liner confirmation). The agent requests a snapshot only when it needs to see the page.');
  w('');

  // Session cost
  const avgPW = valid.length > 0 ? Math.round(totalPW / valid.length) : 0;
  const avgBR = valid.length > 0 ? Math.round(totalBR / valid.length) : 0;
  w('## 10-Step Agent Session');
  w('');
  w('A typical flow: navigate, snapshot, click, snapshot, fill, click, snapshot, check result.');
  w('');
  w('| | @playwright/mcp | @ulpi/browse |');
  w('|---|---:|---:|');
  w(`| Tokens per navigate/click/type | ${fmtT(avgPW)} (auto-dumped) | ~15 (one-liner) |`);
  w(`| 10 actions total | ${fmtT(avgPW * 10)} | ${fmtT(avgBR * 3 + 15 * 7)} (3 snapshots + 7 actions) |`);
  w(`| Context consumed (200K window) | ${Math.round(avgPW * 10 / 2000)}% | ${Math.round((avgBR * 3 + 15 * 7) / 2000)}% |`);
  w('');

  // Raw data
  w('## Raw Data');
  w('');
  let curSite = '';
  for (const r of valid) {
    if (r.site !== curSite) { curSite = r.site; w(`### ${r.site}`); w(''); }
    w(`#### ${r.page}`);
    w('');
    w('| Approach | Size | ~Tokens | Notes |');
    w('|----------|-----:|--------:|-------|');
    w(`| @playwright/mcp navigate | ${fmtB(r.pw_nav)} | ${fmtT(tokOf(r.pw_nav))} | Full snapshot auto-dumped |`);
    w(`| Playwright page.content() | ${fmtB(r.pw_html)} | ${fmtT(tokOf(r.pw_html))} | Raw HTML |`);
    w(`| browse goto | ${fmtB(r.br_goto)} | ${fmtT(tokOf(r.br_goto))} | One-liner |`);
    w(`| browse text | ${fmtB(r.br_text)} | ${fmtT(tokOf(r.br_text))} | Clean visible text |`);
    w(`| browse snapshot | ${fmtB(r.br_snap)} | ${fmtT(tokOf(r.br_snap))} | Full tree + @refs |`);
    w(`| **browse snapshot -i** | **${fmtB(r.br_snapI)}** | **${fmtT(tokOf(r.br_snapI))}** | **Interactive + @refs** |`);
    w(`| browse links | ${fmtB(r.br_links)} | ${fmtT(tokOf(r.br_links))} | Text → URL |`);
    w(`| browse forms | ${fmtB(r.br_forms)} | ${fmtT(tokOf(r.br_forms))} | Structured JSON |`);
    w('');
  }

  // Skipped pages
  const skipped = rows.filter(r => r.pw_nav <= MIN_VALID_BYTES || r.br_snapI <= MIN_VALID_BYTES);
  if (skipped.length > 0) {
    w('### Excluded (bot detection or empty response)');
    w('');
    for (const r of skipped) w(`- ${r.site} / ${r.page}`);
    w('');
  }

  // Architectural differences
  w('## Architectural Differences');
  w('');
  w('| | @playwright/mcp | @ulpi/browse |');
  w('|---|---|---|');
  w('| **Navigate response** | Full snapshot (~5-50K tokens) | One-liner (~15 tokens) |');
  w('| **Click/type response** | Full snapshot (~5-50K tokens) | One-liner (~15 tokens) |');
  w('| **Agent controls output** | No — always gets full dump | Yes — requests what it needs |');
  w('| **Interactive-only filter** | No | `snapshot -i` |');
  w('| **Cursor-interactive detection** | No | `snapshot -C` (cursor:pointer, onclick, tabindex) |');
  w('| **Clean text extraction** | No | `text` command |');
  w('| **Form discovery** | No | `forms` command |');
  w('| **Link extraction** | No | `links` command |');
  w('| **Network/console logs** | console_messages only | `network` + `console` |');
  w('| **Performance timing** | No | `perf` command |');
  w('| **Cookies/storage** | No | `cookies` + `storage` |');
  w('| **Snapshot diff** | No | `snapshot-diff` |');
  w('| **Page text diff** | No | `diff <url1> <url2>` |');
  w('| **Responsive screenshots** | No | `responsive` (3 viewports) |');
  w('| **Persistent daemon** | No — new browser per session | Yes — ~100ms per command |');
  w('| **Crash recovery** | No | Auto-restart with safe retry |');
  w('| **Total commands** | ~15 tools | 40+ commands |');
  w('');

  // Methodology
  w('## Methodology');
  w('');
  w('- Token estimates: ~4 chars per token (standard approximation)');
  w('- @playwright/mcp: simulated by calling `ariaSnapshot()` after navigation (identical to what the MCP server does internally)');
  w('- All pages loaded with `waitUntil: domcontentloaded` + 2.5s settle');
  w(`- Pages returning < ${MIN_VALID_BYTES} bytes excluded (bot detection)`);

  let pwVersion = 'unknown';
  try { pwVersion = require('playwright/package.json').version; } catch {}
  w(`- Measured ${new Date().toISOString().slice(0, 10)}, Playwright ${pwVersion}, Chromium headless`);
  w('- Rerun: `bun run benchmark.ts`');
  w('');

  return L.join('\n');
}

// ─── Main ───────────────────────────────────────────────────────

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  Benchmark: @ulpi/browse vs @playwright/mcp            ║');
console.log('╚══════════════════════════════════════════════════════════╝');
console.log(`  Sites: ${[...new Set(PAGES.map(p => p.site))].join(', ')}`);
console.log(`  Pages: ${PAGES.length} total`);

const pwData = await phase1();
const brData = phase2();

const rows: Row[] = PAGES.map(pc => {
  const key = `${pc.site}|${pc.page}`;
  const pw = pwData.get(key) || { nav: 0, html: 0 };
  const br = brData.get(key) || { goto: 0, text: 0, snap: 0, snapI: 0, links: 0, forms: 0 };
  return {
    site: pc.site, page: pc.page,
    pw_nav: pw.nav, pw_html: pw.html,
    br_goto: br.goto, br_text: br.text, br_snap: br.snap, br_snapI: br.snapI,
    br_links: br.links, br_forms: br.forms,
  };
});

fs.writeFileSync('BENCHMARKS.md', buildMarkdown(rows));

// Print summary
const valid = rows.filter(r => r.pw_nav > MIN_VALID_BYTES && r.br_snapI > MIN_VALID_BYTES);
console.log(`\n  Written to BENCHMARKS.md (${valid.length} valid pages)\n`);
console.log(`  ${'Site'.padEnd(18)} ${'Page'.padEnd(10)} ${'@playwright/mcp'.padStart(16)} ${'browse -i'.padStart(12)} ${'Ratio'.padStart(6)}`);
console.log('  ' + '─'.repeat(64));
for (const r of valid) {
  const pwT = tokOf(r.pw_nav), brT = tokOf(r.br_snapI);
  const ratio = brT > 0 ? Math.round(pwT / brT) : 0;
  console.log(`  ${r.site.padEnd(18)} ${r.page.padEnd(10)} ${fmtT(pwT).padStart(16)} ${fmtT(brT).padStart(12)} ${(ratio + 'x').padStart(6)}`);
}
console.log();
