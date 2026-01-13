#!/usr/bin/env python3

"""
PostToolUse Hook: Verification Reminder System
Monitors tool execution and provides contextual guidance
"""

import sys
import json
import re
import os
from pathlib import Path
from datetime import datetime

# State file for session tracking
STATE_FILE = Path.home() / ".claude" / ".session-stats.json"
STATE_FILE.parent.mkdir(parents=True, exist_ok=True)

def load_stats():
    """Load session statistics from state file."""
    if STATE_FILE.exists():
        try:
            with open(STATE_FILE, 'r') as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            pass
    return {"sessions": {}}

def save_stats(stats):
    """Save session statistics to state file."""
    try:
        with open(STATE_FILE, 'w') as f:
            json.dump(stats, f, indent=2)
    except IOError:
        pass  # Fail silently

def update_stats(tool_name, session_id):
    """Update execution count for this session and tool."""
    stats = load_stats()

    if session_id not in stats["sessions"]:
        stats["sessions"][session_id] = {
            "tool_counts": {},
            "last_tool": "",
            "total_calls": 0,
            "started_at": int(datetime.now().timestamp())
        }

    session = stats["sessions"][session_id]
    session["tool_counts"][tool_name] = session["tool_counts"].get(tool_name, 0) + 1
    session["last_tool"] = tool_name
    session["total_calls"] = session.get("total_calls", 0) + 1
    session["updated_at"] = int(datetime.now().timestamp())

    save_stats(stats)
    return session["tool_counts"][tool_name]

def detect_bash_failure(output):
    """Detect failures in Bash tool output."""
    error_patterns = [
        r"error:",
        r"failed",
        r"cannot",
        r"permission denied",
        r"command not found",
        r"no such file",
        r"exit code: [1-9]",
        r"exit status [1-9]",
        r"fatal:",
        r"abort",
    ]

    output_lower = output.lower()
    for pattern in error_patterns:
        if re.search(pattern, output_lower, re.IGNORECASE):
            return True
    return False

def detect_background_operation(output):
    """Detect if output suggests a background operation."""
    bg_patterns = [
        r"started",
        r"running",
        r"background",
        r"async",
        r"task_id",
        r"spawned",
    ]

    output_lower = output.lower()
    for pattern in bg_patterns:
        if re.search(pattern, output_lower, re.IGNORECASE):
            return True
    return False

def detect_write_failure(output):
    """Detect failures in Write/Edit operations."""
    error_patterns = [
        r"error",
        r"failed",
        r"permission denied",
        r"read-only",
        r"not found",
    ]

    output_lower = output.lower()
    for pattern in error_patterns:
        if re.search(pattern, output_lower, re.IGNORECASE):
            return True
    return False

def generate_message(tool_name, tool_output, session_id, tool_count):
    """Generate contextual message based on tool usage."""
    message = ""

    if tool_name == "Bash":
        if detect_bash_failure(tool_output):
            message = "Command failed. Please investigate the error and fix before continuing."
        elif detect_background_operation(tool_output):
            message = "Background operation detected. Remember to verify results before proceeding."

    elif tool_name == "Task":
        if detect_write_failure(tool_output):
            message = "Task delegation failed. Verify agent name and parameters."
        elif detect_background_operation(tool_output):
            message = "Background task launched. Use TaskOutput to check results when needed."
        elif tool_count > 5:
            message = f"Multiple tasks delegated ({tool_count} total). Track their completion status."

    elif tool_name == "Edit":
        if detect_write_failure(tool_output):
            message = "Edit operation failed. Verify file exists and content matches exactly."
        else:
            message = "Code modified. Verify changes work as expected before marking complete."

    elif tool_name == "Write":
        if detect_write_failure(tool_output):
            message = "Write operation failed. Check file permissions and directory existence."
        else:
            message = "File written. Test the changes to ensure they work correctly."

    elif tool_name == "TodoWrite":
        output_lower = tool_output.lower()
        if re.search(r"created|added", output_lower):
            message = "Todo list updated. Proceed with next task on the list."
        elif re.search(r"completed|done", output_lower):
            message = "Task marked complete. Continue with remaining todos."
        elif re.search(r"in_progress", output_lower):
            message = "Task marked in progress. Focus on completing this task."

    elif tool_name == "Read":
        if tool_count > 10:
            message = f"Extensive reading ({tool_count} files). Consider using Grep for pattern searches."

    elif tool_name == "Grep":
        if re.search(r"^0$|no matches", tool_output):
            message = "No matches found. Verify pattern syntax or try broader search."

    elif tool_name == "Glob":
        if not tool_output.strip() or re.search(r"no files", tool_output.lower()):
            message = "No files matched pattern. Verify glob syntax and directory."

    return message

def main():
    """Main hook execution."""
    try:
        # Read JSON input from stdin
        input_data = json.load(sys.stdin)

        tool_name = input_data.get("toolName", "")
        tool_output = input_data.get("toolOutput", "")
        session_id = input_data.get("sessionId", "unknown")
        directory = input_data.get("directory", "")

        # Update session statistics
        tool_count = update_stats(tool_name, session_id)

        # Generate contextual message
        message = generate_message(tool_name, tool_output, session_id, tool_count)

        # Build response JSON (always continue for post-tool hooks)
        response = {"continue": True}
        if message:
            response["message"] = message

        # Output response
        print(json.dumps(response, indent=2))

    except Exception as e:
        # On error, always continue with no message
        print(json.dumps({"continue": True}))
        sys.exit(0)

if __name__ == "__main__":
    main()
