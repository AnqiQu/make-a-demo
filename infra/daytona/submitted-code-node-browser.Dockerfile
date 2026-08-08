FROM mcr.microsoft.com/playwright:v1.60.0-noble

# build-essential and python3 let node-gyp compile native modules from
# source inside the sealed-network sandbox, where prebuilt binaries can
# never be downloaded.
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential ca-certificates ffmpeg git python3 unzip \
  && update-ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14" \
  && ln -sf /root/.bun/bin/bun /usr/local/bin/bun \
  && ln -sf /root/.bun/bin/bunx /usr/local/bin/bunx

RUN npm install -g --force pnpm@10.12.1 yarn@1.22.22 \
  && npm cache clean --force

RUN npm install -g \
    @playwright/test@1.60.0 \
    playwright@1.60.0 \
    typescript@5.7.3 \
  && npm cache clean --force

# Cache node-gyp's headers for this image's Node version (~/.cache/node-gyp):
# the offline lifecycle pass runs after the network reseals, where the
# header download can never succeed and every from-source native build
# would fail (ghost's better-sqlite3, 2026-08-08 matrix).
RUN npm install -g node-gyp@11.4.2 \
  && node-gyp install \
  && npm cache clean --force

RUN mkdir -p /workspace /workspace/.makeademo

WORKDIR /workspace
