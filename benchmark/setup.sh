#!/bin/bash
set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

log_info "Starting benchmark setup..."

# 1. Check for required tools
log_info "Checking for required tools..."
command -v docker >/dev/null 2>&1 || { log_error "Docker is required but not installed. Aborting."; exit 1; }
command -v python3 >/dev/null 2>&1 || { log_error "Python 3 is required but not installed. Aborting."; exit 1; }
command -v npm >/dev/null 2>&1 || { log_error "npm is required but not installed. Aborting."; exit 1; }

log_info "All required tools found."

# 2. Create necessary directories
log_info "Creating directory structure..."
mkdir -p "$SCRIPT_DIR/predictions/vanilla"
mkdir -p "$SCRIPT_DIR/predictions/omc"
mkdir -p "$SCRIPT_DIR/logs"
mkdir -p "$SCRIPT_DIR/data"
mkdir -p "$SCRIPT_DIR/cache"

# 3. Check API token
log_info "Checking for ANTHROPIC_AUTH_TOKEN..."
if [ -z "${ANTHROPIC_AUTH_TOKEN:-}" ]; then
    log_error "ANTHROPIC_AUTH_TOKEN is not set. Please export it:"
    log_error "  export ANTHROPIC_AUTH_TOKEN=your_token_here"
    exit 1
fi
log_info "API token found."

# 4. Install Python dependencies
log_info "Installing Python dependencies..."
if [ -f "$SCRIPT_DIR/requirements.txt" ]; then
    python3 -m pip install -r "$SCRIPT_DIR/requirements.txt" --quiet
else
    log_warn "No requirements.txt found, installing common dependencies..."
    python3 -m pip install anthropic docker datasets python-dotenv --quiet
fi

# 5. Build Docker image for SWE-bench
log_info "Building Docker image for SWE-bench..."
if [ -f "$SCRIPT_DIR/Dockerfile" ]; then
    docker build -t swe-bench-runner "$SCRIPT_DIR" -q
else
    log_warn "No Dockerfile found. Creating a basic one..."
    cat > "$SCRIPT_DIR/Dockerfile" << 'EOF'
FROM python:3.11-slim

RUN apt-get update && apt-get install -y \
    git \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

CMD ["/bin/bash"]
EOF
    docker build -t swe-bench-runner "$SCRIPT_DIR" -q
fi

# 6. Download and cache dataset
log_info "Downloading SWE-bench dataset..."
python3 -c "
import os
import sys

try:
    from datasets import load_dataset
    cache_dir = os.path.join('$SCRIPT_DIR', 'cache')

    # Download SWE-bench-lite for faster testing
    print('  Downloading SWE-bench-lite...')
    dataset = load_dataset('princeton-nlp/SWE-bench_Lite', cache_dir=cache_dir)
    print(f'  Dataset cached: {len(dataset[\"test\"])} instances')

except ImportError:
    print('  WARNING: \"datasets\" package not installed. Run: pip install datasets')
    sys.exit(1)
except Exception as e:
    print(f'  ERROR: Failed to download dataset: {e}')
    sys.exit(1)
"

if [ $? -ne 0 ]; then
    log_error "Dataset download failed"
    exit 1
fi

# 7. Build OMC project
log_info "Building oh-my-claudecode project..."
cd "$PROJECT_ROOT"
npm install --silent
npm run build --silent

# 8. Verify installation
log_info "Running sanity checks..."

# Check Docker
if docker images | grep -q swe-bench-runner; then
    log_info "  Docker image: OK"
else
    log_error "  Docker image: FAILED"
    exit 1
fi

# Check Python packages
python3 -c "import anthropic, docker, datasets" 2>/dev/null
if [ $? -eq 0 ]; then
    log_info "  Python packages: OK"
else
    log_error "  Python packages: FAILED"
    exit 1
fi

# Check OMC build
if [ -d "$PROJECT_ROOT/dist" ] && [ -f "$PROJECT_ROOT/dist/index.js" ]; then
    log_info "  OMC build: OK"
else
    log_error "  OMC build: FAILED"
    exit 1
fi

log_info ""
log_info "=========================================="
log_info "Setup completed successfully!"
log_info "=========================================="
log_info ""
log_info "Next steps:"
log_info "  1. Quick test: ./quick_test.sh"
log_info "  2. Run vanilla: ./run_vanilla.sh"
log_info "  3. Run OMC: ./run_omc.sh"
log_info "  4. Full comparison: ./run_full_comparison.sh"
log_info ""
