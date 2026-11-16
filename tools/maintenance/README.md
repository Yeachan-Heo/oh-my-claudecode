# Maintenance tools

Standalone tools run by hand. They do not change OMC behaviour, no hook runs them, and they are not shipped
in the npm package (`tools/` is not in the `files` list of `package.json`). Every tool has `--help`.

- [Settings drift check](#settings-drift-check) (`settings_drift.mjs`)
- [Plugin install smoke test](#plugin-install-smoke-test) (`plugin_install_smoke.sh`)
- [Compaction review](#compaction-review) (`compaction_review.mjs`)

## Settings drift check

`settings_drift.mjs` compares the OMC part of a `settings.json` with a reference template and lists the
differences. It is for people who keep the same OMC settings on several machines. It only reads files.

```
node tools/maintenance/settings_drift.mjs --template <file> [--config-dir <dir>] [--settings <file>] [--machine-specific <KEY>]...
```

| Option | Meaning |
|---|---|
| `--template <file>` | reference template (required) |
| `--config-dir <dir>` | Claude Code configuration directory (default `$CLAUDE_CONFIG_DIR`, else `~/.claude`); `settings.json` is read from it |
| `--settings <file>` | the `settings.json` file itself (wins over `--config-dir`) |
| `--machine-specific <KEY>` | env key whose value belongs to the machine (a path, for example): only its presence is compared and its value is never printed. Repeatable; adds to the template's `machine_specific` list |

Exit codes: `0` no differences, `1` differences found, `2` error (missing file, bad JSON, bad usage).

Template format (JSON; every field is optional):

```json
{
  "env": { "OMC_SHELL_CHECKS": "1" },
  "machine_specific": ["OMC_JEV_LOG_DIR"],
  "modelSettings": { "<model id>": { "autoCompactWindow": 1000000 } },
  "no_top_level_autoCompactWindow": true,
  "forbidden_env": ["CLAUDE_CODE_AUTO_COMPACT_WINDOW"]
}
```

What is compared:

- `env`: every template key must be present with the same value (compared as text). An `OMC_*` key of the settings that is
  not in the template and not machine-specific is a difference.
- `machine_specific`: the key must be present in the settings; the value is not compared and not printed.
- `forbidden_env`: the key must be absent from `env`.
- `modelSettings`: every listed field must have the template value.
- `no_top_level_autoCompactWindow`: when true, the settings must not have a top-level `autoCompactWindow`.

Safety: the tool reads only the `OMC_*` keys of `env`, the keys the template lists, `modelSettings.*.autoCompactWindow`
and the top-level `autoCompactWindow`. It prints no other key. Values of keys with `key`, `token`, `secret` or `passw` in the
name are printed as `<hidden>`.

## Plugin install smoke test

`plugin_install_smoke.sh` installs a plugin directory into a throwaway configuration directory and runs an install,
revert and re-install flow against it, with commands you supply. Use it to check that your install and revert
commands leave the plugin tree exactly as they found it. It never touches a real `~/.claude`.

```
bash tools/maintenance/plugin_install_smoke.sh --plugin-dir <dir> --dry-run-cmd <cmd> --apply-cmd <cmd> --revert-cmd <cmd> [options]
```

| Option | Meaning |
|---|---|
| `--plugin-dir <dir>` | plugin directory to install (required); needs `.claude-plugin/plugin.json` with `name` and `version` |
| `--dry-run-cmd <cmd>` | command of phase 1 (required) |
| `--apply-cmd <cmd>` | command of phases 2 and 4 (required) |
| `--revert-cmd <cmd>` | command of phase 3 (required) |
| `--config-dir <dir>` | throwaway configuration directory; must not exist or be empty (default: a new directory under `$TMPDIR` or `/tmp`) |
| `--settings-from <file>` | `settings.json` to derive the fake settings from; read only (default: none, an empty `env`) |
| `--marketplace <name>` | marketplace part of the plugin key and cache path (default `local`) |
| `--ignore-path <name>` | directory name left out of the tree sums; repeatable (default: none) |
| `--revert-time-limit <sec>` | limit for phase 3 (default 60) |
| `--keep` | keep `<config>/plugins/cache` after the run (the logs are always kept) |

Needs `bash`, `python3`, `sha256sum`, `find`, `xargs` and GNU `date` (for `%N`).

What it does:

1. Copies the plugin directory to `<config>/plugins/cache/<marketplace>/<name>/<version>`, writes a one-entry
   `installed_plugins.json` and a fake `settings.json` (mode 0600). In the fake settings the values of `env` keys other than
   `OMC_*`, `CLAUDE_CODE_*` and `ENABLE_TOOL_SEARCH` are replaced by `FAKE`; `pluginConfigs`, `hooks`, `statusLine` and
   `extraKnownMarketplaces` are empty.
2. Takes the tree sum S0 (sorted sha256 of all files under `<config>/plugins`) and runs the phases: dry run, apply (tree sum S1),
   revert (timed; tree sum S2), apply again (tree sum S3).

The phase commands run with `bash -c` in the work directory. They see `CLAUDE_CONFIG_DIR` (the throwaway
configuration directory), `SMOKE_PLUGIN_DIR` (the installed copy of the plugin) and `SMOKE_WORK_DIR` (the work directory with the
logs `1-dry-run.log` to `4-apply-again.log`).

Result: exit `0` and `SMOKE RESULT: OK` only when all four phases exit 0, the revert took less than the limit, S0 = S2, S0 differs from S1 and
S3 = S1. Exit `1` otherwise, exit `2` on a usage error.

Safety: the script refuses (exit 2) to run when the target configuration directory is the real one, lies inside it or
contains it. The real directories are `${CLAUDE_CONFIG_DIR:-$HOME/.claude}` and `$HOME/.claude`; paths are resolved first, so a symbolic link to
them is caught too. The commands you supply are your own code: they run with your user rights, so keep them pointed at
`$CLAUDE_CONFIG_DIR`.

## Compaction review

`compaction_review.mjs` checks the compaction journal against the session transcripts: after a compaction that kept
thinking blocks in the tail of the messages (`kept_thinking > 0` in the record), did the host answer with API errors (400
among them) or with placeholder tool results? It reads files only.

```
node tools/maintenance/compaction_review.mjs --from <time> [--log <compaction.jsonl>] [--projects <dir>] [--json] [--full]
```

| Option | Meaning |
|---|---|
| `--from <time>` | start of the record window (required): local time such as `2026-01-01T10:00:00`, or ISO with `Z` |
| `--log <file>` | compaction journal (default `$OMC_JEV_LOG_DIR/compaction.jsonl`, else `~/.omc/state/jev/compaction.jsonl`) |
| `--projects <dir>` | transcripts directory (default `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`) |
| `--json` | also print the result as one JSON line |
| `--full` | print every file; by default only files with a record or with an error after the boundary (the rest is in the sums) |

Exit codes: `0` no 400 errors and no placeholder results after the boundaries, `1` at least one, `2` input error.

What it counts. From the journal it takes the `event: compact` records with `kept_thinking > 0` from `--from` on. For every
transcript file (main session `<project>/<session>.jsonl`, agents `<project>/<session>/subagents/agent-<agent>.jsonl`) it counts
the rows after the earliest boundary of a record of that file, or, for the other agents of the session, after the earliest boundary of the
session, and for comparison the rows before the boundary:

- API errors: assistant rows with `isApiErrorMessage` true, or model `<synthetic>` and text starting with `API Error`
  (among them `400`, and of those the ones that mention thinking or invalid), and system rows with an API error;
- placeholder results: user rows with a `tool_result` whose content starts with `[Tool result missing`.

Rows of type `api-request-blob`, `attachment` and `queue-operation` are skipped because they quote text; placeholder results in
request blobs are counted separately, over the whole file, as information. Rows without a timestamp are not counted. The tool prints only
counts, 8-character ids and file names. The transcript layout comes from the host and can change between host versions.
