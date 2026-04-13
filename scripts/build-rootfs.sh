#!/usr/bin/env bash
# Build a Firecracker-compatible ext4 rootfs image for browse sessions.
#
# Prerequisites: Docker, dd, mkfs.ext4, mount (Linux only for final image creation)
# Output: rootfs.ext4 (~800MB)
#
# The rootfs contains:
#   - Alpine Linux 3.21 base (~50MB)
#   - Node.js 18 LTS
#   - Chromium + Playwright dependencies
#   - browse server bundle (dist/browse.cjs)
#   - OpenRC init system with browse server service
#   - Network configuration (dhcpcd on eth0)
#
# Usage: bash scripts/build-rootfs.sh [output-path]

set -euo pipefail

# ── Platform check ──────────────────────────────────────────────
if [ "$(uname -s)" != "Linux" ]; then
    echo "Error: This script requires Linux for mount/ext4 operations."
    echo "       Firecracker microVMs only run on Linux hosts."
    echo ""
    echo "On macOS/Windows, use a Linux VM or CI pipeline to build the rootfs."
    exit 1
fi

OUTPUT="${1:-rootfs.ext4}"
IMAGE_SIZE_MB=1024
TEMP_DIR="$(mktemp -d)"
DOCKER_IMAGE="browse-rootfs-builder"

