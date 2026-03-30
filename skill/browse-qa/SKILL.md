---
name: browse-qa
description: |
  AI QA agent powered by browse. Validates features, runs exploratory testing, and generates
  automated regression tests across web, iOS, Android, and macOS. Accepts work from any source:
  Jira stories, Linear tickets, GitHub issues, plain English descriptions, or acceptance criteria.
  Outputs a reusable browse flow file that can be rerun for regression testing.
  Use when the user says "QA this", "test this feature", "validate this story", "check this works",
  or provides a ticket ID/URL to verify.
allowed-tools:
  - Bash
  - Read
  - Write
---

# browse-qa: AI QA Agent

QA any feature across web, iOS, Android, and macOS. Accept a spec from anywhere, test it live, generate automated regression tests.

## When to Use

- User says "QA this", "test this feature", "validate this story", "check this works"
- User provides a Jira ticket, Linear issue, GitHub issue, or any feature description
- User wants to verify acceptance criteria against a live app or website
- User wants to generate automated tests from a manual QA session
- User asks for exploratory testing of a feature or page

## Input Sources

The spec can come from:

1. **Jira MCP** — if `mcp__jira__*` tools are available, fetch the ticket:
   ```
   mcp__jira__get_issue({ issueKey: "PROJ-123" })
   ```
2. **Linear MCP** — if `mcp__linear__*` tools are available
3. **GitHub issue** — use browse to read the issue page
4. **Plain text** — user describes what to test
5. **File** — user points to a spec file
6. **URL** — user provides a ticket URL (use browse to read it)

## Workflow

### Phase 1: Understand What to QA

1. **Get the spec** — from MCP, user text, or URL
2. **Break it down** into concrete, testable scenarios:
   - What is the feature?
   - Where does it live? (URL, app, platform)
   - What are the acceptance criteria?
   - What should happen? What should NOT happen?
   - Edge cases: empty input, invalid data, boundary values
3. **Present the QA plan**:
   ```
   QA plan for [feature]:

   Target: [URL / app / platform]

   Scenarios:
   1. [Happy path] — expected: [outcome]
   2. [Edge case] — expected: [outcome]
   3. [Error case] — expected: [outcome]
   4. [Boundary] — expected: [outcome]
   ```
4. **Confirm with user** before executing

### Phase 2: Decide the Target

| Spec mentions... | Target | Setup |
|---|---|---|
| URL, website, web page, localhost | **Browser** | `browse --headed goto <url>` |
| iOS app, iPhone, iPad, Swift | **iOS Simulator** | `browse sim start --platform ios --app <id> --visible` |
| Android app, Kotlin, phone | **Android Emulator** | `browse sim start --platform android --app <id> --visible` |
| macOS app, desktop app | **macOS** | `browse --app <name>` |
| Ambiguous ("our app", "the app") | **Ask the user** | "Which platform should I test on?" |

**If unsure, always ask.** Don't guess the platform.

### Phase 3: Execute QA

1. **Start recording** — every command becomes part of the regression test:
   ```bash
   browse record start
   ```

2. **For each scenario**, follow this pattern:

   **Navigate:**
   ```bash
   browse goto <url>                    # web
   browse wait --network-idle           # web
   browse --platform ios --app <id> snapshot -i  # native
   ```

   **Interact:**
   ```bash
   browse snapshot -i                   # find elements
   browse click @e3                     # click
   browse fill @e4 "test value"         # fill
   browse press Enter                   # submit
   browse swipe up                      # scroll (native)
   ```

   **Verify — this is the critical part:**
   ```bash
   browse text                          # check visible text contains expected content
   browse snapshot -i                   # check element exists/state
   browse js "document.querySelector('.success')?.textContent"  # specific check
   browse count ".error-message"        # check error count
   browse screenshot .browse/sessions/default/scenario-1.png
   ```

3. **Report each scenario immediately:**
   ```
   ✓ Scenario 1: Valid discount code
     Verified: price updated from AED 500 to AED 400
     Screenshot: .browse/sessions/default/scenario-1.png

   ✗ Scenario 2: Invalid discount code
     Expected: error message "Invalid code"
     Actual: no error shown, page unchanged
     Screenshot: .browse/sessions/default/scenario-2.png
   ```

### Phase 4: Exploratory Testing

After testing the stated scenarios, do exploratory testing:

- **Try unexpected inputs** — special characters, very long text, HTML injection
- **Test responsiveness** — `browse emulate "iPhone 14"` then recheck
- **Check edge states** — empty cart, logged out, slow network (`browse offline on`)
- **Verify error handling** — what happens when things go wrong?
- **Check accessibility** — `browse a11y-audit` on key pages

