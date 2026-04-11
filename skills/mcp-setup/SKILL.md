---
name: mcp-setup
description: Configure popular MCP servers for enhanced agent capabilities
level: 2
---

# MCP Setup

Configure Model Context Protocol (MCP) servers to extend Claude Code's
capabilities with external tools like web search, file system access,
and GitHub integration.

This skill is a **thin wrapper around `omc setup --mcp-only`**. It
collects server choices and credentials via AskUserQuestion, writes them
to a temporary answers JSON file, asks the CLI to materialize a preset,
then executes the preset. All server registration, credential
validation, and `claude mcp add` invocation is done by the TypeScript
CLI — **do not reimplement it here**.

**When this skill is invoked, immediately execute the workflow below.**

## Step 1: Choose Servers

Use AskUserQuestion:

**Question:** "Which MCP server(s) would you like to configure?"

**Options:**
1. **Context7** — Documentation and code context from popular libraries
2. **Exa Web Search** — Enhanced web search (requires an Exa API key)
3. **Filesystem** — Extended file system access
4. **GitHub** — GitHub API integration (issues, PRs, repos)
5. **All of the above** — Configure all four
6. **Custom** — Add a custom MCP server

Record the selection as `selectedServers`. Every AskUserQuestion call
MUST have ≥2 options — do not collapse this into a single-option
question.

## Step 2: Collect Per-Server Credentials

Walk through the selected servers in order. For each one, use
AskUserQuestion to collect whatever the server needs. Do **not** run
`claude mcp add` yourself — just store the answers.

### Context7
No credentials needed. Nothing to collect.

### Exa Web Search

**Question:** "Do you have an Exa API key? (Get one at https://exa.ai)"

**Options:**
1. **I have a key** — Enter the API key via the "Other" free-text option.
2. **Skip for now** — Drop Exa from the selection.

### Filesystem

**Question:** "Which directories should the filesystem MCP have access to?"

**Options:**
1. **Current working directory (Recommended)**
2. **Home directory**
3. **Custom paths** — Enter comma-separated paths via "Other".

### GitHub

**Question:** "How would you like to configure GitHub MCP?"

**Options:**
1. **HTTP transport (Recommended)** — No token required.
2. **Docker with PAT** — Requires a GitHub Personal Access Token. Ask for the token via a follow-up AskUserQuestion with "Other" free-text.
3. **Skip for now** — Drop GitHub from the selection.

### Custom

Ask for name, transport (`stdio` | `http`), command or URL, optional
environment variables, and optional HTTP headers. Build the
`McpCustomSpec` object described in `src/setup/options.ts`.

## Step 3: Build the Answers File

Shape the collected answers as the `mcp` section of `AnswersFile`
(schema: `src/setup/preset-builder.ts`):

```json
{
  "mcp": {
    "enabled": true,
    "servers": [
      "context7",
      "exa",
      "filesystem",
      "github"
    ],
    "credentials": {
      "exa": "<key>",
      "github": "<token>",
      "filesystem": ["/abs/path/1", "/abs/path/2"]
    },
    "onMissingCredentials": "skip"
  }
}
```

Custom servers are added to `servers` as `{ "name": "...", "spec": { ... } }`
objects rather than plain strings.

Write to a temp file:

```bash
ANSWERS_FILE="$(mktemp -t omc-mcp-answers.XXXXXX.json)"
PRESET_FILE="$(mktemp -t omc-mcp-preset.XXXXXX.json)"
chmod 0600 "$ANSWERS_FILE" "$PRESET_FILE"
# …write the JSON to $ANSWERS_FILE…
```

## Step 4: Build the Preset

```bash
omc setup --mcp-only --build-preset --answers "$ANSWERS_FILE" --out "$PRESET_FILE"
```

Validation failures exit non-zero with a red message on stderr — surface
the error to the user and stop.

## Step 5: Run the Preset

```bash
omc setup --preset "$PRESET_FILE"
```

The CLI runs the `mcp-only` sub-phase, which calls `claude mcp add` for
each selected server with the credentials you collected.

## Step 6: Cleanup

```bash
rm -f "$ANSWERS_FILE" "$PRESET_FILE"
```

Run cleanup on **both** success and failure paths.

## Step 7: Verify Installation

```bash
claude mcp list
```

## Step 8: Show Completion Message

```
MCP Server Configuration Complete!

CONFIGURED SERVERS:
[List the servers that were configured]

NEXT STEPS:
1. Restart Claude Code for changes to take effect
2. The configured MCP tools will be available to all agents
3. Run `claude mcp list` to verify configuration

TROUBLESHOOTING:
- Run `claude mcp list` to check status
- Ensure Node.js 18+ is installed for npx-based servers
- For GitHub Docker option, ensure Docker is installed and running
- Run /oh-my-claudecode:omc-doctor to diagnose issues

MANAGING MCP SERVERS:
- Add more: /oh-my-claudecode:mcp-setup
- List: `claude mcp list`
- Remove: `claude mcp remove <server-name>`
```

## Common Issues

### MCP Server Not Loading
- Ensure Node.js 18+ is installed and `npx` is on PATH.
- Run `claude mcp list` to verify server status.

### API Key Issues
- Exa: Verify key at https://dashboard.exa.ai
- GitHub: Ensure token has required scopes (`repo`, `read:org`)
- Re-run this skill with the correct credentials.

### Agents Still Using Built-in Tools
- Restart Claude Code after configuration.
- The built-in websearch is deprioritized when Exa is configured.
