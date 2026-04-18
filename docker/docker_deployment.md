# Docker Deployment Guide

Deploy the **n8n WhatsApp bridge** using Docker for a consistent and isolated environment.

> [!NOTE]
> All commands below should be executed from the **root directory** of the project.

## 📋 Prerequisites

- Docker installed on your system.
- Docker Compose (optional, but recommended).

## 🚀 Deployment Options

> [!IMPORTANT]
> The Docker image builds from the current checked-out workspace. Local code changes are included in the image, and `.dockerignore` excludes bulky runtime folders such as `node_modules`, `auth_session`, and `log`.

### Option 1: Using Shell Scripts

Quick scripts provided for building, starting, and stopping.

1.  **Prepare the environment**:
    ```bash
    cp .env_example .env
    mkdir -p auth_session log
    ```

2.  **Update/Build**:
    ```bash
    sh docker/update.sh
    ```

3.  **Start**:
    ```bash
    sh docker/start.sh
    ```

4.  **Stop & Remove**:
    ```bash
    sh docker/stop.sh
    ```

---

### Option 2: Using Docker Compose (Recommended)

1.  **Prepare the environment**:
    ```bash
    cp .env_example .env
    mkdir -p auth_session log
    ```

2.  **Launch the container**:
    ```bash
    docker compose -f docker/docker-compose.yml up -d
    ```

---

### Option 3: Using Docker CLI

1.  **Build the image**:
    ```bash
    docker build -t whatsapp-bridge -f docker/Dockerfile .
    ```

2.  **Prepare the environment**:
    ```bash
    cp .env_example .env
    mkdir -p auth_session log
    ```

3.  **Run the container**:
    > [!IMPORTANT]
    > You must provide the `.env` file at runtime since it's not baked into the image for security.

    ```bash
    docker run -d \
      --name whatsapp-bridge \
      -p 3001:3001 \
      -v $(pwd)/auth_session:/app/auth_session \
      -v $(pwd)/log:/app/log \
      --env-file .env \
      whatsapp-bridge
    ```

## 🔍 Monitoring & Maintenance

- **View Logs**: `docker logs -f whatsapp-bridge`
- **Stop Container**: `docker stop whatsapp-bridge`
- **Check Status**: `docker compose -f docker/docker-compose.yml ps`
