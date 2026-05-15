#!/usr/bin/env python3
"""
Patch OMC Claude worker startup/notification handling.

Run this from the root of your forked oh-my-claudecode repository:

    cd ~/contrib/oh-my-claudecode
    python3 patch_omc_claude_worker.py --source-only

For local smoke testing against generated/bundled files as well:

    python3 patch_omc_claude_worker.py --with-bundles

What it changes:
1. Adds a Claude idle prompt detector.
2. Allows readiness when Claude Code is showing an idle prompt.
3. Prevents sendToWorker() from rejecting Claude startup banner when the idle prompt is visible.

It intentionally does NOT blindly remove startup-banner protection. It only relaxes it
when Claude Code already appears interactive.
"""

from __future__ import annotations

import argparse
import shutil
import sys
import time
from pathlib import Path


SOURCE_TARGETS = [
    Path("src/team/tmux-session.ts"),
]

BUNDLE_TARGETS = [
    Path("bridge/cli.cjs"),
    Path("bridge/team.js"),
    Path("bridge/runtime-cli.cjs"),
    Path("bridge/team-mcp.cjs"),
    Path("dist/team/tmux-session.js"),
    Path("dist/team/tmux-comm.js"),
]

HELPER_TS = """
function paneHasClaudeIdlePrompt(captured: string): boolean {
  return /Claude Code[\\s\\S]*[❯›>]/u.test(captured) ||
    /Welcome back[\\s\\S]*[❯›>]/u.test(captured);
}
"""

HELPER_JS = """
function paneHasClaudeIdlePrompt(captured) {
  return /Claude Code[\\s\\S]*[❯›>]/u.test(captured) ||
    /Welcome back[\\s\\S]*[❯›>]/u.test(captured);
}
"""


def backup(path: Path) -> Path:
    backup_path = path.with_suffix(path.suffix + f".bak.claude-worker.{int(time.time())}")
    shutil.copy2(path, backup_path)
    return backup_path


def ensure_helper(text: str, helper: str) -> tuple[str, bool]:
    if "function paneHasClaudeIdlePrompt" in text:
        return text, False

    anchor = "function paneHasClaudeStartupBanner"
    idx = text.find(anchor)
    if idx == -1:
        return text, False

    return text[:idx] + helper + "\n" + text[idx:], True


def patch_ready_loop(text: str) -> tuple[str, bool]:
    changed = False

    old_variants = [
        """    const captured = await capturePaneAsync(paneId);
    if (paneLooksReady(captured) && !paneHasActiveTask(captured)) {
      return true;
    }
""",
        """        const captured = await capturePaneAsync(paneId);
        if (paneLooksReady(captured) && !paneHasActiveTask(captured)) {
            return true;
        }
""",
    ]

    new_variants = [
        """    const captured = await capturePaneAsync(paneId);
    if ((paneLooksReady(captured) || paneHasClaudeIdlePrompt(captured)) && !paneHasActiveTask(captured)) {
      return true;
    }
""",
        """        const captured = await capturePaneAsync(paneId);
        if ((paneLooksReady(captured) || paneHasClaudeIdlePrompt(captured)) && !paneHasActiveTask(captured)) {
            return true;
        }
""",
    ]

    for old, new in zip(old_variants, new_variants):
        if old in text and new not in text:
            text = text.replace(old, new)
            changed = True

    return text, changed


def patch_startup_banner_guard(text: str) -> tuple[str, bool]:
    changed = False

    old_variants = [
        """    if (paneHasClaudeStartupBanner(initialCapture)) {
      return false;
    }
""",
        """    if (paneHasClaudeStartupBanner(initialCapture) && !paneLooksReady(initialCapture)) {
      return false;
    }
""",
        """        if (paneHasClaudeStartupBanner(initialCapture)) {
            return false;
        }
""",
        """        if (paneHasClaudeStartupBanner(initialCapture) && !paneLooksReady(initialCapture)) {
            return false;
        }
""",
    ]

    new_variants = [
        """    if (
      paneHasClaudeStartupBanner(initialCapture) &&
      !paneLooksReady(initialCapture) &&
      !paneHasClaudeIdlePrompt(initialCapture)
    ) {
      return false;
    }
""",
        """    if (
      paneHasClaudeStartupBanner(initialCapture) &&
      !paneLooksReady(initialCapture) &&
      !paneHasClaudeIdlePrompt(initialCapture)
    ) {
      return false;
    }
""",
        """        if (paneHasClaudeStartupBanner(initialCapture) &&
            !paneLooksReady(initialCapture) &&
            !paneHasClaudeIdlePrompt(initialCapture)) {
            return false;
        }
""",
        """        if (paneHasClaudeStartupBanner(initialCapture) &&
            !paneLooksReady(initialCapture) &&
            !paneHasClaudeIdlePrompt(initialCapture)) {
            return false;
        }
""",
    ]

    for old, new in zip(old_variants, new_variants):
        if old in text and new not in text:
            text = text.replace(old, new)
            changed = True

    return text, changed


def patch_file(path: Path) -> bool:
    if not path.exists():
        print(f"SKIP missing: {path}")
        return False

    text = path.read_text(encoding="utf-8")

    is_ts = path.suffix == ".ts"
    helper = HELPER_TS if is_ts else HELPER_JS

    original = text
    text, helper_changed = ensure_helper(text, helper)
    text, ready_changed = patch_ready_loop(text)
    text, guard_changed = patch_startup_banner_guard(text)

    if text == original:
        print(f"NO CHANGE: {path}")
        return False

    backup_path = backup(path)
    path.write_text(text, encoding="utf-8")
    print(f"PATCHED: {path}")
    print(f"BACKUP:  {backup_path}")
    print(f"  helper={helper_changed} ready_loop={ready_changed} startup_guard={guard_changed}")
    return True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--with-bundles",
        action="store_true",
        help="Also patch generated bridge/dist files for local smoke testing.",
    )
    parser.add_argument(
        "--source-only",
        action="store_true",
        help="Patch only source files. Recommended for PR preparation.",
    )
    args = parser.parse_args()

    if args.source_only and args.with_bundles:
        print("Choose only one of --source-only or --with-bundles", file=sys.stderr)
        return 2

    repo_root = Path.cwd()
    if not (repo_root / "package.json").exists():
        print("Run this script from the oh-my-claudecode repository root.", file=sys.stderr)
        return 2

    targets = list(SOURCE_TARGETS)
    if args.with_bundles:
        targets.extend(BUNDLE_TARGETS)

    changed_any = False
    for target in targets:
        changed_any = patch_file(repo_root / target) or changed_any

    print()
    if changed_any:
        print("Patch complete.")
        print("Suggested next steps:")
        print("  git diff -- src/team/tmux-session.ts")
        print("  npm test -- --runInBand src/team/__tests__/tmux-session.test.ts  # if supported")
        print("  npm run build  # if the repo requires generated bridge/dist updates")
    else:
        print("No files changed. The patch may already be applied or patterns did not match.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
