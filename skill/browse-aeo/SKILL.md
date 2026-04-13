---
name: browse-aeo
version: 1.0.0
description: |
  Answer Engine Optimization (AEO) audit and SERP analysis for AI-generated answers.
  Analyzes pages for AEO readiness (structured data, FAQ patterns, heading hierarchy,
  meta quality) and checks how queries appear in AI-powered search results (Google AI
  Overviews, Perplexity, ChatGPT Search). Uses the browse CLI for all page interaction.
allowed-tools:
  - Bash
  - Read
argument-hint: "[URL to audit or search query to analyze]"
arguments:
  - request
when_to_use: |
  Use when the user asks for AEO audit, answer engine optimization, AI search optimization,
  AI Overview analysis, Perplexity citation check, or says /browse-aeo. Also use when the
  user wants to understand how a page or domain appears in AI-generated answers.
effort: high
---

# browse-aeo: Answer Engine Optimization

## Goal

Audit a page for AEO readiness or analyze how a query surfaces in AI-powered search.
Two modes: **Page Audit** (analyze a URL) and **SERP Analysis** (analyze a search query).

## Mode 1: Page Audit

Evaluate a single URL for AEO readiness. Run each step in order.

### Step 1: Navigate and stabilize

```bash
browse goto <url>
browse wait --network-idle
```

### Step 2: Extract structured data

```bash
browse schema
```

Analyze for: JSON-LD presence (critical for AEO), FAQPage schema (directly feeds AI answers), HowTo schema (surfaces in how-to answers), Article/NewsArticle/BlogPosting (attribution), Organization/Person (authority), Breadcrumb (hierarchy), QAPage (Q&A pairs). Empty or minimal structured data is a major AEO gap.

### Step 3: Extract and evaluate meta tags

```bash
browse meta
```

Check: meta description (concise direct answer, under 160 chars -- AI uses this as candidate snippet), canonical URL (must be present), Open Graph tags (og:title, og:description), robots directives (`noindex` or `nosnippet` blocks AI citation entirely).

### Step 4: Analyze heading hierarchy

```bash
browse headings
```

Evaluate: single H1 (clear topic statement), H2s as questions or clear topic labels (AI uses headings to find answer boundaries), question-format H2s ("What is X?", "How to Y?") are strongly preferred, logical nesting (no skipped levels).

### Step 5: Analyze page content for answer patterns

```bash
browse text
```

Scan for: direct definitions in the first paragraph ("X is a..." -- AI favors concise leads), FAQ patterns (Q&A pairs even without schema), numbered/bulleted lists (AI prefers extractable structure), concise paragraphs (under 50 words are more likely cited), authority signals ("We tested...", "In our experience..." -- original research language).

### Step 6: Produce the AEO audit report

Score the page on a 0-100 scale across these dimensions:

| Dimension | Weight | What to check |
|-----------|--------|---------------|
| Structured Data | 25% | JSON-LD presence, FAQ/HowTo/Article schema, completeness |
| Meta Quality | 15% | Description as answer snippet, canonical, no blocking robots |
| Heading Structure | 20% | Single H1, question-format H2s, logical nesting |
| Answer Readiness | 25% | Direct definitions, FAQ patterns, concise paragraphs, lists |
| Authority Signals | 15% | Organization schema, author markup, original research language |

Report: overall score out of 100, per-dimension score with findings and recommendations, then the top 3 highest-impact actions.

## Mode 2: SERP Analysis

Check how a query appears in AI-powered search results.

### Step 1: Google search with AI Overview detection

```bash
browse goto "https://www.google.com/search?q=<url-encoded-query>"
browse wait --network-idle
browse snapshot -i
```

Read the snapshot to identify: AI Overview (generative answer block, note cited domains), Featured Snippet (boxed answer, note source domain), People Also Ask (expandable questions -- these are AEO targets), organic position of target domain.

If Google blocks the request, retry with camoufox:

```bash
browse --runtime camoufox --headed goto "https://www.google.com/search?q=<url-encoded-query>"
browse --runtime camoufox --headed snapshot -i
```

### Step 2: Perplexity analysis (camoufox recommended)

Perplexity has bot detection. Use camoufox:

```bash
browse --runtime camoufox --headed goto "https://www.perplexity.ai/search?q=<url-encoded-query>"
browse --runtime camoufox --headed wait --network-idle
browse --runtime camoufox --headed snapshot -i
```

Read the snapshot to identify: cited source domains (numbered citations), answer structure (paragraphs, lists, tables), citation density. If Perplexity blocks, note it in the report and skip.

### Step 3: Produce the SERP analysis report

Report: for each engine (Google, Perplexity), list AI Overview presence, cited domains, featured snippet source, People Also Ask questions, and target domain position. End with observations on what content types are being cited and specific actions to improve citation likelihood.

## Key Rules

1. **Always wait after navigation** -- `browse wait --network-idle` before extracting content.
2. **Use camoufox for search engines** -- Google and Perplexity actively block headless browsers. Fall back to `--runtime camoufox --headed` when blocked.
3. **Agent interprets snapshots** -- there is no magic SERP parser. The agent reads `browse snapshot -i` output and identifies AI Overview elements, citations, and People Also Ask by reading the accessibility tree.
4. **Structured data is the top signal** -- JSON-LD FAQ and HowTo schemas are the single most impactful AEO lever. Always check this first.
5. **Do not fabricate scores** -- if a dimension cannot be evaluated (e.g., page is behind a login wall), mark it as "N/A" and explain why.
6. **Keep recommendations actionable** -- "Add FAQ schema" is good. "Improve SEO" is not.

## Guardrails

- Do not add `disable-model-invocation`; this is a general-purpose audit skill.
- Do not add `context: fork`; audit results are needed in the current flow.
- Do not run `browse handoff` without explicit user confirmation.
- Do not guess SERP structure -- always take a snapshot and read it.
- Do not claim a page "appears in AI Overviews" without actually checking via SERP analysis.

## Output Contract

Report:

1. the mode used (Page Audit or SERP Analysis)
2. the URL audited or query analyzed
3. findings per dimension with specific evidence
4. actionable recommendations ranked by impact
5. any blockers encountered (bot detection, login walls, empty results)
