#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

sudo docker run -d \
  --name whatsapp-bridge \
  --restart always \
  -p 3001:3001 \
  -v "${ROOT_DIR}/auth_session:/app/auth_session" \
  -v "${ROOT_DIR}/log:/app/log" \
  --env-file "${ROOT_DIR}/.env" \
  whatsapp-bridge
