/**
 * Agent workflow commands — flow, retry, watch
 *
 * TASK-036: flow   — Execute a YAML flow file step-by-step
 * TASK-037: retry  — Retry a command with backoff until a condition is met
 * TASK-038: watch  — Watch for DOM changes and execute a callback command
 */

import type { BrowserTarget } from '../../browser/target';
import type { Session } from '../../session/manager';
import type { SessionManager } from '../../session/manager';
import * as fs from 'fs';

export async function handleFlowsCommand(
  command: string,
  args: string[],
  bm: BrowserTarget,
  shutdown: () => Promise<void> | void,
  sessionManager?: SessionManager,
  currentSession?: Session,
): Promise<string> {
  switch (command) {

    // ─── TASK-036: flow ──────────────────────────────────────────
    case 'flow': {
      const filePath = args[0];
      if (!filePath) throw new Error('Usage: browse flow <file.yaml>');

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

      const { handleReadCommand } = await import('../read');
      const { handleWriteCommand } = await import('../write');
      const { registry } = await import('../../automation/registry');

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
          const spec = registry.get(step.command);
          if (!spec) throw new Error(`Unknown command: ${step.command}`);

          let result: string;
          if (spec.category === 'write') {
            result = await handleWriteCommand(step.command, step.args, bm, currentSession?.domainFilter);
          } else if (spec.category === 'read') {
            result = await handleReadCommand(step.command, step.args, bm, currentSession?.buffers);
          } else {
            // Meta command — delegate to the meta handler
            const { handleMetaCommand } = await import('./index');
            result = await handleMetaCommand(step.command, step.args, bm, shutdown, sessionManager, currentSession);
          }

          passed++;
          results.push(`✓ [${stepLabel}] ${cmdDisplay}`);
        } catch (err: any) {
          results.push(`✗ [${stepLabel}] ${cmdDisplay} — FAIL: ${err.message}`);
          results.push('');
          results.push(`Flow failed at step ${i + 1}/${total}`);
          return results.join('\n');
        }
      }

      results.push('');
      results.push(`Flow complete: ${passed}/${total} steps passed`);
      return results.join('\n');
    }

    // ─── TASK-037: retry ─────────────────────────────────────────
    case 'retry': {
      // Parse: retry "command args..." --until "condition" --max N --backoff
      const { command: retryCmd, cmdArgs: retryCmdArgs, until, maxAttempts, backoff } = parseRetryArgs(args);

      const { handleReadCommand } = await import('../read');
      const { handleWriteCommand } = await import('../write');
      const { registry } = await import('../../automation/registry');
      const { parseExpectArgs, checkConditions } = await import('../../expect');

      const spec = registry.get(retryCmd);
      if (!spec) throw new Error(`Unknown command: ${retryCmd}`);

      // Parse the until condition as expect args
      const { conditions } = parseExpectArgs(until);
      const page = bm.getPage();
      const buffers = currentSession?.buffers;

      let lastError: string | null = null;
      let delay = 100; // Initial backoff delay in ms

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          // Execute the command
          if (spec.category === 'write') {
            await handleWriteCommand(retryCmd, retryCmdArgs, bm, currentSession?.domainFilter);
          } else if (spec.category === 'read') {
            await handleReadCommand(retryCmd, retryCmdArgs, bm, buffers);
          } else {
            const { handleMetaCommand } = await import('./index');
            await handleMetaCommand(retryCmd, retryCmdArgs, bm, shutdown, sessionManager, currentSession);
          }
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
      const { selector, onChange, timeout } = parseWatchArgs(args);

      const page = bm.getPage();

      // Inject MutationObserver via page.evaluate to watch for changes
      const watchId = `__browse_watch_${Date.now()}`;
      await page.evaluate(({ selector, watchId }) => {
        const target = document.querySelector(selector);
        if (!target) throw new Error(`Element not found: ${selector}`);

        // Set a flag when mutation is detected
        (window as any)[watchId] = { changed: false, summary: '' };

        const observer = new MutationObserver((mutations) => {
          const info = (window as any)[watchId];
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

        observer.observe(target, {
          childList: true,
          characterData: true,
          attributes: true,
          subtree: true,
        });

        // Store observer reference for cleanup
        info.observer = observer;
        const info = (window as any)[watchId];
        info.observer = observer;
      }, { selector, watchId });

      // Poll for change flag
      const start = Date.now();
      const POLL_INTERVAL = 200;
      let changeSummary = '';

      while (Date.now() - start < timeout) {
        const result = await page.evaluate((watchId) => {
          const info = (window as any)[watchId];
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
      await page.evaluate((watchId) => {
        const info = (window as any)[watchId];
        if (info?.observer) info.observer.disconnect();
        delete (window as any)[watchId];
      }, watchId).catch(() => {});

      if (!changeSummary) {
        throw new Error(`Watch timed out after ${timeout}ms — no changes detected on "${selector}"`);
      }

      // If --on-change callback is specified, execute it
      if (onChange) {
        const { handleReadCommand } = await import('../read');
        const { handleWriteCommand } = await import('../write');
        const { registry } = await import('../../automation/registry');

        const [callbackCmd, ...callbackArgs] = parseCommandString(onChange);
        const spec = registry.get(callbackCmd);
        if (!spec) throw new Error(`Unknown callback command: ${callbackCmd}`);

        let callbackResult: string;
        if (spec.category === 'write') {
          callbackResult = await handleWriteCommand(callbackCmd, callbackArgs, bm, currentSession?.domainFilter);
        } else if (spec.category === 'read') {
          callbackResult = await handleReadCommand(callbackCmd, callbackArgs, bm, currentSession?.buffers);
        } else {
          const { handleMetaCommand } = await import('./index');
          callbackResult = await handleMetaCommand(callbackCmd, callbackArgs, bm, shutdown, sessionManager, currentSession);
        }

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
