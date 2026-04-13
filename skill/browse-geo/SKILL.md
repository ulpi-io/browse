---
name: browse-geo
version: 1.0.0
description: |
  Generative Engine Optimization (GEO) monitoring — track brand and domain visibility
  across AI-powered search engines: Google AI Overviews, Perplexity, and ChatGPT Search.
  Run multi-query sweeps, detect citations, measure domain presence, and generate
  cross-engine visibility reports. Uses the browse CLI with camoufox for stealth.
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
argument-hint: "[brand queries or domain to monitor]"
arguments:
  - request
when_to_use: |
  Use when the user asks for GEO monitoring, generative engine optimization, AI visibility
  tracking, brand monitoring in AI search, or says /browse-geo. Examples:
  - "Check if my domain appears in Google AI Overviews for these queries"
  - "Monitor brand visibility across Perplexity and ChatGPT Search"
  - "Run a GEO audit for our product across AI search engines"
  - "Track which domains get cited in AI-generated answers"
  Do NOT use for traditional SEO (rankings, meta tags, crawlability) — use browse-seo instead.
effort: high
---

# browse-geo: Generative Engine Optimization Monitoring

## Goal

Monitor how a brand or domain appears in AI-generated search results across three engines:
Google AI Overviews, Perplexity, and ChatGPT Search. Produce a visibility matrix showing
which queries surface the target domain, in what position, and with what context.

## Prerequisites

Camoufox is required for Google (bot detection). Install if not available:

```bash
browse --runtime camoufox doctor
# If not installed:
npm install camoufox-js && npx camoufox-js fetch
```

For ChatGPT Search, a persistent browser profile with an authenticated ChatGPT session is
required. Create one if needed:

```bash
browse --profile chatgpt --headed goto https://chatgpt.com
# User logs in manually via headed browser
# Profile persists cookies for future sessions
```

## Step 0: Gather inputs

Before running any queries, collect from the user:

1. **Target domain** — the domain to track (e.g., `example.com`)
2. **Query list** — 3-10 brand-relevant search queries
3. **Engines** — which engines to check (default: all three)

If the user provides only a domain, suggest relevant queries based on the domain's likely
industry and product category. Use `AskUserQuestion` to confirm the query list.

## Step 1: Google AI Overviews

Google AI Overviews appear at the top of search results for informational queries.
Use camoufox with consent dismissal to avoid bot detection and cookie banners.

### Navigate and extract

For each query:

```bash
BROWSE_CONSENT_DISMISS=1 browse --runtime camoufox --headed goto "https://www.google.com/search?q=<url-encoded-query>"
browse --runtime camoufox --headed wait --network-idle
browse --runtime camoufox --headed snapshot -i
```

### Analyze results

Read the snapshot output. The AI Overview section typically has an "AI Overview" label,
expandable summary text with inline citations, and source links. If present, use
`browse --runtime camoufox --headed text` to extract full content.

For each query, record: `ai_overview_present` (yes/no), `domain_cited` (yes/no),
`citation_position` (number or null), `citation_context` (the claim it supports),
and `competing_domains` (other cited domains).

## Step 2: Perplexity

Perplexity shows AI-generated answers with numbered source citations.

### Navigate and extract

For each query:

```bash
browse goto "https://www.perplexity.ai/search?q=<url-encoded-query>"
browse wait --network-idle
browse snapshot -i
```

### Analyze results

Perplexity shows numbered footnote-style citations (e.g., [1], [2]) within the answer
and a "Sources" section with URLs. Use `browse text` for full content if needed.

For each query, record: `answer_generated` (yes/no), `domain_cited` (yes/no),
`citation_numbers` (positions referencing the target domain), `citation_context`,
`total_citations`, and `competing_domains`.

## Step 3: ChatGPT Search (authenticated)

ChatGPT Search requires an authenticated session. Use a persistent profile.

### Navigate and query

For each query:

