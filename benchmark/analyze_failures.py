#!/usr/bin/env python3
"""
SWE-bench Failure Analysis Tool

Analyze failed instances to identify patterns, categorize failures,
and understand differences between vanilla and OMC runs.

Usage:
    python analyze_failures.py --results results/vanilla/ --predictions predictions.json
    python analyze_failures.py --vanilla results/vanilla/ --omc results/omc/ --compare
"""

import argparse
import json
import logging
import re
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


# Common failure pattern definitions
FAILURE_PATTERNS = {
    "syntax_error": [
        r"SyntaxError",
        r"IndentationError",
        r"TabError",
    ],
    "import_error": [
        r"ImportError",
        r"ModuleNotFoundError",
        r"No module named",
    ],
    "type_error": [
        r"TypeError",
        r"expected .+ got .+",
    ],
    "attribute_error": [
        r"AttributeError",
        r"has no attribute",
    ],
    "assertion_error": [
        r"AssertionError",
        r"assert .+ failed",
    ],
    "test_failure": [
        r"FAILED",
        r"test.*failed",
        r"failures=\d+",
    ],
    "timeout": [
        r"timeout",
        r"timed out",
        r"TimeoutError",
    ],
    "empty_patch": [
        r"empty patch",
        r"no changes",
        r"patch is empty",
    ],
    "apply_failure": [
        r"patch.*failed",
        r"could not apply",
        r"git apply.*failed",
        r"hunks? FAILED",
    ],
    "runtime_error": [
        r"RuntimeError",
        r"Exception",
        r"Error:",
    ],
    "value_error": [
        r"ValueError",
        r"invalid .+ value",
    ],
    "key_error": [
        r"KeyError",
        r"not found in",
    ],
}


def load_results(results_dir: Path) -> dict[str, Any]:
    """Load evaluation results."""
    results = {"instances": {}}

    summary_file = results_dir / "summary.json"
    if summary_file.exists():
        with open(summary_file) as f:
            results = json.load(f)

    # Also load from logs if available
    logs_dir = results_dir / "logs"
    if logs_dir.exists():
        for log_file in logs_dir.glob("*.log"):
            instance_id = log_file.stem
            if instance_id not in results.get("instances", {}):
                results.setdefault("instances", {})[instance_id] = {}

            results["instances"][instance_id]["log_content"] = log_file.read_text()

    return results


def load_predictions(predictions_file: Path) -> dict[str, Any]:
    """Load predictions with metadata."""
    with open(predictions_file) as f:
        predictions = json.load(f)

    if isinstance(predictions, list):
        predictions = {p["instance_id"]: p for p in predictions}

    return predictions


def categorize_failure(
    instance_id: str,
    instance_data: dict[str, Any],
    prediction_data: dict[str, Any] | None = None
) -> dict[str, Any]:
    """
    Categorize a single failure instance.

    Returns:
        Dictionary with:
        - category: Primary failure category
        - subcategories: Additional categories
        - error_message: Extracted error message
        - confidence: Confidence in categorization
    """
    result = {
        "instance_id": instance_id,
        "category": "unknown",
        "subcategories": [],
        "error_message": None,
        "confidence": 0.0,
        "details": {}
    }

    # Get content to analyze
    log_content = instance_data.get("log_content", "")
    error_message = instance_data.get("error_message", "")
    patch = ""

    if prediction_data:
        patch = prediction_data.get("model_patch", prediction_data.get("patch", ""))
        result["details"]["patch_length"] = len(patch)
        result["details"]["patch_lines"] = patch.count("\n") + 1 if patch else 0

    content_to_analyze = f"{log_content}\n{error_message}"

    # Check for empty patch first
    if prediction_data and not patch.strip():
        result["category"] = "empty_patch"
        result["confidence"] = 1.0
        result["error_message"] = "No patch generated"
        return result

    # Match against failure patterns
    matched_categories = []

    for category, patterns in FAILURE_PATTERNS.items():
        for pattern in patterns:
            if re.search(pattern, content_to_analyze, re.IGNORECASE):
                matched_categories.append(category)
                break

    if matched_categories:
        result["category"] = matched_categories[0]
        result["subcategories"] = matched_categories[1:]
        result["confidence"] = 0.8 if len(matched_categories) == 1 else 0.6

    # Extract specific error message
    error_patterns = [
        r"(Error: .+?)(?:\n|$)",
        r"(Exception: .+?)(?:\n|$)",
        r"(FAILED .+?)(?:\n|$)",
        r"(AssertionError: .+?)(?:\n|$)",
    ]

    for pattern in error_patterns:
        match = re.search(pattern, content_to_analyze)
        if match:
            result["error_message"] = match.group(1).strip()[:200]
            break

    if not result["error_message"] and error_message:
        result["error_message"] = error_message[:200]

    return result


