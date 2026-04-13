---
name: browse-seo
version: 1.0.0
description: |
  SEO auditing for AI agents using the browse CLI. Extracts meta tags, headings, structured data,
  performance metrics, link structure, and mobile rendering. Generates actionable audit reports
  with findings and recommendations. Works with any URL.
allowed-tools:
  - Bash
  - Read
argument-hint: "[URL to audit]"
arguments:
  - request
when_to_use: |
  Use when the user asks for an SEO audit, SEO check, SEO analysis, on-page SEO review,
  or says /browse-seo. Signs you should use this skill:
  - User wants to check meta tags, structured data, or heading hierarchy
  - User wants a technical SEO report for a page or site
  - User asks about Open Graph tags, Twitter cards, or schema markup
  - User wants to check mobile-friendliness or Core Web Vitals
  Do NOT use for general browsing, form filling, or non-SEO tasks.
effort: medium
---

# browse-seo: SEO Audit for AI Agents

## Goal

Run a complete on-page SEO audit for a target URL using the `browse` CLI. Extract technical
SEO signals, analyze them, and produce a report with findings and recommendations.

## Step 0: Consider stealth setup (optional)

If the audit target is behind bot detection (Cloudflare, competitor sites), use camoufox:

```bash
browse --runtime camoufox --headed goto <url>
```

For most public pages, the default Chromium runtime is sufficient. Skip unless you hit blocks.

## Step 1: Navigate to the target URL

```bash
browse goto <url>
browse wait --network-idle
```

Verify the page loaded. Note any redirects -- redirect chains matter for SEO. If the page
returns 403 or a challenge, switch to camoufox (Step 0).

## Step 2: Extract meta tags

```bash
browse meta
```

Returns title, description, canonical, OG tags, Twitter Card, robots, and viewport. Check:

- **Title**: present, under 60 chars, contains target keywords
- **Description**: present, 120-160 chars, compelling and unique
- **Canonical**: present, correct URL (trailing slashes, www vs non-www)
- **Robots**: no accidental `noindex` or `nofollow`
- **Viewport**: `width=device-width, initial-scale=1` for mobile
- **OG tags**: `og:title`, `og:description`, `og:image`, `og:url` all present
- **Twitter Card**: `twitter:card`, `twitter:title`, `twitter:description` present

## Step 3: Check heading structure

```bash
browse headings
```

Returns H1-H6 hierarchy with counts. Check:

- **Exactly one H1**: multiple H1s dilute the primary topic signal
- **H1 matches topic**: should contain the primary keyword
- **Logical nesting**: H2 under H1, H3 under H2 -- no skipped levels
- **Keyword presence**: target keywords in H1 and H2 tags

## Step 4: Extract structured data

```bash
browse schema
```

Extracts JSON-LD, Microdata, and RDFa from the page. Check:

- **Presence**: at least one schema type (Article, Product, Organization, etc.)
- **Required properties**: each type needs required fields per Google's docs
- **Valid JSON-LD**: no syntax errors or malformed objects
- **Correct @type**: matches actual page content
- **Missing opportunities**: FAQ, HowTo, Breadcrumb, Review where content supports it

## Step 5: Check performance

```bash
browse perf
```

Returns navigation timing (DNS, TTFB, DOM load, full load). Check:

- **TTFB**: under 200ms good, over 600ms problem
- **DOM Content Loaded**: under 1.5s acceptable
- **Full load**: under 3s for good UX
- **DNS**: near zero with proper prefetching

Use `browse network` to inspect render-blocking resources, large assets, and request counts.

## Step 6: Analyze link structure

```bash
browse links
```

Returns all anchor elements with text and href. Check:

- **Internal links**: sufficient linking for crawlability
- **Anchor text**: descriptive, not "click here" or bare URLs
- **External links**: appropriate outbound links, nofollow where needed
- **Broken links**: anything pointing to 404 or error pages

## Step 7: Check mobile rendering

```bash
browse responsive
```

Captures screenshots at mobile (375px), tablet (768px), and desktop (1440px). Review for:

- **Mobile layout**: no horizontal scrolling, readable without zooming
- **Tap targets**: 48px minimum for touch
- **Content parity**: mobile has same critical content as desktop
- **Font size**: 16px minimum base font

Use `browse screenshot` for a single full-page capture if needed.

## Step 8: Custom checks via JavaScript

Run targeted checks the built-in commands do not cover:

```bash
# Image alt tags
browse js "const imgs=[...document.querySelectorAll('img')]; const missing=imgs.filter(i=>!i.alt&&!i.getAttribute('role')); JSON.stringify({total:imgs.length,missingAlt:missing.length,examples:missing.slice(0,5).map(i=>i.src.slice(-60))})"

# Duplicate meta tags
browse js "JSON.stringify({titles:document.querySelectorAll('title').length,descriptions:document.querySelectorAll('meta[name=description]').length,canonicals:document.querySelectorAll('link[rel=canonical]').length})"

# Hreflang tags
browse js "JSON.stringify([...document.querySelectorAll('link[rel=alternate][hreflang]')].map(t=>({lang:t.hreflang,href:t.href})))"

# Lazy images without dimensions
browse js "const lazy=[...document.querySelectorAll('img[loading=lazy]')]; const noDims=lazy.filter(i=>!i.width&&!i.height&&!i.getAttribute('width')); JSON.stringify({lazyImages:lazy.length,missingDimensions:noDims.length})"
```

Check robots.txt and sitemap:

```bash
browse goto <origin>/robots.txt
browse text
browse goto <origin>/sitemap.xml
browse text
```

## Step 9: Generate the audit report

After collecting data from Steps 2-8, produce a structured report:

1. **Summary**: one-paragraph overview with pass/fail/warning counts
2. **Meta Tags**: title, description, canonical, robots, OG, Twitter -- each rated
3. **Heading Structure**: H1 count, nesting issues, keyword presence
4. **Structured Data**: schema types found, missing opportunities, validation issues
5. **Performance**: TTFB, load times, blocking resources
6. **Link Analysis**: internal/external ratio, broken links, anchor text quality
7. **Mobile Friendliness**: viewport tag, responsive screenshots, tap target issues
8. **Images**: alt tag coverage, lazy loading, dimension attributes
9. **Recommendations**: prioritized fixes (critical, important, nice-to-have)

Rate each section as PASS, WARNING, or FAIL. Prioritize recommendations by impact.

## Important Rules

- The browser persists between commands. Cookies, tabs, and session state carry over.
- After `goto`, always `wait --network-idle` before extracting data.
- The agent interprets all results. Browse extracts raw data; analysis is your job.
- Do not install anything automatically.
- Save screenshots under `.browse/` directories.
- For sites that block bots, use `--runtime camoufox --headed`.
