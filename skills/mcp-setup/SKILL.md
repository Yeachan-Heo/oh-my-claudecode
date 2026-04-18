---
name: mcp-setup
description: Configure popular MCP servers for enhanced agent capabilities
level: 2
---

# MCP Setup

Configure Model Context Protocol (MCP) servers to extend Claude Code's capabilities with external tools like web search, file system access, and GitHub integration.

## Overview

MCP servers provide additional tools that Claude Code agents can use. This skill helps you configure popular MCP servers using the `claude mcp add` command-line interface.

## Step 1: Choose a Setup Path

Use **AskUserQuestion** with **one question at a time** and **no more than 3 options per question**. Recent Claude Code builds reject larger option payloads as invalid tool parameters, so keep the MCP selection flow staged.

### Step 1.1: First menu

**Question:** "What kind of MCP setup would you like?"

**Options:**
1. **Recommended starter setup** - Fast path for the most common OMC MCP additions
2. **Individual popular server** - Pick one built-in server from a short follow-up menu
3. **Custom server** - Add your own stdio or HTTP MCP server

### Step 1.2: If the user chooses "Recommended starter setup"

Ask a follow-up **AskUserQuestion**:

**Question:** "Which recommended MCP bundle should I configure?"

**Options:**
1. **Ref only (Recommended)** - Documentation/context server (requires Ref API key)
2. **Ref + Linkup** - Docs/context plus enhanced web search
3. **Full recommended bundle** - Ref, Linkup, Filesystem, and GitHub

Map that choice to the server list you will configure.

### Step 1.3: If the user chooses "Individual popular server"

Ask a follow-up **AskUserQuestion**:

**Question:** "Which server should I configure first?"

**Options:**
1. **Ref (Recommended)** - Documentation and code context from popular libraries
2. **Linkup Web Search** - Enhanced web search (replaces built-in websearch)
3. **More server choices** - Filesystem, GitHub, or the full recommended bundle

If the user chooses **More server choices**, ask one more **AskUserQuestion**:

**Question:** "Which additional MCP option do you want?"

**Options:**
1. **Filesystem (Recommended)** - Extended file system access with additional capabilities
2. **GitHub** - GitHub API integration for issues, PRs, and repository management
3. **Full recommended bundle** - Configure Ref, Linkup, Filesystem, and GitHub together

### Step 1.4: If the user chooses "Custom server"

Skip directly to the **Custom MCP Server** section below.

## Step 2: Gather Required Information

### For Ref:
Ask for API key:
```
Do you have a Ref API key?
- Get one at: https://ref.tools
- Enter your Ref API key, or type 'skip' to configure later
```

### For Linkup Web Search:
Ask for API key:
```
Do you have a Linkup API key?
- Get one at: https://app.linkup.so
- Enter your Linkup API key, or type 'skip' to configure later
```

### For Filesystem:
Ask for allowed directories:
```
Which directories should the filesystem MCP have access to?
Default: Current working directory
Enter comma-separated paths, or press Enter for default
```

### For GitHub:
Ask for token:
```
Do you have a GitHub Personal Access Token?
- Create one at: https://github.com/settings/tokens
- Recommended scopes: repo, read:org
- Enter your token, or type 'skip' to configure later
```

## Step 3: Add MCP Servers Using CLI

Use the `claude mcp add` command to configure each MCP server. The CLI automatically handles settings.json updates and merging.

### Ref Configuration:
```bash
claude mcp add -e REF_API_KEY=<YOUR_REF_API_KEY> ref -- npx -y ref-tools-mcp@latest
```

### Linkup Web Search Configuration:
```bash
claude mcp add linkup -- npx -y linkup-mcp-server apiKey=<YOUR_LINKUP_API_KEY>
```

### Filesystem Configuration:
```bash
claude mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem <allowed-directories>
```

### GitHub Configuration:

