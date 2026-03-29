# Replay Examples

Record a session and export to different formats:

```bash
# Start recording
browse record start

# Do your actions
browse goto https://example.com
browse snapshot -i
browse click @e3
browse fill @e5 "search term"
browse press Enter

# Stop recording
browse record stop

# Export as different formats
browse record export browse        # Chain-compatible JSON
browse record export replay        # Chrome DevTools Recorder (Puppeteer)
browse record export playwright    # Playwright Test with assertions
```

## Export Formats

### Browse (chain JSON)
```bash
browse record export browse > replay.json
echo '$(cat replay.json)' | browse chain
```

### Puppeteer Replay
```bash
browse record export replay > recording.json
npx @puppeteer/replay recording.json
```

### Playwright Test
```bash
browse record export playwright > test.spec.ts
npx playwright test test.spec.ts
```
