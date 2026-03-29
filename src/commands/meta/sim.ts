/**
 * Simulator meta command handler — thin wrapper over the shared sim services.
 *
 * This handler runs through the normal command pipeline (HTTP/MCP).
 * It delegates all logic to src/app/{ios,android}/sim-service.ts.
 */

import type { BrowserTarget } from '../../browser/target';
import type { SessionManager, Session } from '../../session/manager';

export async function handleSimCommand(
  command: string,
  args: string[],
  bm: BrowserTarget,
  shutdown?: () => Promise<void> | void,
  sessionManager?: SessionManager,
  currentSession?: Session,
): Promise<string> {
  const sub = args[0];
  if (!sub || !['start', 'stop', 'status'].includes(sub)) {
    throw new Error('Usage: browse sim start --platform ios|android [--device <name>] [--app <id>] [--visible] | stop | status');
  }

  // Parse --platform from args
  let platform = 'ios';
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--platform' && args[i + 1]) { platform = args[i + 1]; break; }
  }

  if (sub === 'status') {
    if (platform === 'android') {
      const { status } = await import('../../app/android/sim-service');
      const result = await status();
      if (!result.running) return 'No Android device/emulator running.';
      const s = result.state!;
      return `Platform: ${s.platform}\nDevice: ${s.device}\nSerial: ${s.serial}\nApp: ${s.app}\nPort: ${s.port}\nStatus: ${result.healthy ? 'healthy' : 'unhealthy'}\nStarted: ${s.startedAt}`;
    }
    const { status } = await import('../../app/ios/sim-service');
    const result = await status();
    if (!result.running) return 'No simulator/emulator running.';
    const s = result.state!;
    return `Platform: ${s.platform}\nDevice: ${s.device}\nApp: ${s.app}\nPort: ${s.port}\nStatus: ${result.healthy ? 'healthy' : 'unhealthy'}\nStarted: ${s.startedAt}`;
  }

  if (sub === 'stop') {
    if (platform === 'android') {
      const { stop } = await import('../../app/android/sim-service');
      return stop();
    }
    const { stop } = await import('../../app/ios/sim-service');
    return stop();
  }

  // start
  let device: string | undefined;
  let app: string | undefined;
  let visible = false;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--platform' && args[i + 1]) { platform = args[++i]; continue; }
    if (args[i] === '--device' && args[i + 1]) device = args[++i];
    else if (args[i] === '--app' && args[i + 1]) app = args[++i];
    else if (args[i] === '--visible') visible = true;
  }

  if (platform === 'android') {
    const { startAndroid } = await import('../../app/android/sim-service');
    const state = await startAndroid({ device, app, visible });
    return `Android ready: ${state.device} (target: ${state.app})`;
  }

  if (platform === 'ios') {
    const { startIOS } = await import('../../app/ios/sim-service');
    const state = await startIOS({ device, app, visible });
    return `iOS simulator ready: ${state.device} (target: ${state.app})`;
  }

  throw new Error(`Unknown platform: '${platform}'. Use ios or android.`);
}
