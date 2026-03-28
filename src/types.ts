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

// ─── Action Context Types ──────────────────────────────────────

export interface PageState {
  url: string;
  title: string;
  tabCount: number;
  dialog: { type: string; message: string } | null;
  consoleErrorCount: number;
  networkPendingCount: number;
  timestamp: number;
}

export interface ContextDelta {
  urlChanged?: string;       // new URL path (e.g. "/checkout")
  titleChanged?: string;     // new title
  dialogAppeared?: { type: string; message: string };
  dialogDismissed?: boolean;
  tabsChanged?: number;      // new tab count (only if changed)
  consoleErrors?: number;    // new errors since last capture
  navigated?: boolean;       // URL changed (convenience flag)
}
