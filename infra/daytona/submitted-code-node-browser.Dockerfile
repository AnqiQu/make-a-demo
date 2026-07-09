FROM mcr.microsoft.com/playwright:v1.60.0-noble

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg git unzip \
  && update-ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.2.5" \
  && ln -sf /root/.bun/bin/bun /usr/local/bin/bun \
  && ln -sf /root/.bun/bin/bunx /usr/local/bin/bunx

RUN npm install -g --force pnpm@10.12.1 yarn@1.22.22 \
  && npm cache clean --force

RUN npm install -g \
    @playwright/test@1.60.0 \
    playwright@1.60.0 \
    typescript@5.7.3 \
  && npm cache clean --force

RUN mkdir -p /workspace /workspace/.makeademo

WORKDIR /workspace
