# Runtime for the ai-review benchmark: the tools the `code-review` (OpenCodeReview) and
# `completeness-review` (claude-code-action) jobs install on the GitHub runner.
# trixie, for a git new enough for OCR (>= 2.41)
FROM node:22-trixie

# Versions from https://github.com/medic/cht-core/blob/master/.github/workflows/ai-review.yml
ARG OCR_VERSION=1.12.9
# Installed by anthropics/claude-code-action v1.0.239
ARG CLAUDE_CODE_VERSION=2.1.287

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git jq \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# Same install commands the actions run
RUN npm install -g "@alibaba-group/open-code-review@${OCR_VERSION}" && ocr version
ENV OCR_NO_UPDATE=1 \
  OCR_LLM_TIMEOUT=300 \
  OCR_TASK_TIMEOUT=15

# Everything under the runner's home is created as the host user (passed in by run.mjs), who the container runs as.
# Otherwise OCR and Claude can't update their config at run time.
ARG UID=1000
ARG GID=1000
ENV HOME=/home/runner
RUN mkdir -p "$HOME" && chown "${UID}:${GID}" "$HOME" \
  && git config --system --add safe.directory '*'
USER ${UID}:${GID}
RUN curl -fsSL https://claude.ai/install.sh | bash -s -- "${CLAUDE_CODE_VERSION}" \
  && mkdir -p "$HOME/.claude"
ENV PATH=/home/runner/.local/bin:$PATH \
  DISABLE_AUTOUPDATER=1

# The open-code-review action's "Configure OCR" step, with the workflow's inputs and the action's defaults.
# llm.model and llm.extra_body are set per run by run.mjs.
RUN ocr config unset provider \
  && ocr config set llm.auth_token "" \
  && ocr config set llm.extra_headers "" \
  && ocr config set llm.retry_codes "" \
  && ocr config set llm.url https://api.anthropic.com \
  && ocr config set llm.use_anthropic true \
  && ocr config set llm.protocol anthropic \
  && ocr config set llm.auth_header x-api-key \
  && ocr config set llm.auth_token_cmd 'printf "%s" "$OCR_LLM_TOKEN"' \
  && ocr config set language English

# What claude-code-action sets up before running the prompt: the workflow's settings and plugins.
# The plugins come from this checkout (the build context is the repo root), so local changes to the skill are tested.
# Before the plugin installs, which add the plugins to enabledPlugins in this file
COPY --chown=${UID}:${GID} benchmark/ai-review/claude-settings.json /home/runner/.claude/settings.json
COPY .claude-plugin /opt/cht-ai-tools/.claude-plugin
COPY .mcp.json /opt/cht-ai-tools/.mcp.json
COPY skills /opt/cht-ai-tools/skills
COPY hooks /opt/cht-ai-tools/hooks
COPY commands /opt/cht-ai-tools/commands
RUN claude plugin marketplace add /opt/cht-ai-tools \
  && claude plugin install cht-pr-review@medic-cht-ai-tools \
  && claude plugin install cht-docs-mcp@medic-cht-ai-tools

WORKDIR /home/runner/work
