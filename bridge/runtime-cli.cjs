"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/team/team-name.ts
function validateTeamName(teamName) {
  if (!TEAM_NAME_PATTERN.test(teamName)) {
    throw new Error(
      `Invalid team name: "${teamName}". Team name must match /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/.`
    );
  }
  return teamName;
}
var TEAM_NAME_PATTERN;
var init_team_name = __esm({
  "src/team/team-name.ts"() {
    "use strict";
    TEAM_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/;
  }
});

// src/team/tmux-session.ts
var tmux_session_exports = {};
__export(tmux_session_exports, {
  buildWorkerStartCommand: () => buildWorkerStartCommand,
  createSession: () => createSession,
  createTeamSession: () => createTeamSession,
  getDefaultShell: () => getDefaultShell,
  injectToLeaderPane: () => injectToLeaderPane,
  isSessionAlive: () => isSessionAlive,
  isUnixLikeOnWindows: () => isUnixLikeOnWindows,
  isWorkerAlive: () => isWorkerAlive,
  killSession: () => killSession,
  killTeamSession: () => killTeamSession,
  killWorkerPanes: () => killWorkerPanes,
  listActiveSessions: () => listActiveSessions,
  paneHasActiveTask: () => paneHasActiveTask,
  paneLooksReady: () => paneLooksReady,
  sanitizeName: () => sanitizeName,
  sendToWorker: () => sendToWorker,
  sessionName: () => sessionName,
  shouldAttemptAdaptiveRetry: () => shouldAttemptAdaptiveRetry,
  spawnBridgeInSession: () => spawnBridgeInSession,
  spawnWorkerInPane: () => spawnWorkerInPane,
  validateTmux: () => validateTmux,
  waitForPaneReady: () => waitForPaneReady
});
function isUnixLikeOnWindows() {
  return process.platform === "win32" && !!(process.env.MSYSTEM || process.env.MINGW_PREFIX);
}
async function tmuxAsync(args) {
  if (args.some((a) => a.includes("#{"))) {
    const escaped = args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(" ");
    return promisifiedExec(`tmux ${escaped}`);
  }
  return promisifiedExecFile("tmux", args);
}
function getDefaultShell() {
  if (process.platform === "win32" && !isUnixLikeOnWindows()) {
    return process.env.COMSPEC || "cmd.exe";
  }
  return process.env.SHELL || "/bin/bash";
}
function escapeForCmdSet(value) {
  return value.replace(/"/g, '""');
}
function shellNameFromPath(shellPath) {
  const shellName = (0, import_path2.basename)(shellPath.replace(/\\/g, "/"));
  return shellName.replace(/\.(exe|cmd|bat)$/i, "");
}
function shellEscape(value) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
function assertSafeEnvKey(key) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Invalid environment key: "${key}"`);
  }
}
function isAbsoluteLaunchBinaryPath(value) {
  return (0, import_path2.isAbsolute)(value) || import_path2.win32.isAbsolute(value);
}
function assertSafeLaunchBinary(launchBinary) {
  if (launchBinary.trim().length === 0) {
    throw new Error("Invalid launchBinary: value cannot be empty");
  }
  if (launchBinary !== launchBinary.trim()) {
    throw new Error("Invalid launchBinary: value cannot have leading/trailing whitespace");
  }
  if (DANGEROUS_LAUNCH_BINARY_CHARS.test(launchBinary)) {
    throw new Error("Invalid launchBinary: contains dangerous shell metacharacters");
  }
  if (/\s/.test(launchBinary) && !isAbsoluteLaunchBinaryPath(launchBinary)) {
    throw new Error("Invalid launchBinary: paths with spaces must be absolute");
  }
}
function getLaunchWords(config) {
  if (config.launchBinary) {
    assertSafeLaunchBinary(config.launchBinary);
    return [config.launchBinary, ...config.launchArgs ?? []];
  }
  if (config.launchCmd) {
    return [config.launchCmd];
  }
  throw new Error("Missing worker launch command. Provide launchBinary or launchCmd.");
}
function buildWorkerStartCommand(config) {
  const shell = getDefaultShell();
  const launchWords = getLaunchWords(config);
  const shouldSourceRc = process.env.OMC_TEAM_NO_RC !== "1";
  if (process.platform === "win32" && !isUnixLikeOnWindows()) {
    const envPrefix = Object.entries(config.envVars).map(([k, v]) => {
      assertSafeEnvKey(k);
      return `set "${k}=${escapeForCmdSet(v)}"`;
    }).join(" && ");
    const launch = config.launchBinary ? launchWords.map((part) => `"${escapeForCmdSet(part)}"`).join(" ") : launchWords[0];
    const cmdBody = envPrefix ? `${envPrefix} && ${launch}` : launch;
    return `${shell} /d /s /c "${cmdBody}"`;
  }
  if (config.launchBinary) {
    const envAssignments = Object.entries(config.envVars).map(([key, value]) => {
      assertSafeEnvKey(key);
      return `${key}=${shellEscape(value)}`;
    });
    const shellName2 = shellNameFromPath(shell) || "bash";
    const execArgsCommand = shellName2 === "fish" ? "exec $argv" : 'exec "$@"';
    const rcFile2 = process.env.HOME ? `${process.env.HOME}/.${shellName2}rc` : "";
    const script = shouldSourceRc && rcFile2 ? `[ -f ${shellEscape(rcFile2)} ] && . ${shellEscape(rcFile2)}; ${execArgsCommand}` : execArgsCommand;
    return [
      "env",
      ...envAssignments,
      shell,
      "-lc",
      script,
      "--",
      ...launchWords
    ].map(shellEscape).join(" ");
  }
  const envString = Object.entries(config.envVars).map(([k, v]) => {
    assertSafeEnvKey(k);
    return `${k}=${shellEscape(v)}`;
  }).join(" ");
  const shellName = shellNameFromPath(shell) || "bash";
  const rcFile = process.env.HOME ? `${process.env.HOME}/.${shellName}rc` : "";
  const sourceCmd = shouldSourceRc && rcFile ? `[ -f "${rcFile}" ] && source "${rcFile}"; ` : "";
  return `env ${envString} ${shell} -c "${sourceCmd}exec ${launchWords[0]}"`;
}
function validateTmux() {
  try {
    (0, import_child_process2.execSync)("tmux -V", { encoding: "utf-8", timeout: 5e3, stdio: "pipe" });
  } catch {
    throw new Error(
      "tmux is not available. Install it:\n  macOS: brew install tmux\n  Ubuntu/Debian: sudo apt-get install tmux\n  Fedora: sudo dnf install tmux\n  Arch: sudo pacman -S tmux"
    );
  }
}
function sanitizeName(name) {
  const sanitized = name.replace(/[^a-zA-Z0-9-]/g, "");
  if (sanitized.length === 0) {
    throw new Error(`Invalid name: "${name}" contains no valid characters (alphanumeric or hyphen)`);
  }
  if (sanitized.length < 2) {
    throw new Error(`Invalid name: "${name}" too short after sanitization (minimum 2 characters)`);
  }
  return sanitized.slice(0, 50);
}
function sessionName(teamName, workerName2) {
  return `${TMUX_SESSION_PREFIX}-${sanitizeName(teamName)}-${sanitizeName(workerName2)}`;
}
function createSession(teamName, workerName2, workingDirectory) {
  const name = sessionName(teamName, workerName2);
  try {
    (0, import_child_process2.execFileSync)("tmux", ["kill-session", "-t", name], { stdio: "pipe", timeout: 5e3 });
  } catch {
  }
  const args = ["new-session", "-d", "-s", name, "-x", "200", "-y", "50"];
  if (workingDirectory) {
    args.push("-c", workingDirectory);
  }
  (0, import_child_process2.execFileSync)("tmux", args, { stdio: "pipe", timeout: 5e3 });
  return name;
}
function killSession(teamName, workerName2) {
  const name = sessionName(teamName, workerName2);
  try {
    (0, import_child_process2.execFileSync)("tmux", ["kill-session", "-t", name], { stdio: "pipe", timeout: 5e3 });
  } catch {
  }
}
function isSessionAlive(teamName, workerName2) {
  const name = sessionName(teamName, workerName2);
  try {
    (0, import_child_process2.execFileSync)("tmux", ["has-session", "-t", name], { stdio: "pipe", timeout: 5e3 });
    return true;
  } catch {
    return false;
  }
}
function listActiveSessions(teamName) {
  const prefix = `${TMUX_SESSION_PREFIX}-${sanitizeName(teamName)}-`;
  try {
    const fmtArgs = ["list-sessions", "-F", "#{session_name}"];
    const shellCmd = "tmux " + fmtArgs.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(" ");
    const output = (0, import_child_process2.execSync)(shellCmd, {
      encoding: "utf-8",
      timeout: 5e3,
      stdio: ["pipe", "pipe", "pipe"]
    });
    return output.trim().split("\n").filter((s) => s.startsWith(prefix)).map((s) => s.slice(prefix.length));
  } catch {
    return [];
  }
}
function spawnBridgeInSession(tmuxSession, bridgeScriptPath, configFilePath) {
  const cmd = `node "${bridgeScriptPath}" --config "${configFilePath}"`;
  (0, import_child_process2.execFileSync)("tmux", ["send-keys", "-t", tmuxSession, cmd, "Enter"], { stdio: "pipe", timeout: 5e3 });
}
async function createTeamSession(teamName, workerCount, cwd) {
  const { execFile: execFile2 } = await import("child_process");
  const { promisify: promisify2 } = await import("util");
  const execFileAsync = promisify2(execFile2);
  const inTmux = Boolean(process.env.TMUX);
  const envPaneIdRaw = (process.env.TMUX_PANE ?? "").trim();
  const envPaneId = /^%\d+$/.test(envPaneIdRaw) ? envPaneIdRaw : "";
  let sessionAndWindow = "";
  let leaderPaneId = envPaneId;
  if (!inTmux) {
    const detachedSessionName = `${TMUX_SESSION_PREFIX}-${sanitizeName(teamName)}-${Date.now().toString(36)}`;
    const detachedResult = await execFileAsync("tmux", [
      "new-session",
      "-d",
      "-P",
      "-F",
      "#S:0 #{pane_id}",
      "-s",
      detachedSessionName,
      "-c",
      cwd
    ]);
    const detachedLine = detachedResult.stdout.trim();
    const detachedMatch = detachedLine.match(/^(\S+)\s+(%\d+)$/);
    if (!detachedMatch) {
      throw new Error(`Failed to create detached tmux session: "${detachedLine}"`);
    }
    sessionAndWindow = detachedMatch[1];
    leaderPaneId = detachedMatch[2];
  }
  if (inTmux && envPaneId) {
    try {
      const targetedContextResult = await execFileAsync("tmux", [
        "display-message",
        "-p",
        "-t",
        envPaneId,
        "#S:#I"
      ]);
      sessionAndWindow = targetedContextResult.stdout.trim();
    } catch {
      sessionAndWindow = "";
      leaderPaneId = "";
    }
  }
  if (!sessionAndWindow || !leaderPaneId) {
    const contextResult = await tmuxAsync([
      "display-message",
      "-p",
      "#S:#I #{pane_id}"
    ]);
    const contextLine = contextResult.stdout.trim();
    const contextMatch = contextLine.match(/^(\S+)\s+(%\d+)$/);
    if (!contextMatch) {
      throw new Error(`Failed to resolve tmux context: "${contextLine}"`);
    }
    sessionAndWindow = contextMatch[1];
    leaderPaneId = contextMatch[2];
  }
  const teamTarget = sessionAndWindow;
  const resolvedSessionName = teamTarget.split(":")[0];
  const workerPaneIds = [];
  if (workerCount <= 0) {
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
  for (let i = 0; i < workerCount; i++) {
    const splitTarget = i === 0 ? leaderPaneId : workerPaneIds[i - 1];
    const splitType = i === 0 ? "-h" : "-v";
    const splitResult = await tmuxAsync([
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
    const widthResult = await tmuxAsync([
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
async function spawnWorkerInPane(sessionName2, paneId, config) {
  const { execFile: execFile2 } = await import("child_process");
  const { promisify: promisify2 } = await import("util");
  const execFileAsync = promisify2(execFile2);
  validateTeamName(config.teamName);
  const startCmd = buildWorkerStartCommand(config);
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
function paneLooksReady(captured) {
  const lines = captured.split("\n").map((line) => line.replace(/\r/g, "").trim()).filter((line) => line.length > 0);
  if (lines.length === 0) return false;
  const tail = lines.slice(-20);
  const hasPrompt = tail.some((line) => /^\s*[›>❯]\s*/u.test(line));
  if (hasPrompt) return true;
  const hasCodexHint = tail.some(
    (line) => /\bgpt-[\w.-]+\b/i.test(line) || /\b\d+% left\b/i.test(line)
  );
  return hasCodexHint;
}
async function waitForPaneReady(paneId, opts = {}) {
  const envTimeout = Number.parseInt(process.env.OMC_SHELL_READY_TIMEOUT_MS ?? "", 10);
  const timeoutMs = Number.isFinite(opts.timeoutMs) && (opts.timeoutMs ?? 0) > 0 ? Number(opts.timeoutMs) : Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 1e4;
  const pollIntervalMs = Number.isFinite(opts.pollIntervalMs) && (opts.pollIntervalMs ?? 0) > 0 ? Number(opts.pollIntervalMs) : 250;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const captured = await capturePaneAsync(paneId, promisifiedExecFile);
    if (paneLooksReady(captured) && !paneHasActiveTask(captured)) {
      return true;
    }
    await sleep(pollIntervalMs);
  }
  console.warn(
    `[tmux-session] waitForPaneReady: pane ${paneId} timed out after ${timeoutMs}ms (set OMC_SHELL_READY_TIMEOUT_MS to tune)`
  );
  return false;
}
function paneTailContainsLiteralLine(captured, text) {
  return normalizeTmuxCapture(captured).includes(normalizeTmuxCapture(text));
}
async function paneInCopyMode(paneId, execFileAsync) {
  try {
    const result = await tmuxAsync(["display-message", "-t", paneId, "-p", "#{pane_in_mode}"]);
    return result.stdout.trim() === "1";
  } catch {
    return false;
  }
}
function shouldAttemptAdaptiveRetry(args) {
  if (process.env.OMC_TEAM_AUTO_INTERRUPT_RETRY === "0") return false;
  if (args.retriesAttempted >= 1) return false;
  if (args.paneInCopyMode) return false;
  if (!args.paneBusy) return false;
  if (typeof args.latestCapture !== "string") return false;
  if (!paneTailContainsLiteralLine(args.latestCapture, args.message)) return false;
  if (paneHasActiveTask(args.latestCapture)) return false;
  if (!paneLooksReady(args.latestCapture)) return false;
  return true;
}
async function sendToWorker(_sessionName, paneId, message) {
  if (message.length > 200) {
    console.warn(`[tmux-session] sendToWorker: message truncated to 200 chars`);
    message = message.slice(0, 200);
  }
  try {
    const { execFile: execFile2 } = await import("child_process");
    const { promisify: promisify2 } = await import("util");
    const execFileAsync = promisify2(execFile2);
    const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
    const sendKey = async (key) => {
      await execFileAsync("tmux", ["send-keys", "-t", paneId, key]);
    };
    if (await paneInCopyMode(paneId, execFileAsync)) {
      return false;
    }
    const initialCapture = await capturePaneAsync(paneId, execFileAsync);
    const paneBusy = paneHasActiveTask(initialCapture);
    if (paneHasTrustPrompt(initialCapture)) {
      await sendKey("C-m");
      await sleep2(120);
      await sendKey("C-m");
      await sleep2(200);
    }
    await execFileAsync("tmux", ["send-keys", "-t", paneId, "-l", "--", message]);
    await sleep2(150);
    const submitRounds = 6;
    for (let round = 0; round < submitRounds; round++) {
      await sleep2(100);
      if (round === 0 && paneBusy) {
        await sendKey("Tab");
        await sleep2(80);
        await sendKey("C-m");
      } else {
        await sendKey("C-m");
        await sleep2(200);
        await sendKey("C-m");
      }
      await sleep2(140);
      const checkCapture = await capturePaneAsync(paneId, execFileAsync);
      if (!paneTailContainsLiteralLine(checkCapture, message)) return true;
      await sleep2(140);
    }
    if (await paneInCopyMode(paneId, execFileAsync)) {
      return false;
    }
    const finalCapture = await capturePaneAsync(paneId, execFileAsync);
    const paneModeBeforeAdaptiveRetry = await paneInCopyMode(paneId, execFileAsync);
    if (shouldAttemptAdaptiveRetry({
      paneBusy,
      latestCapture: finalCapture,
      message,
      paneInCopyMode: paneModeBeforeAdaptiveRetry,
      retriesAttempted: 0
    })) {
      if (await paneInCopyMode(paneId, execFileAsync)) {
        return false;
      }
      await sendKey("C-u");
      await sleep2(80);
      if (await paneInCopyMode(paneId, execFileAsync)) {
        return false;
      }
      await execFileAsync("tmux", ["send-keys", "-t", paneId, "-l", "--", message]);
      await sleep2(120);
      for (let round = 0; round < 4; round++) {
        await sendKey("C-m");
        await sleep2(180);
        await sendKey("C-m");
        await sleep2(140);
        const retryCapture = await capturePaneAsync(paneId, execFileAsync);
        if (!paneTailContainsLiteralLine(retryCapture, message)) return true;
      }
    }
    if (await paneInCopyMode(paneId, execFileAsync)) {
      return false;
    }
    await sendKey("C-m");
    await sleep2(120);
    await sendKey("C-m");
    return true;
  } catch {
    return false;
  }
}
async function injectToLeaderPane(sessionName2, leaderPaneId, message) {
  const prefixed = `[OMC_TMUX_INJECT] ${message}`.slice(0, 200);
  try {
    const { execFile: execFile2 } = await import("child_process");
    const { promisify: promisify2 } = await import("util");
    const execFileAsync = promisify2(execFile2);
    if (await paneInCopyMode(leaderPaneId, execFileAsync)) {
      return false;
    }
    const captured = await capturePaneAsync(leaderPaneId, execFileAsync);
    if (paneHasActiveTask(captured)) {
      await execFileAsync("tmux", ["send-keys", "-t", leaderPaneId, "C-c"]);
      await new Promise((r) => setTimeout(r, 250));
    }
  } catch {
  }
  return sendToWorker(sessionName2, leaderPaneId, prefixed);
}
async function isWorkerAlive(paneId) {
  try {
    const { execFile: execFile2 } = await import("child_process");
    const { promisify: promisify2 } = await import("util");
    const execFileAsync = promisify2(execFile2);
    const result = await tmuxAsync([
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
async function killWorkerPanes(opts) {
  const { paneIds, leaderPaneId, teamName, cwd, graceMs = 1e4 } = opts;
  if (!paneIds.length) return;
  const shutdownPath = (0, import_path2.join)(cwd, ".omc", "state", "team", teamName, "shutdown.json");
  try {
    await import_promises.default.writeFile(shutdownPath, JSON.stringify({ requestedAt: Date.now() }));
    await sleep(graceMs);
  } catch {
  }
  const { execFile: execFile2 } = await import("child_process");
  const { promisify: promisify2 } = await import("util");
  const execFileAsync = promisify2(execFile2);
  for (const paneId of paneIds) {
    if (paneId === leaderPaneId) continue;
    try {
      await execFileAsync("tmux", ["kill-pane", "-t", paneId]);
    } catch {
    }
  }
}
async function killTeamSession(sessionName2, workerPaneIds, leaderPaneId) {
  const { execFile: execFile2 } = await import("child_process");
  const { promisify: promisify2 } = await import("util");
  const execFileAsync = promisify2(execFile2);
  if (sessionName2.includes(":")) {
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
  if (process.env.OMC_TEAM_ALLOW_KILL_CURRENT_SESSION !== "1" && process.env.TMUX) {
    try {
      const current = await tmuxAsync(["display-message", "-p", "#S"]);
      const currentSessionName = current.stdout.trim();
      if (currentSessionName && currentSessionName === sessionName2) {
        return;
      }
    } catch {
    }
  }
  try {
    await execFileAsync("tmux", ["kill-session", "-t", sessionName2]);
  } catch {
  }
}
var import_child_process2, import_path2, import_util, import_promises, sleep, TMUX_SESSION_PREFIX, promisifiedExec, promisifiedExecFile, DANGEROUS_LAUNCH_BINARY_CHARS;
var init_tmux_session = __esm({
  "src/team/tmux-session.ts"() {
    "use strict";
    import_child_process2 = require("child_process");
    import_path2 = require("path");
    import_util = require("util");
    import_promises = __toESM(require("fs/promises"), 1);
    init_team_name();
    sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    TMUX_SESSION_PREFIX = "omc-team";
    promisifiedExec = (0, import_util.promisify)(import_child_process2.exec);
    promisifiedExecFile = (0, import_util.promisify)(import_child_process2.execFile);
    DANGEROUS_LAUNCH_BINARY_CHARS = /[;&|`$()<>\n\r\t\0]/;
  }
});

