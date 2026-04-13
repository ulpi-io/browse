# Plan: Phase 6 — New Commands

> Generated: 2026-04-12
> Branch: `feat/new-commands`
> Mode: EXPANSION
> Review: claude
> Linked plans: phase1-camoufox-runtime, phase2-real-web-browsing-quality, phase3-snapshot-large-pages, phase4-proxy-pool, phase5-concurrency-lifecycle

## Overview

Add YouTube transcript extraction, download inline base64 support, and Netscape cookie file import to browse_cli. Phase 6 of the camoufox integration roadmap. All three features are runtime-agnostic -- they work with any browser runtime (Playwright, Camoufox, Rebrowser). YouTube transcripts use yt-dlp as the fast path (no browser needed), falling back to a clear "install yt-dlp" message when not available. Download inline returns file content as base64 in the CLI response. Netscape cookie import adds support for .txt cookie files exported by browser extensions (EditThisCookie, Get cookies.txt, Cookie-Editor, etc.).

## Scope Challenge

Three independent features sharing the command pipeline. YouTube transcript is the largest: new handler file (`src/commands/meta/youtube.ts`), new helper module (`src/browser/youtube.ts`), and registry entry. The yt-dlp fast path spawns a child process with a sanitized environment -- security-critical. Download inline is a small extension to the existing download handler in `src/commands/write.ts` -- add `--inline` flag that reads the saved file and returns base64 instead of the path. Netscape cookie import extends the existing `cookie-import` command in `src/commands/meta/auth.ts` -- the current implementation only handles Chromium SQLite databases. Need to detect Netscape format (.txt files with tab-separated fields) and parse them into Playwright-compatible cookies. The Netscape parser is a new function in `src/browser/cookie-import.ts` alongside the existing Chromium decryption pipeline.

## Prerequisites

- CommandRegistry in `src/automation/registry.ts` supports meta command registration via `m()` helper (verified: registry.ts:24)
- Meta command dispatcher (`src/commands/meta/index.ts`) routes to handler modules via command set membership (verified: index.ts:23-43)
- Download command handler exists in `src/commands/write.ts` with save-to-disk logic (verified: write.ts:732-744)
- Cookie import exists for Chromium SQLite databases only -- Chrome, Arc, Brave, Edge on macOS (verified: cookie-import.ts:86-91)
- yt-dlp binary available on developer machines for YouTube fast path (external, optional)
- Test infrastructure has download fixture and test server route (verified: test-server.ts:45-48)

## Non-Goals

- YouTube video download (only transcript/caption extraction)
- YouTube playlist or channel batch transcript extraction
- Download manager with queue/retry/resume (only single-file inline base64)
- Cookie encryption/vault for Netscape-imported cookies (they are plain text)
- Firefox cookie database decryption (only Netscape .txt format added)
- Browser-based YouTube transcript fallback (Phase 6 only implements yt-dlp path; browser intercept is a future enhancement)

## Contracts

| Boundary | Producer | Consumer | Shape / API | Consistency / Recovery Rule |
|----------|----------|----------|-------------|------------------------------|
| youtube.ts helpers -> meta/youtube.ts handler | `src/browser/youtube.ts` exports: `ensureYtDlp`, `ytDlpTranscript`, `parseJson3`, `parseVtt`, `parseXml` | `src/commands/meta/youtube.ts` | `ytDlpTranscript(url, lang?) -> { status: 'ok', transcript, video_title, language, total_words } \| { status: 'error', code, message }` | Handler catches yt-dlp not available error and returns user-friendly message with install instructions |
| download --inline -> CLI response | `src/commands/write.ts` download handler | CLI stdout / MCP response | `data:<mime>;base64,<encoded>` string | Max 20MB. Oversized files return error with saved temp path. Temp file cleaned up after read. |
| Netscape cookie parser -> cookie-import handler | `src/browser/cookie-import.ts` exports: `parseNetscapeCookieFile`, `importNetscapeCookies` | `src/commands/meta/auth.ts` cookie-import with `--file` flag | `parseNetscapeCookieFile(text) -> PlaywrightCookie[]` | Netscape format detected by --file flag. Domain filtering optional. Cookies added to browser context. |

