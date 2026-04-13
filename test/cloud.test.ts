/**
 * Integration tests for the cloud API modules.
 *
 * Tests auth (ApiKeyVault + JWT), tenant isolation (CloudSessionManager),
 * and session freeze/resume — all tested at the module level without
 * starting the full cloud HTTP server.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { chromium, type Browser } from 'playwright';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ApiKeyVault, createJwt, validateJwt, resolveJwtSecret } from '../src/cloud/auth';
import { CloudSessionManager, TenantAccessError } from '../src/cloud/sessions';
import { SessionManager } from '../src/session/manager';
import { createBrowserTargetFactory } from '../src/session/target-factory';
import {
  freezeSession,
  hasFrozenManifest,
  loadFrozenManifest,
  type FrozenSessionManifest,
} from '../src/session/persist';
import { handleWriteCommand } from '../src/commands/write';
import { startTestServer } from './test-server';

// ─── Shared State ──────────────────────────────────────────────

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-cloud-test-'));
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
});

// ─── Auth: API Key Vault ───────────────────────────────────────

describe('Cloud Auth - ApiKeyVault', () => {
  let vault: ApiKeyVault;
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(tmpDir, `test-vault-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    vault = new ApiKeyVault(dbPath);
  });

  afterAll(() => {
    // Vault cleanup is best-effort — DB files removed when tmpDir is cleaned
  });

  test('create returns brw_ prefixed key', () => {
    const result = vault.create('tenant-1', 'test-key');
    expect(result.key).toMatch(/^brw_[0-9a-f]{32}$/);
    expect(result.id).toBeTruthy();
    expect(typeof result.id).toBe('string');
  });

  test('create generates unique keys per call', () => {
    const a = vault.create('tenant-1', 'key-a');
    const b = vault.create('tenant-1', 'key-b');
    expect(a.key).not.toBe(b.key);
    expect(a.id).not.toBe(b.id);
  });

  test('validate returns tenant info for valid key', () => {
    const { key } = vault.create('tenant-1', 'test-key');
    const record = vault.validate(key);

    expect(record).not.toBeNull();
    expect(record!.tenantId).toBe('tenant-1');
    expect(record!.name).toBe('test-key');
    expect(record!.permissions).toBe('*');
    expect(record!.maxSessions).toBe(10);
    expect(record!.maxConcurrent).toBe(6);
  });

  test('validate returns null for invalid key', () => {
    const record = vault.validate('brw_0000000000000000000000000000dead');
    expect(record).toBeNull();
  });

  test('validate returns null for empty string', () => {
    const record = vault.validate('');
    expect(record).toBeNull();
  });

  test('validate returns null for non-brw prefixed string', () => {
    vault.create('tenant-1', 'test-key');
    const record = vault.validate('not-a-valid-key-format');
    expect(record).toBeNull();
  });

  test('validate returns null for revoked key', () => {
    const { key, id } = vault.create('tenant-1', 'to-revoke');

    // Valid before revocation
    expect(vault.validate(key)).not.toBeNull();

    // Revoke
    vault.revoke(id);

    // Invalid after revocation
    expect(vault.validate(key)).toBeNull();
  });

  test('revoking one key does not affect another', () => {
    const a = vault.create('tenant-1', 'key-a');
    const b = vault.create('tenant-1', 'key-b');

    vault.revoke(a.id);

    expect(vault.validate(a.key)).toBeNull();
    expect(vault.validate(b.key)).not.toBeNull();
  });

  test('list shows keys without raw secrets', () => {
    vault.create('tenant-a', 'key-1');
    vault.create('tenant-b', 'key-2');

    const entries = vault.list();
    expect(entries.length).toBe(2);

    for (const entry of entries) {
      expect(entry).toHaveProperty('id');
      expect(entry).toHaveProperty('tenantId');
      expect(entry).toHaveProperty('name');
      expect(entry).toHaveProperty('createdAt');
      expect(entry).toHaveProperty('revoked');
      // No raw key or keyHash exposed
      expect(entry).not.toHaveProperty('key');
      expect(entry).not.toHaveProperty('keyHash');
    }
  });

  test('list shows revoked status correctly', () => {
    const { id } = vault.create('tenant-1', 'will-revoke');
    vault.create('tenant-1', 'will-keep');

    vault.revoke(id);

    const entries = vault.list();
    const revoked = entries.find(e => e.id === id);
    const kept = entries.find(e => e.id !== id);

    expect(revoked!.revoked).toBe(true);
    expect(kept!.revoked).toBe(false);
  });

  test('list returns all created entries', () => {
    vault.create('tenant-1', 'alpha');
    vault.create('tenant-1', 'beta');

    const entries = vault.list();
    const names = entries.map(e => e.name);
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
    expect(entries.length).toBe(2);
  });

  test('close shuts down the database', () => {
    vault.create('tenant-1', 'before-close');
    vault.close();

    // After close, operations should throw
    expect(() => vault.create('tenant-1', 'after-close')).toThrow();
  });
});

// ─── Auth: JWT ─────────────────────────────────────────────────

describe('Cloud Auth - JWT', () => {
  const secret = crypto.randomBytes(32);

  test('createJwt produces valid token with three dot-separated parts', () => {
    const token = createJwt({ tenantId: 'tenant-1', permissions: '*' }, secret);
    const parts = token.split('.');
    expect(parts.length).toBe(3);
  });

  test('createJwt / validateJwt roundtrip returns same payload', () => {
    const payload = { tenantId: 'tenant-42', permissions: 'read,write' };
    const token = createJwt(payload, secret);
    const result = validateJwt(token, secret);

    expect(result).not.toBeNull();
    expect(result!.tenantId).toBe('tenant-42');
    expect(result!.permissions).toBe('read,write');
  });

  test('validateJwt rejects tampered payload', () => {
    const token = createJwt({ tenantId: 'tenant-1', permissions: '*' }, secret);
    const parts = token.split('.');

    // Tamper with the payload — change tenantId
    const tamperedPayload = Buffer.from(
      JSON.stringify({ tenantId: 'tenant-HACKED', permissions: '*', iat: 0, exp: 9999999999 }),
    ).toString('base64url');

    const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
    expect(validateJwt(tamperedToken, secret)).toBeNull();
  });

  test('validateJwt rejects wrong secret', () => {
    const token = createJwt({ tenantId: 'tenant-1', permissions: '*' }, secret);
    const wrongSecret = crypto.randomBytes(32);
    expect(validateJwt(token, wrongSecret)).toBeNull();
  });

  test('validateJwt rejects malformed token (too few parts)', () => {
    expect(validateJwt('only.two', secret)).toBeNull();
    expect(validateJwt('single', secret)).toBeNull();
    expect(validateJwt('', secret)).toBeNull();
  });

  test('validateJwt rejects token with invalid base64 payload', () => {
    const token = createJwt({ tenantId: 'tenant-1', permissions: '*' }, secret);
    const parts = token.split('.');
    const corruptToken = `${parts[0]}.!!!notbase64!!!.${parts[2]}`;
    expect(validateJwt(corruptToken, secret)).toBeNull();
  });

  test('validateJwt rejects expired token', () => {
    // Create a token and manually construct one with exp in the past
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        tenantId: 'tenant-1',
        permissions: '*',
        iat: Math.floor(Date.now() / 1000) - 3600,
        exp: Math.floor(Date.now() / 1000) - 1800, // expired 30 minutes ago
      }),
    ).toString('base64url');

    const signingInput = `${header}.${payload}`;
    const signature = crypto
      .createHmac('sha256', secret)
      .update(signingInput, 'utf-8')
      .digest()
      .toString('base64url');

    const expiredToken = `${signingInput}.${signature}`;
    expect(validateJwt(expiredToken, secret)).toBeNull();
  });
});

// ─── Auth: resolveJwtSecret ────────────────────────────────────

describe('Cloud Auth - resolveJwtSecret', () => {
  test('auto-generates and persists key file', () => {
    const dir = path.join(tmpDir, `jwt-secret-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });

    const secret1 = resolveJwtSecret(dir);
    expect(secret1).toBeInstanceOf(Buffer);
    expect(secret1.length).toBe(32);

    // Key file should exist
    const keyPath = path.join(dir, '.cloud-jwt-key');
    expect(fs.existsSync(keyPath)).toBe(true);

    // Calling again returns the same key
    const secret2 = resolveJwtSecret(dir);
    expect(secret1.equals(secret2)).toBe(true);
  });

  test('creates parent directory if missing', () => {
    const dir = path.join(tmpDir, 'nested', 'jwt-dir', `run-${Date.now()}`);
    const secret = resolveJwtSecret(dir);
    expect(secret.length).toBe(32);
    expect(fs.existsSync(path.join(dir, '.cloud-jwt-key'))).toBe(true);
  });

  test('respects BROWSE_CLOUD_JWT_SECRET env var', () => {
    const hex = crypto.randomBytes(32).toString('hex');
    const originalEnv = process.env.BROWSE_CLOUD_JWT_SECRET;

    try {
      process.env.BROWSE_CLOUD_JWT_SECRET = hex;
      const dir = path.join(tmpDir, `jwt-env-${Date.now()}`);
      const secret = resolveJwtSecret(dir);
      expect(secret.toString('hex')).toBe(hex);
      // Should NOT create a file when env var is used
      expect(fs.existsSync(path.join(dir, '.cloud-jwt-key'))).toBe(false);
    } finally {
      if (originalEnv === undefined) {
        delete process.env.BROWSE_CLOUD_JWT_SECRET;
      } else {
        process.env.BROWSE_CLOUD_JWT_SECRET = originalEnv;
      }
    }
  });

  test('rejects env var with wrong length', () => {
    const originalEnv = process.env.BROWSE_CLOUD_JWT_SECRET;
    try {
      process.env.BROWSE_CLOUD_JWT_SECRET = 'tooshort';
      expect(() => resolveJwtSecret(tmpDir)).toThrow('64 hex characters');
    } finally {
      if (originalEnv === undefined) {
        delete process.env.BROWSE_CLOUD_JWT_SECRET;
      } else {
        process.env.BROWSE_CLOUD_JWT_SECRET = originalEnv;
      }
    }
  });
});

// ─── Cloud Sessions: Tenant Isolation ──────────────────────────

describe('Cloud Sessions - Tenant Isolation', () => {
  let browser: Browser;
  let sm: SessionManager;
  let testServer: Awaited<ReturnType<typeof startTestServer>>;
  let baseUrl: string;

  beforeAll(async () => {
    testServer = await startTestServer(0);
    baseUrl = testServer.url;

    browser = await chromium.launch({ headless: true });
    const localDir = path.join(tmpDir, 'cloud-sessions');
    sm = new SessionManager(createBrowserTargetFactory(browser), localDir);
  });

  afterAll(async () => {
    try { testServer.server.close(); } catch {}
    await sm.closeAll().catch(() => {});
    await Promise.race([
      browser.close().catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 3000)),
    ]);
  });

  test('provision creates tenant-scoped session ID', async () => {
    const cloud = new CloudSessionManager(sm, 10);
    const result = await cloud.provision('tenant-a');

    expect(result.sessionId).toMatch(/^tenant:tenant-a:session:/);
    expect(result.createdAt).toBeTruthy();
  });

  test('provision with custom sessionId uses it', async () => {
    const cloud = new CloudSessionManager(sm, 10);
    const result = await cloud.provision('tenant-custom', { sessionId: 'my-session-42' });

    expect(result.sessionId).toBe('tenant:tenant-custom:session:my-session-42');
  });

  test('cross-tenant access throws TenantAccessError via get', async () => {
    const cloud = new CloudSessionManager(sm, 10);
    const { sessionId } = await cloud.provision('tenant-owner');

    expect(() => cloud.get('tenant-attacker', sessionId)).toThrow(TenantAccessError);
  });

  test('cross-tenant access throws TenantAccessError via getOrCreate', async () => {
    const cloud = new CloudSessionManager(sm, 10);
    const { sessionId } = await cloud.provision('tenant-owner2');

    await expect(cloud.getOrCreate('tenant-attacker2', sessionId)).rejects.toThrow(TenantAccessError);
  });

  test('cross-tenant access throws TenantAccessError via terminate', async () => {
    const cloud = new CloudSessionManager(sm, 10);
    const { sessionId } = await cloud.provision('tenant-owner3');

    await expect(cloud.terminate('tenant-attacker3', sessionId)).rejects.toThrow(TenantAccessError);
  });

  test('session limit enforcement returns error when exceeded', async () => {
    const cloud = new CloudSessionManager(sm, 2);
    const tenantId = `limit-test-${Date.now()}`;

    await cloud.provision(tenantId);
    await cloud.provision(tenantId);

    // Third provision should fail
    await expect(cloud.provision(tenantId)).rejects.toThrow('Session limit reached');
  });

  test('isAtLimit returns true at limit', async () => {
    const cloud = new CloudSessionManager(sm, 1);
    const tenantId = `at-limit-${Date.now()}`;

    expect(cloud.isAtLimit(tenantId)).toBe(false);
    await cloud.provision(tenantId);
    expect(cloud.isAtLimit(tenantId)).toBe(true);
  });

  test('getSessionCount returns correct count', async () => {
    const cloud = new CloudSessionManager(sm, 10);
    const tenantId = `count-test-${Date.now()}`;

    expect(cloud.getSessionCount(tenantId)).toBe(0);
    await cloud.provision(tenantId);
    expect(cloud.getSessionCount(tenantId)).toBe(1);
    await cloud.provision(tenantId);
    expect(cloud.getSessionCount(tenantId)).toBe(2);
  });

  test('list only returns own sessions', async () => {
    const cloud = new CloudSessionManager(sm, 10);
    const tenantA = `list-a-${Date.now()}`;
    const tenantB = `list-b-${Date.now()}`;

    await cloud.provision(tenantA);
    await cloud.provision(tenantA);
    await cloud.provision(tenantB);

    const listA = cloud.list(tenantA);
    const listB = cloud.list(tenantB);

    expect(listA.length).toBe(2);
    expect(listB.length).toBe(1);

    // All entries belong to the correct tenant
    for (const entry of listA) {
      expect(entry.id).toContain(`tenant:${tenantA}:`);
    }
    for (const entry of listB) {
      expect(entry.id).toContain(`tenant:${tenantB}:`);
    }
  });

  test('terminate removes session and untracks from tenant', async () => {
    const cloud = new CloudSessionManager(sm, 10);
    const tenantId = `term-test-${Date.now()}`;

    const { sessionId } = await cloud.provision(tenantId);
    expect(cloud.getSessionCount(tenantId)).toBe(1);

    await cloud.terminate(tenantId, sessionId);
    expect(cloud.getSessionCount(tenantId)).toBe(0);
    expect(cloud.list(tenantId).length).toBe(0);
  });

  test('terminate frees session limit slot', async () => {
    const cloud = new CloudSessionManager(sm, 1);
    const tenantId = `free-slot-${Date.now()}`;

    const { sessionId } = await cloud.provision(tenantId);
    expect(cloud.isAtLimit(tenantId)).toBe(true);

    await cloud.terminate(tenantId, sessionId);
    expect(cloud.isAtLimit(tenantId)).toBe(false);

    // Can provision again
    await cloud.provision(tenantId);
    expect(cloud.isAtLimit(tenantId)).toBe(true);
  });

  test('provisioned session can execute commands', async () => {
    const cloud = new CloudSessionManager(sm, 10);
    const tenantId = `cmd-test-${Date.now()}`;

    const { sessionId } = await cloud.provision(tenantId);
    const session = cloud.get(tenantId, sessionId);

    await handleWriteCommand('goto', [baseUrl + '/basic.html'], session.manager);
    expect(session.manager.getCurrentLocation()).toContain('basic.html');
  });
});

// ─── Session Freeze / Resume Manifest ──────────────────────────

describe('Session Freeze/Resume', () => {
  let browser: Browser;
  let testServer: Awaited<ReturnType<typeof startTestServer>>;
  let baseUrl: string;

  beforeAll(async () => {
    testServer = await startTestServer(0);
    baseUrl = testServer.url;
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    try { testServer.server.close(); } catch {}
    await Promise.race([
      browser.close().catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 3000)),
    ]);
  });

  test('freezeSession captures tab URLs and settings', async () => {
    const { BrowserManager } = await import('../src/browser/manager');
    const bm = new BrowserManager();
    await bm.launchWithBrowser(browser);
    await bm.getPage().goto(baseUrl + '/basic.html', { waitUntil: 'domcontentloaded' });

    const sessionDir = path.join(tmpDir, `freeze-test-${Date.now()}`);

    const manifest = await freezeSession(
      {
        id: 'freeze-test-session',
        manager: bm,
        contextLevel: 'state',
        settleMode: false,
        domainFilter: { domains: ['example.com', '*.api.io'] },
      },
      sessionDir,
    );

    expect(manifest.version).toBe(1);
    expect(manifest.sessionId).toBe('freeze-test-session');
    expect(manifest.frozenAt).toBeTruthy();
    expect(manifest.tabUrls.length).toBeGreaterThanOrEqual(1);
    expect(manifest.tabUrls[0]).toContain('basic.html');
    expect(manifest.contextLevel).toBe('state');
    expect(manifest.settleMode).toBe(false);
    expect(manifest.allowedDomains).toEqual(['example.com', '*.api.io']);
    expect(manifest.stateFile).toBe('state.json');

    await bm.close().catch(() => {});
  });

  test('freezeSession with null domain filter', async () => {
    const { BrowserManager } = await import('../src/browser/manager');
    const bm = new BrowserManager();
    await bm.launchWithBrowser(browser);

    const sessionDir = path.join(tmpDir, `freeze-nodomain-${Date.now()}`);

    const manifest = await freezeSession(
      {
        id: 'freeze-no-domain',
        manager: bm,
        contextLevel: 'off',
        settleMode: true,
        domainFilter: null,
      },
      sessionDir,
    );

    expect(manifest.allowedDomains).toBeNull();
    expect(manifest.settleMode).toBe(true);

    await bm.close().catch(() => {});
  });

  test('freezeSession with multiple tabs', async () => {
    const { BrowserManager } = await import('../src/browser/manager');
    const bm = new BrowserManager();
    await bm.launchWithBrowser(browser);
    await bm.getPage().goto(baseUrl + '/basic.html', { waitUntil: 'domcontentloaded' });
    await bm.newTab(baseUrl + '/forms.html');

    const sessionDir = path.join(tmpDir, `freeze-multi-tabs-${Date.now()}`);

    const manifest = await freezeSession(
      {
        id: 'freeze-multi-tabs',
        manager: bm,
        contextLevel: 'delta',
        settleMode: false,
        domainFilter: null,
      },
      sessionDir,
    );

    expect(manifest.tabUrls.length).toBe(2);
    expect(manifest.tabUrls.some(u => u.includes('basic.html'))).toBe(true);
    expect(manifest.tabUrls.some(u => u.includes('forms.html'))).toBe(true);

    await bm.close().catch(() => {});
  });

  test('hasFrozenManifest detects frozen session', async () => {
    const sessionDir = path.join(tmpDir, `has-frozen-${Date.now()}`);
    fs.mkdirSync(sessionDir, { recursive: true });

    // Before writing: no manifest
    expect(hasFrozenManifest(sessionDir)).toBe(false);

    // Write a manifest
    const manifest: FrozenSessionManifest = {
      version: 1,
      sessionId: 'test-session',
      frozenAt: new Date().toISOString(),
      tabUrls: ['https://example.com'],
      activeTabIndex: 0,
      contextLevel: 'off',
      settleMode: false,
      allowedDomains: null,
      stateFile: 'state.json',
    };
    fs.writeFileSync(
      path.join(sessionDir, 'frozen-manifest.json'),
      JSON.stringify(manifest, null, 2),
    );

    // After writing: manifest exists
    expect(hasFrozenManifest(sessionDir)).toBe(true);
  });

  test('hasFrozenManifest returns false for nonexistent dir', () => {
    expect(hasFrozenManifest('/nonexistent/path/that/does/not/exist')).toBe(false);
  });

  test('loadFrozenManifest reads and validates manifest', () => {
    const sessionDir = path.join(tmpDir, `load-manifest-${Date.now()}`);
    fs.mkdirSync(sessionDir, { recursive: true });

    const manifest: FrozenSessionManifest = {
      version: 1,
      sessionId: 'load-test',
      frozenAt: new Date().toISOString(),
      tabUrls: ['https://example.com', 'https://example.com/page2'],
      activeTabIndex: 1,
      contextLevel: 'state',
      settleMode: true,
      allowedDomains: ['example.com'],
      stateFile: 'state.json',
    };
    fs.writeFileSync(
      path.join(sessionDir, 'frozen-manifest.json'),
      JSON.stringify(manifest, null, 2),
    );

    const loaded = loadFrozenManifest(sessionDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(1);
    expect(loaded!.sessionId).toBe('load-test');
    expect(loaded!.tabUrls).toEqual(['https://example.com', 'https://example.com/page2']);
    expect(loaded!.activeTabIndex).toBe(1);
    expect(loaded!.contextLevel).toBe('state');
    expect(loaded!.settleMode).toBe(true);
    expect(loaded!.allowedDomains).toEqual(['example.com']);
  });

  test('loadFrozenManifest returns null for invalid JSON', () => {
    const sessionDir = path.join(tmpDir, `load-invalid-${Date.now()}`);
    fs.mkdirSync(sessionDir, { recursive: true });

    fs.writeFileSync(
      path.join(sessionDir, 'frozen-manifest.json'),
      'this is not valid JSON {{{',
    );

    const loaded = loadFrozenManifest(sessionDir);
    expect(loaded).toBeNull();
  });

  test('loadFrozenManifest returns null for wrong version', () => {
    const sessionDir = path.join(tmpDir, `load-wrong-version-${Date.now()}`);
    fs.mkdirSync(sessionDir, { recursive: true });

    fs.writeFileSync(
      path.join(sessionDir, 'frozen-manifest.json'),
      JSON.stringify({ version: 99, sessionId: 'test', tabUrls: [] }),
    );

    const loaded = loadFrozenManifest(sessionDir);
    expect(loaded).toBeNull();
  });

  test('loadFrozenManifest returns null for missing fields', () => {
    const sessionDir = path.join(tmpDir, `load-missing-${Date.now()}`);
    fs.mkdirSync(sessionDir, { recursive: true });

    // Missing sessionId and tabUrls
    fs.writeFileSync(
      path.join(sessionDir, 'frozen-manifest.json'),
      JSON.stringify({ version: 1 }),
    );

    const loaded = loadFrozenManifest(sessionDir);
    expect(loaded).toBeNull();
  });

  test('loadFrozenManifest returns null for nonexistent dir', () => {
    const loaded = loadFrozenManifest('/nonexistent/path/xyz');
    expect(loaded).toBeNull();
  });
});
