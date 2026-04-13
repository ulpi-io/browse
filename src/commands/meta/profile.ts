/**
 * Profile, React DevTools, and Cloud Provider commands — profile, react-devtools, provider
 */

import * as fs from 'fs';
import * as path from 'path';
import type { BrowserTarget } from '../../browser/target';

const LOCAL_DIR = process.env.BROWSE_LOCAL_DIR || '/tmp';

export async function handleProfileCommand(
  command: string,
  args: string[],
  bm: BrowserTarget,
): Promise<string> {
  switch (command) {
    case 'profile': {
      const subcommand = args[0];
      if (!subcommand) throw new Error('Usage: browse profile list | delete <name> | clean [--older-than <days>]');

      if (subcommand === 'list') {
        const { listProfiles } = await import('../../browser/manager');
        const profiles = listProfiles(LOCAL_DIR);
        if (profiles.length === 0) return 'No profiles found';
        return profiles.map(p => `${p.name}  ${p.size}  last used: ${p.lastUsed}`).join('\n');
      }

      if (subcommand === 'delete') {
        const name = args[1];
        if (!name) throw new Error('Usage: browse profile delete <name>');
        const { deleteProfile } = await import('../../browser/manager');
        deleteProfile(LOCAL_DIR, name);
        return `Profile "${name}" deleted`;
      }

      if (subcommand === 'clean') {
        const { listProfiles, deleteProfile } = await import('../../browser/manager');
        let maxDays = 7; // default
        const olderIdx = args.indexOf('--older-than');
        if (olderIdx !== -1 && args[olderIdx + 1]) {
          maxDays = parseInt(args[olderIdx + 1], 10);
          if (isNaN(maxDays)) throw new Error('Usage: browse profile clean --older-than <days>');
        }
        const profiles = listProfiles(LOCAL_DIR);
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - maxDays);
        let cleaned = 0;
        for (const p of profiles) {
          if (new Date(p.lastUsed) < cutoff) {
            deleteProfile(LOCAL_DIR, p.name);
            cleaned++;
          }
        }
        return cleaned > 0 ? `Cleaned ${cleaned} profile(s) older than ${maxDays} days` : 'No profiles to clean';
      }

      throw new Error('Usage: browse profile list | delete <name> | clean [--older-than <days>]');
    }

    case 'react-devtools': {
      const sub = args[0];
      if (!sub) throw new Error(
        'Usage: browse react-devtools enable|disable|tree|props|suspense|errors|profiler|hydration|renders|owners|context'
      );

      const rd = await import('../../browser/react-devtools');

      switch (sub) {
        case 'enable': {
          if (rd.isEnabled(bm)) return 'React DevTools already enabled.';
          await rd.injectHook(bm);
          await bm.getPage().reload();
          return 'React DevTools enabled. Page reloaded.';
        }
        case 'disable': {
          rd.removeHook(bm);
          return 'React DevTools disabled. Takes effect on next navigation.';
        }
        case 'tree':
          return await rd.getTree(bm, bm.getPage());
        case 'props': {
          if (!args[1]) throw new Error('Usage: browse react-devtools props <selector|@ref>');
          return await rd.getProps(bm, bm.getPage(), args[1]);
        }
        case 'suspense':
          return await rd.getSuspense(bm, bm.getPage());
        case 'errors':
          return await rd.getErrors(bm, bm.getPage());
        case 'profiler':
          return await rd.getProfiler(bm, bm.getPage());
        case 'hydration':
          return await rd.getHydration(bm, bm.getPage());
        case 'renders':
          return await rd.getRenders(bm, bm.getPage());
        case 'owners': {
          if (!args[1]) throw new Error('Usage: browse react-devtools owners <selector|@ref>');
          return await rd.getOwners(bm, bm.getPage(), args[1]);
        }
        case 'context': {
          if (!args[1]) throw new Error('Usage: browse react-devtools context <selector|@ref>');
          return await rd.getContext(bm, bm.getPage(), args[1]);
        }
        default:
          throw new Error(
            `Unknown subcommand: ${sub}. Use: enable|disable|tree|props|suspense|errors|profiler|hydration|renders|owners|context`
          );
      }
    }

    case 'provider': {
      const sub = args[0];
      if (!sub) throw new Error('Usage: browse provider save|list|delete <name> [api-key]');

      const { ProviderVault, listProviderNames } = await import('../../engine/providers');
      const vault = new ProviderVault(LOCAL_DIR);

      if (sub === 'save') {
        const name = args[1];
        const apiKey = args[2];
        if (!name || !apiKey) {
          throw new Error(
            `Usage: browse provider save <name> <api-key>\nAvailable providers: ${listProviderNames().join(', ')}`
          );
        }
        vault.save(name, apiKey);
        return `Provider "${name}" saved (API key encrypted)`;
      }

      if (sub === 'list') {
        const saved = vault.list();
        if (saved.length === 0) {
          return `No providers saved. Available: ${listProviderNames().join(', ')}\nRun: browse provider save <name> <api-key>`;
        }
        return saved.map(p => `${p.name}  saved: ${p.createdAt}`).join('\n');
      }

      if (sub === 'delete') {
        const name = args[1];
        if (!name) throw new Error('Usage: browse provider delete <name>');
        vault.delete(name);
        return `Provider "${name}" deleted`;
      }

      throw new Error(
        `Unknown subcommand: ${sub}. Usage: browse provider save|list|delete <name> [api-key]`
      );
    }

    case 'profiles': {
      return listCamoufoxProfiles(LOCAL_DIR);
    }

    default:
      throw new Error(`Unknown profile command: ${command}`);
  }
}

/**
 * List camoufox profiles from <localDir>/camoufox-profiles/*.json.
 * Exported so tests can call with a controlled directory.
 */
export function listCamoufoxProfiles(localDir: string): string {
  const profilesDir = path.join(localDir, 'camoufox-profiles');

  if (!fs.existsSync(profilesDir)) return '(no camoufox profiles found)';

  const files = fs.readdirSync(profilesDir).filter(f => f.endsWith('.json'));
  if (files.length === 0) return '(no camoufox profiles found)';

  const lines: string[] = [];
  for (const file of files) {
    const name = file.replace('.json', '');
    try {
      const raw = fs.readFileSync(path.join(profilesDir, file), 'utf-8');
      const config = JSON.parse(raw);
      const keys = Object.keys(config).join(', ');
      lines.push(`${name}  [${keys}]`);
    } catch {
      lines.push(`${name}  (invalid JSON)`);
    }
  }
  return lines.join('\n');
}
