---
name: kiro-review
version: 1.0.0
description: Run Kiro CLI to review code changes made in the current session or branch. Invokes `kiro-cli chat` in non-interactive mode with focused review instructions derived from the actual changes. Use when the user says "kiro review", "second opinion", "rival review", "cross-review", or "/kiro-review".
---

# Kiro Review

Use Kiro CLI to get an independent AI review of code changes.

## When to Use

- User explicitly asks for a kiro review, second opinion, or cross-review
- User says "run kiro", "kiro review", "/kiro-review"
- User wants an independent AI to verify Claude's work before merging

## Prerequisites

- `kiro-cli` must be installed (`which kiro-cli`)
- User must be logged in (`kiro-cli whoami`)

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

Determine the diff to feed into the review:
- **Branch review**: `git diff main..HEAD`
- **Uncommitted changes**: `git diff`
- **Single commit**: `git show <sha>`

### Step 2: Analyze the Changes and Build the Prompt

Read the diff to understand what areas need review focus. Build a
focused review prompt based on the actual code changes.

```bash
# Get the diff summary
git diff --stat <base>..HEAD

# Identify key areas
git diff --name-only <base>..HEAD | sed 's|/[^/]*$||' | sort -u
```

Write a focused review prompt to `/tmp/kiro-review-prompt.md`:

```markdown
Review the code changes on this branch compared to main.

The changes cover: [brief description of what changed].

Focus your review on:
1. [Area 1 based on actual changes]
2. [Area 2 based on actual changes]
3. [Area 3 based on actual changes]

For each finding, report:
- Priority: P1 (critical), P2 (important), P3 (minor)
- File and line number
- Description of the issue
- Suggested fix

Verify each finding against the actual code. Read the relevant
source files before reporting. Do not report style issues.

Output a markdown table of findings.
```

**Key principles for the prompt:**
- Be specific about what changed -- generic prompts get generic results
- List previously known issues so kiro doesn't re-report them
- Focus on the areas where bugs are most likely (security, concurrency, edge cases)
- Tell kiro to verify findings against actual code before reporting

### Step 3: Run Kiro Review

```bash
kiro-cli chat \
  --no-interactive \
  -a \
  "$(cat /tmp/kiro-review-prompt.md)" \
  2>&1
```

**Important flags:**
- `--no-interactive` -- runs without expecting user input, returns output directly
- `-a` (trust all tools) -- kiro needs file read access to verify findings against source
- Always capture stderr with `2>&1` (kiro logs to stderr)

Run this in the background if the review is expected to take long:
- Use `run_in_background` on the Bash tool
- The output will be available when the command completes

**Optional flags:**
- `--model <model>` -- specify a particular model if needed
- `--agent <agent>` -- use a specific agent profile for the review

### Step 4: Parse and Report Findings

Read the kiro output and extract findings. Look for:
- Priority markers (`P1`, `P2`, `P3`)
- File paths with line numbers
- Markdown tables of findings

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
2. Update the prompt to list all previously fixed issues
3. Run round N+1 with the updated prompt
4. Repeat until findings converge to zero

**Critical for iteration:** Always add previously fixed issues to the
prompt's exclusion list. Otherwise kiro will re-report the same issues
every round, wasting time and API costs.

## Example: Branch Review

```bash
# 1. Write review prompt
cat > /tmp/kiro-review-prompt.md << 'EOF'
Review the code changes on this branch compared to main.

The changes cover a new authentication module.

Focus on:
1. SECURITY: JWT validation, token expiry, session management
2. CORRECTNESS: Error handling, edge cases, missing null checks
3. TESTING: Are there tests for error paths?

Verify each finding against the actual code before reporting.
Output a markdown table with Priority, File:Line, Description, and Suggested Fix columns.
EOF

# 2. Run review
kiro-cli chat \
  --no-interactive \
  -a \
  "$(cat /tmp/kiro-review-prompt.md)" \
  2>&1
```

## Example: Iterative Deep Review

```bash
# Round 2 prompt (after fixing round 1 findings)
cat > /tmp/kiro-review-prompt.md << 'EOF'
Round 2 review. Prior fixes (do NOT re-report):
- SQL injection in user query (parameterized)
- Missing auth check on /api/admin (added middleware)
- XSS in profile page (escaped output)

Focus on genuinely NEW issues only.
Review the current branch against main.
Output a markdown table of findings.
EOF

kiro-cli chat \
  --no-interactive \
  -a \
  "$(cat /tmp/kiro-review-prompt.md)" \
  2>&1
```

## Safety Rules

| Rule | Reason |
|------|--------|
| Always use `-a` (trust all tools) | Kiro needs file read access to verify findings |
| Always list prior fixes in iterative reviews | Prevents wasting rounds on already-fixed issues |
| Always verify findings before fixing | Kiro can produce false positives |
| Run from the correct directory | Kiro reviews the repo it's invoked in |
| Never pass secrets in the prompt | The prompt may be logged |

## Failure Modes

- **Kiro not installed**: Check `which kiro-cli` first, tell user to install
- **Not logged in**: Run `kiro-cli whoami` — user needs to `kiro-cli login`
- **Too large diff**: Kiro may truncate; break into smaller review scopes
- **Repeated findings**: Always maintain the exclusion list between rounds
- **False positives**: Always read the cited code before acting on findings
