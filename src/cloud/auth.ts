/**
 * Cloud auth — API key vault (SQLite + SHA-256) and JWT (HS256, native crypto).
 *
 * ApiKeyVault stores API keys as SHA-256 hashes in a SQLite database.
 * Keys are prefixed with `brw_` and only visible at creation time.
 * Validation uses crypto.timingSafeEqual to prevent timing attacks.
 *
 * JWT functions use native Node.js crypto (HS256) with 15-minute expiry.
 * No external JWT library required.
 */

import Database, { type Database as DatabaseType } from 'better-sqlite3';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// ─── Types ──────────────────────────────────────────────────────

export interface ApiKeyRecord {
  id: string;
  tenantId: string;
  name: string;
  permissions: string;
  maxSessions: number;
  maxConcurrent: number;
}

export interface ApiKeyListEntry {
  id: string;
  tenantId: string;
  name: string;
  createdAt: string;
  revoked: boolean;
}

export interface CreateKeyResult {
  key: string;
  id: string;
}

interface JwtPayload {
  tenantId: string;
  permissions: string;
  maxSessions?: number;
  maxConcurrent?: number;
}

interface JwtFullPayload extends JwtPayload {
  iat: number;
  exp: number;
}

// ─── Helpers ────────────────────────────────────────────────────

const JWT_EXPIRY_SECONDS = 15 * 60; // 15 minutes

function base64UrlEncode(data: string | Buffer): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
  return buf.toString('base64url');
}

function base64UrlDecode(str: string): Buffer {
  return Buffer.from(str, 'base64url');
}

export function hashApiKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey, 'utf-8').digest('hex');
}

// ─── API Key Vault ──────────────────────────────────────────────

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    keyHash TEXT NOT NULL,
    name TEXT NOT NULL,
    permissions TEXT NOT NULL DEFAULT '*',
    maxSessions INTEGER NOT NULL DEFAULT 10,
    maxConcurrent INTEGER NOT NULL DEFAULT 6,
    createdAt TEXT NOT NULL,
    revokedAt TEXT
  )
`;

export class ApiKeyVault {
  private db: DatabaseType;

  constructor(dbPath: string) {
    // Ensure parent directory exists
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(CREATE_TABLE_SQL);
  }

  /**
   * Create a new API key for a tenant.
   * Returns the raw key (only time it is visible) and the key ID.
   */
  create(tenantId: string, name: string): CreateKeyResult {
    const id = crypto.randomUUID();
    const randomHex = crypto.randomBytes(16).toString('hex'); // 32 hex chars
    const key = `brw_${randomHex}`;
    const keyHash = hashApiKey(key);
    const createdAt = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO api_keys (id, tenantId, keyHash, name, permissions, createdAt)
      VALUES (?, ?, ?, ?, '*', ?)
    `);
    stmt.run(id, tenantId, keyHash, name, createdAt);

    return { key, id };
  }

  /**
   * Validate a raw API key. Returns tenant info or null if invalid/revoked.
   * Uses timing-safe comparison to prevent timing attacks.
   */
  validate(rawKey: string): ApiKeyRecord | null {
    const candidateHash = hashApiKey(rawKey);

    // Fetch all non-revoked keys and compare with timingSafeEqual
    // We query by hash first for efficiency, then verify with timingSafeEqual
    const row = this.db.prepare(`
      SELECT id, tenantId, keyHash, name, permissions, maxSessions, maxConcurrent
      FROM api_keys
      WHERE keyHash = ? AND revokedAt IS NULL
    `).get(candidateHash) as {
      id: string;
      tenantId: string;
      keyHash: string;
      name: string;
      permissions: string;
      maxSessions: number;
      maxConcurrent: number;
    } | undefined;

    if (!row) return null;

    // Timing-safe comparison of the hash
    const storedBuf = Buffer.from(row.keyHash, 'utf-8');
    const candidateBuf = Buffer.from(candidateHash, 'utf-8');

    if (storedBuf.length !== candidateBuf.length) return null;
    if (!crypto.timingSafeEqual(storedBuf, candidateBuf)) return null;

    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      permissions: row.permissions,
      maxSessions: row.maxSessions,
      maxConcurrent: row.maxConcurrent,
    };
  }

  /**
   * Revoke an API key by ID. Sets revokedAt timestamp.
   */
  revoke(id: string): void {
    const revokedAt = new Date().toISOString();
    this.db.prepare(`UPDATE api_keys SET revokedAt = ? WHERE id = ?`).run(revokedAt, id);
  }

  /**
   * List all API keys (no secrets exposed).
   */
  list(): ApiKeyListEntry[] {
    const rows = this.db.prepare(`
      SELECT id, tenantId, name, createdAt, revokedAt
      FROM api_keys
      ORDER BY createdAt DESC
    `).all() as Array<{
      id: string;
      tenantId: string;
      name: string;
      createdAt: string;
      revokedAt: string | null;
    }>;

    return rows.map(row => ({
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      createdAt: row.createdAt,
      revoked: row.revokedAt !== null,
    }));
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }
}

