#!/usr/bin/env python3
"""
Progress visualization for the self-improvement loop.
Reads raw_data.json and generates progress.png.

Usage:
    python3 plot_progress.py --data /path/to/raw_data.json --output /path/to/progress.png
    python3 plot_progress.py --tracking-dir /path/to/<self-improve-root>/tracking/
"""

import argparse
import json
import sys
from pathlib import Path


def load_data(data_path: str) -> list:
    path = Path(data_path)
    if not path.exists():
        print(f"Warning: {data_path} not found. No visualization generated.")
        return []
    with open(path) as f:
        return json.load(f)


def plot_with_matplotlib(data: list, output_path: str):
    try:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
    except ImportError:
        print("Warning: matplotlib not available. Generating text summary instead.")
        generate_text_summary(data, output_path)
        return

    iterations = sorted(set(d['iteration'] for d in data))
    winners = [d for d in data if d.get('is_winner')]
    losers = [d for d in data if not d.get('is_winner')]

    fig, ax = plt.subplots(figsize=(12, 6))

    if losers:
        ax.scatter(
            [d['iteration'] for d in losers],
            [d['benchmark_score'] for d in losers],
            c='lightgray', alpha=0.5, s=30, label='Candidates', zorder=2
        )

    if winners:
        ax.plot(
            [d['iteration'] for d in winners],
            [d['benchmark_score'] for d in winners],
            'b-o', linewidth=2, markersize=8, label='Winners', zorder=3
        )

        families = list(set(d.get('approach_family', 'unknown') for d in winners))
        colors = plt.cm.Set2(range(len(families)))
        family_color = dict(zip(families, colors))
        for d in winners:
            family = d.get('approach_family', 'unknown')
            ax.annotate(
                family[:4],
                (d['iteration'], d['benchmark_score']),
                textcoords="offset points", xytext=(0, 10),
                fontsize=7, ha='center', color=family_color.get(family, 'black')
            )

    ax.set_xlabel('Iteration')
    ax.set_ylabel('Benchmark Score')
    ax.set_title('Self-Improvement Progress')
    ax.legend(loc='best')
    ax.grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig(output_path, dpi=150)
    plt.close()
    print(f"Visualization saved to: {output_path}")


def generate_text_summary(data: list, output_path: str):
    """Fallback when matplotlib is not available."""
    winners = [d for d in data if d.get('is_winner')]
    summary_path = Path(output_path).with_suffix('.txt')

    lines = ["Self-Improvement Progress Summary", "=" * 40, ""]
    for w in winners:
        lines.append(
            f"Iteration {w['iteration']}: score={w['benchmark_score']:.4f} "
            f"family={w.get('approach_family', '?')} plan={w.get('plan_id', '?')}"
        )

    if winners:
        scores = [w['benchmark_score'] for w in winners]
        lines.append("")
        lines.append(f"Best: {max(scores):.4f}  Worst: {min(scores):.4f}  "
                      f"Delta: {max(scores) - min(scores):.4f}")

    with open(summary_path, 'w') as f:
        f.write('\n'.join(lines))
    print(f"Text summary saved to: {summary_path}")


def main():
    parser = argparse.ArgumentParser(description='Self-improvement progress visualization')
    parser.add_argument('--data', help='Path to raw_data.json')
    parser.add_argument('--output', help='Path to output image')
    parser.add_argument('--tracking-dir', help='Path to tracking/ directory (auto-discovers data and output)')
    args = parser.parse_args()

    if args.tracking_dir:
        data_path = str(Path(args.tracking_dir) / 'raw_data.json')
        output_path = str(Path(args.tracking_dir) / 'progress.png')
    elif args.data and args.output:
        data_path = args.data
        output_path = args.output
    else:
        print("Usage: plot_progress.py --tracking-dir /path/ OR --data /path/raw_data.json --output /path/progress.png")
        sys.exit(1)

    data = load_data(data_path)
    if not data:
        sys.exit(0)

    plot_with_matplotlib(data, output_path)


if __name__ == '__main__':
    main()
