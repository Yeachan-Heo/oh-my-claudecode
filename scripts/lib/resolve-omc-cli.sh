#!/usr/bin/env bash
# Resolves how to invoke the omc CLI. Echoes either a single command or
# "node <absolute-path-to-cli.cjs>". Exits non-zero with a clear error if
# neither is reachable.
#
# Entry-point priority:
#   1. `omc` on PATH (post `npm i -g`)
#   2. `bridge/cli.cjs` under the active plugin root — this is the CANONICAL
#      bin entry per package.json:bin. It's a self-contained esbuild bundle
#      (~2.9 MB) and the actual binary `omc` resolves to. Preferred over
#      dist/cli/index.js because (a) it's what the published npm package's
#      bin field points at, (b) it's bundled so it works without the rest
#      of dist/ tree, (c) it's shipped under both `bridge` and explicit
#      `bridge/cli.cjs` in package.json:files.
#   3. `dist/cli/index.js` as a secondary fallback — this is the TypeScript
#      compiler output (~56 KB) with external imports resolved from dist/.
#      It works only if the full dist/ tree is present.
#
resolve_omc_cli() {
  # 1. Prefer PATH
  if command -v omc >/dev/null 2>&1; then
    echo "omc"
    return 0
  fi

  local script_dir plugin_root
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  # BASH_SOURCE is the caller's path, so this lib file lives under scripts/lib/.
  # Plugin root is scripts/.. (consistent with setup-claude-md.sh:14-15).
  plugin_root="$(cd "${script_dir}/../.." && pwd)"

  # 2. Prefer bridge/cli.cjs (canonical bin entry per package.json:bin)
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/bridge/cli.cjs" ]; then
    echo "node ${CLAUDE_PLUGIN_ROOT}/bridge/cli.cjs"
    return 0
  fi
  if [ -f "${plugin_root}/bridge/cli.cjs" ]; then
    echo "node ${plugin_root}/bridge/cli.cjs"
    return 0
  fi

  # 3. Fall back to dist/cli/index.js if bridge/cli.cjs is missing
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" ]; then
    echo "node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js"
    return 0
  fi
  if [ -f "${plugin_root}/dist/cli/index.js" ]; then
    echo "node ${plugin_root}/dist/cli/index.js"
    return 0
  fi

  echo "ERROR: cannot locate omc CLI (not on PATH, no bridge/cli.cjs or dist/cli/index.js in plugin root)" >&2
  echo "Install with: npm install -g oh-my-claude-sisyphus" >&2
  return 1
}