Report any additional findings as bugs, not scenario failures.

### Phase 5: Generate Regression Test

1. **Stop recording:**
   ```bash
   browse record stop
   ```

2. **Export as flow file:**
   ```bash
   browse flow save <descriptive-name>
   ```

3. **Tell the user how to rerun:**
   ```
   Regression test saved: .browse/flows/<name>.yaml

   Rerun:
     browse flow run <name>

   Run on CI:
     browse flow .browse/flows/<name>.yaml
   ```

### Phase 6: QA Report

```
## QA Report: [Feature Name]

**Source:** [Jira PROJ-123 / user description]
**Target:** [https://example.com / com.example.app on iOS]
**Tested:** [date]

### Acceptance Criteria
| # | Criteria | Result | Evidence |
|---|----------|--------|----------|
| 1 | [criteria from spec] | ✓ PASS | [what was verified] |
| 2 | [criteria from spec] | ✗ FAIL | [expected vs actual] |

### Exploratory Findings
| # | Finding | Severity | Details |
|---|---------|----------|---------|
| 1 | [issue found] | High | [description + screenshot] |
| 2 | [edge case] | Low | [description] |

### Regression Test
Flow: .browse/flows/<name>.yaml
Rerun: browse flow run <name>
Steps recorded: [N]

### Screenshots
[list of screenshots taken during QA]

### Verdict
[PASS / FAIL / PASS WITH ISSUES]
[Summary of what works, what doesn't, and recommended actions]
```

## Rules

1. **Always record** — `browse record start` before any testing. Every QA session should produce a regression test.
2. **Verify, don't just navigate** — the value of QA is checking outcomes, not clicking around. Use `browse text`, `browse count`, `browse js` to verify.
3. **Screenshot at every checkpoint** — evidence for the report and useful for debugging failures.
4. **Test the unhappy path** — edge cases, errors, and boundaries are where bugs hide.
5. **Ask when ambiguous** — if the spec doesn't say where to test or what "correct" looks like, ask.
6. **Name flows after the feature** — `checkout-discount`, `user-registration`, `search-filters`. Not `test1`.
7. **One flow per feature** — keep regression tests focused and independent.
8. **Report honestly** — if something doesn't work, say so clearly. Don't gloss over failures.

## Native App QA

Same workflow, native commands:

```bash
# iOS QA session
browse sim start --platform ios --app com.example.myapp --visible
browse record start
browse --platform ios --app com.example.myapp snapshot -i
browse --platform ios --app com.example.myapp tap @e3
browse --platform ios --app com.example.myapp fill @e5 "test"
browse --platform ios --app com.example.myapp press return
browse --platform ios --app com.example.myapp screenshot .browse/sessions/default/ios-test.png
browse record stop
browse flow save ios-feature-qa

# Android QA session
browse sim start --platform android --app ./app-debug.apk --visible
browse record start
browse --platform android --app com.example.myapp snapshot -i
browse --platform android --app com.example.myapp tap @e3
browse --platform android --app com.example.myapp swipe up
browse record stop
browse flow save android-feature-qa
```

## Examples

### Example 1: Jira Story

**User:** "QA SHOP-789"

**Agent:**
1. `mcp__jira__get_issue({ issueKey: "SHOP-789" })` → "Add discount code field to checkout. Valid codes reduce price. Invalid codes show error."
2. Plans: happy path (valid code), error path (invalid), edge case (empty submit), boundary (expired code)
3. Opens checkout page in headed browser
4. Tests each scenario, screenshots at each step
5. Finds: valid code works, invalid code works, BUT empty submit crashes the page
6. Reports: 3/4 PASS, 1 FAIL (empty submit bug), flow saved as `checkout-discount-qa`

### Example 2: Plain English

**User:** "QA the search on mumzworld.com — make sure filters work"

**Agent:**
1. Plans: search text, apply price filter, apply brand filter, clear filters, empty search
2. Opens mumzworld.com in headed browser
3. Tests each filter combination
4. Reports results with screenshots
5. Saves flow: `mumzworld-search-filters-qa`

### Example 3: Mobile App

**User:** "QA the login flow on our iOS app, bundle is com.ourcompany.app"

**Agent:**
1. Boots iOS Simulator with the app
2. Plans: valid login, invalid password, empty fields, forgot password link
3. Tests each scenario in the simulator
4. Reports with screenshots
5. Saves flow: `ios-login-qa`
