FROM mcr.microsoft.com/playwright:v1.60.0-noble

# build-essential and python3 let node-gyp compile native modules from
# source inside the sealed-network sandbox, where prebuilt binaries can
# never be downloaded. python3-setuptools restores the distutils shim that
# Python 3.12 removed — vendored node-gyp vintages (calcom's sqlite3 ships
# node-gyp 8) import distutils during configure.
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential ca-certificates ffmpeg git python3 python3-setuptools unzip \
  && update-ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Data-service binaries for the provisioned-service rung (N122(5)): the
# sandbox-services module boots these on loopback inside the sealed sandbox,
# so they must ship in the snapshot. mariadb-server answers the mysql service
# class — detection normalizes mariadb/percona onto mysql and the protocol is
# what drivers dial. Versions are whatever the noble archive pins; the
# snapshot itself is the version pin. The apt-created default postgres
# cluster and any auto-start units are irrelevant here: nothing supervises
# services in the sandbox, the module initializes its own data directories.
RUN apt-get update \
  && apt-get install -y --no-install-recommends mariadb-server postgresql postgresql-contrib redis-server \
  && rm -rf /var/lib/apt/lists/*

# Node lines (N78): every common LTS line is baked as a checksum-verified
# official tarball so the backend can swap /usr/local wholesale to the
# repository's pinned line before any repo command runs. Post-swap there is
# exactly one Node in the sandbox — binaries and headers agree by
# construction. Keep MAKEADEMO_NODE_LINES in sync with SUPPORTED_NODE_LINES
# (src/server/agent-harness/tools/node-line-resolution.ts); the dockerfile
# content test enforces the pairing. The base image's apt-installed Node is
# removed entirely — its /usr/include/node headers are the stale-ABI trap
# that broke ghost's better-sqlite3 (2026-08-08 matrix).
ARG MAKEADEMO_NODE_LINES="20 22 24"
ARG MAKEADEMO_DEFAULT_NODE_LINE="24"
RUN set -eux; \
  apt-get purge -y nodejs || true; \
  rm -rf /usr/include/node /usr/local/lib/node_modules \
    /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack; \
  mkdir -p /opt/node-lines; \
  for line in $MAKEADEMO_NODE_LINES; do \
    curl -fsSL -o /tmp/SHASUMS256.txt "https://nodejs.org/dist/latest-v${line}.x/SHASUMS256.txt"; \
    file="$(grep -o "node-v${line}\.[0-9.]*-linux-x64\.tar\.gz" /tmp/SHASUMS256.txt | head -1)"; \
    curl -fsSL -o "/opt/node-lines/${file}" "https://nodejs.org/dist/latest-v${line}.x/${file}"; \
    cd /opt/node-lines && grep " ${file}\$" /tmp/SHASUMS256.txt | sha256sum -c -; \
    rm /tmp/SHASUMS256.txt; \
  done; \
  tar -xzf /opt/node-lines/node-v${MAKEADEMO_DEFAULT_NODE_LINE}.*-linux-x64.tar.gz \
    -C /usr/local --strip-components=1; \
  echo "${MAKEADEMO_DEFAULT_NODE_LINE}" > /usr/local/.makeademo-node-line; \
  node --version

# Native compiles resolve headers from the active /usr/local node (the
# tarballs ship include/node), so offline node-gyp builds always match the
# runtime ABI — including after a line swap.
ENV npm_config_nodedir=/usr/local

# Package managers come from corepack (bundled with every node line): a
# pinned "packageManager" resolves exactly (outline's yarn@4.11.0) and the
# defaults below are cached for offline use. COREPACK_HOME lives outside
# /usr/local so the cache survives line swaps; swaps re-run corepack enable
# because the shims live in the swapped bin directory. COREPACK_NPM_REGISTRY
# routes every corepack fetch to the registry family installs already depend
# on (N164): corepack's default yarn host repo.yarnpkg.com proved
# unreachable from the sandbox even inside the open install window (twenty,
# 2026-08-22). The harness also sets these per command in case this image
# lags; keep the values in sync with toolchainBootstrapEnv
# (src/server/agent-harness/default/default-harness-dependencies.ts).
ENV COREPACK_HOME=/opt/corepack-cache \
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  COREPACK_DEFAULT_TO_LATEST=0 \
  COREPACK_NPM_REGISTRY=https://registry.npmjs.org
RUN corepack enable \
  && corepack install -g yarn@1.22.22 pnpm@10.12.1 \
  && yarn --version \
  && pnpm --version

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14" \
  && ln -sf /root/.bun/bin/bun /usr/local/bin/bun \
  && ln -sf /root/.bun/bin/bunx /usr/local/bin/bunx

# Harness tooling lives in its own prefix so a node-line swap can never
# delete the capture stack; harness scripts resolve it through
# MAKEADEMO_TOOLS_NODE_MODULES instead of `npm root -g`.
ENV MAKEADEMO_TOOLS_NODE_MODULES=/opt/makeademo-tools/lib/node_modules
RUN npm install -g --prefix /opt/makeademo-tools \
    @playwright/test@1.60.0 \
    playwright@1.60.0 \
    typescript@5.7.3 \
    node-gyp@11.4.2 \
  && npm cache clean --force
ENV PATH="/opt/makeademo-tools/bin:${PATH}"

RUN mkdir -p /workspace /workspace/.makeademo

WORKDIR /workspace
