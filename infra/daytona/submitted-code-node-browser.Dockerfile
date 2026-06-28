FROM mcr.microsoft.com/playwright:v1.49.1-noble

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg unzip \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.2.5" \
  && ln -sf /root/.bun/bin/bun /usr/local/bin/bun \
  && ln -sf /root/.bun/bin/bunx /usr/local/bin/bunx

RUN corepack enable \
  && corepack prepare pnpm@latest --activate \
  && corepack prepare yarn@stable --activate

RUN npm install -g \
    @playwright/test@1.49.1 \
    playwright@1.49.1 \
    typescript@5.7.3 \
  && npm cache clean --force

RUN mkdir -p /workspace /workspace/.makeademo

WORKDIR /workspace
