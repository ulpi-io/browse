/**
 * Meta command dispatcher — routes commands to focused handler modules.
 */

import type { BrowserTarget } from '../../browser/target';
import type { SessionManager, Session } from '../../session/manager';

import { handleTabsCommand } from './tabs';
import { handleScreenshotsCommand } from './screenshots';
import { handleRecordingCommand } from './recording';
import { handleSessionsCommand } from './sessions';
import { handleInspectionCommand } from './inspection';
import { handleAuthCommand } from './auth';
import { handleSystemCommand } from './system';
import { handleProfileCommand } from './profile';
import { handleFlowsCommand } from './flows';

// ─── Command routing sets ──────────────────────────────────────────────────

const TABS_COMMANDS = new Set(['tabs', 'tab', 'newtab', 'closetab']);

const SCREENSHOTS_COMMANDS = new Set(['screenshot', 'pdf', 'responsive', 'screenshot-diff']);

const RECORDING_COMMANDS = new Set(['record', 'har', 'video']);

const SESSIONS_COMMANDS = new Set(['sessions', 'session-close', 'state', 'handoff', 'resume']);

const INSPECTION_COMMANDS = new Set([
  'snapshot', 'snapshot-diff', 'diff', 'frame', 'find', 'inspect', 'detect', 'coverage', 'perf-audit', 'api', 'expect', 'visual', 'a11y-audit',
]);

const AUTH_COMMANDS = new Set(['auth', 'cookie-import']);

const SYSTEM_COMMANDS = new Set(['status', 'url', 'stop', 'restart', 'chain', 'doctor', 'upgrade']);

const PROFILE_COMMANDS = new Set(['profile', 'react-devtools', 'provider']);

const WORKFLOW_COMMANDS = new Set(['flow', 'retry', 'watch']);

export async function handleMetaCommand(
  command: string,
  args: string[],
  bm: BrowserTarget,
  shutdown: () => Promise<void> | void,
  sessionManager?: SessionManager,
  currentSession?: Session
): Promise<string> {

  if (TABS_COMMANDS.has(command)) {
    return handleTabsCommand(command, args, bm);
  }

  if (SCREENSHOTS_COMMANDS.has(command)) {
    return handleScreenshotsCommand(command, args, bm, currentSession);
  }

  if (RECORDING_COMMANDS.has(command)) {
    return handleRecordingCommand(command, args, bm, currentSession);
  }

  if (SESSIONS_COMMANDS.has(command)) {
    return handleSessionsCommand(command, args, bm, sessionManager, currentSession);
  }

  if (INSPECTION_COMMANDS.has(command)) {
    return handleInspectionCommand(command, args, bm, currentSession);
  }

  if (AUTH_COMMANDS.has(command)) {
    return handleAuthCommand(command, args, bm);
  }

  if (SYSTEM_COMMANDS.has(command)) {
    return handleSystemCommand(command, args, bm, shutdown, sessionManager, currentSession);
  }

  if (PROFILE_COMMANDS.has(command)) {
    return handleProfileCommand(command, args, bm);
  }

  if (WORKFLOW_COMMANDS.has(command)) {
    return handleFlowsCommand(command, args, bm, shutdown, sessionManager, currentSession);
  }

  throw new Error(`Unknown meta command: ${command}`);
}

// ─── Definition Registration ──────────────────────────────────────

import type { CommandRegistry, CommandContext } from '../../automation/command';

/**
 * Register all meta command definitions in the registry.
 * Called once during lazy initialization from ensureDefinitionsRegistered().
 */
export function registerMetaDefinitions(registry: CommandRegistry): void {
  for (const spec of registry.byCategory('meta')) {
    registry.define({
      spec,
      mcpArgDecode: spec.mcp?.argDecode,
      execute: async (ctx: CommandContext) => {
        const bt = ctx.target as BrowserTarget;
        return handleMetaCommand(spec.name, ctx.args, bt, ctx.shutdown || (() => {}), ctx.sessionManager, ctx.session);
      },
    });
  }
}
