#!/bin/sh
set -eu

image="${MAKEADEMO_SUBMITTED_CODE_IMAGE:-makeademo-submitted-code:node-browser}"
dockerfile="/opt/makeademo/submitted-code-node-browser.Dockerfile"

docker build -t "$image" -f "$dockerfile" /opt/makeademo
