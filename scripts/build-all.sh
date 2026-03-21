#!/usr/bin/env bash
set -euo pipefail

# Build Node.js bundle via esbuild
OUTDIR="dist"
ENTRY="src/cli.ts"

mkdir -p "$OUTDIR"

echo "Building ${OUTDIR}/browse.js..."
npx esbuild "$ENTRY" \
  --bundle \
  --platform=node \
  --target=node18 \
  --outfile="$OUTDIR/browse.js" \
  --external:playwright \
  --external:playwright-core \
  --external:better-sqlite3 \
  --external:electron \
  --external:chromium-bidi

echo "  → $(wc -c < "$OUTDIR/browse.js" | tr -d ' ') bytes"
echo ""
echo "Run with: node $OUTDIR/browse.js"
