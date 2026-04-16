#!/bin/bash
sudo docker run -d \
  --name whatsapp-bridge \
  --restart always \
  -p 3001:3001 \
  -v $(pwd)/auth_session:/app/auth_session \
  -v $(pwd)/log:/app/log \
  --env-file .env \
  whatsapp-bridge
