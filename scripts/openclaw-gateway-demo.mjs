#!/usr/bin/env node
/**
 * OpenClaw Gateway Demo
 *
 * A minimal HTTP gateway that receives OpenClaw payloads and wakes
 * a clawdbot agent session via /hooks/agent. The agent processes the
 * instruction and delivers its response to the configured Discord channel.
 *
 * Usage:
 *   node scripts/openclaw-gateway-demo.mjs [--port 19876]
 *
 * Environment:
 *   CLAWDBOT_GATEWAY_URL   - Clawdbot gateway base URL (default: http://127.0.0.1:18789)
 *   CLAWDBOT_HOOKS_TOKEN   - Hooks auth token (required)
 *   OPENCLAW_GATEWAY_PORT  - Port to listen on (default: 19876)
 *   OPENCLAW_DISCORD_CHANNEL - Discord channel ID for delivery (default: #omc-dev)
 */

import { createServer } from "node:http";

// Parse args
const args = process.argv.slice(2);
function getArg(name, env, fallback) {
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return process.env[env] || fallback;
}

const PORT = Number(getArg("--port", "OPENCLAW_GATEWAY_PORT", "19876"));
const CLAWDBOT_URL = getArg("--clawdbot-url", "CLAWDBOT_GATEWAY_URL", "http://127.0.0.1:18789");
const HOOKS_TOKEN = process.env.CLAWDBOT_HOOKS_TOKEN;
const CHANNEL_ID = getArg("--channel-id", "OPENCLAW_DISCORD_CHANNEL", "1468539002985644084");

if (!HOOKS_TOKEN) {
  console.error("[openclaw-gateway] CLAWDBOT_HOOKS_TOKEN is required");
  process.exit(1);
}

/**
 * Wake clawdbot agent via /hooks/agent.
 *
 * The agent receives the instruction as its prompt, processes it,
 * and delivers the response to the target Discord channel.
 */
async function wakeClawdbotAgent(payload) {
  const agentPayload = {
    message: buildAgentMessage(payload),
    name: "OpenClaw",
    wakeMode: "now",
    sessionKey: `openclaw:${payload.sessionId || "unknown"}`,
    channel: "discord",
    to: CHANNEL_ID,
    deliver: true,
  };

  const url = `${CLAWDBOT_URL}/hooks/agent`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HOOKS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(agentPayload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Clawdbot hooks ${res.status}: ${text}`);
  }

  return await res.json();
}

/**
 * Build an agent message from the OpenClaw payload.
 *
 * The agent receives this as its prompt and can respond intelligently
 * based on the event type, project context, and instruction.
 */
function buildAgentMessage(payload) {
  const parts = [];
  parts.push(`[OpenClaw Event: ${payload.event}]`);

  if (payload.instruction) {
    parts.push(`Instruction: ${payload.instruction}`);
  }

  if (payload.projectName) {
    parts.push(`Project: ${payload.projectName}`);
  }

  if (payload.sessionId) {
    parts.push(`Session: ${payload.sessionId}`);
  }

  // Add context fields if available
  const ctx = payload.context || {};
  if (ctx.contextSummary) {
    parts.push(`Summary: ${ctx.contextSummary}`);
  }
  if (ctx.reason) {
    parts.push(`Reason: ${ctx.reason}`);
  }
  if (ctx.toolName) {
    parts.push(`Tool: ${ctx.toolName}`);
  }

  parts.push(`Timestamp: ${payload.timestamp || new Date().toISOString()}`);

  parts.push("");
  parts.push("Please acknowledge this OMC session event and provide a brief status update to #omc-dev.");

  return parts.join("\n");
}

/** Read JSON body from request */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, gateway: "openclaw-demo", clawdbot: CLAWDBOT_URL }));
    return;
  }

  // Only accept POST
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method Not Allowed");
    return;
  }

  try {
    const payload = await readBody(req);
    const sid = (payload.sessionId || "unknown").slice(0, 8);
    console.log(`[openclaw-gateway] Received: ${payload.event} from session ${sid}`);

    const result = await wakeClawdbotAgent(payload);
    console.log(`[openclaw-gateway] Woke clawdbot agent (runId: ${result.runId})`);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, runId: result.runId }));
  } catch (err) {
    console.error(`[openclaw-gateway] Error:`, err.message);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[openclaw-gateway] Listening on http://127.0.0.1:${PORT}`);
  console.log(`[openclaw-gateway] Clawdbot: ${CLAWDBOT_URL}/hooks/agent`);
  console.log(`[openclaw-gateway] Target channel: ${CHANNEL_ID}`);
});
