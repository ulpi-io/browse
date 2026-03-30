---
name: browse-test-spec
description: |
  Validate a feature spec (Jira story, ticket, or plain text) by testing it live on a website or native app.
  Records every step and exports a reusable browse flow file for regression testing.
  Use when the user says "test this story", "validate this ticket", "test this spec",
  "create a test for this feature", or provides a Jira ticket ID/URL.
allowed-tools:
  - Bash
  - Read
  - Write
---

# browse-test-spec: Validate Features & Generate Automated Tests

Accept a feature specification, test it live using browse, and generate a reusable flow file.

## When to Use

- User provides a Jira ticket, story, or feature description to validate
- User asks to "test this feature", "validate this story", "create a test flow"
- User provides a ticket ID (e.g., "PROJ-123") or URL
- User describes acceptance criteria that need verification

## Input Sources

The spec can come from:

1. **Jira MCP** — if `mcp__jira__*` tools are available, fetch the ticket directly:
   ```
   mcp__jira__get_issue({ issueKey: "PROJ-123" })
   ```
2. **Plain text** — user pastes or describes the feature
3. **File** — user points to a markdown/text file with the spec
4. **URL** — user provides a Jira/Linear/GitHub issue URL (use browse to read it)

## Workflow

### Phase 1: Understand the Spec

1. **Get the spec** — from Jira MCP, user text, or URL
2. **Extract test scenarios** — parse the spec into concrete, testable scenarios:
   - What is the feature?
   - What is the target? (URL, app name, platform)
   - What are the acceptance criteria?
   - What are the expected outcomes?
3. **Present the test plan** — show the user what you'll test before starting:
   ```
   I'll test the following scenarios on [target]:
   1. [Scenario 1] — expected: [outcome]
   2. [Scenario 2] — expected: [outcome]
   3. [Scenario 3] — expected: [outcome]
   ```
4. **Confirm with user** — ask if the plan looks right before executing

### Phase 2: Decide the Target

Use the browse skill's target decision table:

| Spec mentions... | Target | Setup |
|---|---|---|
| A URL, website, web page | **Browser** | `browse goto <url>` |
| iOS app, iPhone, iPad | **iOS Simulator** | `browse sim start --platform ios --app <id> --visible` |
| Android app, phone | **Android Emulator** | `browse sim start --platform android --app <id> --visible` |
| macOS app, desktop app | **macOS** | `browse --app <name>` |
| "our app" (ambiguous) | **Ask the user** | Which platform? |

### Phase 3: Execute Tests

1. **Start recording**:
   ```bash
   browse record start
   ```

2. **For each scenario**, execute browse commands:
   ```bash
   # Navigate
   browse goto <url>
   browse wait --network-idle

   # Find elements
   browse snapshot -i

   # Interact
   browse click @e3
   browse fill @e4 "test value"
   browse press Enter

   # Verify outcomes
   browse text                    # Check visible text
   browse snapshot -i             # Check element state
   browse js "document.title"     # Check page state
   browse screenshot .browse/sessions/default/test-step-1.png
   ```

3. **After each scenario**, report the result:
   ```
   ✓ Scenario 1: [description] — PASSED
     - Verified: [what was checked]
     - Screenshot: .browse/sessions/default/test-step-1.png

   ✗ Scenario 2: [description] — FAILED
     - Expected: [expected outcome]
     - Actual: [what happened]
     - Screenshot: .browse/sessions/default/test-step-2.png
   ```

### Phase 4: Generate Flow File

1. **Stop recording**:
   ```bash
   browse record stop
   ```

2. **Export as flow file**:
   ```bash
   browse record export flow .browse/flows/<spec-name>.yaml
   ```
   Or save as a named flow:
   ```bash
   browse flow save <spec-name>
   ```

3. **Show the user** the generated flow file path and how to rerun it:
   ```
   Test flow saved: .browse/flows/<spec-name>.yaml

   Rerun anytime:
     browse flow .browse/flows/<spec-name>.yaml

   Or by name:
     browse flow run <spec-name>
   ```

### Phase 5: Report

Present a structured report:

```
## Test Report: [Spec Title]

**Source:** [Jira ticket / user description]
**Target:** [URL / app / platform]
**Date:** [timestamp]

### Results
| # | Scenario | Result | Details |
|---|----------|--------|---------|
| 1 | [name]   | ✓ PASS | [what was verified] |
| 2 | [name]   | ✗ FAIL | [expected vs actual] |

### Generated Flow
Path: .browse/flows/<name>.yaml
Rerun: browse flow run <name>

### Screenshots
- Step 1: .browse/sessions/default/test-1.png
- Step 2: .browse/sessions/default/test-2.png
```

## Rules

1. **Always start `browse record start` before testing** — this captures every command for the flow file
2. **Take screenshots at key checkpoints** — evidence for the report
3. **Verify outcomes, don't just navigate** — use `browse text`, `browse snapshot -i`, `browse js` to check that expected content/state exists
4. **Report failures clearly** — expected vs actual, with screenshot
5. **Ask when unsure** — if the spec is ambiguous about what to test or where, ask the user
6. **One flow per spec** — each spec gets its own flow file for independent reruns
7. **Name flows descriptively** — `login-flow`, `checkout-validation`, `search-filters`, not `test1`

## Native App Testing

For iOS/Android/macOS specs, the workflow is the same but uses native commands:

```bash
# iOS
browse sim start --platform ios --app com.example.myapp --visible
browse record start
browse --platform ios --app com.example.myapp snapshot -i
browse --platform ios --app com.example.myapp tap @e3
browse --platform ios --app com.example.myapp swipe up
browse record stop
browse record export flow .browse/flows/ios-feature-test.yaml

# Android
browse sim start --platform android --app com.example.myapp --visible
browse record start
browse --platform android --app com.example.myapp snapshot -i
browse --platform android --app com.example.myapp tap @e5
browse record stop
browse record export flow .browse/flows/android-feature-test.yaml
```

## Example

**User:** "Test PROJ-456 — the new checkout discount field"

**Agent:**
1. Fetches PROJ-456 from Jira MCP (or user provides description)
2. Extracts: "Discount code field on checkout page. When valid code entered, price updates. Invalid code shows error."
3. Plans 3 scenarios: valid code, invalid code, empty submit
4. Confirms with user
5. Starts recording, navigates to checkout, tests each scenario
6. Takes screenshots at each step
7. Exports flow: `.browse/flows/checkout-discount.yaml`
8. Reports: 3/3 passed, flow file path, rerun command
