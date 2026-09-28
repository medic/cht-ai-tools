# Runtime for the ai-review benchmark: the tools the `code-review` (OpenCodeReview) and
# `completeness-review` (claude-code-action) jobs install on the GitHub runner.
FROM node:22-bookworm

ARG OCR_VERSION
ARG CLAUDE_CODE_VERSION

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

# The runner's home, so the plugin cache paths in the workflow's --allowedTools resolve unchanged.
# The container runs as the host user, so the home must be writable by any uid.
ENV HOME=/home/runner
RUN mkdir -p "$HOME" \
  && curl -fsSL https://claude.ai/install.sh | bash -s -- "${CLAUDE_CODE_VERSION}" \
  && chmod -R a+rwX "$HOME" \
  && git config --system --add safe.directory '*'
ENV PATH=/home/runner/.local/bin:$PATH \
  DISABLE_AUTOUPDATER=1

WORKDIR /home/runner/work
