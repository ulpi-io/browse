---
name: codex-review
version: 1.0.0
description: Run OpenAI Codex CLI to review code changes made in the current session or branch. Invokes `codex review` with focused instructions derived from the actual changes. Use when the user says "codex review", "second opinion", "rival review", "cross-review", or "/codex-review".
---

# Codex Review

Use OpenAI Codex CLI to get an independent AI review of code changes.

## When to Use

- User explicitly asks for a codex review, second opinion, or cross-review
- User says "run codex", "codex review", "/codex-review"
- User wants an independent AI to verify Claude's work before merging

## Prerequisites

- `codex` CLI must be installed (`which codex`)
- An OpenAI API key must be configured for codex

## Workflow

### Step 1: Determine the Review Scope

Identify what to review:

```bash
# Option A: Review current branch against main
git log --oneline main..HEAD | head -20

# Option B: Review uncommitted changes
git diff --stat

# Option C: Review a specific commit
git show --stat <sha>
```

Pick the right `codex review` flag:
- **Branch review**: `--base main` (or whatever the base branch is)
- **Uncommitted changes**: `--uncommitted`
- **Single commit**: `--commit <sha>`

### Step 2: Analyze the Changes and Build Instructions

Read the diff to understand what areas need review focus. Build a
focused instruction file based on the actual code changes.

```bash
# Get the diff summary
git diff --stat <base>..HEAD

# Identify key areas
git diff --name-only <base>..HEAD | sed 's|/[^/]*$||' | sort -u
```

Write a focused instruction file to `/tmp/codex-review-instructions.md`:

```markdown
You are reviewing [brief description of what changed].

Focus your review on:
1. [Area 1 based on actual changes]
2. [Area 2 based on actual changes]
3. [Area 3 based on actual changes]

Verify each finding against the actual code. Read the relevant
source files before reporting.
```

**Key principles for instructions:**
- Be specific about what changed — generic instructions get generic results
- List previously known issues so codex doesn't re-report them
- Focus on the areas where bugs are most likely (security, concurrency, edge cases)
- Tell codex to verify findings against actual code before reporting

### Step 3: Run Codex Review

```bash
codex review \
  --base <base-branch> \
  --title "<descriptive title>" \
  -c 'sandbox_permissions=["disk-full-read-access","disk-full-write-access","network-full-access"]' \
  -c 'instructions="/tmp/codex-review-instructions.md"' \
  2>&1
```

**Important flags:**
- `sandbox_permissions` — codex needs read access to verify findings against source
- `instructions` — points to the focused review file from Step 2
- Always capture stderr with `2>&1` (codex logs to stderr)

Run this in the background if the review is expected to take long:
- Use `run_in_background` on the Bash tool
- The output will be available when the command completes

### Step 4: Parse and Report Findings

Read the codex output and extract findings. Look for lines matching:
- `[P1]`, `[P2]`, `[P3]` — prioritized findings
- `Full review comments:` — start of findings section
- File paths with line numbers — specific locations

Report findings to the user in a clear table:

```
| # | Priority | Description | File:Line |
|---|----------|-------------|-----------|
| 1 | P1       | ...         | ...       |
```

### Step 5: Fix Findings (if requested)

If the user wants to fix the findings:
1. Read each cited file to verify the finding is real
2. Apply fixes
3. Run tests and typecheck
4. Commit the fixes

### Step 6: Iterate (if requested)

For thorough review, run multiple rounds:
1. Fix findings from round N
2. Update instructions to list all previously fixed issues
3. Run round N+1 with the updated instructions
4. Repeat until findings converge to zero

**Critical for iteration:** Always add previously fixed issues to the
instruction file's exclusion list. Otherwise codex will re-report the
same issues every round, wasting time and API costs.

## Example: Branch Review

```bash
# 1. Write instructions
cat > /tmp/codex-review-instructions.md << 'EOF'
You are reviewing a new authentication module.

Focus on:
1. SECURITY: JWT validation, token expiry, session management
2. CORRECTNESS: Error handling, edge cases, missing null checks
3. TESTING: Are there tests for error paths?

Verify each finding against the actual code before reporting.
EOF

# 2. Run review
codex review \
  --base main \
  --title "feat(auth): security review" \
  -c 'sandbox_permissions=["disk-full-read-access"]' \
  -c 'instructions="/tmp/codex-review-instructions.md"' \
  2>&1
```

## Example: Iterative Deep Review

```bash
# Round 2 instructions (after fixing round 1 findings)
cat > /tmp/codex-review-instructions.md << 'EOF'
Round 2 review. Prior fixes (do NOT re-report):
- SQL injection in user query (parameterized)
- Missing auth check on /api/admin (added middleware)
- XSS in profile page (escaped output)

Focus on genuinely NEW issues only.
EOF

codex review --base main \
  --title "feat(auth): review round 2" \
  -c 'sandbox_permissions=["disk-full-read-access"]' \
  -c 'instructions="/tmp/codex-review-instructions.md"' \
  2>&1
```

## Safety Rules

| Rule | Reason |
|------|--------|
| Never run codex without sandbox permissions | It needs file read access to verify findings |
| Always list prior fixes in iterative reviews | Prevents wasting rounds on already-fixed issues |
| Always verify findings before fixing | Codex can produce false positives |
| Run from the correct directory | Codex reviews the repo it's invoked in |
| Never pass secrets in instructions | The instruction file may be logged |

## Failure Modes

- **Codex not installed**: Check `which codex` first, tell user to install
- **No API key**: Codex will fail with auth error — user needs to configure
- **Too large diff**: Codex may truncate; break into smaller review scopes
- **Repeated findings**: Always maintain the exclusion list between rounds
- **False positives**: Always read the cited code before acting on findings
