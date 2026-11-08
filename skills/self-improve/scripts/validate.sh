#!/usr/bin/env bash
# validate.sh — Sealed file enforcement + plan schema validation for self-improvement loop.
# Usage:
#   ./validate.sh --worktree /path --settings /path/to/settings.json plan.json
#   ./validate.sh --project-root /path/to/omc/project --topic "Improve tests" plan.json
#   ./validate.sh plan.json
#   ./validate.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Settings path may be provided directly or resolved from the scoped self-improve root.
SETTINGS=""
PROJECT_ROOT=""
TOPIC_NAME=""
TOPIC_SLUG=""

# Parse arguments
WORKTREE_PATH=""
POSITIONAL_ARGS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --worktree)
            WORKTREE_PATH="$2"
            shift 2
            ;;
        --settings)
            SETTINGS="$2"
            shift 2
            ;;
        --project-root)
            PROJECT_ROOT="$2"
            shift 2
            ;;
        --topic)
            TOPIC_NAME="$2"
            shift 2
            ;;
        --slug)
            TOPIC_SLUG="$2"
            shift 2
            ;;
        *)
            POSITIONAL_ARGS+=("$1")
            shift
            ;;
    esac
done
set -- "${POSITIONAL_ARGS[@]+"${POSITIONAL_ARGS[@]}"}"

GIT_DIR="${WORKTREE_PATH:-$(pwd)}"

err() { echo "ERROR: $*" >&2; }
ok()  { echo "OK: $*"; }

require_jq() {
    if ! command -v jq &>/dev/null; then
        err "jq is not installed. Install with: brew install jq (macOS) or apt-get install jq (Linux)"
        exit 1
    fi
}

resolve_settings_from_project_root() {
    local project_root="$1"
    local resolver="${SCRIPT_DIR}/resolve-paths.mjs"
    local args=( "${resolver}" --project-root "${project_root}" )

    if [[ -n "${TOPIC_SLUG}" ]]; then
        args+=( --slug "${TOPIC_SLUG}" )
    elif [[ -n "${TOPIC_NAME}" ]]; then
        args+=( --topic "${TOPIC_NAME}" )
    fi

    local resolved
    resolved=$(node "${args[@]}" 2>/dev/null || true)
    if [[ -z "${resolved}" ]]; then
        return 1
    fi

    local candidate
    candidate=$(printf '%s' "${resolved}" | jq -r '.settings_path // ""' 2>/dev/null || true)
    if [[ -n "${candidate}" ]]; then
        SETTINGS="${candidate}"
        return 0
    fi

    return 1
}