def analyze_failures(
    results: dict[str, Any],
    predictions: dict[str, Any] | None = None
) -> dict[str, Any]:
    """
    Analyze all failures in a results set.

    Returns:
        Comprehensive failure analysis including:
        - category_counts: Count by failure category
        - failures: List of categorized failures
        - patterns: Common failure patterns
        - recommendations: Suggested improvements
    """
    analysis = {
        "timestamp": datetime.now().isoformat(),
        "total_instances": results.get("total", len(results.get("instances", {}))),
        "total_failures": 0,
        "category_counts": Counter(),
        "failures": [],
        "patterns": {},
        "recommendations": []
    }

    # Analyze each failed instance
    for instance_id, instance_data in results.get("instances", {}).items():
        status = instance_data.get("status", "unknown")

        if status in ("passed",):
            continue

        analysis["total_failures"] += 1

        pred_data = predictions.get(instance_id) if predictions else None
        failure_info = categorize_failure(instance_id, instance_data, pred_data)

        analysis["category_counts"][failure_info["category"]] += 1
        analysis["failures"].append(failure_info)

    # Convert Counter to dict for JSON
    analysis["category_counts"] = dict(analysis["category_counts"])

    # Identify patterns
    analysis["patterns"] = identify_patterns(analysis["failures"])

    # Generate recommendations
    analysis["recommendations"] = generate_recommendations(analysis)

    return analysis


def identify_patterns(failures: list[dict[str, Any]]) -> dict[str, Any]:
    """Identify common patterns across failures."""
    patterns = {
        "by_repo": defaultdict(list),
        "by_error_type": defaultdict(list),
        "common_errors": [],
    }

    error_messages = []

    for failure in failures:
        instance_id = failure["instance_id"]

        # Group by repository
        if "__" in instance_id:
            repo = instance_id.split("__")[0]
            patterns["by_repo"][repo].append(instance_id)

        # Group by error type
        patterns["by_error_type"][failure["category"]].append(instance_id)

        # Collect error messages for pattern detection
        if failure.get("error_message"):
            error_messages.append(failure["error_message"])

    # Find most common error message fragments
    if error_messages:
        # Simple n-gram analysis for common phrases
        word_counts = Counter()
        for msg in error_messages:
            words = msg.lower().split()
            for i in range(len(words) - 2):
                phrase = " ".join(words[i:i+3])
                word_counts[phrase] += 1

        patterns["common_errors"] = [
            {"phrase": phrase, "count": count}
            for phrase, count in word_counts.most_common(10)
            if count > 1
        ]

    # Convert defaultdicts
    patterns["by_repo"] = dict(patterns["by_repo"])
    patterns["by_error_type"] = dict(patterns["by_error_type"])

    return patterns


