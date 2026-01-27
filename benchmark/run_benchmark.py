#!/usr/bin/env python3
"""
SWE-bench Benchmark Runner for Claude Code (Vanilla vs OMC)

This script evaluates Claude Code with and without oh-my-claudecode orchestration
on the SWE-bench Verified dataset.

Usage:
    python run_benchmark.py --mode vanilla --limit 10
    python run_benchmark.py --mode omc --output-dir ./predictions/omc
    python run_benchmark.py --mode vanilla --resume checkpoint.json
"""

import argparse
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Optional

try:
    from datasets import load_dataset
except ImportError:
    print("Error: datasets library not installed. Run: pip install datasets")
    sys.exit(1)


# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler("benchmark.log"),
    ],
)
logger = logging.getLogger(__name__)


@dataclass
class BenchmarkConfig:
    """Configuration for benchmark run."""

    dataset: str = "princeton-nlp/SWE-bench_Verified"
    mode: str = "vanilla"  # vanilla or omc
    output_dir: Path = field(default_factory=lambda: Path("./predictions"))
    max_workers: int = 1
    timeout: int = 1800  # 30 minutes default
    resume: Optional[Path] = None
    limit: Optional[int] = None
    retries: int = 3
    retry_delay: int = 30
    model: str = "claude-sonnet-4-20250514"
    skip: int = 0


@dataclass
class TaskResult:
    """Result from processing a single task instance."""

    instance_id: str
    success: bool
    patch: Optional[str] = None
    error: Optional[str] = None
    duration: float = 0.0
    token_usage: dict = field(default_factory=dict)
    retries_used: int = 0


@dataclass
class Checkpoint:
    """Checkpoint state for resuming interrupted runs."""

    completed_instances: list = field(default_factory=list)
    failed_instances: list = field(default_factory=list)
    total_instances: int = 0
    start_time: str = ""
    mode: str = ""
    config: dict = field(default_factory=dict)


