# agent-watchdog container image. Contract: specs/001-watchdog-slack-loop/contracts/container.md (FR-086, revision 30).
# Build-time network: the npm registry alone. Run-time egress: `agent-watchdog egress` lists it and the platform's
# network policy enforces it (FR-083). The image carries no secrets, no policy files, no run data and no browser.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Production dependencies from the lockfile only; no lifecycle script runs (the one postinstall in the tree is
# protobufjs's version warning, not needed).
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM node:22-bookworm-slim
ARG VERSION=0.0.0-development
ARG REVISION=unknown
ENV NODE_ENV=production \
    DISABLE_AUTOUPDATER=1 \
    DISABLE_TELEMETRY=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    CLAUDE_CONFIG_DIR=/tmp/agent-watchdog-runtime \
    HOME=/home/watchdog \
    TMPDIR=/tmp
WORKDIR /app
# The application and its dependencies are owned by root and read-only to the runtime user: a run cannot change its
# own code (constitution VII). Everything a run writes goes to /data or /tmp (FR-086).
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY agent ./agent
COPY prompts ./prompts
COPY skill ./skill
COPY schema ./schema
COPY templates ./templates
COPY config/defaults ./config/defaults
# The Agent SDK ships the Claude Code runtime as a native binary; on PATH as `claude` it is also the CLI engine's
# executable (`claude -p`) and the way a contributor logs in locally (contracts/container.md, revision 32). The build
# fails if the platform package is missing rather than shipping an image without it.
RUN test -x /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude \
  && ln -s /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude /usr/local/bin/claude
RUN groupadd -g 10001 watchdog && useradd -u 10001 -g 10001 -d /home/watchdog -m -s /usr/sbin/nologin watchdog \
  && mkdir -p /data /home/watchdog/.claude && chown -R watchdog:watchdog /data /home/watchdog
USER 10001:10001
LABEL org.opencontainers.image.source="https://github.com/medic/cht-ai-tools" \
      org.opencontainers.image.title="agent-watchdog" \
      org.opencontainers.image.licenses="AGPL-3.0" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
ENTRYPOINT ["node", "bin/agent-watchdog.js"]
CMD ["--help"]
