#!/bin/bash
set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
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

log_header() {
    echo -e "${CYAN}=========================================="
    echo -e "$1"
    echo -e "==========================================${NC}"
}

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Quick test configuration
TEST_LIMIT=5
MODEL="claude-sonnet-4.5-20250929"
TIMEOUT="180"  # 3 minutes per instance for quick test

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --limit)
            TEST_LIMIT="$2"
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
            echo "Quick sanity test with limited instances."
            echo ""
            echo "Options:"
            echo "  --limit N       Number of instances to test (default: 5)"
            echo "  --model MODEL   Claude model to use (default: claude-sonnet-4.5-20250929)"
            echo "  --timeout SECS  Timeout per instance (default: 180)"
            echo "  -h, --help      Show this help message"
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            exit 1
            ;;
    esac
done

START_TIME=$(date +%s)

log_header "Quick Benchmark Test"
log_info "Testing with $TEST_LIMIT instances"
log_info "Model: $MODEL"
log_info "Timeout: ${TIMEOUT}s per instance"
echo ""

# Step 1: Run quick vanilla test
log_step "Step 1/2: Quick vanilla test ($TEST_LIMIT instances)..."
echo ""
"$SCRIPT_DIR/run_vanilla.sh" --limit $TEST_LIMIT --model "$MODEL" --timeout $TIMEOUT
VANILLA_STATUS=$?
echo ""

# Step 2: Run quick OMC test
log_step "Step 2/2: Quick OMC test ($TEST_LIMIT instances)..."
echo ""
"$SCRIPT_DIR/run_omc.sh" --limit $TEST_LIMIT --model "$MODEL" --timeout $TIMEOUT
OMC_STATUS=$?
echo ""

# Calculate elapsed time
END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))
MINUTES=$((ELAPSED / 60))
SECONDS=$((ELAPSED % 60))

# Summary
log_header "Quick Test Complete!"
echo ""

if [ $VANILLA_STATUS -eq 0 ] && [ $OMC_STATUS -eq 0 ]; then
    log_info "Both tests passed successfully!"
    echo ""
    log_info "Results:"
    log_info "  Vanilla: $SCRIPT_DIR/predictions/vanilla/"
    log_info "  OMC:     $SCRIPT_DIR/predictions/omc/"
    echo ""
    log_info "Time: ${MINUTES}m ${SECONDS}s"
    echo ""
    log_info "Everything looks good! Ready for full benchmark run:"
    log_info "  ./run_full_comparison.sh"
    echo ""
    exit 0
else
    log_error "One or more tests failed!"
    echo ""
    [ $VANILLA_STATUS -ne 0 ] && log_error "  Vanilla test: FAILED (exit code $VANILLA_STATUS)"
    [ $OMC_STATUS -ne 0 ] && log_error "  OMC test: FAILED (exit code $OMC_STATUS)"
    echo ""
    log_info "Check logs in: $SCRIPT_DIR/logs/"
    echo ""
    exit 1
fi
