#!/bin/bash
set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
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

log_step() {
    echo -e "${BLUE}[STEP]${NC} $1"
}

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Configuration
RUN_MODE="omc"
PREDICTIONS_DIR="$SCRIPT_DIR/predictions/$RUN_MODE"
LOGS_DIR="$SCRIPT_DIR/logs"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOG_FILE="$LOGS_DIR/${RUN_MODE}_${TIMESTAMP}.log"

# Parse arguments
LIMIT=""
SKIP=""
MODEL="claude-sonnet-4.5-20250929"
TIMEOUT="300"

while [[ $# -gt 0 ]]; do
    case $1 in
        --limit)
            LIMIT="$2"
            shift 2
            ;;
        --skip)
            SKIP="$2"
            shift 2
            ;;
        --model)
            MODEL="$2"
            shift 2
            ;;
        --timeout)
            TIMEOUT="$2"
            shift 2
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --limit N       Limit to N instances (default: all)"
            echo "  --skip N        Skip first N instances (default: 0)"
            echo "  --model MODEL   Claude model to use (default: claude-sonnet-4.5-20250929)"
            echo "  --timeout SECS  Timeout per instance (default: 300)"
            echo "  -h, --help      Show this help message"
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Verify API key (check both possible env var names)
if [ -z "${ANTHROPIC_AUTH_TOKEN:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    log_error "ANTHROPIC_AUTH_TOKEN is not set. Please export it."
    exit 1
fi

# Verify OMC is built
if [ ! -d "$PROJECT_ROOT/dist" ] || [ ! -f "$PROJECT_ROOT/dist/index.js" ]; then
    log_error "oh-my-claudecode is not built. Run: npm run build"
    exit 1
fi

log_info "=========================================="
log_info "Running OMC-Enhanced Benchmark"
log_info "=========================================="
log_info "Mode: $RUN_MODE (with oh-my-claudecode orchestration)"
log_info "Model: $MODEL"
log_info "Timeout: ${TIMEOUT}s per instance"
[ -n "$LIMIT" ] && log_info "Limit: $LIMIT instances"
[ -n "$SKIP" ] && log_info "Skip: $SKIP instances"
log_info "Output: $PREDICTIONS_DIR"
log_info "Log: $LOG_FILE"
log_info ""

# Create directories
mkdir -p "$PREDICTIONS_DIR"
mkdir -p "$LOGS_DIR"

# Build command
CMD="python3 $SCRIPT_DIR/run_benchmark.py"
CMD="$CMD --mode $RUN_MODE"
CMD="$CMD --model $MODEL"
CMD="$CMD --timeout $TIMEOUT"
CMD="$CMD --output-dir $PREDICTIONS_DIR"
[ -n "$LIMIT" ] && CMD="$CMD --limit $LIMIT"
[ -n "$SKIP" ] && CMD="$CMD --skip $SKIP"

log_step "Starting OMC-enhanced benchmark run..."
log_info "Command: $CMD"
log_info ""

# Run benchmark with tee for live output and logging
$CMD 2>&1 | tee "$LOG_FILE"

EXIT_CODE=${PIPESTATUS[0]}

echo ""
if [ $EXIT_CODE -eq 0 ]; then
    log_info "=========================================="
    log_info "Benchmark completed successfully!"
    log_info "=========================================="
    log_info "Results: $PREDICTIONS_DIR"
    log_info "Log: $LOG_FILE"
    log_info ""
    log_info "Next steps:"
    log_info "  1. Run evaluation: python3 evaluate.py --predictions $PREDICTIONS_DIR"
    log_info "  2. Compare results: python3 compare_results.py --vanilla predictions/vanilla --omc predictions/omc"
    log_info ""
else
    log_error "=========================================="
    log_error "Benchmark failed with exit code: $EXIT_CODE"
    log_error "=========================================="
    log_error "Check log file: $LOG_FILE"
    exit $EXIT_CODE
fi
