import type { AutomationTarget } from './automation/target';

export interface CommandContext {
  manager: AutomationTarget;
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
  settled: boolean;
  settledReason?: string; // e.g. "network: 3 pending" or "dom: mutation 150ms ago"
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

// ─── Snapshot Context Types ───────────────────────────────────

/** Context level for write command enrichment */
export type ContextLevel = 'off' | 'state' | 'delta' | 'full';

/** Capture state held between prepare and finalize phases of write context */
export interface WriteContextCapture {
  level: ContextLevel;
  beforeState: PageState | null;
  beforeSnapshot: string | null;  // baseline ARIA text for delta mode
}
