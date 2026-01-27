# SWE-bench Benchmark Suite

Automated benchmark comparison between vanilla Claude Code and OMC-enhanced Claude Code.

## Quick Start

```bash
# 1. One-time setup
./setup.sh

# 2. Quick sanity test (5 instances)
./quick_test.sh

# 3. Full comparison
./run_full_comparison.sh
```

## Scripts

### setup.sh
One-time setup and verification:
- Installs Python dependencies
- Builds Docker image for SWE-bench
- Downloads and caches dataset
- Verifies API key
- Builds OMC project
- Runs sanity checks

**Usage:**
```bash
./setup.sh
```

### quick_test.sh
Quick sanity test with limited instances (default: 5):
- Tests both vanilla and OMC modes
- Fast verification before full runs
- Recommended before production benchmarks

**Usage:**
```bash
./quick_test.sh [--limit N] [--model MODEL] [--timeout SECS]
```

**Examples:**
```bash
./quick_test.sh                    # Test 5 instances
./quick_test.sh --limit 10         # Test 10 instances
./quick_test.sh --timeout 300      # 5 minutes per instance
```

### run_vanilla.sh
Run vanilla Claude Code benchmark:
- Standard Claude Code without OMC
- Saves predictions to `predictions/vanilla/`
- Logs to `logs/vanilla_*.log`

**Usage:**
```bash
./run_vanilla.sh [OPTIONS]
```

**Options:**
- `--limit N` - Limit to N instances (default: all)
- `--skip N` - Skip first N instances (default: 0)
- `--model MODEL` - Claude model to use (default: claude-sonnet-4.5-20250929)
- `--timeout SECS` - Timeout per instance (default: 300)

**Examples:**
```bash
./run_vanilla.sh                           # Full benchmark
./run_vanilla.sh --limit 100               # First 100 instances
./run_vanilla.sh --skip 100 --limit 100    # Instances 101-200
./run_vanilla.sh --timeout 600             # 10 minutes per instance
```

### run_omc.sh
Run OMC-enhanced benchmark:
- Claude Code with oh-my-claudecode orchestration
- Saves predictions to `predictions/omc/`
- Logs to `logs/omc_*.log`

**Usage:**
```bash
./run_omc.sh [OPTIONS]
```

**Options:** Same as `run_vanilla.sh`

**Examples:**
```bash
./run_omc.sh                    # Full benchmark
./run_omc.sh --limit 100        # First 100 instances
```

### run_full_comparison.sh
Complete benchmark suite:
- Runs vanilla benchmark
- Runs OMC benchmark
- Evaluates both runs
- Generates comparison report

**Usage:**
```bash
./run_full_comparison.sh [OPTIONS]
```

**Options:**
- `--limit N` - Limit to N instances
- `--skip N` - Skip first N instances
- `--model MODEL` - Claude model to use
- `--timeout SECS` - Timeout per instance
- `--skip-vanilla` - Skip vanilla benchmark run
- `--skip-omc` - Skip OMC benchmark run
- `--skip-eval` - Skip evaluation step

**Examples:**
```bash
./run_full_comparison.sh                    # Full comparison
./run_full_comparison.sh --limit 100        # Test 100 instances
./run_full_comparison.sh --skip-vanilla     # Only run OMC (reuse vanilla results)
```

## Directory Structure

```
benchmark/
├── setup.sh                    # One-time setup
├── quick_test.sh              # Quick sanity test
├── run_vanilla.sh             # Run vanilla benchmark
├── run_omc.sh                 # Run OMC benchmark
├── run_full_comparison.sh     # Full comparison suite
├── run_benchmark.py           # Main Python benchmark runner
├── Dockerfile                 # Docker image for SWE-bench
├── docker-compose.yml         # Docker compose config
├── requirements.txt           # Python dependencies
├── predictions/
│   ├── vanilla/              # Vanilla predictions
│   └── omc/                  # OMC predictions
├── logs/
│   ├── vanilla_*.log         # Vanilla run logs
│   └── omc_*.log            # OMC run logs
├── results/
│   ├── vanilla_results.json  # Vanilla evaluation
│   ├── omc_results.json      # OMC evaluation
│   └── comparison_report.md  # Comparison report
├── data/                      # Test data
└── cache/                     # Dataset cache
```

## Prerequisites

- Docker
- Python 3.8+
- Node.js and npm
- ANTHROPIC_API_KEY environment variable

```bash
export ANTHROPIC_API_KEY=your_key_here
```

## Workflow

1. **Setup** (one-time):
   ```bash
   ./setup.sh
   ```

2. **Quick Test** (recommended):
   ```bash
   ./quick_test.sh
   ```

3. **Full Benchmark**:
   ```bash
   # Option A: Run full comparison
   ./run_full_comparison.sh

   # Option B: Run individually
   ./run_vanilla.sh
   ./run_omc.sh
   ```

4. **Review Results**:
   - Check `results/comparison_report.md`
   - Inspect predictions in `predictions/vanilla/` and `predictions/omc/`
   - Review logs in `logs/`

## Troubleshooting

### Setup Issues
```bash
./setup.sh
# Check output for specific errors
```

### API Key Issues
```bash
# Verify API key is set
echo $ANTHROPIC_API_KEY

# Export if missing
export ANTHROPIC_API_KEY=your_key_here
```

### Docker Issues
```bash
# Check Docker is running
docker ps

# Rebuild image
docker build -t swe-bench-runner .
```

### Python Dependencies
```bash
# Reinstall dependencies
pip install -r requirements.txt
```

## Advanced Usage

### Custom Model
```bash
./run_vanilla.sh --model claude-opus-4.5-20251101
./run_omc.sh --model claude-opus-4.5-20251101
```

### Longer Timeout
```bash
# 15 minutes per instance
./run_full_comparison.sh --timeout 900
```

### Subset Testing
```bash
# Test instances 50-150
./run_full_comparison.sh --skip 50 --limit 100
```

### Resume Failed Run
```bash
# If vanilla failed at instance 42, skip to 42 and continue
./run_vanilla.sh --skip 42
```

## Performance Tips

1. **Start Small**: Use `quick_test.sh` to verify setup
2. **Parallel Runs**: Don't run vanilla and OMC in parallel (share API rate limits)
3. **Monitor Logs**: Use `tail -f logs/vanilla_*.log` to watch progress
4. **Timeout Tuning**: Increase timeout for complex instances
5. **Disk Space**: Ensure sufficient space for predictions and Docker containers

## Interpreting Results

### Metrics
- **Solve Rate**: Percentage of instances successfully resolved
- **Token Usage**: Average tokens per instance
- **Time**: Average time per instance
- **Error Rate**: Percentage of instances that errored

### Comparison Report
The `results/comparison_report.md` includes:
- Side-by-side metrics
- Statistical significance tests
- Instance-level comparisons
- Qualitative analysis

## License

Same as parent project (MIT)