class SWEBenchRunner:
    """Main benchmark runner for SWE-bench evaluation."""

    def __init__(self, config: BenchmarkConfig):
        self.config = config
        self.config.output_dir.mkdir(parents=True, exist_ok=True)
        self.checkpoint_path = self.config.output_dir / "checkpoint.json"
        self.predictions_path = self.config.output_dir / "predictions.jsonl"
        self.stats_path = self.config.output_dir / "stats.json"
        self.checkpoint = self._load_checkpoint()
        self.stats = {
            "total": 0,
            "completed": 0,
            "failed": 0,
            "total_tokens": 0,
            "total_duration": 0.0,
        }

    def _load_checkpoint(self) -> Checkpoint:
        """Load checkpoint from file if resuming."""
        if self.config.resume and self.config.resume.exists():
            with open(self.config.resume) as f:
                data = json.load(f)
            logger.info(f"Resuming from checkpoint: {len(data['completed_instances'])} completed")
            return Checkpoint(**data)
        return Checkpoint(
            start_time=datetime.now().isoformat(),
            mode=self.config.mode,
            config={
                "dataset": self.config.dataset,
                "timeout": self.config.timeout,
                "max_workers": self.config.max_workers,
            },
        )

    def _save_checkpoint(self):
        """Save current checkpoint state."""
        with open(self.checkpoint_path, "w") as f:
            json.dump(
                {
                    "completed_instances": self.checkpoint.completed_instances,
                    "failed_instances": self.checkpoint.failed_instances,
                    "total_instances": self.checkpoint.total_instances,
                    "start_time": self.checkpoint.start_time,
                    "mode": self.checkpoint.mode,
                    "config": self.checkpoint.config,
                },
                f,
                indent=2,
            )

    def _save_prediction(self, result: TaskResult):
        """Append prediction to JSONL file in SWE-bench format."""
        if result.success and result.patch:
            prediction = {
                "instance_id": result.instance_id,
                "model_name_or_path": f"claude-code-{self.config.mode}",
                "model_patch": result.patch,
            }
            with open(self.predictions_path, "a") as f:
                f.write(json.dumps(prediction) + "\n")

    def _save_stats(self):
        """Save run statistics."""
        self.stats["success_rate"] = (
            self.stats["completed"] / self.stats["total"] * 100
            if self.stats["total"] > 0
            else 0
        )
        self.stats["avg_duration"] = (
            self.stats["total_duration"] / self.stats["total"]
            if self.stats["total"] > 0
            else 0
        )
        with open(self.stats_path, "w") as f:
            json.dump(self.stats, f, indent=2)

    def load_dataset(self) -> list[dict]:
        """Load SWE-bench dataset from HuggingFace."""
        logger.info(f"Loading dataset: {self.config.dataset}")
        try:
            dataset = load_dataset(self.config.dataset, split="test")
            instances = list(dataset)
            logger.info(f"Loaded {len(instances)} instances")

            # Filter out already completed instances if resuming
            if self.checkpoint.completed_instances:
                instances = [
                    i
                    for i in instances
                    if i["instance_id"] not in self.checkpoint.completed_instances
                ]
                logger.info(f"After filtering completed: {len(instances)} remaining")

            # Apply skip if specified
            if self.config.skip > 0:
                instances = instances[self.config.skip :]
                logger.info(f"Skipped first {self.config.skip} instances, {len(instances)} remaining")

            # Apply limit if specified
            if self.config.limit:
                instances = instances[: self.config.limit]
                logger.info(f"Limited to {len(instances)} instances")

            self.checkpoint.total_instances = len(instances)
            return instances
        except Exception as e:
            logger.error(f"Failed to load dataset: {e}")
            raise

    def _setup_repo(self, instance: dict, work_dir: Path) -> bool:
        """Clone repo and checkout base commit."""
        repo = instance["repo"]
        base_commit = instance["base_commit"]

        try:
            # Clone the repo
            repo_url = f"https://github.com/{repo}.git"
            logger.debug(f"Cloning {repo_url}")
            subprocess.run(
                ["git", "clone", "--depth", "100", repo_url, str(work_dir)],
                check=True,
                capture_output=True,
                timeout=300,
            )

            # Fetch the specific commit if needed and checkout
            subprocess.run(
                ["git", "fetch", "--depth", "100", "origin", base_commit],
                cwd=work_dir,
                capture_output=True,
                timeout=120,
            )
            subprocess.run(
                ["git", "checkout", base_commit],
                cwd=work_dir,
                check=True,
                capture_output=True,
                timeout=60,
            )
            return True
        except subprocess.TimeoutExpired:
            logger.error(f"Timeout setting up repo {repo}")
            return False
        except subprocess.CalledProcessError as e:
            logger.error(f"Git error for {repo}: {e.stderr.decode() if e.stderr else e}")
            return False

    def _format_problem(self, instance: dict) -> str:
        """Format the problem statement from issue description."""
        problem = instance.get("problem_statement", "")
        repo = instance["repo"]
        instance_id = instance["instance_id"]

        # Clean up the problem statement
        problem = problem.strip()

        # Add context
        formatted = f"""Repository: {repo}
Instance ID: {instance_id}

Issue Description:
{problem}

Instructions:
1. Analyze the issue carefully
2. Find the relevant code that needs to be changed
3. Implement a fix that resolves the issue
4. Make minimal changes necessary to fix the issue
5. Do not break any existing functionality
"""
        return formatted

    def _run_claude(self, problem: str, work_dir: Path) -> tuple[Optional[str], dict]:
        """Run Claude Code on the problem and return the patch."""
        if self.config.mode == "vanilla":
            cmd = [
                "claude",
                "--print",
                "--model",
                self.config.model,
                f"Fix this issue:\n\n{problem}",
                "--allowedTools",
                "Edit,Bash,Read,Write,Glob,Grep",
            ]
        else:  # omc mode
            cmd = [
                "claude",
                "--print",
                "--model",
                self.config.model,
                f"/oh-my-claudecode:autopilot Fix this issue:\n\n{problem}",
            ]

        token_usage = {}
        try:
            # Prepare environment with API configuration
            env = {
                **os.environ,
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            }

            # Pass ANTHROPIC_BASE_URL if set
            if "ANTHROPIC_BASE_URL" in os.environ:
                env["ANTHROPIC_BASE_URL"] = os.environ["ANTHROPIC_BASE_URL"]

            # Ensure ANTHROPIC_AUTH_TOKEN is passed
            if "ANTHROPIC_AUTH_TOKEN" not in env:
                logger.error("ANTHROPIC_AUTH_TOKEN not found in environment")
                return None, {"error": "missing_auth_token"}

            result = subprocess.run(
                cmd,
                cwd=work_dir,
                capture_output=True,
                text=True,
                timeout=self.config.timeout,
                env=env,
            )

            # Try to extract token usage from output
            # Claude Code may include usage info in stderr or structured output
            if result.stderr:
                for line in result.stderr.split("\n"):
                    if "tokens" in line.lower():
                        token_usage["raw"] = line

            # Get the diff/patch
            patch = self._extract_patch(work_dir)
            return patch, token_usage

        except subprocess.TimeoutExpired:
            logger.warning(f"Claude timed out after {self.config.timeout}s")
            return None, {"error": "timeout"}
        except Exception as e:
            logger.error(f"Error running Claude: {e}")
            return None, {"error": str(e)}

    def _extract_patch(self, work_dir: Path) -> Optional[str]:
        """Extract git diff as patch from work directory."""
        try:
            # Get both staged and unstaged changes
            result = subprocess.run(
                ["git", "diff", "HEAD"],
                cwd=work_dir,
                capture_output=True,
                text=True,
                timeout=30,
            )
            patch = result.stdout.strip()

            if not patch:
                # Check for new untracked files
                status = subprocess.run(
                    ["git", "status", "--porcelain"],
                    cwd=work_dir,
                    capture_output=True,
                    text=True,
                )
                if status.stdout.strip():
                    # There are changes, try to stage and diff
                    subprocess.run(
                        ["git", "add", "-A"],
                        cwd=work_dir,
                        capture_output=True,
                    )
                    result = subprocess.run(
                        ["git", "diff", "--cached"],
                        cwd=work_dir,
                        capture_output=True,
                        text=True,
                    )
                    patch = result.stdout.strip()

            return patch if patch else None
        except Exception as e:
            logger.error(f"Error extracting patch: {e}")
            return None

    def process_instance(self, instance: dict) -> TaskResult:
        """Process a single SWE-bench instance."""
        instance_id = instance["instance_id"]
        start_time = time.time()
        logger.info(f"Processing: {instance_id}")

        result = TaskResult(instance_id=instance_id, success=False)

        for attempt in range(self.config.retries):
            if attempt > 0:
                logger.info(f"Retry {attempt + 1}/{self.config.retries} for {instance_id}")
                time.sleep(self.config.retry_delay)

            work_dir = None
            try:
                # Create temp directory
                work_dir = Path(tempfile.mkdtemp(prefix=f"swe-bench-{instance_id}-"))

                # Setup repo
                if not self._setup_repo(instance, work_dir):
                    result.error = "Failed to setup repository"
                    continue

                # Format problem
                problem = self._format_problem(instance)

                # Run Claude
                patch, token_usage = self._run_claude(problem, work_dir)

                if patch:
                    result.success = True
                    result.patch = patch
                    result.token_usage = token_usage
                    result.retries_used = attempt
                    break
                else:
                    result.error = "No patch generated"

            except Exception as e:
                logger.error(f"Error processing {instance_id}: {e}")
                result.error = str(e)

            finally:
                # Cleanup temp directory
                if work_dir and work_dir.exists():
                    try:
                        shutil.rmtree(work_dir)
                    except Exception as e:
                        logger.warning(f"Failed to cleanup {work_dir}: {e}")

        result.duration = time.time() - start_time
        return result

    def _estimate_eta(self, completed: int, total: int, elapsed: float) -> str:
        """Estimate time remaining."""
        if completed == 0:
            return "calculating..."
        avg_time = elapsed / completed
        remaining = (total - completed) * avg_time
        eta = timedelta(seconds=int(remaining))
        return str(eta)

    def run(self):
        """Run the benchmark."""
        logger.info(f"Starting SWE-bench benchmark in {self.config.mode} mode")
        logger.info(f"Output directory: {self.config.output_dir}")

        # Load dataset
        instances = self.load_dataset()
        if not instances:
            logger.info("No instances to process")
            return

        total = len(instances)
        self.stats["total"] = total
        start_time = time.time()

        logger.info(f"Processing {total} instances with {self.config.max_workers} workers")

        if self.config.max_workers == 1:
            # Sequential processing
            for i, instance in enumerate(instances, 1):
                result = self.process_instance(instance)
                self._handle_result(result, i, total, start_time)
        else:
            # Parallel processing
            with ThreadPoolExecutor(max_workers=self.config.max_workers) as executor:
                futures = {
                    executor.submit(self.process_instance, inst): inst
                    for inst in instances
                }
                completed = 0
                for future in as_completed(futures):
                    completed += 1
                    try:
                        result = future.result()
                        self._handle_result(result, completed, total, start_time)
                    except Exception as e:
                        instance = futures[future]
                        logger.error(f"Future failed for {instance['instance_id']}: {e}")

        # Final stats
        elapsed = time.time() - start_time
        logger.info(f"\n{'='*60}")
        logger.info(f"Benchmark Complete!")
        logger.info(f"Total instances: {self.stats['total']}")
        logger.info(f"Successful: {self.stats['completed']}")
        logger.info(f"Failed: {self.stats['failed']}")
        logger.info(
            f"Success rate: {self.stats['completed']/self.stats['total']*100:.1f}%"
            if self.stats["total"] > 0
            else "N/A"
        )
        logger.info(f"Total time: {timedelta(seconds=int(elapsed))}")
        logger.info(f"Predictions saved to: {self.predictions_path}")
        logger.info(f"{'='*60}")

        self._save_stats()

    def _handle_result(self, result: TaskResult, completed: int, total: int, start_time: float):
        """Handle a completed task result."""
        elapsed = time.time() - start_time
        eta = self._estimate_eta(completed, total, elapsed)

        if result.success:
            self.stats["completed"] += 1
            self.checkpoint.completed_instances.append(result.instance_id)
            self._save_prediction(result)
            status = "SUCCESS"
        else:
            self.stats["failed"] += 1
            self.checkpoint.failed_instances.append(result.instance_id)
            status = f"FAILED: {result.error}"

        self.stats["total_duration"] += result.duration

        logger.info(
            f"[{completed}/{total}] {result.instance_id}: {status} "
            f"(duration: {result.duration:.1f}s, ETA: {eta})"
        )

        # Save checkpoint after each instance
        self._save_checkpoint()


