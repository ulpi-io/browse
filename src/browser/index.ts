export {
  BrowserManager,
  type CoverageEntry,
} from './manager';

export type { BrowserTarget } from './target';

export {
  resolveDevice,
  listDevices,
  DEVICE_ALIASES,
  CUSTOM_DEVICES,
  type DeviceDescriptor,
} from './emulation';

export {
  getProfileDir,
  listProfiles,
  deleteProfile,
} from './profiles';

export { TabManager, type TabEntry } from './tabs';
export { RefManager } from './refs';

export {
  handleSnapshot,
  parseSnapshotArgs,
} from './snapshot';

export {
  ensureHook,
  injectHook,
  removeHook,
  isEnabled,
  requireEnabled,
  requireReact,
  getTree,
  getProps,
  getSuspense,
  getErrors,
  getProfiler,
  getHydration,
  getRenders,
  getOwners,
  getContext,
} from './react-devtools';
