#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

sudo docker build --no-cache -t whatsapp-bridge -f "${ROOT_DIR}/docker/Dockerfile" "${ROOT_DIR}"
