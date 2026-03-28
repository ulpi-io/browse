---
name: bugfix
version: 3.0.0
description: |
  Fix bugs found by /find-bugs, reported by the user, or encountered during development.
  Systematically reproduces, diagnoses root cause, plans minimal fix, implements with
  regression tests, verifies no regressions, and reports results. Includes bug-type-specific
  fix playbooks for security, logic, async, null safety, race conditions, and more.
  Includes framework-specific reference files for 18 frameworks/languages (Express, React,
  Next.js, Fastify, Hono, Remix, Laravel, Go, Gin, Echo, Fiber, Swift, Bun, Rust,
  Axum, Actix Web, Rocket, React Native). Handles single bugs, multi-file bugs, and batch fixes from find-bugs output.
  Invoke via /bugfix or when user says "fix this bug", "fix the findings",
  "fix finding #3", "fix the critical bugs".
---

<EXTREMELY-IMPORTANT>
Before fixing ANY bug, you **ABSOLUTELY MUST**:

1. Write a failing test that reproduces the bug BEFORE writing any fix code
2. Identify the root cause — not just the symptom
3. Understand all callers and dependents of the code you will change
4. Run existing tests to establish a passing baseline
5. Plan the minimal fix that addresses the root cause without side effects
6. After fixing, confirm the failing test now passes

**Fixing without a reproducer = guessing. Fixing without diagnosis = wrong fix. Both = wasted time.**

This is not optional. Every fix requires a reproducer and root-cause analysis.
</EXTREMELY-IMPORTANT>

# Bugfix

## MANDATORY FIRST RESPONSE PROTOCOL

Before fixing ANY bug, you **MUST** complete this checklist:

1. ☐ Parse the bug source (find-bugs output, user report, or observed failure)
2. ☐ Read the relevant code thoroughly (not just the flagged line — the full function, its callers, and its tests)
3. ☐ Write a failing test that reproduces the exact bug (Red phase)
4. ☐ Identify the root cause by tracing data flow from entry to failure point
5. ☐ Map the blast radius (callers, importers, dependents, type consumers)
6. ☐ Run existing tests to establish a passing baseline (the new reproducer should be the only new failure)
7. ☐ Plan the minimal fix (smallest change that addresses root cause)
8. ☐ Announce: "Fixing [N] bug(s): [brief description]. Root cause: [cause]. Blast radius: [scope]."

**Fixing bugs WITHOUT completing this checklist = wrong fixes and regressions.**

## Overview

Diagnose and fix bugs with surgical precision. Every fix follows a strict red-green workflow: reproduce the bug with a failing test, diagnose the root cause, implement the minimal fix, confirm the test goes green, verify no regressions.

**What this skill does:**

- Parses structured findings from `/find-bugs` or freeform user reports
- Writes a failing test that captures the exact bug scenario BEFORE any fix code
- Traces from symptom to root cause through systematic data-flow analysis
- Applies bug-type-specific fix playbooks (security, logic, async, null, race conditions)
- Implements minimal fixes with defense-in-depth hardening where appropriate
- Verifies fixes work and introduces no regressions
- Reports root cause, fix rationale, files changed, and tests added

**What this skill does NOT do:**

- Refactor surrounding code (fix only — use `/code-simplify` for cleanup)
- Add features beyond what the fix requires
- Fix style or formatting issues (those are not bugs)
- Guess at fixes without understanding the root cause
- Skip the reproducer test ("it's a simple change" is never an excuse)

## When to Use

- User says "fix this bug", "fix the findings", "fix finding #3", "/bugfix"
- User pastes a `/find-bugs` report and asks to fix some or all findings
- User describes a bug (error message, wrong behavior, crash)
- User points to a specific line or function and says "this is broken"
- $ARGUMENTS provided as guidance (e.g., `/bugfix fix the SQL injection in auth.ts`)

**Never fix proactively.** Only when explicitly requested.

## When NOT to Use

- **No confirmed bug** — if the code works correctly, there is nothing to fix
- **Feature request** — if the user wants new behavior, that is a feature, not a bugfix
- **Style/formatting** — cosmetic issues are not bugs
- **Architecture redesign needed** — if the fix requires rethinking the design, discuss with the user first
- **Unclear requirements** — if you cannot determine what "correct" means, ask before fixing

---

## Step 0: Detect Framework and Load Reference

**Gate: Framework identified and reference file read before proceeding to Step 1.**

Before diagnosing any bug, identify the framework/language and **read the corresponding reference file** from the `references/` directory alongside this skill. The reference files contain framework-specific bug patterns, idiomatic fixes, common traps, and testing patterns that are critical for accurate diagnosis and correct fixes.

### Detection Rules

Identify the framework from the buggy file's imports, the project's dependency files, and the file extension:

| Signal                                      | Framework          | Reference File                    |
| ------------------------------------------- | ------------------ | --------------------------------- |
| `package.json` has `express`                | Express.js         | `references/expressjs.md`         |
| `package.json` has `react` + JSX/TSX files  | React              | `references/react.md`             |
| `package.json` has `react-native` or `expo` | React Native       | `references/react-native.md`      |
| `package.json` has `next`                   | Next.js            | `references/nextjs.md`            |
| `package.json` has `fastify`                | Fastify            | `references/fastify.md`           |
| `package.json` has `hono`                   | Hono               | `references/hono.md`              |
| `package.json` has `@remix-run/react`       | Remix              | `references/remix.md`             |
| `bun.lockb` or `bunfig.toml` present        | Bun                | `references/bun.md`               |
| `composer.json` has `laravel/framework`     | Laravel            | `references/laravel.md`           |
| `go.mod` present                            | Go                 | `references/golang.md`            |
| `go.mod` has `github.com/gin-gonic/gin`     | Go + Gin           | `references/go-gin.md`            |
| `go.mod` has `github.com/labstack/echo`     | Go + Echo          | `references/go-echo.md`           |
| `go.mod` has `github.com/gofiber/fiber`     | Go + Fiber         | `references/go-fiber.md`          |
| `.swift` files, `Package.swift`             | Swift              | `references/swift.md`             |
| `Cargo.toml` present, `.rs` files           | Rust               | `references/rust.md`              |
| `Cargo.toml` has `axum`                     | Rust + Axum        | `references/rust-axum.md`         |
| `Cargo.toml` has `actix-web`                | Rust + Actix Web   | `references/rust-actix.md`        |
| `Cargo.toml` has `rocket`                   | Rust + Rocket      | `references/rust-rocket.md`       |
| `.ts`/`.js` files (no specific framework)   | Node.js/TypeScript | `references/nodejs-typescript.md` |

### Loading Rules

1. **Always load the base reference** — for Node.js projects, always read `nodejs-typescript.md`; for Go projects, always read `golang.md`; for Rust projects, always read `rust.md`
2. **Layer framework-specific reference on top** — if using Express, read BOTH `nodejs-typescript.md` AND `expressjs.md`; if using Axum, read BOTH `rust.md` AND `rust-axum.md`
3. **React Native includes React** — read both `react.md` and `react-native.md`
4. **Next.js/Remix include React** — read both `react.md` and the framework file
5. **Go frameworks layer on Go** — read both `golang.md` and the framework file (e.g., `go-gin.md`)
6. **Rust frameworks layer on Rust** — read both `rust.md` and the framework file (e.g., `rust-axum.md`)
7. **If the framework is unknown**, fall back to the language-level reference

