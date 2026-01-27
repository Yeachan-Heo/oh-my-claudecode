#!/usr/bin/env python3
"""
SWE-bench Evaluation Runner

Wrapper around swebench.harness.run_evaluation to evaluate predictions
against the official SWE-bench harness.

Usage:
    python evaluate.py --predictions predictions.json --output results/
    python evaluate.py --predictions predictions.json --dataset swe-bench-verified --max-workers 4
"""

import argparse
import json
import logging
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


def load_predictions(predictions_file: Path) -> list[dict[str, Any]]:
    """Load predictions from JSON or JSONL file."""
    logger.info(f"Loading predictions from {predictions_file}")

    predictions = []
    with open(predictions_file) as f:
        content = f.read()
        if not content.strip():
            logger.warning("Empty predictions file")
            return predictions

        # Check if it's JSONL by looking for newlines and trying to parse first line
        lines = content.strip().split('\n')
        is_jsonl = False

        # Check if file has .jsonl extension
        if predictions_file.suffix == '.jsonl':
            is_jsonl = True
        # Or if it's multi-line with each line being a valid JSON object with instance_id
        elif len(lines) > 1:
            try:
                first_line = lines[0].strip()
                if first_line:
                    obj = json.loads(first_line)
                    # Check if it has instance_id field (JSONL format indicator)
                    if isinstance(obj, dict) and 'instance_id' in obj:
                        is_jsonl = True
            except json.JSONDecodeError:
                pass

        # Try JSONL format if detected
        if is_jsonl:
            try:
                for line in lines:
                    if line.strip():
                        predictions.append(json.loads(line))
                logger.info(f"Loaded {len(predictions)} predictions from JSONL format")
                return predictions
            except json.JSONDecodeError as e:
                logger.warning(f"JSONL parsing failed, trying JSON: {e}")

        content = content.strip()

        # Try JSON format
        try:
            data = json.loads(content)
            if isinstance(data, dict):
                # Handle dict format {instance_id: prediction}
                predictions = []
                for k, v in data.items():
                    if isinstance(v, dict):
                        pred = {"instance_id": k, **v}
                        if "model_patch" not in pred:
                            pred["model_patch"] = v.get("patch", "")
                    else:
                        # v is a string (the patch itself)
                        pred = {"instance_id": k, "model_patch": str(v)}
                    predictions.append(pred)
                logger.info(f"Loaded {len(predictions)} predictions from JSON dict format")
            elif isinstance(data, list):
                predictions = data
                logger.info(f"Loaded {len(predictions)} predictions from JSON array format")
            return predictions
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse predictions file: {e}")
            return predictions

    return predictions


def validate_predictions(predictions: list[dict[str, Any]]) -> list[str]:
    """Validate predictions format and return list of issues."""
    issues = []

    for i, pred in enumerate(predictions):
        if "instance_id" not in pred:
            issues.append(f"Prediction {i}: missing 'instance_id'")
        if "model_patch" not in pred:
            issues.append(f"Prediction {i}: missing 'model_patch'")
        elif not pred["model_patch"]:
            issues.append(f"Prediction {i} ({pred.get('instance_id', 'unknown')}): empty patch")

    return issues


def run_swebench_evaluation(
    predictions_file: Path,
    output_dir: Path,
    dataset: str = "princeton-nlp/SWE-bench_Verified",
    max_workers: int = 4,
    timeout: int = 1800,
    run_id: str | None = None
) -> dict[str, Any]:
    """
    Run SWE-bench evaluation harness.

    Args:
        predictions_file: Path to predictions JSON
        output_dir: Directory for evaluation results
        dataset: SWE-bench dataset to use
        max_workers: Number of parallel workers
        timeout: Timeout per instance in seconds
        run_id: Optional run identifier

    Returns:
        Dictionary with evaluation results
    """
    if run_id is None:
        run_id = datetime.now().strftime("%Y%m%d_%H%M%S")

    output_dir = output_dir / run_id
    output_dir.mkdir(parents=True, exist_ok=True)

    logger.info(f"Running SWE-bench evaluation")
    logger.info(f"  Predictions: {predictions_file}")
    logger.info(f"  Output: {output_dir}")
    logger.info(f"  Dataset: {dataset}")
    logger.info(f"  Workers: {max_workers}")

    # Build command for swebench harness
    cmd = [
        sys.executable, "-m", "swebench.harness.run_evaluation",
        "--predictions_path", str(predictions_file),
        "--swe_bench_tasks", dataset,
        "--log_dir", str(output_dir / "logs"),
        "--testbed", str(output_dir / "testbed"),
        "--skip_existing",
        "--timeout", str(timeout),
        "--num_processes", str(max_workers),
    ]

    logger.info(f"Command: {' '.join(cmd)}")

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout * len(load_predictions(predictions_file)) + 3600
        )

        if result.returncode != 0:
            logger.error(f"Evaluation failed with code {result.returncode}")
            logger.error(f"stderr: {result.stderr}")

        # Save raw output
        (output_dir / "stdout.txt").write_text(result.stdout)
        (output_dir / "stderr.txt").write_text(result.stderr)

    except subprocess.TimeoutExpired:
        logger.error("Evaluation timed out")
        return {"error": "timeout", "run_id": run_id}
    except FileNotFoundError:
        logger.error("swebench package not found. Install with: pip install swebench")
        return {"error": "swebench_not_installed", "run_id": run_id}

    # Parse results
    results = parse_evaluation_results(output_dir / "logs")
    results["run_id"] = run_id
    results["output_dir"] = str(output_dir)

    # Save summary
    summary_file = output_dir / "summary.json"
    with open(summary_file, "w") as f:
        json.dump(results, f, indent=2)

    logger.info(f"Results saved to {summary_file}")

    return results


