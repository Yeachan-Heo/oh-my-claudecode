"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/team/runtime-cli.ts
var import_fs4 = require("fs");
var import_promises4 = require("fs/promises");
var import_path6 = require("path");

// src/team/runtime.ts
var import_promises3 = require("fs/promises");
var import_path5 = require("path");
var import_fs3 = require("fs");

// src/team/model-contract.ts
var import_child_process = require("child_process");
var CONTRACTS = {
  claude: {
    agentType: "claude",
    binary: "claude",
    installInstructions: "Install Claude CLI: https://claude.ai/download",
    buildLaunchArgs(model, extraFlags = []) {
      const args = ["--dangerously-skip-permissions"];
      if (model) args.push("--model", model);
      return [...args, ...extraFlags];
    },
    parseOutput(rawOutput) {
      return rawOutput.trim();
    }
  },
  codex: {
    agentType: "codex",
    binary: "codex",
    installInstructions: "Install Codex CLI: npm install -g @openai/codex",
    buildLaunchArgs(model, extraFlags = []) {
      const args = ["--full-auto"];
      if (model) args.push("--model", model);
      return [...args, ...extraFlags];
    },
    parseOutput(rawOutput) {
      const lines = rawOutput.trim().split("\n").filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(lines[i]);
          if (parsed.type === "message" && parsed.role === "assistant") {
            return parsed.content ?? rawOutput;
          }
          if (parsed.type === "result" || parsed.output) {
            return parsed.output ?? parsed.result ?? rawOutput;
          }
        } catch {
        }
      }
      return rawOutput.trim();
    }
  },
  gemini: {
    agentType: "gemini",
    binary: "gemini",
    installInstructions: "Install Gemini CLI: npm install -g @google/gemini-cli",
    buildLaunchArgs(model, extraFlags = []) {
      const args = ["--yolo"];
      if (model) args.push("--model", model);
      return [...args, ...extraFlags];
    },
    parseOutput(rawOutput) {
      return rawOutput.trim();
    }
  }
};
function getContract(agentType) {
  const contract = CONTRACTS[agentType];
  if (!contract) {
    throw new Error(`Unknown agent type: ${agentType}. Supported: ${Object.keys(CONTRACTS).join(", ")}`);
  }
  return contract;
}
function isCliAvailable(agentType) {
  const contract = getContract(agentType);
  try {
    const result = (0, import_child_process.spawnSync)(contract.binary, ["--version"], { timeout: 5e3 });
    return result.status === 0;
  } catch {
    return false;
  }
}
function validateCliAvailable(agentType) {
  if (!isCliAvailable(agentType)) {
    const contract = getContract(agentType);
    throw new Error(
      `CLI agent '${agentType}' not found. ${contract.installInstructions}`
    );
  }
}
function buildLaunchArgs(agentType, config) {
  return getContract(agentType).buildLaunchArgs(config.model, config.extraFlags);
}
function buildWorkerCommand(agentType, config) {
  const contract = getContract(agentType);
  const args = buildLaunchArgs(agentType, config);
  return `${contract.binary} ${args.join(" ")}`;
}
function getWorkerEnv(teamName, workerName2, agentType) {
  return {
    OMC_TEAM_WORKER: `${teamName}/${workerName2}`,
    OMC_TEAM_NAME: teamName,
    OMC_WORKER_AGENT_TYPE: agentType
  };
}

