/**
 * Meta commands — tabs, server control, screenshots, chain, diff, snapshot, sessions
 */

import type { BrowserManager } from '../browser-manager';
import type { SessionManager, Session } from '../session-manager';
import { handleSnapshot } from '../snapshot';
import { DEFAULTS } from '../constants';
import * as Diff from 'diff';
import * as fs from 'fs';

const LOCAL_DIR = process.env.BROWSE_LOCAL_DIR || '/tmp';

export async function handleMetaCommand(
  command: string,
  args: string[],
  bm: BrowserManager,
  shutdown: () => Promise<void> | void,
  sessionManager?: SessionManager,
  currentSession?: Session
): Promise<string> {
  switch (command) {
    // ─── Tabs ──────────────────────────────────────────
    case 'tabs': {
      const tabs = await bm.getTabListWithTitles();
      return tabs.map(t =>
        `${t.active ? '→ ' : '  '}[${t.id}] ${t.title || '(untitled)'} — ${t.url}`
      ).join('\n');
    }

    case 'tab': {
      const id = parseInt(args[0], 10);
      if (isNaN(id)) throw new Error('Usage: browse tab <id>');
      bm.switchTab(id);
      return `Switched to tab ${id}`;
    }

    case 'newtab': {
      const url = args[0];
      const id = await bm.newTab(url);
      return `Opened tab ${id}${url ? ` → ${url}` : ''}`;
    }

    case 'closetab': {
      const id = args[0] ? parseInt(args[0], 10) : undefined;
      await bm.closeTab(id);
      return `Closed tab${id ? ` ${id}` : ''}`;
    }

    // ─── Server Control ────────────────────────────────
    case 'status': {
      const page = bm.getPage();
      const tabs = bm.getTabCount();
      const lines = [
        `Status: healthy`,
        `URL: ${page.url()}`,
        `Tabs: ${tabs}`,
        `PID: ${process.pid}`,
        `Uptime: ${Math.floor(process.uptime())}s`,
      ];
      if (sessionManager) {
        lines.push(`Sessions: ${sessionManager.getSessionCount()}`);
      }
      if (currentSession) {
        lines.push(`Session: ${currentSession.id}`);
      }
      return lines.join('\n');
    }

    case 'url': {
      return bm.getCurrentUrl();
    }

    case 'stop': {
      setTimeout(() => shutdown(), 100);
      return 'Server stopped';
    }

    case 'restart': {
      console.log('[browse] Restart requested. Exiting for CLI to restart.');
      setTimeout(() => shutdown(), 100);
      return 'Restarting...';
    }

    // ─── Sessions ───────────────────────────────────────
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
      await sessionManager.closeSession(id);
      return `Session "${id}" closed`;
    }

    // ─── State Persistence ───────────────────────────────
    case 'state': {
      const subcommand = args[0];
      if (!subcommand || !['save', 'load'].includes(subcommand)) {
        throw new Error('Usage: browse state save [name] | browse state load [name]');
      }
      const name = args[1] || 'default';
      const statesDir = `${LOCAL_DIR}/states`;
      const statePath = `${statesDir}/${name}.json`;

      if (subcommand === 'save') {
        const context = bm.getContext();
        if (!context) throw new Error('No browser context');
        const state = await context.storageState();
        fs.mkdirSync(statesDir, { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
        return `State saved: ${statePath}`;
      }

      if (subcommand === 'load') {
        if (!fs.existsSync(statePath)) {
          throw new Error(`State file not found: ${statePath}. Run "browse state save ${name}" first.`);
        }
        const stateData = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        // Add cookies from saved state to current context
        const context = bm.getContext();
        if (!context) throw new Error('No browser context');
        if (stateData.cookies?.length) {
          await context.addCookies(stateData.cookies);
        }
        // Restore localStorage/sessionStorage for each origin
        if (stateData.origins?.length) {
          for (const origin of stateData.origins) {
            if (origin.localStorage?.length) {
              const page = bm.getPage();
              await page.goto(origin.origin, { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
              for (const item of origin.localStorage) {
                await page.evaluate(([k, v]) => localStorage.setItem(k, v), [item.name, item.value]).catch(() => {});
              }
            }
          }
        }
        return `State loaded: ${statePath}`;
      }
      throw new Error('Usage: browse state save [name] | browse state load [name]');
    }

    // ─── Visual ────────────────────────────────────────
    case 'screenshot': {
      const page = bm.getPage();
      const annotate = args.includes('--annotate');
      const filteredArgs = args.filter(a => a !== '--annotate');
      const screenshotPath = filteredArgs[0] || (currentSession ? `${currentSession.outputDir}/screenshot.png` : `${LOCAL_DIR}/browse-screenshot.png`);

      if (annotate) {
        const viewport = page.viewportSize() || { width: 1920, height: 1080 };
        const annotations = await page.evaluate((vp) => {
          const INTERACTIVE = ['a', 'button', 'input', 'select', 'textarea', 'details', 'summary'];
          const INTERACTIVE_ROLES = ['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
            'listbox', 'menuitem', 'option', 'searchbox', 'slider', 'switch', 'tab'];
          const results: Array<{ x: number; y: number; desc: string }> = [];
          const scrollX = window.scrollX;
          const scrollY = window.scrollY;

          const candidates = document.querySelectorAll(
            INTERACTIVE.join(',') + ',[role],[onclick],[tabindex],[data-action]'
          );

          for (let i = 0; i < candidates.length && results.length < 200; i++) {
            const el = candidates[i] as HTMLElement;
            if (el.offsetWidth === 0 && el.offsetHeight === 0) continue;

            const tag = el.tagName.toLowerCase();
            const role = el.getAttribute('role') || '';
            const isInteractive = INTERACTIVE.includes(tag) || INTERACTIVE_ROLES.includes(role);
            if (!isInteractive && !el.hasAttribute('onclick') &&
                !el.hasAttribute('tabindex') && !el.hasAttribute('data-action') &&
                getComputedStyle(el).cursor !== 'pointer') continue;

            const rect = el.getBoundingClientRect();
            if (rect.right < 0 || rect.left > vp.width) continue;
            if (rect.width < 5 || rect.height < 5) continue;

            const text = (el.textContent || '').trim().slice(0, 40).replace(/\s+/g, ' ');
            const desc = `${tag}${role ? '[' + role + ']' : ''} "${text}"`;
            results.push({ x: rect.left + scrollX, y: rect.top + scrollY, desc });
          }
          return results;
        }, viewport);

        const legend: string[] = [];
        const badges = annotations.map((a, i) => {
          const num = i + 1;
          legend.push(`${num}. ${a.desc}`);
          return { num, x: a.x, y: a.y };
        });

        try {
          await page.evaluate((items: Array<{ num: number; x: number; y: number }>) => {
            const container = document.createElement('div');
            container.id = '__browse_annotate__';
            container.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
            for (const b of items) {
              const el = document.createElement('div');
              el.style.cssText = `position:absolute;top:${b.y}px;left:${b.x}px;width:20px;height:20px;border-radius:50%;background:#e11d48;color:#fff;font:bold 11px/20px sans-serif;text-align:center;border:1px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4);`;
              el.textContent = String(b.num);
              container.appendChild(el);
            }
            document.body.appendChild(container);
          }, badges);

          await page.screenshot({ path: screenshotPath, fullPage: true });
        } finally {
          await page.evaluate(() => {
            document.getElementById('__browse_annotate__')?.remove();
          }).catch(() => {});
        }

        return `Screenshot saved: ${screenshotPath}\n\nLegend:\n${legend.join('\n')}`;
      }

      await page.screenshot({ path: screenshotPath, fullPage: true });
      return `Screenshot saved: ${screenshotPath}`;
    }

    case 'pdf': {
      const page = bm.getPage();
      const pdfPath = args[0] || (currentSession ? `${currentSession.outputDir}/page.pdf` : `${LOCAL_DIR}/browse-page.pdf`);
      await page.pdf({ path: pdfPath, format: 'A4' });
      return `PDF saved: ${pdfPath}`;
    }

    case 'responsive': {
      const page = bm.getPage();
      const prefix = args[0] || (currentSession ? `${currentSession.outputDir}/responsive` : `${LOCAL_DIR}/browse-responsive`);
      const viewports = [
        { name: 'mobile', width: 375, height: 812 },
        { name: 'tablet', width: 768, height: 1024 },
        { name: 'desktop', width: 1920, height: 1080 },
      ];
      const originalViewport = page.viewportSize();
      const results: string[] = [];

      try {
        for (const vp of viewports) {
          await page.setViewportSize({ width: vp.width, height: vp.height });
          const path = `${prefix}-${vp.name}.png`;
          await page.screenshot({ path, fullPage: true });
          results.push(`${vp.name} (${vp.width}x${vp.height}): ${path}`);
        }
      } finally {
        if (originalViewport) {
          await page.setViewportSize(originalViewport).catch(() => {});
        }
      }

      return results.join('\n');
    }

    // ─── Chain ─────────────────────────────────────────
    case 'chain': {
      const jsonStr = args[0];
      if (!jsonStr) throw new Error('Usage: echo \'[["goto","url"],["text"]]\' | browse chain');

      let commands: string[][];
      try {
        commands = JSON.parse(jsonStr);
      } catch {
        throw new Error('Invalid JSON. Expected: [["command", "arg1", "arg2"], ...]');
      }

      if (!Array.isArray(commands)) throw new Error('Expected JSON array of commands');

      const results: string[] = [];
      const { handleReadCommand } = await import('./read');
      const { handleWriteCommand } = await import('./write');

      const WRITE_SET = new Set(['goto','back','forward','reload','click','dblclick','fill','select','hover','focus','check','uncheck','type','press','scroll','wait','viewport','cookie','header','useragent','upload','dialog-accept','dialog-dismiss','emulate','drag','keydown','keyup','highlight','download']);
      const READ_SET  = new Set(['text','html','links','forms','accessibility','js','eval','css','attrs','state','dialog','console','network','cookies','storage','perf','devices','value','count']);

      const sessionBuffers = currentSession?.buffers;

      for (const cmd of commands) {
        const [name, ...cmdArgs] = cmd;
        try {
          let result: string;
          if (WRITE_SET.has(name))      result = await handleWriteCommand(name, cmdArgs, bm);
          else if (READ_SET.has(name))  result = await handleReadCommand(name, cmdArgs, bm, sessionBuffers);
          else                          result = await handleMetaCommand(name, cmdArgs, bm, shutdown, sessionManager, currentSession);
          results.push(`[${name}] ${result}`);
        } catch (err: any) {
          results.push(`[${name}] ERROR: ${err.message}`);
        }
      }

      return results.join('\n\n');
    }

    // ─── Diff ──────────────────────────────────────────
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

    // ─── Snapshot ─────────────────────────────────────
    case 'snapshot': {
      return await handleSnapshot(args, bm);
    }

    // ─── Snapshot Diff ──────────────────────────────
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

    // ─── iframe Targeting ─────────────────────────────
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

    default:
      throw new Error(`Unknown meta command: ${command}`);
  }
}
