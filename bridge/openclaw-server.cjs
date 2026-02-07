
// Resolve global npm modules for native package imports
try {
  var _cp = require('child_process');
  var _Module = require('module');
  var _globalRoot = _cp.execSync('npm root -g', { encoding: 'utf8', timeout: 5000 }).trim();
  if (_globalRoot) {
    process.env.NODE_PATH = _globalRoot + (process.env.NODE_PATH ? ':' + process.env.NODE_PATH : '');
    _Module._initPaths();
  }
} catch (_e) { /* npm not available - native modules will gracefully degrade */ }

"use strict";

// src/mcp/openclaw-core.ts
var import_child_process = require("child_process");
var import_fs = require("fs");
var import_path = require("path");
var OPENCLAW_DEFAULT_MODEL = process.env.OMC_OPENCLAW_DEFAULT_MODEL || "anthropic/claude-sonnet-4-5";
var OPENCLAW_TIMEOUT = parseInt(process.env.OMC_OPENCLAW_TIMEOUT || "300000", 10);
var openclawCliPath = null;
var detectionAttempted = false;
function detectOpenclawCli() {
  if (detectionAttempted) {
    return openclawCliPath;
  }
  detectionAttempted = true;
  try {
    const result = (0, import_child_process.execSync)("which openclaw 2>/dev/null || where openclaw 2>nul", {
      encoding: "utf-8",
      timeout: 5e3
    }).trim();
    if (result) {
      openclawCliPath = result.split("\n")[0].trim();
      console.log(`[openclaw-core] Found OpenClaw CLI at: ${openclawCliPath}`);
      return openclawCliPath;
    }
  } catch {
  }
  const commonPaths = [
    "/usr/local/bin/openclaw",
    "/home/claw/.npm-global/bin/openclaw",
    process.env.HOME ? (0, import_path.join)(process.env.HOME, ".npm-global/bin/openclaw") : null
  ].filter(Boolean);
  for (const path of commonPaths) {
    if ((0, import_fs.existsSync)(path)) {
      openclawCliPath = path;
      console.log(`[openclaw-core] Found OpenClaw CLI at: ${openclawCliPath}`);
      return openclawCliPath;
    }
  }
  console.log("[openclaw-core] OpenClaw CLI not found");
  return null;
}
async function isGatewayRunning() {
  try {
    const cli = detectOpenclawCli();
    if (!cli) return false;
    const result = (0, import_child_process.execSync)(`${cli} status 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 5e3
    });
    return result.includes("running") || result.includes("connected");
  } catch {
    return false;
  }
}
async function spawnOpenclawAgent(options) {
  const cli = detectOpenclawCli();
  if (!cli) {
    return {
      success: false,
      error: "OpenClaw CLI not found. Install with: npm install -g openclaw"
    };
  }
  const model = options.model || OPENCLAW_DEFAULT_MODEL;
  const timeout = options.timeoutSeconds || Math.floor(OPENCLAW_TIMEOUT / 1e3);
  return new Promise((resolve) => {
    const args = [
      "sessions",
      "spawn",
      "--task",
      options.task,
      "--model",
      model,
      "--timeout",
      timeout.toString()
    ];
    if (options.label) {
      args.push("--label", options.label);
    }
    if (options.agentId) {
      args.push("--agent-id", options.agentId);
    }
    const child = (0, import_child_process.spawn)(cli, args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: OPENCLAW_TIMEOUT
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("close", (code) => {
      if (code === 0) {
        try {
          const result = JSON.parse(stdout);
          resolve({
            success: true,
            result: result.output || result.message || stdout,
            sessionKey: result.sessionKey
          });
        } catch {
          resolve({
            success: true,
            result: stdout.trim()
          });
        }
      } else {
        resolve({
          success: false,
          error: stderr || `Process exited with code ${code}`
        });
      }
    });
    child.on("error", (err) => {
      resolve({
        success: false,
        error: err.message
      });
    });
  });
}
async function sendToSession(sessionKey, message) {
  const cli = detectOpenclawCli();
  if (!cli) {
    return {
      success: false,
      error: "OpenClaw CLI not found"
    };
  }
  return new Promise((resolve) => {
    const child = (0, import_child_process.spawn)(cli, [
      "sessions",
      "send",
      "--session-key",
      sessionKey,
      "--message",
      message
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 6e4
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ success: true, result: stdout.trim() });
      } else {
        resolve({ success: false, error: stderr || stdout });
      }
    });
    child.on("error", (err) => {
      resolve({ success: false, error: err.message });
    });
  });
}
function getOpenclawInfo() {
  const cli = detectOpenclawCli();
  let version = null;
  if (cli) {
    try {
      version = (0, import_child_process.execSync)(`${cli} --version 2>/dev/null`, {
        encoding: "utf-8",
        timeout: 5e3
      }).trim();
    } catch {
    }
  }
  return {
    installed: cli !== null,
    cliPath: cli,
    version
  };
}

// src/mcp/openclaw-standalone-server.ts
var buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let boundary = buffer.indexOf("\\n");
  while (boundary !== -1) {
    const message = buffer.substring(0, boundary);
    buffer = buffer.substring(boundary + 1);
    if (message) {
      handleMessage(message);
    }
    boundary = buffer.indexOf("\\n");
  }
});
async function handleMessage(message) {
  try {
    const { id, command, payload } = JSON.parse(message);
    let result;
    switch (command) {
      case "detect":
        result = detectOpenclawCli();
        break;
      case "info":
        result = getOpenclawInfo();
        break;
      case "isGatewayRunning":
        result = await isGatewayRunning();
        break;
      case "spawn":
        result = await spawnOpenclawAgent(payload);
        break;
      case "send":
        result = await sendToSession(payload.sessionKey, payload.message);
        break;
      default:
        result = { success: false, error: `Unknown command: ${command}` };
    }
    sendResponse(id, result);
  } catch (error) {
    sendResponse(
      null,
      { success: false, error: `Failed to process message: ${error.message}` }
    );
  }
}
function sendResponse(id, payload) {
  try {
    const response = JSON.stringify({ id, payload });
    process.stdout.write(response + "\\n");
  } catch (error) {
    const errorResponse = JSON.stringify({
      id,
      payload: { success: false, error: `Failed to serialize response: ${error.message}` }
    });
    process.stdout.write(errorResponse + "\\n");
  }
}
detectOpenclawCli();
sendResponse("ready", { status: "ready" });
