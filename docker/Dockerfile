# Use a lightweight Node.js image
FROM node:22-alpine

# git is required for GitHub-based npm deps.
RUN apk add --no-cache git

# Set working directory
WORKDIR /app

# Keep the container's runtime port aligned with the local deployment config.
ENV PORT=3001

# Install production dependencies first for better layer reuse
COPY package.json package-lock.json ./
RUN npm install -g npm@11.9.0 \
    && npm ci --omit=dev

# Copy the application source from the checked-out workspace
COPY src ./src
COPY public ./public
COPY README.md ./
COPY .env_example ./

# Create volume mount points for persistence
# - /app/log: Stores application logs
RUN mkdir -p /app/auth_session /app/log
VOLUME ["/app/auth_session", "/app/log"]

# Expose the port the app runs on
EXPOSE 3001

# Start the application
CMD ["npm", "start"]