discover_settings_from_search_root() {
    local search_dir="$1"
    while [[ "${search_dir}" != "/" ]]; do
        if [[ -f "${search_dir}/.omc/self-improve/config/settings.json" ]]; then
            SETTINGS="${search_dir}/.omc/self-improve/config/settings.json"
            return 0
        fi

        shopt -s nullglob
        local scoped_candidates=( "${search_dir}"/.omc/self-improve/topics/*/config/settings.json )
        shopt -u nullglob
        if [[ "${#scoped_candidates[@]}" -eq 1 ]]; then
            SETTINGS="${scoped_candidates[0]}"
            return 0
        fi
        if [[ "${#scoped_candidates[@]}" -gt 1 ]]; then
            err "Multiple self-improve topics exist under ${search_dir}/.omc/self-improve/topics/. Pass --settings, --project-root with --topic/--slug, or set SELF_IMPROVE_SETTINGS_PATH."
            exit 1
        fi

        search_dir="$(dirname "${search_dir}")"
    done
    return 1
}

resolve_settings_path() {
    [[ -n "${SETTINGS}" ]] && return 0

    if [[ -n "${SELF_IMPROVE_SETTINGS_PATH:-}" ]]; then
        SETTINGS="${SELF_IMPROVE_SETTINGS_PATH}"
        return 0
    fi

    require_jq

    if [[ -n "${PROJECT_ROOT}" ]]; then
        if [[ -n "${TOPIC_SLUG}" || -n "${TOPIC_NAME}" ]]; then
            if resolve_settings_from_project_root "${PROJECT_ROOT}"; then
                return 0
            fi
        fi

        if discover_settings_from_search_root "${PROJECT_ROOT}"; then
            return 0
        fi
    fi

    local search_dir="${WORKTREE_PATH:-$(pwd)}"
    if discover_settings_from_search_root "${search_dir}"; then
        return 0
    fi

    return 1
}

check_sealed_files() {
    resolve_settings_path || true

    if [[ -z "${SETTINGS}" || ! -f "${SETTINGS}" ]]; then
        ok "No settings file found — skipping sealed file check."
        return 0
    fi

    has_sealed=$(jq -r 'if (.sealed_files | type) == "array" and (.sealed_files | length) > 0 then "yes" else "no" end' "${SETTINGS}" 2>/dev/null || echo "no")

    if [[ "${has_sealed}" != "yes" ]]; then
        ok "No sealed files configured — skipping."
        return 0
    fi

    if ! git -C "${GIT_DIR}" rev-parse --git-dir &>/dev/null 2>&1; then
        ok "Not a git repository — skipping sealed file check."
        return 0
    fi

    local modified_files_str=""
    if [[ -n "${WORKTREE_PATH}" ]]; then
        # Find the correct baseline: the improvement branch this experiment branched from.
        # Try improve/* branches first, then fall back to main/master.
        local base_commit
        local improve_branch
        improve_branch=$(git -C "${GIT_DIR}" branch -a --list 'improve/*' 2>/dev/null | head -1 | tr -d ' *' || true)
        if [[ -z "${improve_branch}" ]]; then
            improve_branch=$(git -C "${GIT_DIR}" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||' || echo "main")
        fi
        base_commit=$(git -C "${GIT_DIR}" merge-base HEAD "${improve_branch}" 2>/dev/null || echo "HEAD~1")
        modified_files_str=$(git -C "${GIT_DIR}" diff --name-only "${base_commit}" 2>/dev/null || true)
        local uncommitted
        uncommitted=$(git -C "${GIT_DIR}" diff --name-only 2>/dev/null || true)
        if [[ -n "${uncommitted}" ]]; then
            modified_files_str="${modified_files_str}"$'\n'"${uncommitted}"
        fi
    else
        modified_files_str=$(git -C "${GIT_DIR}" diff --name-only HEAD 2>/dev/null || true)
        local staged
        staged=$(git -C "${GIT_DIR}" diff --name-only --cached 2>/dev/null || true)
        if [[ -n "${staged}" ]]; then
            modified_files_str="${modified_files_str}"$'\n'"${staged}"
        fi
    fi

    if [[ -n "${modified_files_str}" ]]; then
        modified_files_str=$(echo "${modified_files_str}" | sort -u)
    fi

    if [[ -z "${modified_files_str}" ]]; then
        ok "No modified files detected."
        return 0
    fi

    violations=""
    while IFS= read -r sealed; do
        [[ -z "${sealed}" ]] && continue
        while IFS= read -r modified; do
            [[ -z "${modified}" ]] && continue
            if [[ "${sealed}" == */ ]]; then
                [[ "${modified}" == "${sealed}"* ]] && violations="${violations} ${modified}"
            else
                [[ "${modified}" == "${sealed}" ]] && violations="${violations} ${modified}"
            fi
        done <<< "${modified_files_str}"
    done < <(jq -r '.sealed_files[]' "${SETTINGS}" 2>/dev/null)

    if [[ -n "${violations}" ]]; then
        err "Sealed file(s) were modified:${violations}"
        exit 1
    fi

    local modified_count
    modified_count=$(echo "${modified_files_str}" | wc -l | tr -d ' ')
    ok "Sealed file check passed (${modified_count} modified, none sealed)."
}

check_plan_schema() {
    local plan_file="$1"
    require_jq

    if [[ ! -f "${plan_file}" ]]; then
        err "Plan file not found: ${plan_file}"
        exit 1
    fi

    local required_fields="plan_id planner_id round hypothesis approach_family critic_approved target_files steps expected_outcome history_reference"
    local missing=""

    for field in ${required_fields}; do
        val=$(jq -r --arg f "${field}" '.[$f]' "${plan_file}" 2>/dev/null)
        if [[ "${val}" == "null" || -z "${val}" ]]; then
            missing="${missing} ${field}"
        fi
    done

    if [[ -n "${missing}" ]]; then
        err "Plan is missing required fields:${missing}"
        exit 1
    fi
    ok "Plan contains all required fields."

    # approach_family validation is handled by the critic (supports custom families
    # from harness.md). validate.sh only checks structural schema, not taxonomy.

    # Validate hypothesis is a single string
    hypothesis_type=$(jq -r '.hypothesis | type' "${plan_file}" 2>/dev/null)
    if [[ "${hypothesis_type}" != "string" ]]; then
        err "hypothesis must be a string (got ${hypothesis_type})"
        exit 1
    fi
    ok "One-hypothesis check passed."

    # Validate steps non-empty
    steps_len=$(jq '.steps | length' "${plan_file}" 2>/dev/null || echo "0")
    if [[ "${steps_len}" -eq 0 ]]; then
        err "steps must be a non-empty array"
        exit 1
    fi
    ok "Steps validated (${steps_len} step(s))."
}

