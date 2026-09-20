# agent-watchdog container image. Contract: specs/001-watchdog-slack-loop/contracts/container.md
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    DISABLE_AUTOUPDATER=1 \
    DISABLE_TELEMETRY=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    CLAUDE_CONFIG_DIR=/tmp/agent-watchdog-runtime \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    TMPDIR=/tmp
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# Chromium headless shell installed through Playwright's own installer so browser and library versions move together.
RUN npx playwright-core install --with-deps chromium-headless-shell \
  && apt-get update && apt-get install -y --no-install-recommends fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/* /root/.npm \
  && chmod -R a+rX /ms-playwright
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY agent ./agent
COPY prompts ./prompts
COPY skill ./skill
COPY schema ./schema
COPY templates ./templates
COPY config/defaults ./config/defaults
RUN groupadd -g 10001 watchdog && useradd -u 10001 -g 10001 -d /home/watchdog -m watchdog \
  && mkdir -p /data /tmp/agent-watchdog-runtime && chown -R watchdog:watchdog /data /tmp/agent-watchdog-runtime
USER 10001:10001
LABEL org.opencontainers.image.source="https://github.com/medic/cht-ai-tools" \
      org.opencontainers.image.title="agent-watchdog" \
      org.opencontainers.image.licenses="AGPL-3.0"
ENTRYPOINT ["node", "bin/agent-watchdog.js"]
CMD ["--help"]
