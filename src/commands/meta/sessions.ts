/**
 * Session management commands — sessions, session-close, state, handoff, resume
 */

import type { BrowserTarget } from '../../browser/target';
import type { SessionManager, Session } from '../../session/manager';
import { sanitizeName } from '../../security/sanitize';
import * as fs from 'fs';

const LOCAL_DIR = process.env.BROWSE_LOCAL_DIR || '/tmp';

export async function handleSessionsCommand(
  command: string,
  args: string[],
  bm: BrowserTarget,
  sessionManager?: SessionManager,
  currentSession?: Session,
): Promise<string> {
  switch (command) {
    case 'sessions': {
      if (!sessionManager) return '(session management not available)';
      const list = sessionManager.listSessions();
      if (list.length === 0) return '(no active sessions)';
      return list.map(s =>
        `  [${s.id}] ${s.tabs} tab(s) — ${s.url} — idle ${s.idleSeconds}s`
      ).join('\n');
    }

    case 'session-close': {
      if (!sessionManager) throw new Error('Session management not available');
      const id = args[0];
      if (!id) throw new Error('Usage: browse session-close <id>');
      // Flush buffers before closing so logs aren't lost
      const closingSession = sessionManager.getAllSessions().find(s => s.id === id);
      if (closingSession) {
        const buffers = closingSession.buffers;
        const consolePath = `${closingSession.outputDir}/console.log`;
        const networkPath = `${closingSession.outputDir}/network.log`;
        const newConsoleCount = buffers.consoleTotalAdded - buffers.lastConsoleFlushed;
        if (newConsoleCount > 0) {
          const count = Math.min(newConsoleCount, buffers.consoleBuffer.length);
          const entries = buffers.consoleBuffer.slice(-count);
          const lines = entries.map(e =>
            `[${new Date(e.timestamp).toISOString()}] [${e.level}] ${e.text}`
          ).join('\n') + '\n';
          fs.appendFileSync(consolePath, lines);
          buffers.lastConsoleFlushed = buffers.consoleTotalAdded;
        }
        const newNetworkCount = buffers.networkTotalAdded - buffers.lastNetworkFlushed;
        if (newNetworkCount > 0) {
          const count = Math.min(newNetworkCount, buffers.networkBuffer.length);
          const entries = buffers.networkBuffer.slice(-count);
          const lines = entries.map(e =>
            `[${new Date(e.timestamp).toISOString()}] ${e.method} ${e.url} → ${e.status || 'pending'} (${e.duration || '?'}ms, ${e.size || '?'}B)`
          ).join('\n') + '\n';
          fs.appendFileSync(networkPath, lines);
          buffers.lastNetworkFlushed = buffers.networkTotalAdded;
        }
      }
      await sessionManager.closeSession(id);
      return `Session "${id}" closed`;
    }

    case 'state': {
      const subcommand = args[0];
      if (!subcommand || !['save', 'load', 'list', 'show', 'clean'].includes(subcommand)) {
        throw new Error('Usage: browse state save|load|list|show|clean [name] [--older-than N]');
      }
      const name = sanitizeName(args[1] || 'default');
      const statesDir = `${LOCAL_DIR}/states`;
      const statePath = `${statesDir}/${name}.json`;

      if (subcommand === 'list') {
        if (!fs.existsSync(statesDir)) return '(no saved states)';
        const files = fs.readdirSync(statesDir).filter(f => f.endsWith('.json'));
        if (files.length === 0) return '(no saved states)';
        const lines: string[] = [];
        for (const file of files) {
          const fp = `${statesDir}/${file}`;
          const stat = fs.statSync(fp);
          lines.push(`  ${file.replace('.json', '')}  ${stat.size}B  ${new Date(stat.mtimeMs).toISOString()}`);
        }
        return lines.join('\n');
      }

      if (subcommand === 'show') {
        if (!fs.existsSync(statePath)) {
          throw new Error(`State file not found: ${statePath}`);
        }
        const data = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        const cookieCount = data.cookies?.length || 0;
        const originCount = data.origins?.length || 0;
        const storageItems = (data.origins || []).reduce((sum: number, o: any) => sum + (o.localStorage?.length || 0), 0);
        return [
          `State: ${name}`,
          `Cookies: ${cookieCount}`,
          `Origins: ${originCount}`,
          `Storage items: ${storageItems}`,
        ].join('\n');
      }

      if (subcommand === 'clean') {
        const olderThanIdx = args.indexOf('--older-than');
        const maxDays = olderThanIdx !== -1 && args[olderThanIdx + 1]
          ? parseInt(args[olderThanIdx + 1], 10)
          : 7;
        if (isNaN(maxDays) || maxDays < 1) {
          throw new Error('--older-than must be a positive number of days');
        }
        const { cleanOldStates } = await import('../../session/persist');
        const { deleted } = cleanOldStates(LOCAL_DIR, maxDays);
        return deleted > 0
          ? `Deleted ${deleted} state file(s) older than ${maxDays} days`
          : `No state files older than ${maxDays} days`;
      }

      if (subcommand === 'save') {
        const context = bm.getContext();
        if (!context) throw new Error('No browser context');
        const state = await context.storageState();
        fs.mkdirSync(statesDir, { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
        return `State saved: ${statePath}`;
      }

      if (subcommand === 'load') {
        if (!fs.existsSync(statePath)) {
          throw new Error(`State file not found: ${statePath}. Run "browse state save ${name}" first.`);
        }
        const stateData = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        const context = bm.getContext();
        if (!context) throw new Error('No browser context');
        const warnings: string[] = [];
        if (stateData.cookies?.length) {
          try {
            await context.addCookies(stateData.cookies);
          } catch (err: any) {
            warnings.push(`Cookies: ${err.message}`);
          }
        }
        if (stateData.origins?.length) {
          for (const origin of stateData.origins) {
            if (origin.localStorage?.length) {
              try {
                const page = bm.getPage();
                await page.goto(origin.origin, { waitUntil: 'domcontentloaded', timeout: 5000 });
                for (const item of origin.localStorage) {
                  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [item.name, item.value]);
                }
              } catch (err: any) {
                warnings.push(`Storage for ${origin.origin}: ${err.message}`);
              }
            }
          }
        }
        if (warnings.length > 0) {
          return `State loaded: ${statePath} (${warnings.length} warning(s))\n${warnings.join('\n')}`;
        }
        return `State loaded: ${statePath}`;
      }
      throw new Error('Usage: browse state save|load|list|show [name]');
    }

    case 'handoff': {
      const useChromium = args.includes('--chromium');
      const filteredArgs = args.filter(a => a !== '--chromium');
      const message = filteredArgs.join(' ') || 'User takeover requested';
      return await bm.handoff(message, useChromium);
    }

    case 'resume': {
      const url = await bm.resume();
      // Take fresh snapshot after resuming
      const { handleSnapshot } = await import('../../browser/snapshot');
      const snapshot = await handleSnapshot(['-i'], bm);
      return `Resumed — back to headless.\nURL: ${url}\n\n${snapshot}`;
    }

    default:
      throw new Error(`Unknown sessions command: ${command}`);
  }
}
