"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
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

// ../../../node_modules/jsonc-parser/lib/umd/main.js
var require_main = __commonJS({
  "../../../node_modules/jsonc-parser/lib/umd/main.js"(exports2, module2) {
    (function(factory) {
      if (typeof module2 === "object" && typeof module2.exports === "object") {
        var v = factory(require, exports2);
        if (v !== void 0) module2.exports = v;
      } else if (typeof define === "function" && define.amd) {
        define(["require", "exports", "./impl/format", "./impl/edit", "./impl/scanner", "./impl/parser"], factory);
      }
    })(function(require2, exports3) {
      "use strict";
      Object.defineProperty(exports3, "__esModule", { value: true });
      exports3.applyEdits = exports3.modify = exports3.format = exports3.printParseErrorCode = exports3.ParseErrorCode = exports3.stripComments = exports3.visit = exports3.getNodeValue = exports3.getNodePath = exports3.findNodeAtOffset = exports3.findNodeAtLocation = exports3.parseTree = exports3.parse = exports3.getLocation = exports3.SyntaxKind = exports3.ScanError = exports3.createScanner = void 0;
      const formatter = require2("./impl/format");
      const edit = require2("./impl/edit");
      const scanner = require2("./impl/scanner");
      const parser = require2("./impl/parser");
      exports3.createScanner = scanner.createScanner;
      var ScanError;
      (function(ScanError2) {
        ScanError2[ScanError2["None"] = 0] = "None";
        ScanError2[ScanError2["UnexpectedEndOfComment"] = 1] = "UnexpectedEndOfComment";
        ScanError2[ScanError2["UnexpectedEndOfString"] = 2] = "UnexpectedEndOfString";
        ScanError2[ScanError2["UnexpectedEndOfNumber"] = 3] = "UnexpectedEndOfNumber";
        ScanError2[ScanError2["InvalidUnicode"] = 4] = "InvalidUnicode";
        ScanError2[ScanError2["InvalidEscapeCharacter"] = 5] = "InvalidEscapeCharacter";
        ScanError2[ScanError2["InvalidCharacter"] = 6] = "InvalidCharacter";
      })(ScanError || (exports3.ScanError = ScanError = {}));
      var SyntaxKind;
      (function(SyntaxKind2) {
        SyntaxKind2[SyntaxKind2["OpenBraceToken"] = 1] = "OpenBraceToken";
        SyntaxKind2[SyntaxKind2["CloseBraceToken"] = 2] = "CloseBraceToken";
        SyntaxKind2[SyntaxKind2["OpenBracketToken"] = 3] = "OpenBracketToken";
        SyntaxKind2[SyntaxKind2["CloseBracketToken"] = 4] = "CloseBracketToken";
        SyntaxKind2[SyntaxKind2["CommaToken"] = 5] = "CommaToken";
        SyntaxKind2[SyntaxKind2["ColonToken"] = 6] = "ColonToken";
        SyntaxKind2[SyntaxKind2["NullKeyword"] = 7] = "NullKeyword";
        SyntaxKind2[SyntaxKind2["TrueKeyword"] = 8] = "TrueKeyword";
        SyntaxKind2[SyntaxKind2["FalseKeyword"] = 9] = "FalseKeyword";
        SyntaxKind2[SyntaxKind2["StringLiteral"] = 10] = "StringLiteral";
        SyntaxKind2[SyntaxKind2["NumericLiteral"] = 11] = "NumericLiteral";
        SyntaxKind2[SyntaxKind2["LineCommentTrivia"] = 12] = "LineCommentTrivia";
        SyntaxKind2[SyntaxKind2["BlockCommentTrivia"] = 13] = "BlockCommentTrivia";
        SyntaxKind2[SyntaxKind2["LineBreakTrivia"] = 14] = "LineBreakTrivia";
        SyntaxKind2[SyntaxKind2["Trivia"] = 15] = "Trivia";
        SyntaxKind2[SyntaxKind2["Unknown"] = 16] = "Unknown";
        SyntaxKind2[SyntaxKind2["EOF"] = 17] = "EOF";
      })(SyntaxKind || (exports3.SyntaxKind = SyntaxKind = {}));
      exports3.getLocation = parser.getLocation;
      exports3.parse = parser.parse;
      exports3.parseTree = parser.parseTree;
      exports3.findNodeAtLocation = parser.findNodeAtLocation;
      exports3.findNodeAtOffset = parser.findNodeAtOffset;
      exports3.getNodePath = parser.getNodePath;
      exports3.getNodeValue = parser.getNodeValue;
      exports3.visit = parser.visit;
      exports3.stripComments = parser.stripComments;
      var ParseErrorCode;
      (function(ParseErrorCode2) {
        ParseErrorCode2[ParseErrorCode2["InvalidSymbol"] = 1] = "InvalidSymbol";
        ParseErrorCode2[ParseErrorCode2["InvalidNumberFormat"] = 2] = "InvalidNumberFormat";
        ParseErrorCode2[ParseErrorCode2["PropertyNameExpected"] = 3] = "PropertyNameExpected";
        ParseErrorCode2[ParseErrorCode2["ValueExpected"] = 4] = "ValueExpected";
        ParseErrorCode2[ParseErrorCode2["ColonExpected"] = 5] = "ColonExpected";
        ParseErrorCode2[ParseErrorCode2["CommaExpected"] = 6] = "CommaExpected";
        ParseErrorCode2[ParseErrorCode2["CloseBraceExpected"] = 7] = "CloseBraceExpected";
        ParseErrorCode2[ParseErrorCode2["CloseBracketExpected"] = 8] = "CloseBracketExpected";
        ParseErrorCode2[ParseErrorCode2["EndOfFileExpected"] = 9] = "EndOfFileExpected";
        ParseErrorCode2[ParseErrorCode2["InvalidCommentToken"] = 10] = "InvalidCommentToken";
        ParseErrorCode2[ParseErrorCode2["UnexpectedEndOfComment"] = 11] = "UnexpectedEndOfComment";
        ParseErrorCode2[ParseErrorCode2["UnexpectedEndOfString"] = 12] = "UnexpectedEndOfString";
        ParseErrorCode2[ParseErrorCode2["UnexpectedEndOfNumber"] = 13] = "UnexpectedEndOfNumber";
        ParseErrorCode2[ParseErrorCode2["InvalidUnicode"] = 14] = "InvalidUnicode";
        ParseErrorCode2[ParseErrorCode2["InvalidEscapeCharacter"] = 15] = "InvalidEscapeCharacter";
        ParseErrorCode2[ParseErrorCode2["InvalidCharacter"] = 16] = "InvalidCharacter";
      })(ParseErrorCode || (exports3.ParseErrorCode = ParseErrorCode = {}));
      function printParseErrorCode(code) {
        switch (code) {
          case 1:
            return "InvalidSymbol";
          case 2:
            return "InvalidNumberFormat";
          case 3:
            return "PropertyNameExpected";
          case 4:
            return "ValueExpected";
          case 5:
            return "ColonExpected";
          case 6:
            return "CommaExpected";
          case 7:
            return "CloseBraceExpected";
          case 8:
            return "CloseBracketExpected";
          case 9:
            return "EndOfFileExpected";
          case 10:
            return "InvalidCommentToken";
          case 11:
            return "UnexpectedEndOfComment";
          case 12:
            return "UnexpectedEndOfString";
          case 13:
            return "UnexpectedEndOfNumber";
          case 14:
            return "InvalidUnicode";
          case 15:
            return "InvalidEscapeCharacter";
          case 16:
            return "InvalidCharacter";
        }
        return "<unknown ParseErrorCode>";
      }
      exports3.printParseErrorCode = printParseErrorCode;
      function format(documentText, range, options) {
        return formatter.format(documentText, range, options);
      }
      exports3.format = format;
      function modify(text, path, value, options) {
        return edit.setProperty(text, path, value, options);
      }
      exports3.modify = modify;
      function applyEdits(text, edits) {
        let sortedEdits = edits.slice(0).sort((a, b) => {
          const diff = a.offset - b.offset;
          if (diff === 0) {
            return a.length - b.length;
          }
          return diff;
        });
        let lastModifiedOffset = text.length;
        for (let i = sortedEdits.length - 1; i >= 0; i--) {
          let e = sortedEdits[i];
          if (e.offset + e.length <= lastModifiedOffset) {
            text = edit.applyEdit(text, e);
          } else {
            throw new Error("Overlapping edit");
          }
          lastModifiedOffset = e.offset;
        }
        return text;
      }
      exports3.applyEdits = applyEdits;
    });
  }
});

