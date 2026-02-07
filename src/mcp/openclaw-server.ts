
/**
 * OpenClaw MCP Server - In-process MCP server for OpenClaw integration
 *
 * Exposes `spawn_agent` and `send_to_session` tools via the SDK.
 * Tools will be available as mcp__oc__spawn_agent, etc.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import {
  OPENCLAW_DEFAULT_MODEL,
  spawnOpenclawAgent,
  sendToSession,
  getOpenclawInfo,
  isGatewayRunning
} from './openclaw-core.js';

const spawnAgentTool = tool(
  "spawn_agent",
  "Spawn an OpenClaw sub-agent to perform a task in an isolated, parallel session. Returns immediately with sessionKey.",
  {
    task: { type: "string", description: "The task prompt for the sub-agent." },
    model: { type: "string", description: `Model for the sub-agent (default: ${OPENCLAW_DEFAULT_MODEL}).` },
    label: { type: "string", description: "A descriptive label for the agent session." },
    agent_id: { type: "string", description: "Specific agent ID to use for the spawn." },
    timeout_seconds: { type: "number", description: "Timeout for the entire agent run." },
  } as any,
  async (args: any) => {
    const result = await spawnOpenclawAgent(args);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

const sendMessageTool = tool(
  "send_to_session",
  "Send a message to an existing, active OpenClaw session.",
  {
    session_key: { type: "string", description: "The key of the target session (from spawn_agent)." },
    message: { type: "string", description: "The message to send." },
  } as any,
  async (args: any) => {
    const { session_key, message } = args as { session_key: string; message: string; };
    const result = await sendToSession(session_key, message);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

const getInfoTool = tool(
  "get_info",
  "Get diagnostic information about the OpenClaw installation.",
  {} as any,
  async () => {
    const result = getOpenclawInfo();
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

const isReadyTool = tool(
  "is_ready",
  "Check if the OpenClaw gateway is running and ready to accept commands.",
  {} as any,
  async () => {
    const isReady = await isGatewayRunning();
    const result = {
      is_ready: isReady,
      status: isReady ? 'Gateway is running.' : 'Gateway is not running or not connected.'
    };
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

/**
 * In-process MCP server exposing OpenClaw CLI integration
 */
export const openclawMcpServer = createSdkMcpServer({
  name: "oc",
  version: "1.0.0",
  tools: [spawnAgentTool, sendMessageTool, getInfoTool, isReadyTool]
});

/**
 * Tool names for allowedTools configuration
 */
export const openclawToolNames = ['spawn_agent', 'send_to_session', 'get_info', 'is_ready'];
