---
name: browse-qa
version: 2.0.0
description: |
  QA a web or app feature from a ticket, URL, acceptance criteria, or plain-language description,
  then generate reusable browse flows for regression coverage. Uses the `browse` skill for the
  actual browser or simulator interaction and keeps the QA loop focused on scenarios, evidence, and
  report quality.
allowed-tools:
  - AskUserQuestion
  - Bash
  - Read
  - Write
  - Skill
argument-hint: "[feature, ticket, URL, or QA target]"
arguments:
  - request
when_to_use: |
  Use when the user asks to QA a feature, validate a story, test a page or app flow, or generate
  reusable regression coverage. Examples: "QA this checkout flow", "validate LINEAR-123", "test
  this localhost page", "turn this manual QA into rerunnable browse flows". Do not use for pure
  static code review.
effort: high
---

<EXTREMELY-IMPORTANT>
This skill owns the QA plan and report, not the low-level browser command encyclopedia.

Non-negotiable rules:
1. Turn the incoming spec into explicit scenarios before testing.
2. Confirm ambiguous targets or platforms before execution.
3. Use the `browse` skill for actual browser or simulator interaction.
4. Capture evidence for each failed or important scenario.
5. Save rerunnable flows only when they are cleanly scoped and valuable for regression.
</EXTREMELY-IMPORTANT>

# browse-qa

## Inputs

- `$request`: Ticket, URL, app target, acceptance criteria, or plain-language QA request

## Goal

Produce a credible QA run that:

- turns a vague request into explicit scenarios
- runs those scenarios against the real target
- captures evidence for passes and failures
- saves rerunnable browse flows when appropriate
- returns a clean QA report the user can act on

## Step 0: Resolve the target and spec

Work out:

- what feature is being tested
- the platform: web, iOS simulator, Android emulator, or macOS app
- the target URL, build artifact, or app identifier
- the acceptance criteria or expected outcomes

If the target or platform is ambiguous, ask before testing.

**Success criteria**: The QA target and acceptance criteria are explicit.

## Step 1: Build the scenario list

Break the request into:

- happy path
- validation or error path
- edge cases
- exploratory probes worth trying after the stated acceptance criteria

Keep the plan small enough to execute in one session unless the user asked for a broad QA sweep.

**Success criteria**: There is a concrete scenario list with expected outcomes.

## Step 2: Execute with the `browse` skill

Use `Skill` to invoke `browse` for:

- navigation
- page stabilization
- interactive element discovery
- clicks, fills, and submissions
- screenshots, console logs, and network inspection

Rules:

- keep the same browse session for one logical user journey unless isolation is intentional
- use headed or handoff mode only for real blockers like CAPTCHA, MFA, or OAuth walls
- save screenshots and flow artifacts under the browse session directories

**Success criteria**: Each scenario is executed against the real target with enough evidence to judge pass or fail.

## Step 3: Record reusable regression flows

When the scenario is stable and worth rerunning:

- record the flow
- split unrelated user journeys into separate flow files
- give each saved flow a descriptive name

Do not save noisy or half-manual recordings as regression artifacts.

**Success criteria**: Saved flows are independently rerunnable and map to clear scenarios.

## Step 4: Report results

For each scenario, record:

- expected result
- actual result
- pass or fail
- evidence such as screenshot path, console error, or network symptom

Also report:

- exploratory findings
- regression flow files created
- blockers that prevented full verification

**Success criteria**: Another engineer can understand the QA outcome without replaying the whole session first.

## Guardrails

- Do not duplicate the full browse command manual inline; use the `browse` skill.
- Do not guess a platform when the request is ambiguous.
- Do not save low-signal flows just to say a regression asset was created.
- Do not add `disable-model-invocation`; QA should stay available when the user asks for it.
- Do not add `context: fork`; results are usually needed in the current execution flow.

## Output Contract

Report:

1. target tested
2. scenarios executed
3. pass/fail result for each scenario
4. evidence captured
5. regression flow files created
6. blockers or uncovered gaps