def parse_evaluation_results(logs_dir: Path) -> dict[str, Any]:
    """
    Parse evaluation results from SWE-bench logs directory.

    Returns:
        Dictionary with parsed results including:
        - total: Total number of instances
        - passed: Number of passed instances
        - failed: Number of failed instances
        - error: Number of error instances
        - pass_rate: Pass rate percentage
        - instances: Per-instance results
    """
    results = {
        "total": 0,
        "passed": 0,
        "failed": 0,
        "error": 0,
        "pass_rate": 0.0,
        "instances": {}
    }

    if not logs_dir.exists():
        logger.warning(f"Logs directory not found: {logs_dir}")
        return results

    # Parse individual instance logs
    for log_file in logs_dir.glob("*.log"):
        instance_id = log_file.stem
        results["total"] += 1

        log_content = log_file.read_text()

        # Determine result from log content
        instance_result = {
            "instance_id": instance_id,
            "status": "unknown",
            "tests_passed": 0,
            "tests_failed": 0,
            "error_message": None
        }

        if "PASS" in log_content or "All tests passed" in log_content.lower():
            instance_result["status"] = "passed"
            results["passed"] += 1
        elif "FAIL" in log_content:
            instance_result["status"] = "failed"
            results["failed"] += 1
            # Extract failure info
            for line in log_content.split("\n"):
                if "FAILED" in line or "Error" in line:
                    instance_result["error_message"] = line.strip()
                    break
        elif "ERROR" in log_content or "Exception" in log_content:
            instance_result["status"] = "error"
            results["error"] += 1
            for line in log_content.split("\n"):
                if "Error" in line or "Exception" in line:
                    instance_result["error_message"] = line.strip()
                    break
        else:
            results["failed"] += 1
            instance_result["status"] = "failed"

        # Try to parse test counts
        for line in log_content.split("\n"):
            if "passed" in line.lower() and "failed" in line.lower():
                parts = line.split()
                for i, part in enumerate(parts):
                    if part == "passed" and i > 0:
                        try:
                            instance_result["tests_passed"] = int(parts[i-1])
                        except ValueError:
                            pass
                    if part == "failed" and i > 0:
                        try:
                            instance_result["tests_failed"] = int(parts[i-1])
                        except ValueError:
                            pass

        results["instances"][instance_id] = instance_result

    # Calculate pass rate
    if results["total"] > 0:
        results["pass_rate"] = (results["passed"] / results["total"]) * 100

    # Also check for swebench's own results file
    for results_file in logs_dir.glob("*.json"):
        try:
            with open(results_file) as f:
                swebench_results = json.load(f)
                if "resolved" in swebench_results:
                    results["swebench_resolved"] = swebench_results["resolved"]
                if "unresolved" in swebench_results:
                    results["swebench_unresolved"] = swebench_results["unresolved"]
        except (json.JSONDecodeError, KeyError):
            pass

    return results


