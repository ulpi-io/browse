/**
 * browse install-skill — install the browse Claude Code skill into a project
 *
 * Copies SKILL.md to .claude/skills/browse/SKILL.md
 * and adds browse permission rules to .claude/settings.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const PERMISSIONS = [
  'Bash(browse:*)',
  'Bash(browse goto:*)', 'Bash(browse back:*)', 'Bash(browse forward:*)',
  'Bash(browse reload:*)', 'Bash(browse url:*)', 'Bash(browse text:*)',
  'Bash(browse html:*)', 'Bash(browse links:*)', 'Bash(browse forms:*)',
  'Bash(browse accessibility:*)', 'Bash(browse snapshot:*)',
  'Bash(browse snapshot-diff:*)', 'Bash(browse click:*)',
  'Bash(browse fill:*)', 'Bash(browse select:*)', 'Bash(browse hover:*)',
  'Bash(browse type:*)', 'Bash(browse press:*)', 'Bash(browse scroll:*)',
  'Bash(browse wait:*)', 'Bash(browse viewport:*)', 'Bash(browse upload:*)',
  'Bash(browse dialog-accept:*)', 'Bash(browse dialog-dismiss:*)',
  'Bash(browse js:*)', 'Bash(browse eval:*)', 'Bash(browse css:*)',
  'Bash(browse attrs:*)', 'Bash(browse state:*)', 'Bash(browse dialog:*)',
  'Bash(browse console:*)', 'Bash(browse network:*)',
  'Bash(browse cookies:*)', 'Bash(browse storage:*)', 'Bash(browse perf:*)',
  'Bash(browse devices:*)', 'Bash(browse emulate:*)',
  'Bash(browse screenshot:*)', 'Bash(browse pdf:*)',
  'Bash(browse responsive:*)', 'Bash(browse diff:*)',
  'Bash(browse chain:*)', 'Bash(browse tabs:*)', 'Bash(browse tab:*)',
  'Bash(browse newtab:*)', 'Bash(browse closetab:*)',
  'Bash(browse sessions:*)', 'Bash(browse session-close:*)',
  'Bash(browse status:*)', 'Bash(browse stop:*)', 'Bash(browse restart:*)',
  'Bash(browse cookie:*)', 'Bash(browse header:*)',
  'Bash(browse useragent:*)',
];

export function installSkill(targetDir?: string) {
  const dir = targetDir || process.cwd();

  const hasGit = fs.existsSync(path.join(dir, '.git'));
  const hasClaude = fs.existsSync(path.join(dir, '.claude'));
  if (!hasGit && !hasClaude) {
    console.error(`Not a project root: ${dir}`);
    console.error('Run from a directory with .git or .claude, or pass the path as an argument.');
    process.exit(1);
  }

  // 1. Copy all skill .md files (SKILL.md + supporting reference files)
  const skillDir = path.join(dir, '.claude', 'skills', 'browse');
  fs.mkdirSync(skillDir, { recursive: true });

  const skillSourceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skill');

  if (!fs.existsSync(skillSourceDir)) {
    console.error(`Skill directory not found at ${skillSourceDir}`);
    console.error('Is @ulpi/browse installed correctly?');
    process.exit(1);
  }

  const mdFiles = fs.readdirSync(skillSourceDir).filter(f => f.endsWith('.md'));
  if (mdFiles.length === 0) {
    console.error(`No .md files found in ${skillSourceDir}`);
    process.exit(1);
  }

  for (const file of mdFiles) {
    fs.copyFileSync(path.join(skillSourceDir, file), path.join(skillDir, file));
    console.log(`Skill installed: ${path.relative(dir, path.join(skillDir, file))}`);
  }

  // Copy references/ subdirectory if it exists
  const refsSourceDir = path.join(skillSourceDir, 'references');
  if (fs.existsSync(refsSourceDir)) {
    const refsDestDir = path.join(skillDir, 'references');
    fs.mkdirSync(refsDestDir, { recursive: true });
    const refFiles = fs.readdirSync(refsSourceDir).filter(f => f.endsWith('.md'));
    for (const file of refFiles) {
      fs.copyFileSync(path.join(refsSourceDir, file), path.join(refsDestDir, file));
      console.log(`Skill installed: ${path.relative(dir, path.join(refsDestDir, file))}`);
    }
  }

  // 2. Update .claude/settings.json with permissions
  const settingsPath = path.join(dir, '.claude', 'settings.json');
  let settings: any = {};

  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch {
      console.error(`Warning: could not parse ${settingsPath}, creating fresh`);
      settings = {};
    }
  }

  if (!settings.permissions) settings.permissions = {};
  if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];

  const existing = new Set(settings.permissions.allow);
  let added = 0;
  for (const perm of PERMISSIONS) {
    if (!existing.has(perm)) {
      settings.permissions.allow.push(perm);
      added++;
    }
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  if (added > 0) {
    console.log(`Permissions: ${added} rules added to ${path.relative(dir, settingsPath)}`);
  } else {
    console.log(`Permissions: already configured`);
  }

  console.log('\nDone. Claude Code will now use browse for web tasks automatically.');
}
