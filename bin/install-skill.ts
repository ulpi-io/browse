#!/usr/bin/env bun
/**
 * browse install-skill — install the browse Claude Code skill into a project
 *
 * Copies SKILL.md to .claude/skills/browse/SKILL.md
 * and adds browse permission rules to .claude/settings.json
 *
 * Usage:
 *   browse install-skill           # install into current project
 *   browse install-skill /path     # install into specific project
 */

import * as fs from 'fs';
import * as path from 'path';

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

function main() {
  const targetDir = process.argv[2] || process.cwd();

  // Verify target looks like a project root
  const hasGit = fs.existsSync(path.join(targetDir, '.git'));
  const hasClaude = fs.existsSync(path.join(targetDir, '.claude'));
  if (!hasGit && !hasClaude) {
    console.error(`Not a project root: ${targetDir}`);
    console.error('Run from a directory with .git or .claude, or pass the path as an argument.');
    process.exit(1);
  }

  // 1. Copy SKILL.md
  const skillDir = path.join(targetDir, '.claude', 'skills', 'browse');
  fs.mkdirSync(skillDir, { recursive: true });

  const skillSource = path.resolve(import.meta.dir, '..', 'skill', 'SKILL.md');
  const skillDest = path.join(skillDir, 'SKILL.md');

  if (!fs.existsSync(skillSource)) {
    console.error(`SKILL.md not found at ${skillSource}`);
    console.error('Is @ulpi/browse installed correctly?');
    process.exit(1);
  }

  fs.copyFileSync(skillSource, skillDest);
  console.log(`  Skill installed: ${path.relative(targetDir, skillDest)}`);

  // 2. Update .claude/settings.json with permissions
  const settingsPath = path.join(targetDir, '.claude', 'settings.json');
  let settings: any = {};

  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch {
      console.error(`  Warning: could not parse ${settingsPath}, creating fresh`);
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
    console.log(`  Permissions added: ${added} rules to ${path.relative(targetDir, settingsPath)}`);
  } else {
    console.log(`  Permissions: already configured`);
  }

  console.log('\n  Done. Claude Code will now use browse for web tasks automatically.');
}

main();