## Architecture

```
YouTube Transcript (TASK-001 + TASK-002)
  browse youtube-transcript <url> [--lang en]
      |
      v
  meta/youtube.ts handler
      |
      v
  browser/youtube.ts
      |-- ensureYtDlp() -> detect binary
      |-- ytDlpTranscript(url, lang)
      |       |-- execFile('yt-dlp', ['--print', '%(title)s', url])
      |       |-- execFile('yt-dlp', ['--write-sub', '--sub-format', 'json3', url])
      |       |-- parseJson3() / parseVtt() / parseXml()
      |       +-- return { transcript, title, language, words }
      v
  "Title: <title>\nLanguage: <lang>\nWords: <count>\n\n<transcript>"

Download Inline (TASK-003)
  browse download <selector> --inline
      |
      v
  write.ts download handler
      |-- page.waitForEvent('download')
      |-- download.saveAs(tempPath)
      |-- fs.readFile(tempPath) -> Buffer
      |-- Buffer.toString('base64')
      |-- fs.unlink(tempPath)
      v
  "data:<mime>;base64,<encoded>"

Netscape Cookie Import (TASK-004)
  browse cookie-import --file cookies.txt [--domain .example.com]
      |
      v
  meta/auth.ts cookie-import handler
      |-- detect --file flag
      |-- importNetscapeCookies(filePath, domain?)
      |       |-- fs.readFile(filePath)
      |       |-- parseNetscapeCookieFile(text)
      |       +-- filter by domain (optional)
      v
  context.addCookies(cookies)
```

## Existing Code Leverage

| Sub-problem | Existing Code | Action |
|------------|---------------|--------|
| YouTube transcript parsing (JSON3, VTT, XML) | `camofox-browser/lib/youtube.js` | Port to TypeScript |
| yt-dlp process spawning with safe environment | `camofox-browser/lib/youtube.js:21-86` | Port to TypeScript |
| Download inline base64 pattern | `camofox-browser/lib/downloads.js:118-150` | Port pattern |
| Netscape cookie file parsing | `camofox-browser/lib/cookies.js:13-43` | Port to TypeScript |
| Meta command dispatcher routing | `src/commands/meta/index.ts:23-97` | Extend (add youtube routing) |
| Command registry registration | `src/automation/registry.ts:471+` | Extend (add youtube-transcript) |
| Download command handler | `src/commands/write.ts:732-744` | Extend (add --inline flag) |
| Cookie import handler | `src/commands/meta/auth.ts:73-134` | Extend (add --file flag) |
| Download integration test | `test/interactions.test.ts:275-289` | Extend (add inline test) |

## Tasks

### TASK-001: YouTube yt-dlp detection and caption parsers

Create `src/browser/youtube.ts` with yt-dlp binary detection, safe child process spawning, and three caption format parsers (JSON3, VTT, XML/srv3). Port from camofox-browser/lib/youtube.js with TypeScript types.

Key functions:
1. `detectYtDlp()` -- scan candidate paths, cache result
2. `ensureYtDlp()` -- lazy re-detect on each call if initial detection failed
3. `hasYtDlp()` -- synchronous check of cached result
4. `buildSafeEnv()` -- whitelist only PATH, HOME, LANG, LC_ALL, LC_CTYPE, TMPDIR
5. `runYtDlp(binary, args, timeoutMs)` -- spawn with safe env, maxBuffer 4MB, timeout
6. `normalizeYoutubeUrl(rawUrl)` -- validate URL scheme (https/http) and host (youtube.com, youtu.be)
7. `normalizeLanguage(rawLang)` -- validate language code regex, default 'en'
8. `ytDlpTranscript(url, lang?, proxyUrl?)` -- full transcript pipeline (title + subtitles + parse + cleanup)
9. `parseJson3(content)` -- parse YouTube JSON3 format (events[].segs[].utf8 with tStartMs)
10. `parseVtt(content)` -- parse WebVTT format (timestamps, HTML entity decoding, tag stripping)
11. `parseXml(content)` -- parse XML/srv3 format (<text start="..."> elements)

