
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

// src/clawdcoder/config.ts
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
var import_node_os = require("node:os");
var DEFAULT_CONFIG = {
  maxSessions: 5,
  autoCleanupHours: 24,
  defaultProjectDir: (0, import_node_path.join)((0, import_node_os.homedir)(), "projects")
};
function loadConfig() {
  const configPath = (0, import_node_path.join)((0, import_node_os.homedir)(), ".claude", ".omc-config.json");
  try {
    if (!(0, import_node_fs.existsSync)(configPath)) {
      return { ...DEFAULT_CONFIG };
    }
    const raw = (0, import_node_fs.readFileSync)(configPath, "utf8");
    const full = JSON.parse(raw);
    const clawdcoderConfig = full.clawdcoder ?? {};
    if (process.env.CLAWDCODER_DISCORD_TOKEN) {
      clawdcoderConfig.discord = {
        ...clawdcoderConfig.discord,
        token: process.env.CLAWDCODER_DISCORD_TOKEN,
        enabled: true
      };
    }
    if (process.env.CLAWDCODER_TELEGRAM_TOKEN) {
      clawdcoderConfig.telegram = {
        ...clawdcoderConfig.telegram,
        token: process.env.CLAWDCODER_TELEGRAM_TOKEN,
        enabled: true
      };
    }
    return { ...DEFAULT_CONFIG, ...clawdcoderConfig };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
function getDbPath(config) {
  if (config.dbPath) {
    return config.dbPath.replace(/^~/, (0, import_node_os.homedir)());
  }
  return (0, import_node_path.join)((0, import_node_os.homedir)(), ".omc", "data", "clawdcoder.db");
}
function getSocketPath() {
  return (0, import_node_path.join)((0, import_node_os.homedir)(), ".omc", "state", "clawdcoder.sock");
}
function getPidPath() {
  return (0, import_node_path.join)((0, import_node_os.homedir)(), ".omc", "state", "clawdcoder.pid");
}
function getLogPath() {
  return (0, import_node_path.join)((0, import_node_os.homedir)(), ".omc", "logs", "clawdcoder.log");
}

// src/clawdcoder/db/index.ts
var import_better_sqlite3 = __toESM(require("better-sqlite3"), 1);
var import_node_fs2 = require("node:fs");
var import_node_path2 = require("node:path");

// src/clawdcoder/db/repositories/sessions.ts
var import_node_crypto = require("node:crypto");
function rowToSession(row) {
  return {
    id: row.id,
    name: row.name,
    tmuxSession: row.tmux_session,
    tmuxWindow: row.tmux_window,
    claudeSessionId: row.claude_session_id ?? void 0,
    projectId: row.project_id ?? void 0,
    workingDirectory: row.working_directory,
    status: row.status,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at),
    lastActiveAt: new Date(row.last_active_at),
    totalCostUsd: row.total_cost_usd,
    totalInputTokens: row.total_input_tokens,
    totalOutputTokens: row.total_output_tokens,
    metadata: row.metadata ? JSON.parse(row.metadata) : void 0
  };
}
var SessionRepository = class {
  create(data) {
    const db2 = getDatabase();
    const id = (0, import_node_crypto.randomUUID)();
    db2.prepare(`
      INSERT INTO sessions (id, name, tmux_session, working_directory, created_by, project_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, data.name, data.tmuxSession, data.workingDirectory, data.createdBy, data.projectId ?? null);
    return this.findById(id);
  }
  findById(id) {
    const db2 = getDatabase();
    const row = db2.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
    return row ? rowToSession(row) : null;
  }
  findByName(name) {
    const db2 = getDatabase();
    const row = db2.prepare("SELECT * FROM sessions WHERE name = ? AND status != ?").get(name, "terminated");
    return row ? rowToSession(row) : null;
  }
  findActive() {
    const db2 = getDatabase();
    const rows = db2.prepare("SELECT * FROM sessions WHERE status = ? ORDER BY last_active_at DESC").all("active");
    return rows.map(rowToSession);
  }
  findByUser(userId) {
    const db2 = getDatabase();
    const rows = db2.prepare("SELECT * FROM sessions WHERE created_by = ? ORDER BY last_active_at DESC").all(userId);
    return rows.map(rowToSession);
  }
  updateStatus(id, status) {
    const db2 = getDatabase();
    db2.prepare("UPDATE sessions SET status = ?, last_active_at = CURRENT_TIMESTAMP WHERE id = ?").run(status, id);
  }
  updateClaudeSessionId(id, claudeSessionId) {
    const db2 = getDatabase();
    db2.prepare("UPDATE sessions SET claude_session_id = ? WHERE id = ?").run(claudeSessionId, id);
  }
  updateCost(id, inputTokens, outputTokens, costUsd) {
    const db2 = getDatabase();
    db2.prepare(`
      UPDATE sessions SET
        total_input_tokens = total_input_tokens + ?,
        total_output_tokens = total_output_tokens + ?,
        total_cost_usd = total_cost_usd + ?,
        last_active_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(inputTokens, outputTokens, costUsd, id);
  }
  delete(id) {
    const db2 = getDatabase();
    db2.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }
  countActive() {
    const db2 = getDatabase();
    const row = db2.prepare("SELECT COUNT(*) as count FROM sessions WHERE status = ?").get("active");
    return row.count;
  }
};

// src/clawdcoder/db/repositories/users.ts
var import_node_crypto2 = require("node:crypto");
function rowToUser(row) {
  return {
    id: row.id,
    discordId: row.discord_id ?? void 0,
    telegramId: row.telegram_id ?? void 0,
    username: row.username,
    role: row.role,
    createdAt: new Date(row.created_at),
    settings: row.settings ? JSON.parse(row.settings) : void 0
  };
}
var UserRepository = class {
  create(data) {
    const db2 = getDatabase();
    const id = (0, import_node_crypto2.randomUUID)();
    db2.prepare(`
      INSERT INTO users (id, username, discord_id, telegram_id, role)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, data.username, data.discordId ?? null, data.telegramId ?? null, data.role ?? "user");
    return this.findById(id);
  }
  findById(id) {
    const db2 = getDatabase();
    const row = db2.prepare("SELECT * FROM users WHERE id = ?").get(id);
    return row ? rowToUser(row) : null;
  }
  findByDiscordId(discordId) {
    const db2 = getDatabase();
    const row = db2.prepare("SELECT * FROM users WHERE discord_id = ?").get(discordId);
    return row ? rowToUser(row) : null;
  }
  findByTelegramId(telegramId) {
    const db2 = getDatabase();
    const row = db2.prepare("SELECT * FROM users WHERE telegram_id = ?").get(telegramId);
    return row ? rowToUser(row) : null;
  }
  findOrCreate(data) {
    if (data.discordId) {
      const existing = this.findByDiscordId(data.discordId);
      if (existing) return existing;
    }
    if (data.telegramId) {
      const existing = this.findByTelegramId(data.telegramId);
      if (existing) return existing;
    }
    const db2 = getDatabase();
    const count = db2.prepare("SELECT COUNT(*) as count FROM users").get();
    const role = count.count === 0 ? "admin" : "user";
    return this.create({ ...data, role });
  }
  updateRole(id, role) {
    const db2 = getDatabase();
    db2.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id);
  }
  linkDiscord(id, discordId) {
    const db2 = getDatabase();
    db2.prepare("UPDATE users SET discord_id = ? WHERE id = ?").run(discordId, id);
  }
  linkTelegram(id, telegramId) {
    const db2 = getDatabase();
    db2.prepare("UPDATE users SET telegram_id = ? WHERE id = ?").run(telegramId, id);
  }
  all() {
    const db2 = getDatabase();
    const rows = db2.prepare("SELECT * FROM users ORDER BY created_at").all();
    return rows.map(rowToUser);
  }
};

// src/clawdcoder/db/index.ts
var db = null;
var MIGRATION_001_INITIAL = `
-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tmux_session TEXT NOT NULL,
  tmux_window INTEGER DEFAULT 0,
  claude_session_id TEXT,
  project_id TEXT REFERENCES projects(id),
  working_directory TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  created_by TEXT REFERENCES users(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  total_cost_usd REAL DEFAULT 0.0,
  total_input_tokens INTEGER DEFAULT 0,
  total_output_tokens INTEGER DEFAULT 0,
  metadata TEXT
);

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  discord_id TEXT UNIQUE,
  telegram_id TEXT UNIQUE,
  username TEXT NOT NULL,
  role TEXT DEFAULT 'user',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  settings TEXT
);

-- Projects table
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  directory TEXT NOT NULL,
  git_repo TEXT,
  default_branch TEXT DEFAULT 'main',
  created_by TEXT REFERENCES users(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  settings TEXT
);

-- Permissions table
CREATE TABLE IF NOT EXISTS permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT REFERENCES users(id),
  project_id TEXT REFERENCES projects(id),
  level TEXT DEFAULT 'read',
  granted_by TEXT REFERENCES users(id),
  granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, project_id)
);

-- Cost log table
CREATE TABLE IF NOT EXISTS cost_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT REFERENCES sessions(id),
  user_id TEXT REFERENCES users(id),
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_created_by ON sessions(created_by);
CREATE INDEX IF NOT EXISTS idx_users_discord_id ON users(discord_id);
CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_cost_log_session_id ON cost_log(session_id);
CREATE INDEX IF NOT EXISTS idx_cost_log_user_id ON cost_log(user_id);
`;
function initDatabase(config) {
  if (db) return db;
  const dbPath = getDbPath(config);
  const dbDir = (0, import_node_path2.dirname)(dbPath);
  if (!(0, import_node_fs2.existsSync)(dbDir)) {
    (0, import_node_fs2.mkdirSync)(dbDir, { recursive: true });
  }
  db = new import_better_sqlite3.default(dbPath);
  db.pragma("journal_mode = WAL");
  runMigrations(db);
  return db;
}
function runMigrations(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const applied = database.prepare("SELECT name FROM migrations").all();
  const appliedNames = new Set(applied.map((m) => m.name));
  if (!appliedNames.has("001-initial")) {
    database.exec(MIGRATION_001_INITIAL);
    database.prepare("INSERT INTO migrations (name) VALUES (?)").run("001-initial");
  }
}
function getDatabase() {
  if (!db) {
    throw new Error("Database not initialized. Call initDatabase first.");
  }
  return db;
}
function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

// src/clawdcoder/core/session-manager.ts
var import_node_crypto3 = require("node:crypto");

// src/clawdcoder/core/tmux.ts
var import_node_child_process = require("node:child_process");

// src/clawdcoder/utils/logger.ts
var import_node_fs3 = require("node:fs");
var import_node_path3 = require("node:path");
var logStream = null;
var minLevel = "info";
var LEVEL_ORDER = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};
function shouldLog(level) {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}
function initStream() {
  if (logStream) return;
  const logPath = getLogPath();
  const logDir = (0, import_node_path3.dirname)(logPath);
  if (!(0, import_node_fs3.existsSync)(logDir)) {
    (0, import_node_fs3.mkdirSync)(logDir, { recursive: true });
  }
  logStream = (0, import_node_fs3.createWriteStream)(logPath, { flags: "a" });
}
function log(level, msg, data) {
  if (!shouldLog(level)) return;
  initStream();
  const entry = {
    level,
    msg,
    time: (/* @__PURE__ */ new Date()).toISOString(),
    ...data
  };
  const line = JSON.stringify(entry) + "\n";
  logStream?.write(line);
  if (process.env.NODE_ENV !== "production") {
    const prefix = `[${level.toUpperCase()}]`;
    console.log(prefix, msg, data ? JSON.stringify(data) : "");
  }
}
var logger = {
  debug: (msg, data) => log("debug", msg, data),
  info: (msg, data) => log("info", msg, data),
  warn: (msg, data) => log("warn", msg, data),
  error: (msg, data) => log("error", msg, data),
  setLevel: (level) => {
    minLevel = level;
  },
  close: () => {
    logStream?.end();
    logStream = null;
  }
};

// src/clawdcoder/core/tmux.ts
var SESSION_PREFIX = "cc-";
function checkTmuxInstalled() {
  try {
    (0, import_node_child_process.execSync)("which tmux", { encoding: "utf8", stdio: "pipe" });
  } catch {
    throw new Error("tmux is not installed. Please install tmux to use ClawdCoder.");
  }
}
function createSession(sessionId, cwd) {
  checkTmuxInstalled();
  const name = `${SESSION_PREFIX}${sessionId}`;
  const result = (0, import_node_child_process.spawnSync)("tmux", ["new-session", "-d", "-s", name, "-c", cwd], {
    encoding: "utf8",
    stdio: "pipe"
  });
  if (result.status !== 0) {
    throw new Error(`Failed to create tmux session: ${result.stderr || "Unknown error"}`);
  }
  logger.info("Created tmux session", { name, cwd });
  return name;
}
function killSession(name) {
  checkTmuxInstalled();
  const result = (0, import_node_child_process.spawnSync)("tmux", ["kill-session", "-t", name], {
    encoding: "utf8",
    stdio: "pipe"
  });
  if (result.status !== 0) {
    logger.warn("Failed to kill tmux session", { name, error: result.stderr });
  } else {
    logger.info("Killed tmux session", { name });
  }
}
function sendKeys(name, text) {
  checkTmuxInstalled();
  const escaped = text.replace(/"/g, '\\"');
  const result = (0, import_node_child_process.spawnSync)("tmux", ["send-keys", "-t", name, escaped, "Enter"], {
    encoding: "utf8",
    stdio: "pipe"
  });
  if (result.status !== 0) {
    throw new Error(`Failed to send keys to tmux session: ${result.stderr || "Unknown error"}`);
  }
}
function capturePane(name, lines = 100) {
  checkTmuxInstalled();
  try {
    const output = (0, import_node_child_process.execSync)(`tmux capture-pane -t ${name} -p -S -${lines}`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"]
    });
    return output;
  } catch (error) {
    logger.error("Failed to capture tmux pane", { name, error: String(error) });
    return "";
  }
}
function listSessions() {
  checkTmuxInstalled();
  try {
    const output = (0, import_node_child_process.execSync)(
      'tmux list-sessions -F "#{session_name}|#{session_windows}|#{session_created}|#{session_attached}"',
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
    return output.trim().split("\n").filter((line) => line.startsWith(SESSION_PREFIX)).map((line) => {
      const [name, windows, created, attached] = line.split("|");
      return {
        name,
        windows: parseInt(windows, 10),
        created: new Date(parseInt(created, 10) * 1e3),
        attached: attached === "1"
      };
    });
  } catch {
    return [];
  }
}

// src/clawdcoder/core/claude-wrapper.ts
var activeSessions = /* @__PURE__ */ new Map();
async function startClaudeSession(sessionId, tmuxSession, workingDirectory, initialPrompt) {
  const session2 = {
    id: sessionId,
    tmuxSession,
    workingDirectory
  };
  activeSessions.set(sessionId, session2);
  let command = "claude";
  if (initialPrompt) {
    const escapedPrompt = initialPrompt.replace(/'/g, "'\\''");
    command = `claude -p '${escapedPrompt}'`;
  }
  sendKeys(tmuxSession, command);
  logger.info("Started Claude session", { sessionId, tmuxSession, workingDirectory });
  return session2;
}
function sendPrompt(sessionId, prompt) {
  const session2 = activeSessions.get(sessionId);
  if (!session2) {
    throw new Error(`Session ${sessionId} not found`);
  }
  sendKeys(session2.tmuxSession, prompt);
  logger.debug("Sent prompt to session", { sessionId, promptLength: prompt.length });
}
function registerSession(session2) {
  activeSessions.set(session2.id, session2);
}
function unregisterSession(sessionId) {
  activeSessions.delete(sessionId);
}

// src/clawdcoder/utils/queue.ts
var CommandQueue = class {
  queues = /* @__PURE__ */ new Map();
  processing = /* @__PURE__ */ new Set();
  async enqueue(sessionId, task) {
    return new Promise((resolve, reject) => {
      const queue = this.queues.get(sessionId) ?? [];
      queue.push({ task, resolve, reject });
      this.queues.set(sessionId, queue);
      this.processQueue(sessionId);
    });
  }
  async processQueue(sessionId) {
    if (this.processing.has(sessionId)) return;
    const queue = this.queues.get(sessionId);
    if (!queue || queue.length === 0) return;
    this.processing.add(sessionId);
    while (queue.length > 0) {
      const entry = queue.shift();
      try {
        const result = await entry.task();
        entry.resolve(result);
      } catch (error) {
        entry.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    this.processing.delete(sessionId);
    this.queues.delete(sessionId);
  }
  getQueueLength(sessionId) {
    return this.queues.get(sessionId)?.length ?? 0;
  }
};
var globalQueue = new CommandQueue();

// src/clawdcoder/core/session-manager.ts
var sessionRepo = new SessionRepository();
var startTime = Date.now();
var discordConnected = false;
var telegramConnected = false;
function setDiscordConnected(connected) {
  discordConnected = connected;
}
function setTelegramConnected(connected) {
  telegramConnected = connected;
}
async function createSession2(options) {
  const config = loadConfig();
  const activeCount = sessionRepo.countActive();
  if (activeCount >= (config.maxSessions ?? 5)) {
    throw new Error(`Maximum session limit reached (${config.maxSessions ?? 5})`);
  }
  const existing = sessionRepo.findByName(options.name);
  if (existing) {
    throw new Error(`Session with name "${options.name}" already exists`);
  }
  const sessionId = (0, import_node_crypto3.randomUUID)();
  const tmuxSession = createSession(sessionId, options.workingDirectory);
  const session2 = sessionRepo.create({
    name: options.name,
    tmuxSession,
    workingDirectory: options.workingDirectory,
    createdBy: options.user.id,
    projectId: options.projectId
  });
  await startClaudeSession(
    session2.id,
    tmuxSession,
    options.workingDirectory,
    options.initialPrompt
  );
  logger.info("Created session", { sessionId: session2.id, name: options.name });
  return session2;
}
async function sendPrompt2(sessionId, prompt) {
  const session2 = sessionRepo.findById(sessionId);
  if (!session2) {
    throw new Error(`Session ${sessionId} not found`);
  }
  if (session2.status !== "active") {
    throw new Error(`Session ${sessionId} is not active (status: ${session2.status})`);
  }
  const queuePosition = globalQueue.getQueueLength(sessionId);
  await globalQueue.enqueue(sessionId, async () => {
    sendPrompt(sessionId, prompt);
  });
  return queuePosition;
}
function getOutput(sessionId, lines = 100) {
  const session2 = sessionRepo.findById(sessionId);
  if (!session2) {
    throw new Error(`Session ${sessionId} not found`);
  }
  return capturePane(session2.tmuxSession, lines);
}
function killSession2(sessionId) {
  const session2 = sessionRepo.findById(sessionId);
  if (!session2) {
    throw new Error(`Session ${sessionId} not found`);
  }
  killSession(session2.tmuxSession);
  sessionRepo.updateStatus(sessionId, "terminated");
  unregisterSession(sessionId);
  logger.info("Killed session", { sessionId });
}
function listActiveSessions() {
  return sessionRepo.findActive();
}
function getSession(sessionId) {
  return sessionRepo.findById(sessionId);
}
function getSessionByName(name) {
  return sessionRepo.findByName(name);
}
function getUserSessions(userId) {
  return sessionRepo.findByUser(userId);
}
function getStatus() {
  const config = loadConfig();
  return {
    activeSessions: sessionRepo.countActive(),
    maxSessions: config.maxSessions ?? 5,
    uptime: Date.now() - startTime,
    discordConnected,
    telegramConnected
  };
}
function recoverSessions() {
  const activeSessions2 = sessionRepo.findActive();
  const tmuxSessions = listSessions();
  const tmuxNames = new Set(tmuxSessions.map((s) => s.name));
  for (const session2 of activeSessions2) {
    if (tmuxNames.has(session2.tmuxSession)) {
      registerSession({
        id: session2.id,
        tmuxSession: session2.tmuxSession,
        workingDirectory: session2.workingDirectory
      });
      logger.info("Recovered session", { sessionId: session2.id });
    } else {
      sessionRepo.updateStatus(session2.id, "terminated");
      logger.warn("Session no longer exists in tmux", { sessionId: session2.id });
    }
  }
}
function initialize() {
  startTime = Date.now();
  recoverSessions();
  logger.info("Session manager initialized");
}
function shutdown() {
  const activeSessions2 = listActiveSessions();
  for (const session2 of activeSessions2) {
    try {
      killSession(session2.tmuxSession);
      sessionRepo.updateStatus(session2.id, "terminated");
    } catch (error) {
      logger.error("Failed to kill session during shutdown", { sessionId: session2.id, error: String(error) });
    }
  }
  logger.info("Session manager shut down", { sessionsClosed: activeSessions2.length });
}

// src/clawdcoder/adapters/discord/index.ts
var import_discord2 = require("discord.js");

// src/clawdcoder/adapters/discord/commands.ts
var import_discord = require("discord.js");

// src/clawdcoder/utils/format.ts
var DISCORD_MAX_LENGTH = 2e3;
var TELEGRAM_MAX_LENGTH = 4096;
function truncateOutput(output, platform, preserveLines = 50) {
  const maxLength = platform === "discord" ? DISCORD_MAX_LENGTH : TELEGRAM_MAX_LENGTH;
  if (output.length <= maxLength) {
    return output;
  }
  const lines = output.split("\n");
  const lastLines = lines.slice(-preserveLines);
  const truncated = lastLines.join("\n");
  if (truncated.length > maxLength - 50) {
    return "... (truncated)\n" + truncated.slice(-(maxLength - 50));
  }
  return "... (truncated)\n" + truncated;
}
function wrapCodeBlock(content, language = "") {
  return "```" + language + "\n" + content + "\n```";
}
function formatSessionStatus(status) {
  const icons = {
    active: "\u{1F7E2}",
    paused: "\u{1F7E1}",
    terminated: "\u{1F534}"
  };
  return `${icons[status] ?? "\u26AA"} ${status}`;
}
function formatCost(costUsd) {
  return `$${costUsd.toFixed(4)}`;
}

// src/clawdcoder/adapters/discord/commands.ts
var userRepo = new UserRepository();
var slashCommands = [
  new import_discord.SlashCommandBuilder().setName("cc").setDescription("ClawdCoder - Claude Code session management").addSubcommandGroup(
    (group) => group.setName("session").setDescription("Session management").addSubcommand(
      (sub) => sub.setName("create").setDescription("Create a new Claude Code session").addStringOption((opt) => opt.setName("name").setDescription("Session name").setRequired(true)).addStringOption((opt) => opt.setName("directory").setDescription("Working directory").setRequired(true)).addStringOption((opt) => opt.setName("prompt").setDescription("Initial prompt"))
    ).addSubcommand(
      (sub) => sub.setName("list").setDescription("List active sessions")
    ).addSubcommand(
      (sub) => sub.setName("kill").setDescription("Terminate a session").addStringOption((opt) => opt.setName("name").setDescription("Session name or ID").setRequired(true))
    )
  ).addSubcommand(
    (sub) => sub.setName("prompt").setDescription("Send a prompt to active session").addStringOption((opt) => opt.setName("text").setDescription("Prompt text").setRequired(true)).addStringOption((opt) => opt.setName("session").setDescription("Session name (uses active if omitted)"))
  ).addSubcommand(
    (sub) => sub.setName("output").setDescription("Get session output").addStringOption((opt) => opt.setName("session").setDescription("Session name")).addIntegerOption((opt) => opt.setName("lines").setDescription("Number of lines").setMinValue(10).setMaxValue(500))
  ).addSubcommand(
    (sub) => sub.setName("status").setDescription("Show bot status")
  ).toJSON()
];
async function getOrCreateUser(interaction) {
  const discordId = interaction.user.id;
  const username = interaction.user.username;
  return userRepo.findOrCreate({ discordId, username });
}
async function handleInteraction(interaction) {
  const subcommandGroup = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand();
  const user = await getOrCreateUser(interaction);
  if (subcommandGroup === "session") {
    switch (subcommand) {
      case "create":
        await handleSessionCreate(interaction, user);
        break;
      case "list":
        await handleSessionList(interaction);
        break;
      case "kill":
        await handleSessionKill(interaction, user);
        break;
    }
  } else {
    switch (subcommand) {
      case "prompt":
        await handlePrompt(interaction, user);
        break;
      case "output":
        await handleOutput(interaction);
        break;
      case "status":
        await handleStatus(interaction);
        break;
    }
  }
}
async function handleSessionCreate(interaction, user) {
  await interaction.deferReply();
  const name = interaction.options.getString("name", true);
  const directory = interaction.options.getString("directory", true);
  const prompt = interaction.options.getString("prompt") ?? void 0;
  try {
    const session2 = await createSession2({
      name,
      workingDirectory: directory,
      user,
      initialPrompt: prompt
    });
    const embed = new import_discord.EmbedBuilder().setTitle("Session Created").setColor(65280).addFields(
      { name: "Name", value: session2.name, inline: true },
      { name: "ID", value: session2.id, inline: true },
      { name: "Directory", value: session2.workingDirectory }
    ).setTimestamp();
    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    await interaction.editReply(`Failed to create session: ${error instanceof Error ? error.message : String(error)}`);
  }
}
async function handleSessionList(interaction) {
  const sessions = listActiveSessions();
  if (sessions.length === 0) {
    await interaction.reply("No active sessions.");
    return;
  }
  const embed = new import_discord.EmbedBuilder().setTitle("Active Sessions").setColor(39423).setDescription(sessions.map(
    (s) => `**${s.name}** (${s.id.slice(0, 8)})
${formatSessionStatus(s.status)} | ${s.workingDirectory}
Cost: ${formatCost(s.totalCostUsd)}`
  ).join("\n\n")).setFooter({ text: `${sessions.length} session(s)` }).setTimestamp();
  await interaction.reply({ embeds: [embed] });
}
async function handleSessionKill(interaction, user) {
  const nameOrId = interaction.options.getString("name", true);
  try {
    let session2 = getSessionByName(nameOrId);
    if (!session2) {
      session2 = getSession(nameOrId);
    }
    if (!session2) {
      await interaction.reply({ content: `Session "${nameOrId}" not found.`, ephemeral: true });
      return;
    }
    if (session2.createdBy !== user.id && user.role !== "admin") {
      await interaction.reply({ content: "You do not have permission to kill this session.", ephemeral: true });
      return;
    }
    killSession2(session2.id);
    await interaction.reply(`Session "${session2.name}" terminated.`);
  } catch (error) {
    await interaction.reply({ content: `Failed to kill session: ${error instanceof Error ? error.message : String(error)}`, ephemeral: true });
  }
}
async function handlePrompt(interaction, user) {
  await interaction.deferReply();
  const text = interaction.options.getString("text", true);
  const sessionName = interaction.options.getString("session");
  try {
    let session2;
    if (sessionName) {
      session2 = getSessionByName(sessionName) ?? getSession(sessionName);
    } else {
      const userSessions = getUserSessions(user.id).filter((s) => s.status === "active");
      session2 = userSessions[0];
    }
    if (!session2) {
      await interaction.editReply("No active session found. Create one with `/cc session create`.");
      return;
    }
    const queuePosition = await sendPrompt2(session2.id, text);
    await interaction.editReply(`Prompt sent to **${session2.name}**. Queue position: ${queuePosition}`);
  } catch (error) {
    await interaction.editReply(`Failed to send prompt: ${error instanceof Error ? error.message : String(error)}`);
  }
}
async function handleOutput(interaction) {
  await interaction.deferReply();
  const sessionName = interaction.options.getString("session");
  const lines = interaction.options.getInteger("lines") ?? 50;
  try {
    const sessions = listActiveSessions();
    let session2;
    if (sessionName) {
      session2 = getSessionByName(sessionName) ?? getSession(sessionName);
    } else {
      session2 = sessions[0];
    }
    if (!session2) {
      await interaction.editReply("No session found.");
      return;
    }
    const output = getOutput(session2.id, lines);
    const truncated = truncateOutput(output, "discord");
    await interaction.editReply(wrapCodeBlock(truncated));
  } catch (error) {
    await interaction.editReply(`Failed to get output: ${error instanceof Error ? error.message : String(error)}`);
  }
}
async function handleStatus(interaction) {
  const status = getStatus();
  const uptimeSeconds = Math.floor(status.uptime / 1e3);
  const hours = Math.floor(uptimeSeconds / 3600);
  const minutes = Math.floor(uptimeSeconds % 3600 / 60);
  const embed = new import_discord.EmbedBuilder().setTitle("ClawdCoder Status").setColor(65280).addFields(
    { name: "Uptime", value: `${hours}h ${minutes}m`, inline: true },
    { name: "Sessions", value: `${status.activeSessions}/${status.maxSessions}`, inline: true },
    { name: "Discord", value: status.discordConnected ? "\u{1F7E2} Connected" : "\u{1F534} Disconnected", inline: true },
    { name: "Telegram", value: status.telegramConnected ? "\u{1F7E2} Connected" : "\u{1F534} Disconnected", inline: true }
  ).setTimestamp();
  await interaction.reply({ embeds: [embed] });
}

// src/clawdcoder/adapters/discord/index.ts
var client = null;
async function startDiscord() {
  const config = loadConfig();
  if (!config.discord?.enabled || !config.discord?.token) {
    logger.info("Discord not configured, skipping");
    return null;
  }
  const token = config.discord.token.startsWith("$") ? process.env[config.discord.token.slice(1)] : config.discord.token;
  if (!token) {
    logger.warn("Discord token not found");
    return null;
  }
  client = new import_discord2.Client({
    intents: [
      import_discord2.GatewayIntentBits.Guilds,
      import_discord2.GatewayIntentBits.GuildMessages
    ]
  });
  client.on(import_discord2.Events.ClientReady, async (readyClient) => {
    logger.info("Discord bot ready", { username: readyClient.user.tag });
    setDiscordConnected(true);
    try {
      const rest = new import_discord2.REST().setToken(token);
      await rest.put(
        import_discord2.Routes.applicationCommands(readyClient.user.id),
        { body: slashCommands }
      );
      logger.info("Registered Discord slash commands");
    } catch (error) {
      logger.error("Failed to register slash commands", { error: String(error) });
    }
  });
  client.on(import_discord2.Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      await handleInteraction(interaction);
    } catch (error) {
      logger.error("Error handling interaction", { error: String(error) });
      const reply = interaction.replied || interaction.deferred ? interaction.followUp.bind(interaction) : interaction.reply.bind(interaction);
      await reply({ content: "An error occurred while processing your command.", ephemeral: true });
    }
  });
  client.on(import_discord2.Events.Error, (error) => {
    logger.error("Discord client error", { error: String(error) });
  });
  client.on(import_discord2.Events.ShardDisconnect, () => {
    setDiscordConnected(false);
    logger.warn("Discord disconnected");
  });
  await client.login(token);
  return client;
}
function stopDiscord() {
  if (client) {
    client.destroy();
    client = null;
    setDiscordConnected(false);
    logger.info("Discord client stopped");
  }
}

// src/clawdcoder/adapters/telegram/index.ts
var import_grammy2 = require("grammy");

// src/clawdcoder/adapters/telegram/commands.ts
var import_grammy = require("grammy");
var userRepo2 = new UserRepository();
async function getOrCreateUser2(ctx) {
  const telegramId = ctx.from?.id.toString();
  const username = ctx.from?.username ?? ctx.from?.first_name ?? "Unknown";
  if (!telegramId) {
    throw new Error("No user ID in context");
  }
  return userRepo2.findOrCreate({ telegramId, username });
}
function registerCommands(bot2) {
  bot2.command("start", async (ctx) => {
    await ctx.reply(
      "\u{1F916} *ClawdCoder* - Claude Code Session Manager\n\nCommands:\n/session - Manage sessions\n/prompt <text> - Send prompt to active session\n/output - Get session output\n/status - Bot status\n\nUse /session to create your first Claude Code session!",
      { parse_mode: "Markdown" }
    );
  });
  bot2.command("session", async (ctx) => {
    const keyboard = new import_grammy.InlineKeyboard().text("\u{1F4DD} Create", "session:create").text("\u{1F4CB} List", "session:list").row().text("\u{1F50C} Switch", "session:switch").text("\u{1F6D1} Kill", "session:kill");
    await ctx.reply("Session Management:", { reply_markup: keyboard });
  });
  bot2.command("prompt", async (ctx) => {
    const text = ctx.match;
    if (!text) {
      await ctx.reply("Usage: /prompt <your prompt text>");
      return;
    }
    try {
      const user = await getOrCreateUser2(ctx);
      let sessionId = ctx.session.activeSessionId;
      if (!sessionId) {
        const userSessions = getUserSessions(user.id).filter((s) => s.status === "active");
        if (userSessions.length === 0) {
          await ctx.reply("No active session. Use /session to create one.");
          return;
        }
        sessionId = userSessions[0].id;
        ctx.session.activeSessionId = sessionId;
      }
      const session2 = getSession(sessionId);
      if (!session2 || session2.status !== "active") {
        await ctx.reply("Session no longer active. Use /session to create a new one.");
        ctx.session.activeSessionId = void 0;
        return;
      }
      const queuePos = await sendPrompt2(sessionId, text);
      await ctx.reply(`Sent to *${session2.name}* (queue: ${queuePos})`, { parse_mode: "Markdown" });
    } catch (error) {
      await ctx.reply(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  bot2.command("output", async (ctx) => {
    try {
      const user = await getOrCreateUser2(ctx);
      let sessionId = ctx.session.activeSessionId;
      if (!sessionId) {
        const userSessions = getUserSessions(user.id).filter((s) => s.status === "active");
        if (userSessions.length === 0) {
          await ctx.reply("No active session.");
          return;
        }
        sessionId = userSessions[0].id;
      }
      const session2 = getSession(sessionId);
      if (!session2) {
        await ctx.reply("Session not found.");
        return;
      }
      const output = getOutput(sessionId, 50);
      const truncated = truncateOutput(output, "telegram");
      await ctx.reply(`*${session2.name}* output:
${wrapCodeBlock(truncated)}`, { parse_mode: "Markdown" });
    } catch (error) {
      await ctx.reply(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  bot2.command("status", async (ctx) => {
    const status = getStatus();
    const uptimeSeconds = Math.floor(status.uptime / 1e3);
    const hours = Math.floor(uptimeSeconds / 3600);
    const minutes = Math.floor(uptimeSeconds % 3600 / 60);
    const discordIcon = status.discordConnected ? "\u{1F7E2}" : "\u{1F534}";
    const telegramIcon = status.telegramConnected ? "\u{1F7E2}" : "\u{1F534}";
    await ctx.reply(
      `\u{1F916} *ClawdCoder Status*

\u23F1 Uptime: ${hours}h ${minutes}m
\u{1F4CA} Sessions: ${status.activeSessions}/${status.maxSessions}

${discordIcon} Discord
${telegramIcon} Telegram`,
      { parse_mode: "Markdown" }
    );
  });
  bot2.callbackQuery("session:list", async (ctx) => {
    await ctx.answerCallbackQuery();
    const sessions = listActiveSessions();
    if (sessions.length === 0) {
      await ctx.editMessageText('No active sessions.\n\nUse "Create" to start a new session.');
      return;
    }
    const text = sessions.map(
      (s) => `*${s.name}* (${s.id.slice(0, 8)})
${formatSessionStatus(s.status)} | ${formatCost(s.totalCostUsd)}`
    ).join("\n\n");
    await ctx.editMessageText(`Active Sessions:

${text}`, { parse_mode: "Markdown" });
  });
  bot2.callbackQuery("session:create", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      "To create a session, use:\n\n/create <name> <directory>\n\nExample:\n/create myproject /home/user/myproject"
    );
  });
  bot2.callbackQuery("session:switch", async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const user = await getOrCreateUser2(ctx);
      const sessions = getUserSessions(user.id).filter((s) => s.status === "active");
      if (sessions.length === 0) {
        await ctx.editMessageText("No sessions to switch to.");
        return;
      }
      const keyboard = new import_grammy.InlineKeyboard();
      for (const session2 of sessions) {
        keyboard.text(session2.name, `switch:${session2.id}`).row();
      }
      await ctx.editMessageText("Select session:", { reply_markup: keyboard });
    } catch (error) {
      await ctx.editMessageText(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  bot2.callbackQuery("session:kill", async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const user = await getOrCreateUser2(ctx);
      const sessions = getUserSessions(user.id).filter((s) => s.status === "active");
      if (sessions.length === 0) {
        await ctx.editMessageText("No sessions to kill.");
        return;
      }
      const keyboard = new import_grammy.InlineKeyboard();
      for (const session2 of sessions) {
        keyboard.text(`\u{1F6D1} ${session2.name}`, `kill:${session2.id}`).row();
      }
      await ctx.editMessageText("Select session to terminate:", { reply_markup: keyboard });
    } catch (error) {
      await ctx.editMessageText(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  bot2.callbackQuery(/^switch:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const sessionId = ctx.match[1];
    const session2 = getSession(sessionId);
    if (!session2) {
      await ctx.editMessageText("Session not found.");
      return;
    }
    ctx.session.activeSessionId = sessionId;
    await ctx.editMessageText(`Switched to *${session2.name}*`, { parse_mode: "Markdown" });
  });
  bot2.callbackQuery(/^kill:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const sessionId = ctx.match[1];
    try {
      const session2 = getSession(sessionId);
      if (!session2) {
        await ctx.editMessageText("Session not found.");
        return;
      }
      killSession2(sessionId);
      if (ctx.session.activeSessionId === sessionId) {
        ctx.session.activeSessionId = void 0;
      }
      await ctx.editMessageText(`Session *${session2.name}* terminated.`, { parse_mode: "Markdown" });
    } catch (error) {
      await ctx.editMessageText(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  bot2.command("create", async (ctx) => {
    const args = ctx.match?.split(" ");
    if (!args || args.length < 2) {
      await ctx.reply("Usage: /create <name> <directory> [prompt]");
      return;
    }
    const [name, directory, ...promptParts] = args;
    const initialPrompt = promptParts.length > 0 ? promptParts.join(" ") : void 0;
    try {
      const user = await getOrCreateUser2(ctx);
      const session2 = await createSession2({
        name,
        workingDirectory: directory,
        user,
        initialPrompt
      });
      ctx.session.activeSessionId = session2.id;
      await ctx.reply(
        `\u2705 Session *${session2.name}* created!

\u{1F4C1} Directory: ${session2.workingDirectory}
\u{1F194} ID: \`${session2.id}\`

Use /prompt to send commands.`,
        { parse_mode: "Markdown" }
      );
    } catch (error) {
      await ctx.reply(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

// src/clawdcoder/adapters/telegram/index.ts
var bot = null;
async function startTelegram() {
  const config = loadConfig();
  if (!config.telegram?.enabled || !config.telegram?.token) {
    logger.info("Telegram not configured, skipping");
    return null;
  }
  const token = config.telegram.token.startsWith("$") ? process.env[config.telegram.token.slice(1)] : config.telegram.token;
  if (!token) {
    logger.warn("Telegram token not found");
    return null;
  }
  bot = new import_grammy2.Bot(token);
  bot.use((0, import_grammy2.session)({
    initial: () => ({})
  }));
  registerCommands(bot);
  bot.catch((err) => {
    logger.error("Telegram bot error", { error: String(err.error) });
  });
  bot.start({
    onStart: () => {
      logger.info("Telegram bot started");
      setTelegramConnected(true);
    }
  });
  return bot;
}
function stopTelegram() {
  if (bot) {
    bot.stop();
    bot = null;
    setTelegramConnected(false);
    logger.info("Telegram bot stopped");
  }
}

// src/clawdcoder/ipc/server.ts
var import_node_net = require("node:net");
var import_node_fs4 = require("node:fs");
var server = null;
var userRepo3 = new UserRepository();
function getSystemUser() {
  return userRepo3.findOrCreate({
    username: "system",
    discordId: void 0,
    telegramId: void 0
  });
}
async function handleRequest(request) {
  const { method, params, id } = request;
  try {
    let result;
    switch (method) {
      case "session.create": {
        const user = getSystemUser();
        const session2 = await createSession2({
          name: params?.name,
          workingDirectory: params?.projectDir,
          user,
          initialPrompt: params?.prompt
        });
        result = { sessionId: session2.id, tmuxSession: session2.tmuxSession };
        break;
      }
      case "session.list": {
        const sessions = listActiveSessions();
        result = sessions.map((s) => ({
          id: s.id,
          name: s.name,
          status: s.status,
          workingDirectory: s.workingDirectory,
          createdAt: s.createdAt.toISOString()
        }));
        break;
      }
      case "session.send": {
        const sessionId = params?.sessionId;
        const prompt = params?.prompt;
        let session2 = getSessionByName(sessionId);
        if (!session2) {
          session2 = getSession(sessionId);
        }
        if (!session2) {
          throw new Error(`Session "${sessionId}" not found`);
        }
        const queuePosition = await sendPrompt2(session2.id, prompt);
        result = { queuePosition };
        break;
      }
      case "session.output": {
        const sessionId = params?.sessionId;
        const lines = params?.lines ?? 100;
        let session2 = getSessionByName(sessionId);
        if (!session2) {
          session2 = getSession(sessionId);
        }
        if (!session2) {
          throw new Error(`Session "${sessionId}" not found`);
        }
        const output = getOutput(session2.id, lines);
        result = { output };
        break;
      }
      case "session.kill": {
        const sessionId = params?.sessionId;
        let session2 = getSessionByName(sessionId);
        if (!session2) {
          session2 = getSession(sessionId);
        }
        if (!session2) {
          throw new Error(`Session "${sessionId}" not found`);
        }
        killSession2(session2.id);
        result = { success: true };
        break;
      }
      case "status": {
        result = getStatus();
        break;
      }
      default:
        throw new Error(`Unknown method: ${method}`);
    }
    return { jsonrpc: "2.0", result, id };
  } catch (error) {
    return {
      jsonrpc: "2.0",
      error: {
        code: -32e3,
        message: error instanceof Error ? error.message : String(error)
      },
      id
    };
  }
}
function handleConnection(socket) {
  let buffer = "";
  socket.on("data", async (data) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const request = JSON.parse(line);
        const response = await handleRequest(request);
        socket.write(JSON.stringify(response) + "\n");
      } catch (error) {
        const errorResponse = {
          jsonrpc: "2.0",
          error: {
            code: -32700,
            message: "Parse error"
          },
          id: null
        };
        socket.write(JSON.stringify(errorResponse) + "\n");
      }
    }
  });
  socket.on("error", (error) => {
    logger.error("IPC socket error", { error: String(error) });
  });
}
function startIpcServer() {
  const socketPath = getSocketPath();
  if ((0, import_node_fs4.existsSync)(socketPath)) {
    (0, import_node_fs4.unlinkSync)(socketPath);
  }
  server = (0, import_node_net.createServer)(handleConnection);
  server.on("error", (error) => {
    logger.error("IPC server error", { error: String(error) });
  });
  server.listen(socketPath, () => {
    (0, import_node_fs4.chmodSync)(socketPath, 384);
    logger.info("IPC server started", { socketPath });
  });
}
function stopIpcServer() {
  if (server) {
    server.close();
    server = null;
    const socketPath = getSocketPath();
    if ((0, import_node_fs4.existsSync)(socketPath)) {
      (0, import_node_fs4.unlinkSync)(socketPath);
    }
    logger.info("IPC server stopped");
  }
}

