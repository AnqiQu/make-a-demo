#!/bin/bash
set -euo pipefail

# Remote Claude Code sessions default to Claude as the git identity; local
# sessions already carry the developer's own config, so only override remotely.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

git config --global user.name "Anqi Qu"
git config --global user.email "anqiqu@gmail.com"
