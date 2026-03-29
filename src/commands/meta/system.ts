/**
 * System/server commands — status, url, stop, restart, chain, doctor, upgrade
 */

import type { BrowserTarget } from '../../browser/target';
import type { SessionManager, Session } from '../../session/manager';

export async function handleSystemCommand(
  command: string,
  args: string[],
  bm: BrowserTarget,
  shutdown: () => Promise<void> | void,
  sessionManager?: SessionManager,
  currentSession?: Session,
): Promise<string> {
  switch (command) {
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
      const { handleReadCommand } = await import('../read');
      const { handleWriteCommand } = await import('../write');
      const { PolicyChecker } = await import('../../security/policy');

      const WRITE_SET = new Set(['goto','back','forward','reload','click','dblclick','fill','select','hover','focus','check','uncheck','type','press','scroll','wait','viewport','cookie','header','useragent','upload','dialog-accept','dialog-dismiss','emulate','drag','keydown','keyup','highlight','download','route','offline','rightclick','tap','swipe','mouse','keyboard','scrollinto','scrollintoview','set','initscript']);
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
          else {
            // Delegate to the full meta handler — import lazily to avoid circular
            const { handleMetaCommand } = await import('./index');
            result = await handleMetaCommand(name, cmdArgs, bm, shutdown, sessionManager, currentSession);
          }
          results.push(`[${name}] ${result}`);
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