// src/clawdcoder/index.ts
var import_node_fs5 = require("node:fs");
async function main() {
  logger.info("ClawdCoder starting...");
  const config = loadConfig();
  initDatabase(config);
  logger.info("Database initialized");
  initialize();
  startIpcServer();
  const [discord, telegram] = await Promise.all([
    startDiscord(),
    startTelegram()
  ]);
  if (!discord && !telegram) {
    logger.error("No platform adapters started. Configure Discord or Telegram tokens.");
    logger.info("Set CLAWDCODER_DISCORD_TOKEN or CLAWDCODER_TELEGRAM_TOKEN environment variables.");
    logger.info("Or configure via: omc omc-setup");
    process.exit(1);
  }
  logger.info("ClawdCoder started", {
    discord: !!discord,
    telegram: !!telegram
  });
  const shutdown2 = async (signal) => {
    logger.info(`Received ${signal}, shutting down...`);
    stopDiscord();
    stopTelegram();
    stopIpcServer();
    shutdown();
    closeDatabase();
    logger.close();
    const pidPath = getPidPath();
    if ((0, import_node_fs5.existsSync)(pidPath)) {
      (0, import_node_fs5.unlinkSync)(pidPath);
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown2("SIGTERM"));
  process.on("SIGINT", () => shutdown2("SIGINT"));
  process.stdin.resume();
}
main().catch((error) => {
  logger.error("Fatal error", { error: String(error) });
  process.exit(1);
});
