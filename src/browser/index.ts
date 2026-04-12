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
  type SnapshotOptions,
} from './snapshot';

export { expandMacro, listMacros } from './macros';

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

export { isGoogleSearchUrl, isGoogleBlocked, formatGoogleBlockError } from './detection';

export { dismissConsentDialog } from './consent';

export { waitForPageReady, type ReadinessOptions } from './readiness';

export { applySnapshotWindow, formatWindowMetadata, type WindowResult } from './snapshot-window';

export { isGoogleSerp, extractGoogleSerp } from './serp';

export { parseNetscapeCookieFile } from './cookie-import';

export {
  detectYtDlp,
  hasYtDlp,
  extractVideoId,
  ytDlpTranscript,
  parseJson3,
  parseVtt,
  parseXml,
} from './youtube';
