# Use a lightweight Node.js image
FROM node:22-alpine

# Set working directory
WORKDIR /app

# Copy the current workspace into the image
COPY . .

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
