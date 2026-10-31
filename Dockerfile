# ========================================================
# CodeSentinel Hermetic Security Backend & MCP Server
# ========================================================

# Stage 1: Build the standalone bundles
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./
COPY esbuild.config.mjs ./

RUN npm ci

COPY src ./src
COPY resources ./resources

RUN npm run build

# Stage 2: Minimal runtime image
FROM node:22-alpine AS runtime

# Install Git, curl, tar and baseline utilities for repository inspection
RUN apk add --no-cache \
    git \
    bash \
    curl \
    tar \
    ca-certificates

# Install Atlas Semantic Code Graph Engine (v1.7.0 universal binary)
RUN curl -fsSL https://github.com/LordCasser/atlas/releases/download/v1.7.0/atlas-linux-x86_64.tar.gz | tar -xz -C /usr/local/bin \
    && chmod +x /usr/local/bin/atlas

# Install OpenCode AI Agent CLI globally inside the unified container
RUN npm install -g opencode-ai@1.18.35

WORKDIR /app

COPY package*.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/resources ./resources

# Install production dependencies
RUN npm ci --omit=dev && npm cache clean --force

# Default workspace directory for mounted projects
WORKDIR /workspace

ENV NODE_ENV=production \
    CODESENTINEL_CONTAINER=true

# Create non-root user for runtime security (CWE-269 remediation)
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

# Launch the CodeSentinel MCP Server CLI over stdio by default
ENTRYPOINT ["node", "/app/dist/mcp-server.js"]
