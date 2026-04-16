# Use a lightweight Node.js image
FROM node:22-alpine

# git is required both for cloning the app repo and for GitHub-based npm deps.
RUN apk add --no-cache git

# Clone the upstream bridge source into the image during build.
ARG APP_REPO_URL=https://github.com/fatlungodev/n8n-whatsapp-bridge.git
RUN git clone --depth 1 "${APP_REPO_URL}" /app \
    && rm -rf /app/.git

# Set working directory
WORKDIR /app

# Keep the container's runtime port aligned with the local deployment config.
ENV PORT=3001

# Install production dependencies
RUN npm install -g npm@11.9.0 \
    && npm install --omit=dev

# Create volume mount points for persistence
# - /app/log: Stores application logs
VOLUME ["/app/auth_session", "/app/log"]

# Expose the port the app runs on
EXPOSE 3001

# Start the application
CMD ["npm", "start"]
