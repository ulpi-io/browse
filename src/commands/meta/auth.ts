/**
 * Auth and cookie commands — auth, cookie-import
 */

import type { BrowserTarget } from '../../browser/target';

const LOCAL_DIR = process.env.BROWSE_LOCAL_DIR || '/tmp';

export async function handleAuthCommand(
  command: string,
  args: string[],
  bm: BrowserTarget,
): Promise<string> {
  switch (command) {
    case 'auth': {
      const subcommand = args[0];
      const { AuthVault } = await import('../../security/auth-vault');
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

    case 'cookie-import': {
      const { findInstalledBrowsers, importCookies, CookieImportError } = await import('../../browser/cookie-import');

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
          const { listDomains } = await import('../../browser/cookie-import');
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

    default:
      throw new Error(`Unknown auth command: ${command}`);
  }
}
