/**
 * Tests for SEO/AEO read commands (schema, meta, headings),
 * camoufox config loading/mapping, and profiles command.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { handleReadCommand } from '../src/commands/read';
import { handleWriteCommand } from '../src/commands/write';
import { handleProfileCommand, listCamoufoxProfiles } from '../src/commands/meta/profile';
import { loadCamoufoxConfig, mapCamoufoxConfig } from '../src/config';
import type { CamoufoxConfig } from '../src/config';
import { sharedBm as bm, sharedBaseUrl as baseUrl } from './setup';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Read Commands: schema ─────────────────────────────────────────

describe('schema command', () => {
  test('returns JSON-LD structured data', async () => {
    await handleWriteCommand('goto', [baseUrl + '/seo-page.html'], bm);
    const result = await handleReadCommand('schema', [], bm);
    const data = JSON.parse(result);
    expect(Array.isArray(data)).toBe(true);
    // JSON-LD entry
    const article = data.find((d: Record<string, unknown>) => d['@type'] === 'Article');
    expect(article).toBeDefined();
    expect(article.headline).toBe('Test Article');
  });

  test('returns microdata structured data', async () => {
    await handleWriteCommand('goto', [baseUrl + '/seo-page.html'], bm);
    const result = await handleReadCommand('schema', [], bm);
    const data = JSON.parse(result);
    const product = data.find((d: Record<string, unknown>) => d['@microdata'] === true);
    expect(product).toBeDefined();
    expect(product['@type']).toContain('Product');
    expect(product.name).toBe('Test Product');
    expect(product.price).toBe('29.99');
  });

  test('returns "(no structured data found)" on page without structured data', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleReadCommand('schema', [], bm);
    expect(result).toBe('(no structured data found)');
  });
});

// ─── Read Commands: meta ───────────────────────────────────────────

describe('meta command', () => {
  test('returns full meta information from SEO page', async () => {
    await handleWriteCommand('goto', [baseUrl + '/seo-page.html'], bm);
    const result = await handleReadCommand('meta', [], bm);
    expect(result).toContain('title: SEO Test Page');
    expect(result).toContain('description: A test page for SEO command validation');
    expect(result).toContain('canonical:');
    expect(result).toContain('robots: index, follow');
    expect(result).toContain('viewport: width=device-width, initial-scale=1');
    expect(result).toContain('og:title: OG Title');
    expect(result).toContain('og:description: OG Description');
    expect(result).toContain('og:type: article');
    expect(result).toContain('twitter:card: summary_large_image');
    expect(result).toContain('twitter:title: Twitter Title');
    expect(result).toContain('hreflang:es:');
  });

  test('returns at least title on minimal page', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const result = await handleReadCommand('meta', [], bm);
    expect(result).toContain('title: Test Page - Basic');
  });
});

// ─── Read Commands: headings ───────────────────────────────────────

describe('headings command', () => {
  test('returns count summary and indented tree', async () => {
    await handleWriteCommand('goto', [baseUrl + '/seo-page.html'], bm);
    const result = await handleReadCommand('headings', [], bm);
    // Summary line
    expect(result).toContain('h1:1');
    expect(result).toContain('h2:2');
    expect(result).toContain('h3:3');
    // Indented tree entries
    expect(result).toContain('h1: Main Heading');
    expect(result).toContain('h2: Section One');
    expect(result).toContain('h3: Subsection A');
    expect(result).toContain('h3: Subsection B');
    expect(result).toContain('h2: Section Two');
    expect(result).toContain('h3: Subsection C');
  });

  test('returns "(no headings found)" on page without headings', async () => {
    await handleWriteCommand('goto', [baseUrl + '/download-link.html'], bm);
    const result = await handleReadCommand('headings', [], bm);
    expect(result).toBe('(no headings found)');
  });
});

// ─── Config: mapCamoufoxConfig ─────────────────────────────────────

describe('mapCamoufoxConfig', () => {
  test('maps all 26 camelCase keys to snake_case', () => {
    const full: CamoufoxConfig = {
      os: 'linux',
      blockImages: true,
      blockWebrtc: true,
      blockWebgl: true,
      disableCoop: true,
      geoip: true,
      humanize: true,
      locale: 'en-US',
      addons: ['/path/to/addon.xpi'],
      fonts: ['Arial'],
      customFontsOnly: true,
      screen: { minWidth: 1024, maxWidth: 1920 },
      window: [1280, 720],
      fingerprint: { key: 'value' },
      ffVersion: 128,
      headless: true,
      mainWorldEval: true,
      firefoxUserPrefs: { 'some.pref': 1 },
      proxy: 'http://proxy:8080',
      enableCache: true,
      debug: true,
      excludeAddons: ['addon1'],
      executablePath: '/usr/bin/firefox',
      args: ['--no-remote'],
      env: { MY_VAR: 'test' },
      virtualDisplay: ':99',
    };

    const mapped = mapCamoufoxConfig(full);

    const expectedKeys = [
      'addons', 'args', 'block_images', 'block_webgl', 'block_webrtc',
      'custom_fonts_only', 'debug', 'disable_coop', 'enable_cache', 'env',
      'exclude_addons', 'executable_path', 'ff_version', 'fingerprint',
      'firefox_user_prefs', 'fonts', 'geoip', 'headless', 'humanize',
      'locale', 'main_world_eval', 'os', 'proxy', 'screen',
      'virtual_display', 'window',
    ];

    expect(Object.keys(mapped).sort()).toEqual(expectedKeys);
  });

  test('maps values correctly', () => {
    const config: CamoufoxConfig = {
      os: 'windows',
      blockImages: true,
      headless: 'virtual',
      proxy: { server: 'http://proxy:8080', username: 'user' },
      window: [800, 600],
    };

    const mapped = mapCamoufoxConfig(config);
    expect(mapped.os).toBe('windows');
    expect(mapped.block_images).toBe(true);
    expect(mapped.headless).toBe('virtual');
    expect(mapped.proxy).toEqual({ server: 'http://proxy:8080', username: 'user' });
    expect(mapped.window).toEqual([800, 600]);
  });

  test('ignores unknown keys', () => {
    const config = { os: 'linux', unknownKey: 'should-be-ignored' } as CamoufoxConfig & { unknownKey: string };
    const mapped = mapCamoufoxConfig(config);
    expect(mapped.os).toBe('linux');
    expect(mapped).not.toHaveProperty('unknownKey');
    expect(mapped).not.toHaveProperty('unknown_key');
  });

  test('returns empty object for empty config', () => {
    const mapped = mapCamoufoxConfig({});
    expect(mapped).toEqual({});
  });
});

// ─── Config: loadCamoufoxConfig ────────────────────────────────────

describe('loadCamoufoxConfig', () => {
  let tmpDir: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-test-'));
    savedEnv = process.env.BROWSE_CAMOUFOX_PROFILE;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.BROWSE_CAMOUFOX_PROFILE;
    } else {
      process.env.BROWSE_CAMOUFOX_PROFILE = savedEnv;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns base config when no profile env var set', () => {
    delete process.env.BROWSE_CAMOUFOX_PROFILE;
    // loadCamoufoxConfig reads browse.json from project root which may or may not have camoufox section
    // With no profile env var, it should return without throwing
    const result = loadCamoufoxConfig(tmpDir);
    expect(typeof result).toBe('object');
  });

  test('throws when profile env var set but profile file missing', () => {
    process.env.BROWSE_CAMOUFOX_PROFILE = 'nonexistent-profile';
    expect(() => loadCamoufoxConfig(tmpDir)).toThrow('not found');
  });

  test('loads and merges profile over base config', () => {
    // Create profiles directory and profile file
    const profilesDir = path.join(tmpDir, 'camoufox-profiles');
    fs.mkdirSync(profilesDir, { recursive: true });

    const profileData: CamoufoxConfig = {
      os: 'windows',
      blockImages: true,
      headless: true,
    };
    fs.writeFileSync(
      path.join(profilesDir, 'test-profile.json'),
      JSON.stringify(profileData),
    );

    process.env.BROWSE_CAMOUFOX_PROFILE = 'test-profile';
    const result = loadCamoufoxConfig(tmpDir);

    // Profile values should be present
    expect(result.os).toBe('windows');
    expect(result.blockImages).toBe(true);
    expect(result.headless).toBe(true);
  });

  test('lists available profiles in error when profile not found', () => {
    // Create profiles directory with one existing profile
    const profilesDir = path.join(tmpDir, 'camoufox-profiles');
    fs.mkdirSync(profilesDir, { recursive: true });
    fs.writeFileSync(path.join(profilesDir, 'existing.json'), '{}');

    process.env.BROWSE_CAMOUFOX_PROFILE = 'missing';
    try {
      loadCamoufoxConfig(tmpDir);
      expect.unreachable('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('not found');
      expect(msg).toContain('existing');
    }
  });

  test('handles malformed profile JSON gracefully', () => {
    const profilesDir = path.join(tmpDir, 'camoufox-profiles');
    fs.mkdirSync(profilesDir, { recursive: true });
    fs.writeFileSync(path.join(profilesDir, 'bad.json'), '{ invalid json }}}');

    process.env.BROWSE_CAMOUFOX_PROFILE = 'bad';
    // Should not throw — returns base config with a warning
    const result = loadCamoufoxConfig(tmpDir);
    expect(typeof result).toBe('object');
  });
});

// ─── Meta Command: profiles ────────────────────────────────────────

describe('profiles command', () => {
  let tmpDir: string;
  let savedLocalDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-profiles-test-'));
    savedLocalDir = process.env.BROWSE_LOCAL_DIR;
    process.env.BROWSE_LOCAL_DIR = tmpDir;
  });

  afterEach(() => {
    if (savedLocalDir === undefined) {
      delete process.env.BROWSE_LOCAL_DIR;
    } else {
      process.env.BROWSE_LOCAL_DIR = savedLocalDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns "(no camoufox profiles found)" when no profiles dir exists', () => {
    const result = listCamoufoxProfiles(tmpDir);
    expect(result).toBe('(no camoufox profiles found)');
  });

  test('lists profiles when profiles directory has JSON files', () => {
    const profilesDir = path.join(tmpDir, 'camoufox-profiles');
    fs.mkdirSync(profilesDir, { recursive: true });
    fs.writeFileSync(
      path.join(profilesDir, 'stealth.json'),
      JSON.stringify({ os: 'windows', blockImages: true }),
    );
    fs.writeFileSync(
      path.join(profilesDir, 'fast.json'),
      JSON.stringify({ headless: true, enableCache: true }),
    );

    const result = listCamoufoxProfiles(tmpDir);
    expect(result).toContain('stealth');
    expect(result).toContain('os, blockImages');
    expect(result).toContain('fast');
    expect(result).toContain('headless, enableCache');
  });
});