// src/team/tmux-session.ts
var import_child_process2 = require("child_process");
var import_path = require("path");
var import_promises = __toESM(require("fs/promises"), 1);
async function createTeamSession(teamName, workerCount, cwd) {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);
  if (!process.env.TMUX) {
    throw new Error("Team mode requires running inside tmux. Start one: tmux new-session");
  }
  const contextResult = await execFileAsync("tmux", [
    "display-message",
    "-p",
    "#S:#I #{pane_id}"
  ]);
  const contextLine = contextResult.stdout.trim();
  const spaceIdx = contextLine.indexOf(" ");
  const sessionAndWindow = contextLine.slice(0, spaceIdx);
  const leaderPaneId = contextLine.slice(spaceIdx + 1);
  const teamTarget = sessionAndWindow;
  const resolvedSessionName = teamTarget.split(":")[0];
  const workerPaneIds = [];
  for (let i = 0; i < workerCount; i++) {
    const splitTarget = i === 0 ? leaderPaneId : workerPaneIds[i - 1];
    const splitType = i === 0 ? "-h" : "-v";
    const splitResult = await execFileAsync("tmux", [
      "split-window",
      splitType,
      "-t",
      splitTarget,
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-c",
      cwd
    ]);
    const paneId = splitResult.stdout.split("\n")[0]?.trim();
    if (paneId) {
      workerPaneIds.push(paneId);
    }
  }
  try {
    await execFileAsync("tmux", ["select-layout", "-t", teamTarget, "main-vertical"]);
  } catch {
  }
  try {
    const widthResult = await execFileAsync("tmux", [
      "display-message",
      "-p",
      "-t",
      teamTarget,
      "#{window_width}"
    ]);
    const width = parseInt(widthResult.stdout.trim(), 10);
    if (Number.isFinite(width) && width >= 40) {
      const half = String(Math.floor(width / 2));
      await execFileAsync("tmux", ["set-window-option", "-t", teamTarget, "main-pane-width", half]);
      await execFileAsync("tmux", ["select-layout", "-t", teamTarget, "main-vertical"]);
    }
  } catch {
  }
  try {
    await execFileAsync("tmux", ["set-option", "-t", resolvedSessionName, "mouse", "on"]);
  } catch {
  }
  try {
    await execFileAsync("tmux", ["select-pane", "-t", leaderPaneId]);
  } catch {
  }
  await new Promise((r) => setTimeout(r, 300));
  return { sessionName: teamTarget, leaderPaneId, workerPaneIds };
}
async function spawnWorkerInPane(sessionName, paneId, config) {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);
  const envString = Object.entries(config.envVars).map(([k, v]) => `${k}=${v}`).join(" ");
  const shell = process.env.SHELL || "/bin/bash";
  const shellName = shell.split("/").pop() || "bash";
  const rcFile = process.env.HOME ? `${process.env.HOME}/.${shellName}rc` : "";
  const sourceCmd = rcFile ? `[ -f "${rcFile}" ] && source "${rcFile}"; ` : "";
  const startCmd = `env ${envString} ${shell} -c "${sourceCmd}exec ${config.launchCmd}"`;
  await execFileAsync("tmux", [
    "send-keys",
    "-t",
    paneId,
    "-l",
    startCmd
  ]);
  await execFileAsync("tmux", ["send-keys", "-t", paneId, "Enter"]);
}
function normalizeTmuxCapture(value) {
  return value.replace(/\r/g, "").replace(/\s+/g, " ").trim();
}
async function capturePaneAsync(paneId, execFileAsync) {
  try {
    const result = await execFileAsync("tmux", ["capture-pane", "-t", paneId, "-p", "-S", "-80"]);
    return result.stdout;
  } catch {
    return "";
  }
}
function paneHasTrustPrompt(captured) {
  const lines = captured.split("\n").map((l) => l.replace(/\r/g, "").trim()).filter((l) => l.length > 0);
  const tail = lines.slice(-12);
  const hasQuestion = tail.some((l) => /Do you trust the contents of this directory\?/i.test(l));
  const hasChoices = tail.some((l) => /Yes,\s*continue|No,\s*quit|Press enter to continue/i.test(l));
  return hasQuestion && hasChoices;
}
function paneHasActiveTask(captured) {
  const lines = captured.split("\n").map((l) => l.replace(/\r/g, "").trim()).filter((l) => l.length > 0);
  const tail = lines.slice(-40);
  if (tail.some((l) => /esc to interrupt/i.test(l))) return true;
  if (tail.some((l) => /\bbackground terminal running\b/i.test(l))) return true;
  return false;
}
function paneTailContainsLiteralLine(captured, text) {
  return normalizeTmuxCapture(captured).includes(normalizeTmuxCapture(text));
}
async function sendToWorker(sessionName, paneId, message) {
  if (message.length > 200) {
    console.warn(`[tmux-session] sendToWorker: message truncated to 200 chars`);
    message = message.slice(0, 200);
  }
  try {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const sendKey = async (key) => {
      await execFileAsync("tmux", ["send-keys", "-t", paneId, key]);
    };
    const initialCapture = await capturePaneAsync(paneId, execFileAsync);
    const paneBusy = paneHasActiveTask(initialCapture);
    if (paneHasTrustPrompt(initialCapture)) {
      await sendKey("C-m");
      await sleep(120);
      await sendKey("C-m");
      await sleep(200);
    }
    await execFileAsync("tmux", ["send-keys", "-t", paneId, "-l", "--", message]);
    await sleep(150);
    const submitRounds = 6;
    for (let round = 0; round < submitRounds; round++) {
      await sleep(100);
      if (round === 0 && paneBusy) {
        await sendKey("Tab");
        await sleep(80);
        await sendKey("C-m");
      } else {
        await sendKey("C-m");
        await sleep(200);
        await sendKey("C-m");
      }
      await sleep(140);
      const checkCapture = await capturePaneAsync(paneId, execFileAsync);
      if (!paneTailContainsLiteralLine(checkCapture, message)) return true;
      await sleep(140);
    }
    await sendKey("C-m");
    await sleep(120);
    await sendKey("C-m");
    return true;
  } catch {
    return false;
  }
}
async function injectToLeaderPane(sessionName, leaderPaneId, message) {
  const prefixed = `[OMC_TMUX_INJECT] ${message}`.slice(0, 200);
  try {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);
    const captured = await capturePaneAsync(leaderPaneId, execFileAsync);
    if (paneHasActiveTask(captured)) {
      await execFileAsync("tmux", ["send-keys", "-t", leaderPaneId, "C-c"]);
      await new Promise((r) => setTimeout(r, 250));
    }
  } catch {
  }
  return sendToWorker(sessionName, leaderPaneId, prefixed);
}
async function isWorkerAlive(paneId) {
  try {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);
    const result = await execFileAsync("tmux", [
      "display-message",
      "-t",
      paneId,
      "-p",
      "#{pane_dead}"
    ]);
    return result.stdout.trim() === "0";
  } catch {
    return false;
  }
}
async function killTeamSession(sessionName, workerPaneIds, leaderPaneId) {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);
  if (sessionName.includes(":")) {
    if (!workerPaneIds?.length) return;
    for (const id of workerPaneIds) {
      if (id === leaderPaneId) continue;
      try {
        await execFileAsync("tmux", ["kill-pane", "-t", id]);
      } catch {
      }
    }
    return;
  }
  try {
    await execFileAsync("tmux", ["kill-session", "-t", sessionName]);
  } catch {
  }
}

