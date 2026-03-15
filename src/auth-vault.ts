/**
 * Credential vault — AES-256-GCM encrypted credential storage
 *
 * Encryption key: BROWSE_ENCRYPTION_KEY env var (64-char hex)
 * or auto-generated at .browse/.encryption-key
 *
 * Storage: .browse/auth/<name>.json (mode 0o600)
 * Password never returned in list/get — only hasPassword: true
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { BrowserManager } from './browser-manager';
import { DEFAULTS } from './constants';
import { sanitizeName } from './sanitize';

interface StoredCredential {
  name: string;
  url: string;
  username: string;
  encrypted: true;
  iv: string;       // base64
  authTag: string;  // base64
  data: string;     // base64 (encrypted password)
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CredentialInfo {
  name: string;
  url: string;
  username: string;
  hasPassword: boolean;
  createdAt: string;
}

export class AuthVault {
  private authDir: string;
  private encryptionKey: Buffer;

  constructor(localDir: string) {
    this.authDir = path.join(localDir, 'auth');
    this.encryptionKey = this.resolveKey(localDir);
  }

  private resolveKey(localDir: string): Buffer {
    // 1. Env var (64-char hex = 32 bytes)
    const envKey = process.env.BROWSE_ENCRYPTION_KEY;
    if (envKey) {
      if (envKey.length !== 64) {
        throw new Error('BROWSE_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
      }
      return Buffer.from(envKey, 'hex');
    }

    // 2. Key file
    const keyPath = path.join(localDir, '.encryption-key');
    if (fs.existsSync(keyPath)) {
      const hex = fs.readFileSync(keyPath, 'utf-8').trim();
      return Buffer.from(hex, 'hex');
    }

    // 3. Auto-generate
    const key = crypto.randomBytes(32);
    fs.writeFileSync(keyPath, key.toString('hex') + '\n', { mode: 0o600 });
    return key;
  }

  private encrypt(plaintext: string): { ciphertext: string; iv: string; authTag: string } {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    return {
      ciphertext: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
    };
  }

  private decrypt(ciphertext: string, iv: string, authTag: string): string {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      Buffer.from(iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(authTag, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final(),
    ]);
    return decrypted.toString('utf-8');
  }

  save(
    name: string,
    url: string,
    username: string,
    password: string,
    selectors?: { username?: string; password?: string; submit?: string },
  ): void {
    fs.mkdirSync(this.authDir, { recursive: true });

    const { ciphertext, iv, authTag } = this.encrypt(password);
    const now = new Date().toISOString();

    const credential: StoredCredential = {
      name,
      url,
      username,
      encrypted: true,
      iv,
      authTag,
      data: ciphertext,
      usernameSelector: selectors?.username,
      passwordSelector: selectors?.password,
      submitSelector: selectors?.submit,
      createdAt: now,
      updatedAt: now,
    };

    const filePath = path.join(this.authDir, `${sanitizeName(name)}.json`);
    fs.writeFileSync(filePath, JSON.stringify(credential, null, 2), { mode: 0o600 });
  }

  private load(name: string): StoredCredential {
    const filePath = path.join(this.authDir, `${sanitizeName(name)}.json`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Credential "${name}" not found. Run "browse auth list" to see saved credentials.`);
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }

  async login(name: string, bm: BrowserManager): Promise<string> {
    const cred = this.load(name);
    const password = this.decrypt(cred.data, cred.iv, cred.authTag);
    const page = bm.getPage();

    // Navigate to login URL
    await page.goto(cred.url, {
      waitUntil: 'domcontentloaded',
      timeout: DEFAULTS.COMMAND_TIMEOUT_MS,
    });

    // Resolve selectors: use stored or auto-detect
    const userSel = cred.usernameSelector || await autoDetectSelector(page, 'username');
    const passSel = cred.passwordSelector || await autoDetectSelector(page, 'password');
    const submitSel = cred.submitSelector || await autoDetectSelector(page, 'submit');

    // Fill credentials
    await page.fill(userSel, cred.username, { timeout: DEFAULTS.ACTION_TIMEOUT_MS });
    await page.fill(passSel, password, { timeout: DEFAULTS.ACTION_TIMEOUT_MS });

    // Submit
    await page.click(submitSel, { timeout: DEFAULTS.ACTION_TIMEOUT_MS });
    await page.waitForLoadState('domcontentloaded').catch(() => {});

    return `Logged in as ${cred.username} at ${page.url()}`;
  }

  list(): CredentialInfo[] {
    if (!fs.existsSync(this.authDir)) return [];

    const files = fs.readdirSync(this.authDir).filter(f => f.endsWith('.json'));
    return files.map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(this.authDir, f), 'utf-8'));
        return {
          name: data.name,
          url: data.url,
          username: data.username,
          hasPassword: true,
          createdAt: data.createdAt,
        };
      } catch {
        return null;
      }
    }).filter(Boolean) as CredentialInfo[];
  }

  delete(name: string): void {
    const filePath = path.join(this.authDir, `${sanitizeName(name)}.json`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Credential "${name}" not found.`);
    }
    fs.unlinkSync(filePath);
  }
}

/**
 * Auto-detect login form selectors by common patterns.
 */
async function autoDetectSelector(page: any, field: 'username' | 'password' | 'submit'): Promise<string> {
  if (field === 'username') {
    const candidates = [
      'input[type="email"]',
      'input[name="email"]',
      'input[name="username"]',
      'input[name="user"]',
      'input[name="login"]',
      'input[autocomplete="username"]',
      'input[autocomplete="email"]',
      'input[type="text"]:first-of-type',
    ];
    for (const sel of candidates) {
      const count = await page.locator(sel).count();
      if (count > 0) return sel;
    }
    throw new Error('Could not auto-detect username field. Save with explicit selectors: browse auth save <name> <url> <user> <pass> --user-sel <sel> --pass-sel <sel> --submit-sel <sel>');
  }

  if (field === 'password') {
    const candidates = [
      'input[type="password"]',
      'input[name="password"]',
      'input[name="pass"]',
      'input[autocomplete="current-password"]',
    ];
    for (const sel of candidates) {
      const count = await page.locator(sel).count();
      if (count > 0) return sel;
    }
    throw new Error('Could not auto-detect password field.');
  }

  // submit
  const candidates = [
    'button[type="submit"]',
    'input[type="submit"]',
    'form button',
    'button:has-text("Log in")',
    'button:has-text("Sign in")',
    'button:has-text("Login")',
    'button:has-text("Submit")',
  ];
  for (const sel of candidates) {
    const count = await page.locator(sel).count();
    if (count > 0) return sel;
  }
  throw new Error('Could not auto-detect submit button.');
}
