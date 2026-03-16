---
name: mcp-setup
description: Configure popular MCP servers for enhanced agent capabilities
level: 2
---

# MCP Setup

Configure Model Context Protocol (MCP) servers to extend Claude Code's capabilities with external tools like web search, file system access, and GitHub integration.

## Overview

MCP servers provide additional tools that Claude Code agents can use. This skill helps you configure popular MCP servers using the `claude mcp add` command-line interface.

## Step 1: Show Available MCP Servers

Present the user with available MCP server options using AskUserQuestion:

**Question:** "Which MCP server would you like to configure?"

**Options:**
1. **Context7** - Documentation and code context from popular libraries
2. **Exa Web Search** - Enhanced web search (replaces built-in websearch)
3. **Filesystem** - Extended file system access with additional capabilities
4. **GitHub** - GitHub API integration for issues, PRs, and repository management
5. **All of the above** - Configure all recommended MCP servers
6. **Custom** - Add a custom MCP server

## Step 2: Gather Required Information

### For Context7:
No API key required. Ready to use immediately.

### For Exa Web Search:
Ask for API key:
```
Do you have an Exa API key?
- Get one at: https://exa.ai
- Enter your API key, or type 'skip' to configure later
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

### Context7 Configuration:
```bash
claude mcp add context7 -- npx -y @upstash/context7-mcp
```

### Exa Web Search Configuration:
```bash
claude mcp add -e EXA_API_KEY=<user-provided-key> exa -- npx -y exa-mcp-server
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
- Context7: Ask about library documentation (e.g., "How do I use React hooks?")
- Exa: Use for web searches (e.g., "Search the web for latest TypeScript features")
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

## Common Issues

### MCP Server Not Loading
- Ensure Node.js 18+ is installed
- Check that npx is available in PATH
- Run `claude mcp list` to verify server status
- Check server logs for errors

### API Key Issues
- Exa: Verify key at https://dashboard.exa.ai
- GitHub: Ensure token has required scopes (repo, read:org)
- Re-run `claude mcp add` with correct credentials if needed

### Agents Still Using Built-in Tools
- Restart Claude Code after configuration
- The built-in websearch will be deprioritized when exa is configured
- Run `claude mcp list` to confirm servers are active

### Removing or Updating a Server
- Remove: `claude mcp remove <server-name>`
- Update: Remove the old server, then add it again with new configuration
