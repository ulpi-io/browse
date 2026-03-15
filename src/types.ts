import type { BrowserManager } from './browser-manager';

export interface CommandContext {
  manager: BrowserManager;
  command: string;
  args: string[];
}

export interface CommandResult {
  output: string;
  hint?: string;
}