// src/team/worker-bootstrap.ts
var import_promises2 = require("fs/promises");
var import_path4 = require("path");

// src/agents/prompt-helpers.ts
var import_fs2 = require("fs");
var import_path3 = require("path");
var import_url2 = require("url");

// src/agents/utils.ts
var import_fs = require("fs");
var import_path2 = require("path");
var import_url = require("url");

// src/agents/prompt-helpers.ts
var import_meta = {};
function getPackageDir() {
  try {
    if (import_meta?.url) {
      const __filename = (0, import_url2.fileURLToPath)(import_meta.url);
      const __dirname2 = (0, import_path3.dirname)(__filename);
      return (0, import_path3.join)(__dirname2, "..", "..");
    }
  } catch {
  }
  if (typeof __dirname !== "undefined") {
    return (0, import_path3.join)(__dirname, "..");
  }
  return process.cwd();
}
var _cachedRoles = null;
function getValidAgentRoles() {
  if (_cachedRoles) return _cachedRoles;
  try {
    if (typeof __AGENT_ROLES__ !== "undefined" && Array.isArray(__AGENT_ROLES__) && __AGENT_ROLES__.length > 0) {
      _cachedRoles = __AGENT_ROLES__;
      return _cachedRoles;
    }
  } catch {
  }
  try {
    const agentsDir = (0, import_path3.join)(getPackageDir(), "agents");
    const files = (0, import_fs2.readdirSync)(agentsDir);
    _cachedRoles = files.filter((f) => f.endsWith(".md")).map((f) => (0, import_path3.basename)(f, ".md")).sort();
  } catch (err) {
    console.error("[prompt-injection] CRITICAL: Could not scan agents/ directory for role discovery:", err);
    _cachedRoles = [];
  }
  return _cachedRoles;
}
var VALID_AGENT_ROLES = getValidAgentRoles();
function sanitizePromptContent(content, maxLength = 4e3) {
  if (!content) return "";
  let sanitized = content.length > maxLength ? content.slice(0, maxLength) : content;
  if (sanitized.length > 0) {
    const lastCode = sanitized.charCodeAt(sanitized.length - 1);
    if (lastCode >= 55296 && lastCode <= 56319) {
      sanitized = sanitized.slice(0, -1);
    }
  }
  sanitized = sanitized.replace(/<(\/?)(TASK_SUBJECT)[^>]*>/gi, "[$1$2]");
  sanitized = sanitized.replace(/<(\/?)(TASK_DESCRIPTION)[^>]*>/gi, "[$1$2]");
  sanitized = sanitized.replace(/<(\/?)(INBOX_MESSAGE)[^>]*>/gi, "[$1$2]");
  sanitized = sanitized.replace(/<(\/?)(INSTRUCTIONS)[^>]*>/gi, "[$1$2]");
  sanitized = sanitized.replace(/<(\/?)(SYSTEM)[^>]*>/gi, "[$1$2]");
  return sanitized;
}

