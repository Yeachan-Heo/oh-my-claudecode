#!/bin/bash
# plugin_install_smoke.sh --plugin-dir <dir> --dry-run-cmd <cmd> --apply-cmd <cmd> --revert-cmd <cmd> [options]
# Smoke test of an install, revert and re-install flow on a THROWAWAY configuration directory.
#
# Copies a plugin directory into <config>/plugins/cache/<marketplace>/<name>/<version>, writes a one-entry installed_plugins.json
# and a fake settings.json (values outside OMC_*, CLAUDE_CODE_* and ENABLE_TOOL_SEARCH replaced by FAKE, and so are the values
# of keys whose name contains TOKEN, KEY, SECRET or PASSWORD in any case; no hooks, plugin configurations, status line or
# extra marketplaces), then runs four phases with CLAUDE_CONFIG_DIR pointing at the throwaway directory:
#   1. dry run   (--dry-run-cmd)
#   2. apply     (--apply-cmd)
#   3. revert    (--revert-cmd), timed
#   4. apply again (--apply-cmd)
# A tree sum (sorted sha256 of all files under <config>/plugins) is taken before phase 1 (S0), after phase 2 (S1), after phase 3 (S2)
# and after phase 4 (S3). Exit 0 only when all four phases exit 0, the revert took less than --revert-time-limit seconds, S0 = S2,
# S0 differs from S1 and S3 = S1. Exit 1 when the run fails, exit 2 on a usage error.
#
# The phase commands run with `bash -c` in the throwaway work directory and see CLAUDE_CONFIG_DIR (the throwaway configuration
# directory), SMOKE_PLUGIN_DIR (the installed copy of the plugin) and SMOKE_WORK_DIR (the work directory holding the logs).
#
# Options:
#   --plugin-dir <dir>         plugin directory to install (required); needs .claude-plugin/plugin.json with name and version
#   --dry-run-cmd <cmd>        command of phase 1 (required)
#   --apply-cmd <cmd>          command of phases 2 and 4 (required)
#   --revert-cmd <cmd>         command of phase 3 (required)
#   --config-dir <dir>         throwaway configuration directory; must not exist or be empty (default: <work dir>/config)
#   --settings-from <file>     settings.json to derive the fake settings from (read only; default: none, empty env)
#   --marketplace <name>       marketplace part of the plugin key and cache path (default: local)
#   --ignore-path <name>       directory name left out of the tree sums, repeatable (default: none)
#   --revert-time-limit <sec>  limit for phase 3 (default: 60)
#   --keep                     keep <config>/plugins/cache after the run (logs are always kept)
#   -h, --help                 show this help
# The script refuses (exit 2) to run when the target configuration directory is, contains or lies inside the real one
# (${CLAUDE_CONFIG_DIR:-$HOME/.claude} or $HOME/.claude). Without --config-dir the same check is made for the default work
# directory (a directory under ${TMPDIR:-/tmp}). Needs bash, python3, sha256sum, find, xargs and GNU date.
set -uo pipefail

usage() { sed -n '2,/^set -uo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }
die() { echo "ERROR: $*" >&2; exit 2; }

PLUGIN_DIR=""; DRY_CMD=""; APPLY_CMD=""; REVERT_CMD=""; CONFIG_DIR=""; SETTINGS_FROM=""
MARKETPLACE=local; LIMIT=60; KEEP=0; IGNORE=()
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0;;
    --keep) KEEP=1; shift;;
    --plugin-dir|--dry-run-cmd|--apply-cmd|--revert-cmd|--config-dir|--settings-from|--marketplace|--ignore-path|--revert-time-limit)
      [ $# -ge 2 ] || die "missing value for $1"
      case "$1" in
        --plugin-dir) PLUGIN_DIR=$2;;
        --dry-run-cmd) DRY_CMD=$2;;
        --apply-cmd) APPLY_CMD=$2;;
        --revert-cmd) REVERT_CMD=$2;;
        --config-dir) CONFIG_DIR=$2;;
        --settings-from) SETTINGS_FROM=$2;;
        --marketplace) MARKETPLACE=$2;;
        --ignore-path) IGNORE+=("$2");;
        --revert-time-limit) LIMIT=$2;;
      esac
      shift 2;;
    *) die "unknown option $1";;
  esac
done
[ -n "$PLUGIN_DIR" ] || die "--plugin-dir is required"
[ -n "$DRY_CMD" ] || die "--dry-run-cmd is required"
[ -n "$APPLY_CMD" ] || die "--apply-cmd is required"
[ -n "$REVERT_CMD" ] || die "--revert-cmd is required"
[ -d "$PLUGIN_DIR" ] || die "plugin directory not found: $PLUGIN_DIR"
[ -f "$PLUGIN_DIR/.claude-plugin/plugin.json" ] || die "no .claude-plugin/plugin.json in $PLUGIN_DIR"
[ -z "$SETTINGS_FROM" ] || [ -f "$SETTINGS_FROM" ] || die "settings file not found: $SETTINGS_FROM"
python3 -I -c "import sys; sys.exit(0 if float(sys.argv[1]) > 0 else 1)" "$LIMIT" 2>/dev/null || die "--revert-time-limit must be a positive number"