// src/team/runtime-cli.ts
var runtime_cli_exports = {};
__export(runtime_cli_exports, {
  checkWatchdogFailedMarker: () => checkWatchdogFailedMarker,
  getTerminalStatus: () => getTerminalStatus,
  writeResultArtifact: () => writeResultArtifact
});
module.exports = __toCommonJS(runtime_cli_exports);
var import_fs13 = require("fs");
var import_promises7 = require("fs/promises");
var import_path16 = require("path");

// src/team/runtime.ts
var import_promises3 = require("fs/promises");
var import_path10 = require("path");
var import_fs6 = require("fs");

// src/team/model-contract.ts
var import_child_process = require("child_process");
var import_path = require("path");
init_team_name();
var resolvedPathCache = /* @__PURE__ */ new Map();
var UNTRUSTED_PATH_PATTERNS = [
  /^\/tmp(\/|$)/,
  /^\/var\/tmp(\/|$)/,
  /^\/dev\/shm(\/|$)/
];
function getTrustedPrefixes() {
  const trusted = [
    "/usr/local/bin",
    "/usr/bin",
    "/opt/homebrew/"
  ];
  const home = process.env.HOME;
  if (home) {
    trusted.push(`${home}/.local/bin`);
    trusted.push(`${home}/.nvm/`);
    trusted.push(`${home}/.cargo/bin`);
  }
  const custom = (process.env.OMC_TRUSTED_CLI_DIRS ?? "").split(":").map((part) => part.trim()).filter(Boolean).filter((part) => (0, import_path.isAbsolute)(part));
  trusted.push(...custom);
  return trusted;
}
function isTrustedPrefix(resolvedPath) {
  const normalized = (0, import_path.normalize)(resolvedPath);
  return getTrustedPrefixes().some((prefix) => normalized.startsWith((0, import_path.normalize)(prefix)));
}
function assertBinaryName(binary) {
  if (!/^[A-Za-z0-9._-]+$/.test(binary)) {
    throw new Error(`Invalid CLI binary name: ${binary}`);
  }
}
function resolveCliBinaryPath(binary) {
  assertBinaryName(binary);
  const cached = resolvedPathCache.get(binary);
  if (cached) return cached;
  const finder = process.platform === "win32" ? "where" : "which";
  const result = (0, import_child_process.spawnSync)(finder, [binary], {
    timeout: 5e3,
    env: process.env
  });
  if (result.status !== 0) {
    throw new Error(`CLI binary '${binary}' not found in PATH`);
  }
  const stdout = result.stdout?.toString().trim() ?? "";
  const firstLine = stdout.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  if (!firstLine) {
    throw new Error(`CLI binary '${binary}' not found in PATH`);
  }
  const resolvedPath = (0, import_path.normalize)(firstLine);
  if (!(0, import_path.isAbsolute)(resolvedPath)) {
    throw new Error(`Resolved CLI binary '${binary}' to relative path`);
  }
  if (UNTRUSTED_PATH_PATTERNS.some((pattern) => pattern.test(resolvedPath))) {
    throw new Error(`Resolved CLI binary '${binary}' to untrusted location: ${resolvedPath}`);
  }
  if (!isTrustedPrefix(resolvedPath)) {
    console.warn(`[omc:cli-security] CLI binary '${binary}' resolved to non-standard path: ${resolvedPath}`);
  }
  resolvedPathCache.set(binary, resolvedPath);
  return resolvedPath;
}
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
    supportsPromptMode: true,
    // Codex accepts prompt as a positional argument (no flag needed):
    //   codex [OPTIONS] [PROMPT]
    buildLaunchArgs(model, extraFlags = []) {
      const args = ["--dangerously-bypass-approvals-and-sandbox"];
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
    supportsPromptMode: true,
    promptModeFlag: "-i",
    buildLaunchArgs(model, extraFlags = []) {
      const args = ["--approval-mode", "yolo"];
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
function validateBinaryRef(binary) {
  if ((0, import_path.isAbsolute)(binary)) return;
  if (/^[A-Za-z0-9._-]+$/.test(binary)) return;
  throw new Error(`Unsafe CLI binary reference: ${binary}`);
}
function resolveBinaryPath(binary) {
  validateBinaryRef(binary);
  if ((0, import_path.isAbsolute)(binary)) return binary;
  try {
    const resolver = process.platform === "win32" ? "where" : "which";
    const result = (0, import_child_process.spawnSync)(resolver, [binary], { timeout: 5e3, encoding: "utf8" });
    if (result.status !== 0) return binary;
    const lines = result.stdout?.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) ?? [];
    const firstPath = lines[0];
    const isResolvedAbsolute = !!firstPath && ((0, import_path.isAbsolute)(firstPath) || import_path.win32.isAbsolute(firstPath));
    return isResolvedAbsolute ? firstPath : binary;
  } catch {
    return binary;
  }
}
function resolveValidatedBinaryPath(agentType) {
  const contract = getContract(agentType);
  return resolveCliBinaryPath(contract.binary);
}
function buildLaunchArgs(agentType, config) {
  return getContract(agentType).buildLaunchArgs(config.model, config.extraFlags);
}
function buildWorkerArgv(agentType, config) {
  validateTeamName(config.teamName);
  const contract = getContract(agentType);
  const binary = config.resolvedBinaryPath ? (() => {
    validateBinaryRef(config.resolvedBinaryPath);
    return config.resolvedBinaryPath;
  })() : resolveBinaryPath(contract.binary);
  const args = buildLaunchArgs(agentType, config);
  return [binary, ...args];
}
function getWorkerEnv(teamName, workerName2, agentType) {
  validateTeamName(teamName);
  return {
    OMC_TEAM_WORKER: `${teamName}/${workerName2}`,
    OMC_TEAM_NAME: teamName,
    OMC_WORKER_AGENT_TYPE: agentType
  };
}
function isPromptModeAgent(agentType) {
  const contract = getContract(agentType);
  return !!contract.supportsPromptMode;
}
function getPromptModeArgs(agentType, instruction) {
  const contract = getContract(agentType);
  if (!contract.supportsPromptMode) {
    return [];
  }
  if (contract.promptModeFlag) {
    return [contract.promptModeFlag, instruction];
  }
  return [instruction];
}

// src/team/runtime.ts
init_team_name();
init_tmux_session();

// src/team/worker-bootstrap.ts
var import_promises2 = require("fs/promises");
var import_path5 = require("path");

// src/agents/prompt-helpers.ts
var import_fs2 = require("fs");
var import_path4 = require("path");
var import_url2 = require("url");

// src/agents/utils.ts
var import_fs = require("fs");
var import_path3 = require("path");
var import_url = require("url");

// src/agents/prompt-helpers.ts
var import_meta = {};
function getPackageDir() {
  if (typeof __dirname !== "undefined" && __dirname) {
    const currentDirName = (0, import_path4.basename)(__dirname);
    const parentDirName = (0, import_path4.basename)((0, import_path4.dirname)(__dirname));
    if (currentDirName === "bridge") {
      return (0, import_path4.join)(__dirname, "..");
    }
    if (currentDirName === "agents" && (parentDirName === "src" || parentDirName === "dist")) {
      return (0, import_path4.join)(__dirname, "..", "..");
    }
  }
  try {
    const __filename = (0, import_url2.fileURLToPath)(import_meta.url);
    const __dirname2 = (0, import_path4.dirname)(__filename);
    return (0, import_path4.join)(__dirname2, "..", "..");
  } catch {
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
    const agentsDir = (0, import_path4.join)(getPackageDir(), "agents");
    const files = (0, import_fs2.readdirSync)(agentsDir);
    _cachedRoles = files.filter((f) => f.endsWith(".md")).map((f) => (0, import_path4.basename)(f, ".md")).sort();
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
function agentTypeGuidance(agentType) {
  switch (agentType) {
    case "codex":
      return [
        "### Agent-Type Guidance (codex)",
        "- Prefer short, explicit `omc team api ... --json` commands and parse outputs before next step.",
        "- If a command fails, report the exact stderr to leader-fixed before retrying."
      ].join("\n");
    case "gemini":
      return [
        "### Agent-Type Guidance (gemini)",
        "- Execute task work in small, verifiable increments and report each milestone to leader-fixed.",
        "- Keep commit-sized changes scoped to assigned files only; no broad refactors."
      ].join("\n");
    case "claude":
    default:
      return [
        "### Agent-Type Guidance (claude)",
        "- Keep reasoning focused on assigned task IDs and send concise progress acks to leader-fixed.",
        "- Before any risky command, send a blocker/proposal message to leader-fixed and wait for updated inbox instructions."
      ].join("\n");
  }
}
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
  const statusPath = `.omc/state/team/${teamName}/workers/${workerName2}/status.json`;
  const taskDir = `.omc/state/team/${teamName}/tasks`;
  const taskList = sanitizedTasks.length > 0 ? sanitizedTasks.map((t) => `- **Task ${t.id}**: ${t.subject}
  Description: ${t.description}
  Status: pending`).join("\n") : "- No tasks assigned yet. Check your inbox for assignments.";
  return `# Team Worker Protocol

You are a **team worker**, not the team leader. Operate strictly within worker protocol.

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

## Task Lifecycle Protocol (CLI API)
Use the CLI API for all task lifecycle operations. Do NOT directly edit task files.

1. Read your task file at \`${taskDir}/task-{taskId}.json\`
2. Task id format: State/CLI APIs use task_id: "<id>" (example: "1"), not "task-1"
3. Claim a task via CLI interop:
   \`omc team api claim-task --input "{\\"team_name\\":\\"${teamName}\\",\\"task_id\\":\\"<id>\\",\\"worker\\":\\"${workerName2}\\"}" --json\`
4. Do the work described in the task
5. On completion, transition via CLI interop (use the claim_token from step 3):
   \`omc team api transition-task-status --input "{\\"team_name\\":\\"${teamName}\\",\\"task_id\\":\\"<id>\\",\\"from\\":\\"in_progress\\",\\"to\\":\\"completed\\",\\"claim_token\\":\\"<claim_token from step 3>\\"}" --json\`
6. On failure, transition to "failed" with error (use the claim_token from step 3):
   \`omc team api transition-task-status --input "{\\"team_name\\":\\"${teamName}\\",\\"task_id\\":\\"<id>\\",\\"from\\":\\"in_progress\\",\\"to\\":\\"failed\\",\\"claim_token\\":\\"<claim_token from step 3>\\"}" --json\`
7. Use \`omc team api release-task-claim --json\` only for rollback to pending

## Communication Protocol
- **Inbox**: Read ${inboxPath} for new instructions
- **Status**: Write to ${statusPath}:
  \`\`\`json
  {"state": "idle", "updated_at": "<ISO timestamp>"}
  \`\`\`
  States: "idle" | "working" | "blocked" | "done" | "failed"
- **Heartbeat**: Update ${heartbeatPath} every few minutes:
  \`\`\`json
  {"pid":<pid>,"last_turn_at":"<ISO timestamp>","turn_count":<n>,"alive":true}
  \`\`\`

## Message Protocol
Send messages via CLI API:
- To leader: \`omc team api send-message --input "{\\"team_name\\":\\"${teamName}\\",\\"from_worker\\":\\"${workerName2}\\",\\"to_worker\\":\\"leader-fixed\\",\\"body\\":\\"<message>\\"}" --json\`
- Check mailbox: \`omc team api mailbox-list --input "{\\"team_name\\":\\"${teamName}\\",\\"worker\\":\\"${workerName2}\\"}" --json\`
- Mark delivered: \`omc team api mailbox-mark-delivered --input "{\\"team_name\\":\\"${teamName}\\",\\"worker\\":\\"${workerName2}\\",\\"message_id\\":\\"<id>\\"}" --json\`

## Startup Handshake (Required)
Before doing any task work, send exactly one startup ACK to the leader:
\`omc team api send-message --input "{\\"team_name\\":\\"${teamName}\\",\\"from_worker\\":\\"${workerName2}\\",\\"to_worker\\":\\"leader-fixed\\",\\"body\\":\\"ACK: ${workerName2} initialized\\"}" --json\`

## Shutdown Protocol
When you see a shutdown request in your inbox:
1. Write your decision to: .omc/state/team/${teamName}/workers/${workerName2}/shutdown-ack.json
2. Format:
   - Accept: {"status":"accept","reason":"ok","updated_at":"<iso>"}
   - Reject: {"status":"reject","reason":"still working","updated_at":"<iso>"}
3. Exit your session

## Rules
- You are NOT the leader. Never run leader orchestration workflows.
- Do NOT edit files outside the paths listed in your task description
- Do NOT write lifecycle fields (status, owner, result, error) directly in task files; use CLI API
- Do NOT spawn sub-agents. Complete work in this worker session only.
- Do NOT create tmux panes/sessions (\`tmux split-window\`, \`tmux new-session\`, etc.).
- Do NOT run team spawning/orchestration commands (for example: \`omc team ...\`, \`omx team ...\`, \`$team\`, \`$ultrawork\`, \`$autopilot\`, \`$ralph\`).
- Worker-allowed control surface is only: \`omc team api ... --json\` (and equivalent \`omx team api ... --json\` where configured).
- If blocked, write {"state": "blocked", "reason": "..."} to your status file

${agentTypeGuidance(agentType)}

${bootstrapInstructions ? `## Additional Instructions
${bootstrapInstructions}
` : ""}`;
}
async function composeInitialInbox(teamName, workerName2, content, cwd) {
  const inboxPath = (0, import_path5.join)(cwd, `.omc/state/team/${teamName}/workers/${workerName2}/inbox.md`);
  await (0, import_promises2.mkdir)((0, import_path5.dirname)(inboxPath), { recursive: true });
  await (0, import_promises2.writeFile)(inboxPath, content, "utf-8");
}
async function ensureWorkerStateDir(teamName, workerName2, cwd) {
  const workerDir = (0, import_path5.join)(cwd, `.omc/state/team/${teamName}/workers/${workerName2}`);
  await (0, import_promises2.mkdir)(workerDir, { recursive: true });
  const mailboxDir = (0, import_path5.join)(cwd, `.omc/state/team/${teamName}/mailbox`);
  await (0, import_promises2.mkdir)(mailboxDir, { recursive: true });
  const tasksDir = (0, import_path5.join)(cwd, `.omc/state/team/${teamName}/tasks`);
  await (0, import_promises2.mkdir)(tasksDir, { recursive: true });
}
async function writeWorkerOverlay(params) {
  const { teamName, workerName: workerName2, cwd } = params;
  const overlay = generateWorkerOverlay(params);
  const overlayPath = (0, import_path5.join)(cwd, `.omc/state/team/${teamName}/workers/${workerName2}/AGENTS.md`);
  await (0, import_promises2.mkdir)((0, import_path5.dirname)(overlayPath), { recursive: true });
  await (0, import_promises2.writeFile)(overlayPath, overlay, "utf-8");
  return overlayPath;
}

// src/team/task-file-ops.ts
var import_fs5 = require("fs");
var import_path9 = require("path");

// src/utils/paths.ts
var import_path6 = require("path");
var import_fs3 = require("fs");
var import_os = require("os");
function getConfigDir2() {
  if (process.platform === "win32") {
    return process.env.APPDATA || (0, import_path6.join)((0, import_os.homedir)(), "AppData", "Roaming");
  }
  return process.env.XDG_CONFIG_HOME || (0, import_path6.join)((0, import_os.homedir)(), ".config");
}
var STALE_THRESHOLD_MS = 24 * 60 * 60 * 1e3;

// src/team/task-file-ops.ts
init_tmux_session();

// src/team/fs-utils.ts
var import_fs4 = require("fs");
var import_path7 = require("path");
function atomicWriteJson(filePath, data, mode = 384) {
  const dir = (0, import_path7.dirname)(filePath);
  if (!(0, import_fs4.existsSync)(dir)) (0, import_fs4.mkdirSync)(dir, { recursive: true, mode: 448 });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  (0, import_fs4.writeFileSync)(tmpPath, JSON.stringify(data, null, 2) + "\n", { encoding: "utf-8", mode });
  (0, import_fs4.renameSync)(tmpPath, filePath);
}
function ensureDirWithMode(dirPath, mode = 448) {
  if (!(0, import_fs4.existsSync)(dirPath)) (0, import_fs4.mkdirSync)(dirPath, { recursive: true, mode });
}
function safeRealpath(p) {
  try {
    return (0, import_fs4.realpathSync)(p);
  } catch {
    const parent = (0, import_path7.dirname)(p);
    const name = (0, import_path7.basename)(p);
    try {
      return (0, import_path7.resolve)((0, import_fs4.realpathSync)(parent), name);
    } catch {
      return (0, import_path7.resolve)(p);
    }
  }
}
function validateResolvedPath(resolvedPath, expectedBase) {
  const absResolved = safeRealpath(resolvedPath);
  const absBase = safeRealpath(expectedBase);
  const rel = (0, import_path7.relative)(absBase, absResolved);
  if (rel.startsWith("..") || (0, import_path7.resolve)(absBase, rel) !== absResolved) {
    throw new Error(`Path traversal detected: "${resolvedPath}" escapes base "${expectedBase}"`);
  }
}

// src/team/state-paths.ts
var import_path8 = require("path");
function normalizeTaskFileStem(taskId) {
  const trimmed = String(taskId).trim().replace(/\.json$/i, "");
  if (/^task-\d+$/.test(trimmed)) return trimmed;
  if (/^\d+$/.test(trimmed)) return `task-${trimmed}`;
  return trimmed;
}
var TeamPaths = {
  root: (teamName) => `.omc/state/team/${teamName}`,
  config: (teamName) => `.omc/state/team/${teamName}/config.json`,
  shutdown: (teamName) => `.omc/state/team/${teamName}/shutdown.json`,
  tasks: (teamName) => `.omc/state/team/${teamName}/tasks`,
  taskFile: (teamName, taskId) => `.omc/state/team/${teamName}/tasks/${normalizeTaskFileStem(taskId)}.json`,
  workers: (teamName) => `.omc/state/team/${teamName}/workers`,
  workerDir: (teamName, workerName2) => `.omc/state/team/${teamName}/workers/${workerName2}`,
  heartbeat: (teamName, workerName2) => `.omc/state/team/${teamName}/workers/${workerName2}/heartbeat.json`,
  inbox: (teamName, workerName2) => `.omc/state/team/${teamName}/workers/${workerName2}/inbox.md`,
  outbox: (teamName, workerName2) => `.omc/state/team/${teamName}/workers/${workerName2}/outbox.jsonl`,
  ready: (teamName, workerName2) => `.omc/state/team/${teamName}/workers/${workerName2}/.ready`,
  overlay: (teamName, workerName2) => `.omc/state/team/${teamName}/workers/${workerName2}/AGENTS.md`,
  shutdownAck: (teamName, workerName2) => `.omc/state/team/${teamName}/workers/${workerName2}/shutdown-ack.json`,
  mailbox: (teamName, workerName2) => `.omc/state/team/${teamName}/mailbox/${workerName2}.json`,
  mailboxLockDir: (teamName, workerName2) => `.omc/state/team/${teamName}/mailbox/.lock-${workerName2}`,
  dispatchRequests: (teamName) => `.omc/state/team/${teamName}/dispatch/requests.json`,
  dispatchLockDir: (teamName) => `.omc/state/team/${teamName}/dispatch/.lock`,
  workerStatus: (teamName, workerName2) => `.omc/state/team/${teamName}/workers/${workerName2}/status.json`,
  workerIdleNotify: (teamName) => `.omc/state/team/${teamName}/worker-idle-notify.json`,
  workerPrevNotifyState: (teamName, workerName2) => `.omc/state/team/${teamName}/workers/${workerName2}/prev-notify-state.json`,
  events: (teamName) => `.omc/state/team/${teamName}/events.jsonl`,
  approval: (teamName, taskId) => `.omc/state/team/${teamName}/approvals/${taskId}.json`,
  manifest: (teamName) => `.omc/state/team/${teamName}/manifest.json`,
  monitorSnapshot: (teamName) => `.omc/state/team/${teamName}/monitor-snapshot.json`,
  summarySnapshot: (teamName) => `.omc/state/team/${teamName}/summary-snapshot.json`,
  phaseState: (teamName) => `.omc/state/team/${teamName}/phase-state.json`,
  scalingLock: (teamName) => `.omc/state/team/${teamName}/.scaling-lock`,
  workerIdentity: (teamName, workerName2) => `.omc/state/team/${teamName}/workers/${workerName2}/identity.json`,
  workerAgentsMd: (teamName) => `.omc/state/team/${teamName}/worker-agents.md`,
  shutdownRequest: (teamName, workerName2) => `.omc/state/team/${teamName}/workers/${workerName2}/shutdown-request.json`
};
function absPath(cwd, relativePath) {
  return (0, import_path8.join)(cwd, relativePath);
}
function teamStateRoot(cwd, teamName) {
  return (0, import_path8.join)(cwd, TeamPaths.root(teamName));
}
function getTaskStoragePath(cwd, teamName, taskId) {
  if (taskId !== void 0) {
    return (0, import_path8.join)(cwd, TeamPaths.taskFile(teamName, taskId));
  }
  return (0, import_path8.join)(cwd, TeamPaths.tasks(teamName));
}

// src/team/task-file-ops.ts
var DEFAULT_STALE_LOCK_MS = 3e4;
function isPidAlive(pid) {
  if (pid <= 0 || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && e.code === "EPERM") return true;
    return false;
  }
}
function acquireTaskLock(teamName, taskId, opts) {
  const staleLockMs = opts?.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const dir = canonicalTasksDir(teamName, opts?.cwd);
  ensureDirWithMode(dir);
  const lockPath = (0, import_path9.join)(dir, `${sanitizeTaskId(taskId)}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = (0, import_fs5.openSync)(lockPath, import_fs5.constants.O_CREAT | import_fs5.constants.O_EXCL | import_fs5.constants.O_WRONLY, 384);
      const payload = JSON.stringify({
        pid: process.pid,
        workerName: opts?.workerName ?? "",
        timestamp: Date.now()
      });
      (0, import_fs5.writeSync)(fd, payload, null, "utf-8");
      return { fd, path: lockPath };
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && err.code === "EEXIST") {
        if (attempt === 0 && isLockStale(lockPath, staleLockMs)) {
          try {
            (0, import_fs5.unlinkSync)(lockPath);
          } catch {
          }
          continue;
        }
        return null;
      }
      throw err;
    }
  }
  return null;
}
function releaseTaskLock(handle) {
  try {
    (0, import_fs5.closeSync)(handle.fd);
  } catch {
  }
  try {
    (0, import_fs5.unlinkSync)(handle.path);
  } catch {
  }
}
async function withTaskLock(teamName, taskId, fn, opts) {
  const handle = acquireTaskLock(teamName, taskId, opts);
  if (!handle) return null;
  try {
    return await fn();
  } finally {
    releaseTaskLock(handle);
  }
}
function isLockStale(lockPath, staleLockMs) {
  try {
    const stat = (0, import_fs5.statSync)(lockPath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < staleLockMs) return false;
    try {
      const raw = (0, import_fs5.readFileSync)(lockPath, "utf-8");
      const payload = JSON.parse(raw);
      if (payload.pid && isPidAlive(payload.pid)) return false;
    } catch {
    }
    return true;
  } catch {
    return false;
  }
}
function sanitizeTaskId(taskId) {
  if (!/^[A-Za-z0-9._-]+$/.test(taskId)) {
    throw new Error(`Invalid task ID: "${taskId}" contains unsafe characters`);
  }
  return taskId;
}
function canonicalTasksDir(teamName, cwd) {
  const root = cwd ?? process.cwd();
  const dir = getTaskStoragePath(root, sanitizeName(teamName));
  validateResolvedPath(dir, (0, import_path9.join)(root, ".omc", "state", "team"));
  return dir;
}
function failureSidecarPath(teamName, taskId, cwd) {
  return (0, import_path9.join)(canonicalTasksDir(teamName, cwd), `${sanitizeTaskId(taskId)}.failure.json`);
}
function writeTaskFailure(teamName, taskId, error, opts) {
  const filePath = failureSidecarPath(teamName, taskId, opts?.cwd);
  const existing = readTaskFailure(teamName, taskId, opts);
  const sidecar = {
    taskId,
    lastError: error,
    retryCount: existing ? existing.retryCount + 1 : 1,
    lastFailedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  atomicWriteJson(filePath, sidecar);
  return sidecar;
}
function readTaskFailure(teamName, taskId, opts) {
  const filePath = failureSidecarPath(teamName, taskId, opts?.cwd);
  if (!(0, import_fs5.existsSync)(filePath)) return null;
  try {
    const raw = (0, import_fs5.readFileSync)(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
var DEFAULT_MAX_TASK_RETRIES = 5;

// src/team/runtime.ts
function workerName(index) {
  return `worker-${index + 1}`;
}
function stateRoot(cwd, teamName) {
  validateTeamName(teamName);
  return (0, import_path10.join)(cwd, `.omc/state/team/${teamName}`);
}
async function writeJson(filePath, data) {
  await (0, import_promises3.mkdir)((0, import_path10.join)(filePath, ".."), { recursive: true });
  await (0, import_promises3.writeFile)(filePath, JSON.stringify(data, null, 2), "utf-8");
}
async function readJsonSafe(filePath) {
  const isDoneSignalPath = filePath.endsWith("done.json");
  const maxAttempts = isDoneSignalPath ? 4 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const content = await (0, import_promises3.readFile)(filePath, "utf-8");
      try {
        return JSON.parse(content);
      } catch {
        if (!isDoneSignalPath || attempt === maxAttempts) {
          return null;
        }
      }
    } catch (error) {
      const isMissingDoneSignal = isDoneSignalPath && typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
      if (isMissingDoneSignal) {
        return null;
      }
      if (!isDoneSignalPath || attempt === maxAttempts) {
        return null;
      }
    }
    await new Promise((resolve5) => setTimeout(resolve5, 25));
  }
  return null;
}
function parseWorkerIndex(workerNameValue) {
  const match = workerNameValue.match(/^worker-(\d+)$/);
  if (!match) return 0;
  const parsed = Number.parseInt(match[1], 10) - 1;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
function taskPath(root, taskId) {
  return (0, import_path10.join)(root, "tasks", `${taskId}.json`);
}
async function writePanesTrackingFileIfPresent(runtime) {
  const jobId = process.env.OMC_JOB_ID;
  const omcJobsDir = process.env.OMC_JOBS_DIR;
  if (!jobId || !omcJobsDir) return;
  const panesPath = (0, import_path10.join)(omcJobsDir, `${jobId}-panes.json`);
  const tempPath = `${panesPath}.tmp`;
  await (0, import_promises3.writeFile)(
    tempPath,
    JSON.stringify({ paneIds: [...runtime.workerPaneIds], leaderPaneId: runtime.leaderPaneId }),
    "utf-8"
  );
  await (0, import_promises3.rename)(tempPath, panesPath);
}
async function readTask(root, taskId) {
  return readJsonSafe(taskPath(root, taskId));
}
async function writeTask(root, task) {
  await writeJson(taskPath(root, task.id), task);
}
async function markTaskInProgress(root, taskId, owner, teamName, cwd) {
  const result = await withTaskLock(teamName, taskId, async () => {
    const task = await readTask(root, taskId);
    if (!task || task.status !== "pending") return false;
    task.status = "in_progress";
    task.owner = owner;
    task.assignedAt = (/* @__PURE__ */ new Date()).toISOString();
    await writeTask(root, task);
    return true;
  }, { cwd });
  return result ?? false;
}
async function resetTaskToPending(root, taskId, teamName, cwd) {
  await withTaskLock(teamName, taskId, async () => {
    const task = await readTask(root, taskId);
    if (!task) return;
    task.status = "pending";
    task.owner = null;
    task.assignedAt = void 0;
    await writeTask(root, task);
  }, { cwd });
}
async function markTaskFromDone(root, teamName, cwd, taskId, status, summary) {
  await withTaskLock(teamName, taskId, async () => {
    const task = await readTask(root, taskId);
    if (!task) return;
    task.status = status;
    task.result = summary;
    task.summary = summary;
    if (status === "completed") {
      task.completedAt = (/* @__PURE__ */ new Date()).toISOString();
    } else {
      task.failedAt = (/* @__PURE__ */ new Date()).toISOString();
    }
    await writeTask(root, task);
  }, { cwd });
}
async function applyDeadPaneTransition(runtime, workerNameValue, taskId) {
  const root = stateRoot(runtime.cwd, runtime.teamName);
  const transition = await withTaskLock(runtime.teamName, taskId, async () => {
    const task = await readTask(root, taskId);
    if (!task) return { action: "skipped" };
    if (task.status === "completed" || task.status === "failed") {
      return { action: "skipped" };
    }
    if (task.status !== "in_progress" || task.owner !== workerNameValue) {
      return { action: "skipped" };
    }
    const failure = await writeTaskFailure(
      runtime.teamName,
      taskId,
      `Worker pane died before done.json was written (${workerNameValue})`,
      { cwd: runtime.cwd }
    );
    const retryCount = failure.retryCount;
    if (retryCount >= DEFAULT_MAX_TASK_RETRIES) {
      task.status = "failed";
      task.owner = workerNameValue;
      task.summary = `Worker pane died before done.json was written (${workerNameValue})`;
      task.result = task.summary;
      task.failedAt = (/* @__PURE__ */ new Date()).toISOString();
      await writeTask(root, task);
      return { action: "failed", retryCount };
    }
    task.status = "pending";
    task.owner = null;
    task.assignedAt = void 0;
    await writeTask(root, task);
    return { action: "requeued", retryCount };
  }, { cwd: runtime.cwd });
  return transition ?? { action: "skipped" };
}
async function nextPendingTaskIndex(runtime) {
  const root = stateRoot(runtime.cwd, runtime.teamName);
  const transientReadRetryAttempts = 3;
  const transientReadRetryDelayMs = 15;
  for (let i = 0; i < runtime.config.tasks.length; i++) {
    const taskId = String(i + 1);
    let task = await readTask(root, taskId);
    if (!task) {
      for (let attempt = 1; attempt < transientReadRetryAttempts; attempt++) {
        await new Promise((resolve5) => setTimeout(resolve5, transientReadRetryDelayMs));
        task = await readTask(root, taskId);
        if (task) break;
      }
    }
    if (task?.status === "pending") return i;
  }
  return null;
}
async function notifyPaneWithRetry(sessionName2, paneId, message, maxAttempts = 6, retryDelayMs = 350) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (await sendToWorker(sessionName2, paneId, message)) {
      return true;
    }
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  return false;
}
async function allTasksTerminal(runtime) {
  const root = stateRoot(runtime.cwd, runtime.teamName);
  for (let i = 0; i < runtime.config.tasks.length; i++) {
    const task = await readTask(root, String(i + 1));
    if (!task) return false;
    if (task.status !== "completed" && task.status !== "failed") return false;
  }
  return true;
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
    `{"taskId":"${taskId}","status":"completed","summary":"<brief summary>","completedAt":"<ISO timestamp>"}`,
    ``,
    `IMPORTANT: Execute ONLY the task assigned to you in this inbox. After writing done.json, exit immediately. Do not read from the task directory or claim other tasks.`
  ].join("\n");
}
async function startTeam(config) {
  const { teamName, agentTypes, tasks, cwd } = config;
  validateTeamName(teamName);
  const resolvedBinaryPaths = {};
  for (const agentType of [...new Set(agentTypes)]) {
    resolvedBinaryPaths[agentType] = resolveValidatedBinaryPath(agentType);
  }
  const root = stateRoot(cwd, teamName);
  await (0, import_promises3.mkdir)((0, import_path10.join)(root, "tasks"), { recursive: true });
  await (0, import_promises3.mkdir)((0, import_path10.join)(root, "mailbox"), { recursive: true });
  await writeJson((0, import_path10.join)(root, "config.json"), config);
  for (let i = 0; i < tasks.length; i++) {
    const taskId = String(i + 1);
    await writeJson((0, import_path10.join)(root, "tasks", `${taskId}.json`), {
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
  for (let i = 0; i < tasks.length; i++) {
    const wName = workerName(i);
    workerNames.push(wName);
    const agentType = agentTypes[i % agentTypes.length] ?? agentTypes[0] ?? "claude";
    await ensureWorkerStateDir(teamName, wName, cwd);
    await writeWorkerOverlay({
      teamName,
      workerName: wName,
      agentType,
      tasks: tasks.map((t, idx) => ({ id: String(idx + 1), subject: t.subject, description: t.description })),
      cwd
    });
  }
  const session = await createTeamSession(teamName, 0, cwd);
  const runtime = {
    teamName,
    sessionName: session.sessionName,
    leaderPaneId: session.leaderPaneId,
    config,
    workerNames,
    workerPaneIds: session.workerPaneIds,
    // initially empty []
    activeWorkers: /* @__PURE__ */ new Map(),
    cwd,
    resolvedBinaryPaths
  };
  const maxConcurrentWorkers = agentTypes.length;
  for (let i = 0; i < maxConcurrentWorkers; i++) {
    const taskIndex = await nextPendingTaskIndex(runtime);
    if (taskIndex == null) break;
    await spawnWorkerForTask(runtime, workerName(i), taskIndex);
  }
  runtime.stopWatchdog = watchdogCliWorkers(runtime, 1e3);
  return runtime;
}
async function monitorTeam(teamName, cwd, workerPaneIds) {
  validateTeamName(teamName);
  const monitorStartedAt = Date.now();
  const root = stateRoot(cwd, teamName);
  const taskScanStartedAt = Date.now();
  const taskCounts = { pending: 0, inProgress: 0, completed: 0, failed: 0 };
  try {
    const { readdir: readdir2 } = await import("fs/promises");
    const taskFiles = await readdir2((0, import_path10.join)(root, "tasks"));
    for (const f of taskFiles.filter((f2) => f2.endsWith(".json"))) {
      const task = await readJsonSafe((0, import_path10.join)(root, "tasks", f));
      if (task?.status === "pending") taskCounts.pending++;
      else if (task?.status === "in_progress") taskCounts.inProgress++;
      else if (task?.status === "completed") taskCounts.completed++;
      else if (task?.status === "failed") taskCounts.failed++;
    }
  } catch {
  }
  const listTasksMs = Date.now() - taskScanStartedAt;
  const workerScanStartedAt = Date.now();
  const workers = [];
  const deadWorkers = [];
  for (let i = 0; i < workerPaneIds.length; i++) {
    const wName = `worker-${i + 1}`;
    const paneId = workerPaneIds[i];
    const alive = await isWorkerAlive(paneId);
    const heartbeatPath = (0, import_path10.join)(root, "workers", wName, "heartbeat.json");
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
  const workerScanMs = Date.now() - workerScanStartedAt;
  let phase = "executing";
  if (taskCounts.inProgress === 0 && taskCounts.pending > 0 && taskCounts.completed === 0) {
    phase = "planning";
  } else if (taskCounts.failed > 0 && taskCounts.pending === 0 && taskCounts.inProgress === 0) {
    phase = "fixing";
  } else if (taskCounts.completed > 0 && taskCounts.pending === 0 && taskCounts.inProgress === 0 && taskCounts.failed === 0) {
    phase = "completed";
  }
  return {
    teamName,
    phase,
    workers,
    taskCounts,
    deadWorkers,
    monitorPerformance: {
      listTasksMs,
      workerScanMs,
      totalMs: Date.now() - monitorStartedAt
    }
  };
}
function watchdogCliWorkers(runtime, intervalMs) {
  let tickInFlight = false;
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 3;
  const unresponsiveCounts = /* @__PURE__ */ new Map();
  const UNRESPONSIVE_KILL_THRESHOLD = 3;
  const tick = async () => {
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      const workers = [...runtime.activeWorkers.entries()];
      if (workers.length === 0) return;
      const root = stateRoot(runtime.cwd, runtime.teamName);
      const [doneSignals, aliveResults] = await Promise.all([
        Promise.all(workers.map(([wName]) => {
          const donePath = (0, import_path10.join)(root, "workers", wName, "done.json");
          return readJsonSafe(donePath);
        })),
        Promise.all(workers.map(([, active]) => isWorkerAlive(active.paneId)))
      ]);
      for (let i = 0; i < workers.length; i++) {
        const [wName, active] = workers[i];
        const donePath = (0, import_path10.join)(root, "workers", wName, "done.json");
        const signal = doneSignals[i];
        if (signal) {
          unresponsiveCounts.delete(wName);
          await markTaskFromDone(root, runtime.teamName, runtime.cwd, signal.taskId || active.taskId, signal.status, signal.summary);
          try {
            const { unlink: unlink2 } = await import("fs/promises");
            await unlink2(donePath);
          } catch {
          }
          await killWorkerPane(runtime, wName, active.paneId);
          if (!await allTasksTerminal(runtime)) {
            const nextTaskIndexValue = await nextPendingTaskIndex(runtime);
            if (nextTaskIndexValue != null) {
              await spawnWorkerForTask(runtime, wName, nextTaskIndexValue);
            }
          }
          continue;
        }
        const alive = aliveResults[i];
        if (!alive) {
          unresponsiveCounts.delete(wName);
          const transition = await applyDeadPaneTransition(runtime, wName, active.taskId);
          if (transition.action === "requeued") {
            const retryCount = transition.retryCount ?? 1;
            console.warn(`[watchdog] worker ${wName} dead pane \u2014 requeuing task ${active.taskId} (retry ${retryCount}/${DEFAULT_MAX_TASK_RETRIES})`);
          }
          await killWorkerPane(runtime, wName, active.paneId);
          if (!await allTasksTerminal(runtime)) {
            const nextTaskIndexValue = await nextPendingTaskIndex(runtime);
            if (nextTaskIndexValue != null) {
              await spawnWorkerForTask(runtime, wName, nextTaskIndexValue);
            }
          }
          continue;
        }
        const heartbeatPath = (0, import_path10.join)(root, "workers", wName, "heartbeat.json");
        const heartbeat = await readJsonSafe(heartbeatPath);
        const isStalled = heartbeat?.updatedAt ? Date.now() - new Date(heartbeat.updatedAt).getTime() > 6e4 : false;
        if (isStalled) {
          const count = (unresponsiveCounts.get(wName) ?? 0) + 1;
          unresponsiveCounts.set(wName, count);
          if (count < UNRESPONSIVE_KILL_THRESHOLD) {
            console.warn(`[watchdog] worker ${wName} unresponsive (${count}/${UNRESPONSIVE_KILL_THRESHOLD}), task ${active.taskId}`);
          } else {
            console.warn(`[watchdog] worker ${wName} unresponsive ${count} consecutive ticks \u2014 killing and reassigning task ${active.taskId}`);
            unresponsiveCounts.delete(wName);
            const transition = await applyDeadPaneTransition(runtime, wName, active.taskId);
            if (transition.action === "requeued") {
              console.warn(`[watchdog] worker ${wName} stall-killed \u2014 requeuing task ${active.taskId} (retry ${transition.retryCount}/${DEFAULT_MAX_TASK_RETRIES})`);
            }
            await killWorkerPane(runtime, wName, active.paneId);
            if (!await allTasksTerminal(runtime)) {
              const nextTaskIndexValue = await nextPendingTaskIndex(runtime);
              if (nextTaskIndexValue != null) {
                await spawnWorkerForTask(runtime, wName, nextTaskIndexValue);
              }
            }
          }
        } else {
          unresponsiveCounts.delete(wName);
        }
      }
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures++;
      console.warn("[watchdog] tick error:", err);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.warn(`[watchdog] ${consecutiveFailures} consecutive failures \u2014 marking team as failed`);
        try {
          const root = stateRoot(runtime.cwd, runtime.teamName);
          await writeJson((0, import_path10.join)(root, "watchdog-failed.json"), {
            failedAt: (/* @__PURE__ */ new Date()).toISOString(),
            consecutiveFailures,
            lastError: err instanceof Error ? err.message : String(err)
          });
        } catch {
        }
        clearInterval(intervalId);
      }
    } finally {
      tickInFlight = false;
    }
  };
  const intervalId = setInterval(() => {
    tick();
  }, intervalMs);
  return () => clearInterval(intervalId);
}
async function spawnWorkerForTask(runtime, workerNameValue, taskIndex) {
  const root = stateRoot(runtime.cwd, runtime.teamName);
  const taskId = String(taskIndex + 1);
  const task = runtime.config.tasks[taskIndex];
  if (!task) return "";
  const marked = await markTaskInProgress(root, taskId, workerNameValue, runtime.teamName, runtime.cwd);
  if (!marked) return "";
  const { execFile: execFile2 } = await import("child_process");
  const { promisify: promisify2 } = await import("util");
  const execFileAsync = promisify2(execFile2);
  const splitTarget = runtime.workerPaneIds.length === 0 ? runtime.leaderPaneId : runtime.workerPaneIds[runtime.workerPaneIds.length - 1];
  const splitType = runtime.workerPaneIds.length === 0 ? "-h" : "-v";
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
    runtime.cwd
  ]);
  const paneId = splitResult.stdout.split("\n")[0]?.trim();
  if (!paneId) return "";
  const workerIndex = parseWorkerIndex(workerNameValue);
  const agentType = runtime.config.agentTypes[workerIndex % runtime.config.agentTypes.length] ?? runtime.config.agentTypes[0] ?? "claude";
  const usePromptMode = isPromptModeAgent(agentType);
  const instruction = buildInitialTaskInstruction(runtime.teamName, workerNameValue, task, taskId);
  await composeInitialInbox(runtime.teamName, workerNameValue, instruction, runtime.cwd);
  const relInboxPath = `.omc/state/team/${runtime.teamName}/workers/${workerNameValue}/inbox.md`;
  const envVars = getWorkerEnv(runtime.teamName, workerNameValue, agentType);
  const resolvedBinaryPath = runtime.resolvedBinaryPaths?.[agentType] ?? resolveValidatedBinaryPath(agentType);
  if (!runtime.resolvedBinaryPaths) {
    runtime.resolvedBinaryPaths = {};
  }
  runtime.resolvedBinaryPaths[agentType] = resolvedBinaryPath;
  const modelForAgent = (() => {
    if (agentType === "codex") {
      return process.env.OMC_EXTERNAL_MODELS_DEFAULT_CODEX_MODEL || process.env.OMC_CODEX_DEFAULT_MODEL || void 0;
    }
    if (agentType === "gemini") {
      return process.env.OMC_EXTERNAL_MODELS_DEFAULT_GEMINI_MODEL || process.env.OMC_GEMINI_DEFAULT_MODEL || void 0;
    }
    return void 0;
  })();
  const [launchBinary, ...launchArgs] = buildWorkerArgv(agentType, {
    teamName: runtime.teamName,
    workerName: workerNameValue,
    cwd: runtime.cwd,
    resolvedBinaryPath,
    model: modelForAgent
  });
  if (usePromptMode) {
    const promptArgs = getPromptModeArgs(agentType, `Read and execute your task from: ${relInboxPath}`);
    launchArgs.push(...promptArgs);
  }
  const paneConfig = {
    teamName: runtime.teamName,
    workerName: workerNameValue,
    envVars,
    launchBinary,
    launchArgs,
    cwd: runtime.cwd
  };
  await spawnWorkerInPane(runtime.sessionName, paneId, paneConfig);
  runtime.workerPaneIds.push(paneId);
  runtime.activeWorkers.set(workerNameValue, { paneId, taskId, spawnedAt: Date.now() });
  try {
    await execFileAsync("tmux", ["select-layout", "-t", runtime.sessionName, "main-vertical"]);
  } catch {
  }
  try {
    await writePanesTrackingFileIfPresent(runtime);
  } catch {
  }
  if (!usePromptMode) {
    const paneReady = await waitForPaneReady(paneId);
    if (!paneReady) {
      await killWorkerPane(runtime, workerNameValue, paneId);
      await resetTaskToPending(root, taskId, runtime.teamName, runtime.cwd);
      throw new Error(`worker_pane_not_ready:${workerNameValue}`);
    }
    if (agentType === "gemini") {
      const confirmed = await notifyPaneWithRetry(runtime.sessionName, paneId, "1");
      if (!confirmed) {
        await killWorkerPane(runtime, workerNameValue, paneId);
        await resetTaskToPending(root, taskId, runtime.teamName, runtime.cwd);
        throw new Error(`worker_notify_failed:${workerNameValue}:trust-confirm`);
      }
      await new Promise((r) => setTimeout(r, 800));
    }
    const notified = await notifyPaneWithRetry(
      runtime.sessionName,
      paneId,
      `Read and execute your task from: ${relInboxPath}`
    );
    if (!notified) {
      await killWorkerPane(runtime, workerNameValue, paneId);
      await resetTaskToPending(root, taskId, runtime.teamName, runtime.cwd);
      throw new Error(`worker_notify_failed:${workerNameValue}:initial-inbox`);
    }
  }
  return paneId;
}
async function killWorkerPane(runtime, workerNameValue, paneId) {
  try {
    const { execFile: execFile2 } = await import("child_process");
    const { promisify: promisify2 } = await import("util");
    const execFileAsync = promisify2(execFile2);
    await execFileAsync("tmux", ["kill-pane", "-t", paneId]);
  } catch {
  }
  const paneIndex = runtime.workerPaneIds.indexOf(paneId);
  if (paneIndex >= 0) {
    runtime.workerPaneIds.splice(paneIndex, 1);
  }
  runtime.activeWorkers.delete(workerNameValue);
  try {
    await writePanesTrackingFileIfPresent(runtime);
  } catch {
  }
}
async function shutdownTeam(teamName, sessionName2, cwd, timeoutMs = 3e4, workerPaneIds, leaderPaneId) {
  const root = stateRoot(cwd, teamName);
  await writeJson((0, import_path10.join)(root, "shutdown.json"), {
    requestedAt: (/* @__PURE__ */ new Date()).toISOString(),
    teamName
  });
  const configData = await readJsonSafe((0, import_path10.join)(root, "config.json"));
  const CLI_AGENT_TYPES = /* @__PURE__ */ new Set(["claude", "codex", "gemini"]);
  const agentTypes = configData?.agentTypes ?? [];
  const isCliWorkerTeam = agentTypes.length > 0 && agentTypes.every((t) => CLI_AGENT_TYPES.has(t));
  if (!isCliWorkerTeam) {
    const deadline = Date.now() + timeoutMs;
    const workerCount = configData?.workerCount ?? 0;
    const expectedAcks = Array.from({ length: workerCount }, (_, i) => `worker-${i + 1}`);
    while (Date.now() < deadline && expectedAcks.length > 0) {
      for (const wName of [...expectedAcks]) {
        const ackPath = (0, import_path10.join)(root, "workers", wName, "shutdown-ack.json");
        if ((0, import_fs6.existsSync)(ackPath)) {
          expectedAcks.splice(expectedAcks.indexOf(wName), 1);
        }
      }
      if (expectedAcks.length > 0) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
  await killTeamSession(sessionName2, workerPaneIds, leaderPaneId);
  try {
    await (0, import_promises3.rm)(root, { recursive: true, force: true });
  } catch {
  }
}

// src/hooks/factcheck/checks.ts
var import_fs7 = require("fs");
var import_path11 = require("path");

// src/hooks/factcheck/types.ts
var REQUIRED_FIELDS = /* @__PURE__ */ new Set([
  "schema_version",
  "run_id",
  "ts",
  "cwd",
  "mode",
  "files_modified",
  "files_created",
  "artifacts_expected",
  "gates"
]);
var REQUIRED_GATES = /* @__PURE__ */ new Set([
  "selftest_ran",
  "goldens_ran",
  "sentinel_stop_smoke_ran",
  "shadow_leak_check_ran"
]);

// src/hooks/factcheck/checks.ts
function checkMissingFields(claims) {
  const missing = [];
  for (const field of REQUIRED_FIELDS) {
    if (!(field in claims)) {
      missing.push(field);
    }
  }
  return missing.sort();
}
function checkMissingGates(claims) {
  const gates = claims.gates ?? {};
  const missing = [];
  for (const gate of REQUIRED_GATES) {
    if (!(gate in gates)) {
      missing.push(gate);
    }
  }
  return missing.sort();
}
function getFalseGates(claims) {
  const gates = claims.gates ?? {};
  const falseGates = [];
  for (const gate of REQUIRED_GATES) {
    if (gate in gates && !gates[gate]) {
      falseGates.push(gate);
    }
  }
  return falseGates.sort();
}
function sourceFileCount(claims) {
  const modified = claims.files_modified ?? [];
  const created = claims.files_created ?? [];
  return modified.length + created.length;
}
function checkPaths(claims, policy) {
  const out = [];
  const allPaths = [
    ...claims.files_modified ?? [],
    ...claims.files_created ?? [],
    ...claims.artifacts_expected ?? []
  ];
  const deleted = new Set(claims.files_deleted ?? []);
  for (const pathStr of allPaths) {
    if (deleted.has(pathStr)) continue;
    let prefixBlocked = false;
    for (const prefix of policy.forbidden_path_prefixes) {
      if (pathStr.startsWith(prefix)) {
        out.push({ check: "H", severity: "FAIL", detail: `Forbidden path prefix: ${pathStr}` });
        prefixBlocked = true;
        break;
      }
    }
    if (!prefixBlocked) {
      for (const fragment of policy.forbidden_path_substrings) {
        if (pathStr.includes(fragment)) {
          out.push({ check: "H", severity: "FAIL", detail: `Forbidden path fragment: ${pathStr}` });
          break;
        }
      }
    }
    if (!(0, import_fs7.existsSync)(pathStr)) {
      out.push({ check: "C", severity: "FAIL", detail: `File not found: ${pathStr}` });
    }
  }
  return out;
}
function checkCommands(claims, policy) {
  const out = [];
  const commands = (claims.commands_executed ?? []).map(String);
  for (const cmd of commands) {
    const hitPrefix = policy.forbidden_path_prefixes.some(
      (forbidden) => cmd.includes(forbidden)
    );
    if (!hitPrefix) continue;
    const stripped = cmd.trim().replace(/^\(/, "");
    const isReadOnly = policy.readonly_command_prefixes.some(
      (prefix) => stripped.startsWith(prefix)
    );
    if (!isReadOnly) {
      out.push({ check: "H", severity: "FAIL", detail: `Forbidden mutating command: ${cmd}` });
    }
  }
  return out;
}
function checkCwdParity(claimsCwd, runtimeCwd, mode, policy) {
  const enforceCwd = policy.warn_on_cwd_mismatch && (mode !== "quick" || policy.enforce_cwd_parity_in_quick);
  if (!enforceCwd || !claimsCwd) return null;
  const claimsCwdCanonical = (0, import_path11.resolve)(claimsCwd);
  const runtimeCwdCanonical = (0, import_path11.resolve)(runtimeCwd);
  if (claimsCwdCanonical !== runtimeCwdCanonical) {
    const severity = mode === "strict" ? "FAIL" : "WARN";
    return {
      check: "argv_parity",
      severity,
      detail: `claims.cwd=${claimsCwdCanonical} runtime.cwd=${runtimeCwdCanonical}`
    };
  }
  return null;
}

// src/hooks/factcheck/config.ts
var import_os2 = require("os");

// src/config/loader.ts
var import_fs8 = require("fs");
var import_path12 = require("path");

// src/utils/jsonc.ts
function parseJsonc(content) {
  const cleaned = stripJsoncComments(content);
  return JSON.parse(cleaned);
}
function stripJsoncComments(content) {
  let result = "";
  let i = 0;
  while (i < content.length) {
    if (content[i] === "/" && content[i + 1] === "/") {
      while (i < content.length && content[i] !== "\n") {
        i++;
      }
      continue;
    }
    if (content[i] === "/" && content[i + 1] === "*") {
      i += 2;
      while (i < content.length && !(content[i] === "*" && content[i + 1] === "/")) {
        i++;
      }
      i += 2;
      continue;
    }
    if (content[i] === '"') {
      result += content[i];
      i++;
      while (i < content.length && content[i] !== '"') {
        if (content[i] === "\\" && content[i + 1] === '"') {
          result += content[i];
          i++;
        }
        result += content[i];
        i++;
      }
      if (i < content.length) {
        result += content[i];
        i++;
      }
      continue;
    }
    result += content[i];
    i++;
  }
  return result;
}

// src/utils/ssrf-guard.ts
var BLOCKED_HOST_PATTERNS = [
  // Exact matches
  /^localhost$/i,
  /^127\.[0-9]+\.[0-9]+\.[0-9]+$/,
  // Loopback
  /^10\.[0-9]+\.[0-9]+\.[0-9]+$/,
  // Class A private
  /^172\.(1[6-9]|2[0-9]|3[0-1])\.[0-9]+\.[0-9]+$/,
  // Class B private
  /^192\.168\.[0-9]+\.[0-9]+$/,
  // Class C private
  /^169\.254\.[0-9]+\.[0-9]+$/,
  // Link-local
  /^(0|22[4-9]|23[0-9])\.[0-9]+\.[0-9]+\.[0-9]+$/,
  // Multicast, reserved
  /^\[?::1\]?$/,
  // IPv6 loopback
  /^\[?fc00:/i,
  // IPv6 unique local
  /^\[?fe80:/i
  // IPv6 link-local
];
var ALLOWED_SCHEMES = ["https:", "http:"];
function validateUrlForSSRF(urlString) {
  if (!urlString || typeof urlString !== "string") {
    return { allowed: false, reason: "URL is empty or invalid" };
  }
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    return { allowed: false, reason: "Invalid URL format" };
  }
  if (!ALLOWED_SCHEMES.includes(parsed.protocol)) {
    return { allowed: false, reason: `Protocol '${parsed.protocol}' is not allowed` };
  }
  const hostname = parsed.hostname.toLowerCase();
  for (const pattern of BLOCKED_HOST_PATTERNS) {
    if (pattern.test(hostname)) {
      return {
        allowed: false,
        reason: `Hostname '${hostname}' resolves to a blocked internal/private address`
      };
    }
  }
  if (parsed.username || parsed.password) {
    return { allowed: false, reason: "URLs with embedded credentials are not allowed" };
  }
  const dangerousPaths = [
    "/metadata",
    "/meta-data",
    "/latest/meta-data",
    "/computeMetadata"
  ];
  const pathLower = parsed.pathname.toLowerCase();
  for (const dangerous of dangerousPaths) {
    if (pathLower.startsWith(dangerous)) {
      return {
        allowed: false,
        reason: `Path '${parsed.pathname}' is blocked (cloud metadata access)`
      };
    }
  }
  return { allowed: true };
}
function validateAnthropicBaseUrl(urlString) {
  const result = validateUrlForSSRF(urlString);
  if (!result.allowed) {
    return result;
  }
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    return { allowed: false, reason: "Invalid URL" };
  }
  if (parsed.protocol === "http:") {
    console.warn("[SSRF Guard] Warning: Using HTTP instead of HTTPS for ANTHROPIC_BASE_URL");
  }
  return { allowed: true };
}

// src/config/models.ts
var BUILTIN_MODEL_HIGH = "claude-opus-4-6-20260205";
var BUILTIN_MODEL_MEDIUM = "claude-sonnet-4-6-20260217";
var BUILTIN_MODEL_LOW = "claude-haiku-4-5-20251001";
function getDefaultModelHigh() {
  return process.env.OMC_MODEL_HIGH || BUILTIN_MODEL_HIGH;
}
function getDefaultModelMedium() {
  return process.env.OMC_MODEL_MEDIUM || BUILTIN_MODEL_MEDIUM;
}
function getDefaultModelLow() {
  return process.env.OMC_MODEL_LOW || BUILTIN_MODEL_LOW;
}
function isBedrock() {
  if (process.env.CLAUDE_CODE_USE_BEDROCK === "1") {
    return true;
  }
  const modelId = process.env.CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || "";
  if (modelId && /^((us|eu|ap|global)\.anthropic\.|anthropic\.claude)/i.test(modelId)) {
    return true;
  }
  return false;
}
function isVertexAI() {
  if (process.env.CLAUDE_CODE_USE_VERTEX === "1") {
    return true;
  }
  const modelId = process.env.CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || "";
  if (modelId && modelId.toLowerCase().startsWith("vertex_ai/")) {
    return true;
  }
  return false;
}
function isNonClaudeProvider() {
  if (process.env.OMC_ROUTING_FORCE_INHERIT === "true") {
    return true;
  }
  if (isBedrock()) {
    return true;
  }
  if (isVertexAI()) {
    return true;
  }
  const modelId = process.env.CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || "";
  if (modelId && !modelId.toLowerCase().includes("claude")) {
    return true;
  }
  const baseUrl = process.env.ANTHROPIC_BASE_URL || "";
  if (baseUrl) {
    const validation = validateAnthropicBaseUrl(baseUrl);
    if (!validation.allowed) {
      console.error(`[SSRF Guard] Rejecting ANTHROPIC_BASE_URL: ${validation.reason}`);
      return true;
    }
    if (!baseUrl.includes("anthropic.com")) {
      return true;
    }
  }
  return false;
}

// src/config/loader.ts
var DEFAULT_CONFIG = {
  agents: {
    omc: { model: getDefaultModelHigh() },
    explore: { model: getDefaultModelLow() },
    analyst: { model: getDefaultModelHigh() },
    planner: { model: getDefaultModelHigh() },
    architect: { model: getDefaultModelHigh() },
    debugger: { model: getDefaultModelMedium() },
    executor: { model: getDefaultModelMedium() },
    verifier: { model: getDefaultModelMedium() },
    qualityReviewer: { model: getDefaultModelMedium() },
    securityReviewer: { model: getDefaultModelMedium() },
    codeReviewer: { model: getDefaultModelHigh() },
    deepExecutor: { model: getDefaultModelHigh() },
    testEngineer: { model: getDefaultModelMedium() },
    buildFixer: { model: getDefaultModelMedium() },
    designer: { model: getDefaultModelMedium() },
    writer: { model: getDefaultModelLow() },
    qaTester: { model: getDefaultModelMedium() },
    scientist: { model: getDefaultModelMedium() },
    gitMaster: { model: getDefaultModelMedium() },
    codeSimplifier: { model: getDefaultModelHigh() },
    critic: { model: getDefaultModelHigh() },
    documentSpecialist: { model: getDefaultModelMedium() }
  },
  features: {
    parallelExecution: true,
    lspTools: true,
    // Real LSP integration with language servers
    astTools: true,
    // Real AST tools using ast-grep
    continuationEnforcement: true,
    autoContextInjection: true
  },
  mcpServers: {
    exa: { enabled: true },
    context7: { enabled: true }
  },
  permissions: {
    allowBash: true,
    allowEdit: true,
    allowWrite: true,
    maxBackgroundTasks: 5
  },
  magicKeywords: {
    ultrawork: ["ultrawork", "ulw", "uw"],
    search: ["search", "find", "locate"],
    analyze: ["analyze", "investigate", "examine"],
    ultrathink: ["ultrathink", "think", "reason", "ponder"]
  },
  // Intelligent model routing configuration
  routing: {
    enabled: true,
    defaultTier: "MEDIUM",
    forceInherit: false,
    escalationEnabled: true,
    maxEscalations: 2,
    tierModels: {
      LOW: getDefaultModelLow(),
      MEDIUM: getDefaultModelMedium(),
      HIGH: getDefaultModelHigh()
    },
    agentOverrides: {
      architect: { tier: "HIGH", reason: "Advisory agent requires deep reasoning" },
      planner: { tier: "HIGH", reason: "Strategic planning requires deep reasoning" },
      critic: { tier: "HIGH", reason: "Critical review requires deep reasoning" },
      analyst: { tier: "HIGH", reason: "Pre-planning analysis requires deep reasoning" },
      explore: { tier: "LOW", reason: "Exploration is search-focused" },
      "writer": { tier: "LOW", reason: "Documentation is straightforward" }
    },
    escalationKeywords: [
      "critical",
      "production",
      "urgent",
      "security",
      "breaking",
      "architecture",
      "refactor",
      "redesign",
      "root cause"
    ],
    simplificationKeywords: [
      "find",
      "list",
      "show",
      "where",
      "search",
      "locate",
      "grep"
    ]
  },
  // External models configuration (Codex, Gemini)
  // Static defaults only — env var overrides applied in loadEnvConfig()
  externalModels: {
    defaults: {
      codexModel: "gpt-5.3-codex",
      geminiModel: "gemini-3.1-pro-preview"
    },
    fallbackPolicy: {
      onModelFailure: "provider_chain",
      allowCrossProvider: false,
      crossProviderOrder: ["codex", "gemini"]
    }
  },
  // Delegation routing configuration (opt-in feature for external model routing)
  delegationRouting: {
    enabled: false,
    // Opt-in feature
    defaultProvider: "claude",
    roles: {}
  },
  // Startup codebase map injection (issue #804)
  startupCodebaseMap: {
    enabled: true,
    maxFiles: 200,
    maxDepth: 4
  },
  // Task size detection (issue #790): prevent over-orchestration for small tasks
  taskSizeDetection: {
    enabled: true,
    smallWordLimit: 50,
    largeWordLimit: 200,
    suppressHeavyModesForSmallTasks: true
  }
};
function getConfigPaths() {
  const userConfigDir = getConfigDir2();
  return {
    user: (0, import_path12.join)(userConfigDir, "claude-omc", "config.jsonc"),
    project: (0, import_path12.join)(process.cwd(), ".claude", "omc.jsonc")
  };
}
function loadJsoncFile(path) {
  if (!(0, import_fs8.existsSync)(path)) {
    return null;
  }
  try {
    const content = (0, import_fs8.readFileSync)(path, "utf-8");
    const result = parseJsonc(content);
    return result;
  } catch (error) {
    console.error(`Error loading config from ${path}:`, error);
    return null;
  }
}
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sourceValue = source[key];
    const targetValue = result[key];
    if (sourceValue !== void 0 && typeof sourceValue === "object" && sourceValue !== null && !Array.isArray(sourceValue) && typeof targetValue === "object" && targetValue !== null && !Array.isArray(targetValue)) {
      result[key] = deepMerge(
        targetValue,
        sourceValue
      );
    } else if (sourceValue !== void 0) {
      result[key] = sourceValue;
    }
  }
  return result;
}
function loadEnvConfig() {
  const config = {};
  if (process.env.EXA_API_KEY) {
    config.mcpServers = {
      ...config.mcpServers,
      exa: { enabled: true, apiKey: process.env.EXA_API_KEY }
    };
  }
  if (process.env.OMC_PARALLEL_EXECUTION !== void 0) {
    config.features = {
      ...config.features,
      parallelExecution: process.env.OMC_PARALLEL_EXECUTION === "true"
    };
  }
  if (process.env.OMC_LSP_TOOLS !== void 0) {
    config.features = {
      ...config.features,
      lspTools: process.env.OMC_LSP_TOOLS === "true"
    };
  }
  if (process.env.OMC_MAX_BACKGROUND_TASKS) {
    const maxTasks = parseInt(process.env.OMC_MAX_BACKGROUND_TASKS, 10);
    if (!isNaN(maxTasks)) {
      config.permissions = {
        ...config.permissions,
        maxBackgroundTasks: maxTasks
      };
    }
  }
  if (process.env.OMC_ROUTING_ENABLED !== void 0) {
    config.routing = {
      ...config.routing,
      enabled: process.env.OMC_ROUTING_ENABLED === "true"
    };
  }
  if (process.env.OMC_ROUTING_FORCE_INHERIT !== void 0) {
    config.routing = {
      ...config.routing,
      forceInherit: process.env.OMC_ROUTING_FORCE_INHERIT === "true"
    };
  }
  if (process.env.OMC_ROUTING_DEFAULT_TIER) {
    const tier = process.env.OMC_ROUTING_DEFAULT_TIER.toUpperCase();
    if (tier === "LOW" || tier === "MEDIUM" || tier === "HIGH") {
      config.routing = {
        ...config.routing,
        defaultTier: tier
      };
    }
  }
  const aliasKeys = ["HAIKU", "SONNET", "OPUS"];
  const modelAliases = {};
  for (const key of aliasKeys) {
    const envVal = process.env[`OMC_MODEL_ALIAS_${key}`];
    if (envVal) {
      const lower = key.toLowerCase();
      modelAliases[lower] = envVal.toLowerCase();
    }
  }
  if (Object.keys(modelAliases).length > 0) {
    config.routing = {
      ...config.routing,
      modelAliases
    };
  }
  if (process.env.OMC_ESCALATION_ENABLED !== void 0) {
    config.routing = {
      ...config.routing,
      escalationEnabled: process.env.OMC_ESCALATION_ENABLED === "true"
    };
  }
  const externalModelsDefaults = {};
  if (process.env.OMC_EXTERNAL_MODELS_DEFAULT_PROVIDER) {
    const provider = process.env.OMC_EXTERNAL_MODELS_DEFAULT_PROVIDER;
    if (provider === "codex" || provider === "gemini") {
      externalModelsDefaults.provider = provider;
    }
  }
  if (process.env.OMC_EXTERNAL_MODELS_DEFAULT_CODEX_MODEL) {
    externalModelsDefaults.codexModel = process.env.OMC_EXTERNAL_MODELS_DEFAULT_CODEX_MODEL;
  } else if (process.env.OMC_CODEX_DEFAULT_MODEL) {
    externalModelsDefaults.codexModel = process.env.OMC_CODEX_DEFAULT_MODEL;
  }
  if (process.env.OMC_EXTERNAL_MODELS_DEFAULT_GEMINI_MODEL) {
    externalModelsDefaults.geminiModel = process.env.OMC_EXTERNAL_MODELS_DEFAULT_GEMINI_MODEL;
  } else if (process.env.OMC_GEMINI_DEFAULT_MODEL) {
    externalModelsDefaults.geminiModel = process.env.OMC_GEMINI_DEFAULT_MODEL;
  }
  const externalModelsFallback = {
    onModelFailure: "provider_chain"
  };
  if (process.env.OMC_EXTERNAL_MODELS_FALLBACK_POLICY) {
    const policy = process.env.OMC_EXTERNAL_MODELS_FALLBACK_POLICY;
    if (policy === "provider_chain" || policy === "cross_provider" || policy === "claude_only") {
      externalModelsFallback.onModelFailure = policy;
    }
  }
  if (Object.keys(externalModelsDefaults).length > 0 || externalModelsFallback.onModelFailure !== "provider_chain") {
    config.externalModels = {
      defaults: externalModelsDefaults,
      fallbackPolicy: externalModelsFallback
    };
  }
  if (process.env.OMC_DELEGATION_ROUTING_ENABLED !== void 0) {
    config.delegationRouting = {
      ...config.delegationRouting,
      enabled: process.env.OMC_DELEGATION_ROUTING_ENABLED === "true"
    };
  }
  if (process.env.OMC_DELEGATION_ROUTING_DEFAULT_PROVIDER) {
    const provider = process.env.OMC_DELEGATION_ROUTING_DEFAULT_PROVIDER;
    if (["claude", "codex", "gemini"].includes(provider)) {
      config.delegationRouting = {
        ...config.delegationRouting,
        defaultProvider: provider
      };
    }
  }
  return config;
}
function loadConfig() {
  const paths = getConfigPaths();
  let config = { ...DEFAULT_CONFIG };
  const userConfig = loadJsoncFile(paths.user);
  if (userConfig) {
    config = deepMerge(config, userConfig);
  }
  const projectConfig = loadJsoncFile(paths.project);
  if (projectConfig) {
    config = deepMerge(config, projectConfig);
  }
  const envConfig = loadEnvConfig();
  config = deepMerge(config, envConfig);
  if (config.routing?.forceInherit !== true && process.env.OMC_ROUTING_FORCE_INHERIT === void 0 && isNonClaudeProvider()) {
    config.routing = {
      ...config.routing,
      forceInherit: true
    };
  }
  return config;
}

// src/hooks/factcheck/config.ts
var DEFAULT_FACTCHECK_POLICY = {
  enabled: false,
  mode: "quick",
  strict_project_patterns: [],
  forbidden_path_prefixes: ["${HOME}/.claude/plugins/cache/omc/"],
  forbidden_path_substrings: ["/.omc/", ".omc-config.json"],
  readonly_command_prefixes: [
    "ls ",
    "cat ",
    "find ",
    "grep ",
    "head ",
    "tail ",
    "stat ",
    "echo ",
    "wc "
  ],
  warn_on_cwd_mismatch: true,
  enforce_cwd_parity_in_quick: false,
  warn_on_unverified_gates: true,
  warn_on_unverified_gates_when_no_source_files: false
};
var DEFAULT_SENTINEL_POLICY = {
  enabled: false,
  readiness: {
    min_pass_rate: 0.6,
    max_timeout_rate: 0.1,
    max_warn_plus_fail_rate: 0.4,
    min_reason_coverage_rate: 0.95
  }
};
var DEFAULT_GUARDS_CONFIG = {
  factcheck: { ...DEFAULT_FACTCHECK_POLICY },
  sentinel: { ...DEFAULT_SENTINEL_POLICY }
};
function expandTokens(value, workspace) {
  const home = (0, import_os2.homedir)();
  const ws = workspace ?? process.env.OMC_WORKSPACE ?? process.cwd();
  return value.replace(/\$\{HOME\}/g, home).replace(/\$\{WORKSPACE\}/g, ws);
}
function expandTokensDeep(obj, workspace) {
  if (typeof obj === "string") {
    return expandTokens(obj, workspace);
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => expandTokensDeep(item, workspace));
  }
  if (typeof obj === "object" && obj !== null) {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = expandTokensDeep(value, workspace);
    }
    return result;
  }
  return obj;
}
function deepMergeGuards(target, source) {
  const result = { ...target };
  if (source.factcheck) {
    result.factcheck = { ...result.factcheck, ...source.factcheck };
  }
  if (source.sentinel) {
    result.sentinel = {
      ...result.sentinel,
      ...source.sentinel,
      readiness: {
        ...result.sentinel.readiness,
        ...source.sentinel.readiness ?? {}
      }
    };
  }
  return result;
}
function loadGuardsConfig(workspace) {
  try {
    const fullConfig = loadConfig();
    const guardsRaw = fullConfig.guards ?? {};
    const merged = deepMergeGuards(DEFAULT_GUARDS_CONFIG, guardsRaw);
    return expandTokensDeep(merged, workspace);
  } catch {
    return expandTokensDeep({ ...DEFAULT_GUARDS_CONFIG }, workspace);
  }
}

// src/hooks/factcheck/index.ts
function severityRank(value) {
  if (value === "FAIL") return 2;
  if (value === "WARN") return 1;
  return 0;
}
function runChecks(claims, mode, policy, runtimeCwd) {
  const mismatches = [];
  const notes = [];
  const missingFields = checkMissingFields(claims);
  if (missingFields.length > 0) {
    mismatches.push({
      check: "A",
      severity: "FAIL",
      detail: `Missing required fields: ${JSON.stringify(missingFields)}`
    });
  }
  const missingGates = checkMissingGates(claims);
  if (missingGates.length > 0) {
    mismatches.push({
      check: "A",
      severity: "FAIL",
      detail: `Missing required gates: ${JSON.stringify(missingGates)}`
    });
  }
  const falseGates = getFalseGates(claims);
  const srcFiles = sourceFileCount(claims);
  if (mode === "strict" && falseGates.length > 0) {
    mismatches.push({
      check: "B",
      severity: "FAIL",
      detail: `Strict mode requires all gates true, got false: ${JSON.stringify(falseGates)}`
    });
  } else if ((mode === "declared" || mode === "manual") && falseGates.length > 0 && policy.warn_on_unverified_gates) {
    if (srcFiles > 0 || policy.warn_on_unverified_gates_when_no_source_files) {
      mismatches.push({
        check: "B",
        severity: "WARN",
        detail: `Unverified gates in declared/manual mode: ${JSON.stringify(falseGates)}`
      });
    } else {
      notes.push("No source files declared; unverified gates are ignored by policy");
    }
  }
  mismatches.push(...checkPaths(claims, policy));
  mismatches.push(...checkCommands(claims, policy));
  const claimsCwd = String(claims.cwd ?? "").trim();
  const cwdMismatch = checkCwdParity(
    claimsCwd,
    runtimeCwd ?? process.cwd(),
    mode,
    policy
  );
  if (cwdMismatch) {
    mismatches.push(cwdMismatch);
  }
  const maxRank = mismatches.reduce(
    (max, m) => Math.max(max, severityRank(m.severity)),
    0
  );
  let verdict = "PASS";
  if (maxRank === 2) verdict = "FAIL";
  else if (maxRank === 1) verdict = "WARN";
  return {
    verdict,
    mode,
    mismatches,
    notes,
    claims_evidence: {
      source_files: srcFiles,
      commands_count: (claims.commands_executed ?? []).length,
      models_count: (claims.models_used ?? []).length
    }
  };
}
function runFactcheck(claims, options) {
  const config = loadGuardsConfig(options?.workspace);
  const mode = options?.mode ?? config.factcheck.mode;
  return runChecks(claims, mode, config.factcheck, options?.runtimeCwd);
}

// src/hooks/factcheck/sentinel.ts
var import_fs9 = require("fs");
function computeRate(numerator, denominator) {
  if (denominator === 0) return 0;
  return numerator / denominator;
}
function getPassRate(stats) {
  return computeRate(stats.pass_count, stats.total_runs);
}
function getTimeoutRate(stats) {
  return computeRate(stats.timeout_count, stats.total_runs);
}
function getWarnPlusFailRate(stats) {
  return computeRate(stats.warn_count + stats.fail_count, stats.total_runs);
}
function getReasonCoverageRate(stats) {
  return computeRate(stats.reason_coverage_count, stats.total_runs);
}
function extractVerdict(entry) {
  const raw = String(entry.verdict ?? "").toUpperCase().trim();
  if (raw === "PASS") return "PASS";
  if (raw === "WARN") return "WARN";
  return "FAIL";
}
function hasReason(entry) {
  return !!(entry.reason || entry.error || entry.message);
}
function isTimeout(entry) {
  if (entry.runtime?.timed_out === true) return true;
  if (entry.runtime?.global_timeout === true) return true;
  const reason = String(entry.reason ?? "").toLowerCase();
  return reason.includes("timeout");
}
function analyzeLog(logPath) {
  const stats = {
    total_runs: 0,
    pass_count: 0,
    warn_count: 0,
    fail_count: 0,
    timeout_count: 0,
    reason_coverage_count: 0
  };
  if (!(0, import_fs9.existsSync)(logPath)) {
    return stats;
  }
  let content;
  try {
    content = (0, import_fs9.readFileSync)(logPath, "utf-8");
  } catch {
    return stats;
  }
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    stats.total_runs++;
    const verdict = extractVerdict(entry);
    if (verdict === "PASS") stats.pass_count++;
    else if (verdict === "WARN") stats.warn_count++;
    else stats.fail_count++;
    if (isTimeout(entry)) stats.timeout_count++;
    if (hasReason(entry)) stats.reason_coverage_count++;
  }
  return stats;
}
function isUpstreamReady(stats, policy) {
  const blockers = [];
  const passRate = getPassRate(stats);
  if (passRate < policy.min_pass_rate) {
    blockers.push(
      `pass_rate ${passRate.toFixed(3)} < min ${policy.min_pass_rate}`
    );
  }
  const timeoutRate = getTimeoutRate(stats);
  if (timeoutRate > policy.max_timeout_rate) {
    blockers.push(
      `timeout_rate ${timeoutRate.toFixed(3)} > max ${policy.max_timeout_rate}`
    );
  }
  const warnFailRate = getWarnPlusFailRate(stats);
  if (warnFailRate > policy.max_warn_plus_fail_rate) {
    blockers.push(
      `warn_plus_fail_rate ${warnFailRate.toFixed(3)} > max ${policy.max_warn_plus_fail_rate}`
    );
  }
  const reasonRate = getReasonCoverageRate(stats);
  if (reasonRate < policy.min_reason_coverage_rate) {
    blockers.push(
      `reason_coverage_rate ${reasonRate.toFixed(3)} < min ${policy.min_reason_coverage_rate}`
    );
  }
  return [blockers.length === 0, blockers];
}
function checkSentinelHealth(logPath, workspace) {
  const config = loadGuardsConfig(workspace);
  const stats = analyzeLog(logPath);
  const [ready, blockers] = isUpstreamReady(stats, config.sentinel.readiness);
  return { ready, blockers, stats };
}

// src/team/sentinel-gate.ts
function mapFactcheckToBlockers(result) {
  if (result.verdict === "PASS") {
    return [];
  }
  if (result.mismatches.length === 0) {
    return [`[factcheck] verdict ${result.verdict}`];
  }
  return result.mismatches.map(
    (mismatch) => `[factcheck] ${mismatch.severity} ${mismatch.check}: ${mismatch.detail}`
  );
}
function coerceArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  if (typeof value === "object" && !Array.isArray(value)) return [];
  return [value];
}
function sanitizeClaims(raw) {
  const out = { ...raw };
  const arrayFields = [
    "files_modified",
    "files_created",
    "files_deleted",
    "artifacts_expected",
    "commands_executed",
    "models_used"
  ];
  for (const field of arrayFields) {
    if (field in out) {
      out[field] = coerceArray(out[field]);
    }
  }
  return out;
}
function checkSentinelReadiness(options = {}) {
  const {
    logPath,
    workspace,
    claims,
    enabled = loadGuardsConfig(workspace).sentinel.enabled
  } = options;
  if (!enabled) {
    return {
      ready: true,
      blockers: [],
      skipped: true
    };
  }
  const blockers = [];
  let ranCheck = false;
  if (logPath) {
    ranCheck = true;
    const health = checkSentinelHealth(logPath, workspace);
    blockers.push(...health.blockers);
  }
  if (claims) {
    ranCheck = true;
    try {
      const sanitized = sanitizeClaims(claims);
      const factcheck = runFactcheck(sanitized, { workspace });
      blockers.push(...mapFactcheckToBlockers(factcheck));
    } catch (err) {
      blockers.push(
        `[factcheck] execution error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  if (!ranCheck) {
    return {
      ready: false,
      blockers: ["[sentinel] gate enabled but no logPath or claims provided \u2014 cannot verify readiness"],
      skipped: true
    };
  }
  const dedupedBlockers = [...new Set(blockers)];
  return {
    ready: dedupedBlockers.length === 0,
    blockers: dedupedBlockers,
    skipped: false
  };
}
async function waitForSentinelReadiness(options = {}) {
  const timeoutMs = Math.max(0, options.timeoutMs ?? 3e4);
  const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? 250);
  const startedAt = Date.now();
  let attempts = 1;
  let latest = checkSentinelReadiness(options);
  if (latest.ready) {
    return {
      ...latest,
      timedOut: false,
      elapsedMs: Date.now() - startedAt,
      attempts
    };
  }
  const deadline = startedAt + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve5) => setTimeout(resolve5, pollIntervalMs));
    attempts += 1;
    latest = checkSentinelReadiness(options);
    if (latest.ready) {
      return {
        ...latest,
        timedOut: false,
        elapsedMs: Date.now() - startedAt,
        attempts
      };
    }
  }
  const timeoutBlocker = `[sentinel] readiness check timed out after ${timeoutMs}ms`;
  const blockers = latest.blockers.includes(timeoutBlocker) ? latest.blockers : [...latest.blockers, timeoutBlocker];
  return {
    ...latest,
    blockers,
    timedOut: true,
    elapsedMs: Date.now() - startedAt,
    attempts
  };
}

