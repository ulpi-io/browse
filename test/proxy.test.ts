/**
 * Unit tests for the proxy pool system.
 *
 * Tests cover:
 *   - ProxyProvider implementations (decodo, generic)
 *   - Provider registry (getProvider, registerProvider)
 *   - normalizePlaywrightProxy credential decoding
 *   - ProxyPool round-robin strategy (port cycling, launch proxy)
 *   - ProxyPool backconnect strategy (session rotation, provider wiring)
 *   - Missing/invalid config returns null
 */

import { describe, test, expect } from 'vitest';
import {
  decodoProvider,
  genericProvider,
  getProvider,
  registerProvider,
  normalizePlaywrightProxy,
} from '../src/proxy/providers';
import { createProxyPool } from '../src/proxy/pool';

describe('Proxy Providers', () => {
  test('decodoProvider builds session username with full options', () => {
    const result = decodoProvider.buildSessionUsername('myuser', {
      country: 'us',
      state: 'california',
      sessionId: 'abc123',
      sessionDurationMinutes: 30,
    });
    expect(result).toContain('user-myuser');
    expect(result).toContain('country-us');
    expect(result).toContain('state-california');
    expect(result).toContain('session-abc123');
    expect(result).toContain('sessionduration-30');
  });

  test('decodoProvider sanitizes special characters', () => {
    const result = decodoProvider.buildSessionUsername('my user!', { country: 'U.S.' });
    expect(result).not.toContain(' ');
    expect(result).not.toContain('!');
    expect(result).not.toContain('.');
  });

  test('decodoProvider declares correct capabilities', () => {
    expect(decodoProvider.canRotateSessions).toBe(true);
    expect(decodoProvider.launchRetries).toBe(10);
    expect(decodoProvider.launchTimeoutMs).toBe(180_000);
  });

  test('genericProvider passes through username with session suffix', () => {
    const result = genericProvider.buildSessionUsername('user', { sessionId: 'abc' });
    expect(result).toBe('user-abc');
  });

  test('genericProvider without session', () => {
    const result = genericProvider.buildSessionUsername('user');
    expect(result).toBe('user');
  });

  test('getProvider returns known providers', () => {
    expect(getProvider('decodo')).toBe(decodoProvider);
    expect(getProvider('generic')).toBe(genericProvider);
  });

  test('getProvider returns null for unknown', () => {
    expect(getProvider('unknown')).toBeNull();
  });

  test('registerProvider adds custom provider', () => {
    const custom = { ...genericProvider, name: 'custom' };
    registerProvider('test-custom', custom);
    expect(getProvider('test-custom')).toBe(custom);
  });

  test('normalizePlaywrightProxy decodes percent-encoded credentials', () => {
    const result = normalizePlaywrightProxy({
      server: 'http://proxy:8080',
      username: 'user%40example.com',
      password: 'p%40ss',
    });
    expect(result.username).toBe('user@example.com');
    expect(result.password).toBe('p@ss');
    expect(result.server).toBe('http://proxy:8080');
  });

  test('normalizePlaywrightProxy handles undefined credentials', () => {
    const result = normalizePlaywrightProxy({ server: 'http://proxy:8080' });
    expect(result.username).toBeUndefined();
    expect(result.password).toBeUndefined();
  });
});

describe('Proxy Pool - Round Robin', () => {
  test('createProxyPool round_robin returns pool with correct mode and size', () => {
    const pool = createProxyPool({
      strategy: 'round_robin',
      host: '10.0.0.1',
      ports: [10001, 10002, 10003],
      username: 'user',
      password: 'pass',
    });
    expect(pool).not.toBeNull();
    expect(pool!.mode).toBe('round_robin');
    expect(pool!.size).toBe(3);
    expect(pool!.canRotateSessions).toBe(false);
  });

  test('round robin getNext cycles through ports', () => {
    const pool = createProxyPool({
      strategy: 'round_robin',
      host: '10.0.0.1',
      ports: [10001, 10002],
      username: 'user',
      password: 'pass',
    })!;
    const p1 = pool.getNext();
    const p2 = pool.getNext();
    const p3 = pool.getNext();
    expect(p1.server).toContain('10001');
    expect(p2.server).toContain('10002');
    expect(p3.server).toContain('10001'); // wraps
  });

  test('round robin getLaunchProxy returns first port', () => {
    const pool = createProxyPool({
      strategy: 'round_robin',
      host: '10.0.0.1',
      ports: [10001, 10002],
      username: 'user',
      password: 'pass',
    })!;
    expect(pool.getLaunchProxy().server).toContain('10001');
  });
});

describe('Proxy Pool - Backconnect', () => {
  test('createProxyPool backconnect returns pool with correct mode', () => {
    const pool = createProxyPool({
      strategy: 'backconnect',
      backconnectHost: 'gate.proxy.com',
      backconnectPort: 7000,
      username: 'user',
      password: 'pass',
    });
    expect(pool).not.toBeNull();
    expect(pool!.mode).toBe('backconnect');
    expect(pool!.canRotateSessions).toBe(true);
  });

  test('backconnect getNext creates unique session IDs', () => {
    const pool = createProxyPool({
      strategy: 'backconnect',
      backconnectHost: 'gate.proxy.com',
      backconnectPort: 7000,
      username: 'user',
      password: 'pass',
    })!;
    const p1 = pool.getNext();
    const p2 = pool.getNext();
    expect(p1.sessionId).not.toBe(p2.sessionId);
  });

  test('backconnect uses decodo provider by default', () => {
    const pool = createProxyPool({
      strategy: 'backconnect',
      backconnectHost: 'gate.proxy.com',
      backconnectPort: 7000,
      username: 'user',
      password: 'pass',
    })!;
    expect(pool.provider?.name).toBe('decodo');
  });

  test('backconnect with explicit session ID', () => {
    const pool = createProxyPool({
      strategy: 'backconnect',
      backconnectHost: 'gate.proxy.com',
      backconnectPort: 7000,
      username: 'user',
      password: 'pass',
    })!;
    const p = pool.getNext('my-session');
    // decodo sanitizeValue converts hyphens to underscores
    expect(p.username).toContain('session-my_session');
    expect(p.sessionId).toBe('my-session');
  });
});

describe('Proxy Pool - Missing Config', () => {
  test('round_robin without host returns null', () => {
    expect(createProxyPool({ strategy: 'round_robin', ports: [10001] })).toBeNull();
  });

  test('round_robin without ports returns null', () => {
    expect(createProxyPool({ strategy: 'round_robin', host: '10.0.0.1' })).toBeNull();
  });

  test('backconnect without host returns null', () => {
    expect(createProxyPool({
      strategy: 'backconnect',
      backconnectPort: 7000,
      username: 'user',
      password: 'pass',
    })).toBeNull();
  });

  test('backconnect without credentials returns null', () => {
    expect(createProxyPool({
      strategy: 'backconnect',
      backconnectHost: 'gate.proxy.com',
      backconnectPort: 7000,
    })).toBeNull();
  });
});