cleanup() {
    # Unmount if still mounted (defensive)
    if [ -n "${MOUNT_DIR:-}" ] && mountpoint -q "$MOUNT_DIR" 2>/dev/null; then
        sudo umount "$MOUNT_DIR" || true
    fi
    [ -n "${MOUNT_DIR:-}" ] && [ -d "$MOUNT_DIR" ] && rmdir "$MOUNT_DIR" 2>/dev/null || true
    # Remove temp container if it exists
    [ -n "${CONTAINER_ID:-}" ] && docker rm "$CONTAINER_ID" 2>/dev/null || true
    # Clean up temp dir
    rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

echo "==> Building rootfs contents via Docker..."

# ── Build a Docker image with everything the microVM needs ──────
cat > "$TEMP_DIR/Dockerfile" << 'DOCKERFILE'
FROM alpine:3.21

# Install base system + Chromium + Node.js
# - openrc: init system for service management
# - dhcpcd: DHCP client for network setup
# - chromium: headless browser (Alpine package, no Playwright download needed)
# - nss/freetype/harfbuzz: font rendering deps for Chromium
RUN apk add --no-cache \
    nodejs \
    npm \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    font-noto-emoji \
    dbus \
    openrc \
    dhcpcd \
    curl \
    bash

# Create app directory
RUN mkdir -p /app

# Copy package.json and install production deps.
# The esbuild bundle marks some packages as --external
# (playwright, better-sqlite3, etc.) so they need to be installed.
COPY package.json /app/
RUN cd /app && npm install --omit=dev --ignore-scripts 2>/dev/null || true

# Copy browse server bundle
COPY dist/browse.cjs /app/dist/

# Configure OpenRC init script for the browse server
COPY browse-init /etc/init.d/browse
RUN chmod +x /etc/init.d/browse && rc-update add browse default

# Configure network (DHCP on eth0)
RUN rc-update add dhcpcd default

# Configure hostname
RUN echo "browse-vm" > /etc/hostname

# Set environment for browse server
ENV NODE_ENV=production
ENV __BROWSE_SERVER_MODE=1
ENV BROWSE_PORT=9400
ENV BROWSE_IDLE_TIMEOUT=300000
ENV BROWSE_LOCAL_DIR=/tmp
ENV CHROMIUM_PATH=/usr/bin/chromium-browser
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Create non-root user for running the browse server
RUN adduser -D -h /app browse && chown -R browse:browse /app
DOCKERFILE

# ── Create the OpenRC init script ───────────────────────────────
cat > "$TEMP_DIR/browse-init" << 'INITSCRIPT'
#!/sbin/openrc-run

name="browse-server"
description="Browse headless browser server"
command="/usr/bin/node"
command_args="/app/dist/browse.cjs"
command_user="browse"
pidfile="/run/${RC_SVCNAME}.pid"
command_background=true

depend() {
    need net
    after dhcpcd
}

start_pre() {
    export NODE_ENV=production
    export __BROWSE_SERVER_MODE=1
    export BROWSE_PORT=9400
    export BROWSE_IDLE_TIMEOUT=300000
    export BROWSE_LOCAL_DIR=/tmp
    export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser
}
INITSCRIPT

# ── Copy project files needed for Docker build ──────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cp "$REPO_ROOT/package.json" "$TEMP_DIR/"
mkdir -p "$TEMP_DIR/dist"
if [ -f "$REPO_ROOT/dist/browse.cjs" ]; then
    cp "$REPO_ROOT/dist/browse.cjs" "$TEMP_DIR/dist/"
else
    echo "Warning: dist/browse.cjs not found. Run 'npm run build' first."
    echo "Creating placeholder for rootfs structure validation."
    echo '#!/usr/bin/env node' > "$TEMP_DIR/dist/browse.cjs"
    echo 'console.log("browse server placeholder");' >> "$TEMP_DIR/dist/browse.cjs"
fi

# Build Docker image (used only as a build tool — the output is ext4, not a Docker image)
docker build -t "$DOCKER_IMAGE" "$TEMP_DIR"

echo "==> Creating ext4 image (${IMAGE_SIZE_MB}MB)..."

# ── Create empty ext4 image ─────────────────────────────────────
dd if=/dev/zero of="$OUTPUT" bs=1M count=$IMAGE_SIZE_MB status=progress
mkfs.ext4 -F "$OUTPUT"

# ── Mount and extract Docker filesystem into ext4 ───────────────
MOUNT_DIR="$(mktemp -d)"
sudo mount -o loop "$OUTPUT" "$MOUNT_DIR"

# Export the Docker image filesystem (flat tarball) and extract
CONTAINER_ID=$(docker create "$DOCKER_IMAGE")
docker export "$CONTAINER_ID" | sudo tar -xf - -C "$MOUNT_DIR"
docker rm "$CONTAINER_ID"
CONTAINER_ID=""

# Ensure required pseudo-filesystem mount points exist
sudo mkdir -p "$MOUNT_DIR/dev" "$MOUNT_DIR/proc" "$MOUNT_DIR/sys" "$MOUNT_DIR/run" "$MOUNT_DIR/tmp"
sudo chmod 1777 "$MOUNT_DIR/tmp"

# ── Create /etc/fstab ──────────────────────────────────────────
sudo bash -c "cat > '$MOUNT_DIR/etc/fstab'" << 'FSTAB'
/dev/vda    /       ext4    defaults,noatime    0 1
proc        /proc   proc    defaults            0 0
sysfs       /sys    sysfs   defaults            0 0
devtmpfs    /dev    devtmpfs defaults           0 0
tmpfs       /tmp    tmpfs   defaults,size=256m  0 0
FSTAB

# ── Create /etc/inittab for OpenRC init ─────────────────────────
# Serial console on ttyS0 is the default Firecracker console
sudo bash -c "cat > '$MOUNT_DIR/etc/inittab'" << 'INITTAB'
::sysinit:/sbin/openrc sysinit
::sysinit:/sbin/openrc boot
::sysinit:/sbin/openrc default
::ctrlaltdel:/sbin/reboot
::shutdown:/sbin/openrc shutdown
ttyS0::respawn:/sbin/getty 115200 ttyS0
INITTAB

sudo umount "$MOUNT_DIR"
rmdir "$MOUNT_DIR"
MOUNT_DIR=""

# ── Cleanup Docker artifacts ───────────────────────────────────
docker rmi "$DOCKER_IMAGE" 2>/dev/null || true

echo "==> Rootfs created: $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"
echo "==> To use with Firecracker:"
echo "    firecracker --config-file vm-config.json"
echo "    (set boot_source.kernel_image_path and drives[0].path_on_host)"
