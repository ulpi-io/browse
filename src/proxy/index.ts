/**
 * Proxy module — proxy pool, providers, and configuration.
 */

export { type ProxyProvider, type SessionOptions, decodoProvider, genericProvider, getProvider, registerProvider, normalizePlaywrightProxy } from './providers';
export { type ProxyPool, type ProxyPoolConfig, type ProxyConfig, createProxyPool, buildProxyUrl } from './pool';