def generate_recommendations(analysis: dict[str, Any]) -> list[dict[str, str]]:
    """Generate recommendations based on failure analysis."""
    recommendations = []
    category_counts = analysis["category_counts"]
    total = analysis["total_failures"]

    if total == 0:
        return [{"type": "success", "message": "No failures to analyze!"}]

    # Recommendations based on category distribution
    if category_counts.get("empty_patch", 0) > total * 0.1:
        recommendations.append({
            "type": "critical",
            "category": "empty_patch",
            "message": f"{category_counts['empty_patch']} instances ({category_counts['empty_patch']/total*100:.1f}%) "
                      "produced empty patches. Consider improving prompt engineering or adding retry logic."
        })

    if category_counts.get("apply_failure", 0) > total * 0.1:
        recommendations.append({
            "type": "critical",
            "category": "apply_failure",
            "message": f"{category_counts['apply_failure']} instances had patch application failures. "
                      "Patches may have incorrect context or line numbers."
        })

    if category_counts.get("syntax_error", 0) > total * 0.05:
        recommendations.append({
            "type": "high",
            "category": "syntax_error",
            "message": f"{category_counts['syntax_error']} instances had syntax errors. "
                      "Consider adding syntax validation before submission."
        })

    if category_counts.get("test_failure", 0) > total * 0.2:
        recommendations.append({
            "type": "medium",
            "category": "test_failure",
            "message": f"{category_counts['test_failure']} instances failed tests. "
                      "The patches may be functionally incorrect or incomplete."
        })

    if category_counts.get("timeout", 0) > total * 0.05:
        recommendations.append({
            "type": "medium",
            "category": "timeout",
            "message": f"{category_counts['timeout']} instances timed out. "
                      "Consider increasing timeout or optimizing patch execution."
        })

    # Repo-specific recommendations
    patterns = analysis.get("patterns", {})
    by_repo = patterns.get("by_repo", {})

    for repo, failures in sorted(by_repo.items(), key=lambda x: -len(x[1]))[:3]:
        if len(failures) >= 3:
            recommendations.append({
                "type": "info",
                "category": "repo_pattern",
                "message": f"Repository '{repo}' has {len(failures)} failures. "
                          "May indicate specific challenges with this codebase."
            })

    return recommendations


def compare_failures(
    vanilla_analysis: dict[str, Any],
    omc_analysis: dict[str, Any]
) -> dict[str, Any]:
    """Compare failure patterns between vanilla and OMC."""
    comparison = {
        "timestamp": datetime.now().isoformat(),
        "vanilla_failures": vanilla_analysis["total_failures"],
        "omc_failures": omc_analysis["total_failures"],
        "category_comparison": {},
        "unique_to_vanilla": [],
        "unique_to_omc": [],
        "common_failures": [],
        "insights": []
    }

    # Category comparison
    all_categories = set(vanilla_analysis["category_counts"].keys()) | \
                    set(omc_analysis["category_counts"].keys())

    for category in all_categories:
        vanilla_count = vanilla_analysis["category_counts"].get(category, 0)
        omc_count = omc_analysis["category_counts"].get(category, 0)

        comparison["category_comparison"][category] = {
            "vanilla": vanilla_count,
            "omc": omc_count,
            "delta": omc_count - vanilla_count
        }

    # Instance comparison
    vanilla_failed = {f["instance_id"] for f in vanilla_analysis["failures"]}
    omc_failed = {f["instance_id"] for f in omc_analysis["failures"]}

    comparison["unique_to_vanilla"] = list(vanilla_failed - omc_failed)
    comparison["unique_to_omc"] = list(omc_failed - vanilla_failed)
    comparison["common_failures"] = list(vanilla_failed & omc_failed)

    # Generate insights
    insights = []

    if len(comparison["unique_to_vanilla"]) > len(comparison["unique_to_omc"]):
        insights.append({
            "type": "positive",
            "message": f"OMC fixed {len(comparison['unique_to_vanilla'])} failures that vanilla couldn't solve."
        })
    elif len(comparison["unique_to_omc"]) > len(comparison["unique_to_vanilla"]):
        insights.append({
            "type": "negative",
            "message": f"OMC introduced {len(comparison['unique_to_omc'])} new failures compared to vanilla."
        })

    # Check for category improvements
    for category, counts in comparison["category_comparison"].items():
        if counts["delta"] < -2:
            insights.append({
                "type": "positive",
                "message": f"OMC reduced '{category}' failures by {abs(counts['delta'])}."
            })
        elif counts["delta"] > 2:
            insights.append({
                "type": "negative",
                "message": f"OMC increased '{category}' failures by {counts['delta']}."
            })

    comparison["insights"] = insights

    return comparison


