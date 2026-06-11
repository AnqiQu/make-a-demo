FROM oven/bun:1.2.5

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client \
  && rm -rf /var/lib/apt/lists/*

RUN OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash \
  && ln -sf /root/.opencode/bin/opencode /usr/local/bin/opencode

WORKDIR /workspace
