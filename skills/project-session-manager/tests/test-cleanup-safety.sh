#!/usr/bin/env bash
# Isolated adapters only: fake Git never removes a directory or runs a provider.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/worktree.sh"
source "$SCRIPT_DIR/../lib/session.sh"
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/omc-psm-cleanup.XXXXXXXX")
trap 'case "$ROOT" in */omc-psm-cleanup.*) command rm -rf -- "$ROOT" ;; esac' EXIT
mkdir -p "$ROOT/source/.git/worktrees/owned" "$ROOT/worktrees/owned"
mkdir -p "$ROOT/foreign"
printf 'gitdir: fixture\n' > "$ROOT/worktrees/owned/.git"
REPO="$ROOT/source"; WORKTREE="$ROOT/worktrees/owned"; PRIVATE="$REPO/.git/worktrees/owned"
PSM_SESSIONS="$ROOT/sessions.json"
printf '{"sessions":{},"stats":{"total_created":0,"total_cleaned":0}}\n' > "$PSM_SESSIONS"
TRACE="$ROOT/trace"; : > "$TRACE"
psm_get_worktree_root() { printf '%s\n' "$ROOT/worktrees"; }
psm_with_lock() { "$@"; }
git() {
    printf 'git %s\n' "$*" >> "$TRACE"
    if [[ "${1:-}" == '-C' ]]; then local directory="$2"; shift 2; else local directory="$PWD"; fi
    case "$*" in
        'rev-parse --path-format=absolute --git-common-dir')
            if [[ "${SCENARIO:-}" == foreign && "$directory" == "$WORKTREE" ]]; then echo "$ROOT/foreign"; return; fi
            printf '%s\n' "$REPO/.git" ;;
        'rev-parse --absolute-git-dir') printf '%s\n' "$PRIVATE" ;;
        'rev-parse --show-toplevel') printf '%s\n' "$WORKTREE" ;;
        'symbolic-ref --quiet --short HEAD') [[ "${SCENARIO:-}" == branch_mismatch ]] && echo foreign-topic || echo topic ;;
        'rev-parse --verify HEAD'|'rev-parse HEAD') printf '%040d\n' "${TIP:-1}" ;;
        'rev-parse --verify main^{commit}') printf '%040d\n' 2 ;;
        'hash-object --stdin') sha1sum | cut -d' ' -f1 ;;
        'worktree list --porcelain')
            printf 'worktree %s\n\n' "$REPO"
            [[ "${SCENARIO:-}" != unregistered ]] || return 0
            printf 'worktree %s\n' "$WORKTREE"
            [[ "${SCENARIO:-}" != locked ]] || echo 'locked fixture' ;;
        'status --porcelain'|'status --porcelain --untracked-files=all --ignored')
            [[ "${SCENARIO:-}" != status_error ]] || return 2
            [[ "${SCENARIO:-}" != dirty ]] || echo ' M dirty.txt'
            [[ "${SCENARIO:-}" != untracked ]] || echo '?? new.txt'
            [[ "${SCENARIO:-}" != ignored ]] || echo '!! .env' ;;
        'merge-base --is-ancestor '*)
            [[ "${SCENARIO:-}" != merge_error ]] || return 2
            [[ "${SCENARIO:-}" != unmerged ]] ;;
        'rev-parse --verify refs/tags/psm-archive/demo^{commit}') printf '%040d\n' "${TIP:-1}" ;;
        'worktree remove '*)
            [[ "${SCENARIO:-}" != remove_error ]] || return 1
            : > "$ROOT/removed" ;;
        *) echo "unexpected fake Git command: $*" >&2; return 2 ;;
    esac
}
tmux() {
    case "${SCENARIO:-}" in
        active) echo psm_demo ;;
        tmux_error) echo 'unknown tmux failure' >&2; return 1 ;;
        tmux_empty) return 0 ;;
        *) echo another-session ;;
    esac
}

fail() { echo "FAIL: $*" >&2; exit 1; }
assert_no_remove() { [[ ! -e "$ROOT/removed" ]] || fail 'unexpected removal'; }

# The new owner must come from actual new registration, not an injected record.
if psm_remove_worktree "$REPO" "$WORKTREE" '{}'; then fail 'unowned legacy worktree accepted'; fi
assert_no_remove
_psm_add_session_impl 'demo:feature' feature demo feature topic main psm_demo "$WORKTREE" "$REPO" '{}'
jq -e '.sessions["demo:feature"].cleanup_owner.token | length > 0' "$PSM_SESSIONS" >/dev/null || fail 'new session lacks owner'
[[ -f "$PRIVATE/psm-owner.json" ]] || fail 'private owner missing'
[[ ! -e "$WORKTREE/psm-owner.json" ]] || fail 'owner polluted worktree'
SESSION=$(psm_get_session 'demo:feature')
for SCENARIO in dirty untracked ignored status_error active tmux_error tmux_empty foreign branch_mismatch unregistered locked unmerged remove_error; do
    export SCENARIO
    if psm_remove_worktree "$REPO" "$WORKTREE" "$SESSION"; then fail "$SCENARIO was accepted"; fi
    assert_no_remove