Read the reference file(s) using the Read tool. The file path is relative to this skill's directory.

### Why This Matters

Framework-specific bugs are the most common source of incorrect fixes. For example:

- Fixing a Fastify validation bug with Express-style middleware won't work (Fastify uses JSON Schema)
- Fixing a Fiber request bug without `copy()` will cause memory corruption (fasthttp pools request data)
- Fixing a Next.js auth bug in a page component misses that Server Actions need separate auth checks
- Fixing a Go error without checking the return value is the #1 Go bug pattern

The reference files prevent these mistakes by providing the idiomatic fix pattern for each framework.

---

## Step 1: Parse the Bug

**Gate: Bug(s) clearly identified with location, description, and category before proceeding to Step 2.**

### From `/find-bugs` Output

If the user provides structured findings from `/find-bugs`, parse each finding:

- **Finding number** — e.g., Finding #1, Finding #3
- **File:Line** — exact location
- **Severity** — Critical / High / Medium / Low
- **Category** — Security (injection, XSS, auth, etc.) / Logic Bug / Code Quality
- **Problem** — what is wrong
- **Evidence** — why it's real (from find-bugs verification)
- **Attack vector** — how it can be exploited (security issues)
- **Fix suggestion** — the suggested approach (use as starting point, not gospel)

If the user says "fix all critical bugs" or "fix findings 1, 3, 5":

1. Extract the specified findings
2. Sort by severity (Critical first)
3. Group findings that touch the same file or function (fix together to avoid edit conflicts)
4. Build a dependency graph: does fixing #1 change code that #3 depends on?
5. Identify which **fix playbook** (Step 5) applies to each finding

### From User Report

If the user describes a bug in their own words:

1. Extract the **symptom** (what goes wrong — error message, wrong output, crash, hang)
2. Extract the **trigger** (what action causes it — specific input, API call, sequence of events)
3. Extract the **expected behavior** (what should happen instead)
4. Extract the **location** (file, function, endpoint — if provided)
5. Extract the **frequency** (always, intermittent, only under load — critical for race conditions)

If any of symptom, trigger, or expected behavior are missing, ask before proceeding:

```
To fix this bug, I need to understand:
- What goes wrong? (error message, wrong output, crash)
- What triggers it? (specific input, action, sequence)
- What should happen instead?
- How often? (always, sometimes, only under load)
- Where in the code? (file/function if known)
```

### From Observed Failure

If you encounter a bug during other work (test failure, build error, runtime crash):

1. Capture the **exact error output** (full stack trace, not just the message)
2. Identify the **failing test or build step** (which command, which assertion)
3. Parse the **stack trace** — read bottom-to-top for the call chain, identify the frame in project code (skip node_modules/framework frames)
4. Trace to the **source file and line** from the stack
5. Check `git log --oneline -5 -- <file>` — is this a recent regression?

---

## Step 2: Reproduce the Bug (Red Phase)

**Gate: A failing test exists that captures the exact bug scenario before proceeding to Step 3.**

**This is the most important step.** A fix without a reproducer is guessing. Write the test FIRST.

### 2.1 Find the Test File

```bash
# Tests live alongside source: src/foo.test.ts next to src/foo.ts
# Check for existing test file
```

Use the Glob tool to find `*.test.ts` or `*.spec.ts` files adjacent to the buggy source file. If no test file exists, create one following the project's test patterns.

### 2.2 Write the Failing Test

Write a test that captures the EXACT scenario from the bug report:

```typescript
describe("[module/function name]", () => {
  it("should [expected behavior] when [condition that triggers bug]", () => {
    // Arrange: set up the exact scenario from the bug report
    // - Use the specific input that triggers the bug
    // - Set up the exact state that causes the failure
    // Act: trigger the operation
    // Assert: verify the CORRECT behavior (what SHOULD happen)
    // This assertion should FAIL with the current buggy code
  });
});
```

**Naming convention:** The test name should describe the correct behavior, not the bug. "should sanitize SQL in user input" not "should not have SQL injection."

### 2.3 Run the Test and Confirm It Fails

```bash
# Run just the new test to confirm it fails
pnpm --filter <package> test -- --reporter=verbose <test-file>
```

**The test MUST fail.** If it passes, either:

- The bug doesn't exist (re-examine the report)
- Your test doesn't capture the right scenario (rewrite it)
- The bug is in a different layer than you think (widen the search)

**If you cannot reproduce the bug:**

1. **Check the environment** — Does the bug require specific config, env vars, or database state?
2. **Check the input** — Is the triggering input more specific than you assumed? Try exact values from the report.
3. **Check for intermittency** — Is this a race condition that only happens under concurrency? (See Race Condition Playbook)
4. **Check the version** — Has the code changed since the bug was reported? Run `git log` on the file.
5. **Ask the user** — "I cannot reproduce this bug with the current code. Can you provide the exact input/steps?"

**Never proceed to fix code you cannot prove is broken.** If you truly can't reproduce after these steps, report back to the user with what you tried.

### 2.4 Write Additional Edge Case Tests

While you're in the test file, also write tests for related edge cases the fix should handle:

- **Null/undefined input** (if the bug is about missing data)
- **Empty collection** (if the bug is about array/object handling)
- **Boundary values** (if the bug is about off-by-one or limits)
- **Malicious input** (if the bug is a security vulnerability)

These tests may pass or fail — that's fine. They document the expected behavior and prevent future regressions.

---

## Step 3: Diagnose Root Cause

**Gate: Root cause identified and distinguished from symptom before proceeding to Step 4.**

Now that you have a failing test proving the bug exists, find WHY it exists.

### 3.1 Read the Code — Thoroughly

Read the **complete function/module** where the bug lives. Not just the flagged line — the full context:

1. Read the buggy function in its entirety (use the Read tool)
2. Read the function's callers — who calls this and with what arguments?
3. Read the function's dependencies — what does it call and what does it expect back?
4. Read the type definitions for all parameters and return values
5. Read the test file — what scenarios ARE covered? What's missing?

```bash
# Check git history for the area — was this a recent change?
git log --oneline -10 -- <file-path>

# Who last touched the buggy lines?
git log -1 --format='%h %s (%an, %ar)' -- <file-path>
```

**For regressions** (something that used to work), use git bisect:

```bash
# Find the commit that introduced the bug
git log --oneline --all -- <file-path>
# Then read the diff of the suspicious commit
git show <commit-hash> -- <file-path>
```

### 3.2 Trace the Data Flow

Follow data from entry point to failure, mapping every transformation:

```
ENTRY: [where data enters] (request handler, function param, config read, DB query)
  │
  ├── Validation: [is input validated?] [what constraints?] [can invalid data pass?]
  │
  ├── Transformation 1: [what happens to the data?] [can this produce unexpected output?]
  │
  ├── Transformation 2: [next step] [assumptions about input from step 1?]
  │
  ├── ...
  │
  └── FAILURE POINT: [where it breaks] [what value causes the break?] [why?]
```