def generate_report(results: dict[str, Any], output_file: Path | None = None) -> str:
    """Generate a human-readable evaluation report."""
    lines = [
        "# SWE-bench Evaluation Report",
        "",
        f"**Run ID:** {results.get('run_id', 'N/A')}",
        f"**Generated:** {datetime.now().isoformat()}",
        "",
        "## Summary",
        "",
        "| Metric | Value |",
        "|--------|-------|",
        f"| Total Instances | {results['total']} |",
        f"| Passed | {results['passed']} |",
        f"| Failed | {results['failed']} |",
        f"| Errors | {results['error']} |",
        f"| **Pass Rate** | **{results['pass_rate']:.2f}%** |",
        "",
    ]

    # Add instance details if available
    if results.get("instances"):
        lines.extend([
            "## Instance Results",
            "",
            "| Instance ID | Status | Tests Passed | Tests Failed |",
            "|-------------|--------|--------------|--------------|",
        ])

        for instance_id, inst in sorted(results["instances"].items()):
            status_emoji = {
                "passed": "PASS",
                "failed": "FAIL",
                "error": "ERROR",
                "unknown": "?"
            }.get(inst["status"], "?")

            lines.append(
                f"| {instance_id} | {status_emoji} | "
                f"{inst['tests_passed']} | {inst['tests_failed']} |"
            )

        lines.append("")

    # Add failure details
    failed_instances = [
        (iid, inst) for iid, inst in results.get("instances", {}).items()
        if inst["status"] in ("failed", "error")
    ]

    if failed_instances:
        lines.extend([
            "## Failed Instances",
            "",
        ])

        for instance_id, inst in failed_instances:
            lines.append(f"### {instance_id}")
            lines.append("")
            lines.append(f"**Status:** {inst['status']}")
            if inst.get("error_message"):
                lines.append(f"**Error:** {inst['error_message']}")
            lines.append("")

    report = "\n".join(lines)

    if output_file:
        output_file.write_text(report)
        logger.info(f"Report saved to {output_file}")

    return report


def main():
    parser = argparse.ArgumentParser(
        description="Run SWE-bench evaluation on predictions",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    # Basic evaluation
    python evaluate.py --predictions results/vanilla_predictions.json

    # With custom output and workers
    python evaluate.py --predictions results/omc_predictions.json \\
        --output results/ --max-workers 8

    # Validate predictions only
    python evaluate.py --predictions predictions.json --validate-only
        """
    )

    parser.add_argument(
        "--predictions", "-p",
        type=Path,
        required=True,
        help="Path to predictions JSON file"
    )

    parser.add_argument(
        "--output", "-o",
        type=Path,
        default=Path("results"),
        help="Output directory for results (default: results/)"
    )

    parser.add_argument(
        "--dataset", "-d",
        default="princeton-nlp/SWE-bench_Verified",
        help="SWE-bench dataset to use (default: SWE-bench_Verified)"
    )

    parser.add_argument(
        "--max-workers", "-w",
        type=int,
        default=4,
        help="Number of parallel evaluation workers (default: 4)"
    )

    parser.add_argument(
        "--timeout", "-t",
        type=int,
        default=1800,
        help="Timeout per instance in seconds (default: 1800)"
    )

    parser.add_argument(
        "--run-id",
        help="Custom run identifier (default: timestamp)"
    )

    parser.add_argument(
        "--validate-only",
        action="store_true",
        help="Only validate predictions, don't run evaluation"
    )

    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Enable verbose logging"
    )

    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # Check predictions file exists, or find predictions.jsonl in directory
    predictions_path = args.predictions
    if predictions_path.is_dir():
        # Try to find predictions.jsonl or predictions.json in directory
        jsonl_path = predictions_path / "predictions.jsonl"
        json_path = predictions_path / "predictions.json"

        if jsonl_path.exists():
            predictions_path = jsonl_path
            logger.info(f"Found predictions.jsonl in directory: {predictions_path}")
        elif json_path.exists():
            predictions_path = json_path
            logger.info(f"Found predictions.json in directory: {predictions_path}")
        else:
            logger.error(f"No predictions.jsonl or predictions.json found in directory: {args.predictions}")
            sys.exit(1)
    elif not predictions_path.exists():
        logger.error(f"Predictions file not found: {predictions_path}")
        sys.exit(1)

    # Update args to use resolved path
    args.predictions = predictions_path

    # Load and validate predictions
    predictions = load_predictions(args.predictions)
    issues = validate_predictions(predictions)

    if issues:
        logger.warning("Prediction validation issues:")
        for issue in issues:
            logger.warning(f"  - {issue}")

    if args.validate_only:
        if issues:
            logger.error(f"Validation failed with {len(issues)} issues")
            sys.exit(1)
        else:
            logger.info("Validation passed")
            sys.exit(0)

    # Run evaluation
    results = run_swebench_evaluation(
        predictions_file=args.predictions,
        output_dir=args.output,
        dataset=args.dataset,
        max_workers=args.max_workers,
        timeout=args.timeout,
        run_id=args.run_id
    )

    if "error" in results:
        logger.error(f"Evaluation failed: {results['error']}")
        sys.exit(1)

    # Generate report
    report_file = args.output / results["run_id"] / "report.md"
    report = generate_report(results, report_file)

    # Print summary
    print("\n" + "=" * 60)
    print("EVALUATION COMPLETE")
    print("=" * 60)
    print(f"Total: {results['total']}")
    print(f"Passed: {results['passed']}")
    print(f"Failed: {results['failed']}")
    print(f"Errors: {results['error']}")
    print(f"Pass Rate: {results['pass_rate']:.2f}%")
    print(f"\nFull report: {report_file}")
    print("=" * 60)


if __name__ == "__main__":
    main()
