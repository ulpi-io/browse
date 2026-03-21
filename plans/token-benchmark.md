# Plan: Token & Speed Benchmark — 4 Browser Tools × 3 Real-World Flows

## Context

Public-facing benchmark comparing what each browser automation tool dumps into an AI agent's context window and how fast it does it. Not just page loads — full realistic agent workflows with navigation, search, scrolling, filtering, interaction, and verification.

## Tools Under Test

| Tool | Version | Install | Snapshot Command |
|------|---------|---------|-----------------|
| `browse` | 0.6.0 | `npm i -g @ulpi/browse` | `browse snapshot -i` |
| `agent-browser` | 0.21.4 | `npm i -g agent-browser` | `agent-browser snapshot -i` |
| `browser-use` | 0.5.0 | `npm i -g browser-use` | `browser-use state` |
| `@playwright/mcp` | 1.58.2 | in-process | `ariaSnapshot()` (auto-dumped on every action) |

## Websites & Flows

### Flow 1: E-Commerce Shopping — amazon.com

| Step | Action | What the agent needs |
|------|--------|---------------------|
| 1 | Load homepage | See what's available |
| 2 | Snapshot for search box | Find the search input |
| 3 | Search "running shoes" | Type + submit |
| 4 | Snapshot search results | See products |
| 5 | Scroll down | Load more products |
| 6 | Snapshot after scroll | See new products |
| 7 | Click page 2 | Navigate pagination |
| 8 | Snapshot page 2 results | See second page products |
| 9 | Apply filter (brand/price) | Narrow results |
| 10 | Snapshot filtered results | See filtered products |
| 11 | Click a product (PDP) | Open product detail |
| 12 | Snapshot PDP | See product info, price, options |
| 13 | Add to cart | Click add-to-cart button |
| 14 | Snapshot after add | Verify cart confirmation |
| 15 | View cart | Navigate to cart page |
| 16 | Snapshot cart | Verify item in cart |

**16 steps.** Every step: measure output bytes, tokens, and wall time per tool.

### Flow 2: News Reading & Search — bbc.com

| Step | Action | What the agent needs |
|------|--------|---------------------|
| 1 | Load homepage | See top stories |
| 2 | Snapshot homepage | Find headlines, nav |
| 3 | Accept cookie banner | Dismiss consent modal |
| 4 | Snapshot after consent | Clean page state |
| 5 | Click a top story | Navigate to article |
| 6 | Snapshot article | Read headline, content structure |
| 7 | Extract article text | Full article content |
| 8 | Scroll to bottom | Reach related stories |
| 9 | Snapshot after scroll | See related articles |
| 10 | Go back to homepage | Navigate back |
| 11 | Search "climate change" | Use search function |
| 12 | Snapshot search results | See matching articles |
| 13 | Click second result | Open another article |
| 14 | Snapshot second article | Read content |
| 15 | Extract article text | Full text extraction |

**15 steps.**

### Flow 3: Travel Booking Search — booking.com

| Step | Action | What the agent needs |
|------|--------|---------------------|
| 1 | Load homepage | See search form |
| 2 | Snapshot homepage | Find destination, dates, guests inputs |
| 3 | Dismiss cookie/popup | Handle consent + welcome modal |
| 4 | Snapshot after dismiss | Clean form state |
| 5 | Fill destination "Paris" | Type into search |
| 6 | Snapshot suggestions | See autocomplete dropdown |
| 7 | Select suggestion | Click Paris option |
| 8 | Set dates | Interact with date picker |
| 9 | Submit search | Click search button |
| 10 | Snapshot results | See hotel listings |
| 11 | Scroll results | Load more hotels |
| 12 | Snapshot after scroll | See additional listings |
| 13 | Apply filter (price/stars) | Narrow results |
| 14 | Snapshot filtered results | See filtered hotels |
| 15 | Click a hotel | Open hotel page |
| 16 | Snapshot hotel page | See room options, prices, photos |

**16 steps.**

**47 total steps across all 3 flows.**

## What We Measure Per Step

