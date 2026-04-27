#!/bin/sh
# ============================================================================
# WAG Entrypoint Script
# ============================================================================
# Runs as root inside the container on startup to fix bind-mount permissions,
# then drops to the unprivileged 'wag' user for the Node.js process.
#
# Why this is needed:
#   When Docker creates the host bind-mount directory (./data) automatically,
#   it is owned by root. The 'wag' user (UID 1001) cannot write session files
#   to a root-owned directory. This script ensures /app/data is always
#   writable by the application user before launch.
# ============================================================================

set -e

# Ensure the data directory exists and is owned by the app user
mkdir -p /app/data/session /app/data/logs
chown -R wag:nodejs /app/data

# Drop privileges and execute the main command (node server.js)
exec su-exec wag "$@"
