/**
 * Proxy pool — assigns different proxies to different browser contexts.
 * Supports round-robin (fixed port list) and backconnect (sticky sessions via provider).
 */

import { getProvider, normalizePlaywrightProxy, type ProxyProvider } from './providers';
import * as crypto from 'crypto';

export interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
  sessionId?: string;
}

export interface ProxyPoolConfig {
  strategy: 'round_robin' | 'backconnect';
  host?: string;
  ports?: number[];
  username?: string;
  password?: string;
  backconnectHost?: string;
  backconnectPort?: number;
  providerName?: string;
  country?: string;
  state?: string;
  city?: string;
  sessionDurationMinutes?: number;
}

export interface ProxyPool {
  mode: 'round_robin' | 'backconnect';
  provider: ProxyProvider | null;
  canRotateSessions: boolean;
  launchRetries: number;
  launchTimeoutMs: number;
  size: number;
  getLaunchProxy(sessionId?: string): ProxyConfig;
  getNext(sessionId?: string): ProxyConfig;
}

function makeSessionId(prefix = 'sess'): string {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/**
 * Create a proxy pool from configuration. Returns null if required fields are missing.
 */
export function createProxyPool(config: ProxyPoolConfig): ProxyPool | null {
  const { strategy, host, ports, username, password, backconnectHost, backconnectPort, providerName } = config;

  if (strategy === 'backconnect') {
    if (!backconnectHost || !backconnectPort || !username || !password) return null;
    const provider = getProvider(providerName || 'decodo') || getProvider('decodo')!;

    return {
      mode: 'backconnect',
      provider,
      canRotateSessions: provider.canRotateSessions,
      launchRetries: provider.launchRetries,
      launchTimeoutMs: provider.launchTimeoutMs,
      size: 1,
      getLaunchProxy(sessionId = makeSessionId('browser')) {
        const builtUsername = provider.buildSessionUsername(username, { ...config, sessionId });
        return { server: `http://${backconnectHost}:${backconnectPort}`, username: builtUsername, password, sessionId };
      },
      getNext(sessionId = makeSessionId('ctx')) {
        const builtUsername = provider.buildSessionUsername(username, { ...config, sessionId });
        return { server: `http://${backconnectHost}:${backconnectPort}`, username: builtUsername, password, sessionId };
      },
    };
  }

  // round_robin
  if (!host || !ports || ports.length === 0) return null;
  let index = 0;

  return {
    mode: 'round_robin',
    provider: null,
    canRotateSessions: false,
    launchRetries: 1,
    launchTimeoutMs: 60_000,
    size: ports.length,
    getLaunchProxy() {
      return { server: `http://${host}:${ports[0]}`, username, password };
    },
    getNext() {
      const port = ports[index % ports.length];
      index++;
      return { server: `http://${host}:${port}`, username, password };
    },
  };
}

/**
 * Build a proxy URL string (http://user:pass@host:port) for CLI tools.
 */
export function buildProxyUrl(pool: ProxyPool, config: ProxyPoolConfig): string | null {
  if (!pool) return null;
  if (pool.mode === 'backconnect') {
    const proxy = pool.getLaunchProxy(makeSessionId('url'));
    if (!proxy.username || !config.password) return null;
    return `http://${encodeURIComponent(proxy.username)}:${encodeURIComponent(config.password)}@${config.backconnectHost}:${config.backconnectPort}`;
  }
  if (!config.host || !config.ports?.length) return null;
  const auth = config.username ? `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password || '')}@` : '';
  return `http://${auth}${config.host}:${config.ports[0]}`;
}
