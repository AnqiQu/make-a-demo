FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client unzip \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.2.5" \
  && ln -sf /root/.bun/bin/bun /usr/local/bin/bun \
  && ln -sf /root/.bun/bin/bunx /usr/local/bin/bunx

RUN corepack enable \
  && corepack prepare pnpm@latest --activate \
  && corepack prepare yarn@stable --activate

RUN OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash \
  && ln -sf /root/.opencode/bin/opencode /usr/local/bin/opencode

WORKDIR /workspace