At each step ask:

- What values can this produce?
- What does the next step ASSUME about its input?
- Can the output of this step violate the assumption of the next step?

**The root cause is at the FIRST point where an assumption is violated.**

### 3.3 Classify the Bug

Identify which category the bug falls into — this determines which **fix playbook** to use in Step 5:

| Category                  | Signals                                           | Fix Playbook            |
| ------------------------- | ------------------------------------------------- | ----------------------- |
| **SQL/Command Injection** | User input concatenated into query/command string | §5.1 Injection Fix      |
| **XSS**                   | User input rendered in HTML without escaping      | §5.2 XSS Fix            |
| **Auth/AuthZ Bypass**     | Missing or incorrect auth check, IDOR             | §5.3 Auth Fix           |
| **Null/Undefined Error**  | Property access on potentially null value         | §5.4 Null Safety Fix    |
| **Race Condition**        | TOCTOU, concurrent modification, double-submit    | §5.5 Race Condition Fix |
| **Off-by-One / Boundary** | Wrong loop bound, array index, pagination         | §5.6 Boundary Fix       |
| **Async/Promise Error**   | Missing await, unhandled rejection, stale closure | §5.7 Async Fix          |
| **Type Coercion / Cast**  | Wrong type assumption, implicit conversion        | §5.8 Type Safety Fix    |
| **Resource Leak**         | Unclosed connection, handle, listener, timer      | §5.9 Resource Leak Fix  |
| **Logic / Business Rule** | Wrong conditional, missing state transition check | §5.10 Logic Fix         |

### 3.4 Distinguish Root Cause from Symptom

| What You See           | Likely Symptom     | Dig Deeper For Root Cause                                            |
| ---------------------- | ------------------ | -------------------------------------------------------------------- |
| Null pointer exception | Missing null check | Why is the value null? Who should have provided it?                  |
| Wrong query results    | Bad WHERE clause   | Is the data model wrong? Are joins missing? Is the filter inverted?  |
| Auth bypass            | Missing middleware | Is the route registration wrong? Is the middleware order wrong?      |
| Race condition         | Missing lock       | Is the design inherently concurrent? Should it be serial?            |
| Type error at runtime  | Wrong cast         | Is the type definition wrong upstream? Is the API contract violated? |
| Timeout                | Slow query         | Is there an N+1 query? Missing index? Unbounded result set?          |
| Memory leak            | Growing collection | Who should be cleaning up? Is there a missing `removeListener`?      |

**The root cause is the first thing that goes wrong in the chain, not the last.**

### 3.5 Map the Blast Radius

Before planning a fix, map everything the change will affect:

Search for (using the Grep tool, not bash grep):

- **Direct callers** — functions/methods that invoke the buggy code
- **Importers** — every file that imports the module
- **Type consumers** — code that depends on the type signatures you might change
- **Tests** — all tests covering the affected code paths
- **Config/routes** — registration of routes, middleware, plugins that reference this code
- **Downstream consumers** — if this is a library/package, who depends on it?

```bash
# Check cross-package dependents in monorepo
pnpm why <package-name>
```

Document: "Changing `functionName` in `file.ts` will affect: [list of callers], tested by: [list of test files], imported by: [list of importers]."

### 3.6 Confirm the Diagnosis

Before proceeding, pass these gates:

