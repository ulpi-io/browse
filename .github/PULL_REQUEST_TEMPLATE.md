## Summary

<!-- What does this PR do and why? Link to any related issues. -->

## Changes

<!-- List the specific changes made. Group by file or area if touching multiple parts. -->

## Test plan

<!-- How did you verify this works? Include commands you ran. -->

- [ ] `npm test` passes
- [ ] `npm run build` succeeds
- [ ] Tested manually with `npx tsx src/cli.ts <command>`

### Manual verification

<!-- Paste the actual CLI output from your testing: -->

```bash
# Example:
# npx tsx src/cli.ts goto https://example.com
# npx tsx src/cli.ts your-command
# <output>
```

## Checklist

### Required for all PRs

- [ ] No breaking changes (or documented in "Breaking changes" section below)
- [ ] TypeScript compiles with no errors (`npx tsc --noEmit`)

### Required for new commands

- [ ] Command registered in `src/server.ts` (`READ_COMMANDS`, `WRITE_COMMANDS`, or `META_COMMANDS`)
- [ ] Help text added in `src/cli.ts`
- [ ] Added to `chain` command sets in `src/commands/meta.ts`
- [ ] @ref selectors supported where applicable (via `bm.resolveRef()`)
- [ ] Read-only commands added to `SAFE_TO_RETRY` in `src/cli.ts`
- [ ] Tests added in the appropriate test file

### Required for commands with selectors

- [ ] Both CSS selectors and `@ref` selectors work
- [ ] Error message shown when selector is missing
- [ ] Tested with elements inside iframes (if applicable)

### Session safety

- [ ] Works correctly with `--session` flag (per-session state isolation)
- [ ] No global/shared state introduced (use `SessionBuffers`, not global buffers)

## Breaking changes

<!-- If any, describe the breaking change and migration path. Remove this section if none. -->

N/A

## Screenshots / recordings

<!-- For visual commands (screenshot, snapshot, responsive, etc.), attach before/after. Remove if not applicable. -->
