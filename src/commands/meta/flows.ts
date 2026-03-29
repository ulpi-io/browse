/**
 * Agent workflow commands — flow, retry, watch
 *
 * TASK-036: flow   — Execute a YAML flow file step-by-step
 * TASK-037: retry  — Retry a command with backoff until a condition is met
 * TASK-038: watch  — Watch for DOM changes and execute a callback command
 * TASK-041: flow save/run/list — Saved flows in .browse/flows/
 * TASK-005: Routes flow sub-steps through executeCommand() pipeline
 */

import type { AutomationTarget } from '../../automation/target';
import type { CommandLifecycle } from '../../automation/events';
import type { Session } from '../../session/manager';
import type { SessionManager } from '../../session/manager';
import type { BrowserTarget } from '../../browser/target';
import * as fs from 'fs';
import * as path from 'path';

// ─── Saved Flows Directory ────────────────────────────────────────

/**
 * Returns the flows directory path, creating it if needed.
 *
 * Resolution order:
 *   1. browse.json `flowPaths` (resolved relative to project root)
 *   2. BROWSE_LOCAL_DIR/flows (set by server to <project>/.browse/)
 *   3. <project-root>/.browse/flows (discovered via findProjectRoot)
 *   4. cwd/.browse/flows (absolute last resort — never /tmp)
 */
