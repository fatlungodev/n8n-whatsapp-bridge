#!/bin/bash

set -euo pipefail

sudo docker stop whatsapp-bridge || true
sudo docker rm whatsapp-bridge || true