```bash
browse --profile chatgpt goto https://chatgpt.com
browse --profile chatgpt snapshot -i
```

Find the input field from the snapshot, then:

```bash
browse --profile chatgpt fill <input-ref> "<query>"
browse --profile chatgpt press Enter
browse --profile chatgpt wait --network-idle
```

ChatGPT streams responses. Wait for output to stabilize, then snapshot:

```bash
browse --profile chatgpt wait --network-idle
browse --profile chatgpt snapshot -i
```

If a stop/regenerate button is visible, the response is still streaming — wait and
re-snapshot. Use `browse --profile chatgpt text` for full content extraction.

### Analyze results

ChatGPT Search shows inline numbered citation links and a "Sources" panel with URLs.

For each query, record: `response_generated` (yes/no), `search_used` (yes/no --
ChatGPT may answer from training data without search), `domain_cited` (yes/no),
`citation_position` (number or null), `citation_context`, and `competing_domains`.

## Step 4: Generate visibility report

After running all queries across selected engines, compile the results into a
structured report.

### Visibility matrix

Create a table with queries as rows and engines as columns:

```
| Query                  | Google AI Overview | Perplexity | ChatGPT Search |
|------------------------|--------------------|------------|----------------|
| "best <product>"       | Cited (#2)         | Cited (#1) | Not cited      |
| "<brand> vs competitor"| No AI Overview     | Cited (#3) | Cited (#2)     |
| "how to <task>"        | Cited (#1)         | Not cited  | Not cited      |
```

### Summary metrics

Calculate and report:

- **Visibility rate**: percentage of queries where the domain appears, per engine
- **Average citation position**: mean position when cited, per engine
- **Best-performing queries**: queries where the domain appears across multiple engines
- **Gap queries**: queries where the domain is absent from all engines
- **Top competing domains**: domains that appear most frequently across all queries

### Recommendations

Based on the findings, suggest:

- Which queries have the highest AI visibility potential
- Where competitors are cited but the target domain is not
- Content gaps that could improve citation likelihood
- Which engines favor the domain (focus optimization there)

## Multi-query workflow

When running many queries, batch by engine to minimize context switching:

1. Run all queries on Google AI Overviews first (camoufox session stays warm)
2. Run all queries on Perplexity second (no special runtime needed)
3. Run all queries on ChatGPT Search last (authenticated profile session)

Between queries on the same engine, no need to restart the browser. Navigate directly
to the next search URL.

## Important rules

- **Camoufox for Google** — Google blocks regular Chromium for automated searches. Always
  use `--runtime camoufox --headed` for Google queries.
- **Rate limiting** — Add natural pauses between queries on the same engine. Do not run
  more than one query every 5-10 seconds on Google. Perplexity and ChatGPT are more lenient.
- **AI Overviews are not always present** — Google shows AI Overviews for informational
  queries, not navigational or transactional ones. Record absence as a data point.
- **ChatGPT may not use search** — ChatGPT sometimes answers from training data without
  invoking web search. When no sources panel appears, record `search_used: no`.
- **Snapshot before text** — always take a snapshot first to understand page structure,
  then use text extraction for full content if needed.
- **Do not fabricate results** — if a citation is ambiguous or unclear, note it as
  uncertain rather than asserting presence or absence.
- **Profile persistence** — the `--profile chatgpt` flag reuses cookies across sessions.
  If the session expires, ask the user to re-authenticate via headed mode.

## Limitations

- **Google AI Overviews availability** — not all queries trigger AI Overviews; availability
  varies by region and query type
- **ChatGPT Search access** — requires a ChatGPT Plus or Team subscription with search enabled
- **Rate limits** — aggressive querying may trigger temporary blocks on any engine
- **Dynamic content** — AI-generated answers change over time; results represent a
  point-in-time snapshot
- **Image/video citations** — this workflow tracks text citations only; rich media
  citations in AI answers are not captured