// src/team/runtime-cli.ts
var import_fs10 = require("fs");
var import_promises4 = require("fs/promises");
var import_path12 = require("path");

// src/team/runtime.ts
var import_promises3 = require("fs/promises");
var import_path9 = require("path");
var import_fs6 = require("fs");

// src/team/model-contract.ts
var import_child_process = require("child_process");

// src/team/team-name.ts
var TEAM_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/;
function validateTeamName(teamName) {
  if (!TEAM_NAME_PATTERN.test(teamName)) {
    throw new Error(
      `Invalid team name: "${teamName}". Team name must match /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/.`
    );
  }
  return teamName;
}

// src/team/model-contract.ts
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
    promptModeFlag: "-p",
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
    const result = (0, import_child_process.spawnSync)(contract.binary, ["--version"], { timeout: 5e3, shell: true });
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
function buildWorkerArgv(agentType, config) {
  validateTeamName(config.teamName);
  const contract = getContract(agentType);
  const args = buildLaunchArgs(agentType, config);
  return [contract.binary, ...args];
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

// src/team/tmux-session.ts
var import_child_process2 = require("child_process");
var import_path = require("path");
var import_util = require("util");
var import_promises = __toESM(require("fs/promises"), 1);
var promisifiedExec = (0, import_util.promisify)(import_child_process2.exec);
var promisifiedExecFile = (0, import_util.promisify)(import_child_process2.execFile);
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
  const shellName = (0, import_path.basename)(shellPath.replace(/\\/g, "/"));
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
function getLaunchWords(config) {
  if (config.launchBinary) {
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
    const rcFile2 = process.env.HOME ? `${process.env.HOME}/.${shellName2}rc` : "";
    const script = rcFile2 ? `[ -f ${shellEscape(rcFile2)} ] && . ${shellEscape(rcFile2)}; exec "$@"` : 'exec "$@"';
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
  const sourceCmd = rcFile ? `[ -f "${rcFile}" ] && source "${rcFile}"; ` : "";
  return `env ${envString} ${shell} -c "${sourceCmd}exec ${launchWords[0]}"`;
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
async function createTeamSession(teamName, workerCount, cwd) {
  const { execFile: execFile2 } = await import("child_process");
  const { promisify: promisify2 } = await import("util");
  const execFileAsync = promisify2(execFile2);
  if (!process.env.TMUX) {
    throw new Error("Team mode requires running inside tmux. Start one: tmux new-session");
  }
  const envPaneIdRaw = (process.env.TMUX_PANE ?? "").trim();
  const envPaneId = /^%\d+$/.test(envPaneIdRaw) ? envPaneIdRaw : "";
  let sessionAndWindow = "";
  let leaderPaneId = envPaneId;
  if (envPaneId) {
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
async function spawnWorkerInPane(sessionName, paneId, config) {
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
  if (process.env.OMX_TEAM_AUTO_INTERRUPT_RETRY === "0") return false;
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
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
      await sleep(80);
      if (await paneInCopyMode(paneId, execFileAsync)) {
        return false;
      }
      await execFileAsync("tmux", ["send-keys", "-t", paneId, "-l", "--", message]);
      await sleep(120);
      for (let round = 0; round < 4; round++) {
        await sendKey("C-m");
        await sleep(180);
        await sendKey("C-m");
        await sleep(140);
        const retryCapture = await capturePaneAsync(paneId, execFileAsync);
        if (!paneTailContainsLiteralLine(retryCapture, message)) return true;
      }
    }
    if (await paneInCopyMode(paneId, execFileAsync)) {
      return false;
    }
    await sendKey("C-m");
    await sleep(120);
    await sendKey("C-m");
    return true;
  } catch {
    return false;
  }
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
async function killTeamSession(sessionName, workerPaneIds, leaderPaneId) {
  const { execFile: execFile2 } = await import("child_process");
  const { promisify: promisify2 } = await import("util");
  const execFileAsync = promisify2(execFile2);
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

// src/team/task-file-ops.ts
var import_fs5 = require("fs");
var import_path8 = require("path");

// src/utils/paths.ts
var import_path5 = require("path");
var import_fs3 = require("fs");
var import_os = require("os");
function getConfigDir2() {
  if (process.platform === "win32") {
    return process.env.APPDATA || (0, import_path5.join)((0, import_os.homedir)(), "AppData", "Roaming");
  }
  return process.env.XDG_CONFIG_HOME || (0, import_path5.join)((0, import_os.homedir)(), ".config");
}
var STALE_THRESHOLD_MS = 24 * 60 * 60 * 1e3;

// src/team/fs-utils.ts
var import_fs4 = require("fs");
var import_path6 = require("path");
function atomicWriteJson(filePath, data, mode = 384) {
  const dir = (0, import_path6.dirname)(filePath);
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
    const parent = (0, import_path6.dirname)(p);
    const name = (0, import_path6.basename)(p);
    try {
      return (0, import_path6.resolve)((0, import_fs4.realpathSync)(parent), name);
    } catch {
      return (0, import_path6.resolve)(p);
    }
  }
}
function validateResolvedPath(resolvedPath, expectedBase) {
  const absResolved = safeRealpath(resolvedPath);
  const absBase = safeRealpath(expectedBase);
  const rel = (0, import_path6.relative)(absBase, absResolved);
  if (rel.startsWith("..") || (0, import_path6.resolve)(absBase, rel) !== absResolved) {
    throw new Error(`Path traversal detected: "${resolvedPath}" escapes base "${expectedBase}"`);
  }
}

// src/team/state-paths.ts
var import_path7 = require("path");
var TeamPaths = {
  root: (teamName) => `.omc/state/team/${teamName}`,
  config: (teamName) => `.omc/state/team/${teamName}/config.json`,
  shutdown: (teamName) => `.omc/state/team/${teamName}/shutdown.json`,
  tasks: (teamName) => `.omc/state/team/${teamName}/tasks`,
  taskFile: (teamName, taskId) => `.omc/state/team/${teamName}/tasks/${taskId}.json`,
  workers: (teamName) => `.omc/state/team/${teamName}/workers`,
  workerDir: (teamName, workerName2) => `.omc/state/team/${teamName}/workers/${workerName2}`,
  heartbeat: (teamName, workerName2) => `.omc/state/team/${teamName}/workers/${workerName2}/heartbeat.json`,
  inbox: (teamName, workerName2) => `.omc/state/team/${teamName}/workers/${workerName2}/inbox.md`,
  outbox: (teamName, workerName2) => `.omc/state/team/${teamName}/workers/${workerName2}/outbox.jsonl`,
  ready: (teamName, workerName2) => `.omc/state/team/${teamName}/workers/${workerName2}/.ready`,
  overlay: (teamName, workerName2) => `.omc/state/team/${teamName}/workers/${workerName2}/AGENTS.md`,
  shutdownAck: (teamName, workerName2) => `.omc/state/team/${teamName}/workers/${workerName2}/shutdown-ack.json`,
  done: (teamName, workerName2) => `.omc/state/team/${teamName}/workers/${workerName2}/done.json`,
  mailbox: (teamName, workerName2) => `.omc/state/team/${teamName}/mailbox/${workerName2}.jsonl`
};
function getTaskStoragePath(cwd, teamName, taskId) {
  if (taskId !== void 0) {
    return (0, import_path7.join)(cwd, TeamPaths.taskFile(teamName, taskId));
  }
  return (0, import_path7.join)(cwd, TeamPaths.tasks(teamName));
}

// src/team/task-file-ops.ts
var DEFAULT_STALE_LOCK_MS = 3e4;
var FAILURE_LOCK_RETRY_ATTEMPTS = 40;
var FAILURE_LOCK_RETRY_DELAY_MS = 5;
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
  const lockPath = (0, import_path8.join)(dir, `${sanitizeTaskId(taskId)}.lock`);
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
async function sleepAsync(ms) {
  return new Promise((resolve4) => setTimeout(resolve4, ms));
}
async function acquireTaskLockWithRetry(teamName, taskId, opts) {
  const attempts = opts?.attempts ?? FAILURE_LOCK_RETRY_ATTEMPTS;
  const delayMs = opts?.delayMs ?? FAILURE_LOCK_RETRY_DELAY_MS;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const handle = acquireTaskLock(teamName, taskId, opts);
    if (handle) return handle;
    if (attempt < attempts - 1) await sleepAsync(delayMs);
  }
  throw new Error(`Failed to acquire lock for ${taskId} after ${attempts} attempts`);
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
  validateResolvedPath(dir, (0, import_path8.join)(root, ".omc", "state", "team"));
  return dir;
}
function failureSidecarPath(teamName, taskId, cwd) {
  return (0, import_path8.join)(canonicalTasksDir(teamName, cwd), `${sanitizeTaskId(taskId)}.failure.json`);
}
async function writeTaskFailure(teamName, taskId, error, opts) {
  const failureLockId = `${sanitizeTaskId(taskId)}-failure`;
  const handle = await acquireTaskLockWithRetry(teamName, failureLockId, { cwd: opts?.cwd });
  try {
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
  } finally {
    releaseTaskLock(handle);
  }
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
  return (0, import_path9.join)(cwd, `.omc/state/team/${teamName}`);
}
async function writeJson(filePath, data) {
  await (0, import_promises3.mkdir)((0, import_path9.join)(filePath, ".."), { recursive: true });
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
function parseWorkerIndex(workerNameValue) {
  const match = workerNameValue.match(/^worker-(\d+)$/);
  if (!match) return 0;
  const parsed = Number.parseInt(match[1], 10) - 1;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
function taskPath(root, taskId) {
  return (0, import_path9.join)(root, "tasks", `${taskId}.json`);
}
async function writePanesTrackingFileIfPresent(runtime) {
  const jobId = process.env.OMC_JOB_ID;
  const omcJobsDir = process.env.OMC_JOBS_DIR;
  if (!jobId || !omcJobsDir) return;
  const panesPath = (0, import_path9.join)(omcJobsDir, `${jobId}-panes.json`);
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
  for (let i = 0; i < runtime.config.tasks.length; i++) {
    const task = await readTask(root, String(i + 1));
    if (task?.status === "pending") return i;
  }
  return null;
}
async function notifyPaneWithRetry(sessionName, paneId, message, maxAttempts = 6, retryDelayMs = 350) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (await sendToWorker(sessionName, paneId, message)) {
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
  for (const agentType of [...new Set(agentTypes)]) {
    validateCliAvailable(agentType);
  }
  const root = stateRoot(cwd, teamName);
  await (0, import_promises3.mkdir)((0, import_path9.join)(root, "tasks"), { recursive: true });
  await (0, import_promises3.mkdir)((0, import_path9.join)(root, "mailbox"), { recursive: true });
  await writeJson((0, import_path9.join)(root, "config.json"), config);
  for (let i = 0; i < tasks.length; i++) {
    const taskId = String(i + 1);
    await writeJson((0, import_path9.join)(root, "tasks", `${taskId}.json`), {
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
    cwd
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
    const { readdir } = await import("fs/promises");
    const taskFiles = await readdir((0, import_path9.join)(root, "tasks"));
    for (const f of taskFiles.filter((f2) => f2.endsWith(".json"))) {
      const task = await readJsonSafe((0, import_path9.join)(root, "tasks", f));
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
    const heartbeatPath = (0, import_path9.join)(root, "workers", wName, "heartbeat.json");
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
          const donePath = (0, import_path9.join)(root, "workers", wName, "done.json");
          return readJsonSafe(donePath);
        })),
        Promise.all(workers.map(([, active]) => isWorkerAlive(active.paneId)))
      ]);
      for (let i = 0; i < workers.length; i++) {
        const [wName, active] = workers[i];
        const donePath = (0, import_path9.join)(root, "workers", wName, "done.json");
        const signal = doneSignals[i];
        if (signal) {
          unresponsiveCounts.delete(wName);
          await markTaskFromDone(root, runtime.teamName, runtime.cwd, signal.taskId || active.taskId, signal.status, signal.summary);
          try {
            const { unlink } = await import("fs/promises");
            await unlink(donePath);
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
        const heartbeatPath = (0, import_path9.join)(root, "workers", wName, "heartbeat.json");
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
          await writeJson((0, import_path9.join)(root, "watchdog-failed.json"), {
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
  const [launchBinary, ...launchArgs] = buildWorkerArgv(agentType, {
    teamName: runtime.teamName,
    workerName: workerNameValue,
    cwd: runtime.cwd
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
    await new Promise((r) => setTimeout(r, 4e3));
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
async function shutdownTeam(teamName, sessionName, cwd, timeoutMs = 3e4, workerPaneIds, leaderPaneId) {
  const root = stateRoot(cwd, teamName);
  await writeJson((0, import_path9.join)(root, "shutdown.json"), {
    requestedAt: (/* @__PURE__ */ new Date()).toISOString(),
    teamName
  });
  const configData = await readJsonSafe((0, import_path9.join)(root, "config.json"));
  const CLI_AGENT_TYPES = /* @__PURE__ */ new Set(["claude", "codex", "gemini"]);
  const agentTypes = configData?.agentTypes ?? [];
  const isCliWorkerTeam = agentTypes.length > 0 && agentTypes.every((t) => CLI_AGENT_TYPES.has(t));
  if (!isCliWorkerTeam) {
    const deadline = Date.now() + timeoutMs;
    const workerCount = configData?.workerCount ?? 0;
    const expectedAcks = Array.from({ length: workerCount }, (_, i) => `worker-${i + 1}`);
    while (Date.now() < deadline && expectedAcks.length > 0) {
      for (const wName of [...expectedAcks]) {
        const ackPath = (0, import_path9.join)(root, "workers", wName, "shutdown-ack.json");
        if ((0, import_fs6.existsSync)(ackPath)) {
          expectedAcks.splice(expectedAcks.indexOf(wName), 1);
        }
      }
      if (expectedAcks.length > 0) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
  await killTeamSession(sessionName, workerPaneIds, leaderPaneId);
  try {
    await (0, import_promises3.rm)(root, { recursive: true, force: true });
  } catch {
  }
}

// src/hooks/factcheck/checks.ts
var import_fs7 = require("fs");
var import_path10 = require("path");

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
  const claimsCwdCanonical = (0, import_path10.resolve)(claimsCwd);
  const runtimeCwdCanonical = (0, import_path10.resolve)(runtimeCwd);
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
var import_path11 = require("path");
var jsonc = __toESM(require_main(), 1);

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
function isNonClaudeProvider() {
  if (process.env.OMC_ROUTING_FORCE_INHERIT === "true") {
    return true;
  }
  const modelId = process.env.CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || "";
  if (modelId && !modelId.toLowerCase().includes("claude")) {
    return true;
  }
  const baseUrl = process.env.ANTHROPIC_BASE_URL || "";
  if (baseUrl && !baseUrl.includes("anthropic.com")) {
    return true;
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
    user: (0, import_path11.join)(userConfigDir, "claude-omc", "config.jsonc"),
    project: (0, import_path11.join)(process.cwd(), ".claude", "omc.jsonc")
  };
}
function loadJsoncFile(path) {
  if (!(0, import_fs8.existsSync)(path)) {
    return null;
  }
  try {
    const content = (0, import_fs8.readFileSync)(path, "utf-8");
    const errors = [];
    const result = jsonc.parse(content, errors, {
      allowTrailingComma: true,
      allowEmptyContent: true
    });
    if (errors.length > 0) {
      console.warn(`Warning: Parse errors in ${path}:`, errors);
    }
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
    await new Promise((resolve4) => setTimeout(resolve4, pollIntervalMs));
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

// src/team/runtime-cli.ts
async function writePanesFile(jobId, paneIds, leaderPaneId) {
  const omcJobsDir = process.env.OMC_JOBS_DIR;
  if (!jobId || !omcJobsDir) return;
  const panesPath = (0, import_path12.join)(omcJobsDir, `${jobId}-panes.json`);
  await (0, import_promises4.writeFile)(
    panesPath + ".tmp",
    JSON.stringify({ paneIds: [...paneIds], leaderPaneId })
  );
  await (0, import_promises4.rename)(panesPath + ".tmp", panesPath);
}
function collectTaskResults(stateRoot2) {
  const tasksDir = (0, import_path12.join)(stateRoot2, "tasks");
  try {
    const files = (0, import_fs10.readdirSync)(tasksDir).filter((f) => f.endsWith(".json"));
    return files.map((f) => {
      try {
        const raw = (0, import_fs10.readFileSync)((0, import_path12.join)(tasksDir, f), "utf-8");
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
  const stateRoot2 = (0, import_path12.join)(cwd, `.omc/state/team/${teamName}`);
  const config = {
    teamName,
    workerCount,
    agentTypes,
    tasks,
    cwd
  };
  let runtime = null;
  let finalStatus = "failed";
  let pollActive = true;
  function exitCodeFor(status) {
    return status === "completed" ? 0 : 1;
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
  try {
    await writePanesFile(jobId, runtime.workerPaneIds, runtime.leaderPaneId);
  } catch (err) {
    process.stderr.write(`[runtime-cli] Failed to persist pane IDs: ${err}
`);
  }
  while (pollActive) {
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
    if (snap.phase === "completed") {
      const sentinelLogPath = (0, import_path12.join)(cwd, "sentinel_stop.jsonl");
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
