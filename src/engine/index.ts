/**
 * Engine module — browser runtime registry, Chrome discovery, cloud providers.
 */

export { getRuntime, findLightpanda, AVAILABLE_RUNTIMES } from './resolver';
export type { BrowserRuntime } from './resolver';

export {
  discoverChrome,
  findChromeExecutable,
  isChromeRunning,
  getChromeUserDataDir,
  fetchWsUrl,
  launchChrome,
} from './chrome';
export type { ChromeStatus, ChromeLaunchResult } from './chrome';

export {
  getProvider,
  listProviderNames,
  ProviderVault,
  resolveProviderCdpUrl,
  cleanupProvider,
} from './providers';