// src/team/worker-bootstrap.ts
function generateWorkerOverlay(params) {
  const { teamName, workerName: workerName2, agentType, tasks, bootstrapInstructions } = params;
  const sanitizedTasks = tasks.map((t) => ({
    id: t.id,
    subject: sanitizePromptContent(t.subject),
    description: sanitizePromptContent(t.description)
  }));
  const sentinelPath = `.omc/state/team/${teamName}/workers/${workerName2}/.ready`;
  const heartbeatPath = `.omc/state/team/${teamName}/workers/${workerName2}/heartbeat.json`;
  const inboxPath = `.omc/state/team/${teamName}/workers/${workerName2}/inbox.md`;
  const taskDir = `.omc/state/team/${teamName}/tasks`;
  const donePath = `.omc/state/team/${teamName}/workers/${workerName2}/done.json`;
  const taskList = sanitizedTasks.length > 0 ? sanitizedTasks.map((t) => `- **Task ${t.id}**: ${t.subject}`).join("\n") : "- No tasks assigned yet. Check your inbox for assignments.";
  return `# Team Worker Protocol

## FIRST ACTION REQUIRED
Before doing anything else, write your ready sentinel file:
\`\`\`bash
mkdir -p $(dirname ${sentinelPath}) && touch ${sentinelPath}
\`\`\`

## Identity
- **Team**: ${teamName}
- **Worker**: ${workerName2}
- **Agent Type**: ${agentType}
- **Environment**: OMC_TEAM_WORKER=${teamName}/${workerName2}

## Your Tasks
${taskList}

## Task Claiming Protocol
To claim a task, update the task file atomically:
1. Read task from: ${taskDir}/{taskId}.json
2. Update status to "in_progress", set owner to "${workerName2}"
3. Write back to task file
4. Do the work
5. Update status to "completed", write result to task file

## Communication Protocol
- **Inbox**: Read ${inboxPath} for new instructions
- **Heartbeat**: Update ${heartbeatPath} every few minutes:
  \`\`\`json
  {"workerName":"${workerName2}","status":"working","updatedAt":"<ISO timestamp>","currentTaskId":"<id or null>"}
  \`\`\`

## Task Completion Protocol
When you finish a task (success or failure), write a done signal file:
- Path: ${donePath}
- Content (JSON, one line):
  {"taskId":"<id>","status":"completed","summary":"<1-2 sentence summary>","completedAt":"<ISO timestamp>"}
- For failures, set status to "failed" and include the error in summary.
- Use "completed" or "failed" only for status.

## Shutdown Protocol
When you see a shutdown request (check .omc/state/team/${teamName}/shutdown.json):
1. Finish your current task if close to completion
2. Write an ACK file: .omc/state/team/${teamName}/workers/${workerName2}/shutdown-ack.json
3. Exit

${bootstrapInstructions ? `## Additional Instructions
${bootstrapInstructions}
` : ""}`;
}
async function composeInitialInbox(teamName, workerName2, content, cwd) {
  const inboxPath = (0, import_path4.join)(cwd, `.omc/state/team/${teamName}/workers/${workerName2}/inbox.md`);
  await (0, import_promises2.mkdir)((0, import_path4.dirname)(inboxPath), { recursive: true });
  await (0, import_promises2.writeFile)(inboxPath, content, "utf-8");
}
async function ensureWorkerStateDir(teamName, workerName2, cwd) {
  const workerDir = (0, import_path4.join)(cwd, `.omc/state/team/${teamName}/workers/${workerName2}`);
  await (0, import_promises2.mkdir)(workerDir, { recursive: true });
  const mailboxDir = (0, import_path4.join)(cwd, `.omc/state/team/${teamName}/mailbox`);
  await (0, import_promises2.mkdir)(mailboxDir, { recursive: true });
  const tasksDir = (0, import_path4.join)(cwd, `.omc/state/team/${teamName}/tasks`);
  await (0, import_promises2.mkdir)(tasksDir, { recursive: true });
}
async function writeWorkerOverlay(params) {
  const { teamName, workerName: workerName2, cwd } = params;
  const overlay = generateWorkerOverlay(params);
  const overlayPath = (0, import_path4.join)(cwd, `.omc/state/team/${teamName}/workers/${workerName2}/AGENTS.md`);
  await (0, import_promises2.mkdir)((0, import_path4.dirname)(overlayPath), { recursive: true });
  await (0, import_promises2.writeFile)(overlayPath, overlay, "utf-8");
  return overlayPath;
}

