
# OpenClaw Provider

The OpenClaw provider allows `oh-my-claudecode` to delegate tasks to a running OpenClaw instance. This enables complex, multi-step workflows that can run autonomously in the background, leverage OpenClaw's memory and messaging capabilities, and interact with its other integrated services.

## Configuration

This provider is enabled automatically if the `openclaw` CLI is detected in your system's `PATH`. No additional configuration is required.

- **Installation:** `npm install -g openclaw`
- **Homepage:** [https://github.com/openclaw/openclaw](https://github.com/openclaw/openclaw)

## Tools

The OpenClaw provider exposes the following tools under the `mcp__oc__` prefix.

### `spawn_agent`

Spawns a new OpenClaw sub-agent in an isolated session to perform a task. This is the primary tool for delegating work. It runs in the background and returns a `sessionKey` immediately.

**Parameters:**
- `task` (string, required): The prompt or task for the sub-agent.
- `model` (string, optional): The model to use (e.g., 'anthropic/claude-sonnet-4-5'). Defaults to the OpenClaw instance's default.
- `label` (string, optional): A descriptive label for the session.
- `timeout_seconds` (number, optional): A timeout for the entire agent run.

**Example:**
```
<tool_code>
mcp__oc__spawn_agent(
  task="Analyze the attached log file and summarize the errors.",
  label="log-analysis-agent"
)
</tool_code>
```

### `send_to_session`

Sends a message to an already running OpenClaw session, identified by its `sessionKey`.

**Parameters:**
- `session_key` (string, required): The target session key (obtained from `spawn_agent`).
- `message` (string, required): The message to send to the session.

**Example:**
```
<tool_code>
mcp__oc__send_to_session(
  session_key="agent:main:subagent:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  message="Have you finished the analysis? Provide a preliminary report."
)
</tool_code>
```

### `get_info`

Retrieves diagnostic information about the connected OpenClaw instance, including its path and version.

**Example:**
```
<tool_code>
mcp__oc__get_info()
</tool_code>
```

### `is_ready`

Checks if the OpenClaw gateway is running and ready to receive commands.

**Example:**
```
<tool_code>
mcp__oc__is_ready()
</tool_code>
```

## Use Case: Autonomous Development

You can use the OpenClaw provider to offload a complex development task to a fully autonomous agent that can run for hours or days.

1.  **Spawn the agent:**
    ```
    <tool_code>
    mcp__oc__spawn_agent(
      task="Build a full-stack application for managing a personal library. Use Next.js, Tailwind CSS, and a Convex backend. Follow best practices for schema design and component structure. The task is complete when the application is deployed and a live URL is provided.",
      model="anthropic/claude-opus-4-6",
      label="full-stack-library-app-build",
      timeout_seconds=86400
    )
    </tool_code>
    ```

2.  **Monitor progress (optional):**
    You can periodically send messages to the session to get status updates, though the agent will report back upon completion.

This allows OMC to act as a high-level orchestrator, delegating the heavy lifting to a persistent, autonomous agent managed by OpenClaw.
