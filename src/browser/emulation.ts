/**
 * Device emulation data and standalone resolution functions.
 *
 * The BrowserManager methods that perform context recreation (emulateDevice,
 * recreateContext, applyUserAgent) remain in manager.ts because they depend on
 * many private BrowserManager fields (context, browser, pages, tabSnapshots,
 * refMap, activeFramePerTab, userRoutes, domainFilter, etc.).
 *
 * TODO: When BrowserManager is further decomposed, move emulateDevice /
 * recreateContext / setViewport here as well.
 */

import { devices as playwrightDevices } from 'playwright';

export interface DeviceDescriptor {
  viewport: { width: number; height: number };
  userAgent: string;
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
}

/** Shorthand aliases for common devices → Playwright device names */
export const DEVICE_ALIASES: Record<string, string> = {
  'iphone': 'iPhone 15',
  'iphone-12': 'iPhone 12',
  'iphone-13': 'iPhone 13',
  'iphone-14': 'iPhone 14',
  'iphone-15': 'iPhone 15',
  'iphone-14-pro': 'iPhone 14 Pro Max',
  'iphone-15-pro': 'iPhone 15 Pro Max',
  'iphone-16': 'iPhone 16',
  'iphone-16-pro': 'iPhone 16 Pro',
  'iphone-16-pro-max': 'iPhone 16 Pro Max',
  'iphone-17': 'iPhone 17',
  'iphone-17-pro': 'iPhone 17 Pro',
  'iphone-17-pro-max': 'iPhone 17 Pro Max',
  'iphone-se': 'iPhone SE',
  'pixel': 'Pixel 7',
  'pixel-7': 'Pixel 7',
  'pixel-5': 'Pixel 5',
  'samsung': 'Galaxy S9+',
  'galaxy': 'Galaxy S9+',
  'ipad': 'iPad (gen 7)',
  'ipad-pro': 'iPad Pro 11',
  'ipad-mini': 'iPad Mini',
};

/** Custom device descriptors for devices not yet in Playwright's built-in list */
export const CUSTOM_DEVICES: Record<string, DeviceDescriptor> = {
  'iPhone 16': {
    viewport: { width: 393, height: 852 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
  'iPhone 16 Pro': {
    viewport: { width: 402, height: 874 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
  'iPhone 16 Pro Max': {
    viewport: { width: 440, height: 956 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
  'iPhone 17': {
    viewport: { width: 393, height: 852 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
  'iPhone 17 Pro': {
    viewport: { width: 402, height: 874 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
  'iPhone 17 Pro Max': {
    viewport: { width: 440, height: 956 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
};

/** Resolve a device name (alias or Playwright name or custom) to a descriptor, or null */
export function resolveDevice(name: string): DeviceDescriptor | null {
  // Check aliases first (case-insensitive)
  const alias = DEVICE_ALIASES[name.toLowerCase()];
  const aliasTarget = alias || name;

  // Check custom devices
  if (CUSTOM_DEVICES[aliasTarget]) {
    return CUSTOM_DEVICES[aliasTarget];
  }
  // Direct Playwright device name lookup
  if (playwrightDevices[aliasTarget]) {
    return playwrightDevices[aliasTarget] as DeviceDescriptor;
  }
  // Fuzzy: try case-insensitive match across both lists
  const lower = name.toLowerCase();
  for (const [key, desc] of Object.entries(CUSTOM_DEVICES)) {
    if (key.toLowerCase() === lower) return desc;
  }
  for (const [key, desc] of Object.entries(playwrightDevices)) {
    if (key.toLowerCase() === lower) {
      return desc as DeviceDescriptor;
    }
  }
  return null;
}

/** List all available device names */
export function listDevices(): string[] {
  const all = new Set([
    ...Object.keys(CUSTOM_DEVICES),
    ...Object.keys(playwrightDevices),
  ]);
  return [...all].sort();
}