done
SCENARIO=clean; export SCENARIO
pushd "$WORKTREE" >/dev/null
if psm_remove_worktree "$REPO" "$WORKTREE" "$SESSION"; then fail 'current worktree removed'; fi
popd >/dev/null
if psm_remove_worktree "$REPO" "$REPO" "$SESSION"; then fail 'main checkout removed'; fi
mkdir -p "$ROOT/outside"; printf 'gitdir: fixture\n' > "$ROOT/outside/.git"
if psm_remove_worktree "$REPO" "$ROOT/outside" "$SESSION"; then fail 'outside-root path removed'; fi
ln -s "$WORKTREE" "$ROOT/worktrees/link" 2>/dev/null || true
if [[ -L "$ROOT/worktrees/link" ]]; then
    if psm_remove_worktree "$REPO" "$ROOT/worktrees/link" "$SESSION"; then fail 'symlink path accepted'; fi
else
    echo 'NOTE: native symlink fixture unavailable on this host'
fi
assert_no_remove
cp "$PRIVATE/psm-owner.json" "$ROOT/saved-owner.json"
printf '{}\n' > "$PRIVATE/psm-owner.json"
if psm_remove_worktree "$REPO" "$WORKTREE" "$SESSION"; then fail 'owner mismatch accepted'; fi
cp "$ROOT/saved-owner.json" "$PRIVATE/psm-owner.json"
before_registry=$(cat "$PSM_SESSIONS")
jq '.sessions["demo:feature"].state="changed-during-cleanup"' "$PSM_SESSIONS" > "$ROOT/changed.json"
command mv "$ROOT/changed.json" "$PSM_SESSIONS"
if psm_remove_worktree "$REPO" "$WORKTREE" "$SESSION"; then fail 'changed registry snapshot accepted'; fi
printf '%s\n' "$before_registry" > "$PSM_SESSIONS"
if _psm_add_session_impl 'demo:feature' feature demo feature topic main psm_demo "$WORKTREE" "$REPO" '{}'; then fail 'old owner was overwritten'; fi
[[ "$(cat "$PSM_SESSIONS")" == "$before_registry" ]] || fail 'duplicate creation rewrote registry'
if _psm_add_session_impl 'demo:other' feature demo feature topic main psm_demo "$WORKTREE" "$REPO" '{}'; then fail 'existing private owner overwritten'; fi
[[ "$(cat "$PSM_SESSIONS")" == "$before_registry" ]] || fail 'owner collision rewrote registry'
if _psm_remove_session_impl 'demo:feature' 'not-the-owner'; then fail 'concurrently replaced record deleted'; fi
[[ "$(cat "$PSM_SESSIONS")" == "$before_registry" ]] || fail 'owner mismatch altered registry'
changed_session=$(jq -c '.tmux="another-session"' <<< "$SESSION")
if psm_remove_worktree "$REPO" "$WORKTREE" "$changed_session"; then fail 'unowned tmux name accepted'; fi

