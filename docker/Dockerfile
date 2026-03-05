# Use a lightweight Node.js image
FROM node:22-alpine

# Install git for cloning
RUN apk add --no-cache git

# Set working directory
WORKDIR /app

# Clone the repository
# Default to the current origin, but allow override via build-arg
ARG REPO_URL=https://github.com/fatlungodev/Trend-AI-guard-demo.git
RUN git clone ${REPO_URL} .

# Install production dependencies
RUN npm install --omit=dev
RUN npm install -g npm@11.9.0
RUN npm install @whiskeysockets/baileys@kobie3717/Baileys#fix/405-platform-macos
# Create volume mount points for persistence
# - /app/log: Stores application logs
VOLUME ["/app/auth_session", "/app/log"]

# Expose the port the app runs on
EXPOSE 3000

# Start the application
CMD ["npm", "start"]