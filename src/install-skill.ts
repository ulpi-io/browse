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

/** Recursively copy a skill directory (SKILL.md + references/) */
function copySkillDir(srcDir: string, destDir: string, projectRoot: string): void {
  fs.mkdirSync(destDir, { recursive: true });

  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      copySkillDir(srcPath, destPath, projectRoot);
    } else if (entry.name.endsWith('.md')) {
      fs.copyFileSync(srcPath, destPath);
      console.log(`  ${path.relative(projectRoot, destPath)}`);
    }
  }
}

export function installSkill(targetDir?: string) {
  const dir = targetDir || process.cwd();

  const hasGit = fs.existsSync(path.join(dir, '.git'));
  const hasClaude = fs.existsSync(path.join(dir, '.claude'));
  if (!hasGit && !hasClaude) {
    console.error(`Not a project root: ${dir}`);
    console.error('Run from a directory with .git or .claude, or pass the path as an argument.');
    process.exit(1);
  }

  // 1. Copy all skills — each subfolder in skill/ becomes a separate skill
  const skillSourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skill');

  if (!fs.existsSync(skillSourceRoot)) {
    console.error(`Skill directory not found at ${skillSourceRoot}`);
    console.error('Is @ulpi/browse installed correctly?');
    process.exit(1);
  }

  // Each subfolder (browse/, browse-qa/) is a skill
  const skillFolders = fs.readdirSync(skillSourceRoot).filter(f =>
    fs.statSync(path.join(skillSourceRoot, f)).isDirectory()
  );

  if (skillFolders.length === 0) {
    console.error(`No skill folders found in ${skillSourceRoot}`);
    process.exit(1);
  }

  for (const folder of skillFolders) {
    const srcDir = path.join(skillSourceRoot, folder);
    const destDir = path.join(dir, '.claude', 'skills', folder);
    copySkillDir(srcDir, destDir, dir);
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
