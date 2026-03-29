/**
 * Simulator CLI entrypoint — thin wrapper over the shared sim service.
 *
 * Handled before ensureServer() in cli.ts because sim lifecycle
 * doesn't need the browse HTTP server.
 */

export async function handleSimCLI(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === '--help') {
    console.log('Usage: browse sim start --platform ios [--device <name>] [--app <bundleId>]');
    console.log('       browse sim stop');
    console.log('       browse sim status');
    return;
  }

  if (sub === 'status') {
    const { status } = await import('./app/ios/sim-service');
    const result = await status();
    if (!result.running) { console.log('No simulator/emulator running.'); return; }
    console.log(`Platform: ${result.state!.platform}`);
    console.log(`Device:   ${result.state!.device}`);
    console.log(`App:      ${result.state!.app}`);
    console.log(`Port:     ${result.state!.port}`);
    console.log(`Status:   ${result.healthy ? 'healthy' : 'unhealthy'}`);
    console.log(`Started:  ${result.state!.startedAt}`);
    return;
  }

  if (sub === 'stop') {
    const { stop } = await import('./app/ios/sim-service');
    console.log(await stop());
    return;
  }

  if (sub === 'start') {
    let platform = 'ios';
    let device: string | undefined;
    let app: string | undefined;

    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--platform' && args[i + 1]) platform = args[++i];
      else if (args[i] === '--device' && args[i + 1]) device = args[++i];
      else if (args[i] === '--app' && args[i + 1]) app = args[++i];
    }

    if (platform !== 'ios') {
      console.error(`Platform '${platform}' sim start not yet implemented.`);
      process.exit(1);
    }

    const { startIOS } = await import('./app/ios/sim-service');
    const state = await startIOS({ device, app });
    console.log(`iOS simulator ready: ${state.device} (target: ${state.app})`);
    return;
  }

  console.error(`Unknown sim subcommand: ${sub}`);
  process.exit(1);
}