check_result_schema() {
    local result_file="$1"
    require_jq

    if [[ ! -f "${result_file}" ]]; then
        err "Result file not found: ${result_file}"
        exit 1
    fi

    local required_fields="executor_id plan_id benchmark_score status timestamp benchmark_raw"
    local missing=""

    for field in ${required_fields}; do
        val=$(jq -r --arg f "${field}" '.[$f]' "${result_file}" 2>/dev/null)
        if [[ "${val}" == "null" || -z "${val}" ]]; then
            if [[ "${field}" == "benchmark_raw" ]]; then
                exists=$(jq --arg f "${field}" 'has($f)' "${result_file}" 2>/dev/null || echo "false")
                if [[ "${exists}" != "true" ]]; then
                    missing="${missing} ${field}"
                fi
            elif [[ "${field}" == "benchmark_score" ]]; then
                exists=$(jq --arg f "${field}" 'has($f)' "${result_file}" 2>/dev/null || echo "false")
                if [[ "${exists}" != "true" ]]; then
                    missing="${missing} ${field}"
                fi
            else
                missing="${missing} ${field}"
            fi
        fi
    done

    if [[ -n "${missing}" ]]; then
        err "Result is missing required fields:${missing}"
        exit 1
    fi
    ok "Result contains all required fields."

    # Validate status enum
    local status
    status=$(jq -r '.status' "${result_file}" 2>/dev/null)
    case "${status}" in
        success|regression|error|timeout) ;;
        *)
            err "Invalid status '${status}'. Must be one of: success, regression, error, timeout"
            exit 1
            ;;
    esac
    ok "Status '${status}' is valid."

    # Check failure_analysis on non-success status
    if [[ "${status}" != "success" ]]; then
        local fa_type
        fa_type=$(jq -r '.failure_analysis | type' "${result_file}" 2>/dev/null)
        if [[ "${fa_type}" != "object" ]]; then
            err "failure_analysis must be a non-null object when status is '${status}' (got ${fa_type})"
            exit 1
        fi

        local fa_fields="what why category lesson"
        local fa_missing=""
        for field in ${fa_fields}; do
            val=$(jq -r --arg f "${field}" '.failure_analysis[$f]' "${result_file}" 2>/dev/null)
            if [[ "${val}" == "null" || -z "${val}" ]]; then
                fa_missing="${fa_missing} ${field}"
            fi
        done

        if [[ -n "${fa_missing}" ]]; then
            err "failure_analysis is missing required fields:${fa_missing}"
            exit 1
        fi
        ok "failure_analysis is complete for non-success status."

        # Validate failure category enum
        local fa_category
        fa_category=$(jq -r '.failure_analysis.category' "${result_file}" 2>/dev/null)
        local valid_categories="oom timeout regression logic_error scope_error infrastructure benchmark_parse_error sealed_file_violation"
        local cat_valid=0
        for cat in ${valid_categories}; do
            if [[ "${fa_category}" == "${cat}" ]]; then
                cat_valid=1
                break
            fi
        done

        if [[ ${cat_valid} -eq 0 ]]; then
            err "failure_analysis.category '${fa_category}' is not valid. Must be one of: ${valid_categories}"
            exit 1
        fi
        ok "failure_analysis.category '${fa_category}' is valid."
    fi

    # Validate sub_scores if present
    local has_sub_scores
    has_sub_scores=$(jq 'has("sub_scores")' "${result_file}" 2>/dev/null || echo "false")
    if [[ "${has_sub_scores}" == "true" ]]; then
        local sub_scores_type
        sub_scores_type=$(jq -r '.sub_scores | type' "${result_file}" 2>/dev/null)
        if [[ "${sub_scores_type}" == "object" ]]; then
            local invalid_values
            invalid_values=$(jq -r '.sub_scores | to_entries[] | select(.value != null and (.value | type) != "number") | .key' "${result_file}" 2>/dev/null)
            if [[ -n "${invalid_values}" ]]; then
                err "sub_scores contains non-numeric values for keys: ${invalid_values}"
                exit 1
            fi
            local sub_scores_count
            sub_scores_count=$(jq '.sub_scores | length' "${result_file}" 2>/dev/null)
            ok "sub_scores is a valid object (${sub_scores_count} dimension(s))."
        elif [[ "${sub_scores_type}" != "null" ]]; then
            err "sub_scores must be an object or null (got ${sub_scores_type})"
            exit 1
        fi
    fi
}

main() {
    resolve_settings_path || true
    echo "=== self-improve validate.sh ==="
    if [[ -n "${SETTINGS}" ]]; then
        echo "Settings: ${SETTINGS}"
    fi
    check_sealed_files

    if [[ ${#POSITIONAL_ARGS[@]} -ge 1 ]]; then
        check_plan_schema "${POSITIONAL_ARGS[0]}"
    fi

    if [[ ${#POSITIONAL_ARGS[@]} -ge 2 ]]; then
        check_result_schema "${POSITIONAL_ARGS[1]}"
    fi

    echo "=== All checks passed ==="
}

main
