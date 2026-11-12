# AIClipStudio - Production Docker Image
FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV PY_SERVICE_PORT=8611
ENV PYTHON=/app/.venv/bin/python
ENV AICLIP_WHISPER_CACHE=/app/.cache/whisper
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-venv \
    python3-pip \
    python3-dev \
    build-essential \
    pkg-config \
    ffmpeg \
    libglib2.0-0 \
    libgl1 \
    libsm6 \
    libxext6 \
    libxrender1 \
    libgomp1 \
    fonts-noto-core \
    fonts-noto-extra \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js dependencies
COPY package.json package-lock.json ./

RUN npm ci --omit=dev

# Create Python virtual environment
RUN python3 -m venv /app/.venv

# Install Python dependencies
COPY py/requirements.txt ./py/requirements.txt

RUN /app/.venv/bin/pip install --no-cache-dir --upgrade pip setuptools wheel \
    && /app/.venv/bin/pip install --no-cache-dir -r py/requirements.txt "av<19"

# Copy application source
COPY . .

# Make bundled FFmpeg binaries executable
RUN chmod +x vendor/ffmpeg-* vendor/ffprobe-* 2>/dev/null || true

# Create runtime directories
RUN mkdir -p jobs /app/.cache/whisper

# Northflank public HTTP port
EXPOSE 3000

# Start Node.js backend
CMD ["node", "server.js"]
