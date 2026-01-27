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

# Parse arguments
LIMIT=""
SKIP=""
MODEL="claude-sonnet-4.5-20250929"
TIMEOUT="300"
SKIP_VANILLA=false
SKIP_OMC=false
SKIP_EVAL=false

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
        --skip-vanilla)
            SKIP_VANILLA=true
            shift
            ;;
        --skip-omc)
            SKIP_OMC=true
            shift
            ;;
        --skip-eval)
            SKIP_EVAL=true
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Run complete benchmark comparison between vanilla and OMC modes."
            echo ""
            echo "Options:"
            echo "  --limit N         Limit to N instances (default: all)"
            echo "  --skip N          Skip first N instances (default: 0)"
            echo "  --model MODEL     Claude model to use (default: claude-sonnet-4.5-20250929)"
            echo "  --timeout SECS    Timeout per instance (default: 300)"
            echo "  --skip-vanilla    Skip vanilla benchmark run"
            echo "  --skip-omc        Skip OMC benchmark run"
            echo "  --skip-eval       Skip evaluation step"
            echo "  -h, --help        Show this help message"
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Build argument string
ARGS=""
[ -n "$LIMIT" ] && ARGS="$ARGS --limit $LIMIT"
[ -n "$SKIP" ] && ARGS="$ARGS --skip $SKIP"
ARGS="$ARGS --model $MODEL"
ARGS="$ARGS --timeout $TIMEOUT"

START_TIME=$(date +%s)

log_header "Full Benchmark Comparison Suite"
log_info "Model: $MODEL"
log_info "Timeout: ${TIMEOUT}s per instance"
[ -n "$LIMIT" ] && log_info "Limit: $LIMIT instances"
[ -n "$SKIP" ] && log_info "Skip: $SKIP instances"
echo ""

# Step 1: Run vanilla benchmark
if [ "$SKIP_VANILLA" = false ]; then
    log_step "Step 1/4: Running vanilla Claude Code benchmark..."
    echo ""
    "$SCRIPT_DIR/run_vanilla.sh" $ARGS
    if [ $? -ne 0 ]; then
        log_error "Vanilla benchmark failed. Aborting."
        exit 1
    fi
    echo ""
else
    log_warn "Skipping vanilla benchmark (--skip-vanilla)"
    echo ""
fi

# Step 2: Run OMC benchmark
if [ "$SKIP_OMC" = false ]; then
    log_step "Step 2/4: Running OMC-enhanced benchmark..."
    echo ""
    "$SCRIPT_DIR/run_omc.sh" $ARGS
    if [ $? -ne 0 ]; then
        log_error "OMC benchmark failed. Aborting."
        exit 1
    fi
    echo ""
else
    log_warn "Skipping OMC benchmark (--skip-omc)"
    echo ""
fi

# Step 3: Evaluate both runs
if [ "$SKIP_EVAL" = false ]; then
    log_step "Step 3/4: Evaluating vanilla predictions..."
    echo ""
    if [ -f "$SCRIPT_DIR/evaluate.py" ]; then
        python3 "$SCRIPT_DIR/evaluate.py" \
            --predictions "$SCRIPT_DIR/predictions/vanilla" \
            --output "$SCRIPT_DIR/results/vanilla_results.json"
        if [ $? -ne 0 ]; then
            log_warn "Vanilla evaluation had issues (continuing...)"
        fi
    else
        log_warn "evaluate.py not found, skipping evaluation"
    fi
    echo ""

    log_step "Step 4/4: Evaluating OMC predictions..."
    echo ""
    if [ -f "$SCRIPT_DIR/evaluate.py" ]; then
        python3 "$SCRIPT_DIR/evaluate.py" \
            --predictions "$SCRIPT_DIR/predictions/omc" \
            --output "$SCRIPT_DIR/results/omc_results.json"
        if [ $? -ne 0 ]; then
            log_warn "OMC evaluation had issues (continuing...)"
        fi
    else
        log_warn "evaluate.py not found, skipping evaluation"
    fi
    echo ""
else
    log_warn "Skipping evaluation (--skip-eval)"
    echo ""
fi

# Calculate elapsed time
END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))
HOURS=$((ELAPSED / 3600))
MINUTES=$(((ELAPSED % 3600) / 60))
SECONDS=$((ELAPSED % 60))

# Step 4: Generate comparison report
log_step "Generating comparison report..."
echo ""

if [ -f "$SCRIPT_DIR/compare_results.py" ]; then
    python3 "$SCRIPT_DIR/compare_results.py" \
        --vanilla "$SCRIPT_DIR/predictions/vanilla/predictions.jsonl" \
        --omc "$SCRIPT_DIR/predictions/omc/predictions.jsonl" \
        --output "$SCRIPT_DIR/results/comparison_report.md"
else
    log_warn "compare_results.py not found, generating basic report..."

    cat > "$SCRIPT_DIR/results/comparison_report.md" << EOF
# Benchmark Comparison Report

Generated: $(date)

## Configuration
- Model: $MODEL
- Timeout: ${TIMEOUT}s per instance
$([ -n "$LIMIT" ] && echo "- Limit: $LIMIT instances")
$([ -n "$SKIP" ] && echo "- Skip: $SKIP instances")

## Results

### Vanilla Claude Code
Location: \`predictions/vanilla/\`
Results: \`results/vanilla_results.json\`

### OMC-Enhanced
Location: \`predictions/omc/\`
Results: \`results/omc_results.json\`

## Elapsed Time
Total runtime: ${HOURS}h ${MINUTES}m ${SECONDS}s

## Next Steps
1. Review predictions in \`predictions/\` directories
2. Check detailed results in \`results/\` JSON files
3. Compare specific instances for qualitative analysis
EOF
fi

log_header "Full Comparison Complete!"
log_info "Total runtime: ${HOURS}h ${MINUTES}m ${SECONDS}s"
echo ""
log_info "Results:"
log_info "  Vanilla predictions: $SCRIPT_DIR/predictions/vanilla/"
log_info "  OMC predictions:     $SCRIPT_DIR/predictions/omc/"
log_info "  Comparison report:   $SCRIPT_DIR/results/comparison_report.md"
echo ""
log_info "Review the comparison report for detailed analysis."
echo ""