Security: All yt-dlp args constructed from validated values. Environment whitelisted. Temp dirs cleaned in finally blocks.

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] parseJson3() converts YouTube JSON3 caption data into '[MM:SS] text' format
- [ ] parseVtt() converts WebVTT caption data into '[MM:SS] text' format, stripping HTML tags and decoding entities
- [ ] parseXml() converts XML/srv3 caption data into '[MM:SS] text' format
- [ ] normalizeYoutubeUrl() rejects non-YouTube URLs and non-http(s) schemes
- [ ] buildSafeEnv() only includes whitelisted environment variables
- [ ] ytDlpTranscript() cleans up temp directory even on error (finally block)
- [ ] All functions have TypeScript types -- no any types

**Write Scope:** `src/browser/youtube.ts`, `src/browser/index.ts`
**Validation:** `npx tsc --noEmit`

**Agent:** nodejs-cli-senior-engineer
**Review:** none
**Priority:** P0

---

### TASK-002: YouTube transcript meta command and registry entry

Create `src/commands/meta/youtube.ts` as the command handler, register `youtube-transcript` in the command registry, and wire it into the meta dispatcher.

**Handler (src/commands/meta/youtube.ts):**
1. Export `handleYoutubeCommand(command, args, bm)` following existing meta handler patterns
2. Parse args: first positional arg is YouTube URL, optional `--lang <code>` flag
3. Call `ensureYtDlp()` -- if false, return clear error with install instructions
4. Call `ytDlpTranscript(url, lang)` from browser/youtube.ts
5. Format output: `Title: <title>\nLanguage: <lang>\nWords: <count>\n\n<transcript>`
6. On error (no captions): return the error message from ytDlpTranscript result

**Registry (src/automation/registry.ts):**
Add `m('youtube-transcript', 'Extract YouTube video transcript', ...)` with:
- usage: '<url> [--lang <code>]'
- safeToRetry: true
- MCP schema with url (required) and lang (optional) properties

**Meta dispatcher (src/commands/meta/index.ts):**
1. Import handleYoutubeCommand from './youtube'
2. Add `YOUTUBE_COMMANDS = new Set(['youtube-transcript'])`
3. Add routing block in handleMetaCommand

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] youtube-transcript appears in META_COMMANDS set (derived from registry)
- [ ] browse youtube-transcript <youtube-url> returns transcript text when yt-dlp is available
- [ ] browse youtube-transcript without URL throws usage error
- [ ] MCP schema has url (required) and lang (optional) properties
- [ ] When yt-dlp is not installed, returns helpful error message with install instructions

**Write Scope:** `src/commands/meta/youtube.ts`, `src/automation/registry.ts`, `src/commands/meta/index.ts`
**Validation:** `npx tsc --noEmit`

**Depends on:** TASK-001
**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P1

---

### TASK-003: Download inline base64 extension

Extend the existing download command in `src/commands/write.ts` (line 732-744) to support `--inline` flag. When set, the downloaded file content is returned as a base64 data URI instead of just a file path.

**Changes to write.ts download handler:**
1. Parse `--inline` flag from args
2. When `--inline`: save to temp path, read file, check size (max 20MB), encode base64, guess MIME type, return `data:<mime>;base64,<encoded>`, clean up temp file
3. When over 20MB: return error with temp path so caller can read directly
4. Without `--inline`: existing behavior unchanged

**Changes to registry.ts download entry:**
1. Add `inline` boolean to MCP inputSchema
2. Update argDecode for inline flag
3. Update MCP description

