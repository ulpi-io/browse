/**
 * Cloud browser providers — encrypted API key vault + provider implementations.
 *
 * Supports Browserless (direct WebSocket) and Browserbase (REST API + CDP).
 * API keys stored encrypted in .browse/providers/ — never visible to agents.
 */

import * as fs from 'fs';
import * as path from 'path';
import { resolveEncryptionKey, encrypt, decrypt } from '../session/encryption';
import { sanitizeName } from '../security/sanitize';

// ─── Provider Interface ──────────────────────────────

interface ProviderResult {
  cdpUrl: string;
  sessionId?: string;  // for cleanup on shutdown
}

interface CloudProvider {
  name: string;
  getCdpUrl(apiKey: string): Promise<ProviderResult>;
  cleanup?(apiKey: string, sessionId: string): Promise<void>;
}

// ─── Provider Implementations ────────────────────────

const providers: Record<string, CloudProvider> = {
  browserless: {
    name: 'Browserless',
    async getCdpUrl(token) {
      const baseUrl = process.env.BROWSERLESS_URL || 'wss://production-sfo.browserless.io';
      return { cdpUrl: `${baseUrl}?token=${token}` };
    },
  },

  browserbase: {
    name: 'Browserbase',
    async getCdpUrl(apiKey) {
      const projectId = process.env.BROWSERBASE_PROJECT_ID;
      if (!projectId) {
        throw new Error(
          'BROWSERBASE_PROJECT_ID env var required.\n' +
          'Find it at https://browserbase.com/settings'
        );
      }
      const res = await fetch('https://api.browserbase.com/v1/sessions', {
        method: 'POST',
        headers: { 'x-bb-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Browserbase API error ${res.status}: ${body}`);
      }
      const session = await res.json() as { id: string; connectUrl: string };
      return { cdpUrl: session.connectUrl, sessionId: session.id };
    },
    async cleanup(apiKey, sessionId) {
      await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}`, {
        method: 'POST',
        headers: { 'x-bb-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'REQUEST_RELEASE' }),
      }).catch(() => {});
    },
  },
};

export function getProvider(name: string): CloudProvider {
  const provider = providers[name];
  if (!provider) {
    throw new Error(
      `Unknown provider: "${name}". Available: ${Object.keys(providers).join(', ')}`
    );
  }
  return provider;
}

export function listProviderNames(): string[] {
  return Object.keys(providers);
}

// ─── Provider Vault (Encrypted Key Storage) ──────────

interface StoredProviderKey {
  name: string;
  encrypted: true;
  iv: string;
  authTag: string;
  data: string;
  createdAt: string;
}

export class ProviderVault {
  private dir: string;
  private encryptionKey: Buffer;

  constructor(localDir: string) {
    this.dir = path.join(localDir, 'providers');
    this.encryptionKey = resolveEncryptionKey(localDir);
  }

  save(name: string, apiKey: string): void {
    // Validate provider exists
    getProvider(name);

    fs.mkdirSync(this.dir, { recursive: true });
    const { ciphertext, iv, authTag } = encrypt(apiKey, this.encryptionKey);
    const stored: StoredProviderKey = {
      name,
      encrypted: true,
      iv,
      authTag,
      data: ciphertext,
      createdAt: new Date().toISOString(),
    };
    const filePath = path.join(this.dir, `${sanitizeName(name)}.json`);
    fs.writeFileSync(filePath, JSON.stringify(stored, null, 2), { mode: 0o600 });
  }

  load(name: string): string {
    const filePath = path.join(this.dir, `${sanitizeName(name)}.json`);
    if (!fs.existsSync(filePath)) {
      throw new Error(
        `No API key saved for "${name}". Run: browse provider save ${name} <api-key>`
      );
    }
    const stored: StoredProviderKey = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return decrypt(stored.data, stored.iv, stored.authTag, this.encryptionKey);
  }

  list(): Array<{ name: string; createdAt: string }> {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const stored: StoredProviderKey = JSON.parse(
          fs.readFileSync(path.join(this.dir, f), 'utf-8')
        );
        return { name: stored.name, createdAt: stored.createdAt };
      });
  }

  delete(name: string): void {
    const filePath = path.join(this.dir, `${sanitizeName(name)}.json`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`No saved key for "${name}"`);
    }
    fs.unlinkSync(filePath);
  }
}

// ─── High-level: resolve provider CDP URL ────────────

export async function resolveProviderCdpUrl(
  providerName: string,
  localDir: string,
): Promise<ProviderResult & { apiKey: string; providerName: string }> {
  const vault = new ProviderVault(localDir);
  const apiKey = vault.load(providerName);
  const provider = getProvider(providerName);
  const result = await provider.getCdpUrl(apiKey);
  return { ...result, apiKey, providerName };
}

export async function cleanupProvider(
  providerName: string,
  apiKey: string,
  sessionId: string,
): Promise<void> {
  const provider = getProvider(providerName);
  if (provider.cleanup) {
    await provider.cleanup(apiKey, sessionId);
  }
}
