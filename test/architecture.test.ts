/**
 * Architecture regression tests — enforce structural invariants.
 *
 * These tests protect the domain architecture refactor by failing when:
 *   - Command registry drifts from server/MCP/CLI surfaces
 *   - Generic command handlers reintroduce direct BrowserManager imports
 *   - Compatibility shims accumulate new business logic
 *   - AutomationTarget contract is violated
 */

import { describe, test, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', 'src');

/** Read a source file and return its content */
function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(SRC, relPath), 'utf-8');
}

/** Check if a file exists in src/ */
function srcExists(relPath: string): boolean {
  return fs.existsSync(path.join(SRC, relPath));
}

// ─── Registry Parity ─────────────────────────────────────────────

describe('Registry parity', () => {
  test('server.ts does not maintain independent command sets', () => {
    const server = readSrc('server.ts');
    // Should NOT have inline Set definitions for commands
    const inlineSets = server.match(/^const (READ|WRITE|META)_COMMANDS = new Set\(/m);
    expect(inlineSets).toBeNull();
  });

  test('server.ts imports command sets from registry', () => {
    const server = readSrc('server.ts');
    expect(server).toContain("from './automation/registry'");
  });

  test('mcp.ts routes through executeCommand', () => {
    const mcp = readSrc('mcp/server.ts');
    expect(mcp).toContain('executeCommand(');
  });

  test('registry exports derived sets for backward compatibility', () => {
    // Verify the registry module exports the expected sets by checking source
    const registrySrc = readSrc('automation/registry.ts');
    expect(registrySrc).toContain('export const READ_COMMANDS');
    expect(registrySrc).toContain('export const WRITE_COMMANDS');
    expect(registrySrc).toContain('export const META_COMMANDS');
    expect(registrySrc).toContain('export const SAFE_TO_RETRY');
    expect(registrySrc).toContain('export const RECORDING_SKIP');
    expect(registrySrc).toContain('export const PAGE_CONTENT_COMMANDS');
    // Sets are derived from registry, not hand-maintained
    expect(registrySrc).toContain('registry.categorySet');
    expect(registrySrc).toContain('registry.all().filter');
  });
});

// ─── AutomationTarget Contract ───────────────────────────────────

describe('AutomationTarget contract', () => {
  test('automation contracts have no forbidden runtime imports', () => {
    const targetContent = readSrc('automation/target.ts');
    const eventsContent = readSrc('automation/events.ts');
    const commandContent = readSrc('automation/command.ts');

    // Check actual import statements, not comments
    for (const content of [targetContent, eventsContent, commandContent]) {
      const importLines = content.split('\n').filter(line =>
        line.match(/^import\s/) && !line.startsWith('//')
      );
      for (const line of importLines) {
        expect(line).not.toContain('browser-manager');
        expect(line).not.toContain('session-manager');
        // Page/Locator from playwright are allowed as comments but not as imports
        if (line.includes('playwright')) {
          expect(line).toContain('type'); // Only type imports allowed
        }
      }
    }
  });

  test('BrowserManager implements AutomationTarget', () => {
    const manager = readSrc('browser/manager.ts');
    expect(manager).toContain('implements BrowserTarget');
    expect(manager).toContain("targetType = 'browser'");
    expect(manager).toContain('getCapabilities()');
    expect(manager).toContain('getCurrentLocation()');
    expect(manager).toContain('isReady()');
  });

  test('Session.manager is typed as AutomationTarget, not BrowserManager', () => {
    const sessionManager = readSrc('session/manager.ts');
    // The Session interface should use AutomationTarget
    const sessionInterface = sessionManager.match(/export interface Session \{[\s\S]*?\}/)?.[0] || '';
    expect(sessionInterface).toContain('manager: AutomationTarget');
    expect(sessionInterface).not.toContain('manager: BrowserManager');
  });
});

// ─── Handler Retargeting ─────────────────────────────────────────

describe('Handler retargeting', () => {
  test('command handlers use BrowserTarget interface, not BrowserManager class', () => {
    const read = readSrc('commands/read.ts');
    const write = readSrc('commands/write.ts');
    const metaIndex = readSrc('commands/meta/index.ts');

    // Handlers import BrowserTarget, not BrowserManager
    for (const [name, content] of [['read', read], ['write', write], ['meta/index', metaIndex]]) {
      expect(content).toContain('browser/target');
      expect(content).not.toContain("import.*BrowserManager");
      expect(content, `${name} still has asBrowser()`).not.toContain('asBrowser');
    }
  });

  test('meta sub-handlers use BrowserTarget, not BrowserManager', () => {
    const subHandlers = [
      'commands/meta/tabs.ts', 'commands/meta/auth.ts', 'commands/meta/screenshots.ts',
      'commands/meta/recording.ts', 'commands/meta/sessions.ts', 'commands/meta/inspection.ts',
      'commands/meta/system.ts', 'commands/meta/profile.ts',
    ];
    for (const file of subHandlers) {
      const content = readSrc(file);
      expect(content, `${file} imports BrowserManager`).not.toContain("import.*BrowserManager");
      expect(content, `${file} has BrowserTarget`).toContain('BrowserTarget');
    }
  });

  test('no instanceof BrowserManager or asBrowser in command handlers', () => {
    const read = readSrc('commands/read.ts');
    const write = readSrc('commands/write.ts');
    const metaIndex = readSrc('commands/meta/index.ts');

    for (const content of [read, write, metaIndex]) {
      expect(content).not.toContain('instanceof BrowserManager');
      expect(content).not.toContain('asBrowser');
    }
  });
});

// ─── Domain Structure ────────────────────────────────────────────

describe('Domain structure', () => {
  test('automation domain exists with required files', () => {
    expect(srcExists('automation/target.ts')).toBe(true);
    expect(srcExists('automation/events.ts')).toBe(true);
    expect(srcExists('automation/command.ts')).toBe(true);
    expect(srcExists('automation/executor.ts')).toBe(true);
    expect(srcExists('automation/index.ts')).toBe(true);
  });

  test('browser domain exists', () => {
    expect(srcExists('browser/manager.ts')).toBe(true);
    expect(srcExists('browser/index.ts')).toBe(true);
    expect(srcExists('browser/snapshot.ts')).toBe(true);
  });

  test('network domain exists', () => {
    expect(srcExists('network/buffers.ts')).toBe(true);
    expect(srcExists('network/har.ts')).toBe(true);
    expect(srcExists('network/index.ts')).toBe(true);
  });

  test('session domain exists', () => {
    expect(srcExists('session/manager.ts')).toBe(true);
    expect(srcExists('session/persist.ts')).toBe(true);
    expect(srcExists('session/encryption.ts')).toBe(true);
    expect(srcExists('session/index.ts')).toBe(true);
  });

  test('security domain exists', () => {
    expect(srcExists('security/domain-filter.ts')).toBe(true);
    expect(srcExists('security/policy.ts')).toBe(true);
    expect(srcExists('security/auth-vault.ts')).toBe(true);
    expect(srcExists('security/sanitize.ts')).toBe(true);
    expect(srcExists('security/index.ts')).toBe(true);
  });

  test('engine domain exists', () => {
    expect(srcExists('engine/resolver.ts')).toBe(true);
    expect(srcExists('engine/index.ts')).toBe(true);
  });

  test('export domain exists', () => {
    expect(srcExists('export/record.ts')).toBe(true);
    expect(srcExists('export/index.ts')).toBe(true);
  });
});

// ─── Shim Purity ─────────────────────────────────────────────────

describe('Shim purity', () => {
  const SHIM_FILES = [
    'buffers.ts',
    'har.ts',
    'domain-filter.ts',
    'policy.ts',
    'sanitize.ts',
    'auth-vault.ts',
    'snapshot.ts',
  ];

  for (const shimFile of SHIM_FILES) {
    test(`${shimFile} is export-only shim (no business logic)`, () => {
      if (!srcExists(shimFile)) return; // Skip if already deleted
      const content = readSrc(shimFile);
      // Strip comments and blank lines
      const meaningful = content
        .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
        .replace(/\/\/.*/g, '')           // line comments
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0);
      // Join all lines into one string and check for non-export statements.
      // A shim should only contain export/re-export declarations.
      const joined = meaningful.join(' ');
      // Remove all export { ... } from '...' statements
      const withoutExports = joined
        .replace(/export\s*\{[^}]*\}\s*from\s*'[^']*'\s*;?/g, '')
        .replace(/export\s+type\s*\{[^}]*\}\s*from\s*'[^']*'\s*;?/g, '')
        .trim();
      expect(
        withoutExports.length,
        `Shim ${shimFile} contains non-export logic: "${withoutExports.slice(0, 100)}"`
      ).toBe(0);
    });
  }
});

