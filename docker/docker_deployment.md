# 🐳 Docker Deployment Guide

Deploy the **Trend AI Guard Demo** using Docker for a consistent and isolated environment.

> [!NOTE]
> All commands below should be executed from the **root directory** of the project.

## 📋 Prerequisites

- Docker installed on your system.
- Docker Compose (optional, but recommended).

## 🚀 Deployment Options

### Option 1: Using Docker Compose (Recommended)

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

### Option 2: Using Docker CLI

1.  **Build the image**:
    ```bash
    docker build -t trend-ai-guard -f docker/Dockerfile .
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
      --name ai-guard \
      -p 3000:3000 \
      -v $(pwd)/auth_session:/app/auth_session \
      -v $(pwd)/log:/app/log \
      --env-file .env \
      trend-ai-guard
    ```

---

### Option 3: Using Shell Scripts

Quick scripts provided for building, starting, and stopping.

1.  **Update/Build**:
    ```bash
    sh docker/update.sh
    ```

2.  **Start**:
    ```bash
    sh docker/start.sh
    ```

3.  **Stop & Remove**:
    ```bash
    sh docker/stop.sh
    ```

## 🔍 Monitoring & Maintenance

- **View Logs**: `docker logs -f ai-guard`
- **Stop Container**: `docker stop ai-guard`
- **Check Status**: `docker compose -f docker/docker-compose.yml ps`