1. **One-sentence test:** Can you explain the root cause in one sentence? If not, keep digging.
2. **Completeness test:** Does your explanation account for ALL symptoms? If the user reports two issues and your root cause only explains one, there may be two bugs or a deeper shared cause.
3. **Simplicity test:** Is there a simpler explanation? Prefer the simplest root cause that explains all symptoms (Occam's razor).
4. **Prediction test:** Does your diagnosis predict what your failing test does? If your root cause is correct, you should be able to predict exactly WHY the test fails and with what values.

---

## Step 4: Plan the Fix

**Gate: Fix plan complete, minimal, and matched to the correct playbook before proceeding to Step 5.**

### 4.1 Design the Minimal Fix

The best fix is the smallest change that addresses the root cause:

| Principle                              | Why                                                      |
| -------------------------------------- | -------------------------------------------------------- |
| Fix at the root cause, not the symptom | Symptom fixes mask the real problem; it resurfaces later |
| Change as few files as possible        | Smaller blast radius = fewer regressions                 |
| Change as few lines as possible        | Less to review, less to go wrong                         |
| Don't refactor alongside the fix       | Mixing fix + refactor makes review impossible            |
| Don't add features alongside the fix   | Scope creep obscures the fix                             |
| Preserve behavior for non-buggy paths  | Only fix what is broken                                  |
| Match the fix to the bug category      | Use the right playbook (Step 5), not a generic patch     |

### 4.2 Consider Edge Cases in the Fix

For the planned fix, check each:

- [ ] **Empty case** — does the fix handle empty arrays, null, undefined, empty strings?
- [ ] **Error case** — does the fix handle network failures, invalid input, timeouts?
- [ ] **Concurrent access** — does the fix handle parallel requests? (if relevant)
- [ ] **Existing tests** — will the fix break any existing assertions? (read them)
- [ ] **New dependency** — does the fix require importing something new? (avoid if possible)
- [ ] **Performance** — does the fix add a query, loop, or allocation in a hot path?
- [ ] **Backwards compatibility** — does the fix change a public API? (flag to user)

### 4.3 Plan Defense-in-Depth

After fixing the immediate bug, consider whether a **structural guard** would prevent the entire class of bug from recurring:

| Bug Class      | Defense-in-Depth Option                                              |
| -------------- | -------------------------------------------------------------------- |
| Null access    | TypeScript strict null checks, `NonNullable<T>`, assertion function  |
| Injection      | Parameterized query builder, tagged template validation              |
| Missing auth   | Route-level middleware that requires explicit opt-out                |
| Type mismatch  | Zod schema at the boundary, runtime validation                       |
| Race condition | Database transaction, optimistic locking column                      |
| Resource leak  | `using` declaration (TC39 Explicit Resource Management), try/finally |

**Only add defense-in-depth if it's a small, focused addition.** If it requires architectural changes, note it in the report as a recommendation for future work.

### 4.4 Create a Rollback Checkpoint

Before making any code changes, ensure you can revert cleanly:

```bash
# Stash any unrelated uncommitted work
git stash --include-untracked --message "pre-bugfix checkpoint"

# Or if on a clean working tree, just note the current HEAD
git rev-parse HEAD
```

If the fix goes wrong mid-implementation, you can:

```bash
# Revert all changes since the checkpoint
git checkout -- .
# Or restore the stash
git stash pop
```

### 4.5 Present the Plan (for significant fixes)

For High/Critical severity, multi-file changes, security fixes, or fixes that touch public API — present the plan before implementing:

```
## Fix Plan

**Bug:** [one-sentence description]
**Root Cause:** [one-sentence explanation — WHY, not just WHAT]
**Category:** [from §3.3 classification] → using [Playbook §5.X]
**Blast Radius:** [N files affected] — [list callers/dependents]

**Reproducer Test:**
- `test-file:line` — [test name] — currently FAILING ✗

**Changes:**
1. [file:line] — [what will change and why]
2. [file:line] — [what will change and why]

**Defense-in-Depth:** [structural guard to add, or "none needed"]

**Edge Cases Considered:**
- [case] — handled by [how]
- [case] — handled by [how]

**Risk:** [Low/Medium/High] — [why]
```

For simple, obvious fixes (Low severity, single-line, clear root cause, no public API change), proceed directly — don't over-ceremony a typo fix.

---

## Step 5: Implement the Fix (Green Phase)

**Gate: All planned changes applied, reproducer test passes, no regressions before proceeding to Step 6.**

### General Implementation Rules

1. Edit files using the Edit tool (not sed/awk)
2. Apply changes one logical unit at a time
3. After each edit, verify the file is syntactically valid
4. If the fix cascades (changing a type requires updating callers), follow the chain completely
5. Follow existing code style (indentation, naming, patterns)
6. Fix ONLY what the bug requires — nothing more
7. Follow project conventions from CLAUDE.md:
   - ESM only (`import`/`export`, no `require`)
   - Bare imports (`from "@ulpi/contracts"`, no `/dist/` paths)
   - `execFileSync` with arg arrays (never `execSync` with template strings)

### After applying each change, run the reproducer test:

```bash
pnpm --filter <package> test -- --reporter=verbose <test-file> -t "<test-name>"
```

The reproducer test should go from **RED (failing) → GREEN (passing)** after the fix is applied. If it's still failing, the fix is incomplete or wrong.

---

### §5.1 Injection Fix Playbook (SQL, Command, Template, Path)

**Root cause pattern:** User-controlled input concatenated into a query, command, template, or path string.

**Fix approach — always parameterize, never sanitize:**

```typescript
// ✗ WRONG — string concatenation (the bug)
const result = db.query(`SELECT * FROM users WHERE id = '${userId}'`);

// ✗ WRONG — blocklist sanitization (incomplete fix — will be bypassed)
const safeId = userId.replace(/['";\-\-]/g, "");
const result = db.query(`SELECT * FROM users WHERE id = '${safeId}'`);

// ✓ CORRECT — parameterized query (the fix)
const result = db.query("SELECT * FROM users WHERE id = $1", [userId]);
```

**For command injection:**

```typescript
// ✗ WRONG — shell interpolation
execSync(`git log --author="${author}"`);

// ✓ CORRECT — arg array, no shell
execFileSync("git", ["log", `--author=${author}`]);
```

**For path traversal:**

```typescript
// ✗ WRONG — direct concatenation
const filePath = path.join(uploadDir, req.params.filename);

// ✓ CORRECT — resolve and verify within boundary
const filePath = path.resolve(uploadDir, req.params.filename);
if (!filePath.startsWith(path.resolve(uploadDir))) {
  throw new Error("Path traversal attempt");
}
```

**Verification checklist for injection fixes:**

- [ ] Is the input parameterized (not concatenated)?
- [ ] Does the test include a payload that would exploit the original vulnerability? (e.g., `'; DROP TABLE users; --`)
- [ ] Are ALL code paths that use this input parameterized? (search for other usages)
- [ ] If using an ORM, are raw query escapes also parameterized?

---

### §5.2 XSS Fix Playbook

**Root cause pattern:** User-controlled input rendered in HTML output without escaping.

**Fix approach — escape at output, not input:**

```typescript
// ✗ WRONG — innerHTML with user data
element.innerHTML = `<p>${userComment}</p>`;

// ✓ CORRECT — textContent (auto-escapes)
const p = document.createElement('p');
p.textContent = userComment;
element.appendChild(p);

// ✓ CORRECT — React (auto-escapes by default)
return <p>{userComment}</p>;

// ✗ WRONG — React dangerouslySetInnerHTML
return <div dangerouslySetInnerHTML={{ __html: userComment }} />;
```

**Verification checklist for XSS fixes:**

- [ ] Does the test include a `<script>alert(1)</script>` payload?
- [ ] Is every output point for this data escaped? (search for all render sites)
- [ ] Are URL parameters also sanitized? (`javascript:` protocol, data URIs)
- [ ] If using a framework that auto-escapes, is `dangerouslySetInnerHTML`/`{!! !!}`/`| safe` avoided?

---

### §5.3 Auth/AuthZ Fix Playbook

**Root cause pattern:** Missing authentication check, missing authorization check, or direct object reference without ownership validation.

**Fix approach — deny by default, check explicitly:**

```typescript
// ✗ WRONG — no auth check on route
router.get("/api/users/:id/settings", getSettings);

// ✓ CORRECT — auth middleware + ownership check
router.get("/api/users/:id/settings", requireAuth, async (req, res) => {
  const user = await getUser(req.params.id);
  if (user.id !== req.user.id && !req.user.isAdmin) {
    return res.status(403).json({ error: "Forbidden" });
  }
  return res.json(await getSettings(req.params.id));
});
```

**For IDOR (Insecure Direct Object Reference):**

```typescript
// ✗ WRONG — trusts the ID from the URL
const order = await db.orders.findById(req.params.orderId);

// ✓ CORRECT — scopes query to authenticated user
const order = await db.orders.findOne({
  id: req.params.orderId,
  userId: req.user.id, // ownership check
});
if (!order) return res.status(404).json({ error: "Not found" });
```

**Verification checklist for auth fixes:**

- [ ] Does the test verify that unauthenticated requests are rejected (401)?
- [ ] Does the test verify that unauthorized users cannot access other users' data (403)?
- [ ] Are ALL endpoints for this resource protected? (list endpoints, check each)
- [ ] Is the auth check in middleware (not repeated inline in each handler)?
- [ ] Is the ownership check scoped to the query (not a post-fetch check that leaks timing)?

---

### §5.4 Null Safety Fix Playbook

**Root cause pattern:** Property access or method call on a value that can be null/undefined at runtime.

**Fix approach — fix the SOURCE of null, not just the access site:**

```typescript
// ✗ WEAK — null guard at the symptom (masks the real issue)
const name = user?.name ?? "Unknown";

// FIRST: Ask WHY user is null
// If user SHOULD always exist (e.g., after auth middleware):
//   → Fix the middleware/provider that should guarantee non-null
// If user CAN legitimately be null (e.g., optional lookup):
//   → Handle the null case with appropriate business logic

// ✓ CORRECT — handle at the business logic level
const user = await findUser(id);
if (!user) {
  return res.status(404).json({ error: "User not found" });
}
// user is now narrowed to non-null by TypeScript
processUser(user); // no optional chaining needed
```

**When optional chaining IS appropriate:**

- Data from external APIs where schema is not guaranteed
- Optional configuration values with sensible defaults
- Display logic where missing data should show fallback UI

**Verification checklist for null fixes:**

- [ ] Did you fix the SOURCE of null, or just guard the access? (Prefer fixing the source)
- [ ] Does the test cover the null case with an explicit assertion?
- [ ] Is the TypeScript type accurate? (If the value can be null, the type should include `| null`)
- [ ] If you added a null guard, does the else branch have appropriate behavior? (Not just `return` or swallow)

---

### §5.5 Race Condition Fix Playbook

**Root cause pattern:** TOCTOU (time-of-check-time-of-use), concurrent modification without synchronization, double-submit.

**Fix approach — make the operation atomic:**

```typescript
// ✗ WRONG — TOCTOU: check then update (race window between check and update)
const balance = await getBalance(userId);
if (balance >= amount) {
  await deductBalance(userId, amount); // another request could deduct between check and here
}

// ✓ CORRECT — atomic operation with transaction
await db.transaction(async (tx) => {
  const { balance } = await tx.query(
    "SELECT balance FROM accounts WHERE user_id = $1 FOR UPDATE", // row lock
    [userId],
  );
  if (balance < amount) throw new InsufficientFundsError();
  await tx.query(
    "UPDATE accounts SET balance = balance - $1 WHERE user_id = $2",
    [amount, userId],
  );
});
```

**For idempotency (double-submit):**

```typescript
// ✓ Use idempotency key
router.post("/api/payments", async (req, res) => {
  const idempotencyKey = req.headers["idempotency-key"];
  const existing = await db.payments.findByKey(idempotencyKey);
  if (existing) return res.json(existing); // return cached result
  // ... process payment
});
```

**For optimistic locking:**

```typescript
// ✓ Use version column
const result = await db.query(
  "UPDATE items SET data = $1, version = version + 1 WHERE id = $2 AND version = $3",
  [newData, itemId, expectedVersion],
);
if (result.rowCount === 0) throw new ConcurrentModificationError();
```

**Verification checklist for race condition fixes:**

- [ ] Is the critical section atomic? (Single query, transaction, or mutex)
- [ ] Does the test simulate concurrent access? (Multiple simultaneous calls)
- [ ] Is the fix correct under retry? (Idempotent operations)
- [ ] Are there other code paths to the same shared state? (Check all writers)

---

### §5.6 Boundary / Off-by-One Fix Playbook

**Root cause pattern:** Wrong loop bound, array index, pagination offset, slice endpoint.

**Fix approach — reason about the boundaries explicitly:**

```typescript
// ✗ WRONG — off-by-one in pagination
const items = data.slice(page * pageSize, page * pageSize + pageSize - 1);
//                                                                   ^^^ slice end is exclusive, so this misses the last item

// ✓ CORRECT
const start = page * pageSize;
const items = data.slice(start, start + pageSize); // slice end is exclusive, so this gets exactly pageSize items
```

**Boundary reasoning template:**

```
Value range: [min, max] (inclusive or exclusive?)
Loop: for (i = START; i COMPARISON BOUND; i INCREMENT)
  - First iteration: i = ?
  - Last iteration: i = ?
  - Total iterations: ?
  - Does this match the expected count?
```

**Verification checklist for boundary fixes:**

- [ ] Test with boundary values: 0, 1, max, max+1
- [ ] Test with empty input (length 0)
- [ ] Test with single element (length 1)
- [ ] Verify inclusive vs exclusive bounds are consistent
- [ ] Check if the same boundary logic exists elsewhere (DRY it if repeated)

---

### §5.7 Async / Promise Fix Playbook

**Root cause pattern:** Missing `await`, unhandled rejection, stale closure, promise returned but not awaited.

**Fix approach — ensure every async operation is awaited and errors are caught:**

```typescript
// ✗ WRONG — missing await (error is silently swallowed)
async function processItems(items: Item[]) {
  items.forEach(async (item) => {
    // forEach doesn't await the callback!
    await processItem(item);
  });
  // Returns here BEFORE any items are processed
}

// ✓ CORRECT — use for...of or Promise.all
async function processItems(items: Item[]) {
  // Sequential:
  for (const item of items) {
    await processItem(item);
  }
  // Or parallel:
  await Promise.all(items.map((item) => processItem(item)));
}
```

**For stale closures:**

```typescript
// ✗ WRONG — stale closure captures initial value
useEffect(() => {
  const interval = setInterval(() => {
    setCount(count + 1); // always uses the count from when effect was created
  }, 1000);
  return () => clearInterval(interval);
}, []); // empty deps = stale closure

// ✓ CORRECT — functional updater
useEffect(() => {
  const interval = setInterval(() => {
    setCount((prev) => prev + 1); // uses current value
  }, 1000);
  return () => clearInterval(interval);
}, []);
```

**Verification checklist for async fixes:**

- [ ] Is every `async` function call `await`-ed? (Search for calls without `await`)
- [ ] Are `.forEach(async ...)` patterns replaced with `for...of` or `Promise.all`?
- [ ] Are promise rejections caught? (try/catch or `.catch()`)
- [ ] Does the test verify the operation completes before assertions run?
- [ ] For React: are effect cleanup functions correct? Are deps arrays complete?

---

### §5.8 Type Safety Fix Playbook

**Root cause pattern:** Runtime type doesn't match compile-time type, implicit coercion, wrong `as` cast.

**Fix approach — validate at boundaries, trust within:**

```typescript
// ✗ WRONG — trusting external data matches TypeScript type
const data = JSON.parse(body) as UserInput; // as-cast provides zero runtime safety

// ✓ CORRECT — validate with Zod at the boundary
import { UserInputSchema } from "@ulpi/contracts";
const data = UserInputSchema.parse(JSON.parse(body)); // throws on invalid input
```

```typescript
// ✗ WRONG — loose equality allows type coercion
if (userId == 0) { ... }  // '' == 0 is true!

// ✓ CORRECT — strict equality
if (userId === 0) { ... }
```

**Verification checklist for type fixes:**

- [ ] Is external data (API, user input, DB) validated at the boundary?
- [ ] Are `as` casts replaced with runtime validation? (Search for `as` in the file)
- [ ] Is `===` used instead of `==`? (Search for `==` in the file)
- [ ] Does the TypeScript type accurately reflect all possible runtime values?

---

### §5.9 Resource Leak Fix Playbook

**Root cause pattern:** Unclosed file handle, database connection, event listener, timer, WebSocket.

**Fix approach — ensure cleanup in all code paths (success, error, early return):**

```typescript
// ✗ WRONG — connection leaks on error
async function queryData() {
  const conn = await pool.getConnection();
  const result = await conn.query("SELECT ..."); // if this throws, conn is never released
  conn.release();
  return result;
}

// ✓ CORRECT — finally block ensures cleanup
async function queryData() {
  const conn = await pool.getConnection();
  try {
    return await conn.query("SELECT ...");
  } finally {
    conn.release();
  }
}
```

```typescript
// ✗ WRONG — event listener never removed
element.addEventListener("resize", handler);

// ✓ CORRECT — remove in cleanup
element.addEventListener("resize", handler);
// In cleanup/dispose/useEffect return:
element.removeEventListener("resize", handler);
```

**Verification checklist for resource leak fixes:**

- [ ] Is cleanup in a `finally` block (not just the happy path)?
- [ ] Are event listeners removed in the corresponding cleanup function?
- [ ] Are timers (`setInterval`, `setTimeout`) cleared in cleanup?
- [ ] Does the test verify cleanup runs? (Mock the resource, assert `.release()` / `.close()` called)

---

### §5.10 Logic / Business Rule Fix Playbook

**Root cause pattern:** Wrong conditional, inverted check, missing state validation, incorrect algorithm.

**Fix approach — reason from the specification, not the code:**

1. **State what the correct behavior is** (from the bug report, spec, or user)
2. **Read the current code** and identify WHERE it diverges from correct behavior
3. **Fix the divergence** — don't rewrite the whole function

```typescript
// ✗ WRONG — inverted condition
if (order.status === "shipped") {
  allowCancel(); // Bug: shouldn't allow cancel after shipping
}

// ✓ CORRECT
if (order.status === "pending" || order.status === "processing") {
  allowCancel();
}
```

**For state machine bugs:**

```typescript
// ✓ Explicit valid transitions
const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  draft: ["pending"],
  pending: ["processing", "cancelled"],
  processing: ["shipped", "cancelled"],
  shipped: ["delivered", "returned"],
  delivered: [],
  cancelled: [],
  returned: [],
};

function transitionOrder(order: Order, newStatus: OrderStatus) {
  if (!VALID_TRANSITIONS[order.status]?.includes(newStatus)) {
    throw new InvalidTransitionError(order.status, newStatus);
  }
  order.status = newStatus;
}
```

**Verification checklist for logic fixes:**

- [ ] Does the test cover the exact scenario from the bug report?
- [ ] Are all branches of the conditional tested? (Not just the buggy one)
- [ ] If fixing a state machine, are all valid and invalid transitions tested?
- [ ] Is the fix consistent with other similar logic in the codebase?

---

## Step 6: Verify the Fix

**Gate: All tests pass, no type errors, reproducer is green, no regressions before proceeding to Step 7.**

### 6.1 Run Tests

```bash
# Run tests for the affected package
pnpm --filter <affected-package> test

# If changes cross package boundaries, run the full suite
pnpm test

# Run type checking
pnpm -r typecheck
```

### 6.2 Compare Against Baseline

| Metric        | Baseline (Step 2)  | After Fix       | Verdict               |
| ------------- | ------------------ | --------------- | --------------------- |
| Passing tests | N                  | N + (new tests) | Must increase         |
| Failing tests | M + 1 (reproducer) | M               | Reproducer now passes |
| Type errors   | P                  | 0               | Must be zero          |

### 6.3 Verify the Bug is Actually Fixed

Don't just check that tests pass. Verify the specific bug through the lens of the category:

**For injection fixes:**

- [ ] Try the exploit payload against the fixed code (in the test). Does it fail safely?
- [ ] Search for other instances of the same pattern in the codebase. Are they also vulnerable?

**For auth fixes:**

- [ ] Try accessing the resource as an unauthenticated user. Is it rejected?
- [ ] Try accessing another user's resource. Is it rejected?
- [ ] Are all related endpoints protected? (Not just the one that was reported)

**For null safety fixes:**

- [ ] Trace the data flow again. Can null reach the fixed code through any other path?
- [ ] Is the TypeScript type now accurate? (Does it include `| null` if null is possible?)

**For race condition fixes:**

- [ ] Is the critical section truly atomic? Walk through with two concurrent requests mentally.
- [ ] Can the fix deadlock? (If using locks, check for circular dependencies)

**For logic fixes:**

- [ ] Trace the code path with the triggering input. Does it now produce the correct output?
- [ ] Trace with edge case inputs. Are they also correct?

### 6.4 Check for Regressions

Look beyond test results:

- [ ] Did the fix change any public API signatures? (function params, return types, error types)
- [ ] Did the fix change behavior for non-buggy inputs? (Only the buggy path should change)
- [ ] Did the fix introduce a performance concern? (New query in a loop, new allocation in hot path)
- [ ] Did the fix add a new dependency? (Was it necessary?)
- [ ] Are there console.log/debugger statements left from debugging?

**If tests fail after your fix**, the fix is wrong. Do NOT:

- Adjust existing tests to match the broken behavior
- Add `.skip` to failing tests
- Weaken assertions

Instead: revert to the checkpoint (Step 4.4), go back to Step 3, and re-diagnose.

---

## Step 7: Handle Multi-Bug Batches

**Gate: All findings addressed, tested after each group, no cross-finding regressions.**

When fixing multiple bugs from a `/find-bugs` report, follow this coordination protocol:

### 7.1 Build the Fix Order

```
FINDING DEPENDENCY GRAPH:

Finding #1 (Critical, auth.ts:42)
  └── independent

Finding #2 (Critical, auth.ts:67)
  └── depends on #1 (same file, fix #1 first)

Finding #3 (High, cart.ts:89)
  └── independent

Finding #4 (Medium, cart.ts:120)
  └── depends on #3 (same file, fix #3 first)

Finding #5 (Low, utils.ts:15)
  └── independent

FIX ORDER: [#1, #2] → test → [#3, #4] → test → [#5] → test
```

### 7.2 Group Rules

1. **Same file** — fix together (avoids conflicting edits)
2. **Same function** — fix together (need to understand combined effect)
3. **Dependent findings** — fix in dependency order
4. **Independent findings** — can be fixed in any order; prefer severity order

### 7.3 Test After Each Group

After fixing each group:

```bash
# Run the affected package tests
pnpm --filter <package> test

# If the group touched multiple packages
pnpm test
```

**Do NOT wait until all findings are fixed to run tests.** Finding regressions early is much cheaper than finding them after 10 edits.

### 7.4 Track Progress

As you fix each finding, announce progress:

```
✅ Finding #1 (Critical) — Fixed: parameterized SQL query in auth.ts:42
✅ Finding #2 (Critical) — Fixed: added ownership check in auth.ts:67
   Tests: 45 pass, 0 fail (2 new tests added)
⏳ Finding #3 (High) — Next: race condition in cart.ts:89
⏳ Finding #4 (Medium) — Queued: boundary check in cart.ts:120
⏳ Finding #5 (Low) — Queued: error swallowing in utils.ts:15
```

### 7.5 Handle Cross-Finding Conflicts

If fixing finding A makes finding B's location change:

1. Re-read the code at finding B's location
2. Verify finding B still exists (maybe fixing A also fixed B)
3. If it moved, locate the new position
4. If it's fixed, mark it as "resolved by fix for finding A"

---

## Step 8: Report Results

**Gate: Report delivered before marking fix complete.**

Present results for each bug fixed:

```
## Bug Fix Report

### Finding [#N]: [Title]
- **Severity:** Critical / High / Medium / Low
- **Category:** [from §3.3] — [Playbook §5.X applied]
- **Root Cause:** [one-sentence explanation of WHY the bug existed — the root cause, not the symptom]
- **Fix:** [one-sentence description of WHAT was changed]
- **Defense-in-Depth:** [structural guard added, or "none — fix is sufficient"]
- **Files Changed:**
  - `file:line` — [what changed and why]
  - `file:line` — [what changed and why]
- **Tests Added:**
  - `test-file:line` — [test name] — was RED, now GREEN ✅
  - `test-file:line` — [edge case test name] ✅
- **Verification:**
  - Reproducer test passes: ✅
  - [Category-specific verification item]: ✅
  - No regressions: ✅

### Finding [#N]: [Title]
...
```

**Summary section:**

```
## Summary
- Bugs fixed: [count] ([N] Critical, [N] High, [N] Medium, [N] Low)
- Files modified: [count]
- Tests added/updated: [count]
- All tests pass: ✅
- Type check clean: ✅
- Playbooks used: [list, e.g., §5.1 Injection, §5.4 Null Safety]
```

**If a bug could not be fixed**, explain why clearly:

| Reason                       | What to Report                                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Cannot reproduce             | "Wrote test for reported scenario; test passes with current code. Bug may be fixed or may require different reproduction steps." |
| Root cause is upstream       | "Root cause is in [dependency]. Workaround applied; filed issue [link]."                                                         |
| Requires architecture change | "Fix requires [redesign]. Documented as recommendation. Quick mitigation applied: [what]."                                       |
| Insufficient information     | "Need [specific info] from user to diagnose. Current evidence suggests [hypothesis]."                                            |

---

## Safety Rules

| Rule                                            | Reason                                             |
| ----------------------------------------------- | -------------------------------------------------- |
| Never fix without a reproducer test             | Guessing at fixes introduces new bugs              |
| Never fix without diagnosing root cause         | Symptom fixes mask the real problem                |
| Never skip the baseline test run                | You need "before" to compare against               |
| Never weaken tests to make a fix pass           | If tests fail, the fix is wrong                    |
| Never mix fixes with refactors                  | Keeps the change reviewable and the fix isolated   |
| Never fix style issues in this skill            | Style is not a bug; use /code-simplify             |
| Never assume a /find-bugs suggestion is correct | Suggestions are starting points, not prescriptions |
| Never proceed without reproducing               | If you can't prove it's broken, don't change it    |
| Always map blast radius before changing         | Understand everything your change touches          |
| Always run tests before AND after               | Baseline + verification = confidence               |
| Always use the correct fix playbook             | Generic patches miss category-specific pitfalls    |

---

## Step 9: Verification (MANDATORY)

After fixing, verify the complete workflow:

### Check 1: Reproducer

- [ ] A failing test existed BEFORE the fix was implemented
- [ ] The test captures the EXACT scenario from the bug report
- [ ] The test now passes after the fix
- [ ] The test would fail if the fix were reverted (it tests the right thing)

### Check 2: Root Cause

- [ ] Root cause was identified (not just symptom)
- [ ] Fix addresses the root cause directly
- [ ] Fix does not just suppress the error (no bare try/catch, no silent swallow)

### Check 3: Correct Playbook

- [ ] Bug was classified into a category (§3.3)
- [ ] The corresponding fix playbook (§5.X) was followed
- [ ] Category-specific verification checklist was completed

### Check 4: Regression Safety

- [ ] Baseline tests still pass (no regressions)
- [ ] New tests added for each bug fixed
- [ ] Type checking passes
- [ ] No debug artifacts left (console.log, debugger, TODO REMOVE)

### Check 5: Minimal Change

- [ ] Only bug-related code was changed
- [ ] No refactoring, features, or style changes mixed in
- [ ] No unnecessary dependencies added
- [ ] No public API changes (or flagged to user if unavoidable)

### Check 6: Completeness

- [ ] All requested bugs addressed (or explained why not)
- [ ] Report delivered with root cause, playbook used, fix rationale, and test details
- [ ] Defense-in-depth recommendations noted (if applicable)

**Gate:** Do NOT mark fix complete until all 6 checks pass.

---

## Quality Checklist (Must Score 10/12)

Score yourself honestly before marking fix complete:

### Reproducer Quality (0-2 points)

- **0 points:** No reproducer test written
- **1 point:** Test written but doesn't capture the exact bug scenario
- **2 points:** Test reproduces the exact bug, was RED before fix, is GREEN after, would go RED if fix reverted

### Diagnosis Quality (0-2 points)

- **0 points:** Fixed the symptom without finding root cause
- **1 point:** Found root cause but didn't trace full data flow
- **2 points:** Full root cause analysis with data flow trace and blast radius mapping

### Playbook Application (0-2 points)

- **0 points:** Generic fix without considering bug category
- **1 point:** Used correct playbook but skipped verification checklist
- **2 points:** Correct playbook applied, category-specific verification completed

### Fix Precision (0-2 points)

- **0 points:** Shotgun fix — changed many things hoping one works
- **1 point:** Targeted fix but included unnecessary changes
- **2 points:** Minimal, surgical fix — only the lines needed to address root cause

### Regression Safety (0-2 points)

- **0 points:** Didn't run tests before or after
- **1 point:** Ran tests after but no baseline comparison
- **2 points:** Full baseline → RED → fix → GREEN → verify cycle

### Report Quality (0-2 points)

- **0 points:** No report or vague "fixed it"
- **1 point:** Report missing root cause, playbook, or test details
- **2 points:** Complete report with root cause, playbook, fix rationale, files changed, tests added

**Minimum passing score: 10/12**

---

## Common Rationalizations (All Wrong)

These are excuses. Don't fall for them:

- **"The fix is obvious, I don't need a reproducer"** → STILL write the failing test first; "obvious" fixes are often wrong and you won't know without proof
- **"It's a one-line fix, it can't break anything"** → One-line fixes can have project-wide blast radius; map callers first
- **"The /find-bugs suggestion said exactly what to do"** → STILL verify the suggestion against the code; the diagnosis may be right but the fix wrong
- **"Tests are passing so the fix must be right"** → Tests might not cover the exact bug scenario; that's why you write a reproducer first
- **"I'll add tests later"** → Add them NOW; the reproducer comes BEFORE the fix, not after
- **"This is just a null check, it doesn't need a test"** → Null checks are one of the most common sources of masked bugs; test them
- **"The bug is in a test file, so it doesn't matter"** → Wrong tests produce false confidence; fix them with the same rigor
- **"I fixed the bug and also cleaned up the function"** → UNDO the cleanup; fix only what's broken; use /code-simplify separately
- **"Running the full test suite is too slow"** → STILL run it; a fast broken fix is worse than a slow correct one
- **"I can't write a test for this"** → You almost always can; if truly impossible, document exactly why and what manual verification you did
- **"The reproducer test passes — the bug must not exist"** → Your test doesn't capture the right scenario; re-read the report and try different inputs

---

## Failure Modes

### Failure Mode 1: Fix Without Reproducer

**Symptom:** "Fix" that doesn't actually address the bug, or introduces a different bug
**Cause:** Skipped the reproducer test, so there was no proof the bug existed or that the fix resolved it
**Fix:** Always write the failing test first. If it passes, the bug is different than you think.

### Failure Mode 2: Symptom Fix

**Symptom:** Bug reappears in a different form after "fixing" it
**Cause:** Fixed the symptom (null check, try/catch) instead of the root cause (why was it null?)
**Fix:** Go back to Step 3. Trace the data flow. Find where the chain FIRST breaks.

### Failure Mode 3: Wrong Playbook

**Symptom:** Fix doesn't address the actual vulnerability or creates a new one
**Cause:** Misclassified the bug (e.g., treated XSS as a logic bug, used sanitization instead of escaping)
**Fix:** Re-classify the bug (Step 3.3). Apply the correct playbook. Run the category-specific verification.

### Failure Mode 4: Regression

**Symptom:** Fix introduces a new bug in previously working code
**Cause:** Blast radius not mapped; change affected callers or dependents unexpectedly
**Fix:** Revert to checkpoint. Map all callers (Step 3.5). Plan fix compatible with all call sites.

### Failure Mode 5: Wrong Root Cause

**Symptom:** Reproducer test still fails after the fix
**Cause:** Diagnosed the wrong root cause; the real issue is elsewhere
**Fix:** Don't double down. Go back to Step 3.2 and widen the data flow trace.

### Failure Mode 6: Test Gap

**Symptom:** Fix works now but the same bug comes back in a future change
**Cause:** Reproducer test didn't precisely capture the bug scenario, or no edge case tests added
**Fix:** Verify reproducer would go RED if fix is reverted. Add edge case tests for related scenarios.

### Failure Mode 7: Scope Creep

**Symptom:** "Bugfix" PR has 20 files changed, mixed with refactoring and improvements
**Cause:** Mixed fixing with cleanup, refactoring, or feature work
**Fix:** Fix ONLY the bug. Log cleanup opportunities for /code-simplify as a separate commit.

### Failure Mode 8: Cargo Cult Fix

**Symptom:** Applied the `/find-bugs` suggestion verbatim without understanding it
**Cause:** Treated the suggestion as a prescription instead of a starting point
**Fix:** Always verify suggestions by reading the code. The playbook verification checklist catches many wrong fixes.

### Failure Mode 9: Incomplete Security Fix

**Symptom:** Fixed one instance of a vulnerability but left others in the codebase
**Cause:** Didn't search for other instances of the same pattern
**Fix:** After fixing, grep the entire codebase for the same vulnerable pattern. Fix all instances or document the remaining ones.

---

## Quick Workflow Summary

```
STEP 0: DETECT FRAMEWORK
├── Identify framework from imports, deps, file extensions
├── Read base language reference (nodejs-typescript.md, golang.md, etc.)
├── Read framework-specific reference (expressjs.md, go-gin.md, etc.)
└── Gate: Framework identified, reference loaded

STEP 1: PARSE THE BUG
├── From /find-bugs → Extract finding details, classify category
├── From user report → Extract symptom, trigger, expected, location, frequency
├── From observed failure → Parse stack trace, check git history
└── Gate: Bug(s) identified with category

STEP 2: REPRODUCE (RED PHASE)
├── Find or create test file
├── Write failing test capturing exact bug scenario
├── Run test — confirm it FAILS
├── Write edge case tests
├── If can't reproduce: check env, input, version, ask user
└── Gate: Failing test exists

STEP 3: DIAGNOSE ROOT CAUSE
├── Read full function + callers + deps + types + tests
├── Trace data flow: entry → transformations → failure point
├── Classify bug category (§3.3) → select playbook (§5.X)
├── Distinguish root cause from symptom
├── Map blast radius (callers, importers, types, tests)
├── Confirm: one-sentence test, completeness, simplicity, prediction
└── Gate: Root cause identified, category classified

STEP 4: PLAN THE FIX
├── Design minimal change matching the playbook
├── Consider edge cases (null, empty, concurrent, error, perf)
├── Plan defense-in-depth (structural guard, if small addition)
├── Create rollback checkpoint (git stash or note HEAD)
├── Present plan (for significant fixes)
└── Gate: Fix plan is minimal, playbook-matched, edge-case-aware

STEP 5: IMPLEMENT (GREEN PHASE)
├── Apply code changes (Edit tool, one unit at a time)
├── Follow the category-specific playbook (§5.1–§5.10)
├── Complete playbook verification checklist
├── Run reproducer test after each change — watch for RED → GREEN
└── Gate: Reproducer passes, changes applied cleanly

STEP 6: VERIFY
├── Run full test suite (compare to baseline)
├── Run type checking
├── Category-specific verification (injection, auth, null, race)
├── Check for regressions (API changes, behavior changes, perf)
├── Scan for debug artifacts (console.log, debugger, TODO)
└── Gate: All tests pass, types clean, bug resolved, no regressions

STEP 7: BATCH COORDINATION (multi-bug only)
├── Build dependency graph between findings
├── Group by file → order by dependency → order by severity
├── Test after each group
├── Track progress (✅/⏳ per finding)
├── Handle cross-finding conflicts (re-locate moved findings)
└── Gate: All findings addressed, no cross-finding regressions

STEP 8: REPORT
├── Per-bug: root cause, playbook, fix, files, tests, verification
├── Summary: counts, playbooks used, pass/fail status
├── Unfixed bugs: reason + what was tried
└── Gate: Report delivered

STEP 9: VERIFICATION (MANDATORY)
├── Check 1: Reproducer (RED → GREEN → would go RED if reverted)
├── Check 2: Root cause (not symptom, not suppression)
├── Check 3: Correct playbook + verification checklist
├── Check 4: Regression safety (baseline + new tests + types)
├── Check 5: Minimal change (no scope creep)
├── Check 6: Completeness (all bugs addressed or explained)
└── Gate: All 6 checks pass
```

---

## Completion Announcement

When fix is complete, announce:

```
Bugfix complete.

**Quality Score: X/12**
- Reproducer Quality: X/2
- Diagnosis Quality: X/2
- Playbook Application: X/2
- Fix Precision: X/2
- Regression Safety: X/2
- Report Quality: X/2

**Bugs Fixed:**
- [#N] [severity] [title] — root cause: [one sentence] — playbook: §5.X
- [#N] [severity] [title] — root cause: [one sentence] — playbook: §5.X

**Changes:**
- Files modified: [count]
- Tests added/updated: [count]
- Lines changed: +[added] / -[removed]
- Framework reference: [e.g., expressjs.md + nodejs-typescript.md]
- Playbooks used: [list]

**Verification:**
- Reproducer tests: RED → GREEN ✅
- Baseline tests pass: ✅
- Type check clean: ✅
- Category-specific checks: ✅
- No regressions: ✅
- No debug artifacts: ✅

**Next steps:**
[Commit changes, run /find-bugs again to verify, or continue with remaining findings]
```

---

## Integration with Other Skills

The `bugfix` skill integrates with:

- **`find-bugs`** — Takes structured findings as input; run `/find-bugs` first to identify bugs, then `/bugfix` to fix them
- **`commit`** — After fixing, invoke `/commit` to commit the changes
- **`code-simplify`** — If the fix revealed surrounding code that could be cleaner, use `/code-simplify` after committing the fix (as a separate commit)
- **`create-pr`** — After committing, invoke `/create-pr` to submit for review
- **`branch-review-before-pr`** — Run before creating PR to catch any issues the fix may have introduced

**Workflow Chains:**

```
/find-bugs → /bugfix → /commit → /create-pr
                           │
                           ▼
                   /code-simplify (optional, separate commit)
```

```
User reports bug → /bugfix → /commit
```

```
/find-bugs → /bugfix (critical only) → /commit → /find-bugs (verify remaining)
```

**Batch Fix Pattern:**

When `/find-bugs` reports multiple findings:

1. Run `/bugfix fix all critical bugs` — fixes Critical findings first
2. Run `/commit` — commits critical fixes
3. Run `/bugfix fix high bugs` — fixes High findings next
4. Run `/commit` — commits high fixes
5. Repeat for Medium/Low as desired

This keeps each commit focused and reviewable.