// ─── Executor Pipeline ───────────────────────────────────────────

describe('Executor pipeline', () => {
  test('automation index exports executeCommand', () => {
    const index = readSrc('automation/index.ts');
    expect(index).toContain('executeCommand');
  });

  test('executor uses registry for command lookup', () => {
    const executor = readSrc('automation/executor.ts');
    expect(executor).toContain("registry.get(command)");
  });

  test('server.ts uses definition-backed execution (no category dispatch)', () => {
    const server = readSrc('server.ts');
    expect(server).toContain('executeCommand(');
    // No transport-owned category dispatch
    expect(server).not.toContain('handleReadCommand');
    expect(server).not.toContain('handleWriteCommand');
    expect(server).not.toContain('handleMetaCommand');
    expect(server).not.toContain('cmdSpec.category');
  });

  test('mcp/server.ts uses definition-backed execution (no category dispatch)', () => {
    const mcp = readSrc('mcp/server.ts');
    expect(mcp).toContain('executeCommand(');
    expect(mcp).not.toContain('handleReadCommand');
    expect(mcp).not.toContain('handleWriteCommand');
    expect(mcp).not.toContain('handleMetaCommand');
    expect(mcp).not.toContain('cmdSpec.category');
  });

  test('mcp/tools/index.ts has no hard-coded command switch', () => {
    const tools = readSrc('mcp/tools/index.ts');
    expect(tools).not.toContain('switch (rawCommand)');
    expect(tools).not.toMatch(/case 'text'/);
    expect(tools).not.toMatch(/case 'goto'/);
  });
});

// ─── Session Factory ─────────────────────────────────────────────

describe('Session factory', () => {
  test('SessionManager uses factory, not direct BrowserManager construction', () => {
    const sm = readSrc('session/manager.ts');
    expect(sm).not.toContain('new BrowserManager');
    expect(sm).not.toContain('browserManagers');
    expect(sm).toContain('SessionTargetFactory');
  });
});

// ─── Shim Deletion ───────────────────────────────────────────────

describe('Shim deletion', () => {
  const DELETED_FILES = [
    'buffers.ts', 'har.ts', 'session-manager.ts', 'session-persist.ts',
    'encryption.ts', 'domain-filter.ts', 'policy.ts', 'auth-vault.ts',
    'sanitize.ts', 'runtime.ts', 'chrome-discover.ts', 'cloud-providers.ts',
    'record-export.ts', 'snapshot.ts', 'react-devtools.ts', 'mcp-tools.ts',
    'browser-manager.ts', 'command-registry.ts', 'action-context.ts',
    'mcp.ts', 'cookie-import.ts', 'png-compare.ts',
  ];

  test('all migrated root-level files have been deleted', () => {
    for (const f of DELETED_FILES) {
      expect(srcExists(f), `${f} still exists at root`).toBe(false);
    }
  });
});