// src/team/runtime.ts
function workerName(index) {
  return `worker-${index + 1}`;
}
function stateRoot(cwd, teamName) {
  return (0, import_path5.join)(cwd, `.omc/state/team/${teamName}`);
}
async function writeJson(filePath, data) {
  await (0, import_promises3.mkdir)((0, import_path5.join)(filePath, ".."), { recursive: true });
  await (0, import_promises3.writeFile)(filePath, JSON.stringify(data, null, 2), "utf-8");
}
async function readJsonSafe(filePath) {
  try {
    const content = await (0, import_promises3.readFile)(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}
function buildInitialTaskInstruction(teamName, workerName2, task, taskId) {
  const donePath = `.omc/state/team/${teamName}/workers/${workerName2}/done.json`;
  return [
    `## Initial Task Assignment`,
    `Task ID: ${taskId}`,
    `Worker: ${workerName2}`,
    `Subject: ${task.subject}`,
    ``,
    task.description,
    ``,
    `When complete, write done signal to ${donePath}:`,
    `{"taskId":"${taskId}","status":"completed","summary":"<brief summary>","completedAt":"<ISO timestamp>"}`
  ].join("\n");
}
async function startTeam(config) {
  const { teamName, workerCount, agentTypes, tasks, cwd } = config;
  for (const agentType of [...new Set(agentTypes)]) {
    validateCliAvailable(agentType);
  }
  const root = stateRoot(cwd, teamName);
  await (0, import_promises3.mkdir)((0, import_path5.join)(root, "tasks"), { recursive: true });
  await (0, import_promises3.mkdir)((0, import_path5.join)(root, "mailbox"), { recursive: true });
  await writeJson((0, import_path5.join)(root, "config.json"), config);
  for (let i = 0; i < tasks.length; i++) {
    const taskId = String(i + 1);
    await writeJson((0, import_path5.join)(root, "tasks", `${taskId}.json`), {
      id: taskId,
      subject: tasks[i].subject,
      description: tasks[i].description,
      status: "pending",
      owner: null,
      result: null,
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    });
  }
  const workerNames = [];
  for (let i = 0; i < workerCount; i++) {
    const wName = workerName(i);
    workerNames.push(wName);
    const agentType = agentTypes[i] ?? agentTypes[0] ?? "claude";
    await ensureWorkerStateDir(teamName, wName, cwd);
    await writeWorkerOverlay({
      teamName,
      workerName: wName,
      agentType,
      tasks: tasks.map((t, idx) => ({ id: String(idx + 1), subject: t.subject, description: t.description })),
      cwd
    });
    await composeInitialInbox(
      teamName,
      wName,
      `# Welcome, ${wName}

Read your AGENTS.md overlay at .omc/state/team/${teamName}/workers/${wName}/AGENTS.md

Write your ready sentinel first, then claim tasks from .omc/state/team/${teamName}/tasks/`,
      cwd
    );
  }
  const session = await createTeamSession(teamName, workerCount, cwd);
  for (let i = 0; i < workerCount; i++) {
    const wName = workerNames[i];
    const agentType = agentTypes[i] ?? agentTypes[0] ?? "claude";
    const paneId = session.workerPaneIds[i];
    const envVars = getWorkerEnv(teamName, wName, agentType);
    const launchCmd = buildWorkerCommand(agentType, { teamName, workerName: wName, cwd });
    const paneConfig = { teamName, workerName: wName, envVars, launchCmd, cwd };
    await spawnWorkerInPane(session.sessionName, paneId, paneConfig);
  }
  await Promise.all(
    workerNames.map(async (wName, i) => {
      const agentType = agentTypes[i] ?? agentTypes[0] ?? "claude";
      const paneId = session.workerPaneIds[i];
      await new Promise((r) => setTimeout(r, 4e3));
      if (agentType === "gemini") {
        await sendToWorker(session.sessionName, paneId, "1");
        await new Promise((r) => setTimeout(r, 800));
      }
      const task = tasks[i] ?? tasks[0];
      if (task) {
        const taskId = String(i + 1);
        const instruction = buildInitialTaskInstruction(teamName, wName, task, taskId);
        const inboxPath = (0, import_path5.join)(cwd, `.omc/state/team/${teamName}/workers/${wName}/inbox.md`);
        await (0, import_promises3.appendFile)(inboxPath, `

---
${instruction}
_queued: ${(/* @__PURE__ */ new Date()).toISOString()}_
`, "utf-8");
        const relPath = `.omc/state/team/${teamName}/workers/${wName}/inbox.md`;
        await sendToWorker(session.sessionName, paneId, `Read and execute your task from: ${relPath}`);
      }
    })
  );
  const hasCliWorkers = agentTypes.length > 0;
  let stopWatchdog;
  if (hasCliWorkers) {
    stopWatchdog = watchdogCliWorkers(
      teamName,
      workerNames,
      cwd,
      3e3,
      async (event) => {
        const msg = `[${event.workerName} ${event.status}] ${event.summary}`;
        const ok = await injectToLeaderPane(session.sessionName, session.leaderPaneId, msg);
        if (!ok) {
          console.warn(`[watchdog] Failed to inject completion message for ${event.workerName}`);
        }
        const taskPath = (0, import_path5.join)(root, "tasks", `${event.taskId}.json`);
        const task = await readJsonSafe(taskPath);
        if (task && task.status !== "completed") {
          task.status = event.status === "completed" ? "completed" : "failed";
          task.result = event.summary;
          task.completedAt = (/* @__PURE__ */ new Date()).toISOString();
          await writeJson(taskPath, task);
        }
      }
    );
  }
  return {
    teamName,
    sessionName: session.sessionName,
    leaderPaneId: session.leaderPaneId,
    config,
    workerNames,
    workerPaneIds: session.workerPaneIds,
    cwd,
    stopWatchdog
  };
}
async function monitorTeam(teamName, cwd, workerPaneIds) {
  const root = stateRoot(cwd, teamName);
  const taskCounts = { pending: 0, inProgress: 0, completed: 0, failed: 0 };
  try {
    const { readdir } = await import("fs/promises");
    const taskFiles = await readdir((0, import_path5.join)(root, "tasks"));
    for (const f of taskFiles.filter((f2) => f2.endsWith(".json"))) {
      const task = await readJsonSafe((0, import_path5.join)(root, "tasks", f));
      if (task?.status === "pending") taskCounts.pending++;
      else if (task?.status === "in_progress") taskCounts.inProgress++;
      else if (task?.status === "completed") taskCounts.completed++;
      else if (task?.status === "failed") taskCounts.failed++;
    }
  } catch {
  }
  const workers = [];
  const deadWorkers = [];
  for (let i = 0; i < workerPaneIds.length; i++) {
    const wName = `worker-${i + 1}`;
    const paneId = workerPaneIds[i];
    const alive = await isWorkerAlive(paneId);
    const heartbeatPath = (0, import_path5.join)(root, "workers", wName, "heartbeat.json");
    const heartbeat = await readJsonSafe(heartbeatPath);
    let stalled = false;
    if (heartbeat?.updatedAt) {
      const age = Date.now() - new Date(heartbeat.updatedAt).getTime();
      stalled = age > 6e4;
    }
    const status = {
      workerName: wName,
      alive,
      paneId,
      currentTaskId: heartbeat?.currentTaskId,
      lastHeartbeat: heartbeat?.updatedAt,
      stalled
    };
    workers.push(status);
    if (!alive) deadWorkers.push(wName);
  }
  let phase = "executing";
  if (taskCounts.inProgress === 0 && taskCounts.pending > 0 && taskCounts.completed === 0) {
    phase = "planning";
  } else if (taskCounts.failed > 0 && taskCounts.pending === 0 && taskCounts.inProgress === 0) {
    phase = "fixing";
  } else if (taskCounts.completed > 0 && taskCounts.pending === 0 && taskCounts.inProgress === 0 && taskCounts.failed === 0) {
    phase = "completed";
  }
  return { teamName, phase, workers, taskCounts, deadWorkers };
}
function watchdogCliWorkers(teamName, workerNames, cwd, intervalMs, onComplete) {
  const processed = /* @__PURE__ */ new Set();
  const tick = async () => {
    for (let i = 0; i < workerNames.length; i++) {
      const wName = workerNames[i];
      if (processed.has(wName)) continue;
      const donePath = (0, import_path5.join)(stateRoot(cwd, teamName), "workers", wName, "done.json");
      const signal = await readJsonSafe(donePath);
      if (!signal) continue;
      processed.add(wName);
      try {
        const { unlink } = await import("fs/promises");
        await unlink(donePath);
      } catch {
      }
      try {
        await onComplete({
          workerName: wName,
          taskId: signal.taskId,
          status: signal.status,
          summary: signal.summary
        });
      } catch (err) {
        console.warn(`[watchdog] onComplete error for ${wName}:`, err);
      }
    }
  };
  const intervalId = setInterval(() => {
    tick().catch((err) => console.warn("[watchdog] tick error:", err));
  }, intervalMs);
  return () => clearInterval(intervalId);
}
async function shutdownTeam(teamName, sessionName, cwd, timeoutMs = 3e4, workerPaneIds, leaderPaneId) {
  const root = stateRoot(cwd, teamName);
  await writeJson((0, import_path5.join)(root, "shutdown.json"), {
    requestedAt: (/* @__PURE__ */ new Date()).toISOString(),
    teamName
  });
  const deadline = Date.now() + timeoutMs;
  const configData = await readJsonSafe((0, import_path5.join)(root, "config.json"));
  const workerCount = configData?.workerCount ?? 0;
  const expectedAcks = Array.from({ length: workerCount }, (_, i) => `worker-${i + 1}`);
  while (Date.now() < deadline && expectedAcks.length > 0) {
    for (const wName of [...expectedAcks]) {
      const ackPath = (0, import_path5.join)(root, "workers", wName, "shutdown-ack.json");
      if ((0, import_fs3.existsSync)(ackPath)) {
        expectedAcks.splice(expectedAcks.indexOf(wName), 1);
      }
    }
    if (expectedAcks.length > 0) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  await killTeamSession(sessionName, workerPaneIds, leaderPaneId);
  try {
    await (0, import_promises3.rm)(root, { recursive: true, force: true });
  } catch {
  }
}

// src/team/runtime-cli.ts
function collectTaskResults(stateRoot2) {
  const tasksDir = (0, import_path6.join)(stateRoot2, "tasks");
  try {
    const files = (0, import_fs4.readdirSync)(tasksDir).filter((f) => f.endsWith(".json"));
    return files.map((f) => {
      try {
        const raw = (0, import_fs4.readFileSync)((0, import_path6.join)(tasksDir, f), "utf-8");
        const task = JSON.parse(raw);
        return {
          taskId: task.id ?? f.replace(".json", ""),
          status: task.status ?? "unknown",
          summary: task.result ?? task.summary ?? ""
        };
      } catch {
        return { taskId: f.replace(".json", ""), status: "unknown", summary: "" };
      }
    });
  } catch {
    return [];
  }
}
async function main() {
  const startTime = Date.now();
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const rawInput = Buffer.concat(chunks).toString("utf-8").trim();
  let input;
  try {
    input = JSON.parse(rawInput);
  } catch (err) {
    process.stderr.write(`[runtime-cli] Failed to parse stdin JSON: ${err}
`);
    process.exit(1);
  }
  const missing = [];
  if (!input.teamName) missing.push("teamName");
  if (!input.agentTypes || !Array.isArray(input.agentTypes) || input.agentTypes.length === 0) missing.push("agentTypes");
  if (!input.tasks || !Array.isArray(input.tasks) || input.tasks.length === 0) missing.push("tasks");
  if (!input.cwd) missing.push("cwd");
  if (missing.length > 0) {
    process.stderr.write(`[runtime-cli] Missing required fields: ${missing.join(", ")}
`);
    process.exit(1);
  }
  const {
    teamName,
    agentTypes,
    tasks,
    cwd,
    timeoutSeconds = 300,
    pollIntervalMs = 5e3
  } = input;
  const workerCount = input.workerCount ?? agentTypes.length;
  const stateRoot2 = (0, import_path6.join)(cwd, `.omc/state/team/${teamName}`);
  const timeoutMs = timeoutSeconds * 1e3;
  const config = {
    teamName,
    workerCount,
    agentTypes,
    tasks,
    cwd
  };
  let runtime = null;
  let finalStatus = "timeout";
  let pollActive = true;
  function exitCodeFor(status) {
    return status === "completed" ? 0 : status === "timeout" ? 2 : 1;
  }
  async function doShutdown(status) {
    pollActive = false;
    finalStatus = status;
    if (runtime?.stopWatchdog) {
      runtime.stopWatchdog();
    }
    const taskResults = collectTaskResults(stateRoot2);
    if (runtime) {
      try {
        await shutdownTeam(
          runtime.teamName,
          runtime.sessionName,
          runtime.cwd,
          2e3,
          runtime.workerPaneIds,
          runtime.leaderPaneId
        );
      } catch (err) {
        process.stderr.write(`[runtime-cli] shutdownTeam error: ${err}
`);
      }
    }
    const duration = (Date.now() - startTime) / 1e3;
    const output = {
      status: finalStatus,
      teamName,
      taskResults,
      duration,
      workerCount
    };
    process.stdout.write(JSON.stringify(output) + "\n");
    process.exit(exitCodeFor(status));
  }
  process.on("SIGINT", () => {
    process.stderr.write("[runtime-cli] Received SIGINT, shutting down...\n");
    doShutdown("failed").catch(() => process.exit(1));
  });
  process.on("SIGTERM", () => {
    process.stderr.write("[runtime-cli] Received SIGTERM, shutting down...\n");
    doShutdown("failed").catch(() => process.exit(1));
  });
  try {
    runtime = await startTeam(config);
  } catch (err) {
    process.stderr.write(`[runtime-cli] startTeam failed: ${err}
`);
    process.exit(1);
  }
  const jobId = process.env.OMC_JOB_ID;
  const omcJobsDir = process.env.OMC_JOBS_DIR;
  if (jobId && omcJobsDir) {
    try {
      const panesPath = (0, import_path6.join)(omcJobsDir, `${jobId}-panes.json`);
      await (0, import_promises4.writeFile)(
        panesPath + ".tmp",
        JSON.stringify({ paneIds: runtime.workerPaneIds, leaderPaneId: runtime.leaderPaneId })
      );
      await (0, import_promises4.rename)(panesPath + ".tmp", panesPath);
    } catch (err) {
      process.stderr.write(`[runtime-cli] Failed to persist pane IDs: ${err}
`);
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (pollActive && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    if (!pollActive) break;
    let snap;
    try {
      snap = await monitorTeam(teamName, cwd, runtime.workerPaneIds);
    } catch (err) {
      process.stderr.write(`[runtime-cli] monitorTeam error: ${err}
`);
      continue;
    }
    process.stderr.write(
      `[runtime-cli] phase=${snap.phase} pending=${snap.taskCounts.pending} inProgress=${snap.taskCounts.inProgress} completed=${snap.taskCounts.completed} failed=${snap.taskCounts.failed} dead=${snap.deadWorkers.length}
`
    );
    if (snap.phase === "completed") {
      await doShutdown("completed");
      return;
    }
    const allWorkersDead = snap.deadWorkers.length === runtime.workerPaneIds.length;
    const hasOutstandingWork = snap.taskCounts.pending + snap.taskCounts.inProgress > 0;
    const deadWorkerFailure = allWorkersDead && hasOutstandingWork;
    const fixingWithNoWorkers = snap.phase === "fixing" && allWorkersDead;
    if (deadWorkerFailure || fixingWithNoWorkers) {
      process.stderr.write(`[runtime-cli] Failure detected: deadWorkerFailure=${deadWorkerFailure} fixingWithNoWorkers=${fixingWithNoWorkers}
`);
      await doShutdown("failed");
      return;
    }
  }
  if (pollActive) {
    process.stderr.write(`[runtime-cli] Timeout after ${timeoutSeconds}s
`);
    await doShutdown("timeout");
  }
}
if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[runtime-cli] Fatal error: ${err}
`);
    process.exit(1);
  });
}
