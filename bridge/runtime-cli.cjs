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
  applyMainVerticalLayout: () => applyMainVerticalLayout,
  buildWorkerLaunchSpec: () => buildWorkerLaunchSpec,
  buildWorkerStartCommand: () => buildWorkerStartCommand,
  createSession: () => createSession,
  createTeamSession: () => createTeamSession,
  detectTeamMultiplexerContext: () => detectTeamMultiplexerContext,
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
  resolveShellFromCandidates: () => resolveShellFromCandidates,
  resolveSplitPaneWorkerPaneIds: () => resolveSplitPaneWorkerPaneIds,
  resolveSupportedShellAffinity: () => resolveSupportedShellAffinity,
  sanitizeName: () => sanitizeName,
  sendToWorker: () => sendToWorker,
  sessionName: () => sessionName,
  shouldAttemptAdaptiveRetry: () => shouldAttemptAdaptiveRetry,
  spawnBridgeInSession: () => spawnBridgeInSession,
  spawnWorkerInPane: () => spawnWorkerInPane,
  validateTmux: () => validateTmux,
  waitForPaneReady: () => waitForPaneReady
});
function detectTeamMultiplexerContext(env = process.env) {
  if (env.TMUX) return "tmux";
  if (env.CMUX_SURFACE_ID) return "cmux";
  return "none";
}
function isUnixLikeOnWindows() {
  return process.platform === "win32" && !!(process.env.MSYSTEM || process.env.MINGW_PREFIX);
}
async function tmuxAsync(args) {
  if (args.some((a) => a.includes("#{"))) {
    const escaped = args.map((a) => "'" + a.replace(/'/g, "'\\''") + "'").join(" ");
    return promisifiedExec(`tmux ${escaped}`);
  }
  return promisifiedExecFile("tmux", args);
}
async function applyMainVerticalLayout(teamTarget) {
  const { execFile: execFile4 } = await import("child_process");
  const { promisify: promisify3 } = await import("util");
  const execFileAsync2 = promisify3(execFile4);
  try {
    await execFileAsync2("tmux", ["select-layout", "-t", teamTarget, "main-vertical"]);
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
      await execFileAsync2("tmux", ["set-window-option", "-t", teamTarget, "main-pane-width", half]);
      await execFileAsync2("tmux", ["select-layout", "-t", teamTarget, "main-vertical"]);
    }
  } catch {
  }
}
function getDefaultShell() {
  if (process.platform === "win32" && !isUnixLikeOnWindows()) {
    return process.env.COMSPEC || "cmd.exe";
  }
  const shell = process.env.SHELL || "/bin/bash";
  const name = (0, import_path7.basename)(shell.replace(/\\/g, "/")).replace(/\.(exe|cmd|bat)$/i, "");
  if (!SUPPORTED_POSIX_SHELLS.has(name)) {
    return "/bin/sh";
  }
  return shell;
}
function pathEntries(envPath) {
  return (envPath ?? "").split(process.platform === "win32" ? ";" : ":").map((entry) => entry.trim()).filter(Boolean);
}
function pathCandidateNames(candidatePath) {
  const base = (0, import_path7.basename)(candidatePath.replace(/\\/g, "/"));
  const bare = base.replace(/\.(exe|cmd|bat)$/i, "");
  if (process.platform === "win32") {
    return Array.from(/* @__PURE__ */ new Set([`${bare}.exe`, `${bare}.cmd`, `${bare}.bat`, bare]));
  }
  return Array.from(/* @__PURE__ */ new Set([base, bare]));
}
function resolveShellFromPath(candidatePath) {
  for (const dir of pathEntries(process.env.PATH)) {
    for (const name of pathCandidateNames(candidatePath)) {
      const full = (0, import_path7.join)(dir, name);
      if ((0, import_fs5.existsSync)(full)) return full;
    }
  }
  return null;
}
function resolveShellFromCandidates(paths, rcFile) {
  for (const p of paths) {
    if ((0, import_fs5.existsSync)(p)) return { shell: p, rcFile };
    const resolvedFromPath = resolveShellFromPath(p);
    if (resolvedFromPath) return { shell: resolvedFromPath, rcFile };
  }
  return null;
}
function resolveSupportedShellAffinity(shellPath) {
  if (!shellPath) return null;
  const name = (0, import_path7.basename)(shellPath.replace(/\\/g, "/")).replace(/\.(exe|cmd|bat)$/i, "");
  if (name !== "zsh" && name !== "bash") return null;
  if (!(0, import_fs5.existsSync)(shellPath)) return null;
  const home = process.env.HOME ?? "";
  const rcFile = home ? `${home}/.${name}rc` : null;
  return { shell: shellPath, rcFile };
}
function buildWorkerLaunchSpec(shellPath) {
  if (isUnixLikeOnWindows()) {
    return { shell: "/bin/sh", rcFile: null };
  }
  const preferred = resolveSupportedShellAffinity(shellPath);
  if (preferred) return preferred;
  const home = process.env.HOME ?? "";
  const zshRc = home ? `${home}/.zshrc` : null;
  const zsh = resolveShellFromCandidates(ZSH_CANDIDATES, zshRc ?? "");
  if (zsh) return { shell: zsh.shell, rcFile: zshRc };
  const bashRc = home ? `${home}/.bashrc` : null;
  const bash = resolveShellFromCandidates(BASH_CANDIDATES, bashRc ?? "");
  if (bash) return { shell: bash.shell, rcFile: bashRc };
  return { shell: "/bin/sh", rcFile: null };
}
function escapeForCmdSet(value) {
  return value.replace(/"/g, '""');
}
function shellNameFromPath(shellPath) {
  const shellName = (0, import_path7.basename)(shellPath.replace(/\\/g, "/"));
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
  return (0, import_path7.isAbsolute)(value) || import_path7.win32.isAbsolute(value);
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
    throw new Error(
      "launchCmd is deprecated and has been removed for security reasons. Use launchBinary + launchArgs instead."
    );
  }
  throw new Error("Missing worker launch command. Provide launchBinary or launchCmd.");
}
function buildWorkerStartCommand(config) {
  const shell = getDefaultShell();
  const launchSpec = buildWorkerLaunchSpec(process.env.SHELL);
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
    const isFish2 = shellName2 === "fish";
    const execArgsCommand = isFish2 ? "exec $argv" : 'exec "$@"';
    let rcFile2 = (launchSpec.shell === shell ? launchSpec.rcFile : null) ?? "";
    if (!rcFile2 && process.env.HOME) {
      rcFile2 = isFish2 ? `${process.env.HOME}/.config/fish/config.fish` : `${process.env.HOME}/.${shellName2}rc`;
    }
    let script;
    if (isFish2) {
      script = shouldSourceRc && rcFile2 ? `test -f ${shellEscape(rcFile2)}; and source ${shellEscape(rcFile2)}; ${execArgsCommand}` : execArgsCommand;
    } else {
      script = shouldSourceRc && rcFile2 ? `[ -f ${shellEscape(rcFile2)} ] && . ${shellEscape(rcFile2)}; ${execArgsCommand}` : execArgsCommand;
    }
    const shellFlags = isFish2 ? ["-l", "-c"] : ["-lc"];
    return [
      shellEscape("env"),
      ...envAssignments,
      ...[shell, ...shellFlags, script, "--", ...launchWords].map(shellEscape)
    ].join(" ");
  }
  const envString = Object.entries(config.envVars).map(([k, v]) => {
    assertSafeEnvKey(k);
    return `${k}=${shellEscape(v)}`;
  }).join(" ");
  const shellName = shellNameFromPath(shell) || "bash";
  const isFish = shellName === "fish";
  let rcFile = (launchSpec.shell === shell ? launchSpec.rcFile : null) ?? "";
  if (!rcFile && process.env.HOME) {
    rcFile = isFish ? `${process.env.HOME}/.config/fish/config.fish` : `${process.env.HOME}/.${shellName}rc`;
  }
  let sourceCmd = "";
  if (shouldSourceRc && rcFile) {
    sourceCmd = isFish ? `test -f "${rcFile}"; and source "${rcFile}"; ` : `[ -f "${rcFile}" ] && source "${rcFile}"; `;
  }
  return `env ${envString} ${shell} -c "${sourceCmd}exec ${launchWords[0]}"`;
}
function validateTmux() {
  try {
    (0, import_child_process2.execSync)("tmux -V", { encoding: "utf-8", timeout: 5e3, stdio: "pipe" });
  } catch {
    throw new Error(
      "tmux is not available. Install it:\n  macOS: brew install tmux\n  Ubuntu/Debian: sudo apt-get install tmux\n  Fedora: sudo dnf install tmux\n  Arch: sudo pacman -S tmux\n  Windows: winget install psmux"
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
    const output = (0, import_child_process2.execSync)("tmux list-sessions -F '#{session_name}'", {
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
async function createTeamSession(teamName, workerCount, cwd, options = {}) {
  const { execFile: execFile4 } = await import("child_process");
  const { promisify: promisify3 } = await import("util");
  const execFileAsync2 = promisify3(execFile4);
  const multiplexerContext = detectTeamMultiplexerContext();
  const inTmux = multiplexerContext === "tmux";
  const useDedicatedWindow = Boolean(options.newWindow && inTmux);
  const envPaneIdRaw = (process.env.TMUX_PANE ?? "").trim();
  const envPaneId = /^%\d+$/.test(envPaneIdRaw) ? envPaneIdRaw : "";
  let sessionAndWindow = "";
  let leaderPaneId = envPaneId;
  let sessionMode = inTmux ? "split-pane" : "detached-session";
  if (!inTmux) {
    const detachedSessionName = `${TMUX_SESSION_PREFIX}-${sanitizeName(teamName)}-${Date.now().toString(36)}`;
    const detachedResult = await execFileAsync2("tmux", [
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
      const targetedContextResult = await execFileAsync2("tmux", [
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
  if (useDedicatedWindow) {
    const targetSession = sessionAndWindow.split(":")[0] ?? sessionAndWindow;
    const windowName = `omc-${sanitizeName(teamName)}`.slice(0, 32);
    const newWindowResult = await execFileAsync2("tmux", [
      "new-window",
      "-d",
      "-P",
      "-F",
      "#S:#I #{pane_id}",
      "-t",
      targetSession,
      "-n",
      windowName,
      "-c",
      cwd
    ]);
    const newWindowLine = newWindowResult.stdout.trim();
    const newWindowMatch = newWindowLine.match(/^(\S+)\s+(%\d+)$/);
    if (!newWindowMatch) {
      throw new Error(`Failed to create team tmux window: "${newWindowLine}"`);
    }
    sessionAndWindow = newWindowMatch[1];
    leaderPaneId = newWindowMatch[2];
    sessionMode = "dedicated-window";
  }
  const teamTarget = sessionAndWindow;
  const resolvedSessionName = teamTarget.split(":")[0];
  const workerPaneIds = [];
  if (workerCount <= 0) {
    try {
      await execFileAsync2("tmux", ["set-option", "-t", resolvedSessionName, "mouse", "on"]);
    } catch {
    }
    if (sessionMode !== "dedicated-window") {
      try {
        await execFileAsync2("tmux", ["select-pane", "-t", leaderPaneId]);
      } catch {
      }
    }
    await new Promise((r) => setTimeout(r, 300));
    return { sessionName: teamTarget, leaderPaneId, workerPaneIds, sessionMode };
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
  await applyMainVerticalLayout(teamTarget);
  try {
    await execFileAsync2("tmux", ["set-option", "-t", resolvedSessionName, "mouse", "on"]);
  } catch {
  }
  if (sessionMode !== "dedicated-window") {
    try {
      await execFileAsync2("tmux", ["select-pane", "-t", leaderPaneId]);
    } catch {
    }
  }
  await new Promise((r) => setTimeout(r, 300));
  return { sessionName: teamTarget, leaderPaneId, workerPaneIds, sessionMode };
}
async function spawnWorkerInPane(sessionName2, paneId, config) {
  const { execFile: execFile4 } = await import("child_process");
  const { promisify: promisify3 } = await import("util");
  const execFileAsync2 = promisify3(execFile4);
  validateTeamName(config.teamName);
  const startCmd = buildWorkerStartCommand(config);
  await execFileAsync2("tmux", [
    "send-keys",
    "-t",
    paneId,
    "-l",
    startCmd
  ]);
  await execFileAsync2("tmux", ["send-keys", "-t", paneId, "Enter"]);
}
function normalizeTmuxCapture(value) {
  return value.replace(/\r/g, "").replace(/\s+/g, " ").trim();
}
async function capturePaneAsync(paneId, execFileAsync2) {
  try {
    const result = await execFileAsync2("tmux", ["capture-pane", "-t", paneId, "-p", "-S", "-80"]);
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
function paneIsBootstrapping(captured) {
  const lines = captured.split("\n").map((line) => line.replace(/\r/g, "").trim()).filter((line) => line.length > 0);
  return lines.some(
    (line) => /\b(loading|initializing|starting up)\b/i.test(line) || /\bmodel:\s*loading\b/i.test(line) || /\bconnecting\s+to\b/i.test(line)
  );
}
function paneHasActiveTask(captured) {
  const lines = captured.split("\n").map((l) => l.replace(/\r/g, "").trim()).filter((l) => l.length > 0);
  const tail = lines.slice(-40);
  if (tail.some((l) => /\b\d+\s+background terminal running\b/i.test(l))) return true;
  if (tail.some((l) => /esc to interrupt/i.test(l))) return true;
  if (tail.some((l) => /\bbackground terminal running\b/i.test(l))) return true;
  if (tail.some((l) => /^[·✻]\s+[A-Za-z][A-Za-z0-9''-]*(?:\s+[A-Za-z][A-Za-z0-9''-]*){0,3}(?:…|\.{3})$/u.test(l))) return true;
  return false;
}
function paneLooksReady(captured) {
  const content = captured.trimEnd();
  if (content === "") return false;
  const lines = content.split("\n").map((line) => line.replace(/\r/g, "").trimEnd()).filter((line) => line.trim() !== "");
  if (lines.length === 0) return false;
  if (paneIsBootstrapping(content)) return false;
  const lastLine = lines[lines.length - 1];
  if (/^\s*[›>❯]\s*/u.test(lastLine)) return true;
  const hasCodexPromptLine = lines.some((line) => /^\s*›\s*/u.test(line));
  const hasClaudePromptLine = lines.some((line) => /^\s*❯\s*/u.test(line));
  return hasCodexPromptLine || hasClaudePromptLine;
}
async function waitForPaneReady(paneId, opts = {}) {
  const envTimeout = Number.parseInt(process.env.OMC_SHELL_READY_TIMEOUT_MS ?? "", 10);
  const timeoutMs = Number.isFinite(opts.timeoutMs) && (opts.timeoutMs ?? 0) > 0 ? Number(opts.timeoutMs) : Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 3e4;
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
async function paneInCopyMode(paneId) {
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
    console.warn(`[tmux-session] sendToWorker: message rejected (${message.length} chars exceeds 200 char limit)`);
    return false;
  }
  try {
    const { execFile: execFile4 } = await import("child_process");
    const { promisify: promisify3 } = await import("util");
    const execFileAsync2 = promisify3(execFile4);
    const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
    const sendKey = async (key) => {
      await execFileAsync2("tmux", ["send-keys", "-t", paneId, key]);
    };
    if (await paneInCopyMode(paneId)) {
      return false;
    }
    const initialCapture = await capturePaneAsync(paneId, execFileAsync2);
    const paneBusy = paneHasActiveTask(initialCapture);
    if (paneHasTrustPrompt(initialCapture)) {
      await sendKey("C-m");
      await sleep2(120);
      await sendKey("C-m");
      await sleep2(200);
    }
    await execFileAsync2("tmux", ["send-keys", "-t", paneId, "-l", "--", message]);
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
      const checkCapture = await capturePaneAsync(paneId, execFileAsync2);
      if (!paneTailContainsLiteralLine(checkCapture, message)) return true;
      await sleep2(140);
    }
    if (await paneInCopyMode(paneId)) {
      return false;
    }
    const finalCapture = await capturePaneAsync(paneId, execFileAsync2);
    const paneModeBeforeAdaptiveRetry = await paneInCopyMode(paneId);
    if (shouldAttemptAdaptiveRetry({
      paneBusy,
      latestCapture: finalCapture,
      message,
      paneInCopyMode: paneModeBeforeAdaptiveRetry,
      retriesAttempted: 0
    })) {
      if (await paneInCopyMode(paneId)) {
        return false;
      }
      await sendKey("C-u");
      await sleep2(80);
      if (await paneInCopyMode(paneId)) {
        return false;
      }
      await execFileAsync2("tmux", ["send-keys", "-t", paneId, "-l", "--", message]);
      await sleep2(120);
      for (let round = 0; round < 4; round++) {
        await sendKey("C-m");
        await sleep2(180);
        await sendKey("C-m");
        await sleep2(140);
        const retryCapture = await capturePaneAsync(paneId, execFileAsync2);
        if (!paneTailContainsLiteralLine(retryCapture, message)) return true;
      }
    }
    if (await paneInCopyMode(paneId)) {
      return false;
    }
    await sendKey("C-m");
    await sleep2(120);
    await sendKey("C-m");
    await sleep2(140);
    const finalCheckCapture = await capturePaneAsync(paneId, execFileAsync2);
    if (!finalCheckCapture || finalCheckCapture.trim() === "") {
      return false;
    }
    return !paneTailContainsLiteralLine(finalCheckCapture, message);
  } catch {
    return false;
  }
}
async function injectToLeaderPane(sessionName2, leaderPaneId, message) {
  const prefixed = `[OMC_TMUX_INJECT] ${message}`.slice(0, 200);
  try {
    const { execFile: execFile4 } = await import("child_process");
    const { promisify: promisify3 } = await import("util");
    const execFileAsync2 = promisify3(execFile4);
    if (await paneInCopyMode(leaderPaneId)) {
      return false;
    }
    const captured = await capturePaneAsync(leaderPaneId, execFileAsync2);
    if (paneHasActiveTask(captured)) {
      await execFileAsync2("tmux", ["send-keys", "-t", leaderPaneId, "C-c"]);
      await new Promise((r) => setTimeout(r, 250));
    }
  } catch {
  }
  return sendToWorker(sessionName2, leaderPaneId, prefixed);
}
async function isWorkerAlive(paneId) {
  try {
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
  const shutdownPath = (0, import_path7.join)(cwd, ".omc", "state", "team", teamName, "shutdown.json");
  try {
    await import_promises.default.writeFile(shutdownPath, JSON.stringify({ requestedAt: Date.now() }));
    const aliveChecks = await Promise.all(paneIds.map((id) => isWorkerAlive(id)));
    if (aliveChecks.some((alive) => alive)) {
      await sleep(graceMs);
    }
  } catch {
  }
  const { execFile: execFile4 } = await import("child_process");
  const { promisify: promisify3 } = await import("util");
  const execFileAsync2 = promisify3(execFile4);
  for (const paneId of paneIds) {
    if (paneId === leaderPaneId) continue;
    try {
      await execFileAsync2("tmux", ["kill-pane", "-t", paneId]);
    } catch {
    }
  }
}
function isPaneId(value) {
  return typeof value === "string" && /^%\d+$/.test(value.trim());
}
function dedupeWorkerPaneIds(paneIds, leaderPaneId) {
  const unique = /* @__PURE__ */ new Set();
  for (const paneId of paneIds) {
    if (!isPaneId(paneId)) continue;
    const normalized = paneId.trim();
    if (normalized === leaderPaneId) continue;
    unique.add(normalized);
  }
  return [...unique];
}
async function resolveSplitPaneWorkerPaneIds(sessionName2, recordedPaneIds, leaderPaneId) {
  const resolved = dedupeWorkerPaneIds(recordedPaneIds ?? [], leaderPaneId);
  if (!sessionName2.includes(":")) return resolved;
  try {
    const paneResult = await tmuxAsync(["list-panes", "-t", sessionName2, "-F", "#{pane_id}"]);
    return dedupeWorkerPaneIds(
      [...resolved, ...paneResult.stdout.split("\n").map((paneId) => paneId.trim())],
      leaderPaneId
    );
  } catch {
    return resolved;
  }
}
async function killTeamSession(sessionName2, workerPaneIds, leaderPaneId, options = {}) {
  const { execFile: execFile4 } = await import("child_process");
  const { promisify: promisify3 } = await import("util");
  const execFileAsync2 = promisify3(execFile4);
  const sessionMode = options.sessionMode ?? (sessionName2.includes(":") ? "split-pane" : "detached-session");
  if (sessionMode === "split-pane") {
    if (!workerPaneIds?.length) return;
    for (const id of workerPaneIds) {
      if (id === leaderPaneId) continue;
      try {
        await execFileAsync2("tmux", ["kill-pane", "-t", id]);
      } catch {
      }
    }
    return;
  }
  if (sessionMode === "dedicated-window") {
    try {
      await execFileAsync2("tmux", ["kill-window", "-t", sessionName2]);
    } catch {
    }
    return;
  }
  const sessionTarget = sessionName2.split(":")[0] ?? sessionName2;
  if (process.env.OMC_TEAM_ALLOW_KILL_CURRENT_SESSION !== "1" && process.env.TMUX) {
    try {
      const current = await tmuxAsync(["display-message", "-p", "#S"]);
      const currentSessionName = current.stdout.trim();
      if (currentSessionName && currentSessionName === sessionTarget) {
        return;
      }
    } catch {
    }
  }
  try {
    await execFileAsync2("tmux", ["kill-session", "-t", sessionTarget]);
  } catch {
  }
}
var import_child_process2, import_fs5, import_path7, import_util, import_promises, sleep, TMUX_SESSION_PREFIX, promisifiedExec, promisifiedExecFile, SUPPORTED_POSIX_SHELLS, ZSH_CANDIDATES, BASH_CANDIDATES, DANGEROUS_LAUNCH_BINARY_CHARS;
var init_tmux_session = __esm({
  "src/team/tmux-session.ts"() {
    "use strict";
    import_child_process2 = require("child_process");
    import_fs5 = require("fs");
    import_path7 = require("path");
    import_util = require("util");
    import_promises = __toESM(require("fs/promises"), 1);
    init_team_name();
    sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    TMUX_SESSION_PREFIX = "omc-team";
    promisifiedExec = (0, import_util.promisify)(import_child_process2.exec);
    promisifiedExecFile = (0, import_util.promisify)(import_child_process2.execFile);
    SUPPORTED_POSIX_SHELLS = /* @__PURE__ */ new Set(["sh", "bash", "zsh", "fish", "ksh"]);
    ZSH_CANDIDATES = ["/bin/zsh", "/usr/bin/zsh", "/usr/local/bin/zsh", "/opt/homebrew/bin/zsh"];
    BASH_CANDIDATES = ["/bin/bash", "/usr/bin/bash"];
    DANGEROUS_LAUNCH_BINARY_CHARS = /[;&|`$()<>\n\r\t\0]/;
  }
});

// src/lib/atomic-write.ts
function ensureDirSync(dir) {
  if (fsSync.existsSync(dir)) {
    return;
  }
  try {
    fsSync.mkdirSync(dir, { recursive: true });
  } catch (err) {
    if (err.code === "EEXIST") {
      return;
    }
    throw err;
  }
}
var fs2, fsSync, path, crypto;
var init_atomic_write = __esm({
  "src/lib/atomic-write.ts"() {
    "use strict";
    fs2 = __toESM(require("fs/promises"), 1);
    fsSync = __toESM(require("fs"), 1);
    path = __toESM(require("path"), 1);
    crypto = __toESM(require("crypto"), 1);
  }
});

// src/platform/process-utils.ts
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && e.code === "EPERM") {
      return true;
    }
    return false;
  }
}
var import_child_process4, import_util2, fsPromises, execFileAsync;
var init_process_utils = __esm({
  "src/platform/process-utils.ts"() {
    "use strict";
    import_child_process4 = require("child_process");
    import_util2 = require("util");
    fsPromises = __toESM(require("fs/promises"), 1);
    execFileAsync = (0, import_util2.promisify)(import_child_process4.execFile);
  }
});

// src/platform/index.ts
var path2, import_fs8, PLATFORM;
var init_platform = __esm({
  "src/platform/index.ts"() {
    "use strict";
    path2 = __toESM(require("path"), 1);
    import_fs8 = require("fs");
    init_process_utils();
    PLATFORM = process.platform;
  }
});

// src/lib/file-lock.ts
function isLockStale(lockPath, staleLockMs) {
  try {
    const stat2 = (0, import_fs9.statSync)(lockPath);
    const ageMs = Date.now() - stat2.mtimeMs;
    if (ageMs < staleLockMs) return false;
    try {
      const raw = (0, import_fs9.readFileSync)(lockPath, "utf-8");
      const payload = JSON.parse(raw);
      if (payload.pid && isProcessAlive(payload.pid)) return false;
    } catch {
    }
    return true;
  } catch {
    return false;
  }
}
function tryAcquireSync(lockPath, staleLockMs) {
  ensureDirSync(path3.dirname(lockPath));
  try {
    const fd = (0, import_fs9.openSync)(
      lockPath,
      import_fs9.constants.O_CREAT | import_fs9.constants.O_EXCL | import_fs9.constants.O_WRONLY,
      384
    );
    try {
      const payload = JSON.stringify({ pid: process.pid, timestamp: Date.now() });
      (0, import_fs9.writeSync)(fd, payload, null, "utf-8");
    } catch (writeErr) {
      try {
        (0, import_fs9.closeSync)(fd);
      } catch {
      }
      try {
        (0, import_fs9.unlinkSync)(lockPath);
      } catch {
      }
      throw writeErr;
    }
    return { fd, path: lockPath };
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "EEXIST") {
      if (isLockStale(lockPath, staleLockMs)) {
        try {
          (0, import_fs9.unlinkSync)(lockPath);
        } catch {
        }
        try {
          const fd = (0, import_fs9.openSync)(
            lockPath,
            import_fs9.constants.O_CREAT | import_fs9.constants.O_EXCL | import_fs9.constants.O_WRONLY,
            384
          );
          try {
            const payload = JSON.stringify({ pid: process.pid, timestamp: Date.now() });
            (0, import_fs9.writeSync)(fd, payload, null, "utf-8");
          } catch (writeErr) {
            try {
              (0, import_fs9.closeSync)(fd);
            } catch {
            }
            try {
              (0, import_fs9.unlinkSync)(lockPath);
            } catch {
            }
            throw writeErr;
          }
          return { fd, path: lockPath };
        } catch {
          return null;
        }
      }
      return null;
    }
    throw err;
  }
}
function acquireFileLockSync(lockPath, opts) {
  const staleLockMs = opts?.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const timeoutMs = opts?.timeoutMs ?? 0;
  const retryDelayMs = opts?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const handle = tryAcquireSync(lockPath, staleLockMs);
  if (handle || timeoutMs <= 0) return handle;
  const deadline = Date.now() + timeoutMs;
  const sharedBuf = new SharedArrayBuffer(4);
  const sharedArr = new Int32Array(sharedBuf);
  while (Date.now() < deadline) {
    const waitMs = Math.min(retryDelayMs, deadline - Date.now());
    try {
      Atomics.wait(sharedArr, 0, 0, waitMs);
    } catch {
      const waitUntil = Date.now() + waitMs;
      while (Date.now() < waitUntil) {
      }
    }
    const retryHandle = tryAcquireSync(lockPath, staleLockMs);
    if (retryHandle) return retryHandle;
  }
  return null;
}
function releaseFileLockSync(handle) {
  try {
    (0, import_fs9.closeSync)(handle.fd);
  } catch {
  }
  try {
    (0, import_fs9.unlinkSync)(handle.path);
  } catch {
  }
}
function withFileLockSync(lockPath, fn, opts) {
  const handle = acquireFileLockSync(lockPath, opts);
  if (!handle) {
    throw new Error(`Failed to acquire file lock: ${lockPath}`);
  }
  try {
    return fn();
  } finally {
    releaseFileLockSync(handle);
  }
}
var import_fs9, path3, DEFAULT_STALE_LOCK_MS, DEFAULT_RETRY_DELAY_MS;
var init_file_lock = __esm({
  "src/lib/file-lock.ts"() {
    "use strict";
    import_fs9 = require("fs");
    path3 = __toESM(require("path"), 1);
    init_atomic_write();
    init_platform();
    DEFAULT_STALE_LOCK_MS = 3e4;
    DEFAULT_RETRY_DELAY_MS = 50;
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
var import_fs18 = require("fs");
var import_promises8 = require("fs/promises");
var import_path19 = require("path");

// src/team/runtime.ts
var import_promises3 = require("fs/promises");
var import_path13 = require("path");
var import_fs11 = require("fs");

// src/team/model-contract.ts
var import_child_process = require("child_process");
var import_path6 = require("path");
init_team_name();

// src/agents/utils.ts
var import_fs = require("fs");
var import_path = require("path");
var import_url = require("url");
var import_meta = {};
function getPackageDir() {
  if (typeof __dirname !== "undefined" && __dirname) {
    const currentDirName = (0, import_path.basename)(__dirname);
    const parentDirName = (0, import_path.basename)((0, import_path.dirname)(__dirname));
    if (currentDirName === "bridge") {
      return (0, import_path.join)(__dirname, "..");
    }
    if (currentDirName === "agents" && (parentDirName === "src" || parentDirName === "dist")) {
      return (0, import_path.join)(__dirname, "..", "..");
    }
  }
  try {
    const __filename = (0, import_url.fileURLToPath)(import_meta.url);
    const __dirname2 = (0, import_path.dirname)(__filename);
    const currentDirName = (0, import_path.basename)(__dirname2);
    if (currentDirName === "bridge") {
      return (0, import_path.join)(__dirname2, "..");
    }
    return (0, import_path.join)(__dirname2, "..", "..");
  } catch {
  }
  return process.cwd();
}
function stripFrontmatter(content) {
  const match = content.match(/^---[\s\S]*?---\s*([\s\S]*)$/);
  return match ? match[1].trim() : content.trim();
}
function loadAgentPrompt(agentName) {
  if (!/^[a-z0-9-]+$/i.test(agentName)) {
    throw new Error(`Invalid agent name: contains disallowed characters`);
  }
  try {
    if (typeof __AGENT_PROMPTS__ !== "undefined" && __AGENT_PROMPTS__ !== null) {
      const prompt = __AGENT_PROMPTS__[agentName];
      if (prompt) return prompt;
    }
  } catch {
  }
  try {
    const agentsDir = (0, import_path.join)(getPackageDir(), "agents");
    const agentPath = (0, import_path.join)(agentsDir, `${agentName}.md`);
    const resolvedPath = (0, import_path.resolve)(agentPath);
    const resolvedAgentsDir = (0, import_path.resolve)(agentsDir);
    const rel = (0, import_path.relative)(resolvedAgentsDir, resolvedPath);
    if (rel.startsWith("..") || (0, import_path.isAbsolute)(rel)) {
      throw new Error(`Invalid agent name: path traversal detected`);
    }
    const content = (0, import_fs.readFileSync)(agentPath, "utf-8");
    return stripFrontmatter(content);
  } catch (error) {
    const message = error instanceof Error && error.message.includes("Invalid agent name") ? error.message : "Agent prompt file not found";
    console.warn(`[loadAgentPrompt] ${message}`);
    return `Agent: ${agentName}

Prompt unavailable.`;
  }
}

// src/config/loader.ts
var import_fs3 = require("fs");
var import_path4 = require("path");

// src/utils/paths.ts
var import_path3 = require("path");
var import_fs2 = require("fs");
var import_os2 = require("os");

// src/utils/config-dir.ts
var import_path2 = require("path");
var import_os = require("os");
function stripTrailingSep(p) {
  if (!p.endsWith(import_path2.sep)) {
    return p;
  }
  return p === (0, import_path2.parse)(p).root ? p : p.slice(0, -1);
}
function getClaudeConfigDir() {
  const home = (0, import_os.homedir)();
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (!configured) {
    return stripTrailingSep((0, import_path2.normalize)((0, import_path2.join)(home, ".claude")));
  }
  if (configured === "~") {
    return stripTrailingSep((0, import_path2.normalize)(home));
  }
  if (configured.startsWith("~/") || configured.startsWith("~\\")) {
    return stripTrailingSep((0, import_path2.normalize)((0, import_path2.join)(home, configured.slice(2))));
  }
  return stripTrailingSep((0, import_path2.normalize)(configured));
}

// src/utils/paths.ts
function getConfigDir() {
  if (process.platform === "win32") {
    return process.env.APPDATA || (0, import_path3.join)((0, import_os2.homedir)(), "AppData", "Roaming");
  }
  return process.env.XDG_CONFIG_HOME || (0, import_path3.join)((0, import_os2.homedir)(), ".config");
}
var STALE_THRESHOLD_MS = 24 * 60 * 60 * 1e3;

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
        if (content[i] === "\\") {
          result += content[i];
          i++;
          if (i < content.length) {
            result += content[i];
            i++;
          }
          continue;
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
  /^\[?fe80:/i,
  // IPv6 link-local
  /^\[?::ffff:/i,
  // IPv6-mapped IPv4 (all private ranges accessible via this prefix)
  /^\[?0{0,4}:{0,2}ffff:/i
  // IPv6-mapped IPv4 expanded forms
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
  if (/^0x[0-9a-f]+$/i.test(hostname)) {
    return {
      allowed: false,
      reason: `Hostname '${hostname}' looks like a hex-encoded IP address`
    };
  }
  if (/^\d+$/.test(hostname) && hostname.length > 3) {
    return {
      allowed: false,
      reason: `Hostname '${hostname}' looks like a decimal-encoded IP address`
    };
  }
  if (/^0\d+\./.test(hostname)) {
    return {
      allowed: false,
      reason: `Hostname '${hostname}' looks like an octal-encoded IP address`
    };
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
var TIER_ENV_KEYS = {
  LOW: [
    "OMC_MODEL_LOW",
    "CLAUDE_CODE_BEDROCK_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL"
  ],
  MEDIUM: [
    "OMC_MODEL_MEDIUM",
    "CLAUDE_CODE_BEDROCK_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL"
  ],
  HIGH: [
    "OMC_MODEL_HIGH",
    "CLAUDE_CODE_BEDROCK_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL"
  ]
};
var CLAUDE_FAMILY_DEFAULTS = {
  HAIKU: "claude-haiku-4-5",
  SONNET: "claude-sonnet-4-6",
  OPUS: "claude-opus-4-6"
};
var BUILTIN_TIER_MODEL_DEFAULTS = {
  LOW: CLAUDE_FAMILY_DEFAULTS.HAIKU,
  MEDIUM: CLAUDE_FAMILY_DEFAULTS.SONNET,
  HIGH: CLAUDE_FAMILY_DEFAULTS.OPUS
};
var CLAUDE_FAMILY_HIGH_VARIANTS = {
  HAIKU: `${CLAUDE_FAMILY_DEFAULTS.HAIKU}-high`,
  SONNET: `${CLAUDE_FAMILY_DEFAULTS.SONNET}-high`,
  OPUS: `${CLAUDE_FAMILY_DEFAULTS.OPUS}-high`
};
var BUILTIN_EXTERNAL_MODEL_DEFAULTS = {
  codexModel: "gpt-5.3-codex",
  geminiModel: "gemini-3.1-pro-preview"
};
function resolveTierModelFromEnv(tier) {
  for (const key of TIER_ENV_KEYS[tier]) {
    const value = process.env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return void 0;
}
function getDefaultModelHigh() {
  return resolveTierModelFromEnv("HIGH") || BUILTIN_TIER_MODEL_DEFAULTS.HIGH;
}
function getDefaultModelMedium() {
  return resolveTierModelFromEnv("MEDIUM") || BUILTIN_TIER_MODEL_DEFAULTS.MEDIUM;
}
function getDefaultModelLow() {
  return resolveTierModelFromEnv("LOW") || BUILTIN_TIER_MODEL_DEFAULTS.LOW;
}
function getDefaultTierModels() {
  return {
    LOW: getDefaultModelLow(),
    MEDIUM: getDefaultModelMedium(),
    HIGH: getDefaultModelHigh()
  };
}
function resolveClaudeFamily(modelId) {
  const lower = modelId.toLowerCase();
  if (!lower.includes("claude")) return null;
  if (lower.includes("sonnet")) return "SONNET";
  if (lower.includes("opus")) return "OPUS";
  if (lower.includes("haiku")) return "HAIKU";
  return null;
}
function isBedrock() {
  if (process.env.CLAUDE_CODE_USE_BEDROCK === "1") {
    return true;
  }
  const modelId = process.env.CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || "";
  if (modelId && /^((us|eu|ap|global)\.anthropic\.|anthropic\.claude)/i.test(modelId)) {
    return true;
  }
  if (modelId && /^arn:aws(-[^:]+)?:bedrock:/i.test(modelId) && /:(inference-profile|application-inference-profile)\//i.test(modelId) && modelId.toLowerCase().includes("claude")) {
    return true;
  }
  return false;
}
function isProviderSpecificModelId(modelId) {
  if (/^((us|eu|ap|global)\.anthropic\.|anthropic\.claude)/i.test(modelId)) {
    return true;
  }
  if (/^arn:aws(-[^:]+)?:bedrock:/i.test(modelId)) {
    return true;
  }
  if (modelId.toLowerCase().startsWith("vertex_ai/")) {
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
function buildDefaultConfig() {
  const defaultTierModels = getDefaultTierModels();
  return {
    agents: {
      omc: { model: defaultTierModels.HIGH },
      explore: { model: defaultTierModels.LOW },
      analyst: { model: defaultTierModels.HIGH },
      planner: { model: defaultTierModels.HIGH },
      architect: { model: defaultTierModels.HIGH },
      debugger: { model: defaultTierModels.MEDIUM },
      executor: { model: defaultTierModels.MEDIUM },
      verifier: { model: defaultTierModels.MEDIUM },
      securityReviewer: { model: defaultTierModels.MEDIUM },
      codeReviewer: { model: defaultTierModels.HIGH },
      testEngineer: { model: defaultTierModels.MEDIUM },
      designer: { model: defaultTierModels.MEDIUM },
      writer: { model: defaultTierModels.LOW },
      qaTester: { model: defaultTierModels.MEDIUM },
      scientist: { model: defaultTierModels.MEDIUM },
      tracer: { model: defaultTierModels.MEDIUM },
      gitMaster: { model: defaultTierModels.MEDIUM },
      codeSimplifier: { model: defaultTierModels.HIGH },
      critic: { model: defaultTierModels.HIGH },
      documentSpecialist: { model: defaultTierModels.MEDIUM }
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
      tierModels: { ...defaultTierModels },
      agentOverrides: {
        architect: {
          tier: "HIGH",
          reason: "Advisory agent requires deep reasoning"
        },
        planner: {
          tier: "HIGH",
          reason: "Strategic planning requires deep reasoning"
        },
        critic: {
          tier: "HIGH",
          reason: "Critical review requires deep reasoning"
        },
        analyst: {
          tier: "HIGH",
          reason: "Pre-planning analysis requires deep reasoning"
        },
        explore: { tier: "LOW", reason: "Exploration is search-focused" },
        writer: { tier: "LOW", reason: "Documentation is straightforward" }
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
        codexModel: BUILTIN_EXTERNAL_MODEL_DEFAULTS.codexModel,
        geminiModel: BUILTIN_EXTERNAL_MODEL_DEFAULTS.geminiModel
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
      defaultProvider: "claude",
      roles: {}
    },
    planOutput: {
      directory: ".omc/plans",
      filenameTemplate: "{{name}}.md"
    },
    teleport: {
      symlinkNodeModules: true
    },
    startupCodebaseMap: {
      enabled: true,
      maxFiles: 200,
      maxDepth: 4
    },
    taskSizeDetection: {
      enabled: true,
      smallWordLimit: 50,
      largeWordLimit: 200,
      suppressHeavyModesForSmallTasks: true
    },
    promptPrerequisites: {
      enabled: true,
      sectionNames: {
        memory: ["M\xC9MOIRE", "MEMOIRE", "MEMORY"],
        skills: ["SKILLS"],
        verifyFirst: ["VERIFY-FIRST", "VERIFY FIRST", "VERIFY_FIRST"],
        context: ["CONTEXT"]
      },
      blockingTools: ["Edit", "MultiEdit", "Write", "Agent", "Task"],
      executionKeywords: ["ralph", "ultrawork", "autopilot"]
    }
  };
}
var DEFAULT_CONFIG = buildDefaultConfig();
function getConfigPaths() {
  const userConfigDir = getConfigDir();
  return {
    user: (0, import_path4.join)(userConfigDir, "claude-omc", "config.jsonc"),
    project: (0, import_path4.join)(process.cwd(), ".claude", "omc.jsonc")
  };
}
function loadJsoncFile(path4) {
  if (!(0, import_fs3.existsSync)(path4)) {
    return null;
  }
  try {
    const content = (0, import_fs3.readFileSync)(path4, "utf-8");
    const result = parseJsonc(content);
    return result;
  } catch (error) {
    console.error(`Error loading config from ${path4}:`, error);
    return null;
  }
}
function deepMerge(target, source) {
  const result = { ...target };
  const mutableResult = result;
  for (const key of Object.keys(source)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype")
      continue;
    const sourceValue = source[key];
    const targetValue = mutableResult[key];
    if (sourceValue !== void 0 && typeof sourceValue === "object" && sourceValue !== null && !Array.isArray(sourceValue) && typeof targetValue === "object" && targetValue !== null && !Array.isArray(targetValue)) {
      mutableResult[key] = deepMerge(
        targetValue,
        sourceValue
      );
    } else if (sourceValue !== void 0) {
      mutableResult[key] = sourceValue;
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
  let config = buildDefaultConfig();
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

// src/agents/architect.ts
var ARCHITECT_PROMPT_METADATA = {
  category: "advisor",
  cost: "EXPENSIVE",
  promptAlias: "architect",
  triggers: [
    { domain: "Architecture decisions", trigger: "Multi-system tradeoffs, unfamiliar patterns" },
    { domain: "Self-review", trigger: "After completing significant implementation" },
    { domain: "Hard debugging", trigger: "After 2+ failed fix attempts" }
  ],
  useWhen: [
    "Complex architecture design",
    "After completing significant work",
    "2+ failed fix attempts",
    "Unfamiliar code patterns",
    "Security/performance concerns",
    "Multi-system tradeoffs"
  ],
  avoidWhen: [
    "Simple file operations (use direct tools)",
    "First attempt at any fix (try yourself first)",
    "Questions answerable from code you've read",
    "Trivial decisions (variable names, formatting)",
    "Things you can infer from existing code patterns"
  ]
};
var architectAgent = {
  name: "architect",
  description: "Read-only consultation agent. High-IQ reasoning specialist for debugging hard problems and high-difficulty architecture design.",
  prompt: loadAgentPrompt("architect"),
  model: "opus",
  defaultModel: "opus",
  metadata: ARCHITECT_PROMPT_METADATA
};

// src/agents/designer.ts
var FRONTEND_ENGINEER_PROMPT_METADATA = {
  category: "specialist",
  cost: "CHEAP",
  promptAlias: "designer",
  triggers: [
    {
      domain: "UI/UX",
      trigger: "Visual changes, styling, components, accessibility"
    },
    {
      domain: "Design",
      trigger: "Layout, animations, responsive design"
    }
  ],
  useWhen: [
    "Visual styling or layout changes",
    "Component design or refactoring",
    "Animation implementation",
    "Accessibility improvements",
    "Responsive design work"
  ],
  avoidWhen: [
    "Pure logic changes in frontend files",
    "Backend/API work",
    "Non-visual refactoring"
  ]
};
var designerAgent = {
  name: "designer",
  description: `Designer-turned-developer who crafts stunning UI/UX even without design mockups. Use for VISUAL changes only (styling, layout, animation). Pure logic changes in frontend files should be handled directly.`,
  prompt: loadAgentPrompt("designer"),
  model: "sonnet",
  defaultModel: "sonnet",
  metadata: FRONTEND_ENGINEER_PROMPT_METADATA
};

// src/agents/writer.ts
var DOCUMENT_WRITER_PROMPT_METADATA = {
  category: "specialist",
  cost: "FREE",
  promptAlias: "writer",
  triggers: [
    {
      domain: "Documentation",
      trigger: "README, API docs, guides, comments"
    }
  ],
  useWhen: [
    "Creating or updating README files",
    "Writing API documentation",
    "Creating user guides or tutorials",
    "Adding code comments or JSDoc",
    "Architecture documentation"
  ],
  avoidWhen: [
    "Code implementation tasks",
    "Bug fixes",
    "Non-documentation tasks"
  ]
};
var writerAgent = {
  name: "writer",
  description: `Technical writer who crafts clear, comprehensive documentation. Specializes in README files, API docs, architecture docs, and user guides.`,
  prompt: loadAgentPrompt("writer"),
  model: "haiku",
  defaultModel: "haiku",
  metadata: DOCUMENT_WRITER_PROMPT_METADATA
};

// src/agents/critic.ts
var CRITIC_PROMPT_METADATA = {
  category: "reviewer",
  cost: "EXPENSIVE",
  promptAlias: "critic",
  triggers: [
    {
      domain: "Plan Review",
      trigger: "Evaluating work plans before execution"
    }
  ],
  useWhen: [
    "After planner creates a work plan",
    "Before executing a complex plan",
    "When plan quality validation is needed",
    "To catch gaps before implementation"
  ],
  avoidWhen: [
    "Simple, straightforward tasks",
    "When no plan exists to review",
    "During implementation phase"
  ]
};
var criticAgent = {
  name: "critic",
  description: `Expert reviewer for evaluating work plans against rigorous clarity, verifiability, and completeness standards. Use after planner creates a work plan to validate it before execution.`,
  prompt: loadAgentPrompt("critic"),
  model: "opus",
  defaultModel: "opus",
  metadata: CRITIC_PROMPT_METADATA
};

// src/agents/analyst.ts
var ANALYST_PROMPT_METADATA = {
  category: "planner",
  cost: "EXPENSIVE",
  promptAlias: "analyst",
  triggers: [
    {
      domain: "Pre-Planning",
      trigger: "Hidden requirements, edge cases, risk analysis"
    }
  ],
  useWhen: [
    "Before creating a work plan",
    "When requirements seem incomplete",
    "To identify hidden assumptions",
    "Risk analysis before implementation",
    "Scope validation"
  ],
  avoidWhen: [
    "Simple, well-defined tasks",
    "During implementation phase",
    "When plan already reviewed"
  ]
};
var analystAgent = {
  name: "analyst",
  description: `Pre-planning consultant that analyzes requests before implementation to identify hidden requirements, edge cases, and potential risks. Use before creating a work plan.`,
  prompt: loadAgentPrompt("analyst"),
  model: "opus",
  defaultModel: "opus",
  metadata: ANALYST_PROMPT_METADATA
};

// src/agents/executor.ts
var EXECUTOR_PROMPT_METADATA = {
  category: "specialist",
  cost: "CHEAP",
  promptAlias: "Junior",
  triggers: [
    { domain: "Direct implementation", trigger: "Single-file changes, focused tasks" },
    { domain: "Bug fixes", trigger: "Clear, scoped fixes" },
    { domain: "Small features", trigger: "Well-defined, isolated work" }
  ],
  useWhen: [
    "Direct, focused implementation tasks",
    "Single-file or few-file changes",
    "When delegation overhead isn't worth it",
    "Clear, well-scoped work items"
  ],
  avoidWhen: [
    "Multi-file refactoring (use orchestrator)",
    "Tasks requiring research (use explore/document-specialist first)",
    "Complex decisions (consult architect)"
  ]
};
var executorAgent = {
  name: "executor",
  description: "Focused task executor. Execute tasks directly. NEVER delegate or spawn other agents. Same discipline as OMC, no delegation.",
  prompt: loadAgentPrompt("executor"),
  model: "sonnet",
  defaultModel: "sonnet",
  metadata: EXECUTOR_PROMPT_METADATA
};

// src/agents/planner.ts
var PLANNER_PROMPT_METADATA = {
  category: "planner",
  cost: "EXPENSIVE",
  promptAlias: "planner",
  triggers: [
    {
      domain: "Strategic Planning",
      trigger: "Comprehensive work plans, interview-style consultation"
    }
  ],
  useWhen: [
    "Complex features requiring planning",
    "When requirements need clarification through interview",
    "Creating comprehensive work plans",
    "Before large implementation efforts"
  ],
  avoidWhen: [
    "Simple, straightforward tasks",
    "When implementation should just start",
    "When a plan already exists"
  ]
};
var plannerAgent = {
  name: "planner",
  description: `Strategic planning consultant. Interviews users to understand requirements, then creates comprehensive work plans. NEVER implements - only plans.`,
  prompt: loadAgentPrompt("planner"),
  model: "opus",
  defaultModel: "opus",
  metadata: PLANNER_PROMPT_METADATA
};

// src/agents/qa-tester.ts
var QA_TESTER_PROMPT_METADATA = {
  category: "specialist",
  cost: "CHEAP",
  promptAlias: "QATester",
  triggers: [
    { domain: "CLI testing", trigger: "Testing command-line applications" },
    { domain: "Service testing", trigger: "Starting and testing background services" },
    { domain: "Integration testing", trigger: "End-to-end CLI workflow verification" },
    { domain: "Interactive testing", trigger: "Testing applications requiring user input" }
  ],
  useWhen: [
    "Testing CLI applications that need interactive input",
    "Starting background services and verifying their behavior",
    "Running end-to-end tests on command-line tools",
    "Testing applications that produce streaming output",
    "Verifying service startup and shutdown behavior"
  ],
  avoidWhen: [
    "Unit testing (use standard test runners)",
    "API testing without CLI interface (use curl/httpie directly)",
    "Static code analysis (use architect or explore)"
  ]
};
var qaTesterAgent = {
  name: "qa-tester",
  description: "Interactive CLI testing specialist using tmux. Tests CLI applications, background services, and interactive tools. Manages test sessions, sends commands, verifies output, and ensures cleanup.",
  prompt: loadAgentPrompt("qa-tester"),
  model: "sonnet",
  defaultModel: "sonnet",
  metadata: QA_TESTER_PROMPT_METADATA
};

// src/agents/scientist.ts
var SCIENTIST_PROMPT_METADATA = {
  category: "specialist",
  cost: "CHEAP",
  promptAlias: "scientist",
  triggers: [
    { domain: "Data analysis", trigger: "Analyzing datasets and computing statistics" },
    { domain: "Research execution", trigger: "Running data experiments and generating findings" },
    { domain: "Python data work", trigger: "Using pandas, numpy, scipy for data tasks" },
    { domain: "EDA", trigger: "Exploratory data analysis on files" },
    { domain: "Hypothesis testing", trigger: "Statistical tests with confidence intervals and effect sizes" },
    { domain: "Research stages", trigger: "Multi-stage analysis with structured markers" }
  ],
  useWhen: [
    "Analyzing CSV, JSON, Parquet, or other data files",
    "Computing descriptive statistics or aggregations",
    "Performing exploratory data analysis (EDA)",
    "Generating data-driven findings and insights",
    "Simple ML tasks like clustering or regression",
    "Data transformations and feature engineering",
    "Generating data analysis reports with visualizations",
    "Hypothesis testing with statistical evidence markers",
    "Research stages with [STAGE:*] markers for orchestration"
  ],
  avoidWhen: [
    "Researching external documentation or APIs (use document-specialist)",
    "Implementing production code features (use executor)",
    "Architecture or system design questions (use architect)",
    "No data files to analyze - just theoretical questions",
    "Web scraping or external data fetching (use document-specialist)"
  ]
};
var scientistAgent = {
  name: "scientist",
  description: "Data analysis and research execution specialist. Executes Python code for EDA, statistical analysis, and generating data-driven findings. Works with CSV, JSON, Parquet files using pandas, numpy, scipy.",
  prompt: loadAgentPrompt("scientist"),
  model: "sonnet",
  defaultModel: "sonnet",
  metadata: SCIENTIST_PROMPT_METADATA
};

// src/agents/explore.ts
var EXPLORE_PROMPT_METADATA = {
  category: "exploration",
  cost: "CHEAP",
  promptAlias: "Explore",
  triggers: [
    { domain: "Internal codebase search", trigger: "Finding implementations, patterns, files" },
    { domain: "Project structure", trigger: "Understanding code organization" },
    { domain: "Code discovery", trigger: "Locating specific code by pattern" }
  ],
  useWhen: [
    "Finding files by pattern or name",
    "Searching for implementations in current project",
    "Understanding project structure",
    "Locating code by content or pattern",
    "Quick codebase exploration"
  ],
  avoidWhen: [
    "External documentation, literature, or academic paper lookup (use document-specialist)",
    "Database/reference/manual lookups outside the current project (use document-specialist)",
    "GitHub/npm package research (use document-specialist)",
    "Complex architectural analysis (use architect)",
    "When you already know the file location"
  ]
};
var exploreAgent = {
  name: "explore",
  description: "Fast codebase exploration and pattern search. Use for finding files, understanding structure, locating implementations. Searches INTERNAL codebase only; external docs, literature, papers, and reference databases belong to document-specialist.",
  prompt: loadAgentPrompt("explore"),
  model: "haiku",
  defaultModel: "haiku",
  metadata: EXPLORE_PROMPT_METADATA
};

// src/agents/tracer.ts
var TRACER_PROMPT_METADATA = {
  category: "advisor",
  cost: "EXPENSIVE",
  promptAlias: "tracer",
  triggers: [
    { domain: "Causal tracing", trigger: "Why did this happen? Which explanation best fits the evidence?" },
    { domain: "Forensic analysis", trigger: "Observed output, artifact, or behavior needs ranked explanations" },
    { domain: "Evidence-driven uncertainty reduction", trigger: "Need competing hypotheses and the next best probe" }
  ],
  useWhen: [
    "Tracing ambiguous runtime behavior, regressions, or orchestration outcomes",
    "Ranking competing explanations for an observed result",
    "Separating observation, evidence, and inference",
    "Explaining performance, architecture, scientific, or configuration outcomes",
    "Identifying the next probe that would collapse uncertainty fastest"
  ],
  avoidWhen: [
    "The task is pure implementation or fixing (use executor/debugger)",
    "The task is a generic summary without causal analysis",
    "A single-file code search is enough (use explore)",
    "You already have decisive evidence and only need execution"
  ]
};
var tracerAgent = {
  name: "tracer",
  description: "Evidence-driven causal tracing specialist. Explains observed outcomes using competing hypotheses, evidence for and against, uncertainty tracking, and next-probe recommendations.",
  prompt: loadAgentPrompt("tracer"),
  model: "sonnet",
  defaultModel: "sonnet",
  metadata: TRACER_PROMPT_METADATA
};

// src/agents/document-specialist.ts
var DOCUMENT_SPECIALIST_PROMPT_METADATA = {
  category: "exploration",
  cost: "CHEAP",
  promptAlias: "document-specialist",
  triggers: [
    {
      domain: "Project documentation",
      trigger: "README, docs/, migration guides, local references"
    },
    {
      domain: "External documentation",
      trigger: "API references, official docs"
    },
    {
      domain: "API/framework correctness",
      trigger: "Context Hub / chub first when available; curated backend fallback otherwise"
    },
    {
      domain: "OSS implementations",
      trigger: "GitHub examples, package source"
    },
    {
      domain: "Best practices",
      trigger: "Community patterns, recommendations"
    },
    {
      domain: "Literature and reference research",
      trigger: "Academic papers, manuals, reference databases"
    }
  ],
  useWhen: [
    "Checking README/docs/local reference files before broader research",
    "Looking up official documentation",
    "Using Context Hub / chub (or another curated docs backend) for external API/framework correctness when available",
    "Finding GitHub examples",
    "Researching npm/pip packages",
    "Stack Overflow solutions",
    "External API references",
    "Searching external literature or academic papers",
    "Looking up manuals, databases, or reference material outside the current project"
  ],
  avoidWhen: [
    "Internal codebase implementation search (use explore)",
    "Current project source files when the task is code discovery rather than documentation lookup (use explore)",
    "When you already have the information"
  ]
};
var documentSpecialistAgent = {
  name: "document-specialist",
  description: "Document Specialist for documentation research and reference finding. Use for local repo docs, official docs, Context Hub / chub or other curated docs backends for API/framework correctness, GitHub examples, OSS implementations, external literature, academic papers, and reference/database lookups. Avoid internal implementation search; use explore for code discovery.",
  prompt: loadAgentPrompt("document-specialist"),
  model: "sonnet",
  defaultModel: "sonnet",
  metadata: DOCUMENT_SPECIALIST_PROMPT_METADATA
};

// src/agents/definitions.ts
var debuggerAgent = {
  name: "debugger",
  description: "Root-cause analysis, regression isolation, failure diagnosis (Sonnet).",
  prompt: loadAgentPrompt("debugger"),
  model: "sonnet",
  defaultModel: "sonnet"
};
var verifierAgent = {
  name: "verifier",
  description: "Completion evidence, claim validation, test adequacy (Sonnet).",
  prompt: loadAgentPrompt("verifier"),
  model: "sonnet",
  defaultModel: "sonnet"
};
var testEngineerAgent = {
  name: "test-engineer",
  description: "Test strategy, coverage, flaky test hardening (Sonnet).",
  prompt: loadAgentPrompt("test-engineer"),
  model: "sonnet",
  defaultModel: "sonnet"
};
var securityReviewerAgent = {
  name: "security-reviewer",
  description: "Security vulnerability detection specialist (Sonnet). Use for security audits and OWASP detection.",
  prompt: loadAgentPrompt("security-reviewer"),
  model: "sonnet",
  defaultModel: "sonnet"
};
var codeReviewerAgent = {
  name: "code-reviewer",
  description: "Expert code review specialist (Opus). Use for comprehensive code quality review.",
  prompt: loadAgentPrompt("code-reviewer"),
  model: "opus",
  defaultModel: "opus"
};
var gitMasterAgent = {
  name: "git-master",
  description: "Git expert for atomic commits, rebasing, and history management with style detection",
  prompt: loadAgentPrompt("git-master"),
  model: "sonnet",
  defaultModel: "sonnet"
};
var codeSimplifierAgent = {
  name: "code-simplifier",
  description: "Simplifies and refines code for clarity, consistency, and maintainability (Opus).",
  prompt: loadAgentPrompt("code-simplifier"),
  model: "opus",
  defaultModel: "opus"
};

// src/features/delegation-enforcer.ts
var FAMILY_TO_ALIAS = {
  SONNET: "sonnet",
  OPUS: "opus",
  HAIKU: "haiku"
};
function normalizeToCcAlias(model) {
  const family = resolveClaudeFamily(model);
  return family ? FAMILY_TO_ALIAS[family] ?? model : model;
}

// src/lib/security-config.ts
var import_fs4 = require("fs");
var import_path5 = require("path");
var DEFAULTS = {
  restrictToolPaths: false,
  pythonSandbox: false,
  disableProjectSkills: false,
  disableAutoUpdate: false,
  hardMaxIterations: 500,
  disableRemoteMcp: false,
  disableExternalLLM: false
};
var STRICT_OVERRIDES = {
  restrictToolPaths: true,
  pythonSandbox: true,
  disableProjectSkills: true,
  disableAutoUpdate: true,
  hardMaxIterations: 200,
  disableRemoteMcp: true,
  disableExternalLLM: true
};
var cachedConfig = null;
function loadSecurityFromConfigFiles() {
  const paths = [
    (0, import_path5.join)(process.cwd(), ".claude", "omc.jsonc"),
    (0, import_path5.join)(getConfigDir(), "claude-omc", "config.jsonc")
  ];
  for (const configPath of paths) {
    if (!(0, import_fs4.existsSync)(configPath)) continue;
    try {
      const content = (0, import_fs4.readFileSync)(configPath, "utf-8");
      const parsed = parseJsonc(content);
      if (parsed?.security && typeof parsed.security === "object") {
        return parsed.security;
      }
    } catch {
    }
  }
  return {};
}
function getSecurityConfig() {
  if (cachedConfig) return cachedConfig;
  const isStrict = process.env.OMC_SECURITY === "strict";
  const base = isStrict ? { ...STRICT_OVERRIDES } : { ...DEFAULTS };
  const fileOverrides = loadSecurityFromConfigFiles();
  if (isStrict) {
    cachedConfig = {
      restrictToolPaths: base.restrictToolPaths || (fileOverrides.restrictToolPaths ?? false),
      pythonSandbox: base.pythonSandbox || (fileOverrides.pythonSandbox ?? false),
      disableProjectSkills: base.disableProjectSkills || (fileOverrides.disableProjectSkills ?? false),
      disableAutoUpdate: base.disableAutoUpdate || (fileOverrides.disableAutoUpdate ?? false),
      disableRemoteMcp: base.disableRemoteMcp || (fileOverrides.disableRemoteMcp ?? false),
      disableExternalLLM: base.disableExternalLLM || (fileOverrides.disableExternalLLM ?? false),
      hardMaxIterations: Math.min(base.hardMaxIterations, typeof fileOverrides.hardMaxIterations === "number" && fileOverrides.hardMaxIterations > 0 ? fileOverrides.hardMaxIterations : base.hardMaxIterations)
    };
  } else {
    cachedConfig = {
      restrictToolPaths: fileOverrides.restrictToolPaths ?? base.restrictToolPaths,
      pythonSandbox: fileOverrides.pythonSandbox ?? base.pythonSandbox,
      disableProjectSkills: fileOverrides.disableProjectSkills ?? base.disableProjectSkills,
      disableAutoUpdate: fileOverrides.disableAutoUpdate ?? base.disableAutoUpdate,
      disableRemoteMcp: fileOverrides.disableRemoteMcp ?? base.disableRemoteMcp,
      disableExternalLLM: fileOverrides.disableExternalLLM ?? base.disableExternalLLM,
      hardMaxIterations: fileOverrides.hardMaxIterations ?? base.hardMaxIterations
    };
  }
  return cachedConfig;
}
function isExternalLLMDisabled() {
  return getSecurityConfig().disableExternalLLM;
}

// src/team/model-contract.ts
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
  const custom = (process.env.OMC_TRUSTED_CLI_DIRS ?? "").split(":").map((part) => part.trim()).filter(Boolean).filter((part) => (0, import_path6.isAbsolute)(part));
  trusted.push(...custom);
  return trusted;
}
function isTrustedPrefix(resolvedPath) {
  const normalized = (0, import_path6.normalize)(resolvedPath);
  return getTrustedPrefixes().some((prefix) => normalized.startsWith((0, import_path6.normalize)(prefix)));
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
  const resolvedPath = (0, import_path6.normalize)(firstLine);
  if (!(0, import_path6.isAbsolute)(resolvedPath)) {
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
      if (model) {
        const resolved = isProviderSpecificModelId(model) ? model : normalizeToCcAlias(model);
        args.push("--model", resolved);
      }
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
  if (agentType !== "claude" && isExternalLLMDisabled()) {
    throw new Error(
      `External LLM provider "${agentType}" is blocked by security policy (disableExternalLLM). Only Claude workers are allowed in the current security configuration.`
    );
  }
  return contract;
}
function validateBinaryRef(binary) {
  if ((0, import_path6.isAbsolute)(binary)) return;
  if (/^[A-Za-z0-9._-]+$/.test(binary)) return;
  throw new Error(`Unsafe CLI binary reference: ${binary}`);
}
function resolveBinaryPath(binary) {
  validateBinaryRef(binary);
  if ((0, import_path6.isAbsolute)(binary)) return binary;
  try {
    const resolver = process.platform === "win32" ? "where" : "which";
    const result = (0, import_child_process.spawnSync)(resolver, [binary], { timeout: 5e3, encoding: "utf8" });
    if (result.status !== 0) return binary;
    const lines = result.stdout?.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) ?? [];
    const firstPath = lines[0];
    const isResolvedAbsolute = !!firstPath && ((0, import_path6.isAbsolute)(firstPath) || import_path6.win32.isAbsolute(firstPath));
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
var WORKER_MODEL_ENV_ALLOWLIST = [
  "ANTHROPIC_MODEL",
  "CLAUDE_MODEL",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_BEDROCK_OPUS_MODEL",
  "CLAUDE_CODE_BEDROCK_SONNET_MODEL",
  "CLAUDE_CODE_BEDROCK_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "OMC_MODEL_HIGH",
  "OMC_MODEL_MEDIUM",
  "OMC_MODEL_LOW",
  "OMC_EXTERNAL_MODELS_DEFAULT_CODEX_MODEL",
  "OMC_CODEX_DEFAULT_MODEL",
  "OMC_EXTERNAL_MODELS_DEFAULT_GEMINI_MODEL",
  "OMC_GEMINI_DEFAULT_MODEL"
];
function getWorkerEnv(teamName, workerName2, agentType, env = process.env) {
  validateTeamName(teamName);
  const workerEnv = {
    OMC_TEAM_WORKER: `${teamName}/${workerName2}`,
    OMC_TEAM_NAME: teamName,
    OMC_WORKER_AGENT_TYPE: agentType
  };
  for (const key of WORKER_MODEL_ENV_ALLOWLIST) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0) {
      workerEnv[key] = value;
    }
  }
  return workerEnv;
}
function isPromptModeAgent(agentType) {
  const contract = getContract(agentType);
  return !!contract.supportsPromptMode;
}
function resolveClaudeWorkerModel(env = process.env) {
  if (env.OMC_ROUTING_FORCE_INHERIT === "true") {
    return void 0;
  }
  if (!isBedrock() && !isVertexAI()) {
    return void 0;
  }
  const directModel = env.ANTHROPIC_MODEL || env.CLAUDE_MODEL || "";
  if (directModel) {
    return directModel;
  }
  const bedrockModel = env.CLAUDE_CODE_BEDROCK_SONNET_MODEL || env.ANTHROPIC_DEFAULT_SONNET_MODEL || "";
  if (bedrockModel) {
    return bedrockModel;
  }
  const omcModel = env.OMC_MODEL_MEDIUM || "";
  if (omcModel) {
    return omcModel;
  }
  return void 0;
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
var import_path9 = require("path");

// src/agents/prompt-helpers.ts
var import_fs6 = require("fs");
var import_path8 = require("path");
var import_url2 = require("url");
var import_meta2 = {};
function getPackageDir2() {
  if (typeof __dirname !== "undefined" && __dirname) {
    const currentDirName = (0, import_path8.basename)(__dirname);
    const parentDirName = (0, import_path8.basename)((0, import_path8.dirname)(__dirname));
    if (currentDirName === "bridge") {
      return (0, import_path8.join)(__dirname, "..");
    }
    if (currentDirName === "agents" && (parentDirName === "src" || parentDirName === "dist")) {
      return (0, import_path8.join)(__dirname, "..", "..");
    }
  }
  try {
    const __filename = (0, import_url2.fileURLToPath)(import_meta2.url);
    const __dirname2 = (0, import_path8.dirname)(__filename);
    const currentDirName = (0, import_path8.basename)(__dirname2);
    if (currentDirName === "bridge") {
      return (0, import_path8.join)(__dirname2, "..");
    }
    return (0, import_path8.join)(__dirname2, "..", "..");
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
    const agentsDir = (0, import_path8.join)(getPackageDir2(), "agents");
    const files = (0, import_fs6.readdirSync)(agentsDir);
    _cachedRoles = files.filter((f) => f.endsWith(".md")).map((f) => (0, import_path8.basename)(f, ".md")).sort();
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

// src/utils/omc-cli-rendering.ts
var import_child_process3 = require("child_process");
var OMC_CLI_BINARY = "omc";
var OMC_PLUGIN_BRIDGE_PREFIX = 'node "$CLAUDE_PLUGIN_ROOT"/bridge/cli.cjs';
function commandExists(command, env) {
  const lookupCommand = process.platform === "win32" ? "where" : "which";
  const result = (0, import_child_process3.spawnSync)(lookupCommand, [command], {
    stdio: "ignore",
    env
  });
  return result.status === 0;
}
function resolveOmcCliPrefix(options = {}) {
  const env = options.env ?? process.env;
  const omcAvailable = options.omcAvailable ?? commandExists(OMC_CLI_BINARY, env);
  if (omcAvailable) {
    return OMC_CLI_BINARY;
  }
  const pluginRoot = typeof env.CLAUDE_PLUGIN_ROOT === "string" ? env.CLAUDE_PLUGIN_ROOT.trim() : "";
  if (pluginRoot) {
    return OMC_PLUGIN_BRIDGE_PREFIX;
  }
  return OMC_CLI_BINARY;
}
function formatOmcCliInvocation(commandSuffix, options = {}) {
  const suffix = commandSuffix.trim().replace(/^omc\s+/, "");
  return `${resolveOmcCliPrefix(options)} ${suffix}`.trim();
}

// src/team/worker-bootstrap.ts
function buildInstructionPath(...parts) {
  return (0, import_path9.join)(...parts).replaceAll("\\", "/");
}
function generateTriggerMessage(teamName, workerName2, teamStateRoot2 = ".omc/state") {
  const inboxPath = buildInstructionPath(teamStateRoot2, "team", teamName, "workers", workerName2, "inbox.md");
  if (teamStateRoot2 !== ".omc/state") {
    return `Read ${inboxPath}, work now, report progress.`;
  }
  return `Read ${inboxPath}, start work now, report concrete progress (not ACK-only), and keep executing your assigned or next feasible work.`;
}
function agentTypeGuidance(agentType) {
  const teamApiCommand = formatOmcCliInvocation("team api");
  const claimTaskCommand = formatOmcCliInvocation("team api claim-task");
  const transitionTaskStatusCommand = formatOmcCliInvocation("team api transition-task-status");
  switch (agentType) {
    case "codex":
      return [
        "### Agent-Type Guidance (codex)",
        `- Prefer short, explicit \`${teamApiCommand} ... --json\` commands and parse outputs before next step.`,
        "- If a command fails, report the exact stderr to leader-fixed before retrying.",
        `- You MUST run \`${claimTaskCommand}\` before starting work and \`${transitionTaskStatusCommand}\` when done.`
      ].join("\n");
    case "gemini":
      return [
        "### Agent-Type Guidance (gemini)",
        "- Execute task work in small, verifiable increments and report each milestone to leader-fixed.",
        "- Keep commit-sized changes scoped to assigned files only; no broad refactors.",
        `- CRITICAL: You MUST run \`${claimTaskCommand}\` before starting work and \`${transitionTaskStatusCommand}\` when done. Do not exit without transitioning the task status.`
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
  const claimTaskCommand = formatOmcCliInvocation(`team api claim-task --input "{\\"team_name\\":\\"${teamName}\\",\\"task_id\\":\\"<id>\\",\\"worker\\":\\"${workerName2}\\"}" --json`);
  const sendAckCommand = formatOmcCliInvocation(`team api send-message --input "{\\"team_name\\":\\"${teamName}\\",\\"from_worker\\":\\"${workerName2}\\",\\"to_worker\\":\\"leader-fixed\\",\\"body\\":\\"ACK: ${workerName2} initialized\\"}" --json`);
  const completeTaskCommand = formatOmcCliInvocation(`team api transition-task-status --input "{\\"team_name\\":\\"${teamName}\\",\\"task_id\\":\\"<id>\\",\\"from\\":\\"in_progress\\",\\"to\\":\\"completed\\",\\"claim_token\\":\\"<claim_token>\\"}" --json`);
  const failTaskCommand = formatOmcCliInvocation(`team api transition-task-status --input "{\\"team_name\\":\\"${teamName}\\",\\"task_id\\":\\"<id>\\",\\"from\\":\\"in_progress\\",\\"to\\":\\"failed\\",\\"claim_token\\":\\"<claim_token>\\"}" --json`);
  const readTaskCommand = formatOmcCliInvocation(`team api read-task --input "{\\"team_name\\":\\"${teamName}\\",\\"task_id\\":\\"<id>\\"}" --json`);
  const releaseClaimCommand = formatOmcCliInvocation(`team api release-task-claim --input "{\\"team_name\\":\\"${teamName}\\",\\"task_id\\":\\"<id>\\",\\"claim_token\\":\\"<claim_token>\\",\\"worker\\":\\"${workerName2}\\"}" --json`);
  const mailboxListCommand = formatOmcCliInvocation(`team api mailbox-list --input "{\\"team_name\\":\\"${teamName}\\",\\"worker\\":\\"${workerName2}\\"}" --json`);
  const mailboxDeliveredCommand = formatOmcCliInvocation(`team api mailbox-mark-delivered --input "{\\"team_name\\":\\"${teamName}\\",\\"worker\\":\\"${workerName2}\\",\\"message_id\\":\\"<id>\\"}" --json`);
  const teamApiCommand = formatOmcCliInvocation("team api");
  const teamCommand = formatOmcCliInvocation("team");
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

## MANDATORY WORKFLOW \u2014 Follow These Steps In Order
You MUST complete ALL of these steps. Do NOT skip any step. Do NOT exit without step 4.

1. **Claim** your task (run this command first):
   \`${claimTaskCommand}\`
   Save the \`claim_token\` from the response \u2014 you need it for step 4.
2. **Do the work** described in your task assignment below.
3. **Send ACK** to the leader:
   \`${sendAckCommand}\`
4. **Transition** the task status (REQUIRED before exit):
   - On success: \`${completeTaskCommand}\`
   - On failure: \`${failTaskCommand}\`
5. **Keep going after replies**: ACK/progress messages are not a stop signal. Keep executing your assigned or next feasible work until the task is actually complete or failed, then transition and exit.

## Identity
- **Team**: ${teamName}
- **Worker**: ${workerName2}
- **Agent Type**: ${agentType}
- **Environment**: OMC_TEAM_WORKER=${teamName}/${workerName2}

## Your Tasks
${taskList}

## Task Lifecycle Reference (CLI API)
Use the CLI API for all task lifecycle operations. Do NOT directly edit task files.

- Inspect task state: \`${readTaskCommand}\`
- Task id format: State/CLI APIs use task_id: "<id>" (example: "1"), not "task-1"
- Claim task: \`${claimTaskCommand}\`
- Complete task: \`${completeTaskCommand}\`
- Fail task: \`${failTaskCommand}\`
- Release claim (rollback): \`${releaseClaimCommand}\`

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
- To leader: \`${formatOmcCliInvocation(`team api send-message --input "{\\"team_name\\":\\"${teamName}\\",\\"from_worker\\":\\"${workerName2}\\",\\"to_worker\\":\\"leader-fixed\\",\\"body\\":\\"<message>\\"}" --json`)}\`
- Check mailbox: \`${mailboxListCommand}\`
- Mark delivered: \`${mailboxDeliveredCommand}\`

## Startup Handshake (Required)
Before doing any task work, send exactly one startup ACK to the leader:
\`${sendAckCommand}\`

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
- Do NOT run team spawning/orchestration commands (for example: \`${teamCommand} ...\`, \`omx team ...\`, \`$team\`, \`$ultrawork\`, \`$autopilot\`, \`$ralph\`).
- Worker-allowed control surface is only: \`${teamApiCommand} ... --json\` (and equivalent \`omx team api ... --json\` where configured).
- If blocked, write {"state": "blocked", "reason": "..."} to your status file

${agentTypeGuidance(agentType)}

## BEFORE YOU EXIT
You MUST call \`${formatOmcCliInvocation("team api transition-task-status")}\` to mark your task as "completed" or "failed" before exiting.
If you skip this step, the leader cannot track your work and the task will appear stuck.

${bootstrapInstructions ? `## Role Context
${bootstrapInstructions}
` : ""}`;
}
async function composeInitialInbox(teamName, workerName2, content, cwd) {
  const inboxPath = (0, import_path9.join)(cwd, `.omc/state/team/${teamName}/workers/${workerName2}/inbox.md`);
  await (0, import_promises2.mkdir)((0, import_path9.dirname)(inboxPath), { recursive: true });
  await (0, import_promises2.writeFile)(inboxPath, content, "utf-8");
}
async function ensureWorkerStateDir(teamName, workerName2, cwd) {
  const workerDir = (0, import_path9.join)(cwd, `.omc/state/team/${teamName}/workers/${workerName2}`);
  await (0, import_promises2.mkdir)(workerDir, { recursive: true });
  const mailboxDir = (0, import_path9.join)(cwd, `.omc/state/team/${teamName}/mailbox`);
  await (0, import_promises2.mkdir)(mailboxDir, { recursive: true });
  const tasksDir = (0, import_path9.join)(cwd, `.omc/state/team/${teamName}/tasks`);
  await (0, import_promises2.mkdir)(tasksDir, { recursive: true });
}
async function writeWorkerOverlay(params) {
  const { teamName, workerName: workerName2, cwd } = params;
  const overlay = generateWorkerOverlay(params);
  const overlayPath = (0, import_path9.join)(cwd, `.omc/state/team/${teamName}/workers/${workerName2}/AGENTS.md`);
  await (0, import_promises2.mkdir)((0, import_path9.dirname)(overlayPath), { recursive: true });
  await (0, import_promises2.writeFile)(overlayPath, overlay, "utf-8");
  return overlayPath;
}

// src/team/git-worktree.ts
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
var import_node_child_process = require("node:child_process");

// src/team/fs-utils.ts
var import_fs7 = require("fs");
var import_path10 = require("path");
function atomicWriteJson(filePath, data, mode = 384) {
  const dir = (0, import_path10.dirname)(filePath);
  if (!(0, import_fs7.existsSync)(dir)) (0, import_fs7.mkdirSync)(dir, { recursive: true, mode: 448 });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  (0, import_fs7.writeFileSync)(tmpPath, JSON.stringify(data, null, 2) + "\n", { encoding: "utf-8", mode });
  (0, import_fs7.renameSync)(tmpPath, filePath);
}
function ensureDirWithMode(dirPath, mode = 448) {
  if (!(0, import_fs7.existsSync)(dirPath)) (0, import_fs7.mkdirSync)(dirPath, { recursive: true, mode });
}
function safeRealpath(p) {
  try {
    return (0, import_fs7.realpathSync)(p);
  } catch {
    const segments = [];
    let current = (0, import_path10.resolve)(p);
    while (!(0, import_fs7.existsSync)(current)) {
      segments.unshift((0, import_path10.basename)(current));
      const parent = (0, import_path10.dirname)(current);
      if (parent === current) break;
      current = parent;
    }
    try {
      return (0, import_path10.join)((0, import_fs7.realpathSync)(current), ...segments);
    } catch {
      return (0, import_path10.resolve)(p);
    }
  }
}
function validateResolvedPath(resolvedPath, expectedBase) {
  const absResolved = safeRealpath(resolvedPath);
  const absBase = safeRealpath(expectedBase);
  const rel = (0, import_path10.relative)(absBase, absResolved);
  if (rel.startsWith("..") || (0, import_path10.resolve)(absBase, rel) !== absResolved) {
    throw new Error(`Path traversal detected: "${resolvedPath}" escapes base "${expectedBase}"`);
  }
}

// src/team/git-worktree.ts
init_tmux_session();
init_file_lock();
function getWorktreePath(repoRoot, teamName, workerName2) {
  return (0, import_node_path.join)(repoRoot, ".omc", "worktrees", sanitizeName(teamName), sanitizeName(workerName2));
}
function getBranchName(teamName, workerName2) {
  return `omc-team/${sanitizeName(teamName)}/${sanitizeName(workerName2)}`;
}
function getMetadataPath(repoRoot, teamName) {
  return (0, import_node_path.join)(repoRoot, ".omc", "state", "team-bridge", sanitizeName(teamName), "worktrees.json");
}
function readMetadata(repoRoot, teamName) {
  const metaPath = getMetadataPath(repoRoot, teamName);
  if (!(0, import_node_fs.existsSync)(metaPath)) return [];
  try {
    return JSON.parse((0, import_node_fs.readFileSync)(metaPath, "utf-8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[omc] warning: worktrees.json parse error: ${msg}
`);
    return [];
  }
}
function writeMetadata(repoRoot, teamName, entries) {
  const metaPath = getMetadataPath(repoRoot, teamName);
  validateResolvedPath(metaPath, repoRoot);
  const dir = (0, import_node_path.join)(repoRoot, ".omc", "state", "team-bridge", sanitizeName(teamName));
  ensureDirWithMode(dir);
  atomicWriteJson(metaPath, entries);
}
function removeWorkerWorktree(teamName, workerName2, repoRoot) {
  const wtPath = getWorktreePath(repoRoot, teamName, workerName2);
  const branch = getBranchName(teamName, workerName2);
  try {
    (0, import_node_child_process.execFileSync)("git", ["worktree", "remove", "--force", wtPath], { cwd: repoRoot, stdio: "pipe" });
  } catch {
  }
  try {
    (0, import_node_child_process.execFileSync)("git", ["worktree", "prune"], { cwd: repoRoot, stdio: "pipe" });
  } catch {
  }
  try {
    (0, import_node_child_process.execFileSync)("git", ["branch", "-D", branch], { cwd: repoRoot, stdio: "pipe" });
  } catch {
  }
  const metaLockPath = getMetadataPath(repoRoot, teamName) + ".lock";
  withFileLockSync(metaLockPath, () => {
    const existing = readMetadata(repoRoot, teamName);
    const updated = existing.filter((e) => e.workerName !== workerName2);
    writeMetadata(repoRoot, teamName, updated);
  });
}
function cleanupTeamWorktrees(teamName, repoRoot) {
  const entries = readMetadata(repoRoot, teamName);
  for (const entry of entries) {
    try {
      removeWorkerWorktree(teamName, entry.workerName, repoRoot);
    } catch {
    }
  }
}

// src/team/task-file-ops.ts
var import_fs10 = require("fs");
var import_path12 = require("path");
init_tmux_session();
init_platform();

// src/team/state-paths.ts
var import_path11 = require("path");
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
  return (0, import_path11.isAbsolute)(relativePath) ? relativePath : (0, import_path11.join)(cwd, relativePath);
}
function teamStateRoot(cwd, teamName) {
  return (0, import_path11.join)(cwd, TeamPaths.root(teamName));
}
function getTaskStoragePath(cwd, teamName, taskId) {
  if (taskId !== void 0) {
    return (0, import_path11.join)(cwd, TeamPaths.taskFile(teamName, taskId));
  }
  return (0, import_path11.join)(cwd, TeamPaths.tasks(teamName));
}

// src/team/task-file-ops.ts
var DEFAULT_STALE_LOCK_MS2 = 3e4;
function acquireTaskLock(teamName, taskId, opts) {
  const staleLockMs = opts?.staleLockMs ?? DEFAULT_STALE_LOCK_MS2;
  const dir = canonicalTasksDir(teamName, opts?.cwd);
  ensureDirWithMode(dir);
  const lockPath = (0, import_path12.join)(dir, `${sanitizeTaskId(taskId)}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = (0, import_fs10.openSync)(lockPath, import_fs10.constants.O_CREAT | import_fs10.constants.O_EXCL | import_fs10.constants.O_WRONLY, 384);
      const payload = JSON.stringify({
        pid: process.pid,
        workerName: opts?.workerName ?? "",
        timestamp: Date.now()
      });
      (0, import_fs10.writeSync)(fd, payload, null, "utf-8");
      return { fd, path: lockPath };
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && err.code === "EEXIST") {
        if (attempt === 0 && isLockStale2(lockPath, staleLockMs)) {
          try {
            (0, import_fs10.unlinkSync)(lockPath);
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
    (0, import_fs10.closeSync)(handle.fd);
  } catch {
  }
  try {
    (0, import_fs10.unlinkSync)(handle.path);
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
function isLockStale2(lockPath, staleLockMs) {
  try {
    const stat2 = (0, import_fs10.statSync)(lockPath);
    const ageMs = Date.now() - stat2.mtimeMs;
    if (ageMs < staleLockMs) return false;
    try {
      const raw = (0, import_fs10.readFileSync)(lockPath, "utf-8");
      const payload = JSON.parse(raw);
      if (payload.pid && isProcessAlive(payload.pid)) return false;
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
  validateResolvedPath(dir, (0, import_path12.join)(root, ".omc", "state", "team"));
  return dir;
}
function failureSidecarPath(teamName, taskId, cwd) {
  return (0, import_path12.join)(canonicalTasksDir(teamName, cwd), `${sanitizeTaskId(taskId)}.failure.json`);
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
  if (!(0, import_fs10.existsSync)(filePath)) return null;
  try {
    const raw = (0, import_fs10.readFileSync)(filePath, "utf-8");
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
  return (0, import_path13.join)(cwd, `.omc/state/team/${teamName}`);
}
async function writeJson(filePath, data) {
  await (0, import_promises3.mkdir)((0, import_path13.join)(filePath, ".."), { recursive: true });
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
  return (0, import_path13.join)(root, "tasks", `${taskId}.json`);
}
async function writePanesTrackingFileIfPresent(runtime) {
  const jobId = process.env.OMC_JOB_ID;
  const omcJobsDir = process.env.OMC_JOBS_DIR;
  if (!jobId || !omcJobsDir) return;
  const panesPath = (0, import_path13.join)(omcJobsDir, `${jobId}-panes.json`);
  const tempPath = `${panesPath}.tmp`;
  await (0, import_promises3.writeFile)(
    tempPath,
    JSON.stringify({
      paneIds: [...runtime.workerPaneIds],
      leaderPaneId: runtime.leaderPaneId,
      sessionName: runtime.sessionName,
      ownsWindow: Boolean(runtime.ownsWindow)
    }),
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
  await (0, import_promises3.mkdir)((0, import_path13.join)(root, "tasks"), { recursive: true });
  await (0, import_promises3.mkdir)((0, import_path13.join)(root, "mailbox"), { recursive: true });
  await writeJson((0, import_path13.join)(root, "config.json"), config);
  for (let i = 0; i < tasks.length; i++) {
    const taskId = String(i + 1);
    await writeJson((0, import_path13.join)(root, "tasks", `${taskId}.json`), {
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
  const session = await createTeamSession(teamName, 0, cwd, {
    newWindow: Boolean(config.newWindow)
  });
  const runtime = {
    teamName,
    sessionName: session.sessionName,
    leaderPaneId: session.leaderPaneId,
    config: {
      ...config,
      tmuxSession: session.sessionName,
      leaderPaneId: session.leaderPaneId,
      tmuxOwnsWindow: session.sessionMode !== "split-pane"
    },
    workerNames,
    workerPaneIds: session.workerPaneIds,
    // initially empty []
    activeWorkers: /* @__PURE__ */ new Map(),
    cwd,
    resolvedBinaryPaths,
    ownsWindow: session.sessionMode !== "split-pane"
  };
  await writeJson((0, import_path13.join)(root, "config.json"), runtime.config);
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
    const taskFiles = await readdir2((0, import_path13.join)(root, "tasks"));
    for (const f of taskFiles.filter((f2) => f2.endsWith(".json"))) {
      const task = await readJsonSafe((0, import_path13.join)(root, "tasks", f));
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
    const heartbeatPath = (0, import_path13.join)(root, "workers", wName, "heartbeat.json");
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
          const donePath = (0, import_path13.join)(root, "workers", wName, "done.json");
          return readJsonSafe(donePath);
        })),
        Promise.all(workers.map(([, active]) => isWorkerAlive(active.paneId)))
      ]);
      for (let i = 0; i < workers.length; i++) {
        const [wName, active] = workers[i];
        const donePath = (0, import_path13.join)(root, "workers", wName, "done.json");
        const signal = doneSignals[i];
        if (signal) {
          unresponsiveCounts.delete(wName);
          await markTaskFromDone(root, runtime.teamName, runtime.cwd, signal.taskId || active.taskId, signal.status, signal.summary);
          try {
            const { unlink: unlink3 } = await import("fs/promises");
            await unlink3(donePath);
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
        const heartbeatPath = (0, import_path13.join)(root, "workers", wName, "heartbeat.json");
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
          await writeJson((0, import_path13.join)(root, "watchdog-failed.json"), {
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
  const { execFile: execFile4 } = await import("child_process");
  const { promisify: promisify3 } = await import("util");
  const execFileAsync2 = promisify3(execFile4);
  const splitTarget = runtime.workerPaneIds.length === 0 ? runtime.leaderPaneId : runtime.workerPaneIds[runtime.workerPaneIds.length - 1];
  const splitType = runtime.workerPaneIds.length === 0 ? "-h" : "-v";
  const splitResult = await execFileAsync2("tmux", [
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
  if (!paneId) {
    try {
      await resetTaskToPending(root, taskId, runtime.teamName, runtime.cwd);
    } catch {
    }
    return "";
  }
  const workerIndex = parseWorkerIndex(workerNameValue);
  const agentType = runtime.config.agentTypes[workerIndex % runtime.config.agentTypes.length] ?? runtime.config.agentTypes[0] ?? "claude";
  const usePromptMode = isPromptModeAgent(agentType);
  const instruction = buildInitialTaskInstruction(runtime.teamName, workerNameValue, task, taskId);
  await composeInitialInbox(runtime.teamName, workerNameValue, instruction, runtime.cwd);
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
    return resolveClaudeWorkerModel();
  })();
  const [launchBinary, ...launchArgs] = buildWorkerArgv(agentType, {
    teamName: runtime.teamName,
    workerName: workerNameValue,
    cwd: runtime.cwd,
    resolvedBinaryPath,
    model: modelForAgent
  });
  if (usePromptMode) {
    const promptArgs = getPromptModeArgs(agentType, generateTriggerMessage(runtime.teamName, workerNameValue));
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
  await applyMainVerticalLayout(runtime.sessionName);
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
      generateTriggerMessage(runtime.teamName, workerNameValue)
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
    const { execFile: execFile4 } = await import("child_process");
    const { promisify: promisify3 } = await import("util");
    const execFileAsync2 = promisify3(execFile4);
    await execFileAsync2("tmux", ["kill-pane", "-t", paneId]);
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
async function shutdownTeam(teamName, sessionName2, cwd, timeoutMs = 3e4, workerPaneIds, leaderPaneId, ownsWindow) {
  const root = stateRoot(cwd, teamName);
  await writeJson((0, import_path13.join)(root, "shutdown.json"), {
    requestedAt: (/* @__PURE__ */ new Date()).toISOString(),
    teamName
  });
  const configData = await readJsonSafe((0, import_path13.join)(root, "config.json"));
  const CLI_AGENT_TYPES = /* @__PURE__ */ new Set(["claude", "codex", "gemini"]);
  const agentTypes = configData?.agentTypes ?? [];
  const isCliWorkerTeam = agentTypes.length > 0 && agentTypes.every((t) => CLI_AGENT_TYPES.has(t));
  if (!isCliWorkerTeam) {
    const deadline = Date.now() + timeoutMs;
    const workerCount = configData?.workerCount ?? 0;
    const expectedAcks = Array.from({ length: workerCount }, (_, i) => `worker-${i + 1}`);
    while (Date.now() < deadline && expectedAcks.length > 0) {
      for (const wName of [...expectedAcks]) {
        const ackPath = (0, import_path13.join)(root, "workers", wName, "shutdown-ack.json");
        if ((0, import_fs11.existsSync)(ackPath)) {
          expectedAcks.splice(expectedAcks.indexOf(wName), 1);
        }
      }
      if (expectedAcks.length > 0) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
  const sessionMode = ownsWindow ?? Boolean(configData?.tmuxOwnsWindow) ? sessionName2.includes(":") ? "dedicated-window" : "detached-session" : "split-pane";
  const effectiveWorkerPaneIds = sessionMode === "split-pane" ? await resolveSplitPaneWorkerPaneIds(sessionName2, workerPaneIds, leaderPaneId) : workerPaneIds;
  await killTeamSession(sessionName2, effectiveWorkerPaneIds, leaderPaneId, { sessionMode });
  try {
    cleanupTeamWorktrees(teamName, cwd);
  } catch {
  }
  try {
    await (0, import_promises3.rm)(root, { recursive: true, force: true });
  } catch {
  }
}

// src/team/events.ts
var import_crypto = require("crypto");
var import_path14 = require("path");
var import_promises4 = require("fs/promises");
var import_fs12 = require("fs");

// src/lib/swallowed-error.ts
function formatSwallowedError(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
function logSwallowedError(context, error) {
  try {
    console.warn(`[omc] ${context}: ${formatSwallowedError(error)}`);
  } catch {
  }
}
function createSwallowedErrorLogger(context) {
  return (error) => {
    logSwallowedError(context, error);
  };
}

// src/team/events.ts
async function appendTeamEvent(teamName, event, cwd) {
  const full = {
    event_id: (0, import_crypto.randomUUID)(),
    team: teamName,
    created_at: (/* @__PURE__ */ new Date()).toISOString(),
    ...event
  };
  const p = absPath(cwd, TeamPaths.events(teamName));
  await (0, import_promises4.mkdir)((0, import_path14.dirname)(p), { recursive: true });
  await (0, import_promises4.appendFile)(p, `${JSON.stringify(full)}
`, "utf8");
  return full;
}
async function emitMonitorDerivedEvents(teamName, tasks, workers, previousSnapshot, cwd) {
  if (!previousSnapshot) return;
  const logDerivedEventFailure = createSwallowedErrorLogger(
    "team.events.emitMonitorDerivedEvents appendTeamEvent failed"
  );
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
      }, cwd).catch(logDerivedEventFailure);
      completedEventTaskIds[task.id] = true;
    } else if (task.status === "failed") {
      await appendTeamEvent(teamName, {
        type: "task_failed",
        worker: "leader-fixed",
        task_id: task.id,
        reason: `status_transition:${prevStatus}->${task.status}`
      }, cwd).catch(logDerivedEventFailure);
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
      }, cwd).catch(logDerivedEventFailure);
    }
    if (prevState === "working" && worker.status.state === "idle") {
      await appendTeamEvent(teamName, {
        type: "worker_idle",
        worker: worker.name,
        reason: `state_transition:${prevState}->${worker.status.state}`
      }, cwd).catch(logDerivedEventFailure);
    }
  }
}

// src/team/leader-nudge-guidance.ts
function activeTaskCount(input) {
  return input.tasks.pending + input.tasks.blocked + input.tasks.inProgress;
}
function deriveTeamLeaderGuidance(input) {
  const activeTasks = activeTaskCount(input);
  const totalWorkers = Math.max(0, input.workers.total);
  const aliveWorkers = Math.max(0, input.workers.alive);
  const idleWorkers = Math.max(0, input.workers.idle);
  const nonReportingWorkers = Math.max(0, input.workers.nonReporting);
  if (activeTasks === 0) {
    return {
      nextAction: "shutdown",
      reason: `all_tasks_terminal:completed=${input.tasks.completed},failed=${input.tasks.failed},workers=${totalWorkers}`,
      message: "All tasks are in a terminal state. Review any failures, then shut down or clean up the current team."
    };
  }
  if (aliveWorkers === 0) {
    return {
      nextAction: "launch-new-team",
      reason: `no_alive_workers:active=${activeTasks},total_workers=${totalWorkers}`,
      message: "Active tasks remain, but no workers appear alive. Launch a new team or replace the dead workers."
    };
  }
  if (idleWorkers >= aliveWorkers) {
    return {
      nextAction: "reuse-current-team",
      reason: `all_alive_workers_idle:active=${activeTasks},alive=${aliveWorkers},idle=${idleWorkers}`,
      message: "Workers are idle while active tasks remain. Reuse the current team and reassign, unblock, or restart the pending work."
    };
  }
  if (nonReportingWorkers >= aliveWorkers) {
    return {
      nextAction: "launch-new-team",
      reason: `all_alive_workers_non_reporting:active=${activeTasks},alive=${aliveWorkers},non_reporting=${nonReportingWorkers}`,
      message: "Workers are still marked alive, but none are reporting progress. Launch a replacement team or restart the stuck workers."
    };
  }
  return {
    nextAction: "keep-checking-status",
    reason: `workers_still_active:active=${activeTasks},alive=${aliveWorkers},idle=${idleWorkers},non_reporting=${nonReportingWorkers}`,
    message: "Workers still appear active. Keep checking team status before intervening."
  };
}

// src/hooks/factcheck/checks.ts
var import_fs13 = require("fs");
var import_path15 = require("path");

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
    if (!(0, import_fs13.existsSync)(pathStr)) {
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
  const claimsCwdCanonical = (0, import_path15.resolve)(claimsCwd);
  const runtimeCwdCanonical = (0, import_path15.resolve)(runtimeCwd);
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
var import_os3 = require("os");
var DEFAULT_FACTCHECK_POLICY = {
  enabled: false,
  mode: "quick",
  strict_project_patterns: [],
  forbidden_path_prefixes: ["${CLAUDE_CONFIG_DIR}/plugins/cache/omc/"],
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
  const home = (0, import_os3.homedir)();
  const ws = workspace ?? process.env.OMC_WORKSPACE ?? process.cwd();
  return value.replace(/\$\{HOME\}/g, home).replace(/\$\{WORKSPACE\}/g, ws).replace(/\$\{CLAUDE_CONFIG_DIR\}/g, getClaudeConfigDir());
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
var import_fs14 = require("fs");
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
  if (!(0, import_fs14.existsSync)(logPath)) {
    return stats;
  }
  let content;
  try {
    content = (0, import_fs14.readFileSync)(logPath, "utf-8");
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
var import_child_process5 = require("child_process");
var import_path18 = require("path");
var import_fs17 = require("fs");
var import_promises7 = require("fs/promises");
var import_perf_hooks = require("perf_hooks");

// src/team/allocation-policy.ts
function allocateTasksToWorkers(tasks, workers) {
  if (tasks.length === 0 || workers.length === 0) return [];
  const uniformRolePool = isUniformRolePool(workers);
  const results = [];
  const loadMap = new Map(workers.map((w) => [w.name, w.currentLoad]));
  if (uniformRolePool) {
    for (const task of tasks) {
      const target = pickLeastLoaded(workers, loadMap);
      results.push({
        taskId: task.id,
        workerName: target.name,
        reason: `uniform pool round-robin (role=${target.role}, load=${loadMap.get(target.name)})`
      });
      loadMap.set(target.name, (loadMap.get(target.name) ?? 0) + 1);
    }
  } else {
    for (const task of tasks) {
      const target = pickBestWorker(task, workers, loadMap);
      results.push({
        taskId: task.id,
        workerName: target.name,
        reason: `role match (task.role=${task.role ?? "any"}, worker.role=${target.role}, load=${loadMap.get(target.name)})`
      });
      loadMap.set(target.name, (loadMap.get(target.name) ?? 0) + 1);
    }
  }
  return results;
}
function isUniformRolePool(workers) {
  if (workers.length === 0) return true;
  const firstRole = workers[0].role;
  return workers.every((w) => w.role === firstRole);
}
function pickLeastLoaded(workers, loadMap) {
  let best = workers[0];
  let bestLoad = loadMap.get(best.name) ?? 0;
  for (const w of workers) {
    const load = loadMap.get(w.name) ?? 0;
    if (load < bestLoad) {
      best = w;
      bestLoad = load;
    }
  }
  return best;
}
function pickBestWorker(task, workers, loadMap) {
  const scored = workers.map((w) => {
    const load = loadMap.get(w.name) ?? 0;
    const roleScore = task.role ? w.role === task.role ? 1 : 0 : 0.5;
    const score = roleScore - load * 0.2;
    return { worker: w, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].worker;
}

// src/team/monitor.ts
var import_fs15 = require("fs");
var import_promises5 = require("fs/promises");
var import_path16 = require("path");

// src/team/governance.ts
var DEFAULT_TEAM_TRANSPORT_POLICY = {
  display_mode: "split_pane",
  worker_launch_mode: "interactive",
  dispatch_mode: "hook_preferred_with_fallback",
  dispatch_ack_timeout_ms: 15e3
};
var DEFAULT_TEAM_GOVERNANCE = {
  delegation_only: false,
  plan_approval_required: false,
  nested_teams_allowed: false,
  one_team_per_leader_session: true,
  cleanup_requires_all_workers_inactive: true
};
function normalizeTeamTransportPolicy(policy) {
  return {
    display_mode: policy?.display_mode ?? DEFAULT_TEAM_TRANSPORT_POLICY.display_mode,
    worker_launch_mode: policy?.worker_launch_mode ?? DEFAULT_TEAM_TRANSPORT_POLICY.worker_launch_mode,
    dispatch_mode: policy?.dispatch_mode ?? DEFAULT_TEAM_TRANSPORT_POLICY.dispatch_mode,
    dispatch_ack_timeout_ms: typeof policy?.dispatch_ack_timeout_ms === "number" ? policy.dispatch_ack_timeout_ms : DEFAULT_TEAM_TRANSPORT_POLICY.dispatch_ack_timeout_ms
  };
}
function normalizeTeamGovernance(governance, legacyPolicy) {
  return {
    delegation_only: governance?.delegation_only ?? legacyPolicy?.delegation_only ?? DEFAULT_TEAM_GOVERNANCE.delegation_only,
    plan_approval_required: governance?.plan_approval_required ?? legacyPolicy?.plan_approval_required ?? DEFAULT_TEAM_GOVERNANCE.plan_approval_required,
    nested_teams_allowed: governance?.nested_teams_allowed ?? legacyPolicy?.nested_teams_allowed ?? DEFAULT_TEAM_GOVERNANCE.nested_teams_allowed,
    one_team_per_leader_session: governance?.one_team_per_leader_session ?? legacyPolicy?.one_team_per_leader_session ?? DEFAULT_TEAM_GOVERNANCE.one_team_per_leader_session,
    cleanup_requires_all_workers_inactive: governance?.cleanup_requires_all_workers_inactive ?? legacyPolicy?.cleanup_requires_all_workers_inactive ?? DEFAULT_TEAM_GOVERNANCE.cleanup_requires_all_workers_inactive
  };
}
function normalizeTeamManifest(manifest) {
  return {
    ...manifest,
    policy: normalizeTeamTransportPolicy(manifest.policy),
    governance: normalizeTeamGovernance(manifest.governance, manifest.policy)
  };
}
function getConfigGovernance(config) {
  return normalizeTeamGovernance(config?.governance, config?.policy);
}

// src/team/worker-canonicalization.ts
function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function hasAssignedTasks(worker) {
  return Array.isArray(worker.assigned_tasks) && worker.assigned_tasks.length > 0;
}
function workerPriority(worker) {
  if (hasText(worker.pane_id)) return 4;
  if (typeof worker.pid === "number" && Number.isFinite(worker.pid)) return 3;
  if (hasAssignedTasks(worker)) return 2;
  if (typeof worker.index === "number" && worker.index > 0) return 1;
  return 0;
}
function mergeAssignedTasks(primary, secondary) {
  const merged = [];
  for (const taskId of [...primary ?? [], ...secondary ?? []]) {
    if (typeof taskId !== "string" || taskId.trim() === "" || merged.includes(taskId)) continue;
    merged.push(taskId);
  }
  return merged;
}
function backfillText(primary, secondary) {
  return hasText(primary) ? primary : secondary;
}
function backfillBoolean(primary, secondary) {
  return typeof primary === "boolean" ? primary : secondary;
}
function backfillNumber(primary, secondary, predicate) {
  const isUsable = (value) => typeof value === "number" && Number.isFinite(value) && (predicate ? predicate(value) : true);
  return isUsable(primary) ? primary : isUsable(secondary) ? secondary : void 0;
}
function chooseWinningWorker(existing, incoming) {
  const existingPriority = workerPriority(existing);
  const incomingPriority = workerPriority(incoming);
  if (incomingPriority > existingPriority) return { winner: incoming, loser: existing };
  if (incomingPriority < existingPriority) return { winner: existing, loser: incoming };
  if ((incoming.index ?? 0) >= (existing.index ?? 0)) return { winner: incoming, loser: existing };
  return { winner: existing, loser: incoming };
}
function canonicalizeWorkers(workers) {
  const byName = /* @__PURE__ */ new Map();
  const duplicateNames = /* @__PURE__ */ new Set();
  for (const worker of workers) {
    const name = typeof worker.name === "string" ? worker.name.trim() : "";
    if (!name) continue;
    const normalized = {
      ...worker,
      name,
      assigned_tasks: Array.isArray(worker.assigned_tasks) ? worker.assigned_tasks : []
    };
    const existing = byName.get(name);
    if (!existing) {
      byName.set(name, normalized);
      continue;
    }
    duplicateNames.add(name);
    const { winner, loser } = chooseWinningWorker(existing, normalized);
    byName.set(name, {
      ...winner,
      name,
      assigned_tasks: mergeAssignedTasks(winner.assigned_tasks, loser.assigned_tasks),
      pane_id: backfillText(winner.pane_id, loser.pane_id),
      pid: backfillNumber(winner.pid, loser.pid),
      index: backfillNumber(winner.index, loser.index, (value) => value > 0) ?? 0,
      role: backfillText(winner.role, loser.role) ?? winner.role,
      worker_cli: backfillText(winner.worker_cli, loser.worker_cli),
      working_dir: backfillText(winner.working_dir, loser.working_dir),
      worktree_path: backfillText(winner.worktree_path, loser.worktree_path),
      worktree_branch: backfillText(winner.worktree_branch, loser.worktree_branch),
      worktree_detached: backfillBoolean(winner.worktree_detached, loser.worktree_detached),
      team_state_root: backfillText(winner.team_state_root, loser.team_state_root)
    });
  }
  return {
    workers: Array.from(byName.values()),
    duplicateNames: Array.from(duplicateNames.values())
  };
}
function canonicalizeTeamConfigWorkers(config) {
  const { workers, duplicateNames } = canonicalizeWorkers(config.workers ?? []);
  if (duplicateNames.length > 0) {
    console.warn(
      `[team] canonicalized duplicate worker entries: ${duplicateNames.join(", ")}`
    );
  }
  return {
    ...config,
    workers,
    worker_count: workers.length
  };
}

// src/team/monitor.ts
async function readJsonSafe2(filePath) {
  try {
    if (!(0, import_fs15.existsSync)(filePath)) return null;
    const raw = await (0, import_promises5.readFile)(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
async function writeAtomic(filePath, data) {
  const { writeFile: writeFile6 } = await import("fs/promises");
  await (0, import_promises5.mkdir)((0, import_path16.dirname)(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await writeFile6(tmpPath, data, "utf-8");
  const { rename: rename4 } = await import("fs/promises");
  await rename4(tmpPath, filePath);
}
function configFromManifest(manifest) {
  return {
    name: manifest.name,
    task: manifest.task,
    agent_type: "claude",
    policy: manifest.policy,
    governance: manifest.governance,
    worker_launch_mode: manifest.policy.worker_launch_mode,
    worker_count: manifest.worker_count,
    max_workers: 20,
    workers: manifest.workers,
    created_at: manifest.created_at,
    tmux_session: manifest.tmux_session,
    next_task_id: manifest.next_task_id,
    leader_cwd: manifest.leader_cwd,
    team_state_root: manifest.team_state_root,
    workspace_mode: manifest.workspace_mode,
    leader_pane_id: manifest.leader_pane_id,
    hud_pane_id: manifest.hud_pane_id,
    resize_hook_name: manifest.resize_hook_name,
    resize_hook_target: manifest.resize_hook_target,
    next_worker_index: manifest.next_worker_index
  };
}
async function readTeamConfig(teamName, cwd) {
  const [config, manifest] = await Promise.all([
    readJsonSafe2(absPath(cwd, TeamPaths.config(teamName))),
    readTeamManifest(teamName, cwd)
  ]);
  if (!config && !manifest) return null;
  if (!manifest) return config ? canonicalizeTeamConfigWorkers(config) : null;
  if (!config) return canonicalizeTeamConfigWorkers(configFromManifest(manifest));
  return canonicalizeTeamConfigWorkers({
    ...configFromManifest(manifest),
    ...config,
    workers: [...config.workers ?? [], ...manifest.workers ?? []],
    worker_count: Math.max(config.worker_count ?? 0, manifest.worker_count ?? 0),
    next_task_id: Math.max(config.next_task_id ?? 1, manifest.next_task_id ?? 1),
    max_workers: Math.max(config.max_workers ?? 0, 20)
  });
}
async function readTeamManifest(teamName, cwd) {
  const manifest = await readJsonSafe2(absPath(cwd, TeamPaths.manifest(teamName)));
  return manifest ? normalizeTeamManifest(manifest) : null;
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
  if (!(0, import_fs15.existsSync)(p)) return null;
  try {
    const raw = await (0, import_promises5.readFile)(p, "utf-8");
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
  if (!(0, import_fs15.existsSync)(tasksDir)) return [];
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
  const manifestPath = absPath(cwd, TeamPaths.manifest(config.name));
  const existingManifest = await readJsonSafe2(manifestPath);
  if (existingManifest) {
    const nextManifest = normalizeTeamManifest({
      ...existingManifest,
      workers: config.workers,
      worker_count: config.worker_count,
      tmux_session: config.tmux_session,
      next_task_id: config.next_task_id,
      created_at: config.created_at,
      leader_cwd: config.leader_cwd,
      team_state_root: config.team_state_root,
      workspace_mode: config.workspace_mode,
      leader_pane_id: config.leader_pane_id,
      hud_pane_id: config.hud_pane_id,
      resize_hook_name: config.resize_hook_name,
      resize_hook_target: config.resize_hook_target,
      next_worker_index: config.next_worker_index,
      policy: config.policy ?? existingManifest.policy,
      governance: config.governance ?? existingManifest.governance
    });
    await writeAtomic(manifestPath, JSON.stringify(nextManifest, null, 2));
  }
}
async function cleanupTeamState(teamName, cwd) {
  const root = absPath(cwd, TeamPaths.root(teamName));
  const { rm: rm3 } = await import("fs/promises");
  try {
    await rm3(root, { recursive: true, force: true });
  } catch {
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
  if (pending.length > 0 && genuinelyCompleted.length > 0 && inProgress.length === 0 && allFailed.length === 0) {
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

// src/team/dispatch-queue.ts
var import_crypto2 = require("crypto");
var import_fs16 = require("fs");
var import_promises6 = require("fs/promises");
var import_path17 = require("path");

// src/team/contracts.ts
var WORKER_NAME_SAFE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

// src/team/dispatch-queue.ts
var OMC_DISPATCH_LOCK_TIMEOUT_ENV = "OMC_TEAM_DISPATCH_LOCK_TIMEOUT_MS";
var DEFAULT_DISPATCH_LOCK_TIMEOUT_MS = 15e3;
var MIN_DISPATCH_LOCK_TIMEOUT_MS = 1e3;
var MAX_DISPATCH_LOCK_TIMEOUT_MS = 12e4;
var DISPATCH_LOCK_INITIAL_POLL_MS = 25;
var DISPATCH_LOCK_MAX_POLL_MS = 500;
var LOCK_STALE_MS = 5 * 60 * 1e3;
function validateWorkerName(name) {
  if (!WORKER_NAME_SAFE_PATTERN.test(name)) {
    throw new Error(`Invalid worker name: "${name}"`);
  }
}
function isDispatchKind(value) {
  return value === "inbox" || value === "mailbox" || value === "nudge";
}
function isDispatchStatus(value) {
  return value === "pending" || value === "notified" || value === "delivered" || value === "failed";
}
function resolveDispatchLockTimeoutMs(env = process.env) {
  const raw = env[OMC_DISPATCH_LOCK_TIMEOUT_ENV];
  if (raw === void 0 || raw === "") return DEFAULT_DISPATCH_LOCK_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_DISPATCH_LOCK_TIMEOUT_MS;
  return Math.max(MIN_DISPATCH_LOCK_TIMEOUT_MS, Math.min(MAX_DISPATCH_LOCK_TIMEOUT_MS, Math.floor(parsed)));
}
async function withDispatchLock(teamName, cwd, fn) {
  const root = absPath(cwd, TeamPaths.root(teamName));
  if (!(0, import_fs16.existsSync)(root)) throw new Error(`Team ${teamName} not found`);
  const lockDir = absPath(cwd, TeamPaths.dispatchLockDir(teamName));
  const ownerPath = (0, import_path17.join)(lockDir, "owner");
  const ownerToken = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const timeoutMs = resolveDispatchLockTimeoutMs(process.env);
  const deadline = Date.now() + timeoutMs;
  let pollMs = DISPATCH_LOCK_INITIAL_POLL_MS;
  await (0, import_promises6.mkdir)((0, import_path17.dirname)(lockDir), { recursive: true });
  while (true) {
    try {
      await (0, import_promises6.mkdir)(lockDir, { recursive: false });
      try {
        await (0, import_promises6.writeFile)(ownerPath, ownerToken, "utf8");
      } catch (error) {
        await (0, import_promises6.rm)(lockDir, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      const err = error;
      if (err.code !== "EEXIST") throw error;
      try {
        const info = await (0, import_promises6.stat)(lockDir);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await (0, import_promises6.rm)(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out acquiring dispatch lock for ${teamName} after ${timeoutMs}ms. Set ${OMC_DISPATCH_LOCK_TIMEOUT_ENV} to increase (current: ${timeoutMs}ms, max: ${MAX_DISPATCH_LOCK_TIMEOUT_MS}ms).`
        );
      }
      const jitter = 0.5 + Math.random() * 0.5;
      await new Promise((resolve5) => setTimeout(resolve5, Math.floor(pollMs * jitter)));
      pollMs = Math.min(pollMs * 2, DISPATCH_LOCK_MAX_POLL_MS);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      const currentOwner = await (0, import_promises6.readFile)(ownerPath, "utf8");
      if (currentOwner.trim() === ownerToken) {
        await (0, import_promises6.rm)(lockDir, { recursive: true, force: true });
      }
    } catch {
    }
  }
}
async function readDispatchRequestsFromFile(teamName, cwd) {
  const path4 = absPath(cwd, TeamPaths.dispatchRequests(teamName));
  try {
    if (!(0, import_fs16.existsSync)(path4)) return [];
    const raw = await (0, import_promises6.readFile)(path4, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => normalizeDispatchRequest(teamName, entry)).filter((req) => req !== null);
  } catch {
    return [];
  }
}
async function writeDispatchRequestsToFile(teamName, requests, cwd) {
  const path4 = absPath(cwd, TeamPaths.dispatchRequests(teamName));
  const dir = (0, import_path17.dirname)(path4);
  ensureDirWithMode(dir);
  atomicWriteJson(path4, requests);
}
function normalizeDispatchRequest(teamName, raw, nowIso = (/* @__PURE__ */ new Date()).toISOString()) {
  if (!isDispatchKind(raw.kind)) return null;
  if (typeof raw.to_worker !== "string" || raw.to_worker.trim() === "") return null;
  if (typeof raw.trigger_message !== "string" || raw.trigger_message.trim() === "") return null;
  const status = isDispatchStatus(raw.status) ? raw.status : "pending";
  return {
    request_id: typeof raw.request_id === "string" && raw.request_id.trim() !== "" ? raw.request_id : (0, import_crypto2.randomUUID)(),
    kind: raw.kind,
    team_name: teamName,
    to_worker: raw.to_worker,
    worker_index: typeof raw.worker_index === "number" ? raw.worker_index : void 0,
    pane_id: typeof raw.pane_id === "string" && raw.pane_id !== "" ? raw.pane_id : void 0,
    trigger_message: raw.trigger_message,
    message_id: typeof raw.message_id === "string" && raw.message_id !== "" ? raw.message_id : void 0,
    inbox_correlation_key: typeof raw.inbox_correlation_key === "string" && raw.inbox_correlation_key !== "" ? raw.inbox_correlation_key : void 0,
    transport_preference: raw.transport_preference === "transport_direct" || raw.transport_preference === "prompt_stdin" ? raw.transport_preference : "hook_preferred_with_fallback",
    fallback_allowed: raw.fallback_allowed !== false,
    status,
    attempt_count: Number.isFinite(raw.attempt_count) ? Math.max(0, Math.floor(raw.attempt_count)) : 0,
    created_at: typeof raw.created_at === "string" && raw.created_at !== "" ? raw.created_at : nowIso,
    updated_at: typeof raw.updated_at === "string" && raw.updated_at !== "" ? raw.updated_at : nowIso,
    notified_at: typeof raw.notified_at === "string" && raw.notified_at !== "" ? raw.notified_at : void 0,
    delivered_at: typeof raw.delivered_at === "string" && raw.delivered_at !== "" ? raw.delivered_at : void 0,
    failed_at: typeof raw.failed_at === "string" && raw.failed_at !== "" ? raw.failed_at : void 0,
    last_reason: typeof raw.last_reason === "string" && raw.last_reason !== "" ? raw.last_reason : void 0
  };
}
function equivalentPendingDispatch(existing, input) {
  if (existing.status !== "pending") return false;
  if (existing.kind !== input.kind) return false;
  if (existing.to_worker !== input.to_worker) return false;
  if (input.kind === "mailbox") {
    return Boolean(input.message_id) && existing.message_id === input.message_id;
  }
  if (input.kind === "inbox" && input.inbox_correlation_key) {
    return existing.inbox_correlation_key === input.inbox_correlation_key;
  }
  return existing.trigger_message === input.trigger_message;
}
function canTransitionDispatchStatus(from, to) {
  if (from === to) return true;
  if (from === "pending" && (to === "notified" || to === "failed")) return true;
  if (from === "notified" && (to === "delivered" || to === "failed")) return true;
  return false;
}
async function enqueueDispatchRequest(teamName, requestInput, cwd) {
  if (!isDispatchKind(requestInput.kind)) throw new Error(`Invalid dispatch request kind: ${String(requestInput.kind)}`);
  if (requestInput.kind === "mailbox" && (!requestInput.message_id || requestInput.message_id.trim() === "")) {
    throw new Error("mailbox dispatch requests require message_id");
  }
  validateWorkerName(requestInput.to_worker);
  return await withDispatchLock(teamName, cwd, async () => {
    const requests = await readDispatchRequestsFromFile(teamName, cwd);
    const existing = requests.find((req) => equivalentPendingDispatch(req, requestInput));
    if (existing) return { request: existing, deduped: true };
    const nowIso = (/* @__PURE__ */ new Date()).toISOString();
    const request = normalizeDispatchRequest(
      teamName,
      {
        request_id: (0, import_crypto2.randomUUID)(),
        ...requestInput,
        status: "pending",
        attempt_count: 0,
        created_at: nowIso,
        updated_at: nowIso
      },
      nowIso
    );
    if (!request) throw new Error("failed_to_normalize_dispatch_request");
    requests.push(request);
    await writeDispatchRequestsToFile(teamName, requests, cwd);
    return { request, deduped: false };
  });
}
async function readDispatchRequest(teamName, requestId, cwd) {
  const requests = await readDispatchRequestsFromFile(teamName, cwd);
  return requests.find((req) => req.request_id === requestId) ?? null;
}
async function transitionDispatchRequest(teamName, requestId, from, to, patch = {}, cwd) {
  return await withDispatchLock(teamName, cwd, async () => {
    const requests = await readDispatchRequestsFromFile(teamName, cwd);
    const index = requests.findIndex((req) => req.request_id === requestId);
    if (index < 0) return null;
    const existing = requests[index];
    if (existing.status !== from && existing.status !== to) return null;
    if (!canTransitionDispatchStatus(existing.status, to)) return null;
    const nowIso = (/* @__PURE__ */ new Date()).toISOString();
    const nextAttemptCount = Math.max(
      existing.attempt_count,
      Number.isFinite(patch.attempt_count) ? Math.floor(patch.attempt_count) : existing.status === to ? existing.attempt_count : existing.attempt_count + 1
    );
    const next = {
      ...existing,
      ...patch,
      status: to,
      attempt_count: Math.max(0, nextAttemptCount),
      updated_at: nowIso
    };
    if (to === "notified") next.notified_at = patch.notified_at ?? nowIso;
    if (to === "delivered") next.delivered_at = patch.delivered_at ?? nowIso;
    if (to === "failed") next.failed_at = patch.failed_at ?? nowIso;
    requests[index] = next;
    await writeDispatchRequestsToFile(teamName, requests, cwd);
    return next;
  });
}
async function markDispatchRequestNotified(teamName, requestId, patch = {}, cwd) {
  const current = await readDispatchRequest(teamName, requestId, cwd);
  if (!current) return null;
  if (current.status === "notified" || current.status === "delivered") return current;
  return await transitionDispatchRequest(teamName, requestId, current.status, "notified", patch, cwd);
}

// src/team/mcp-comm.ts
function isConfirmedNotification(outcome) {
  if (!outcome.ok) return false;
  if (outcome.transport !== "hook") return true;
  return outcome.reason !== "queued_for_hook_dispatch";
}
function fallbackTransportForPreference(preference) {
  if (preference === "prompt_stdin") return "prompt_stdin";
  if (preference === "transport_direct") return "tmux_send_keys";
  return "hook";
}
function notifyExceptionReason(error) {
  const message = error instanceof Error ? error.message : String(error);
  return `notify_exception:${message}`;
}
async function markImmediateDispatchFailure(params) {
  const { teamName, request, reason, messageId, cwd } = params;
  if (request.transport_preference === "hook_preferred_with_fallback") return;
  const logTransitionFailure = createSwallowedErrorLogger(
    "team.mcp-comm.markImmediateDispatchFailure transitionDispatchRequest failed"
  );
  const current = await readDispatchRequest(teamName, request.request_id, cwd);
  if (!current) return;
  if (current.status === "failed" || current.status === "notified" || current.status === "delivered") return;
  await transitionDispatchRequest(
    teamName,
    request.request_id,
    current.status,
    "failed",
    {
      message_id: messageId ?? current.message_id,
      last_reason: reason
    },
    cwd
  ).catch(logTransitionFailure);
}
async function queueInboxInstruction(params) {
  const queued = await enqueueDispatchRequest(
    params.teamName,
    {
      kind: "inbox",
      to_worker: params.workerName,
      worker_index: params.workerIndex,
      pane_id: params.paneId,
      trigger_message: params.triggerMessage,
      transport_preference: params.transportPreference,
      fallback_allowed: params.fallbackAllowed,
      inbox_correlation_key: params.inboxCorrelationKey
    },
    params.cwd
  );
  if (queued.deduped) {
    return {
      ok: false,
      transport: "none",
      reason: "duplicate_pending_dispatch_request",
      request_id: queued.request.request_id
    };
  }
  try {
    await params.deps.writeWorkerInbox(params.teamName, params.workerName, params.inbox, params.cwd);
  } catch (error) {
    await markImmediateDispatchFailure({
      teamName: params.teamName,
      request: queued.request,
      reason: "inbox_write_failed",
      cwd: params.cwd
    });
    throw error;
  }
  const notifyOutcome = await Promise.resolve(params.notify(
    { workerName: params.workerName, workerIndex: params.workerIndex, paneId: params.paneId },
    params.triggerMessage,
    { request: queued.request }
  )).catch((error) => ({
    ok: false,
    transport: fallbackTransportForPreference(params.transportPreference),
    reason: notifyExceptionReason(error)
  }));
  const outcome = { ...notifyOutcome, request_id: queued.request.request_id };
  if (isConfirmedNotification(outcome)) {
    await markDispatchRequestNotified(
      params.teamName,
      queued.request.request_id,
      { last_reason: outcome.reason },
      params.cwd
    );
  } else {
    await markImmediateDispatchFailure({
      teamName: params.teamName,
      request: queued.request,
      reason: outcome.reason,
      cwd: params.cwd
    });
  }
  return outcome;
}

// src/team/runtime-v2.ts
function isRuntimeV2Enabled(env = process.env) {
  const raw = env.OMC_RUNTIME_V2;
  if (!raw) return true;
  const normalized = raw.trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(normalized);
}
var MONITOR_SIGNAL_STALE_MS = 3e4;
function sanitizeTeamName(name) {
  const sanitized = name.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 30);
  if (!sanitized) throw new Error(`Invalid team name: "${name}" produces empty slug after sanitization`);
  return sanitized;
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
async function captureWorkerPane(paneId) {
  if (!paneId) return "";
  return await new Promise((resolve5) => {
    (0, import_child_process5.execFile)("tmux", ["capture-pane", "-t", paneId, "-p", "-S", "-80"], (err, stdout) => {
      if (err) resolve5("");
      else resolve5(stdout ?? "");
    });
  });
}
function isFreshTimestamp(value, maxAgeMs = MONITOR_SIGNAL_STALE_MS) {
  if (!value) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  return Date.now() - parsed <= maxAgeMs;
}
function findOutstandingWorkerTask(worker, taskById, inProgressByOwner) {
  if (typeof worker.assigned_tasks === "object") {
    for (const taskId of worker.assigned_tasks) {
      const task = taskById.get(taskId);
      if (task && (task.status === "pending" || task.status === "in_progress")) {
        return task;
      }
    }
  }
  const owned = inProgressByOwner.get(worker.name) ?? [];
  return owned[0] ?? null;
}
function buildV2TaskInstruction(teamName, workerName2, task, taskId) {
  const claimTaskCommand = formatOmcCliInvocation(
    `team api claim-task --input '${JSON.stringify({ team_name: teamName, task_id: taskId, worker: workerName2 })}' --json`,
    {}
  );
  const completeTaskCommand = formatOmcCliInvocation(
    `team api transition-task-status --input '${JSON.stringify({ team_name: teamName, task_id: taskId, from: "in_progress", to: "completed", claim_token: "<claim_token>" })}' --json`
  );
  const failTaskCommand = formatOmcCliInvocation(
    `team api transition-task-status --input '${JSON.stringify({ team_name: teamName, task_id: taskId, from: "in_progress", to: "failed", claim_token: "<claim_token>" })}' --json`
  );
  return [
    `## REQUIRED: Task Lifecycle Commands`,
    `You MUST run these commands. Do NOT skip any step.`,
    ``,
    `1. Claim your task:`,
    `   ${claimTaskCommand}`,
    `   Save the claim_token from the response.`,
    `2. Do the work described below.`,
    `3. On completion (use claim_token from step 1):`,
    `   ${completeTaskCommand}`,
    `4. On failure (use claim_token from step 1):`,
    `   ${failTaskCommand}`,
    `5. ACK/progress replies are not a stop signal. Keep executing your assigned or next feasible work until the task is actually complete or failed, then transition and exit.`,
    ``,
    `## Task Assignment`,
    `Task ID: ${taskId}`,
    `Worker: ${workerName2}`,
    `Subject: ${task.subject}`,
    ``,
    task.description,
    ``,
    `REMINDER: You MUST run transition-task-status before exiting. Do NOT write done.json or edit task files directly.`
  ].join("\n");
}
async function notifyStartupInbox(sessionName2, paneId, message) {
  const notified = await notifyPaneWithRetry2(sessionName2, paneId, message);
  return notified ? { ok: true, transport: "tmux_send_keys", reason: "worker_pane_notified" } : { ok: false, transport: "tmux_send_keys", reason: "worker_notify_failed" };
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
function hasWorkerStatusProgress(status, taskId) {
  if (status.current_task_id === taskId) return true;
  return ["working", "blocked", "done", "failed"].includes(status.state);
}
async function hasWorkerTaskClaimEvidence(teamName, workerName2, cwd, taskId) {
  try {
    const raw = await (0, import_promises7.readFile)(absPath(cwd, TeamPaths.taskFile(teamName, taskId)), "utf-8");
    const task = JSON.parse(raw);
    return task.owner === workerName2 && ["in_progress", "completed", "failed"].includes(task.status);
  } catch {
    return false;
  }
}
async function hasWorkerStartupEvidence(teamName, workerName2, taskId, cwd) {
  const [hasClaimEvidence, status] = await Promise.all([
    hasWorkerTaskClaimEvidence(teamName, workerName2, cwd, taskId),
    readWorkerStatus(teamName, workerName2, cwd)
  ]);
  return hasClaimEvidence || hasWorkerStatusProgress(status, taskId);
}
async function waitForWorkerStartupEvidence(teamName, workerName2, taskId, cwd, attempts = 3, delayMs = 250) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (await hasWorkerStartupEvidence(teamName, workerName2, taskId, cwd)) {
      return true;
    }
    if (attempt < attempts) {
      await new Promise((resolve5) => setTimeout(resolve5, delayMs));
    }
  }
  return false;
}
async function spawnV2Worker(opts) {
  const { execFile: execFile4 } = await import("child_process");
  const { promisify: promisify3 } = await import("util");
  const execFileAsync2 = promisify3(execFile4);
  const splitTarget = opts.existingWorkerPaneIds.length === 0 ? opts.leaderPaneId : opts.existingWorkerPaneIds[opts.existingWorkerPaneIds.length - 1];
  const splitType = opts.existingWorkerPaneIds.length === 0 ? "-h" : "-v";
  const splitResult = await execFileAsync2("tmux", [
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
  if (!paneId) {
    return { paneId: null, startupAssigned: false, startupFailureReason: "pane_id_missing" };
  }
  const usePromptMode = isPromptModeAgent(opts.agentType);
  const instruction = buildV2TaskInstruction(
    opts.teamName,
    opts.workerName,
    opts.task,
    opts.taskId
  );
  const inboxTriggerMessage = generateTriggerMessage(opts.teamName, opts.workerName);
  if (usePromptMode) {
    await composeInitialInbox(opts.teamName, opts.workerName, instruction, opts.cwd);
  }
  const envVars = {
    ...getWorkerEnv(opts.teamName, opts.workerName, opts.agentType),
    OMC_TEAM_STATE_ROOT: teamStateRoot(opts.cwd, opts.teamName),
    OMC_TEAM_LEADER_CWD: opts.cwd
  };
  const resolvedBinaryPath = opts.resolvedBinaryPaths[opts.agentType] ?? resolveValidatedBinaryPath(opts.agentType);
  const modelForAgent = (() => {
    if (opts.agentType === "codex") {
      return process.env.OMC_EXTERNAL_MODELS_DEFAULT_CODEX_MODEL || process.env.OMC_CODEX_DEFAULT_MODEL || void 0;
    }
    if (opts.agentType === "gemini") {
      return process.env.OMC_EXTERNAL_MODELS_DEFAULT_GEMINI_MODEL || process.env.OMC_GEMINI_DEFAULT_MODEL || void 0;
    }
    return resolveClaudeWorkerModel();
  })();
  const [launchBinary, ...launchArgs] = buildWorkerArgv(opts.agentType, {
    teamName: opts.teamName,
    workerName: opts.workerName,
    cwd: opts.cwd,
    resolvedBinaryPath,
    model: modelForAgent
  });
  if (usePromptMode) {
    launchArgs.push(...getPromptModeArgs(opts.agentType, instruction));
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
  await applyMainVerticalLayout(opts.sessionName);
  if (!usePromptMode) {
    const paneReady = await waitForPaneReady(paneId);
    if (!paneReady) {
      return {
        paneId,
        startupAssigned: false,
        startupFailureReason: "worker_pane_not_ready"
      };
    }
  }
  const dispatchOutcome = await queueInboxInstruction({
    teamName: opts.teamName,
    workerName: opts.workerName,
    workerIndex: opts.workerIndex + 1,
    paneId,
    inbox: instruction,
    triggerMessage: inboxTriggerMessage,
    cwd: opts.cwd,
    transportPreference: usePromptMode ? "prompt_stdin" : "transport_direct",
    fallbackAllowed: false,
    inboxCorrelationKey: `startup:${opts.workerName}:${opts.taskId}`,
    notify: async (_target, triggerMessage) => {
      if (usePromptMode) {
        return { ok: true, transport: "prompt_stdin", reason: "prompt_mode_launch_args" };
      }
      if (opts.agentType === "gemini") {
        const confirmed = await notifyPaneWithRetry2(opts.sessionName, paneId, "1");
        if (!confirmed) {
          return { ok: false, transport: "tmux_send_keys", reason: "worker_notify_failed:trust-confirm" };
        }
        await new Promise((r) => setTimeout(r, 800));
      }
      return notifyStartupInbox(opts.sessionName, paneId, triggerMessage);
    },
    deps: {
      writeWorkerInbox
    }
  });
  if (!dispatchOutcome.ok) {
    return {
      paneId,
      startupAssigned: false,
      startupFailureReason: dispatchOutcome.reason
    };
  }
  if (opts.agentType === "claude") {
    const settled = await waitForWorkerStartupEvidence(
      opts.teamName,
      opts.workerName,
      opts.taskId,
      opts.cwd,
      6
    );
    if (!settled) {
      return {
        paneId,
        startupAssigned: false,
        startupFailureReason: "claude_startup_evidence_missing"
      };
    }
  }
  if (usePromptMode) {
    const settled = await waitForWorkerStartupEvidence(
      opts.teamName,
      opts.workerName,
      opts.taskId,
      opts.cwd
    );
    if (!settled) {
      return {
        paneId,
        startupAssigned: false,
        startupFailureReason: `${opts.agentType}_startup_evidence_missing`
      };
    }
  }
  return {
    paneId,
    startupAssigned: true
  };
}
async function startTeamV2(config) {
  const sanitized = sanitizeTeamName(config.teamName);
  const leaderCwd = (0, import_path18.resolve)(config.cwd);
  validateTeamName(sanitized);
  const agentTypes = config.agentTypes;
  const resolvedBinaryPaths = {};
  for (const agentType of [...new Set(agentTypes)]) {
    resolvedBinaryPaths[agentType] = resolveValidatedBinaryPath(agentType);
  }
  await (0, import_promises7.mkdir)(absPath(leaderCwd, TeamPaths.tasks(sanitized)), { recursive: true });
  await (0, import_promises7.mkdir)(absPath(leaderCwd, TeamPaths.workers(sanitized)), { recursive: true });
  await (0, import_promises7.mkdir)((0, import_path18.join)(leaderCwd, ".omc", "state", "team", sanitized, "mailbox"), { recursive: true });
  for (let i = 0; i < config.tasks.length; i++) {
    const taskId = String(i + 1);
    const taskFilePath = absPath(leaderCwd, TeamPaths.taskFile(sanitized, taskId));
    await (0, import_promises7.mkdir)((0, import_path18.join)(taskFilePath, ".."), { recursive: true });
    await (0, import_promises7.writeFile)(taskFilePath, JSON.stringify({
      id: taskId,
      subject: config.tasks[i].subject,
      description: config.tasks[i].description,
      status: "pending",
      owner: null,
      result: null,
      created_at: (/* @__PURE__ */ new Date()).toISOString()
    }, null, 2), "utf-8");
  }
  const workerNames = Array.from({ length: config.workerCount }, (_, index) => `worker-${index + 1}`);
  const workerNameSet = new Set(workerNames);
  const startupAllocations = [];
  const unownedTaskIndices = [];
  for (let i = 0; i < config.tasks.length; i++) {
    const owner = config.tasks[i]?.owner;
    if (typeof owner === "string" && workerNameSet.has(owner)) {
      startupAllocations.push({ workerName: owner, taskIndex: i });
    } else {
      unownedTaskIndices.push(i);
    }
  }
  if (unownedTaskIndices.length > 0) {
    const allocationTasks = unownedTaskIndices.map((idx) => ({
      id: String(idx),
      subject: config.tasks[idx].subject,
      description: config.tasks[idx].description
    }));
    const allocationWorkers = workerNames.map((name, i) => ({
      name,
      role: config.workerRoles?.[i] ?? (agentTypes[i % agentTypes.length] ?? agentTypes[0] ?? "claude"),
      currentLoad: 0
    }));
    for (const r of allocateTasksToWorkers(allocationTasks, allocationWorkers)) {
      startupAllocations.push({ workerName: r.workerName, taskIndex: Number(r.taskId) });
    }
  }
  for (let i = 0; i < workerNames.length; i++) {
    const wName = workerNames[i];
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
      cwd: leaderCwd,
      ...config.rolePrompt ? { bootstrapInstructions: config.rolePrompt } : {}
    });
  }
  const session = await createTeamSession(sanitized, 0, leaderCwd, {
    newWindow: Boolean(config.newWindow)
  });
  const sessionName2 = session.sessionName;
  const leaderPaneId = session.leaderPaneId;
  const ownsWindow = session.sessionMode !== "split-pane";
  const workerPaneIds = [];
  const workersInfo = workerNames.map((wName, i) => ({
    name: wName,
    index: i + 1,
    role: config.workerRoles?.[i] ?? (agentTypes[i % agentTypes.length] ?? agentTypes[0] ?? "claude"),
    assigned_tasks: [],
    working_dir: leaderCwd
  }));
  const teamConfig = {
    name: sanitized,
    task: config.tasks.map((t) => t.subject).join("; "),
    agent_type: agentTypes[0] || "claude",
    worker_launch_mode: "interactive",
    policy: DEFAULT_TEAM_TRANSPORT_POLICY,
    governance: DEFAULT_TEAM_GOVERNANCE,
    worker_count: config.workerCount,
    max_workers: 20,
    workers: workersInfo,
    created_at: (/* @__PURE__ */ new Date()).toISOString(),
    tmux_session: sessionName2,
    tmux_window_owned: ownsWindow,
    next_task_id: config.tasks.length + 1,
    leader_cwd: leaderCwd,
    team_state_root: teamStateRoot(leaderCwd, sanitized),
    leader_pane_id: leaderPaneId,
    hud_pane_id: null,
    resize_hook_name: null,
    resize_hook_target: null,
    ...ownsWindow ? { workspace_mode: "single" } : {}
  };
  await saveTeamConfig(teamConfig, leaderCwd);
  const permissionsSnapshot = {
    approval_mode: process.env.OMC_APPROVAL_MODE || "default",
    sandbox_mode: process.env.OMC_SANDBOX_MODE || "default",
    network_access: process.env.OMC_NETWORK_ACCESS === "1"
  };
  const teamManifest = {
    schema_version: 2,
    name: sanitized,
    task: teamConfig.task,
    leader: {
      session_id: sessionName2,
      worker_id: "leader-fixed",
      role: "leader"
    },
    policy: DEFAULT_TEAM_TRANSPORT_POLICY,
    governance: DEFAULT_TEAM_GOVERNANCE,
    permissions_snapshot: permissionsSnapshot,
    tmux_session: sessionName2,
    worker_count: teamConfig.worker_count,
    workers: workersInfo,
    next_task_id: teamConfig.next_task_id,
    created_at: teamConfig.created_at,
    leader_cwd: leaderCwd,
    team_state_root: teamConfig.team_state_root,
    workspace_mode: teamConfig.workspace_mode,
    leader_pane_id: leaderPaneId,
    hud_pane_id: null,
    resize_hook_name: null,
    resize_hook_target: null,
    next_worker_index: teamConfig.next_worker_index
  };
  await (0, import_promises7.writeFile)(absPath(leaderCwd, TeamPaths.manifest(sanitized)), JSON.stringify(teamManifest, null, 2), "utf-8");
  const initialStartupAllocations = [];
  const seenStartupWorkers = /* @__PURE__ */ new Set();
  for (const decision of startupAllocations) {
    if (seenStartupWorkers.has(decision.workerName)) continue;
    initialStartupAllocations.push(decision);
    seenStartupWorkers.add(decision.workerName);
    if (initialStartupAllocations.length >= config.workerCount) break;
  }
  for (const decision of initialStartupAllocations) {
    const wName = decision.workerName;
    const workerIndex = Number.parseInt(wName.replace("worker-", ""), 10) - 1;
    const taskId = String(decision.taskIndex + 1);
    const task = config.tasks[decision.taskIndex];
    if (!task || workerIndex < 0) continue;
    const workerLaunch = await spawnV2Worker({
      sessionName: sessionName2,
      leaderPaneId,
      existingWorkerPaneIds: workerPaneIds,
      teamName: sanitized,
      workerName: wName,
      workerIndex,
      agentType: agentTypes[workerIndex % agentTypes.length] ?? agentTypes[0] ?? "claude",
      task,
      taskId,
      cwd: leaderCwd,
      resolvedBinaryPaths
    });
    if (workerLaunch.paneId) {
      workerPaneIds.push(workerLaunch.paneId);
      const workerInfo = workersInfo[workerIndex];
      if (workerInfo) {
        workerInfo.pane_id = workerLaunch.paneId;
        workerInfo.assigned_tasks = workerLaunch.startupAssigned ? [taskId] : [];
      }
    }
    if (workerLaunch.startupFailureReason) {
      const logEventFailure2 = createSwallowedErrorLogger(
        "team.runtime-v2.startTeamV2 appendTeamEvent failed"
      );
      appendTeamEvent(sanitized, {
        type: "team_leader_nudge",
        worker: "leader-fixed",
        reason: `startup_manual_intervention_required:${wName}:${workerLaunch.startupFailureReason}`
      }, leaderCwd).catch(logEventFailure2);
    }
  }
  teamConfig.workers = workersInfo;
  await saveTeamConfig(teamConfig, leaderCwd);
  const logEventFailure = createSwallowedErrorLogger(
    "team.runtime-v2.startTeamV2 appendTeamEvent failed"
  );
  appendTeamEvent(sanitized, {
    type: "team_leader_nudge",
    worker: "leader-fixed",
    reason: `start_team_v2: workers=${config.workerCount} tasks=${config.tasks.length} panes=${workerPaneIds.length}`
  }, leaderCwd).catch(logEventFailure);
  return {
    teamName: sanitized,
    sanitizedName: sanitized,
    sessionName: sessionName2,
    config: teamConfig,
    cwd: leaderCwd,
    ownsWindow
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
      const [status, heartbeat, paneCapture] = await Promise.all([
        readWorkerStatus(sanitized, worker.name, cwd),
        readWorkerHeartbeat(sanitized, worker.name, cwd),
        alive ? captureWorkerPane(worker.pane_id) : Promise.resolve("")
      ]);
      return { worker, alive, status, heartbeat, paneCapture };
    })
  );
  const workerScanMs = import_perf_hooks.performance.now() - workerScanStartMs;
  for (const { worker: w, alive, status, heartbeat, paneCapture } of workerSignals) {
    const currentTask = status.current_task_id ? taskById.get(status.current_task_id) ?? null : null;
    const outstandingTask = currentTask ?? findOutstandingWorkerTask(w, taskById, inProgressByOwner);
    const expectedTaskId = status.current_task_id ?? outstandingTask?.id ?? w.assigned_tasks[0] ?? "";
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
    const paneSuggestsIdle = alive && paneLooksReady(paneCapture) && !paneHasActiveTask(paneCapture);
    const statusFresh = isFreshTimestamp(status.updated_at);
    const heartbeatFresh = isFreshTimestamp(heartbeat?.last_turn_at);
    const hasWorkStartEvidence = expectedTaskId !== "" && hasWorkerStatusProgress(status, expectedTaskId);
    let stallReason = null;
    if (paneSuggestsIdle && expectedTaskId !== "" && !hasWorkStartEvidence) {
      stallReason = "no_work_start_evidence";
    } else if (paneSuggestsIdle && expectedTaskId !== "" && (!statusFresh || !heartbeatFresh)) {
      stallReason = "stale_or_missing_worker_reports";
    } else if (paneSuggestsIdle && turnsWithoutProgress > 5) {
      stallReason = "no_meaningful_turn_progress";
    }
    if (stallReason) {
      nonReportingWorkers.push(w.name);
      if (stallReason === "no_work_start_evidence") {
        recommendations.push(`Investigate ${w.name}: assigned work but no work-start evidence; pane is idle at prompt`);
      } else if (stallReason === "stale_or_missing_worker_reports") {
        recommendations.push(`Investigate ${w.name}: pane is idle while status/heartbeat are stale or missing`);
      } else {
        recommendations.push(`Investigate ${w.name}: no meaningful turn progress and pane is idle at prompt`);
      }
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
  const logEventFailure = createSwallowedErrorLogger(
    "team.runtime-v2.shutdownTeamV2 appendTeamEvent failed"
  );
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
    const governance = getConfigGovernance(config);
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
    }, cwd).catch(logEventFailure);
    if (!gate.allowed) {
      const hasActiveWork = gate.pending > 0 || gate.blocked > 0 || gate.in_progress > 0;
      if (!governance.cleanup_requires_all_workers_inactive) {
        await appendTeamEvent(sanitized, {
          type: "team_leader_nudge",
          worker: "leader-fixed",
          reason: `cleanup_override_bypassed:pending=${gate.pending},blocked=${gate.blocked},in_progress=${gate.in_progress},failed=${gate.failed}`
        }, cwd).catch(logEventFailure);
      } else if (ralph && !hasActiveWork) {
        await appendTeamEvent(sanitized, {
          type: "team_leader_nudge",
          worker: "leader-fixed",
          reason: `gate_bypassed:pending=${gate.pending},blocked=${gate.blocked},in_progress=${gate.in_progress},failed=${gate.failed}`
        }, cwd).catch(logEventFailure);
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
    }, cwd).catch(logEventFailure);
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
        }, cwd).catch(logEventFailure);
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
    const { killWorkerPanes: killWorkerPanes2, killTeamSession: killTeamSession2, resolveSplitPaneWorkerPaneIds: resolveSplitPaneWorkerPaneIds2 } = await Promise.resolve().then(() => (init_tmux_session(), tmux_session_exports));
    const recordedWorkerPaneIds = config.workers.map((w) => w.pane_id).filter((p) => typeof p === "string" && p.trim().length > 0);
    const ownsWindow = config.tmux_window_owned === true;
    const workerPaneIds = ownsWindow ? recordedWorkerPaneIds : await resolveSplitPaneWorkerPaneIds2(
      config.tmux_session,
      recordedWorkerPaneIds,
      config.leader_pane_id ?? void 0
    );
    await killWorkerPanes2({
      paneIds: workerPaneIds,
      leaderPaneId: config.leader_pane_id ?? void 0,
      teamName: sanitized,
      cwd
    });
    if (config.tmux_session && (ownsWindow || !config.tmux_session.includes(":"))) {
      const sessionMode = ownsWindow ? config.tmux_session.includes(":") ? "dedicated-window" : "detached-session" : "detached-session";
      await killTeamSession2(
        config.tmux_session,
        workerPaneIds,
        config.leader_pane_id ?? void 0,
        { sessionMode }
      );
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
    }, cwd).catch(logEventFailure);
  }
  try {
    cleanupTeamWorktrees(sanitized, cwd);
  } catch (err) {
    process.stderr.write(`[team/runtime-v2] worktree cleanup: ${err}
`);
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
  const markerPath = (0, import_path19.join)(stateRoot2, "watchdog-failed.json");
  let raw;
  try {
    raw = await (0, import_promises8.readFile)(markerPath, "utf-8");
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
    await (0, import_promises8.unlink)(markerPath);
  } catch {
  }
  return { failed: false };
}
async function writeResultArtifact(output, finishedAt, jobId = process.env.OMC_JOB_ID, omcJobsDir = process.env.OMC_JOBS_DIR) {
  if (!jobId || !omcJobsDir) return;
  const resultPath = (0, import_path19.join)(omcJobsDir, `${jobId}-result.json`);
  const tmpPath = `${resultPath}.tmp`;
  await (0, import_promises8.writeFile)(
    tmpPath,
    JSON.stringify({ ...output, finishedAt }),
    "utf-8"
  );
  await (0, import_promises8.rename)(tmpPath, resultPath);
}
async function writePanesFile(jobId, paneIds, leaderPaneId, sessionName2, ownsWindow) {
  const omcJobsDir = process.env.OMC_JOBS_DIR;
  if (!jobId || !omcJobsDir) return;
  const panesPath = (0, import_path19.join)(omcJobsDir, `${jobId}-panes.json`);
  await (0, import_promises8.writeFile)(
    panesPath + ".tmp",
    JSON.stringify({ paneIds: [...paneIds], leaderPaneId, sessionName: sessionName2, ownsWindow })
  );
  await (0, import_promises8.rename)(panesPath + ".tmp", panesPath);
}
function collectTaskResults(stateRoot2) {
  const tasksDir = (0, import_path19.join)(stateRoot2, "tasks");
  try {
    const files = (0, import_fs18.readdirSync)(tasksDir).filter((f) => f.endsWith(".json"));
    return files.map((f) => {
      try {
        const raw = (0, import_fs18.readFileSync)((0, import_path19.join)(tasksDir, f), "utf-8");
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
  const logLeaderNudgeEventFailure = createSwallowedErrorLogger(
    "team.runtime-cli main appendTeamEvent failed"
  );
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
    newWindow = false,
    pollIntervalMs = 5e3,
    sentinelGateTimeoutMs = 3e4,
    sentinelGatePollIntervalMs = 250
  } = input;
  const workerCount = input.workerCount ?? agentTypes.length;
  const stateRoot2 = (0, import_path19.join)(cwd, `.omc/state/team/${teamName}`);
  const config = {
    teamName,
    workerCount,
    agentTypes,
    tasks,
    cwd,
    newWindow
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
            runtime.leaderPaneId,
            runtime.ownsWindow
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
        cwd,
        newWindow
      });
      const v2PaneIds = v2Runtime.config.workers.map((w) => w.pane_id).filter((p) => typeof p === "string");
      runtime = {
        teamName: v2Runtime.teamName,
        sessionName: v2Runtime.sessionName,
        leaderPaneId: v2Runtime.config.leader_pane_id || "",
        ownsWindow: v2Runtime.ownsWindow,
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
    await writePanesFile(jobId, runtime.workerPaneIds, runtime.leaderPaneId, runtime.sessionName, Boolean(runtime.ownsWindow));
  } catch (err) {
    process.stderr.write(`[runtime-cli] Failed to persist pane IDs: ${err}
`);
  }
  if (useV2) {
    process.stderr.write("[runtime-cli] Using runtime v2 (event-driven, no watchdog)\n");
    let lastLeaderNudgeReason = "";
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
        await writePanesFile(jobId, runtime.workerPaneIds, runtime.leaderPaneId, runtime.sessionName, Boolean(runtime.ownsWindow));
      } catch {
      }
      process.stderr.write(
        `[runtime-cli/v2] phase=${snap.phase} pending=${snap.tasks.pending} in_progress=${snap.tasks.in_progress} completed=${snap.tasks.completed} failed=${snap.tasks.failed} dead=${snap.deadWorkers.length} totalMs=${snap.performance.total_ms}
`
      );
      const leaderGuidance = deriveTeamLeaderGuidance({
        tasks: {
          pending: snap.tasks.pending,
          blocked: snap.tasks.blocked,
          inProgress: snap.tasks.in_progress,
          completed: snap.tasks.completed,
          failed: snap.tasks.failed
        },
        workers: {
          total: snap.workers.length,
          alive: snap.workers.filter((worker) => worker.alive).length,
          idle: snap.workers.filter((worker) => worker.alive && (worker.status.state === "idle" || worker.status.state === "done")).length,
          nonReporting: snap.nonReportingWorkers.length
        }
      });
      process.stderr.write(
        `[runtime-cli/v2] leader_next_action=${leaderGuidance.nextAction} reason=${leaderGuidance.reason}
`
      );
      if (leaderGuidance.nextAction === "keep-checking-status") {
        lastLeaderNudgeReason = "";
      }
      if (leaderGuidance.nextAction !== "keep-checking-status" && leaderGuidance.reason !== lastLeaderNudgeReason) {
        await appendTeamEvent(teamName, {
          type: "team_leader_nudge",
          worker: "leader-fixed",
          reason: leaderGuidance.reason,
          next_action: leaderGuidance.nextAction,
          message: leaderGuidance.message
        }, cwd).catch(logLeaderNudgeEventFailure);
        lastLeaderNudgeReason = leaderGuidance.reason;
      }
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
          const sentinelLogPath = (0, import_path19.join)(cwd, "sentinel_stop.jsonl");
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
      await writePanesFile(jobId, runtime.workerPaneIds, runtime.leaderPaneId, runtime.sessionName, Boolean(runtime.ownsWindow));
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
      const sentinelLogPath = (0, import_path19.join)(cwd, "sentinel_stop.jsonl");
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
