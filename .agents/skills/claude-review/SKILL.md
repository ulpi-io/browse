---
name: claude-review
version: 1.0.0
description: |
  Spawn a separate Claude Code agent to review code changes made in the current session
  or branch. Uses the Agent tool with worktree isolation so the reviewer gets an independent
  read-only copy. Use when the user says "claude review", "self-review", "/claude-review",
  or when a task plan calls for post-task review.
---

<EXTREMELY-IMPORTANT>
Before reporting ANY finding, you **ABSOLUTELY MUST**:

1. Read the complete diff (every changed line, not just file names)
2. Read surrounding context to verify the issue is real
3. Check if the issue is already handled elsewhere in the changed code
4. Search for existing tests that cover the scenario
5. Never report stylistic issues as bugs — only real defects and vulnerabilities

**Reporting without verification = false positives, wasted developer time, eroded trust**

This is not optional. Every finding requires disciplined verification.
</EXTREMELY-IMPORTANT>

# Claude Review

Spawn a separate Claude Code agent to independently review code changes.

## When to Use

- User says "claude review", "self-review", "/claude-review"
- After completing a task from a DAG plan
- User wants a second opinion from Claude itself (not codex or kiro)
- As part of the review trifecta: `/claude-review`, `/codex-review`, `/kiro-review`

## When NOT to Use

- User specifically wants codex or kiro review (use those skills instead)
- No changes exist on the branch (nothing to review)
- User wants to make changes (this is review-only)

## Workflow

### Step 1: Determine the Review Scope

```bash
# Detect default branch
DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||' || echo main)

# What changed?
git diff --stat $DEFAULT_BRANCH..HEAD
git diff --name-only $DEFAULT_BRANCH..HEAD
```

Determine scope:
- **Full branch**: all commits since divergence from default branch
- **Last commit**: only the most recent commit (`git show --stat HEAD`)
- **Uncommitted**: staged + unstaged changes

If $ARGUMENTS contains a scope hint (e.g., "last commit", "uncommitted"), use that.
Otherwise default to full branch review.

### Step 2: Build Review Context

Read the diff to understand what areas need review focus:

```bash
# Get changed directories to identify subsystems
git diff --name-only $DEFAULT_BRANCH..HEAD | sed 's|/[^/]*$||' | sort -u

# Count changes per area
git diff --stat $DEFAULT_BRANCH..HEAD
```

Identify:
- Which packages/modules changed
- Whether changes are security-sensitive (auth, crypto, secrets, permissions)
- Whether changes involve concurrency, I/O, or shell execution
- What test files exist vs what source files changed

### Step 3: Spawn the Review Agent

Use the Agent tool to launch an independent reviewer in a worktree:

```
Agent tool call:
  subagent_type: general-purpose
  isolation: worktree
  prompt: |
    You are performing a code review of changes on branch [branch-name]
    compared to [base].

    ## Changed files
    [list of changed files from Step 2]

    ## Review focus
    Based on the changes, focus on:
    1. [Area 1 — derived from actual changes]
    2. [Area 2 — derived from actual changes]
    3. [Area 3 — derived from actual changes]

    ## Previously known issues (do NOT re-report)
    [List any issues already fixed in prior rounds]

    ## Instructions
    1. Read the full diff: git diff [base]..HEAD
    2. For each changed file, read it completely and check for:
       - Logic errors, off-by-one, null access, missing error handling
       - Security issues: injection, auth bypass, credential leaks
       - Race conditions, TOCTOU, concurrent modification
       - Edge cases: empty input, unicode, special characters
       - Missing or incorrect test coverage
    3. Verify each finding against surrounding context before reporting
    4. Report findings as a markdown table:
       | # | Priority | File:Line | Description | Suggested Fix |
    5. Priority levels: P1 (crash/security), P2 (incorrect behavior), P3 (minor)
    6. If you find nothing significant, say so explicitly

    Do NOT make any code changes. Report only.
```

**Key configuration:**
- `isolation: "worktree"` — gives the reviewer a clean read-only copy
- `subagent_type: general-purpose` — full tool access for reading code
- The prompt must include the specific files and focus areas (not generic)

### Step 4: Parse and Report Findings

When the agent returns, extract findings and present to the user:

```
## Claude Review: [scope description]

| # | Priority | File:Line | Description |
|---|----------|-----------|-------------|
| 1 | P1       | ...       | ...         |

[N] findings: [x] P1, [y] P2, [z] P3
```

### Step 5: Fix Findings (if requested)

If the user wants to fix:
1. Read each cited file to verify the finding is real
2. Apply minimal fixes
3. Run tests and typecheck
4. Commit the fixes

### Step 6: Iterate (if requested)

For thorough review, run multiple rounds:
1. Fix findings from round N
2. Add fixed issues to the "Previously known issues" list
3. Spawn a new review agent with the updated prompt
4. Repeat until findings converge to zero

**Critical:** Always maintain the exclusion list between rounds.

## Example: Full Branch Review

```
Agent tool call:
  description: "Review secrets branch changes"
  subagent_type: general-purpose
  isolation: worktree
  prompt: |
    Review all changes on this branch compared to main.

    Changed files: vault.ts, injection.ts, proxy/server.ts, command-parser.ts

    Focus on:
    1. SECURITY: AES-256-GCM implementation, credential leaks in error messages
    2. CORRECTNESS: Shell parser with quotes/pipes/subshells
    3. EDGE CASES: Concurrent vault access, proxy chunked encoding

    Read every changed file. Verify findings against context.
    Report as markdown table with Priority, File:Line, Description, Fix.
```

## Example: Post-Task Review (DAG integration)

After a task agent completes, run claude-review on just that task's changes:

```
Agent tool call:
  description: "Review TASK-003 implementation"
  subagent_type: general-purpose
  isolation: worktree
  prompt: |
    Review the changes in the last commit (TASK-003: Add vault encryption).

    Run: git show --stat HEAD
    Then: git show HEAD (full diff)

    Focus on:
    1. Is the AES-256-GCM implementation correct?
    2. Are there credential leaks in error messages?
    3. Is the key derivation secure?

    Report findings as markdown table.
```

## Comparison with Sibling Skills

| Skill | Tool | Best For |
|-------|------|----------|
| `/claude-review` | Claude Code (Agent) | Deep code understanding, context-aware review |
| `/codex-review` | OpenAI Codex CLI | Independent perspective, repro scripts |
| `/kiro-review` | Kiro CLI | Alternative AI perspective |

**Recommendation:** For critical code, run all three and cross-reference findings.
The overlap between reviewers catches more bugs than any single tool.

## Safety Rules

| Rule | Reason |
|------|--------|
| Always use `isolation: "worktree"` | Prevents reviewer from modifying your working copy |
| Always list prior fixes in iterations | Prevents re-reporting already-fixed issues |
| Never include actual secret values in findings | Report type and location only (e.g., "hardcoded key at config.ts:17") |
| Always verify findings before fixing | Any reviewer can produce false positives |
| Never skip the diff reading step | Generic prompts get generic (useless) results |
| Be specific about focus areas | Targeted reviews find more bugs than broad ones |

## Failure Modes

- **Agent returns no findings**: Prompt was too generic. Add specific file names and focus areas.
- **Agent makes code changes**: Forgot `isolation: "worktree"` or prompt didn't say "report only"
- **Repeated findings across rounds**: Exclusion list not maintained — add prior fixes
- **False positives**: Always read the cited code before acting. ~10% of findings are wrong.
- **Agent times out**: Diff too large. Break into per-file or per-module reviews.
