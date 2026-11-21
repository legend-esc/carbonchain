# =============================================================================
# CarbonChain API — multi-stage Docker build
# Issue #1362: builder → runner separation; production-only deps; non-root user
# =============================================================================

# ── Stage 1: builder ──────────────────────────────────────────────────────────
# Install all dependencies (including devDependencies) and compile TypeScript.
FROM node:20-alpine AS builder

WORKDIR /app

# Install deps first so the layer is cached when only source changes.
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── Stage 2: runner ───────────────────────────────────────────────────────────
# Minimal image: production deps only, no source, no build toolchain.
FROM node:20-alpine AS runner

# Create a dedicated unprivileged user. Alpine's built-in `node` UID is 1000;
# we create `nodejs` at UID 1001 to avoid colliding with any host mapping.
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 --ingroup nodejs --no-create-home nodejs

WORKDIR /app

# Install production dependencies before dropping privileges so npm can
# write to /app. We copy only the lock files — no source needed.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output from builder stage.
COPY --from=builder /app/dist ./dist

# Lock down ownership so the nodejs user can read but not modify.
RUN chown -R nodejs:nodejs /app

EXPOSE 3000

# Switch to the unprivileged runtime user.
USER nodejs

# `nest build` with sourceRoot "src" emits to dist/main.js.
CMD ["node", "dist/main"]
