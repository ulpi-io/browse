import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export function resolveEncryptionKey(localDir: string): Buffer {
  const envKey = process.env.BROWSE_ENCRYPTION_KEY;
  if (envKey) {
    if (envKey.length !== 64) {
      throw new Error('BROWSE_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
    }
    return Buffer.from(envKey, 'hex');
  }

  const keyPath = path.join(localDir, '.encryption-key');
  if (fs.existsSync(keyPath)) {
    const hex = fs.readFileSync(keyPath, 'utf-8').trim();
    return Buffer.from(hex, 'hex');
  }

  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, key.toString('hex') + '\n', { mode: 0o600 });
  return key;
}

export function encrypt(plaintext: string, key: Buffer): { ciphertext: string; iv: string; authTag: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

export function decrypt(ciphertext: string, iv: string, authTag: string, key: Buffer): string {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf-8');
}