// ─── JWT (HS256, native crypto) ─────────────────────────────────

/**
 * Create a JWT with HS256 signing.
 * Payload includes tenantId, permissions, iat, and exp (15-minute expiry).
 */
export function createJwt(payload: JwtPayload, secret: Buffer): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);

  const fullPayload: JwtFullPayload = {
    ...payload,
    iat: now,
    exp: now + JWT_EXPIRY_SECONDS,
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(fullPayload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const signature = crypto
    .createHmac('sha256', secret)
    .update(signingInput, 'utf-8')
    .digest();

  return `${signingInput}.${base64UrlEncode(signature)}`;
}

/**
 * Validate a JWT token. Returns the payload or null if invalid/expired.
 * Uses timing-safe comparison for signature verification.
 */
export function validateJwt(token: string, secret: Buffer): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;

  // Verify signature with timing-safe comparison
  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(signingInput, 'utf-8')
    .digest();

  const actualSig = base64UrlDecode(signatureB64);

  if (expectedSig.length !== actualSig.length) return null;
  if (!crypto.timingSafeEqual(expectedSig, actualSig)) return null;

  // Decode and validate payload
  let payload: JwtFullPayload;
  try {
    const decoded = base64UrlDecode(payloadB64).toString('utf-8');
    payload = JSON.parse(decoded) as JwtFullPayload;
  } catch {
    return null;
  }

  // Check expiry
  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp <= now) return null;

  // Validate required fields
  if (typeof payload.tenantId !== 'string' || typeof payload.permissions !== 'string') {
    return null;
  }

  return {
    tenantId: payload.tenantId,
    permissions: payload.permissions,
  };
}

/**
 * Resolve the JWT signing secret.
 * Reads from BROWSE_CLOUD_JWT_SECRET env var (64-char hex = 32 bytes)
 * or auto-generates and stores at <localDir>/.cloud-jwt-key.
 */
export function resolveJwtSecret(localDir: string): Buffer {
  const envSecret = process.env.BROWSE_CLOUD_JWT_SECRET;
  if (envSecret) {
    if (envSecret.length !== 64) {
      throw new Error('BROWSE_CLOUD_JWT_SECRET must be 64 hex characters (32 bytes)');
    }
    return Buffer.from(envSecret, 'hex');
  }

  const keyPath = path.join(localDir, '.cloud-jwt-key');
  if (fs.existsSync(keyPath)) {
    const hex = fs.readFileSync(keyPath, 'utf-8').trim();
    return Buffer.from(hex, 'hex');
  }

  // Auto-generate and persist
  fs.mkdirSync(localDir, { recursive: true });
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, key.toString('hex') + '\n', { mode: 0o600 });
  return key;
}
