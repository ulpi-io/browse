/**
 * System/server commands — status, url, stop, restart, chain, doctor, upgrade
 */

import type { BrowserTarget } from '../../browser/target';
import type { AutomationTarget } from '../../automation/target';
import type { CommandLifecycle } from '../../automation/events';
import type { SessionManager, Session } from '../../session/manager';

export async function handleSystemCommand(
  command: string,
  args: string[],
  target: AutomationTarget,
  shutdown: () => Promise<void> | void,
  sessionManager?: SessionManager,
  currentSession?: Session,
  lifecycle?: CommandLifecycle,
): Promise<string> {
  switch (command) {
    case 'status': {
      if (!('getPage' in target)) {
        // App target — return basic status
        const lines = [
          `Status: healthy`,
          `Target: ${target.targetType}`,
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
      const bm = target as BrowserTarget;
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
      if (!('getPage' in target)) {
        return target.getCurrentLocation();
      }
      return (target as BrowserTarget).getCurrentUrl();
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
      const { PolicyChecker } = await import('../../security/policy');
      const { executeCommand } = await import('../../automation/executor');
      const { SessionBuffers } = await import('../../network/buffers');

      const policy = new PolicyChecker();
      const sessionBuffers = currentSession?.buffers ?? new SessionBuffers();

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

          const { output } = await executeCommand(name, cmdArgs, {
            context: {
              args: cmdArgs,
              target,
              buffers: sessionBuffers,
              domainFilter: currentSession?.domainFilter,
              session: currentSession,
              shutdown,
              sessionManager,
              lifecycle,
            },
            lifecycle,
          });
          results.push(`[${name}] ${output}`);
        } catch (err: any) {
          results.push(`[${name}] ERROR: ${err.message}`);
        }
      }

      return results.join('\n\n');
    }

    case 'doctor': {
      const { execSync } = await import('child_process');
      const platformArg = args.find(a => a.startsWith('--platform='))?.split('=')[1]
        || (args.indexOf('--platform') !== -1 ? args[args.indexOf('--platform') + 1] : '');
      const lines: string[] = [];
      lines.push(`Node: ${process.version}`);

      // Browser stack
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

      // Camoufox (optional anti-detection runtime)
      try {
        const camoPkg = require('camoufox-js/package.json') as { version?: string };
        // Verify runtime actually loads (binary available)
        const { findCamoufox } = await import('../../engine/resolver');
        const available = await findCamoufox();
        if (available) {
          lines.push(`Camoufox: installed v${camoPkg.version ?? '?'} (binary ready)`);
        } else {
          lines.push(`Camoufox: installed v${camoPkg.version ?? '?'} (binary NOT downloaded — run "npx camoufox-js fetch")`);
        }
      } catch {
        lines.push(`Camoufox: not installed (optional — npm install camoufox-js for anti-detection browsing)`);
      }

      lines.push(`Server: running (you're connected)`);

      // macOS app bridge
      if (process.platform === 'darwin') {
        try {
          const { ensureMacOSBridge } = await import('../../app/macos/bridge');
          const bridgePath = await ensureMacOSBridge();
          lines.push(`macOS app bridge: ${bridgePath}`);
        } catch {
          lines.push(`macOS app bridge: NOT FOUND — cd browse-ax && swift build -c release`);
        }
      }

      // Android diagnostics (always shown if --platform android, or on any platform)
      if (!platformArg || platformArg === 'android') {
        lines.push('');
        lines.push('--- Android ---');

        // adb
        try {
          const adbVersion = execSync('adb version', { encoding: 'utf-8', timeout: 5000 }).split('\n')[0].trim();
          lines.push(`adb: ${adbVersion}`);
        } catch {
          lines.push('adb: NOT FOUND — install Android SDK platform-tools and add to PATH');
          lines.push('  https://developer.android.com/tools/releases/platform-tools');
          if (platformArg === 'android') return lines.join('\n');
        }

        // Connected devices
        try {
          const devicesOut = execSync('adb devices', { encoding: 'utf-8', timeout: 5000 });
          const deviceLines = devicesOut.split('\n').slice(1).map(l => l.trim()).filter(l => l.length > 0);
          const booted = deviceLines.filter(l => l.endsWith('\tdevice'));
          const other = deviceLines.filter(l => !l.endsWith('\tdevice'));
          if (booted.length > 0) {
            lines.push(`Devices: ${booted.map(l => l.split('\t')[0]).join(', ')}`);
          } else {
            lines.push('Devices: none connected');
            lines.push('  Start an emulator (Android Studio) or connect a device with USB debugging');
          }
          if (other.length > 0) {
            lines.push(`Not ready: ${other.map(l => l.replace('\t', ' (')).join('), ')}`);
          }
        } catch {
          lines.push('Devices: could not query (adb failed)');
        }

        // Emulator availability
        try {
          execSync('emulator -list-avds', { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
          const avds = execSync('emulator -list-avds', { encoding: 'utf-8', timeout: 5000 }).trim();
          if (avds) {
            lines.push(`AVDs: ${avds.split('\n').join(', ')}`);
          } else {
            lines.push('AVDs: none configured — create one in Android Studio');
          }
        } catch {
          lines.push('Emulator: not found (optional — only needed to start AVDs from CLI)');
        }

        // Driver APK
        try {
          const fs = await import('fs');
          const path = await import('path');
          const localBuild = path.resolve(__dirname, '../../../browse-android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk');
          const installed = path.resolve(__dirname, '../../bin/browse-android.apk');
          if (fs.existsSync(localBuild)) {
            lines.push(`Driver APK: ${localBuild}`);
          } else if (fs.existsSync(installed)) {
            lines.push(`Driver APK: ${installed}`);
          } else {
            lines.push('Driver APK: NOT FOUND');
            lines.push('  Build: cd browse-android && ./gradlew :app:assembleDebugAndroidTest');
          }
        } catch {
          lines.push('Driver APK: could not check');
        }
      }

      return lines.join('\n');
    }

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

    default:
      throw new Error(`Unknown system command: ${command}`);
  }
}
