/**
 * Snapshot windowing — truncate large accessibility snapshots while
 * preserving pagination/navigation links at the tail.
 *
 * Cuts on line boundaries (never splits a line or @ref mid-token).
 * Extracts actual navigation/pagination lines from the tail, not arbitrary chars.
 */

const DEFAULT_MAX_CHARS = 80_000;   // ~20K tokens
const TAIL_MAX_LINES = 40;          // max lines reserved for nav/pagination tail

export interface WindowResult {
  text: string;
  truncated: boolean;
  totalChars: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
}

/**
 * Extract navigation/pagination lines from the end of a snapshot.
 * Looks for lines containing navigation, pagination, link "Next", link "Previous", etc.
 * Returns the last N lines that look like nav elements, or a small fixed tail.
 */
function extractNavTail(lines: string[]): string[] {
  // Walk backward from the end, collecting nav-like lines
  const navLines: string[] = [];
  const navPatterns = /navigation|pagination|link "Next"|link "Previous"|link "More"|page \d/i;

  for (let i = lines.length - 1; i >= 0 && navLines.length < TAIL_MAX_LINES; i--) {
    const line = lines[i];
    if (navPatterns.test(line) || (navLines.length > 0 && line.match(/^\s/))) {
      navLines.unshift(line);
    } else if (navLines.length > 0) {
      break; // stop once we've left the nav block
    }
  }

  // If no nav lines found, take the last few lines as fallback
  if (navLines.length === 0) {
    return lines.slice(-Math.min(10, lines.length));
  }
  return navLines;
}

/**
 * Apply windowing to a snapshot string.
 * - Splits on line boundaries (never cuts mid-line or mid-@ref).
 * - offset is a LINE index, not char index.
 * - Appends actual navigation/pagination tail lines.
 * - Returns unchanged if under the char limit.
 */
export function applySnapshotWindow(
  snapshot: string,
  opts?: { offset?: number; maxChars?: number },
): WindowResult {
  const maxChars = opts?.maxChars ?? DEFAULT_MAX_CHARS;
  const offset = opts?.offset ?? 0;
  const total = snapshot.length;

  if (total <= maxChars) {
    return { text: snapshot, truncated: false, totalChars: total, offset: 0, hasMore: false, nextOffset: null };
  }

  const allLines = snapshot.split('\n');
  const navTail = extractNavTail(allLines);
  const navTailText = navTail.join('\n');
  const navTailChars = navTailText.length + 200; // room for marker

  // Budget for content lines (excluding nav tail)
  const contentBudget = maxChars - navTailChars;

  // Collect lines starting from offset (line index), fitting within budget
  const clampedOffset = Math.min(Math.max(0, offset), allLines.length - 1);
  const chunkLines: string[] = [];
  let chunkChars = 0;

  for (let i = clampedOffset; i < allLines.length; i++) {
    const lineLen = allLines[i].length + 1; // +1 for newline
    if (chunkChars + lineLen > contentBudget && chunkLines.length > 0) break;
    chunkLines.push(allLines[i]);
    chunkChars += lineLen;
  }

  const nextLineIdx = clampedOffset + chunkLines.length;
  const hasMore = nextLineIdx < allLines.length - navTail.length;

  const marker = hasMore
    ? `\n[... truncated at line ${nextLineIdx} of ${allLines.length}. Use --offset ${nextLineIdx} to see more. ...]\n`
    : '\n';

  return {
    text: chunkLines.join('\n') + marker + navTailText,
    truncated: true,
    totalChars: total,
    offset: clampedOffset,
    hasMore,
    nextOffset: hasMore ? nextLineIdx : null,
  };
}

/**
 * Format window metadata as a human-readable line.
 */
export function formatWindowMetadata(result: WindowResult): string {
  if (!result.truncated) return '';
  return `[snapshot truncated: showing from line ${result.offset}, ${result.totalChars} total chars` +
    (result.hasMore ? `, next: --offset ${result.nextOffset}` : '') + ']';
}
