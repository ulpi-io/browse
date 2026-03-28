#!/usr/bin/env node
/**
 * Guard script: fails if deprecated root-shim imports are found in src/ or test/.
 *
 * Only flags imports that resolve to ROOT-LEVEL shim files (src/<name>.ts).
 * Intra-domain imports (e.g., src/network/har.ts importing ./buffers) are fine.
 *
 * Usage: node scripts/check-legacy-imports.mjs
 * Exit code: 0 = clean, 1 = violations found
 */

import { execSync } from 'child_process';
import * as path from 'path';

const DEPRECATED_MODULES = [
  'buffers', 'har', 'session-manager', 'session-persist', 'encryption',
  'domain-filter', 'policy', 'auth-vault', 'sanitize', 'runtime',
  'chrome-discover', 'cloud-providers', 'record-export', 'snapshot',
  'react-devtools', 'mcp-tools',
];

// Files allowed to reference deprecated paths (top-level entry points during migration)
const ALLOWLIST = new Set([
  // Top-level entry points — no shim files remain
  'src/cli.ts',
]);

const deprecatedSet = new Set(DEPRECATED_MODULES);

/**
 * Check if an import from a given file resolves to a root-level shim.
 * Returns true if the import path would resolve to src/<deprecated>.ts
 */
function isRootShimImport(filePath, importPath) {
  // Remove quotes and 'from' prefix
  const cleaned = importPath.replace(/['"]/g, '');

  // Get the directory of the importing file
  const dir = path.dirname(filePath);

  // Resolve the import path relative to the importing file
  const resolved = path.normalize(path.join(dir, cleaned));

  // Check if it resolves to src/<deprecated-module>
  const basename = path.basename(resolved);
  const parent = path.dirname(resolved);

  // It's a root-shim import if the resolved path is at src/<deprecated>
  return parent === 'src' && deprecatedSet.has(basename);
}

let violations = [];

try {
  // Find all imports of potentially-deprecated module names
  const pattern = DEPRECATED_MODULES.map(m => m.replace(/-/g, '\\-')).join('|');
  const result = execSync(
    `grep -rn --include='*.ts' -E "from '.*/(${pattern})'" src/ test/ 2>/dev/null || true`,
    { encoding: 'utf-8' }
  );

  for (const line of result.split('\n').filter(Boolean)) {
    const colonIdx = line.indexOf(':');
    const secondColon = line.indexOf(':', colonIdx + 1);
    const filePath = line.substring(0, colonIdx);
    const relPath = filePath.replace(/^\.\//, '');

    // Skip allowlisted files
    if (ALLOWLIST.has(relPath)) continue;

    // Extract the import path
    const importMatch = line.match(/from\s+['"]([^'"]+)['"]/);
    if (!importMatch) continue;

    const importPath = importMatch[1];

    // Check if this resolves to a root-level shim
    if (isRootShimImport(relPath, importPath)) {
      violations.push(line);
    }
  }
} catch {
  // grep returned no matches — clean
}

if (violations.length > 0) {
  console.error('Legacy import violations found:');
  for (const v of violations) {
    console.error(`  ${v}`);
  }
  console.error(`\n${violations.length} violation(s). Update imports to use domain paths.`);
  process.exit(1);
} else {
  console.log('No legacy import violations found.');
  process.exit(0);
}
