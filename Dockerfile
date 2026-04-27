# ============================================================================
# WAG — Dockerfile
# ============================================================================
# Multi-stage build using Node.js 22 Alpine for a minimal production image.
#
# Build context: repository root (where this Dockerfile lives).
# The Node.js application source lives in ./src/ and is copied into /app.
#
# Stages:
#   1. deps    — Install production npm dependencies.
#   2. runner  — Copy app + node_modules, run as non-root user.
# ============================================================================

# ----------------------------------------------------------------------------
# Stage 1: Dependencies
# ----------------------------------------------------------------------------
FROM node:22-alpine AS deps

# Set working directory inside the build stage
WORKDIR /deps

# Install only what's needed to build native modules (if any)
RUN apk add --no-cache libc6-compat

# Copy dependency manifests first (maximises Docker layer cache)
COPY src/package.json src/package-lock.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# ----------------------------------------------------------------------------
# Stage 2: Runtime
# ----------------------------------------------------------------------------
FROM node:22-alpine AS runner

# Metadata labels (useful for image inspection)
LABEL org.opencontainers.image.title="WAG — WhatsApp Ghost"
LABEL org.opencontainers.image.description="Containerised WhatsApp Web automation with Web GUI"
LABEL org.opencontainers.image.source="https://github.com/wotsthestory/wag"

# Install curl for the HEALTHCHECK instruction
RUN apk add --no-cache curl

# Create a non-root user/group for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S wag -u 1001

# Set working directory
WORKDIR /app

# Copy production node_modules from deps stage
COPY --from=deps /deps/node_modules ./node_modules

# Copy application source code (server.js + public/)
COPY --chown=wag:nodejs src/ ./

# Create data directory for session persistence and logs
RUN mkdir -p /app/data/session /app/data/logs && chown -R wag:nodejs /app/data

# Switch to non-root user
USER wag

# Expose the HTTP port defined in server.js (default 3000)
EXPOSE 3000

# Health check — Kubernetes/Docker compatible
# Returns 200 from /api/health when the service is alive and responsive
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fs http://localhost:3000/api/health || exit 1

# Default command: start the Express server
CMD ["node", "server.js"]
