#!/bin/bash

# PreToolUse Hook: Sisyphus Reminder Enforcer
# Injects contextual reminders before every tool execution

set -euo pipefail

# Read JSON input from stdin
input=$(cat)

# Simple JSON extraction using grep/sed (avoids jq dependency)
extract_json_field() {
    local field=$1
    local default=${2:-""}
    echo "$input" | grep -o "\"$field\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | sed 's/.*"\([^"]*\)".*/\1/' || echo "$default"
}

toolName=$(extract_json_field "toolName" "unknown")
directory=$(extract_json_field "directory" "")

# Try to get todo count from todo list file (if exists)
todo_file="${directory}/.sisyphus/todos.json"
todo_status=""
if [[ -f "$todo_file" ]] && command -v jq &> /dev/null; then
    pending=$(jq -r '[.todos[] | select(.status == "pending")] | length' "$todo_file" 2>/dev/null || echo "0")
    in_progress=$(jq -r '[.todos[] | select(.status == "in_progress")] | length' "$todo_file" 2>/dev/null || echo "0")
    if [[ $((pending + in_progress)) -gt 0 ]]; then
        todo_status="[${in_progress} active, ${pending} pending] "
    fi
fi

# Generate contextual reminder based on tool type
message=""

case "$toolName" in
    TodoWrite)
        message="${todo_status}Mark todos in_progress BEFORE starting, completed IMMEDIATELY after finishing."
        ;;

    Bash)
        message="${todo_status}Use parallel execution for independent tasks. Use run_in_background for long operations (npm install, builds, tests)."
        ;;

    Task)
        message="${todo_status}Launch multiple agents in parallel when tasks are independent. Use run_in_background for long operations."
        ;;

    Edit|Write)
        message="${todo_status}Verify changes work after editing. Test functionality before marking complete."
        ;;

    Read)
        message="${todo_status}Read multiple files in parallel when possible for faster analysis."
        ;;

    Grep|Glob)
        message="${todo_status}Combine searches in parallel when investigating multiple patterns."
        ;;

    *)
        message="${todo_status}The boulder never stops. Continue until all tasks complete."
        ;;
esac

# Return JSON response (always continue, just remind)
# Escape message for JSON (replace " with \", newlines with \n)
escaped_message=$(echo "$message" | sed 's/\\/\\\\/g' | sed 's/"/\\"/g' | tr '\n' ' ')

cat <<EOF
{
    "continue": true,
    "message": "$escaped_message"
}
EOF

exit 0
