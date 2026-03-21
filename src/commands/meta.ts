/**
 * Meta commands — tabs, server control, screenshots, chain, diff, snapshot, sessions
 */

import type { BrowserManager } from '../browser-manager';
import type { SessionManager, Session } from '../session-manager';
import { handleSnapshot } from '../snapshot';
import { DEFAULTS } from '../constants';
import { sanitizeName } from '../sanitize';
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

    // ─── State Persistence ───────────────────────────────
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
        const { cleanOldStates } = await import('../session-persist');
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

    // ─── Visual ────────────────────────────────────────
    case 'screenshot': {
      const page = bm.getPage();
      const annotate = args.includes('--annotate');
      const isFullPage = args.includes('--full');
      const clipIdx = args.indexOf('--clip');
      const clipArg = clipIdx >= 0 ? args[clipIdx + 1] : null;
      const filteredArgs = args.filter((a, i) => a !== '--annotate' && a !== '--full' && a !== '--clip' && (clipIdx < 0 || i !== clipIdx + 1));

      // Parse --clip x,y,w,h
      let clip: { x: number; y: number; width: number; height: number } | undefined;
      if (clipArg) {
        const parts = clipArg.split(',').map(Number);
        if (parts.length !== 4 || parts.some(isNaN)) throw new Error('Usage: browse screenshot --clip x,y,width,height [path]');
        clip = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
        if (isFullPage) throw new Error('Cannot use --clip with --full');
      }

      // Detect element/ref selector vs output path
      // Selector: starts with @e, ., #, [ — Path: contains / or ends with image extension
      let elementSelector: string | null = null;
      let screenshotPath: string;
      const firstArg = filteredArgs[0];
      if (firstArg && (firstArg.startsWith('@e') || firstArg.startsWith('@c') || /^[.#\[]/.test(firstArg))) {
        if (clip) throw new Error('Cannot use --clip with element selector');
        elementSelector = firstArg;
        screenshotPath = filteredArgs[1] || (currentSession ? `${currentSession.outputDir}/screenshot.png` : `${LOCAL_DIR}/browse-screenshot.png`);
      } else {
        screenshotPath = firstArg || (currentSession ? `${currentSession.outputDir}/screenshot.png` : `${LOCAL_DIR}/browse-screenshot.png`);
      }

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

          await page.screenshot({ path: screenshotPath, fullPage: isFullPage });
        } finally {
          await page.evaluate(() => {
            document.getElementById('__browse_annotate__')?.remove();
          }).catch(() => {});
        }

        return `Screenshot saved: ${screenshotPath}\n\nLegend:\n${legend.join('\n')}`;
      }

      if (elementSelector) {
        const resolved = bm.resolveRef(elementSelector);
        const locator = 'locator' in resolved ? resolved.locator : page.locator(resolved.selector);
        await locator.screenshot({ path: screenshotPath });
        return `Screenshot saved: ${screenshotPath} (element: ${elementSelector})`;
      }

      await page.screenshot({ path: screenshotPath, fullPage: isFullPage, clip });
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
      const { PolicyChecker } = await import('../policy');

      const WRITE_SET = new Set(['goto','back','forward','reload','click','dblclick','fill','select','hover','focus','check','uncheck','type','press','scroll','wait','viewport','cookie','header','useragent','upload','dialog-accept','dialog-dismiss','emulate','drag','keydown','keyup','highlight','download','route','offline','rightclick','tap','swipe','mouse','keyboard','scrollinto','scrollintoview','set']);
      const READ_SET  = new Set(['text','html','links','forms','accessibility','js','eval','css','attrs','element-state','dialog','console','network','cookies','storage','perf','devices','value','count','clipboard','box','errors']);

      const sessionBuffers = currentSession?.buffers;
      const policy = new PolicyChecker();

      for (const cmd of commands) {
        const [name, ...cmdArgs] = cmd;
        try {
          // Policy check for each sub-command — chain must not bypass policy
          const policyResult = policy.check(name);
          if (policyResult === 'deny') {
            results.push(`[${name}] ERROR: Command '${name}' denied by policy`);
            continue;
          }
          if (policyResult === 'confirm') {
            results.push(`[${name}] ERROR: Command '${name}' requires confirmation (policy)`);
            continue;
          }

          let result: string;
          if (WRITE_SET.has(name))      result = await handleWriteCommand(name, cmdArgs, bm, currentSession?.domainFilter);
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

    // ─── Screenshot Diff ──────────────────────────────
    case 'screenshot-diff': {
      const isFullPageDiff = args.includes('--full');
      const diffArgs = args.filter(a => a !== '--full');
      const baseline = diffArgs[0];
      if (!baseline) throw new Error('Usage: browse screenshot-diff <baseline> [current] [--threshold 0.1] [--full]');
      if (!fs.existsSync(baseline)) throw new Error(`Baseline file not found: ${baseline}`);

      let thresholdPct = 0.1;
      const threshIdx = diffArgs.indexOf('--threshold');
      if (threshIdx !== -1 && diffArgs[threshIdx + 1]) {
        thresholdPct = parseFloat(diffArgs[threshIdx + 1]);
      }

      const baselineBuffer = fs.readFileSync(baseline);

      // Find optional current image path: any non-flag arg after baseline
      let currentBuffer: Buffer;
      let currentPath: string | undefined;
      for (let i = 1; i < diffArgs.length; i++) {
        if (diffArgs[i] === '--threshold') { i++; continue; }
        if (!diffArgs[i].startsWith('--')) { currentPath = diffArgs[i]; break; }
      }
      if (currentPath) {
        if (!fs.existsSync(currentPath)) throw new Error(`Current screenshot not found: ${currentPath}`);
        currentBuffer = fs.readFileSync(currentPath);
      } else {
        const page = bm.getPage();
        currentBuffer = await page.screenshot({ fullPage: isFullPageDiff }) as Buffer;
      }

      const { compareScreenshots } = await import('../png-compare');
      const result = compareScreenshots(baselineBuffer, currentBuffer, thresholdPct);

      // Diff path: append -diff before extension, or add -diff.png if no extension
      const extIdx = baseline.lastIndexOf('.');
      const diffPath = extIdx > 0
        ? baseline.slice(0, extIdx) + '-diff' + baseline.slice(extIdx)
        : baseline + '-diff.png';
      if (!result.passed && result.diffImage) {
        fs.writeFileSync(diffPath, result.diffImage);
      }

      return [
        `Pixels: ${result.totalPixels}`,
        `Different: ${result.diffPixels}`,
        `Mismatch: ${result.mismatchPct.toFixed(3)}%`,
        `Threshold: ${thresholdPct}%`,
        `Result: ${result.passed ? 'PASS' : 'FAIL'}`,
        ...(!result.passed ? [`Diff saved: ${diffPath}`] : []),
      ].join('\n');
    }

    // ─── Auth Vault ─────────────────────────────────────
    case 'auth': {
      const subcommand = args[0];
      const { AuthVault } = await import('../auth-vault');
      const vault = new AuthVault(LOCAL_DIR);

      switch (subcommand) {
        case 'save': {
          const [, name, url, username] = args;
          // Parse optional selector flags first (Task 9: scan flags before positional args)
          let userSel: string | undefined;
          let passSel: string | undefined;
          let submitSel: string | undefined;
          const positionalAfterUsername: string[] = [];
          const knownFlags = new Set(['--user-sel', '--pass-sel', '--submit-sel']);
          for (let i = 4; i < args.length; i++) {
            if (args[i] === '--user-sel' && args[i+1]) { userSel = args[++i]; }
            else if (args[i] === '--pass-sel' && args[i+1]) { passSel = args[++i]; }
            else if (args[i] === '--submit-sel' && args[i+1]) { submitSel = args[++i]; }
            else if (!knownFlags.has(args[i])) { positionalAfterUsername.push(args[i]); }
          }
          // Password: from positional arg (after username), or env var
          // (--password-stdin is handled in CLI before reaching server)
          let password: string | undefined = positionalAfterUsername[0];
          if (!password && process.env.BROWSE_AUTH_PASSWORD) {
            password = process.env.BROWSE_AUTH_PASSWORD;
          }
          if (!name || !url || !username || !password) {
            throw new Error(
              'Usage: browse auth save <name> <url> <username> <password>\n' +
              '       browse auth save <name> <url> <username> --password-stdin\n' +
              '       BROWSE_AUTH_PASSWORD=secret browse auth save <name> <url> <username>'
            );
          }
          const selectors = (userSel || passSel || submitSel) ? { username: userSel, password: passSel, submit: submitSel } : undefined;
          vault.save(name, url, username, password, selectors);
          return `Credentials saved: ${name}`;
        }
        case 'login': {
          const name = args[1];
          if (!name) throw new Error('Usage: browse auth login <name>');
          return await vault.login(name, bm);
        }
        case 'list': {
          const creds = vault.list();
          if (creds.length === 0) return '(no saved credentials)';
          return creds.map(c => `  ${c.name} — ${c.url} (${c.username})`).join('\n');
        }
        case 'delete': {
          const name = args[1];
          if (!name) throw new Error('Usage: browse auth delete <name>');
          vault.delete(name);
          return `Credentials deleted: ${name}`;
        }
        default:
          throw new Error('Usage: browse auth save|login|list|delete [args...]');
      }
    }

    // ─── Cookie Import ──────────────────────────────────
    case 'cookie-import': {
      const { findInstalledBrowsers, importCookies, CookieImportError } = await import('../cookie-import');

      // --list: show installed browsers
      if (args.includes('--list')) {
        const browsers = findInstalledBrowsers();
        if (browsers.length === 0) return 'No supported Chromium browsers found';
        return 'Installed browsers:\n' + browsers.map(b => `  ${b.name}`).join('\n');
      }

      const browserName = args[0];
      if (!browserName) {
        throw new Error(
          'Usage: browse cookie-import --list\n' +
          '       browse cookie-import <browser> [--domain <d>] [--profile <p>]\n' +
          'Supported browsers: chrome, arc, brave, edge'
        );
      }

      // Parse --domain and --profile flags
      const domains: string[] = [];
      let profile: string | undefined;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--domain' && args[i + 1]) { domains.push(args[++i]); }
        else if (args[i] === '--profile' && args[i + 1]) { profile = args[++i]; }
      }

      try {
        // If no domains specified, import all by listing domains first then importing all
        if (domains.length === 0) {
          const { listDomains } = await import('../cookie-import');
          const { domains: allDomains, browser } = listDomains(browserName, profile);
          if (allDomains.length === 0) return `No cookies found in ${browser}`;
          const allDomainNames = allDomains.map(d => d.domain);
          const result = await importCookies(browserName, allDomainNames, profile);
          const context = bm.getContext();
          if (!context) throw new Error('No browser context');
          if (result.cookies.length > 0) await context.addCookies(result.cookies);
          const domainCount = Object.keys(result.domainCounts).length;
          const failedNote = result.failed > 0 ? ` (${result.failed} failed to decrypt)` : '';
          return `Imported ${result.count} cookies from ${browser} across ${domainCount} domains${failedNote}`;
        }

        const result = await importCookies(browserName, domains, profile);
        const context = bm.getContext();
        if (!context) throw new Error('No browser context');
        if (result.cookies.length > 0) await context.addCookies(result.cookies);
        const domainLabel = domains.length === 1 ? `for ${domains[0]} ` : '';
        const failedNote = result.failed > 0 ? ` (${result.failed} failed to decrypt)` : '';
        // Resolve display name from the result's domain counts keys or use arg
        const browserDisplay = Object.keys(result.domainCounts).length > 0
          ? browserName.charAt(0).toUpperCase() + browserName.slice(1)
          : browserName;
        return `Imported ${result.count} cookies ${domainLabel}from ${browserDisplay}${failedNote}`;
      } catch (err) {
        if (err instanceof CookieImportError) {
          const hint = err.action === 'retry' ? ' (retry may help)' : '';
          throw new Error(err.message + hint);
        }
        throw err;
      }
    }

    // ─── HAR Recording ────────────────────────────────
    case 'har': {
      const subcommand = args[0];
      if (!subcommand) throw new Error('Usage: browse har start | browse har stop [path]');

      if (subcommand === 'start') {
        bm.startHarRecording();
        return 'HAR recording started';
      }

      if (subcommand === 'stop') {
        const recording = bm.stopHarRecording();
        if (!recording) throw new Error('No active HAR recording. Run "browse har start" first.');

        const sessionBuffers = currentSession?.buffers || bm.getBuffers();
        const { formatAsHar } = await import('../har');
        const har = formatAsHar(sessionBuffers.networkBuffer, recording.startTime);

        const harPath = args[1] || (currentSession
          ? `${currentSession.outputDir}/recording.har`
          : `${LOCAL_DIR}/browse-recording.har`);

        fs.writeFileSync(harPath, JSON.stringify(har, null, 2));
        const entryCount = (har as any).log.entries.length;
        return `HAR saved: ${harPath} (${entryCount} entries)`;
      }

      throw new Error('Usage: browse har start | browse har stop [path]');
    }

    // ─── Video Recording ─────────────────────────────────
    case 'video': {
      const subcommand = args[0];
      if (!subcommand) throw new Error('Usage: browse video start [dir] | browse video stop | browse video status');

      if (subcommand === 'start') {
        const dir = args[1] || (currentSession
          ? `${currentSession.outputDir}`
          : `${LOCAL_DIR}`);
        await bm.startVideoRecording(dir);
        return `Video recording started — output dir: ${dir}`;
      }

      if (subcommand === 'stop') {
        const result = await bm.stopVideoRecording();
        if (!result) throw new Error('No active video recording. Run "browse video start" first.');
        const duration = ((Date.now() - result.startedAt) / 1000).toFixed(1);
        return `Video saved: ${result.paths.join(', ')} (${duration}s)`;
      }

      if (subcommand === 'status') {
        const recording = bm.getVideoRecording();
        if (!recording) return 'No active video recording';
        const duration = ((Date.now() - recording.startedAt) / 1000).toFixed(1);
        return `Video recording active — dir: ${recording.dir}, duration: ${duration}s`;
      }

      throw new Error('Usage: browse video start [dir] | browse video stop | browse video status');
    }

    // ─── Doctor ────────────────────────────────────────
    case 'doctor': {
      const lines: string[] = [];
      lines.push(`Node: ${process.version}`);
      try {
        const pw = await import('playwright');
        lines.push(`Playwright: installed`);
        try {
          const chromium = pw.chromium;
          lines.push(`Chromium: ${chromium.executablePath()}`);
        } catch {
          lines.push(`Chromium: NOT FOUND — run "bunx playwright install chromium"`);
        }
      } catch {
        lines.push(`Playwright: NOT INSTALLED — run "bun install playwright"`);
      }
      lines.push(`Server: running (you're connected)`);
      return lines.join('\n');
    }

    // ─── Upgrade ────────────────────────────────────────
    case 'upgrade': {
      const { execSync } = await import('child_process');
      try {
        const output = execSync('npm update -g @ulpi/browse 2>&1', { encoding: 'utf-8', timeout: 30000 });
        return `Upgrade complete.\n${output.trim()}`;
      } catch (err: any) {
        if (err.message?.includes('EACCES') || err.message?.includes('permission')) {
          return `Permission denied. Try: sudo npm update -g @ulpi/browse`;
        }
        return `Upgrade failed: ${err.message}\nManual: npm install -g @ulpi/browse`;
      }
    }

    // ─── Semantic Locator ──────────────────────────────
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

      const count = await locator.count();
      let firstText = '';
      if (count > 0) {
        try {
          firstText = (await locator.first().textContent({ timeout: 2000 })) || '';
          firstText = firstText.trim().slice(0, 100);
        } catch {}
      }
      return `Found ${count} match(es)${firstText ? `: "${firstText}"` : ''}`;
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

    // ─── DevTools Inspect ──────────────────────────────
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

    // ─── Record & Export ─────────────────────────────────
    case 'record': {
      const subcommand = args[0];
      if (!subcommand) throw new Error('Usage: browse record start | stop | status | export browse|replay [path]');

      if (subcommand === 'start') {
        if (!currentSession) throw new Error('Recording requires a session context');
        if (currentSession.recording) throw new Error('Recording already active. Run "browse record stop" first.');
        currentSession.recording = [];
        return 'Recording started';
      }

      if (subcommand === 'stop') {
        if (!currentSession) throw new Error('Recording requires a session context');
        if (!currentSession.recording) throw new Error('No active recording. Run "browse record start" first.');
        const count = currentSession.recording.length;
        // Store last recording for export after stop
        (currentSession as any)._lastRecording = currentSession.recording;
        currentSession.recording = null;
        return `Recording stopped (${count} steps captured)`;
      }

      if (subcommand === 'status') {
        if (!currentSession) return 'No session context';
        if (currentSession.recording) {
          return `Recording active — ${currentSession.recording.length} steps captured`;
        }
        const last = (currentSession as any)._lastRecording;
        if (last) return `Recording stopped — ${last.length} steps available for export`;
        return 'No active recording';
      }

      if (subcommand === 'export') {
        if (!currentSession) throw new Error('Recording requires a session context');
        const format = args[1];
        if (!format) throw new Error('Usage: browse record export browse|replay [path]');

        // Use active recording or last stopped recording
        const steps = currentSession.recording || (currentSession as any)._lastRecording;
        if (!steps || steps.length === 0) {
          throw new Error('No recording to export. Run "browse record start" first, execute commands, then export.');
        }

        const { exportBrowse, exportReplay } = await import('../record-export');

        let output: string;
        if (format === 'browse') {
          output = exportBrowse(steps);
        } else if (format === 'replay') {
          output = exportReplay(steps);
        } else {
          throw new Error(`Unknown format: ${format}. Use "browse" (chain JSON) or "replay" (Playwright/Puppeteer).`);
        }

        const filePath = args[2];
        if (filePath) {
          fs.writeFileSync(filePath, output);
          return `Exported ${steps.length} steps as ${format}: ${filePath}`;
        }

        // No path — return the script to stdout
        return output;
      }

      throw new Error('Usage: browse record start | stop | status | export browse|replay [path]');
    }

    default:
      throw new Error(`Unknown meta command: ${command}`);
  }
}