| Metric | How |
|--------|-----|
| **Output size (bytes)** | `Buffer.byteLength(stdout)` |
| **Token estimate** | `Math.round(bytes / 4)` |
| **Wall time (ms)** | `performance.now()` before/after execution |
| **Cumulative tokens** | Running total through the flow |
| **Cumulative time** | Running total through the flow |

## Command Mapping Per Step Type

| Action | browse | agent-browser | browser-use | playwright/mcp |
|--------|--------|---------------|-------------|----------------|
| Navigate | `goto <url>` | `open <url>` | `open <url>` | `page.goto()` → auto snapshot |
| Snapshot | `snapshot -i` | `snapshot -i` | `state` | `ariaSnapshot()` (already returned) |
| Click | `click @ref` | `click @ref` | `click <index>` | `page.click()` → auto snapshot |
| Fill/Type | `fill @ref "text"` | `fill @ref "text"` | `input <index> "text"` | `page.fill()` → auto snapshot |
| Scroll | `scroll down` | `scroll down` | `scroll down` | `page.evaluate('scroll')` → auto snapshot |
| Text | `text` | `get text` | `eval "document.body.innerText"` | `page.innerText('body')` |
| Back | `back` | `back` | `back` | `page.goBack()` → auto snapshot |
| Wait | `wait --network-idle` | `wait --load networkidle` | `wait selector "body"` | implicit |

**Key difference**: playwright/mcp returns the full accessibility snapshot on EVERY action (navigate, click, type, scroll). The other 3 tools return a one-liner confirmation — the agent chooses when to request a snapshot.

## Token Cost Model

### For browse, agent-browser, browser-use:
```
Total tokens = Σ(action one-liners) + Σ(explicit snapshots)
```
Agent only pays for snapshots when it explicitly requests them. Actions cost ~15 tokens each.

### For @playwright/mcp:
```
Total tokens = Σ(full snapshot per action)
```
Every action auto-dumps the full page snapshot. No way to opt out.

## Implementation: benchmark.ts

### Architecture

```
benchmark.ts
├── Phase 0: Setup (kill servers, verify tools)
├── Phase 1: playwright/mcp (in-process, own Chromium)
│   ├── Flow 1: amazon (16 steps)
│   ├── Flow 2: bbc (15 steps)
│   └── Flow 3: booking (16 steps)
├── Phase 2: browse (subprocess, own server)
│   ├── Flow 1: amazon (16 steps)
│   ├── Flow 2: bbc (15 steps)
│   └── Flow 3: booking (16 steps)
├── Phase 3: agent-browser (subprocess, own server)
│   ├── Flow 1: amazon (16 steps)
│   ├── Flow 2: bbc (15 steps)
│   └── Flow 3: booking (16 steps)
├── Phase 4: browser-use (subprocess, own daemon)
│   ├── Flow 1: amazon (16 steps)
│   ├── Flow 2: bbc (15 steps)
│   └── Flow 3: booking (16 steps)
└── Phase 5: Generate BENCHMARKS.md
```

### Data Shape

```typescript
interface StepResult {
  step: number;
  action: string;           // "navigate", "snapshot", "click", "fill", "scroll", "text", "back"
  description: string;       // Human-readable: "Search running shoes"
  bytes: number;
  tokens: number;
  ms: number;
}

interface FlowResult {
  site: string;              // "amazon.com"
  flow: string;              // "E-Commerce Shopping"
  steps: StepResult[];
  totalTokens: number;
  totalMs: number;
}

interface ToolResults {
  tool: string;
  version: string;
  flows: FlowResult[];
  grandTotalTokens: number;
  grandTotalMs: number;
}
```

### Timing Function

```typescript
function measure(cmd: string): { output: string; bytes: number; ms: number } {
  const start = performance.now();
  const output = execSync(cmd, { timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const ms = Math.round(performance.now() - start);
  return { output, bytes: Buffer.byteLength(output), ms };
}
```

### Flow Executor Pattern

Each flow is a function that takes a tool adapter and returns StepResult[]:

```typescript
interface ToolAdapter {
  name: string;
  navigate(url: string): StepResult;
  snapshot(): StepResult;
  click(ref: string): StepResult;
  fill(ref: string, value: string): StepResult;
  scroll(direction: string): StepResult;
  text(): StepResult;
  back(): StepResult;
  wait(): StepResult;
  stop(): void;
}
```

