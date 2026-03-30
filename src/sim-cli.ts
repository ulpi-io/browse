/**
 * Simulator CLI entrypoint — thin wrapper over the shared sim service.
 *
 * Handled before ensureServer() in cli.ts because sim lifecycle
 * doesn't need the browse HTTP server.
 */

export async function handleSimCLI(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === '--help') {
    console.log('Usage: browse sim start --platform ios|android [--device <name>] [--app <id-or-path>] [--visible]');
    console.log('       browse sim stop [--platform ios|android]');
    console.log('       browse sim status [--platform ios|android]');
    console.log('');
    console.log('Flags:');
    console.log('  --app        Bundle ID, package name, or path to .app/.ipa/.apk');
    console.log('  --visible    Open the Simulator window (default: headless/background)');
    return;
  }

  // Parse --platform from any subcommand
  let platform = 'ios';
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--platform' && args[i + 1]) { platform = args[i + 1]; break; }
  }

  if (sub === 'status') {
    if (platform === 'android') {
      const { status } = await import('./app/android/sim-service');
      const result = await status();
      if (!result.running) { console.log('No Android device/emulator running.'); return; }
      console.log(`Platform: ${result.state!.platform}`);
      console.log(`Device:   ${result.state!.device}`);
      console.log(`Serial:   ${result.state!.serial}`);
      console.log(`App:      ${result.state!.app}`);
      console.log(`Port:     ${result.state!.port}`);
      console.log(`Status:   ${result.healthy ? 'healthy' : 'unhealthy'}`);
      console.log(`Started:  ${result.state!.startedAt}`);
    } else {
      const { status } = await import('./app/ios/sim-service');
      const result = await status();
      if (!result.running) { console.log('No simulator/emulator running.'); return; }
      console.log(`Platform: ${result.state!.platform}`);
      console.log(`Device:   ${result.state!.device}`);
      console.log(`App:      ${result.state!.app}`);
      console.log(`Port:     ${result.state!.port}`);
      console.log(`Status:   ${result.healthy ? 'healthy' : 'unhealthy'}`);
      console.log(`Started:  ${result.state!.startedAt}`);
    }
    return;
  }

  if (sub === 'stop') {
    if (platform === 'android') {
      const { stop } = await import('./app/android/sim-service');
      console.log(await stop());
    } else {
      const { stop } = await import('./app/ios/sim-service');
      console.log(await stop());
    }
    return;
  }

  if (sub === 'start') {
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
      const { startAndroid } = await import('./app/android/sim-service');
      const state = await startAndroid({ device, app, visible });
      console.log(`Android ready: ${state.device} (target: ${state.app})`);
    } else if (platform === 'ios') {
      const { startIOS } = await import('./app/ios/sim-service');
      const state = await startIOS({ device, app, visible });
      console.log(`iOS simulator ready: ${state.device} (target: ${state.app})`);
    } else {
      console.error(`Unknown platform: '${platform}'. Use ios or android.`);
      process.exit(1);
    }
    return;
  }

  console.error(`Unknown sim subcommand: ${sub}`);
  process.exit(1);
}
