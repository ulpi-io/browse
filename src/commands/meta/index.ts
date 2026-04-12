/**
 * Meta command dispatcher — routes commands to focused handler modules.
 */

import type { BrowserTarget } from '../../browser/target';
import type { AutomationTarget } from '../../automation/target';
import type { CommandLifecycle } from '../../automation/events';
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
import { handleSimCommand } from './sim';

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

const SIM_COMMANDS = new Set(['sim']);

const YOUTUBE_COMMANDS = new Set(['youtube-transcript']);

export async function handleMetaCommand(
  command: string,
  args: string[],
  target: AutomationTarget,
  shutdown: () => Promise<void> | void,
  sessionManager?: SessionManager,
  currentSession?: Session,
  lifecycle?: CommandLifecycle,
): Promise<string> {
  // Browser-only handlers receive a cast; flows/system get `as any` (TASK-005/006 will widen)
  // Browser-specific handlers — only safe when target is a browser
  const bm = () => target as BrowserTarget;

  if (TABS_COMMANDS.has(command)) {
    return handleTabsCommand(command, args, bm());
  }

  if (SCREENSHOTS_COMMANDS.has(command)) {
    return handleScreenshotsCommand(command, args, bm(), currentSession);
  }

  if (RECORDING_COMMANDS.has(command)) {
    return handleRecordingCommand(command, args, target, currentSession);
  }

  if (SESSIONS_COMMANDS.has(command)) {
    return handleSessionsCommand(command, args, bm(), sessionManager, currentSession);
  }

  if (INSPECTION_COMMANDS.has(command)) {
    return handleInspectionCommand(command, args, bm(), currentSession);
  }

  if (AUTH_COMMANDS.has(command)) {
    return handleAuthCommand(command, args, bm());
  }

  // Target-neutral handlers — work with any AutomationTarget
  if (SYSTEM_COMMANDS.has(command)) {
    return handleSystemCommand(command, args, target, shutdown, sessionManager, currentSession, lifecycle);
  }

  if (PROFILE_COMMANDS.has(command)) {
    return handleProfileCommand(command, args, bm());
  }

  if (WORKFLOW_COMMANDS.has(command)) {
    return handleFlowsCommand(command, args, target, shutdown, sessionManager, currentSession, lifecycle);
  }

  if (SIM_COMMANDS.has(command)) {
    return handleSimCommand(command, args, bm(), shutdown, sessionManager, currentSession);
  }

  if (YOUTUBE_COMMANDS.has(command)) {
    const { handleYoutubeTranscript } = await import('./youtube');
    return handleYoutubeTranscript(args, bm());
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
  const appMetaCommands = new Set([
    'snapshot', 'screenshot', 'status',
    'flow', 'chain', 'doctor', 'sessions', 'session-close', 'record',
  ]);

  for (const spec of registry.byCategory('meta')) {
    registry.define({
      spec,
      mcpArgDecode: spec.mcp?.argDecode,
      execute: async (ctx: CommandContext) => {
        // App target dispatch for supported meta commands
        if (ctx.target.targetType === 'app') {
          if (!appMetaCommands.has(spec.name)) {
            throw new Error(`Command '${spec.name}' not available for app targets. Use 'snapshot', 'text', 'tap', 'fill', 'type', 'press', or 'screenshot'.`);
          }
          // App-specific command overrides — use duck typing since multiple app manager classes exist
          const t = ctx.target as any;
          switch (spec.name) {
            case 'snapshot':
              if (typeof t.snapshot === 'function') return t.snapshot(ctx.args.includes('-i'));
              break;
            case 'screenshot':
              if (typeof t.screenshot === 'function') return t.screenshot(ctx.args[0] || '.browse/screenshot.png');
              break;
            case 'status':
              if (typeof t.getState === 'function') {
                const state = await t.getState();
                return `App: ${state.appName}\nWindow: ${state.windowTitle}\nElements: ${state.elementCount}\nWindows: ${state.windowCount}`;
              }
              break;
            // flow, chain, record, doctor, sessions, session-close: fall through to handleMetaCommand
          }
        }
        return handleMetaCommand(spec.name, ctx.args, ctx.target, ctx.shutdown || (() => {}), ctx.sessionManager, ctx.session, ctx.lifecycle);
      },
    });
  }
}
