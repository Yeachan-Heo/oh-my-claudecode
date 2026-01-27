# SWE-bench Evaluation Container for oh-my-claudecode
# Supports both vanilla Claude Code and OMC-enhanced modes

FROM python:3.11-slim

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    gnupg \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20.x (LTS)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Docker CLI (for SWE-bench container operations)
RUN curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /workspace

# Copy requirements first for layer caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Create directories for benchmark artifacts
RUN mkdir -p /workspace/results \
    /workspace/predictions \
    /workspace/repos \
    /workspace/logs \
    /root/.claude

# Environment variables
ENV PYTHONUNBUFFERED=1
ENV NODE_ENV=production

# Default run mode (vanilla or omc)
ENV RUN_MODE=vanilla

# For OMC mode: install oh-my-claudecode globally
# This is done conditionally at runtime via entrypoint
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD claude --version || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["bash"]