// src/team/runtime-v2.ts
var import_path15 = require("path");
var import_fs12 = require("fs");
var import_promises6 = require("fs/promises");
var import_perf_hooks = require("perf_hooks");

// src/team/monitor.ts
var import_fs10 = require("fs");
var import_promises4 = require("fs/promises");
var import_path13 = require("path");
async function readJsonSafe2(filePath) {
  try {
    if (!(0, import_fs10.existsSync)(filePath)) return null;
    const raw = await (0, import_promises4.readFile)(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
async function writeAtomic(filePath, data) {
  const { writeFile: writeFile5 } = await import("fs/promises");
  await (0, import_promises4.mkdir)((0, import_path13.dirname)(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await writeFile5(tmpPath, data, "utf-8");
  const { rename: rename3 } = await import("fs/promises");
  await rename3(tmpPath, filePath);
}
async function readTeamConfig(teamName, cwd) {
  return readJsonSafe2(absPath(cwd, TeamPaths.config(teamName)));
}
async function readWorkerStatus(teamName, workerName2, cwd) {
  const data = await readJsonSafe2(absPath(cwd, TeamPaths.workerStatus(teamName, workerName2)));
  return data ?? { state: "unknown", updated_at: "" };
}
async function readWorkerHeartbeat(teamName, workerName2, cwd) {
  return readJsonSafe2(absPath(cwd, TeamPaths.heartbeat(teamName, workerName2)));
}
async function readMonitorSnapshot(teamName, cwd) {
  const p = absPath(cwd, TeamPaths.monitorSnapshot(teamName));
  if (!(0, import_fs10.existsSync)(p)) return null;
  try {
    const raw = await (0, import_promises4.readFile)(p, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const monitorTimings = (() => {
      const candidate = parsed.monitorTimings;
      if (!candidate || typeof candidate !== "object") return void 0;
      if (typeof candidate.list_tasks_ms !== "number" || typeof candidate.worker_scan_ms !== "number" || typeof candidate.mailbox_delivery_ms !== "number" || typeof candidate.total_ms !== "number" || typeof candidate.updated_at !== "string") {
        return void 0;
      }
      return candidate;
    })();
    return {
      taskStatusById: parsed.taskStatusById ?? {},
      workerAliveByName: parsed.workerAliveByName ?? {},
      workerStateByName: parsed.workerStateByName ?? {},
      workerTurnCountByName: parsed.workerTurnCountByName ?? {},
      workerTaskIdByName: parsed.workerTaskIdByName ?? {},
      mailboxNotifiedByMessageId: parsed.mailboxNotifiedByMessageId ?? {},
      completedEventTaskIds: parsed.completedEventTaskIds ?? {},
      monitorTimings
    };
  } catch {
    return null;
  }
}
async function writeMonitorSnapshot(teamName, snapshot, cwd) {
  await writeAtomic(absPath(cwd, TeamPaths.monitorSnapshot(teamName)), JSON.stringify(snapshot, null, 2));
}
async function writeShutdownRequest(teamName, workerName2, fromWorker, cwd) {
  const data = {
    from: fromWorker,
    requested_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  await writeAtomic(absPath(cwd, TeamPaths.shutdownRequest(teamName, workerName2)), JSON.stringify(data, null, 2));
}
async function readShutdownAck(teamName, workerName2, cwd, requestedAfter) {
  const ack = await readJsonSafe2(
    absPath(cwd, TeamPaths.shutdownAck(teamName, workerName2))
  );
  if (!ack) return null;
  if (requestedAfter && ack.updated_at) {
    if (new Date(ack.updated_at).getTime() < new Date(requestedAfter).getTime()) {
      return null;
    }
  }
  return ack;
}
async function listTasksFromFiles(teamName, cwd) {
  const tasksDir = absPath(cwd, TeamPaths.tasks(teamName));
  if (!(0, import_fs10.existsSync)(tasksDir)) return [];
  const { readdir: readdir2 } = await import("fs/promises");
  const entries = await readdir2(tasksDir);
  const tasks = [];
  for (const entry of entries) {
    const match = /^(?:task-)?(\d+)\.json$/.exec(entry);
    if (!match) continue;
    const task = await readJsonSafe2(absPath(cwd, `${TeamPaths.tasks(teamName)}/${entry}`));
    if (task) tasks.push(task);
  }
  return tasks.sort((a, b) => Number(a.id) - Number(b.id));
}
async function writeWorkerInbox(teamName, workerName2, content, cwd) {
  await writeAtomic(absPath(cwd, TeamPaths.inbox(teamName, workerName2)), content);
}
async function saveTeamConfig(config, cwd) {
  await writeAtomic(absPath(cwd, TeamPaths.config(config.name)), JSON.stringify(config, null, 2));
}
async function cleanupTeamState(teamName, cwd) {
  const root = absPath(cwd, TeamPaths.root(teamName));
  const { rm: rm3 } = await import("fs/promises");
  try {
    await rm3(root, { recursive: true, force: true });
  } catch {
  }
}

// src/team/events.ts
var import_crypto = require("crypto");
var import_path14 = require("path");
var import_promises5 = require("fs/promises");
var import_fs11 = require("fs");
async function appendTeamEvent(teamName, event, cwd) {
  const full = {
    event_id: (0, import_crypto.randomUUID)(),
    team: teamName,
    created_at: (/* @__PURE__ */ new Date()).toISOString(),
    ...event
  };
  const p = absPath(cwd, TeamPaths.events(teamName));
  await (0, import_promises5.mkdir)((0, import_path14.dirname)(p), { recursive: true });
  await (0, import_promises5.appendFile)(p, `${JSON.stringify(full)}
`, "utf8");
  return full;
}
async function emitMonitorDerivedEvents(teamName, tasks, workers, previousSnapshot, cwd) {
  if (!previousSnapshot) return;
  const completedEventTaskIds = { ...previousSnapshot.completedEventTaskIds ?? {} };
  for (const task of tasks) {
    const prevStatus = previousSnapshot.taskStatusById?.[task.id];
    if (!prevStatus || prevStatus === task.status) continue;
    if (task.status === "completed" && !completedEventTaskIds[task.id]) {
      await appendTeamEvent(teamName, {
        type: "task_completed",
        worker: "leader-fixed",
        task_id: task.id,
        reason: `status_transition:${prevStatus}->${task.status}`
      }, cwd).catch(() => {
      });
      completedEventTaskIds[task.id] = true;
    } else if (task.status === "failed") {
      await appendTeamEvent(teamName, {
        type: "task_failed",
        worker: "leader-fixed",
        task_id: task.id,
        reason: `status_transition:${prevStatus}->${task.status}`
      }, cwd).catch(() => {
      });
    }
  }
  for (const worker of workers) {
    const prevAlive = previousSnapshot.workerAliveByName?.[worker.name];
    const prevState = previousSnapshot.workerStateByName?.[worker.name];
    if (prevAlive === true && !worker.alive) {
      await appendTeamEvent(teamName, {
        type: "worker_stopped",
        worker: worker.name,
        reason: "pane_exited"
      }, cwd).catch(() => {
      });
    }
    if (prevState === "working" && worker.status.state === "idle") {
      await appendTeamEvent(teamName, {
        type: "worker_idle",
        worker: worker.name,
        reason: `state_transition:${prevState}->${worker.status.state}`
      }, cwd).catch(() => {
      });
    }
  }
}

// src/team/phase-controller.ts
function inferPhase(tasks) {
  if (tasks.length === 0) return "initializing";
  const inProgress = tasks.filter((t) => t.status === "in_progress");
  const pending = tasks.filter((t) => t.status === "pending");
  const permanentlyFailed = tasks.filter(
    (t) => t.status === "completed" && t.metadata?.permanentlyFailed === true
  );
  const genuinelyCompleted = tasks.filter(
    (t) => t.status === "completed" && !t.metadata?.permanentlyFailed
  );
  const explicitlyFailed = tasks.filter((t) => t.status === "failed");
  const allFailed = [...permanentlyFailed, ...explicitlyFailed];
  if (inProgress.length > 0) return "executing";
  if (pending.length === tasks.length && genuinelyCompleted.length === 0 && allFailed.length === 0) {
    return "planning";
  }
  if (pending.length > 0 && genuinelyCompleted.length > 0 && inProgress.length === 0) {
    return "executing";
  }
  if (allFailed.length > 0) {
    const hasRetriesRemaining = allFailed.some((t) => {
      const retryCount = t.metadata?.retryCount ?? 0;
      const maxRetries = t.metadata?.maxRetries ?? 3;
      return retryCount < maxRetries;
    });
    if (allFailed.length === tasks.length && !hasRetriesRemaining || pending.length === 0 && inProgress.length === 0 && genuinelyCompleted.length === 0 && !hasRetriesRemaining) {
      return "failed";
    }
    if (hasRetriesRemaining) return "fixing";
  }
  if (genuinelyCompleted.length === tasks.length && allFailed.length === 0) {
    return "completed";
  }
  return "executing";
}

// src/team/runtime-v2.ts
init_team_name();
init_tmux_session();
function isRuntimeV2Enabled(env = process.env) {
  const raw = env.OMC_RUNTIME_V2;
  if (!raw) return true;
  const normalized = raw.trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(normalized);
}
function sanitizeTeamName(name) {
  return name.replace(/[^a-z0-9-]/g, "").slice(0, 30);
}
async function isWorkerPaneAlive(paneId) {
  if (!paneId) return false;
  try {
    const { isWorkerAlive: isWorkerAlive2 } = await Promise.resolve().then(() => (init_tmux_session(), tmux_session_exports));
    return await isWorkerAlive2(paneId);
  } catch {
    return false;
  }
}
function buildV2TaskInstruction(teamName, workerName2, task, taskId) {
  return [
    `## Initial Task Assignment`,
    `Task ID: ${taskId}`,
    `Worker: ${workerName2}`,
    `Subject: ${task.subject}`,
    ``,
    task.description,
    ``,
    `## Task Lifecycle (CLI API)`,
    `1. Claim your task:`,
    `   omc team api claim-task --input '{"team_name":"${teamName}","task_id":"${taskId}","worker":"${workerName2}"}' --json`,
    `2. Do the work described above`,
    `3. On completion (use the claim_token from step 1):`,
    `   omc team api transition-task-status --input '{"team_name":"${teamName}","task_id":"${taskId}","from":"in_progress","to":"completed","claim_token":"<claim_token>"}' --json`,
    `4. On failure (use the claim_token from step 1):`,
    `   omc team api transition-task-status --input '{"team_name":"${teamName}","task_id":"${taskId}","from":"in_progress","to":"failed","claim_token":"<claim_token>"}' --json`,
    ``,
    `IMPORTANT: Use the CLI API commands above for all task state transitions.`,
    `Do NOT write done.json or edit task files directly.`,
    `After completing or failing the task, exit immediately.`
  ].join("\n");
}
async function notifyPaneWithRetry2(sessionName2, paneId, message, maxAttempts = 6, retryDelayMs = 350) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (await sendToWorker(sessionName2, paneId, message)) {
      return true;
    }
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  return false;
}
async function spawnV2Worker(opts) {
  const { execFile: execFile2 } = await import("child_process");
  const { promisify: promisify2 } = await import("util");
  const execFileAsync = promisify2(execFile2);
  const splitTarget = opts.existingWorkerPaneIds.length === 0 ? opts.leaderPaneId : opts.existingWorkerPaneIds[opts.existingWorkerPaneIds.length - 1];
  const splitType = opts.existingWorkerPaneIds.length === 0 ? "-h" : "-v";
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
    opts.cwd
  ]);
  const paneId = splitResult.stdout.split("\n")[0]?.trim();
  if (!paneId) return null;
  const usePromptMode = isPromptModeAgent(opts.agentType);
  const instruction = buildV2TaskInstruction(
    opts.teamName,
    opts.workerName,
    opts.task,
    opts.taskId
  );
  await composeInitialInbox(opts.teamName, opts.workerName, instruction, opts.cwd);
  const relInboxPath = `.omc/state/team/${opts.teamName}/workers/${opts.workerName}/inbox.md`;
  const envVars = getWorkerEnv(opts.teamName, opts.workerName, opts.agentType);
  const resolvedBinaryPath = opts.resolvedBinaryPaths[opts.agentType] ?? resolveValidatedBinaryPath(opts.agentType);
  const modelForAgent = (() => {
    if (opts.agentType === "codex") {
      return process.env.OMC_EXTERNAL_MODELS_DEFAULT_CODEX_MODEL || process.env.OMC_CODEX_DEFAULT_MODEL || void 0;
    }
    if (opts.agentType === "gemini") {
      return process.env.OMC_EXTERNAL_MODELS_DEFAULT_GEMINI_MODEL || process.env.OMC_GEMINI_DEFAULT_MODEL || void 0;
    }
    return void 0;
  })();
  const [launchBinary, ...launchArgs] = buildWorkerArgv(opts.agentType, {
    teamName: opts.teamName,
    workerName: opts.workerName,
    cwd: opts.cwd,
    resolvedBinaryPath,
    model: modelForAgent
  });
  if (usePromptMode) {
    const promptArgs = getPromptModeArgs(
      opts.agentType,
      `Read and execute your task from: ${relInboxPath}`
    );
    launchArgs.push(...promptArgs);
  }
  const paneConfig = {
    teamName: opts.teamName,
    workerName: opts.workerName,
    envVars,
    launchBinary,
    launchArgs,
    cwd: opts.cwd
  };
  await spawnWorkerInPane(opts.sessionName, paneId, paneConfig);
  try {
    await execFileAsync("tmux", [
      "select-layout",
      "-t",
      opts.sessionName,
      "main-vertical"
    ]);
  } catch {
  }
  if (!usePromptMode) {
    const paneReady = await waitForPaneReady(paneId);
    if (!paneReady) {
      try {
        await execFileAsync("tmux", ["kill-pane", "-t", paneId]);
      } catch {
      }
      return null;
    }
    if (opts.agentType === "gemini") {
      const confirmed = await notifyPaneWithRetry2(opts.sessionName, paneId, "1");
      if (!confirmed) {
        try {
          await execFileAsync("tmux", ["kill-pane", "-t", paneId]);
        } catch {
        }
        return null;
      }
      await new Promise((r) => setTimeout(r, 800));
    }
    const notified = await notifyPaneWithRetry2(
      opts.sessionName,
      paneId,
      `Read and execute your task from: ${relInboxPath}`
    );
    if (!notified) {
      try {
        await execFileAsync("tmux", ["kill-pane", "-t", paneId]);
      } catch {
      }
      return null;
    }
  }
  return paneId;
}
async function startTeamV2(config) {
  const sanitized = sanitizeTeamName(config.teamName);
  const leaderCwd = (0, import_path15.resolve)(config.cwd);
  validateTeamName(sanitized);
  const agentTypes = config.agentTypes;
  const resolvedBinaryPaths = {};
  for (const agentType of [...new Set(agentTypes)]) {
    resolvedBinaryPaths[agentType] = resolveValidatedBinaryPath(agentType);
  }
  await (0, import_promises6.mkdir)(absPath(leaderCwd, TeamPaths.tasks(sanitized)), { recursive: true });
  await (0, import_promises6.mkdir)(absPath(leaderCwd, TeamPaths.workers(sanitized)), { recursive: true });
  await (0, import_promises6.mkdir)((0, import_path15.join)(leaderCwd, ".omc", "state", "team", sanitized, "mailbox"), { recursive: true });
  for (let i = 0; i < config.tasks.length; i++) {
    const taskId = String(i + 1);
    const taskFilePath = absPath(leaderCwd, TeamPaths.taskFile(sanitized, taskId));
    await (0, import_promises6.mkdir)((0, import_path15.join)(taskFilePath, ".."), { recursive: true });
    await (0, import_promises6.writeFile)(taskFilePath, JSON.stringify({
      id: taskId,
      subject: config.tasks[i].subject,
      description: config.tasks[i].description,
      status: "pending",
      owner: null,
      result: null,
      created_at: (/* @__PURE__ */ new Date()).toISOString()
    }, null, 2), "utf-8");
  }
  const workerNames = [];
  for (let i = 0; i < config.tasks.length; i++) {
    const wName = `worker-${i + 1}`;
    workerNames.push(wName);
    const agentType = agentTypes[i % agentTypes.length] ?? agentTypes[0] ?? "claude";
    await ensureWorkerStateDir(sanitized, wName, leaderCwd);
    await writeWorkerOverlay({
      teamName: sanitized,
      workerName: wName,
      agentType,
      tasks: config.tasks.map((t, idx) => ({
        id: String(idx + 1),
        subject: t.subject,
        description: t.description
      })),
      cwd: leaderCwd
    });
  }
  const session = await createTeamSession(sanitized, 0, leaderCwd);
  const sessionName2 = session.sessionName;
  const leaderPaneId = session.leaderPaneId;
  const workerPaneIds = [];
  const workersInfo = workerNames.map((wName, i) => ({
    name: wName,
    index: i + 1,
    role: agentTypes[i % agentTypes.length] ?? agentTypes[0] ?? "claude",
    assigned_tasks: [],
    working_dir: leaderCwd
  }));
  const teamConfig = {
    name: sanitized,
    task: config.tasks.map((t) => t.subject).join("; "),
    agent_type: agentTypes[0] || "claude",
    worker_launch_mode: "interactive",
    worker_count: config.workerCount,
    max_workers: 20,
    workers: workersInfo,
    created_at: (/* @__PURE__ */ new Date()).toISOString(),
    tmux_session: sessionName2,
    next_task_id: config.tasks.length + 1,
    leader_cwd: leaderCwd,
    team_state_root: teamStateRoot(leaderCwd, sanitized),
    leader_pane_id: leaderPaneId,
    hud_pane_id: null,
    resize_hook_name: null,
    resize_hook_target: null
  };
  await saveTeamConfig(teamConfig, leaderCwd);
  const maxConcurrent = Math.min(agentTypes.length, config.tasks.length);
  for (let i = 0; i < maxConcurrent; i++) {
    const wName = workerNames[i];
    const taskId = String(i + 1);
    const task = config.tasks[i];
    if (!task) break;
    const paneId = await spawnV2Worker({
      sessionName: sessionName2,
      leaderPaneId,
      existingWorkerPaneIds: workerPaneIds,
      teamName: sanitized,
      workerName: wName,
      workerIndex: i,
      agentType: agentTypes[i % agentTypes.length] ?? agentTypes[0] ?? "claude",
      task,
      taskId,
      cwd: leaderCwd,
      resolvedBinaryPaths
    });
    if (paneId) {
      workerPaneIds.push(paneId);
      const workerInfo = workersInfo[i];
      if (workerInfo) {
        workerInfo.pane_id = paneId;
        workerInfo.assigned_tasks = [taskId];
      }
    }
  }
  teamConfig.workers = workersInfo;
  await saveTeamConfig(teamConfig, leaderCwd);
  await appendTeamEvent(sanitized, {
    type: "team_leader_nudge",
    worker: "leader-fixed",
    reason: `start_team_v2: workers=${config.workerCount} tasks=${config.tasks.length} panes=${workerPaneIds.length}`
  }, leaderCwd);
  return {
    teamName: sanitized,
    sanitizedName: sanitized,
    sessionName: sessionName2,
    config: teamConfig,
    cwd: leaderCwd
  };
}
async function monitorTeamV2(teamName, cwd) {
  const monitorStartMs = import_perf_hooks.performance.now();
  const sanitized = sanitizeTeamName(teamName);
  const config = await readTeamConfig(sanitized, cwd);
  if (!config) return null;
  const previousSnapshot = await readMonitorSnapshot(sanitized, cwd);
  const listTasksStartMs = import_perf_hooks.performance.now();
  const allTasks = await listTasksFromFiles(sanitized, cwd);
  const listTasksMs = import_perf_hooks.performance.now() - listTasksStartMs;
  const taskById = new Map(allTasks.map((task) => [task.id, task]));
  const inProgressByOwner = /* @__PURE__ */ new Map();
  for (const task of allTasks) {
    if (task.status !== "in_progress" || !task.owner) continue;
    const existing = inProgressByOwner.get(task.owner) || [];
    existing.push(task);
    inProgressByOwner.set(task.owner, existing);
  }
  const workers = [];
  const deadWorkers = [];
  const nonReportingWorkers = [];
  const recommendations = [];
  const workerScanStartMs = import_perf_hooks.performance.now();
  const workerSignals = await Promise.all(
    config.workers.map(async (worker) => {
      const alive = await isWorkerPaneAlive(worker.pane_id);
      const [status, heartbeat] = await Promise.all([
        readWorkerStatus(sanitized, worker.name, cwd),
        readWorkerHeartbeat(sanitized, worker.name, cwd)
      ]);
      return { worker, alive, status, heartbeat };
    })
  );
  const workerScanMs = import_perf_hooks.performance.now() - workerScanStartMs;
  for (const { worker: w, alive, status, heartbeat } of workerSignals) {
    const currentTask = status.current_task_id ? taskById.get(status.current_task_id) ?? null : null;
    const previousTurns = previousSnapshot ? previousSnapshot.workerTurnCountByName[w.name] ?? 0 : null;
    const previousTaskId = previousSnapshot?.workerTaskIdByName[w.name] ?? "";
    const currentTaskId = status.current_task_id ?? "";
    const turnsWithoutProgress = heartbeat && previousTurns !== null && status.state === "working" && currentTask && (currentTask.status === "pending" || currentTask.status === "in_progress") && currentTaskId !== "" && previousTaskId === currentTaskId ? Math.max(0, heartbeat.turn_count - previousTurns) : 0;
    workers.push({
      name: w.name,
      alive,
      status,
      heartbeat,
      assignedTasks: w.assigned_tasks,
      turnsWithoutProgress
    });
    if (!alive) {
      deadWorkers.push(w.name);
      const deadWorkerTasks = inProgressByOwner.get(w.name) || [];
      for (const t of deadWorkerTasks) {
        recommendations.push(`Reassign task-${t.id} from dead ${w.name}`);
      }
    }
    if (alive && turnsWithoutProgress > 5) {
      nonReportingWorkers.push(w.name);
      recommendations.push(`Send reminder to non-reporting ${w.name}`);
    }
  }
  const taskCounts = {
    total: allTasks.length,
    pending: allTasks.filter((t) => t.status === "pending").length,
    blocked: allTasks.filter((t) => t.status === "blocked").length,
    in_progress: allTasks.filter((t) => t.status === "in_progress").length,
    completed: allTasks.filter((t) => t.status === "completed").length,
    failed: allTasks.filter((t) => t.status === "failed").length
  };
  const allTasksTerminal2 = taskCounts.pending === 0 && taskCounts.blocked === 0 && taskCounts.in_progress === 0;
  const phase = inferPhase(allTasks.map((t) => ({
    status: t.status,
    metadata: void 0
  })));
  await emitMonitorDerivedEvents(
    sanitized,
    allTasks,
    workers.map((w) => ({ name: w.name, alive: w.alive, status: w.status })),
    previousSnapshot,
    cwd
  );
  const updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  const totalMs = import_perf_hooks.performance.now() - monitorStartMs;
  await writeMonitorSnapshot(sanitized, {
    taskStatusById: Object.fromEntries(allTasks.map((t) => [t.id, t.status])),
    workerAliveByName: Object.fromEntries(workers.map((w) => [w.name, w.alive])),
    workerStateByName: Object.fromEntries(workers.map((w) => [w.name, w.status.state])),
    workerTurnCountByName: Object.fromEntries(workers.map((w) => [w.name, w.heartbeat?.turn_count ?? 0])),
    workerTaskIdByName: Object.fromEntries(workers.map((w) => [w.name, w.status.current_task_id ?? ""])),
    mailboxNotifiedByMessageId: previousSnapshot?.mailboxNotifiedByMessageId ?? {},
    completedEventTaskIds: previousSnapshot?.completedEventTaskIds ?? {},
    monitorTimings: {
      list_tasks_ms: Number(listTasksMs.toFixed(2)),
      worker_scan_ms: Number(workerScanMs.toFixed(2)),
      mailbox_delivery_ms: 0,
      total_ms: Number(totalMs.toFixed(2)),
      updated_at: updatedAt
    }
  }, cwd);
  return {
    teamName: sanitized,
    phase,
    workers,
    tasks: {
      ...taskCounts,
      items: allTasks
    },
    allTasksTerminal: allTasksTerminal2,
    deadWorkers,
    nonReportingWorkers,
    recommendations,
    performance: {
      list_tasks_ms: Number(listTasksMs.toFixed(2)),
      worker_scan_ms: Number(workerScanMs.toFixed(2)),
      total_ms: Number(totalMs.toFixed(2)),
      updated_at: updatedAt
    }
  };
}
async function shutdownTeamV2(teamName, cwd, options = {}) {
  const force = options.force === true;
  const ralph = options.ralph === true;
  const timeoutMs = options.timeoutMs ?? 15e3;
  const sanitized = sanitizeTeamName(teamName);
  const config = await readTeamConfig(sanitized, cwd);
  if (!config) {
    await cleanupTeamState(sanitized, cwd);
    return;
  }
  if (!force) {
    const allTasks = await listTasksFromFiles(sanitized, cwd);
    const gate = {
      total: allTasks.length,
      pending: allTasks.filter((t) => t.status === "pending").length,
      blocked: allTasks.filter((t) => t.status === "blocked").length,
      in_progress: allTasks.filter((t) => t.status === "in_progress").length,
      completed: allTasks.filter((t) => t.status === "completed").length,
      failed: allTasks.filter((t) => t.status === "failed").length,
      allowed: false
    };
    gate.allowed = gate.pending === 0 && gate.blocked === 0 && gate.in_progress === 0 && gate.failed === 0;
    await appendTeamEvent(sanitized, {
      type: "shutdown_gate",
      worker: "leader-fixed",
      reason: `allowed=${gate.allowed} total=${gate.total} pending=${gate.pending} blocked=${gate.blocked} in_progress=${gate.in_progress} completed=${gate.completed} failed=${gate.failed}${ralph ? " policy=ralph" : ""}`
    }, cwd).catch(() => {
    });
    if (!gate.allowed) {
      const hasActiveWork = gate.pending > 0 || gate.blocked > 0 || gate.in_progress > 0;
      if (ralph && !hasActiveWork) {
        await appendTeamEvent(sanitized, {
          type: "team_leader_nudge",
          worker: "leader-fixed",
          reason: `gate_bypassed:pending=${gate.pending},blocked=${gate.blocked},in_progress=${gate.in_progress},failed=${gate.failed}`
        }, cwd).catch(() => {
        });
      } else {
        throw new Error(
          `shutdown_gate_blocked:pending=${gate.pending},blocked=${gate.blocked},in_progress=${gate.in_progress},failed=${gate.failed}`
        );
      }
    }
  }
  if (force) {
    await appendTeamEvent(sanitized, {
      type: "shutdown_gate_forced",
      worker: "leader-fixed",
      reason: "force_bypass"
    }, cwd).catch(() => {
    });
  }
  const shutdownRequestTimes = /* @__PURE__ */ new Map();
  for (const w of config.workers) {
    try {
      const requestedAt = (/* @__PURE__ */ new Date()).toISOString();
      await writeShutdownRequest(sanitized, w.name, "leader-fixed", cwd);
      shutdownRequestTimes.set(w.name, requestedAt);
      const shutdownInbox = `# Shutdown Request

All tasks are complete. Please wrap up and respond with a shutdown acknowledgement.

Write your ack to: ${TeamPaths.shutdownAck(sanitized, w.name)}
Format: {"status":"accept","reason":"ok","updated_at":"<iso>"}

Then exit your session.
`;
      await writeWorkerInbox(sanitized, w.name, shutdownInbox, cwd);
    } catch (err) {
      process.stderr.write(`[team/runtime-v2] shutdown request failed for ${w.name}: ${err}
`);
    }
  }
  const deadline = Date.now() + timeoutMs;
  const rejected = [];
  const ackedWorkers = /* @__PURE__ */ new Set();
  while (Date.now() < deadline) {
    for (const w of config.workers) {
      if (ackedWorkers.has(w.name)) continue;
      const ack = await readShutdownAck(sanitized, w.name, cwd, shutdownRequestTimes.get(w.name));
      if (ack) {
        ackedWorkers.add(w.name);
        await appendTeamEvent(sanitized, {
          type: "shutdown_ack",
          worker: w.name,
          reason: ack.status === "reject" ? `reject:${ack.reason || "no_reason"}` : "accept"
        }, cwd).catch(() => {
        });
        if (ack.status === "reject") {
          rejected.push({ worker: w.name, reason: ack.reason || "no_reason" });
        }
      }
    }
    if (rejected.length > 0 && !force) {
      const detail = rejected.map((r) => `${r.worker}:${r.reason}`).join(",");
      throw new Error(`shutdown_rejected:${detail}`);
    }
    const allDone = config.workers.every((w) => ackedWorkers.has(w.name));
    if (allDone) break;
    await new Promise((r) => setTimeout(r, 2e3));
  }
  try {
    const { killWorkerPanes: killWorkerPanes2, killTeamSession: killTeamSession2 } = await Promise.resolve().then(() => (init_tmux_session(), tmux_session_exports));
    const workerPaneIds = config.workers.map((w) => w.pane_id).filter((p) => typeof p === "string" && p.trim().length > 0);
    await killWorkerPanes2({
      paneIds: workerPaneIds,
      leaderPaneId: config.leader_pane_id ?? void 0,
      teamName: sanitized,
      cwd
    });
    if (config.tmux_session && !config.tmux_session.includes(":")) {
      await killTeamSession2(config.tmux_session, [], void 0);
    }
  } catch (err) {
    process.stderr.write(`[team/runtime-v2] tmux cleanup: ${err}
`);
  }
  if (ralph) {
    const finalTasks = await listTasksFromFiles(sanitized, cwd).catch(() => []);
    const completed = finalTasks.filter((t) => t.status === "completed").length;
    const failed = finalTasks.filter((t) => t.status === "failed").length;
    const pending = finalTasks.filter((t) => t.status === "pending").length;
    await appendTeamEvent(sanitized, {
      type: "team_leader_nudge",
      worker: "leader-fixed",
      reason: `ralph_cleanup_summary: total=${finalTasks.length} completed=${completed} failed=${failed} pending=${pending} force=${force}`
    }, cwd).catch(() => {
    });
  }
  await cleanupTeamState(sanitized, cwd);
}

// src/team/runtime-cli.ts
function getTerminalStatus(taskCounts, expectedTaskCount) {
  const active = taskCounts.pending + taskCounts.inProgress;
  const terminal = taskCounts.completed + taskCounts.failed;
  if (active !== 0 || terminal !== expectedTaskCount) return null;
  return taskCounts.failed > 0 ? "failed" : "completed";
}
function parseWatchdogFailedAt(marker) {
  if (typeof marker.failedAt === "number") return marker.failedAt;
  if (typeof marker.failedAt === "string") {
    const numeric = Number(marker.failedAt);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(marker.failedAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error("watchdog marker missing valid failedAt");
}
async function checkWatchdogFailedMarker(stateRoot2, startTime) {
  const markerPath = (0, import_path16.join)(stateRoot2, "watchdog-failed.json");
  let raw;
  try {
    raw = await (0, import_promises7.readFile)(markerPath, "utf-8");
  } catch (err) {
    const code = err.code;
    if (code === "ENOENT") return { failed: false };
    return { failed: true, reason: `Failed to read watchdog marker: ${err}` };
  }
  let marker;
  try {
    marker = JSON.parse(raw);
  } catch (err) {
    return { failed: true, reason: `Failed to parse watchdog marker: ${err}` };
  }
  let failedAt;
  try {
    failedAt = parseWatchdogFailedAt(marker);
  } catch (err) {
    return { failed: true, reason: `Invalid watchdog marker: ${err}` };
  }
  if (failedAt >= startTime) {
    return { failed: true, reason: `Watchdog marked team failed at ${new Date(failedAt).toISOString()}` };
  }
  try {
    await (0, import_promises7.unlink)(markerPath);
  } catch {
  }
  return { failed: false };
}
async function writeResultArtifact(output, finishedAt, jobId = process.env.OMC_JOB_ID, omcJobsDir = process.env.OMC_JOBS_DIR) {
  if (!jobId || !omcJobsDir) return;
  const resultPath = (0, import_path16.join)(omcJobsDir, `${jobId}-result.json`);
  const tmpPath = `${resultPath}.tmp`;
  await (0, import_promises7.writeFile)(
    tmpPath,
    JSON.stringify({ ...output, finishedAt }),
    "utf-8"
  );
  await (0, import_promises7.rename)(tmpPath, resultPath);
}
async function writePanesFile(jobId, paneIds, leaderPaneId) {
  const omcJobsDir = process.env.OMC_JOBS_DIR;
  if (!jobId || !omcJobsDir) return;
  const panesPath = (0, import_path16.join)(omcJobsDir, `${jobId}-panes.json`);
  await (0, import_promises7.writeFile)(
    panesPath + ".tmp",
    JSON.stringify({ paneIds: [...paneIds], leaderPaneId })
  );
  await (0, import_promises7.rename)(panesPath + ".tmp", panesPath);
}
function collectTaskResults(stateRoot2) {
  const tasksDir = (0, import_path16.join)(stateRoot2, "tasks");
  try {
    const files = (0, import_fs13.readdirSync)(tasksDir).filter((f) => f.endsWith(".json"));
    return files.map((f) => {
      try {
        const raw = (0, import_fs13.readFileSync)((0, import_path16.join)(tasksDir, f), "utf-8");
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
    pollIntervalMs = 5e3,
    sentinelGateTimeoutMs = 3e4,
    sentinelGatePollIntervalMs = 250
  } = input;
  const workerCount = input.workerCount ?? agentTypes.length;
  const stateRoot2 = (0, import_path16.join)(cwd, `.omc/state/team/${teamName}`);
  const config = {
    teamName,
    workerCount,
    agentTypes,
    tasks,
    cwd
  };
  const useV2 = isRuntimeV2Enabled();
  let runtime = null;
  let finalStatus = "failed";
  let pollActive = true;
  function exitCodeFor(status) {
    return status === "completed" ? 0 : 1;
  }
  async function doShutdown(status) {
    pollActive = false;
    finalStatus = status;
    if (!useV2 && runtime?.stopWatchdog) {
      runtime.stopWatchdog();
    }
    const taskResults = collectTaskResults(stateRoot2);
    if (runtime) {
      try {
        if (useV2) {
          await shutdownTeamV2(runtime.teamName, runtime.cwd, { force: true });
        } else {
          await shutdownTeam(
            runtime.teamName,
            runtime.sessionName,
            runtime.cwd,
            2e3,
            runtime.workerPaneIds,
            runtime.leaderPaneId
          );
        }
      } catch (err) {
        process.stderr.write(`[runtime-cli] shutdown error: ${err}
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
    const finishedAt = (/* @__PURE__ */ new Date()).toISOString();
    try {
      await writeResultArtifact(output, finishedAt);
    } catch (err) {
      process.stderr.write(`[runtime-cli] Failed to persist result artifact: ${err}
`);
    }
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
    if (useV2) {
      const v2Runtime = await startTeamV2({
        teamName,
        workerCount,
        agentTypes,
        tasks,
        cwd
      });
      const v2PaneIds = v2Runtime.config.workers.map((w) => w.pane_id).filter((p) => typeof p === "string");
      runtime = {
        teamName: v2Runtime.teamName,
        sessionName: v2Runtime.sessionName,
        leaderPaneId: v2Runtime.config.leader_pane_id || "",
        config,
        workerNames: v2Runtime.config.workers.map((w) => w.name),
        workerPaneIds: v2PaneIds,
        activeWorkers: /* @__PURE__ */ new Map(),
        cwd
      };
    } else {
      runtime = await startTeam(config);
    }
  } catch (err) {
    process.stderr.write(`[runtime-cli] startTeam failed: ${err}
`);
    process.exit(1);
  }
  const jobId = process.env.OMC_JOB_ID;
  const expectedTaskCount = tasks.length;
  let mismatchStreak = 0;
  try {
    await writePanesFile(jobId, runtime.workerPaneIds, runtime.leaderPaneId);
  } catch (err) {
    process.stderr.write(`[runtime-cli] Failed to persist pane IDs: ${err}
`);
  }
  if (useV2) {
    process.stderr.write("[runtime-cli] Using runtime v2 (event-driven, no watchdog)\n");
    while (pollActive) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      if (!pollActive) break;
      let snap;
      try {
        snap = await monitorTeamV2(teamName, cwd);
      } catch (err) {
        process.stderr.write(`[runtime-cli/v2] monitorTeamV2 error: ${err}
`);
        continue;
      }
      if (!snap) {
        process.stderr.write("[runtime-cli/v2] monitorTeamV2 returned null (team config missing?)\n");
        await doShutdown("failed");
        return;
      }
      try {
        await writePanesFile(jobId, runtime.workerPaneIds, runtime.leaderPaneId);
      } catch {
      }
      process.stderr.write(
        `[runtime-cli/v2] phase=${snap.phase} pending=${snap.tasks.pending} in_progress=${snap.tasks.in_progress} completed=${snap.tasks.completed} failed=${snap.tasks.failed} dead=${snap.deadWorkers.length} totalMs=${snap.performance.total_ms}
`
      );
      const v2Observed = snap.tasks.pending + snap.tasks.in_progress + snap.tasks.completed + snap.tasks.failed;
      if (v2Observed !== expectedTaskCount) {
        mismatchStreak += 1;
        process.stderr.write(
          `[runtime-cli/v2] Task-count mismatch observed=${v2Observed} expected=${expectedTaskCount} streak=${mismatchStreak}
`
        );
        if (mismatchStreak >= 2) {
          process.stderr.write("[runtime-cli/v2] Persistent task-count mismatch \u2014 failing fast\n");
          await doShutdown("failed");
          return;
        }
        continue;
      }
      mismatchStreak = 0;
      if (snap.allTasksTerminal) {
        const hasFailures = snap.tasks.failed > 0;
        if (!hasFailures) {
          const sentinelLogPath = (0, import_path16.join)(cwd, "sentinel_stop.jsonl");
          const gateResult = await waitForSentinelReadiness({
            workspace: cwd,
            logPath: sentinelLogPath,
            timeoutMs: sentinelGateTimeoutMs,
            pollIntervalMs: sentinelGatePollIntervalMs
          });
          if (!gateResult.ready) {
            process.stderr.write(
              `[runtime-cli/v2] Sentinel gate blocked: ${gateResult.blockers.join("; ")}
`
            );
            await doShutdown("failed");
            return;
          }
          await doShutdown("completed");
        } else {
          process.stderr.write("[runtime-cli/v2] Terminal failure detected from task counts\n");
          await doShutdown("failed");
        }
        return;
      }
      const allDead = runtime.workerPaneIds.length > 0 && snap.deadWorkers.length === runtime.workerPaneIds.length;
      const hasOutstanding = snap.tasks.pending + snap.tasks.in_progress > 0;
      if (allDead && hasOutstanding) {
        process.stderr.write("[runtime-cli/v2] All workers dead with outstanding work \u2014 failing\n");
        await doShutdown("failed");
        return;
      }
    }
    return;
  }
  while (pollActive) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    if (!pollActive) break;
    const watchdogCheck = await checkWatchdogFailedMarker(stateRoot2, startTime);
    if (watchdogCheck.failed) {
      process.stderr.write(`[runtime-cli] ${watchdogCheck.reason ?? "Watchdog failure marker detected"}
`);
      await doShutdown("failed");
      return;
    }
    let snap;
    try {
      snap = await monitorTeam(teamName, cwd, runtime.workerPaneIds);
    } catch (err) {
      process.stderr.write(`[runtime-cli] monitorTeam error: ${err}
`);
      continue;
    }
    try {
      await writePanesFile(jobId, runtime.workerPaneIds, runtime.leaderPaneId);
    } catch (err) {
      process.stderr.write(`[runtime-cli] Failed to persist pane IDs: ${err}
`);
    }
    process.stderr.write(
      `[runtime-cli] phase=${snap.phase} pending=${snap.taskCounts.pending} inProgress=${snap.taskCounts.inProgress} completed=${snap.taskCounts.completed} failed=${snap.taskCounts.failed} dead=${snap.deadWorkers.length} monitorMs=${snap.monitorPerformance.totalMs} tasksMs=${snap.monitorPerformance.listTasksMs} workerMs=${snap.monitorPerformance.workerScanMs}
`
    );
    const observedTaskCount = snap.taskCounts.pending + snap.taskCounts.inProgress + snap.taskCounts.completed + snap.taskCounts.failed;
    if (observedTaskCount !== expectedTaskCount) {
      mismatchStreak += 1;
      process.stderr.write(
        `[runtime-cli] Task-count mismatch observed=${observedTaskCount} expected=${expectedTaskCount} streak=${mismatchStreak}
`
      );
      if (mismatchStreak >= 2) {
        process.stderr.write("[runtime-cli] Persistent task-count mismatch detected \u2014 failing fast\n");
        await doShutdown("failed");
        return;
      }
      continue;
    }
    mismatchStreak = 0;
    const terminalStatus = getTerminalStatus(snap.taskCounts, expectedTaskCount);
    if (terminalStatus === "completed") {
      const sentinelLogPath = (0, import_path16.join)(cwd, "sentinel_stop.jsonl");
      const gateResult = await waitForSentinelReadiness({
        workspace: cwd,
        logPath: sentinelLogPath,
        timeoutMs: sentinelGateTimeoutMs,
        pollIntervalMs: sentinelGatePollIntervalMs
      });
      if (!gateResult.ready) {
        process.stderr.write(
          `[runtime-cli] Sentinel gate blocked completion (timedOut=${gateResult.timedOut}, attempts=${gateResult.attempts}, elapsedMs=${gateResult.elapsedMs}): ${gateResult.blockers.join("; ")}
`
        );
        await doShutdown("failed");
        return;
      }
      await doShutdown("completed");
      return;
    }
    if (terminalStatus === "failed") {
      process.stderr.write("[runtime-cli] Terminal failure detected from task counts\n");
      await doShutdown("failed");
      return;
    }
    const allWorkersDead = runtime.workerPaneIds.length > 0 && snap.deadWorkers.length === runtime.workerPaneIds.length;
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
}
if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[runtime-cli] Fatal error: ${err}
`);
    process.exit(1);
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  checkWatchdogFailedMarker,
  getTerminalStatus,
  writeResultArtifact
});