function getFlowsDir(): string {
  // 1. Config flowPaths (resolved relative to project root)
  try {
    const { loadConfig, findProjectRoot } = require('../../config') as typeof import('../../config');
    const config = loadConfig();
    const root = findProjectRoot();

    if (config.flowPaths?.length && root) {
      for (const fp of config.flowPaths) {
        const abs = path.isAbsolute(fp) ? fp : path.join(root, fp);
        try { fs.mkdirSync(abs, { recursive: true }); return abs; } catch { /* try next */ }
      }
    }
  } catch { /* config not available — fall through */ }

  // 2. BROWSE_LOCAL_DIR/flows (set by CLI to <project>/.browse/)
  const localDir = process.env.BROWSE_LOCAL_DIR;
  if (localDir) {
    const dir = path.join(localDir, 'flows');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // 3. .browse/flows from project root
  try {
    const { findProjectRoot } = require('../../config') as typeof import('../../config');
    const root = findProjectRoot();
    if (root) {
      const dir = path.join(root, '.browse', 'flows');
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    }
  } catch { /* fall through */ }

  // 4. Absolute last resort: cwd/.browse/flows (never /tmp)
  const dir = path.join(process.cwd(), '.browse', 'flows');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Validate a flow name — reject names with path traversal characters.
 * Names may only contain alphanumeric chars, hyphens, underscores, and dots
 * (but not ".." and must not contain "/" or path separators).
 */
function validateFlowName(name: string): void {
  if (!name || name.trim() === '') {
    throw new Error('Flow name cannot be empty');
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new Error(`Invalid flow name "${name}": path separators are not allowed`);
  }
  if (name === '..' || name.includes('..')) {
    throw new Error(`Invalid flow name "${name}": ".." is not allowed`);
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new Error(`Invalid flow name "${name}": only alphanumeric characters, hyphens, underscores, and dots are allowed`);
  }
}

// ─── Flow Depth Tracking (per-session, for nested flow detection) ──

const MAX_FLOW_DEPTH = 10;

/** Per-session flow nesting depth tracker. WeakMap so sessions are GC'd normally. */
const flowDepthMap = new WeakMap<object, number>();

function getFlowDepth(session: Session | undefined): number {
  if (!session) return 0;
  return flowDepthMap.get(session) ?? 0;
}

async function withFlowDepth<T>(session: Session | undefined, fn: () => Promise<T>): Promise<T> {
  if (!session) return fn();
  const current = flowDepthMap.get(session) ?? 0;
  flowDepthMap.set(session, current + 1);
  return fn().finally(() => {
    const now = flowDepthMap.get(session) ?? 1;
    if (now <= 1) flowDepthMap.delete(session);
    else flowDepthMap.set(session, now - 1);
  });
}

// ─── Shared Flow Step Executor ──────────────────────────────────

/**
 * Execute a sequence of flow steps through the executeCommand() pipeline.
 * Shared by `flow <file>` and `flow run <name>`.
 *
 * Each sub-step goes through the full executor with lifecycle hooks,
 * enabling recording, context enrichment, and error shaping.
 */
async function executeFlowSteps(
  steps: Array<{ command: string; args: string[] }>,
  target: AutomationTarget,
  shutdown: () => Promise<void> | void,
  sessionManager: SessionManager | undefined,
  currentSession: Session | undefined,
  lifecycle: CommandLifecycle | undefined,
): Promise<string> {
  const depth = getFlowDepth(currentSession);
  if (depth > MAX_FLOW_DEPTH) {
    throw new Error(`flow nesting depth exceeded (max ${MAX_FLOW_DEPTH})`);
  }

  const { executeCommand } = await import('../../automation/executor');
  const { SessionBuffers } = await import('../../network/buffers');

  return withFlowDepth(currentSession, async () => {
    const results: string[] = [];
    let passed = 0;
    const total = steps.length;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepLabel = `${i + 1}/${total}`;
      const cmdDisplay = step.args.length > 0
        ? `${step.command} ${step.args.join(' ')}`
        : step.command;

      try {
        await executeCommand(step.command, step.args, {
          context: {
            args: step.args,
            target,
            buffers: currentSession?.buffers ?? new SessionBuffers(),
            domainFilter: currentSession?.domainFilter,
            session: currentSession,
            shutdown,
            sessionManager,
            lifecycle,
          },
          lifecycle,
        });
        passed++;
        results.push(`\u2713 [${stepLabel}] ${cmdDisplay}`);
      } catch (err: any) {
        results.push(`\u2717 [${stepLabel}] ${cmdDisplay} \u2014 FAIL: ${err.message}`);
        results.push('');
        results.push(`Flow failed at step ${i + 1}/${total}`);
        return results.join('\n');
      }
    }

    results.push('');
    results.push(`Flow complete: ${passed}/${total} steps passed`);
    return results.join('\n');
  });
}

// ─── Browser Target Guard ───────────────────────────────────────

/** Assert target is a BrowserTarget and return it typed. Throws on non-browser targets. */
function requireBrowserTarget(target: AutomationTarget, commandName: string): BrowserTarget {
  if (!('getPage' in target)) {
    throw new Error(`${commandName} requires a browser target`);
  }
  return target as BrowserTarget;
}

// ─── Main Handler ───────────────────────────────────────────────

export async function handleFlowsCommand(
  command: string,
  args: string[],
  target: AutomationTarget,
  shutdown: () => Promise<void> | void,
  sessionManager?: SessionManager,
  currentSession?: Session,
  lifecycle?: CommandLifecycle,
): Promise<string> {
  switch (command) {

    // ─── TASK-036 + TASK-041: flow ────────────────────────────────
    case 'flow': {
      const subOrFile = args[0];
      if (!subOrFile) {
        throw new Error(
          'Usage:\n' +
          '  browse flow <file.yaml>          \u2014 execute a flow file\n' +
          '  browse flow save <name>          \u2014 save current recording as a named flow\n' +
          '  browse flow run <name>           \u2014 execute a saved flow by name\n' +
          '  browse flow list                 \u2014 list saved flows'
        );
      }

      // ── TASK-041: flow save <name> ─────────────────────────────
      if (subOrFile === 'save') {
        const name = args[1];
        if (!name) throw new Error('Usage: browse flow save <name>');
        validateFlowName(name);

        if (!currentSession) throw new Error('flow save requires a session context');

        // Use active recording or last stopped recording
        const steps = currentSession.recording || currentSession.lastRecording;
        if (!steps || steps.length === 0) {
          throw new Error(
            'No recording to save. Run "browse record start", execute commands, then "browse flow save <name>".'
          );
        }

        // Serialize steps to YAML using shared export function
        const { exportFlowYaml } = await import('../../export/record');
        const yamlContent = exportFlowYaml(steps);
        const flowPath = path.join(getFlowsDir(), `${name}.yaml`);
        fs.writeFileSync(flowPath, yamlContent, 'utf-8');

        return `Flow saved: ${flowPath} (${steps.length} steps)`;
      }

      // ── TASK-041: flow run <name> ──────────────────────────────
      if (subOrFile === 'run') {
        const name = args[1];
        if (!name) throw new Error('Usage: browse flow run <name>');
        validateFlowName(name);

        const flowPath = path.join(getFlowsDir(), `${name}.yaml`);
        let content: string;
        try {
          content = fs.readFileSync(flowPath, 'utf-8');
        } catch (err: any) {
          if (err.code === 'ENOENT') {
            throw new Error(`Saved flow not found: "${name}" (looked at ${flowPath})`);
          }
          throw new Error(`Cannot read flow "${name}": ${err.message}`);
        }

        const { parseFlowYaml } = await import('../../flow-parser');
        const steps = parseFlowYaml(content);
        return executeFlowSteps(steps, target, shutdown, sessionManager, currentSession, lifecycle);
      }

      // ── TASK-041: flow list ────────────────────────────────────
      if (subOrFile === 'list') {
        const flowsDir = getFlowsDir();
        if (!fs.existsSync(flowsDir)) {
          return 'No saved flows (directory does not exist yet)';
        }

        const entries = fs.readdirSync(flowsDir)
          .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
          .sort();

        if (entries.length === 0) {
          return 'No saved flows';
        }

        const lines: string[] = [`Saved flows (${flowsDir}):`];
        for (const entry of entries) {
          const name = entry.replace(/\.(yaml|yml)$/, '');
          const fullPath = path.join(flowsDir, entry);
          const stat = fs.statSync(fullPath);
          const mtime = new Date(stat.mtimeMs).toISOString().replace('T', ' ').slice(0, 19);
          lines.push(`  ${name}  (${mtime})`);
        }
        return lines.join('\n');
      }

      // ── Original TASK-036 path: treat args[0] as a file path ──
      const filePath = subOrFile;

      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          throw new Error(`Flow file not found: ${filePath}`);
        }
        throw new Error(`Cannot read flow file: ${err.message}`);
      }

      const { parseFlowYaml } = await import('../../flow-parser');
      const steps = parseFlowYaml(content);
      return executeFlowSteps(steps, target, shutdown, sessionManager, currentSession, lifecycle);
    }

    // ─── TASK-037: retry ─────────────────────────────────────────
    case 'retry': {
      const bm = requireBrowserTarget(target, 'retry');

      // Parse: retry "command args..." --until "condition" --max N --backoff
      const { command: retryCmd, cmdArgs: retryCmdArgs, until, maxAttempts, backoff } = parseRetryArgs(args);

      const { executeCommand } = await import('../../automation/executor');
      const { SessionBuffers } = await import('../../network/buffers');
      const { parseExpectArgs, checkConditions } = await import('../../expect');

      // Parse the until condition as expect args
      const { conditions } = parseExpectArgs(until);
      const page = bm.getPage();
      const buffers = currentSession?.buffers;

      let lastError: string | null = null;
      let delay = 100; // Initial backoff delay in ms

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          // Execute the command through the shared pipeline
          await executeCommand(retryCmd, retryCmdArgs, {
            context: {
              args: retryCmdArgs,
              target,
              buffers: currentSession?.buffers ?? new SessionBuffers(),
              domainFilter: currentSession?.domainFilter,
              session: currentSession,
              shutdown,
              sessionManager,
              lifecycle,
            },
            lifecycle,
          });
        } catch (err: any) {
          lastError = err.message;
          // Command failed — check if we should retry
          if (attempt < maxAttempts) {
            if (backoff) {
              await new Promise(resolve => setTimeout(resolve, delay));
              delay *= 2;
            }
            continue;
          }
          throw new Error(`Retry exhausted after ${maxAttempts} attempts. Last error: ${lastError}`);
        }

        // Command succeeded — check the until condition
        const results = await checkConditions(conditions, page, bm, buffers);
        const allPassed = results.every(r => r.passed);

        if (allPassed) {
          return `OK after ${attempt} attempt${attempt > 1 ? 's' : ''}`;
        }

        if (attempt >= maxAttempts) {
          const failures = results.filter(r => !r.passed);
          throw new Error(
            `Retry exhausted after ${maxAttempts} attempts. Condition not met:\n` +
            failures.map(r => `  ${r.description} (actual: ${r.actual})`).join('\n')
          );
        }

        if (backoff) {
          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= 2;
        }
      }

      // Should not reach here
      throw new Error(`Retry exhausted after ${maxAttempts} attempts`);
    }

    // ─── TASK-038: watch ─────────────────────────────────────────
    case 'watch': {
      const bm = requireBrowserTarget(target, 'watch');

      const { selector, onChange, timeout } = parseWatchArgs(args);

      const page = bm.getPage();

      // Inject MutationObserver via page.evaluate to watch for changes
      const watchId = `__browse_watch_${Date.now()}`;
      await page.evaluate(({ selector: sel, watchId: wid }: { selector: string; watchId: string }) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error(`Element not found: ${sel}`);

        // Set a flag when mutation is detected
        (window as any)[wid] = { changed: false, summary: '' };

        const observer = new MutationObserver((mutations) => {
          const info = (window as any)[wid];
          if (info.changed) return; // Already detected

          // Summarize the change
          const types = new Set(mutations.map(m => m.type));
          const addedCount = mutations.reduce((s, m) => s + m.addedNodes.length, 0);
          const removedCount = mutations.reduce((s, m) => s + m.removedNodes.length, 0);

          const parts: string[] = [];
          if (types.has('childList')) parts.push(`DOM: +${addedCount}/-${removedCount} nodes`);
          if (types.has('characterData')) parts.push('text changed');
          if (types.has('attributes')) {
            const attrs = [...new Set(mutations.filter(m => m.type === 'attributes').map(m => m.attributeName))];
            parts.push(`attrs: ${attrs.slice(0, 3).join(', ')}`);
          }

          info.changed = true;
          info.summary = parts.join(', ') || 'mutation detected';
        });

        observer.observe(el, {
          childList: true,
          characterData: true,
          attributes: true,
          subtree: true,
        });

        // Store observer reference for cleanup
        (window as any)[wid].observer = observer;
      }, { selector, watchId });

      // Poll for change flag
      const start = Date.now();
      const POLL_INTERVAL = 200;
      let changeSummary = '';

      while (Date.now() - start < timeout) {
        const result = await page.evaluate((wid: string) => {
          const info = (window as any)[wid];
          if (!info) return { changed: false, summary: '' };
          return { changed: info.changed, summary: info.summary };
        }, watchId);

        if (result.changed) {
          changeSummary = result.summary;
          break;
        }

        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
      }

      // Cleanup: disconnect the observer
      await page.evaluate((wid: string) => {
        const info = (window as any)[wid];
        if (info?.observer) info.observer.disconnect();
        delete (window as any)[wid];
      }, watchId).catch(() => {});

      if (!changeSummary) {
        throw new Error(`Watch timed out after ${timeout}ms \u2014 no changes detected on "${selector}"`);
      }

      // If --on-change callback is specified, execute it through the pipeline
      if (onChange) {
        const { executeCommand } = await import('../../automation/executor');
        const { SessionBuffers } = await import('../../network/buffers');

        const [callbackCmd, ...callbackArgs] = parseCommandString(onChange);

        const { output: callbackResult } = await executeCommand(callbackCmd, callbackArgs, {
          context: {
            args: callbackArgs,
            target,
            buffers: currentSession?.buffers ?? new SessionBuffers(),
            domainFilter: currentSession?.domainFilter,
            session: currentSession,
            shutdown,
            sessionManager,
            lifecycle,
          },
          lifecycle,
        });

        return `Change detected (${changeSummary})\n${callbackResult}`;
      }

      return `Change detected (${changeSummary})`;
    }

    default:
      throw new Error(`Unknown workflow command: ${command}`);
  }
}

