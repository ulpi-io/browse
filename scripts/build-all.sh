#!/usr/bin/env bash
set -euo pipefail

# Build standalone platform binaries using bun build --compile
# No Bun runtime needed to run the output binaries.

OUTDIR="dist"
ENTRY="src/cli.ts"

mkdir -p "$OUTDIR"

targets=(
  "bun-darwin-arm64"
  "bun-darwin-x64"
  "bun-linux-x64"
)

for target in "${targets[@]}"; do
  # Extract platform-arch from "bun-<platform>-<arch>"
  suffix="${target#bun-}"  # e.g., "darwin-arm64"
  outfile="$OUTDIR/browse-${suffix}"

  echo "Building ${outfile}..."
  bun build --compile --external electron --external chromium-bidi --target="$target" "$ENTRY" --outfile "$outfile"
  echo "  → $(ls -lh "$outfile" | awk '{print $5}')"
done

echo ""
echo "Done. Binaries in $OUTDIR/:"
ls -lh "$OUTDIR"/browse-*