Tool adapters:
- `BrowseAdapter`: calls `browse <cmd>` via execSync
- `AgentBrowserAdapter`: calls `agent-browser <cmd>` via execSync
- `BrowserUseAdapter`: calls `browser-use <cmd>` via execSync
- `PlaywrightAdapter`: calls Playwright API directly (in-process), records ariaSnapshot on every action

## Output: BENCHMARKS.md Structure

```markdown
# Benchmarks: Token Cost & Speed — Browser Automation Tools

> Measured YYYY-MM-DD. Same machine, 3 real-world flows, 47 steps each.

## TL;DR

| Metric | browse | agent-browser | browser-use | @playwright/mcp |
|--------|--------|---------------|-------------|-----------------|
| Total tokens (47 steps) | X | X | X | X |
| Total time (47 steps) | Xs | Xs | Xs | Xs |
| Avg tokens per step | X | X | X | X |
| Avg ms per step | X | X | X | X |
| Context consumed (200K) | X% | X% | X% | X% |

## Flow 1: E-Commerce Shopping (amazon.com) — 16 steps

### Cumulative Token Cost

| Step | Action | browse | agent-browser | browser-use | playwright/mcp |
|------|--------|--------|---------------|-------------|----------------|
| 1 | Load homepage | X | X | X | X |
| 2 | Snapshot | +X (=Y) | +X (=Y) | +X (=Y) | (included in 1) |
| ... | ... | ... | ... | ... | ... |
| 16 | Snapshot cart | =TOTAL | =TOTAL | =TOTAL | =TOTAL |

### Cumulative Time (ms)

(Same table structure with ms instead of tokens)

## Flow 2: News Reading (bbc.com) — 15 steps
(Same structure)

## Flow 3: Travel Search (booking.com) — 16 steps
(Same structure)

## Why The Difference

@playwright/mcp dumps the full accessibility snapshot on EVERY action:
navigate, click, type, scroll — each returns 5K-50K tokens.

browse, agent-browser, browser-use return a one-liner (~15 tokens) for
actions. The agent requests a snapshot ONLY when it needs to see the page.

In a 16-step flow:
- @playwright/mcp: 16 × full snapshot = 80K-800K tokens
- browse: 16 × one-liner + 5 explicit snapshots = 240 + 25K = ~25K tokens

## Architectural Differences

| Feature | browse | agent-browser | browser-use | @playwright/mcp |
|---------|--------|---------------|-------------|-----------------|
| Navigate response | one-liner (~15 tok) | one-liner (~15 tok) | one-liner (~15 tok) | full snapshot (5-50K tok) |
| Click response | one-liner | one-liner | one-liner | full snapshot |
| Type response | one-liner | one-liner | one-liner | full snapshot |
| Agent controls output | yes | yes | yes | no |
| Interactive filter | snapshot -i | snapshot -i | state | no |
| Persistent daemon | yes | yes | yes | no |
| Crash recovery | yes | yes | no | no |
| Coordinate click | yes | no | yes | no |
| Device emulation | yes | yes | no | no |
| Total commands | 76+ | 50+ | 30+ | ~15 |

## Methodology

- Token estimates: ~4 chars per token (standard approximation)
- All navigations: wait for domcontentloaded + 2.5s settle
- Each tool gets its own fresh browser process
- Steps that fail (bot detection, timeout) recorded as 0 and excluded from averages
- Wall time includes CLI overhead (first call includes server startup)
- Machine: Apple M-series, macOS, [RAM]
- Rerun: `bun run benchmark.ts`
```

## Verification

```bash
bun run benchmark.ts
# Runs all 4 tools × 3 flows × 47 steps
# Output: BENCHMARKS.md
# Expected runtime: ~10-15 minutes
```

## Notes

- Flows must adapt to each tool's selector format (@refs vs indices vs CSS)
- After each navigate/click, the flow needs to re-snapshot to get fresh refs/indices
- Some sites may block some tools differently — record and report honestly
- The 2.5s settle time is generous — some tools may be faster but we keep it fair
- playwright/mcp phase runs in-process (no CLI overhead) which gives it a speed advantage — note this in methodology