def parse_args() -> argparse.Namespace:
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="SWE-bench Benchmark Runner for Claude Code",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Run vanilla Claude Code on first 10 instances
  python run_benchmark.py --mode vanilla --limit 10

  # Run OMC mode with 2 parallel workers
  python run_benchmark.py --mode omc --max-workers 2

  # Resume from checkpoint
  python run_benchmark.py --mode vanilla --resume predictions/checkpoint.json

  # Custom timeout (45 minutes per instance)
  python run_benchmark.py --mode omc --timeout 2700
        """,
    )

    parser.add_argument(
        "--dataset",
        default="princeton-nlp/SWE-bench_Verified",
        help="HuggingFace dataset to use (default: SWE-bench_Verified)",
    )
    parser.add_argument(
        "--mode",
        choices=["vanilla", "omc"],
        default=os.environ.get("RUN_MODE", "vanilla"),
        help="Run mode: vanilla (bare Claude) or omc (with orchestration)",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("./predictions"),
        help="Output directory for predictions (default: ./predictions)",
    )
    parser.add_argument(
        "--max-workers",
        type=int,
        default=1,
        help="Number of parallel instances (default: 1)",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=1800,
        help="Timeout per instance in seconds (default: 1800 = 30 minutes)",
    )
    parser.add_argument(
        "--resume",
        type=Path,
        default=None,
        help="Checkpoint file to resume from",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Maximum instances to run (for testing)",
    )
    parser.add_argument(
        "--retries",
        type=int,
        default=3,
        help="Number of retries per instance (default: 3)",
    )
    parser.add_argument(
        "--model",
        default="claude-sonnet-4-20250514",
        help="Claude model to use (default: claude-sonnet-4-20250514)",
    )
    parser.add_argument(
        "--skip",
        type=int,
        default=0,
        help="Number of instances to skip (default: 0)",
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Enable verbose logging",
    )

    return parser.parse_args()


def main():
    """Main entry point."""
    args = parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    config = BenchmarkConfig(
        dataset=args.dataset,
        mode=args.mode,
        output_dir=args.output_dir,
        max_workers=args.max_workers,
        timeout=args.timeout,
        resume=args.resume,
        limit=args.limit,
        retries=args.retries,
        model=args.model,
        skip=args.skip,
    )

    runner = SWEBenchRunner(config)
    runner.run()


if __name__ == "__main__":
    main()
