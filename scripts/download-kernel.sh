#!/usr/bin/env bash
# Download a Firecracker-compatible Linux kernel (vmlinux).
#
# Uses the kernel published by the Firecracker team for CI testing.
# These kernels are minimal configs optimized for fast boot (~125ms).
#
# The kernel URL follows this pattern:
#   https://s3.amazonaws.com/spec.ccfc.min/ci-artifacts/kernels/<arch>/vmlinux-<version>
#
# To find the latest available versions, check:
#   https://github.com/firecracker-microvm/firecracker/blob/main/docs/kernel-policy.md
#   https://github.com/firecracker-microvm/firecracker/tree/main/resources/guest_configs
#
# Usage: bash scripts/download-kernel.sh [output-path] [kernel-version]

set -euo pipefail

OUTPUT="${1:-vmlinux}"
KERNEL_VERSION="${2:-5.10}"
ARCH="$(uname -m)"

# Validate architecture (Firecracker supports x86_64 and aarch64)
case "$ARCH" in
    x86_64|aarch64) ;;
    *)
        echo "Error: Unsupported architecture '$ARCH'."
        echo "       Firecracker supports x86_64 and aarch64 only."
        exit 1
        ;;
esac

# Firecracker publishes CI-tested kernels at this S3 bucket.
# These are vmlinux (uncompressed ELF) binaries, not bzImage.
BASE_URL="https://s3.amazonaws.com/spec.ccfc.min/ci-artifacts/kernels/${ARCH}"
KERNEL_URL="${BASE_URL}/vmlinux-${KERNEL_VERSION}"

echo "==> Downloading Firecracker kernel ${KERNEL_VERSION} for ${ARCH}..."
echo "    URL: ${KERNEL_URL}"

if command -v curl &>/dev/null; then
    curl -fSL -o "$OUTPUT" "$KERNEL_URL"
elif command -v wget &>/dev/null; then
    wget -O "$OUTPUT" "$KERNEL_URL"
else
    echo "Error: curl or wget required"
    exit 1
fi

# Verify the downloaded file looks like a kernel (ELF binary)
if command -v file &>/dev/null; then
    FILE_TYPE="$(file -b "$OUTPUT")"
    if echo "$FILE_TYPE" | grep -q "ELF"; then
        echo "==> Verified: ELF binary"
    else
        echo "Warning: Downloaded file does not appear to be an ELF binary."
        echo "         file type: $FILE_TYPE"
        echo "         The download URL may have changed. Check:"
        echo "         https://github.com/firecracker-microvm/firecracker/blob/main/docs/kernel-policy.md"
    fi
fi

echo "==> Kernel downloaded: $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"
echo "==> Kernel version: ${KERNEL_VERSION} (${ARCH})"
