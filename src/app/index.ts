/**
 * App automation domain — normalized app tree, ref assignment, and command dispatch.
 *
 * Public API for the app automation layer. Consumers import from here.
 */

export type { AppNode, AppState, BridgeResult, AppBridgeProtocol } from './types';
export type {
  RawAndroidNode,
  AndroidState,
  AndroidDriverProtocol,
  ActionRequest,
  SetValueRequest,
  TypeRequest,
  PressRequest,
  ScreenshotRequest,
  DriverResult,
} from './android/protocol';
export { AndroidAppManager } from './android/manager';
export { ensureAndroidBridge, createAndroidBridge } from './android/bridge';
export type {
  RawIOSNode,
  IOSState,
  IOSRunnerProtocol,
  RunnerResponse,
} from './ios/protocol';
export { normalizeIOSRole, IOS_ROLE_MAP } from './ios/protocol';
export { IOSAppManager, createIOSAppManager } from './ios/manager';
export { ensureIOSBridge, ensureRunnerApp, createIOSBridge } from './ios/bridge';
export {
  listSimulators,
  resolveSimulator,
  bootSimulator,
  shutdownSimulator,
  installApp,
  uninstallApp,
  launchApp,
  terminateApp,
  isAppInstalled,
  grantPermission,
  revokePermission,
  resetPermissions,
  screenshotSimulator,
  getAppContainer,
  openURL,
  addMedia,
  setStatusBar,
  clearStatusBar,
  checkXcodeTools,
  type SimulatorInfo,
  type SimulatorPermission,
} from './ios/controller';
