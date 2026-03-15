/**
 * Sanitize a user-supplied name for safe use in file paths.
 * Strips path separators and parent directory references.
 */
export function sanitizeName(name: string): string {
  const sanitized = name.replace(/[\/\\]/g, '_').replace(/\.\./g, '_');
  if (!sanitized || /^[._]+$/.test(sanitized)) {
    throw new Error(`Invalid name: "${name}"`);
  }
  return sanitized;
}
