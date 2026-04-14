/**
 * Proxy providers — pluggable proxy credential shaping and capability declaration.
 * Each provider knows how to build usernames for sticky sessions.
 */

export interface SessionOptions {
  country?: string;
  state?: string;
  city?: string;
  zip?: string;
  sessionId?: string;
  sessionDurationMinutes?: number;
}

export interface ProxyProvider {
  name: string;
  canRotateSessions: boolean;
  launchRetries: number;
  launchTimeoutMs: number;
  buildSessionUsername(baseUsername: string, options?: SessionOptions): string;
}

function sanitizeValue(value: string | undefined): string {
  if (!value) return '';
  return String(value).trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
}

/** Decodo residential proxy provider. Username DSL: user-{base}-country-{cc}-session-{id} */
export const decodoProvider: ProxyProvider = {
  name: 'decodo',
  canRotateSessions: true,
  launchRetries: 10,
  launchTimeoutMs: 180_000,
  buildSessionUsername(baseUsername, options = {}) {
    const username = sanitizeValue(baseUsername);
    if (!username) return '';
    const parts = [`user-${username}`];
    const country = sanitizeValue(options.country);
    const state = sanitizeValue(options.state);
    const city = sanitizeValue(options.city);
    const sessionId = sanitizeValue(options.sessionId);
    const duration = options.sessionDurationMinutes;
    if (country) parts.push(`country-${country}`);
    if (state) parts.push(`state-${state}`);
    if (city) parts.push(`city-${city}`);
    if (sessionId) parts.push(`session-${sessionId}`);
    if (duration && Number.isFinite(duration)) parts.push(`sessionduration-${Math.max(1, Math.min(1440, Math.trunc(duration)))}`);
    return parts.join('-');
  },
};

/** Generic backconnect provider — pass-through username with session suffix. */
export const genericProvider: ProxyProvider = {
  name: 'generic',
  canRotateSessions: true,
  launchRetries: 5,
  launchTimeoutMs: 120_000,
  buildSessionUsername(baseUsername, options = {}) {
    const base = String(baseUsername || '').trim();
    const sessionId = options?.sessionId ? `-${String(options.sessionId).trim()}` : '';
    return `${base}${sessionId}`;
  },
};

const providers: Record<string, ProxyProvider> = {
  decodo: decodoProvider,
  generic: genericProvider,
};

export function getProvider(name: string): ProxyProvider | null {
  return providers[name] || null;
}

export function registerProvider(name: string, provider: ProxyProvider): void {
  providers[name] = provider;
}

/** Decode percent-encoded proxy credentials for Playwright compatibility. */
export function normalizePlaywrightProxy(proxy: { server: string; username?: string; password?: string }): typeof proxy {
  if (!proxy) return proxy;
  return {
    ...proxy,
    username: proxy.username ? decodeURIComponent(proxy.username) : proxy.username,
    password: proxy.password ? decodeURIComponent(proxy.password) : proxy.password,
  };
}