// ─── Argument Parsers ───────────────────────────────────────────

/**
 * Parse retry command arguments.
 *
 * Format: retry "command args" --until "condition" --max N --backoff
 */
function parseRetryArgs(args: string[]): {
  command: string;
  cmdArgs: string[];
  until: string[];
  maxAttempts: number;
  backoff: boolean;
} {
  let commandStr: string | null = null;
  const untilArgs: string[] = [];
  let maxAttempts = 3;
  let backoff = false;
  let inUntil = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--until') {
      inUntil = true;
      continue;
    }

    if (arg === '--max') {
      inUntil = false;
      const val = args[++i];
      if (!val || isNaN(parseInt(val, 10))) throw new Error('--max requires a number');
      maxAttempts = parseInt(val, 10);
      if (maxAttempts < 1) throw new Error('--max must be at least 1');
      continue;
    }

    if (arg === '--backoff') {
      inUntil = false;
      backoff = true;
      continue;
    }

    if (inUntil) {
      untilArgs.push(arg);
      continue;
    }

    // First non-flag arg is the command string
    if (commandStr == null) {
      commandStr = arg;
      continue;
    }

    // Remaining non-flag args before --until are treated as extra command args
    // This handles: retry click .dismiss --until --hidden .modal
    // where "click" is commandStr and ".dismiss" needs to be captured
    // Re-parse: the commandStr itself may contain the full command
    throw new Error(
      'Usage: browse retry "<command> [args]" --until <condition> [--max N] [--backoff]\n' +
      'Example: browse retry "click .dismiss" --until --hidden .modal --max 3 --backoff'
    );
  }

  if (!commandStr) {
    throw new Error(
      'Usage: browse retry "<command> [args]" --until <condition> [--max N] [--backoff]\n' +
      'Example: browse retry "click .dismiss" --until --hidden .modal --max 3 --backoff'
    );
  }

  if (untilArgs.length === 0) {
    throw new Error('--until condition is required for retry');
  }

  const parts = parseCommandString(commandStr);
  const [command, ...cmdArgs] = parts;

  return { command, cmdArgs, until: untilArgs, maxAttempts, backoff };
}