MIME type guessing: simple extension-based mapping (.png, .jpg, .webp, .gif, .svg, .pdf, .json, .csv, .txt, .html, .css, .js, default application/octet-stream).

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] browse download <selector> --inline returns data:<mime>;base64,<encoded> string
- [ ] browse download <selector> <path> (without --inline) behavior unchanged
- [ ] Files over 20MB with --inline return error with saved temp path
- [ ] MCP schema includes inline boolean property
- [ ] Temp file is cleaned up after successful inline read

**Write Scope:** `src/commands/write.ts`, `src/automation/registry.ts`
**Validation:** `npx tsc --noEmit`

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P1

---

### TASK-004: Netscape cookie format parity

Add Netscape cookie file (.txt) import support to the existing `cookie-import` command. The current implementation only handles Chromium browser SQLite databases (Chrome, Arc, Brave, Edge on macOS). This adds a `--file` flag to import from Netscape-format text files exported by browser extensions.

**New functions in src/browser/cookie-import.ts:**
1. `parseNetscapeCookieFile(text: string): PlaywrightCookie[]` -- Parse tab-separated Netscape format:
   - Strip BOM, skip comments (except #HttpOnly_), handle #HttpOnly_ prefix
   - 7+ fields: domain, subdomains-flag, path, secure, expires, name, value
   - Convert TRUE/FALSE to booleans, expires to number, sameSite default 'Lax'
2. `importNetscapeCookies(filePath: string, domain?: string): Promise<ImportResult>` -- Read, parse, filter

**Changes to src/commands/meta/auth.ts:**
1. Detect `--file <path>` flag in args
2. Route to importNetscapeCookies when --file present
3. Add cookies to browser context, return import count

**Changes to src/automation/registry.ts cookie-import entry:**
1. Add `file` property to MCP inputSchema
2. Update argDecode and description

**Type:** feature
**Effort:** M

**Acceptance Criteria:**
- [ ] parseNetscapeCookieFile() correctly parses standard Netscape cookie file format
- [ ] parseNetscapeCookieFile() handles #HttpOnly_ prefix, BOM, and malformed lines gracefully
- [ ] browse cookie-import --file cookies.txt imports cookies into browser context
- [ ] browse cookie-import --file cookies.txt --domain .example.com filters by domain
- [ ] Files over 5MB are rejected with clear error
- [ ] MCP schema includes file property
- [ ] Existing Chromium cookie import (browse cookie-import chrome) still works unchanged

**Write Scope:** `src/browser/cookie-import.ts`, `src/commands/meta/auth.ts`, `src/automation/registry.ts`
**Validation:** `npx tsc --noEmit`

**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P1

---

### TASK-005: Tests for YouTube transcript, download base64, and cookie import

Add tests for all three new features.

**YouTube parser unit tests (test/features.test.ts):**
- parseJson3(): valid JSON3 -> timestamped lines; empty events -> empty; malformed JSON -> null
- parseVtt(): valid VTT -> timestamped lines with HTML entities decoded; nested HTML tags stripped
- parseXml(): valid XML/srv3 -> timestamped lines
- normalizeYoutubeUrl(): valid YouTube URLs accepted; non-YouTube hosts rejected; non-https rejected
- normalizeLanguage(): valid codes pass through; invalid default to 'en'

**Download inline integration test (test/interactions.test.ts):**
- download --inline returns base64 data URI using existing /download/test.txt fixture
- Decode base64 and verify content matches 'test file content'
- Existing download-to-disk test unchanged

**Netscape cookie parser unit tests (test/features.test.ts):**
- Standard 7-field tab-separated lines parsed correctly
- #HttpOnly_ prefix sets httpOnly flag
- Comment lines and empty lines skipped
- Lines with fewer than 7 fields skipped
- BOM stripped; secure TRUE/FALSE conversion correct

**Cookie import integration test:**
- Create temp Netscape cookie file, import with --file, verify cookies in context

**Type:** test
**Effort:** M

**Acceptance Criteria:**
- [ ] All YouTube parser unit tests pass
- [ ] Download --inline integration test verifies base64 data URI format and content correctness
- [ ] Netscape cookie parser unit tests cover standard format, HttpOnly prefix, BOM, malformed lines
- [ ] Cookie import --file integration test verifies cookies loaded into browser context
- [ ] All existing tests continue to pass (no regressions)

**Write Scope:** `test/features.test.ts`, `test/interactions.test.ts`
**Validation:** `npm test`

**Depends on:** TASK-002, TASK-003, TASK-004
**Agent:** nodejs-cli-senior-engineer
**Review:** claude
**Priority:** P2

---

## Failure Modes

| Risk | Affected Tasks | Mitigation |
|------|---------------|------------|
| yt-dlp not installed -- transcript command fails with unhelpful error | TASK-001, TASK-002 | ensureYtDlp() returns false. Handler returns: 'yt-dlp not installed. Install: brew install yt-dlp or pip install yt-dlp' |
| yt-dlp subprocess hangs on slow networks | TASK-001 | All yt-dlp calls have explicit timeouts (15s title, 30s subtitles). Safe env. maxBuffer 4MB |
| Download inline exceeds memory for large files (>20MB) | TASK-003 | MAX_DOWNLOAD_INLINE_BYTES = 20MB hard limit. Oversized files return error with disk path |
| Netscape cookie file has malformed lines or unexpected encoding | TASK-004 | Parser skips malformed lines (<7 fields). BOM stripping. Invalid lines ignored, not errors |
| YouTube video has no captions | TASK-002 | Clean error response: 'No captions available for this video' with video URL and title |

## Ship Cut

- **Minimum shippable:** TASK-001 + TASK-002 = YouTube transcript via yt-dlp works end-to-end
- **Full feature set:** All 5 tasks = YouTube transcripts + download inline + Netscape cookie import with full test coverage

## Test Coverage Map

| New Codepath | Covering Task | Test Type |
|-------------|--------------|-----------|
| parseJson3() parses YouTube JSON3 captions | TASK-005 | unit |
| parseVtt() parses WebVTT captions | TASK-005 | unit |
| parseXml() parses XML/srv3 captions | TASK-005 | unit |
| normalizeYoutubeUrl() validates YouTube URLs | TASK-005 | unit |
| normalizeLanguage() validates language codes | TASK-005 | unit |
| download --inline returns base64 data URI | TASK-005 | integration |
| download --inline oversized file returns error | TASK-005 | unit |
| parseNetscapeCookieFile() parses standard format | TASK-005 | unit |
| parseNetscapeCookieFile() handles #HttpOnly_ prefix | TASK-005 | unit |
| parseNetscapeCookieFile() skips malformed lines | TASK-005 | unit |
| cookie-import --file loads Netscape cookies | TASK-005 | integration |
| youtube-transcript registered in CommandRegistry | TASK-005 | unit |

## Execution Summary

| Item | Value |
|------|-------|
| Task Count | 5 |
| Layer Count | 3 |
| Critical Path | TASK-001 -> TASK-002 -> TASK-005 |

### Parallel Layers

| Layer | Tasks | Notes |
|-------|-------|-------|
| 0 | TASK-001, TASK-003, TASK-004 | Independent: yt-dlp helpers, download inline, Netscape cookies |
| 1 | TASK-002 | YouTube command handler (depends on TASK-001) |
| 2 | TASK-005 | Tests for all features (depends on TASK-002, TASK-003, TASK-004) |

## Task Dependencies

```json
{
  "TASK-001": [],
  "TASK-002": ["TASK-001"],
  "TASK-003": [],
  "TASK-004": [],
  "TASK-005": ["TASK-002", "TASK-003", "TASK-004"]
}
```
