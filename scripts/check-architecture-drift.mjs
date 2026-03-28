#!/usr/bin/env node
/**
 * Architecture anti-drift guard — fails on specific violations.
 *
 * Usage:
 *   node scripts/check-architecture-drift.mjs --scope code
 *   node scripts/check-architecture-drift.mjs --scope roadmap
 *   node scripts/check-architecture-drift.mjs --scope docs
 *   node scripts/check-architecture-drift.mjs              (all scopes)
 *
 * Exit code: 0 = clean, 1 = violations found
 */

import { execSync } from 'child_process';
import * as fs from 'fs';

const scope = process.argv.includes('--scope')
  ? process.argv[process.argv.indexOf('--scope') + 1]
  : 'all';

const violations = [];

function check(description, command) {
  try {
    const result = execSync(command, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (result) {
      violations.push(`${description}:\n  ${result.split('\n').join('\n  ')}`);
    }
  } catch {
    // grep exit 1 = no matches = good
  }
}

// ─── Code scope ──────────────────────────────────────────────────

if (scope === 'code' || scope === 'all') {
  // server.ts must not import BrowserManager as a type
  check(
    'server.ts imports BrowserManager (type leak)',
    `grep -n "import.*BrowserManager" src/server.ts | grep -v "dynamic import" || true`,
  );

  // server.ts must not have transport-owned category dispatch
  check(
    'server.ts has transport-owned category dispatch',
    `grep -n "handleReadCommand\\|handleWriteCommand\\|handleMetaCommand\\|cmdSpec\\.category" src/server.ts || true`,
  );

  // cli.ts must not have hardcoded full help block
  check(
    'cli.ts has hardcoded help block',
    `grep -n "Navigation:.*goto.*url\\|Content:.*text.*html.*links" src/cli.ts || true`,
  );

  // mcp/index.ts must export startMcpServer
  try {
    const mcpIndex = fs.readFileSync('src/mcp/index.ts', 'utf-8');
    if (!mcpIndex.includes('startMcpServer')) {
      violations.push('src/mcp/index.ts does not export startMcpServer');
    }
  } catch {
    violations.push('src/mcp/index.ts does not exist');
  }

  // mcp/tools/index.ts must not have hard-coded command switch
  check(
    'mcp/tools/index.ts has hard-coded command switch',
    `grep -n "switch (rawCommand)\\|case 'text'\\|case 'goto'\\|case 'snapshot'" src/mcp/tools/index.ts || true`,
  );
}

// ─── Roadmap scope ───────────────────────────────────────────────

if (scope === 'roadmap' || scope === 'all') {
  const DELETED_PATHS = [
    'src/browser-manager',
    'src/command-registry',
    'src/mcp-tools',
    'src/commands/meta\\.ts',
    'src/session-manager',
    'src/record-export',
  ];
  const pattern = DELETED_PATHS.join('\\|');
  check(
    'Roadmap references deleted files',
    `grep -n "${pattern}" plans/roadmap-v1.5-v2.2.md plans/roadmap-v1.5-v2.2.json 2>/dev/null || true`,
  );
}

// ─── Docs scope ──────────────────────────────────────────────────

if (scope === 'docs' || scope === 'all') {
  const DELETED_PATHS = [
    'src/command-registry',
    'src/mcp-tools',
    'src/browser-manager',
    'src/record-export',
    'src/commands/meta\\.ts',
    'src/session-manager',
  ];
  const pattern = DELETED_PATHS.join('\\|');
  check(
    'Docs reference deleted files',
    `grep -rn "${pattern}" CLAUDE.md 2>/dev/null || true`,
  );
}

// ─── Report ──────────────────────────────────────────────────────

if (violations.length > 0) {
  console.error(`Architecture drift violations (scope: ${scope}):\n`);
  for (const v of violations) {
    console.error(`  ${v}\n`);
  }
  console.error(`${violations.length} violation(s) found.`);
  process.exit(1);
} else {
  console.log(`Architecture drift check passed (scope: ${scope}).`);
  process.exit(0);
}