# Refuse the real configuration directory (resolved, so symbolic links are caught too).
REAL_CANDIDATES=("$(realpath -m "${CLAUDE_CONFIG_DIR:-$HOME/.claude}")" "$(realpath -m "$HOME/.claude")")
refuse_real() {
  local target real
  target=$(realpath -m "$1")
  for real in "${REAL_CANDIDATES[@]}"; do
    case "$target/" in "$real"/*) die "refusing to use the real configuration directory (or a path inside it): $2";; esac
    case "$real/" in "$target"/*) die "refusing to use a directory that contains the real configuration directory: $2";; esac
  done
}
if [ -n "$CONFIG_DIR" ]; then
  refuse_real "$CONFIG_DIR" "$CONFIG_DIR"
  if [ -e "$CONFIG_DIR" ] && { [ ! -d "$CONFIG_DIR" ] || [ -n "$(ls -A "$CONFIG_DIR")" ]; }; then die "configuration directory must not exist or be empty: $CONFIG_DIR"; fi
else
  refuse_real "${TMPDIR:-/tmp}/plugin-smoke.XXXXXX/config" "${TMPDIR:-/tmp}"
fi

NAME=$(python3 -I -c "import json,sys; print(json.load(open(sys.argv[1]))['name'])" "$PLUGIN_DIR/.claude-plugin/plugin.json" 2>/dev/null) || die "plugin.json has no readable name"
VERSION=$(python3 -I -c "import json,sys; print(json.load(open(sys.argv[1]))['version'])" "$PLUGIN_DIR/.claude-plugin/plugin.json" 2>/dev/null) || die "plugin.json has no readable version"
T=$(mktemp -d "${TMPDIR:-/tmp}/plugin-smoke.XXXXXX") || die "cannot create the work directory"
chmod 700 "$T"
C=${CONFIG_DIR:-$T/config}
mkdir -p "$C/plugins" || die "cannot create the configuration directory: $C"
C=$(cd "$C" 2>/dev/null && pwd) || die "cannot resolve the configuration directory to an absolute path: $C"
python3 -I - "$PLUGIN_DIR" "$C" "$NAME" "$VERSION" "$MARKETPLACE" "$SETTINGS_FROM" <<'PY' || { echo "ERROR: could not prepare the throwaway configuration" >&2; exit 2; }
import json, os, shutil, sys
src, c, name, version, marketplace, settings_from = sys.argv[1:7]
dst = c + '/plugins/cache/' + marketplace + '/' + name + '/' + version
os.makedirs(os.path.dirname(dst), exist_ok=True)
shutil.copytree(src, dst, symlinks=True)
entry = {'scope': 'user', 'installPath': dst, 'version': version}
json.dump({'version': 2, 'plugins': {name + '@' + marketplace: [entry]}}, open(c + '/plugins/installed_plugins.json', 'w'), indent=2)
s = json.load(open(settings_from)) if settings_from else {}
secret_words = ('TOKEN', 'KEY', 'SECRET', 'PASSWORD')
def keep_value(k):
    if any(w in k.upper() for w in secret_words):
        return False
    return k.startswith('OMC_') or k.startswith('CLAUDE_CODE_') or k == 'ENABLE_TOOL_SEARCH'
s['env'] = {k: (v if keep_value(k) else 'FAKE') for k, v in s.get('env', {}).items()}
for k in ('pluginConfigs', 'hooks', 'statusLine', 'extraKnownMarketplaces'): s[k] = {}
open(c + '/settings.json', 'w').write(json.dumps(s, indent=2, ensure_ascii=False) + '\n'); os.chmod(c + '/settings.json', 0o600)
PY
DST=$C/plugins/cache/$MARKETPLACE/$NAME/$VERSION
echo "smoke run in $T (plugin copy $(du -sh "$C/plugins" | cut -f1))"

treesum() {
  local excl=() p
  for p in "${IGNORE[@]+"${IGNORE[@]}"}"; do excl+=(! -path "*/$p/*"); done
  find "$C/plugins" -type f "${excl[@]+"${excl[@]}"}" -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum | sha256sum | cut -c1-16
}
phase() { ( cd "$T" && CLAUDE_CONFIG_DIR="$C" SMOKE_PLUGIN_DIR="$DST" SMOKE_WORK_DIR="$T" bash -c "$1" ); }

S0=$(treesum)
echo "### 1. dry run"; phase "$DRY_CMD" > "$T/1-dry-run.log" 2>&1; K1=$?; tail -4 "$T/1-dry-run.log"; echo "exit $K1"
echo "### 2. apply"; phase "$APPLY_CMD" > "$T/2-apply.log" 2>&1; K2=$?; tail -6 "$T/2-apply.log"; echo "exit $K2"
S1=$(treesum)
echo "### 3. revert"; W0=$(date +%s.%N); phase "$REVERT_CMD" > "$T/3-revert.log" 2>&1; K3=$?; W1=$(date +%s.%N); tail -8 "$T/3-revert.log"; echo "exit $K3"
S2=$(treesum)
echo "tree sums: before $S0, after apply $S1, after revert $S2"
ELAPSED=$(python3 -I -c "import sys; print(round(float(sys.argv[2]) - float(sys.argv[1]), 1))" "$W0" "$W1")
OK=1; [ "$K1" = 0 ] && [ "$K2" = 0 ] && [ "$K3" = 0 ] || OK=0; [ "$S0" = "$S2" ] && [ "$S0" != "$S1" ] || OK=0; python3 -I -c "import sys; sys.exit(0 if float(sys.argv[1]) < float(sys.argv[2]) else 1)" "$ELAPSED" "$LIMIT" || OK=0
echo "### 4. apply again after the revert"; phase "$APPLY_CMD" > "$T/4-apply-again.log" 2>&1; K4=$?; tail -3 "$T/4-apply-again.log"; echo "exit $K4"; [ "$K4" = 0 ] || OK=0
S3=$(treesum); [ "$S3" = "$S1" ] || { echo "sum after the second apply $S3 differs from $S1"; OK=0; }
echo "SMOKE RESULT: $([ "$OK" = 1 ] && echo OK || echo FAILED); revert ${ELAPSED} s; logs in $T"
[ "$KEEP" = 1 ] || rm -rf "$C/plugins/cache"
[ "$OK" = 1 ] || exit 1
