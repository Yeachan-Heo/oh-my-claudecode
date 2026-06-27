---
name: ralphthon
description: Setup and manage the multi-pane tmux ralphthon orchestration environment. Use this skill when the user wants to run autonomous plan execution with a detached lead CLI pane using the --leader flag.
---

# Ralphthon Execution Workspace Skill

This skill automates the configuration and startup of a three-pane Tmux workspace for unattended plan execution:

- **Left Pane (Leader/Parent Agent):** Strategy and supervision.
- **Top-Right Pane (Orchestrator):** Runs `omc ralphthon --leader <executor_pane_id>`.
- **Bottom-Right Pane (Executor CLI):** Runs the CLI runner (e.g. `agy` or `claude`) with `--dangerously-skip-permissions` to work completely hands-free.

---

## 1. Setup Instructions

To establish the environment, follow these steps:

1. **Verify Tmux is active:**
   Ensure the current terminal is running inside a Tmux session.

2. **Split the right pane:**
   Split the active right pane vertically (creating top-right and bottom-right sections):
   ```bash
   tmux split-window -v -t <right_pane_id>
   ```

3. **Get the Pane IDs:**
   Retrieve the current pane layout list:
   ```bash
   tmux list-panes
   ```
   Identify the **Top-Right Pane ID** (usually `%3` or `%1`) and the **Bottom-Right Pane ID** (usually `%4` or `%2`).

4. **Launch the Executor CLI in the Bottom-Right Pane:**
   Send keys to launch the interactive executor CLI in the bottom-right pane with full permissions bypassed:
   ```bash
   tmux send-keys -t <bottom_right_pane_id> "cd $(pwd)" Enter "/home/galadriel/.local/bin/agy --dangerously-skip-permissions" Enter
   ```

5. **Initialize the Ralphthon Loop in the Top-Right Pane:**
   Type the orchestrator start command in the top-right pane pointing to the bottom-right leader executor pane (do not run immediately, let the user inspect it first):
   ```bash
   tmux send-keys -t <top_right_pane_id> "omc ralphthon --leader <bottom_right_pane_id> --skip-interview '<task_description>'"
   ```

---

## 2. Monitoring & Recovery

* **Watch the output:** The bottom-right pane displays the live coding activity. The top-right pane displays orchestrator loops and wave logs.
* **Stop the loop:** Send `Ctrl+C` to the top-right pane to terminate the orchestrator cleanly.
* **Kill a frozen executor:** If the executor CLI hangs, locate its PID and kill it, then relaunch it:
   ```bash
   kill -9 <pid>
   ```
* **State files:**
  * PRD task state: `.omc/ralphthon-prd.json`
  * Execution state: `.omc/state/sessions/<session_id>/ralphthon-state.json`

---

## 3. Pro-Tips & Caveats

* **Critical: Dangerously Skip Permissions:** You **MUST** run the executor CLI in the bottom-right pane with `--dangerously-skip-permissions` (e.g. `agy --dangerously-skip-permissions` or `claude --dangerously-skip-permissions`). Without this, the CLI will freeze on tool execution approval dialogs. Because these dialogs don't show active loading animations, the orchestrator will perceive the pane as idle and inject duplicate commands.
* **Resuming a Session:** If the orchestrator or executor crashes or is stopped, you can resume the run seamlessly from where you left off by appending the `--resume` flag:
  ```bash
  omc ralphthon --leader <executor_pane_id> --resume
  ```
* **Pane ID Visual Lookup:** You can easily check the pane ID values visually by pressing `Ctrl + B` then `q` in Tmux. This displays the numeric index of each pane overlaying the layout.
* **Orchestrator Idle Compatibility:** This workflow requires a patched `omc` build where `isPaneIdle` has been updated to check for `node`, `claude`, and `agy` process prompt states. Otherwise, the orchestrator will perceive the running CLI as busy forever.