def generate_failure_report(
    analysis: dict[str, Any],
    comparison: dict[str, Any] | None = None
) -> str:
    """Generate a detailed failure analysis report."""
    lines = [
        "# SWE-bench Failure Analysis Report",
        "",
        f"**Generated:** {analysis['timestamp']}",
        "",
        "## Summary",
        "",
        f"- **Total Instances:** {analysis['total_instances']}",
        f"- **Total Failures:** {analysis['total_failures']}",
        f"- **Failure Rate:** {analysis['total_failures']/max(analysis['total_instances'],1)*100:.1f}%",
        "",
        "## Failure Categories",
        "",
        "| Category | Count | Percentage |",
        "|----------|-------|------------|",
    ]

    total = max(analysis["total_failures"], 1)
    for category, count in sorted(
        analysis["category_counts"].items(),
        key=lambda x: -x[1]
    ):
        pct = count / total * 100
        lines.append(f"| {category} | {count} | {pct:.1f}% |")

    lines.extend([
        "",
        "## Recommendations",
        "",
    ])

    for rec in analysis["recommendations"]:
        priority = {"critical": "!!!", "high": "!!", "medium": "!", "info": "i"}.get(rec["type"], "-")
        lines.append(f"- [{priority}] {rec['message']}")

    # Repository breakdown
    if analysis.get("patterns", {}).get("by_repo"):
        lines.extend([
            "",
            "## Failures by Repository",
            "",
            "| Repository | Failures |",
            "|------------|----------|",
        ])

        for repo, failures in sorted(
            analysis["patterns"]["by_repo"].items(),
            key=lambda x: -len(x[1])
        )[:10]:
            lines.append(f"| {repo} | {len(failures)} |")

    # Comparison section
    if comparison:
        lines.extend([
            "",
            "## Vanilla vs OMC Comparison",
            "",
            f"- **Vanilla Failures:** {comparison['vanilla_failures']}",
            f"- **OMC Failures:** {comparison['omc_failures']}",
            f"- **Fixed by OMC:** {len(comparison['unique_to_vanilla'])}",
            f"- **New in OMC:** {len(comparison['unique_to_omc'])}",
            f"- **Common Failures:** {len(comparison['common_failures'])}",
            "",
            "### Category Changes",
            "",
            "| Category | Vanilla | OMC | Delta |",
            "|----------|---------|-----|-------|",
        ])

        for category, counts in sorted(
            comparison["category_comparison"].items(),
            key=lambda x: x[1]["delta"]
        ):
            delta_str = f"{counts['delta']:+d}" if counts['delta'] != 0 else "0"
            lines.append(f"| {category} | {counts['vanilla']} | {counts['omc']} | {delta_str} |")

        if comparison.get("insights"):
            lines.extend([
                "",
                "### Insights",
                "",
            ])
            for insight in comparison["insights"]:
                icon = {"positive": "+", "negative": "-", "neutral": "="}.get(insight["type"], "*")
                lines.append(f"- [{icon}] {insight['message']}")

    # Sample failures
    if analysis["failures"]:
        lines.extend([
            "",
            "## Sample Failures",
            "",
        ])

        for failure in analysis["failures"][:10]:
            lines.append(f"### {failure['instance_id']}")
            lines.append(f"- **Category:** {failure['category']}")
            if failure.get("error_message"):
                lines.append(f"- **Error:** `{failure['error_message']}`")
            if failure.get("details"):
                for k, v in failure["details"].items():
                    lines.append(f"- **{k}:** {v}")
            lines.append("")

    lines.extend([
        "",
        "---",
        "",
        "*Report generated by analyze_failures.py*"
    ])

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description="Analyze SWE-bench failure patterns",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    # Analyze single run
    python analyze_failures.py --results results/vanilla/

    # With predictions for more context
    python analyze_failures.py --results results/omc/ --predictions predictions.json

    # Compare vanilla vs OMC failures
    python analyze_failures.py --vanilla results/vanilla/ --omc results/omc/ --compare
        """
    )

    parser.add_argument(
        "--results",
        type=Path,
        help="Path to results directory for single analysis"
    )

    parser.add_argument(
        "--predictions",
        type=Path,
        help="Path to predictions JSON for additional context"
    )

    parser.add_argument(
        "--vanilla",
        type=Path,
        help="Path to vanilla results for comparison"
    )

    parser.add_argument(
        "--omc",
        type=Path,
        help="Path to OMC results for comparison"
    )

    parser.add_argument(
        "--compare",
        action="store_true",
        help="Compare vanilla vs OMC (requires --vanilla and --omc)"
    )

    parser.add_argument(
        "--output", "-o",
        type=Path,
        default=Path("analysis"),
        help="Output directory for analysis reports (default: analysis/)"
    )

    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Enable verbose logging"
    )

    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # Validate arguments
    if args.compare:
        if not args.vanilla or not args.omc:
            parser.error("--compare requires both --vanilla and --omc")
    elif not args.results:
        parser.error("Either --results or (--vanilla, --omc, --compare) required")

    args.output.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    if args.compare:
        # Comparison mode
        logger.info(f"Loading vanilla results from {args.vanilla}")
        vanilla_results = load_results(args.vanilla)
        vanilla_predictions = None

        logger.info(f"Loading OMC results from {args.omc}")
        omc_results = load_results(args.omc)
        omc_predictions = None

        # Try to load predictions
        for pred_path in [args.vanilla / "predictions.json", args.vanilla.parent / "vanilla_predictions.json"]:
            if pred_path.exists():
                vanilla_predictions = load_predictions(pred_path)
                break

        for pred_path in [args.omc / "predictions.json", args.omc.parent / "omc_predictions.json"]:
            if pred_path.exists():
                omc_predictions = load_predictions(pred_path)
                break

        logger.info("Analyzing failures...")
        vanilla_analysis = analyze_failures(vanilla_results, vanilla_predictions)
        omc_analysis = analyze_failures(omc_results, omc_predictions)

        logger.info("Comparing failures...")
        comparison = compare_failures(vanilla_analysis, omc_analysis)

        # Save outputs
        json_file = args.output / f"comparison_analysis_{timestamp}.json"
        with open(json_file, "w") as f:
            json.dump({
                "vanilla": vanilla_analysis,
                "omc": omc_analysis,
                "comparison": comparison
            }, f, indent=2)

        report = generate_failure_report(omc_analysis, comparison)
        md_file = args.output / f"comparison_analysis_{timestamp}.md"
        md_file.write_text(report)

        print("\n" + "=" * 60)
        print("FAILURE COMPARISON COMPLETE")
        print("=" * 60)
        print(f"Vanilla Failures: {vanilla_analysis['total_failures']}")
        print(f"OMC Failures:     {omc_analysis['total_failures']}")
        print(f"Fixed by OMC:     {len(comparison['unique_to_vanilla'])}")
        print(f"New in OMC:       {len(comparison['unique_to_omc'])}")
        print(f"\nResults saved to: {args.output}")
        print("=" * 60)

    else:
        # Single analysis mode
        logger.info(f"Loading results from {args.results}")
        results = load_results(args.results)

        predictions = None
        if args.predictions and args.predictions.exists():
            predictions = load_predictions(args.predictions)

        logger.info("Analyzing failures...")
        analysis = analyze_failures(results, predictions)

        # Save outputs
        json_file = args.output / f"failure_analysis_{timestamp}.json"
        with open(json_file, "w") as f:
            json.dump(analysis, f, indent=2)

        report = generate_failure_report(analysis)
        md_file = args.output / f"failure_analysis_{timestamp}.md"
        md_file.write_text(report)

        print("\n" + "=" * 60)
        print("FAILURE ANALYSIS COMPLETE")
        print("=" * 60)
        print(f"Total Instances: {analysis['total_instances']}")
        print(f"Total Failures:  {analysis['total_failures']}")
        print(f"\nTop Categories:")
        for cat, count in sorted(analysis["category_counts"].items(), key=lambda x: -x[1])[:5]:
            print(f"  {cat}: {count}")
        print(f"\nResults saved to: {args.output}")
        print("=" * 60)

    return 0


if __name__ == "__main__":
    exit(main())