# A failed registry commit leaves an unregistered owner/tree; it grants no cleanup.
saved_worktree="$WORKTREE"; saved_private="$PRIVATE"
WORKTREE="$ROOT/worktrees/orphan"; PRIVATE="$REPO/.git/worktrees/orphan"
mkdir -p "$WORKTREE" "$PRIVATE"; printf 'gitdir: fixture\n' > "$WORKTREE/.git"
mv() { return 1; }
if _psm_add_session_impl 'demo:orphan' feature demo feature topic main psm_demo "$WORKTREE" "$REPO" '{}'; then fail 'failed registry save reported success'; fi
unset -f mv
[[ -d "$WORKTREE" && -f "$PRIVATE/psm-owner.json" ]] || fail 'failed registration deleted worktree/owner'
[[ "$(cat "$PSM_SESSIONS")" == "$before_registry" ]] || fail 'failed registry write changed original'
WORKTREE="$saved_worktree"; PRIVATE="$saved_private"
archived_session=$(jq -c '.metadata={cleanup_archive_confirmed:true,cleanup_archive_ref:"refs/tags/psm-archive/demo"}' <<< "$SESSION")
jq --argjson session "$archived_session" '.sessions["demo:feature"]=$session' "$PSM_SESSIONS" > "$ROOT/changed.json"
command mv "$ROOT/changed.json" "$PSM_SESSIONS"
SCENARIO=merge_error; export SCENARIO
if psm_remove_worktree "$REPO" "$WORKTREE" "$archived_session"; then fail 'archive bypassed failed Git merge probe'; fi
assert_no_remove
SCENARIO=unmerged; export SCENARIO
psm_remove_worktree "$REPO" "$WORKTREE" "$archived_session" || fail 'explicit exact-tip archive refused'
[[ -e "$ROOT/removed" ]] || fail 'archive positive did not invoke Git removal'
command rm -f -- "$ROOT/removed"
printf '%s\n' "$before_registry" > "$PSM_SESSIONS"
SCENARIO=clean; export SCENARIO
TIP=2; export TIP  # A legitimate commit after creation must not invalidate ownership.
registered_source=$(jq -er '.source_repo' <<< "$SESSION")
registered_path=$(jq -er '.worktree' <<< "$SESSION")
psm_remove_worktree "$registered_source" "$registered_path" "$SESSION" || fail 'registered-path roundtrip clean removal refused'
[[ -e "$ROOT/removed" ]] || fail 'positive control did not call Git removal'
if grep -q -- '--force' "$TRACE"; then fail 'force removal was used'; fi
owner_token=$(jq -er '.cleanup_owner.token' <<< "$SESSION")
_psm_remove_session_impl 'demo:feature' "$owner_token" || fail 'matching owner registry removal failed'
jq -e '(.sessions | has("demo:feature") | not) and .stats.total_cleaned==1' "$PSM_SESSIONS" >/dev/null || fail 'registry positive control wrong'
echo 'PASS: new owner creation, preservation guards, failed registration, advanced-HEAD non-force positive control'

# Exercise the actual caller with a failing helper, including conditional contexts
# where Bash deliberately disables errexit inside the called function.
eval "$(sed -n '/^cmd_kill() {$/,/^}$/p' "$SCRIPT_DIR/../psm.sh")"
log_info() { :; }; log_warn() { :; }; log_error() { :; }; log_success() { :; }
psm_get_session() { printf '%s\n' "$SESSION"; }
psm_current_tmux_session() { printf '%s\n' "${CURRENT_SESSION:-}"; }
psm_kill_tmux_session() { echo stop >> "$TRACE"; }
psm_remove_worktree() { echo remove-attempt >> "$TRACE"; return 1; }
psm_remove_session() { echo registry-delete >> "$TRACE"; }
: > "$TRACE"
if cmd_kill 'demo:feature'; then fail 'caller reported failed removal as success'; fi
if grep -q registry-delete "$TRACE"; then fail 'caller deleted registry on removal failure'; fi
echo 'PASS: failed removal preserves registry in conditional caller context'
: > "$TRACE"
if cmd_kill 'demo:feature' false; then fail 'automatic failed removal reported success'; fi
if grep -q stop "$TRACE"; then fail 'automatic cleanup stopped active session'; fi
CURRENT_SESSION=psm_demo; TMUX=fixture; export TMUX
: > "$TRACE"
if cmd_kill 'demo:feature'; then fail 'current session accepted'; fi
if grep -q stop "$TRACE"; then fail 'current session was stopped'; fi
unset TMUX
echo 'PASS: automatic cleanup never stops sessions; explicit current session retained'

eval "$(sed -n '/^cmd_cleanup() {$/,/^}$/p' "$SCRIPT_DIR/../psm.sh")"
psm_get_review_sessions() { echo 'demo:feature|42|demo'; }
psm_get_fix_sessions() { :; }
psm_get_project() { echo 'owner/repo|unused'; }
provider_github_available() { return 0; }
provider_call() { return 0; }
log_success() { echo "success: $*" >> "$TRACE"; }
: > "$TRACE"
cmd_cleanup
if grep -Eq 'registry-delete|^stop$|removed [1-9]' "$TRACE"; then fail 'cleanup counted or stopped a retained candidate'; fi
psm_remove_worktree() { echo remove-ok >> "$TRACE"; return 0; }
: > "$TRACE"
cmd_cleanup
grep -q 'removed 1 session' "$TRACE" || fail 'cleanup positive control not counted'
[[ "$(grep -E 'remove-ok|registry-delete' "$TRACE" | paste -sd, -)" == 'remove-ok,registry-delete' ]] || fail 'registry success order wrong'
echo 'PASS: automatic cleanup counts only successful checked Git removals'