**Option 1: Docker (local)**
```bash
claude mcp add -e GITHUB_PERSONAL_ACCESS_TOKEN=<user-provided-token> github -- docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server
```

**Option 2: HTTP (remote)**
```bash
claude mcp add --transport http github https://api.githubcopilot.com/mcp/
```

> Note: Docker option requires Docker installed. HTTP option is simpler but may have different capabilities.

## Step 4: Verify Installation

After configuration, verify the MCP servers are properly set up:

```bash
# List configured MCP servers
claude mcp list
```

This will display all configured MCP servers and their status.

## Step 5: Show Completion Message

```
MCP Server Configuration Complete!

CONFIGURED SERVERS:
[List the servers that were configured]

NEXT STEPS:
1. Restart Claude Code for changes to take effect
2. The configured MCP tools will be available to all agents
3. Run `claude mcp list` to verify configuration

USAGE TIPS:
- Ref: Ask about library documentation (e.g., "How do I use React hooks?")
- Linkup: Use for web searches (e.g., "Search the web for latest TypeScript features")
- Filesystem: Extended file operations beyond the working directory
- GitHub: Interact with GitHub repos, issues, and PRs

TROUBLESHOOTING:
- If MCP servers don't appear, run `claude mcp list` to check status
- Ensure you have Node.js 18+ installed for npx-based servers
- For GitHub Docker option, ensure Docker is installed and running
- Run /oh-my-claudecode:omc-doctor to diagnose issues

MANAGING MCP SERVERS:
- Add more servers: /oh-my-claudecode:mcp-setup or `claude mcp add ...`
- List servers: `claude mcp list`
- Remove a server: `claude mcp remove <server-name>`
```

## Custom MCP Server

If user selects "Custom":

Ask for:
1. Server name (identifier)
2. Transport type: `stdio` (default) or `http`
3. For stdio: Command and arguments (e.g., `npx my-mcp-server`)
4. For http: URL (e.g., `https://example.com/mcp`)
5. Environment variables (optional, key=value pairs)
6. HTTP headers (optional, for http transport only)

Then construct and run the appropriate `claude mcp add` command:

**For stdio servers:**
```bash
# Without environment variables
claude mcp add <server-name> -- <command> [args...]

# With environment variables
claude mcp add -e KEY1=value1 -e KEY2=value2 <server-name> -- <command> [args...]
```

**For HTTP servers:**
```bash
# Basic HTTP server
claude mcp add --transport http <server-name> <url>

# HTTP server with headers
claude mcp add --transport http --header "Authorization: Bearer <token>" <server-name> <url>
```

### Company-context convention

If the custom server is meant to provide organization-specific reference material to OMC workflows, prefer a single tool named `get_company_context` that returns markdown via `{ context: string }`.

Example local registration:

```bash
claude mcp add company-context -- node examples/vendor-mcp-server/server.mjs
```

Then point OMC at the full tool name in `.claude/omc.jsonc` or `~/.config/claude-omc/config.jsonc`:

```jsonc
{
  "companyContext": {
    "tool": "mcp__company-context__get_company_context",
    "onError": "warn"
  }
}
```

This remains advisory prompt context, not runtime enforcement.

## Common Issues

### MCP Server Not Loading
- Ensure Node.js 18+ is installed
- Check that npx is available in PATH
- Run `claude mcp list` to verify server status
- Check server logs for errors

### API Key Issues
- Ref: Verify key at https://ref.tools
- Linkup: Verify key at https://app.linkup.so
- GitHub: Ensure token has required scopes (repo, read:org)
- Re-run `claude mcp add` with correct credentials if needed

### Agents Still Using Built-in Tools
- Restart Claude Code after configuration
- The built-in websearch will be deprioritized when linkup is configured
- Run `claude mcp list` to confirm servers are active

### Removing or Updating a Server
- Remove: `claude mcp remove <server-name>`
- Update: Remove the old server, then add it again with new configuration