/**
 * Parse watch command arguments.
 *
 * Format: watch ".selector" --on-change "command" --timeout 30000
 */
function parseWatchArgs(args: string[]): {
  selector: string;
  onChange: string | null;
  timeout: number;
} {
  let selector: string | null = null;
  let onChange: string | null = null;
  let timeout = 30000;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--on-change') {
      onChange = args[++i];
      if (!onChange) throw new Error('--on-change requires a command string');
      continue;
    }

    if (arg === '--timeout') {
      const val = args[++i];
      if (!val || isNaN(parseInt(val, 10))) throw new Error('--timeout requires a number in milliseconds');
      timeout = parseInt(val, 10);
      continue;
    }

    if (!selector) {
      selector = arg;
      continue;
    }

    throw new Error(
      'Usage: browse watch "<selector>" [--on-change "<command>"] [--timeout ms]\n' +
      'Example: browse watch ".messages" --on-change "text" --timeout 30000'
    );
  }

  if (!selector) {
    throw new Error(
      'Usage: browse watch "<selector>" [--on-change "<command>"] [--timeout ms]\n' +
      'Example: browse watch ".messages" --on-change "text" --timeout 30000'
    );
  }

  return { selector, onChange, timeout };
}

/**
 * Parse a command string into command name and args.
 * Handles quoted strings: 'fill ".input" "hello world"'
 */
function parseCommandString(input: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuote: string | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }

    if (ch === ' ' || ch === '\t') {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (current) parts.push(current);

  if (parts.length === 0) {
    throw new Error('Empty command string');
  }

  return parts;
}
