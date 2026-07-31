var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/utils/config-dir.ts
import { join, normalize, parse, sep } from "path";
import { homedir } from "os";
var init_config_dir = __esm({
  "src/utils/config-dir.ts"() {
    "use strict";
  }
});

// src/utils/encode-project-path.ts
var init_encode_project_path = __esm({
  "src/utils/encode-project-path.ts"() {
    "use strict";
  }
});

// src/lib/worktree-paths.ts
import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, writeFileSync, unlinkSync } from "fs";
import { homedir as homedir2, tmpdir } from "os";
import { resolve, normalize as normalize2, relative, sep as sep2, join as join2, isAbsolute, basename, dirname } from "path";
function findWorkspaceRoot(startDir) {
  if (process.env.OMC_DISABLE_MULTIREPO === "1") return null;
  const effectiveStart = startDir || process.cwd();
  let current;
  try {
    current = resolve(effectiveStart);
  } catch {
    return null;
  }
  if (workspaceCacheMap.has(current)) {
    const cached = workspaceCacheMap.get(current) ?? null;
    workspaceCacheMap.delete(current);
    workspaceCacheMap.set(current, cached);
    return cached;
  }
  const home = (() => {
    try {
      return resolve(homedir2());
    } catch {
      return null;
    }
  })();
  let cursor = current;
  let result = null;
  while (true) {
    if (home && cursor === home) break;
    if (existsSync(join2(cursor, WORKSPACE_MARKER))) {
      result = cursor;
      break;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (workspaceCacheMap.size >= MAX_WORKTREE_CACHE_SIZE) {
    const oldest = workspaceCacheMap.keys().next().value;
    if (oldest !== void 0) workspaceCacheMap.delete(oldest);
  }
  workspaceCacheMap.set(current, result);
  return result;
}
function readWorkspaceMarkerConfig(workspaceRoot) {
  try {
    const raw = readFileSync(join2(workspaceRoot, WORKSPACE_MARKER), "utf-8").trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}
function isDefinitiveNonGitError(error) {
  if (!error || typeof error !== "object") return false;
  const { status, stderr } = error;
  if (status !== 128) return false;
  const output2 = typeof stderr === "string" ? stderr : Buffer.isBuffer(stderr) ? stderr.toString() : "";
  return /not a git repository/i.test(output2);
}
function resolveSuperprojectRoot(cwd) {
  const cacheKey = resolve(cwd);
  if (superprojectCacheMap.has(cacheKey)) {
    const cached = superprojectCacheMap.get(cacheKey) ?? null;
    superprojectCacheMap.delete(cacheKey);
    superprojectCacheMap.set(cacheKey, cached);
    return cached;
  }
  let anchor = null;
  let probeCwd = cacheKey;
  let completed = false;
  for (let depth = 0; depth < 32; depth++) {
    let superRoot;
    try {
      superRoot = execFileSync("git", ["rev-parse", "--show-superproject-working-tree"], {
        cwd: probeCwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        timeout: 5e3
      }).trim();
    } catch (error) {
      completed = depth === 0 && isDefinitiveNonGitError(error);
      break;
    }
    if (!superRoot) {
      completed = true;
      break;
    }
    anchor = superRoot;
    probeCwd = superRoot;
  }
  if (completed) {
    if (superprojectCacheMap.size >= MAX_WORKTREE_CACHE_SIZE) {
      const oldest = superprojectCacheMap.keys().next().value;
      if (oldest !== void 0) superprojectCacheMap.delete(oldest);
    }
    superprojectCacheMap.set(cacheKey, anchor);
  }
  return anchor;
}
function resolveStateAnchorRoot(worktreeRoot) {
  if (worktreeRoot) return resolveSuperprojectRoot(worktreeRoot) || worktreeRoot;
  return getWorktreeRoot() || process.cwd();
}
function getGitTopLevel(cwd) {
  const effectiveCwd = cwd || process.cwd();
  if (toplevelCacheMap.has(effectiveCwd)) {
    const root = toplevelCacheMap.get(effectiveCwd);
    toplevelCacheMap.delete(effectiveCwd);
    toplevelCacheMap.set(effectiveCwd, root);
    return root || null;
  }
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: effectiveCwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      timeout: 5e3
    }).trim();
    if (toplevelCacheMap.size >= MAX_WORKTREE_CACHE_SIZE) {
      const oldest = toplevelCacheMap.keys().next().value;
      if (oldest !== void 0) toplevelCacheMap.delete(oldest);
    }
    toplevelCacheMap.set(effectiveCwd, root);
    return root;
  } catch {
    return null;
  }
}
function getWorktreeRoot(cwd) {
  const effectiveCwd = cwd || process.cwd();
  if (worktreeCacheMap.has(effectiveCwd)) {
    const root2 = worktreeCacheMap.get(effectiveCwd);
    worktreeCacheMap.delete(effectiveCwd);
    worktreeCacheMap.set(effectiveCwd, root2);
    return root2 || null;
  }
  const root = resolveSuperprojectRoot(effectiveCwd) || getGitTopLevel(effectiveCwd);
  if (!root) {
    return null;
  }
  if (worktreeCacheMap.size >= MAX_WORKTREE_CACHE_SIZE) {
    const oldest = worktreeCacheMap.keys().next().value;
    if (oldest !== void 0) {
      worktreeCacheMap.delete(oldest);
    }
  }
  worktreeCacheMap.set(effectiveCwd, root);
  return root;
}
function getProjectIdentifier(worktreeRoot) {
  const root = worktreeRoot || getGitTopLevel() || process.cwd();
  const workspaceRoot = findWorkspaceRoot(root);
  if (workspaceRoot) {
    const cfg = readWorkspaceMarkerConfig(workspaceRoot);
    if (cfg.id && typeof cfg.id === "string" && cfg.id.trim()) {
      const safeId = cfg.id.trim().replace(/[^a-zA-Z0-9_-]/g, "_");
      const hash3 = createHash("sha256").update(safeId).digest("hex").slice(0, 16);
      return `${safeId}-${hash3}`;
    }
    const hash2 = createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
    const dirName2 = basename(workspaceRoot).replace(/[^a-zA-Z0-9_-]/g, "_");
    return `${dirName2}-${hash2}`;
  }
  let source;
  try {
    const remoteUrl = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: root,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    }).trim();
    source = remoteUrl || root;
  } catch {
    source = root;
  }
  let primaryRoot = root;
  try {
    const commonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: root,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      timeout: 5e3
    }).trim();
    const isGitDir = basename(commonDir) === ".git";
    const isSubmodule = commonDir.includes(`${sep2}.git${sep2}modules`);
    if (isGitDir && !isSubmodule) {
      const resolved = dirname(commonDir);
      if (resolved && resolved !== root) {
        primaryRoot = resolved;
      }
    }
  } catch {
  }
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const dirName = basename(primaryRoot).replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${dirName}-${hash}`;
}
function getOmcRoot(worktreeRoot) {
  const customDir = process.env.OMC_STATE_DIR;
  if (customDir) {
    const root2 = worktreeRoot || getGitTopLevel() || process.cwd();
    const projectId = getProjectIdentifier(root2);
    const centralizedPath = join2(customDir, projectId);
    const legacyPath = join2(root2, OmcPaths.ROOT);
    const warningKey = `${legacyPath}:${centralizedPath}`;
    if (!dualDirWarnings.has(warningKey) && existsSync(legacyPath) && existsSync(centralizedPath)) {
      dualDirWarnings.add(warningKey);
      console.warn(
        `[omc] Both legacy state dir (${legacyPath}) and centralized state dir (${centralizedPath}) exist. Using centralized dir. Consider migrating data from the legacy dir and removing it.`
      );
    }
    return centralizedPath;
  }
  const workspaceAnchor = findWorkspaceRoot(worktreeRoot);
  if (workspaceAnchor) {
    return join2(workspaceAnchor, OmcPaths.ROOT);
  }
  const root = resolveStateAnchorRoot(worktreeRoot);
  return join2(root, OmcPaths.ROOT);
}
var WORKSPACE_MARKER, OmcPaths, MAX_WORKTREE_CACHE_SIZE, worktreeCacheMap, toplevelCacheMap, superprojectCacheMap, workspaceCacheMap, dualDirWarnings;
var init_worktree_paths = __esm({
  "src/lib/worktree-paths.ts"() {
    "use strict";
    init_config_dir();
    init_encode_project_path();
    WORKSPACE_MARKER = ".omc-workspace";
    OmcPaths = {
      ROOT: ".omc",
      STATE: ".omc/state",
      SESSIONS: ".omc/state/sessions",
      PLANS: ".omc/plans",
      RESEARCH: ".omc/research",
      NOTEPAD: ".omc/notepad.md",
      PROJECT_MEMORY: ".omc/project-memory.json",
      DRAFTS: ".omc/drafts",
      NOTEPADS: ".omc/notepads",
      LOGS: ".omc/logs",
      SCIENTIST: ".omc/scientist",
      AUTOPILOT: ".omc/autopilot",
      SKILLS: ".omc/skills",
      SHARED_MEMORY: ".omc/state/shared-memory",
      DEEPINIT_MANIFEST: ".omc/deepinit-manifest.json"
    };
    MAX_WORKTREE_CACHE_SIZE = 8;
    worktreeCacheMap = /* @__PURE__ */ new Map();
    toplevelCacheMap = /* @__PURE__ */ new Map();
    superprojectCacheMap = /* @__PURE__ */ new Map();
    workspaceCacheMap = /* @__PURE__ */ new Map();
    dualDirWarnings = /* @__PURE__ */ new Set();
  }
});

// src/team/contracts.ts
function isTerminalTeamTaskStatus(status) {
  return TEAM_TERMINAL_TASK_STATUSES.has(status);
}
function canTransitionTeamTaskStatus(from, to) {
  return TEAM_TASK_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}
var TEAM_NAME_SAFE_PATTERN, WORKER_NAME_SAFE_PATTERN, TASK_ID_SAFE_PATTERN, TEAM_TASK_STATUSES, TEAM_TERMINAL_TASK_STATUSES, TEAM_TASK_STATUS_TRANSITIONS, TEAM_EVENT_TYPES, TEAM_TASK_APPROVAL_STATUSES;
var init_contracts = __esm({
  "src/team/contracts.ts"() {
    "use strict";
    TEAM_NAME_SAFE_PATTERN = /^[a-z0-9][a-z0-9-]{0,29}$/;
    WORKER_NAME_SAFE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
    TASK_ID_SAFE_PATTERN = /^\d{1,20}$/;
    TEAM_TASK_STATUSES = ["pending", "blocked", "in_progress", "completed", "failed"];
    TEAM_TERMINAL_TASK_STATUSES = /* @__PURE__ */ new Set(["completed", "failed"]);
    TEAM_TASK_STATUS_TRANSITIONS = {
      pending: [],
      blocked: [],
      in_progress: ["completed", "failed"],
      completed: [],
      failed: []
    };
    TEAM_EVENT_TYPES = [
      "task_completed",
      "task_failed",
      "worker_idle",
      "worker_stopped",
      "message_received",
      "shutdown_ack",
      "shutdown_gate",
      "shutdown_gate_forced",
      "approval_decision",
      "team_leader_nudge"
    ];
    TEAM_TASK_APPROVAL_STATUSES = ["pending", "approved", "rejected"];
  }
});

// src/team/state-paths.ts
import { createHash as createHash2 } from "node:crypto";
import { isAbsolute as isAbsolute2, join as join3 } from "path";
function normalizeTaskFileStem(taskId) {
  const trimmed = String(taskId).trim().replace(/\.json$/i, "");
  if (/^task-\d+$/.test(trimmed)) return trimmed;
  if (/^\d+$/.test(trimmed)) return `task-${trimmed}`;
  return trimmed;
}
function absPath(cwd, relativePath) {
  return isAbsolute2(relativePath) ? relativePath : join3(cwd, relativePath);
}
function teamStateRoot(cwd, teamName) {
  return join3(cwd, TeamPaths.root(teamName));
}
var TeamPaths;
var init_state_paths = __esm({
  "src/team/state-paths.ts"() {
    "use strict";
    TeamPaths = {
      root: (teamName) => `.omc/state/team/${teamName}`,
      config: (teamName) => `.omc/state/team/${teamName}/config.json`,
      shutdown: (teamName) => `.omc/state/team/${teamName}/shutdown.json`,
      tasks: (teamName) => `.omc/state/team/${teamName}/tasks`,
      taskFile: (teamName, taskId) => `.omc/state/team/${teamName}/tasks/${normalizeTaskFileStem(taskId)}.json`,
      workers: (teamName) => `.omc/state/team/${teamName}/workers`,
      workerDir: (teamName, workerName) => `.omc/state/team/${teamName}/workers/${workerName}`,
      heartbeat: (teamName, workerName) => `.omc/state/team/${teamName}/workers/${workerName}/heartbeat.json`,
      inbox: (teamName, workerName) => `.omc/state/team/${teamName}/workers/${workerName}/inbox.md`,
      outbox: (teamName, workerName) => `.omc/state/team/${teamName}/workers/${workerName}/outbox.jsonl`,
      ready: (teamName, workerName) => `.omc/state/team/${teamName}/workers/${workerName}/.ready`,
      overlay: (teamName, workerName) => `.omc/state/team/${teamName}/workers/${workerName}/AGENTS.md`,
      shutdownAck: (teamName, workerName) => `.omc/state/team/${teamName}/workers/${workerName}/shutdown-ack.json`,
      mailbox: (teamName, workerName) => `.omc/state/team/${teamName}/mailbox/${workerName}.json`,
      mailboxLockDir: (teamName, workerName) => `.omc/state/team/${teamName}/mailbox/.lock-${workerName}`,
      dispatchRequests: (teamName) => `.omc/state/team/${teamName}/dispatch/requests.json`,
      dispatchLockDir: (teamName) => `.omc/state/team/${teamName}/dispatch/.lock`,
      mailboxNotificationLock: (teamName, requestId) => `.omc/state/team/${teamName}/dispatch/.mailbox-notification-${createHash2("sha256").update(requestId).digest("hex")}.lock`,
      workerStatus: (teamName, workerName) => `.omc/state/team/${teamName}/workers/${workerName}/status.json`,
      workerIdleNotify: (teamName) => `.omc/state/team/${teamName}/worker-idle-notify.json`,
      workerPrevNotifyState: (teamName, workerName) => `.omc/state/team/${teamName}/workers/${workerName}/prev-notify-state.json`,
      events: (teamName) => `.omc/state/team/${teamName}/events.jsonl`,
      approval: (teamName, taskId) => `.omc/state/team/${teamName}/approvals/${taskId}.json`,
      manifest: (teamName) => `.omc/state/team/${teamName}/manifest.json`,
      monitorSnapshot: (teamName) => `.omc/state/team/${teamName}/monitor-snapshot.json`,
      summarySnapshot: (teamName) => `.omc/state/team/${teamName}/summary-snapshot.json`,
      phaseState: (teamName) => `.omc/state/team/${teamName}/phase-state.json`,
      scalingLock: (teamName) => `.omc/state/team/${teamName}/.scaling-lock`,
      configMutationLock: (teamName) => `.omc/state/team/${teamName}/.config-mutation.lock`,
      workerIdentity: (teamName, workerName) => `.omc/state/team/${teamName}/workers/${workerName}/identity.json`,
      workerAgentsMd: (teamName) => `.omc/state/team/${teamName}/worker-agents.md`,
      shutdownRequest: (teamName, workerName) => `.omc/state/team/${teamName}/workers/${workerName}/shutdown-request.json`,
      checkpoints: (teamName, taskId, claimTokenHash) => `.omc/state/team/${teamName}/checkpoints/${normalizeTaskFileStem(taskId)}/${claimTokenHash}`,
      checkpoint: (teamName, taskId, claimTokenHash, sequence) => `.omc/state/team/${teamName}/checkpoints/${normalizeTaskFileStem(taskId)}/${claimTokenHash}/${sequence}.json`,
      checkpointLatest: (teamName, taskId, claimTokenHash) => `.omc/state/team/${teamName}/checkpoints/${normalizeTaskFileStem(taskId)}/${claimTokenHash}/latest.json`,
      taskRecoverySidecar: (teamName, recoveryId, taskId) => {
        if (recoveryId.length === 0 || recoveryId.length > 128 || recoveryId === "." || recoveryId === ".." || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(recoveryId)) {
          throw new Error("invalid_recovery_request_id");
        }
        const taskStem = normalizeTaskFileStem(taskId);
        if (!/^task-\d+$/.test(taskStem)) throw new Error("invalid_task_id");
        return `.omc/state/team/${teamName}/recovery/task-sidecars/${recoveryId}/${taskStem}.json`;
      },
      taskRecoveryReservation: (teamName, taskId) => `.omc/state/team/${teamName}/recovery/reservations/${normalizeTaskFileStem(taskId)}.json`,
      ownerEpochs: (teamName) => `.omc/state/team/${teamName}/recovery/owner-epochs`,
      ownerEpoch: (teamName, epoch) => `.omc/state/team/${teamName}/recovery/owner-epochs/${epoch}.json`,
      recoveryOwnerBootstrapCandidate: (teamName, expectedEpoch, nonce) => {
        if (nonce.length === 0 || nonce.length > 128 || nonce === "." || nonce === ".." || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(nonce)) throw new Error("invalid_recovery_owner_bootstrap_nonce");
        return `.omc/state/team/${teamName}/recovery/owner-bootstrap/${expectedEpoch}/${nonce}.json`;
      },
      recoveryIntents: (teamName) => `.omc/state/team/${teamName}/recovery/intents`,
      recoveryIntent: (teamName, recoveryId) => `.omc/state/team/${teamName}/recovery/intents/${recoveryId}.json`,
      recoveryAttempts: (teamName) => `.omc/state/team/${teamName}/recovery/attempts`,
      recoveryAttempt: (teamName, recoveryId) => `.omc/state/team/${teamName}/recovery/attempts/${recoveryId}.json`,
      recoveryActivation: (teamName, recoveryId, paneAttemptId) => `.omc/state/team/${teamName}/recovery/activation/${recoveryId}/${paneAttemptId}`,
      recoveryReady: (teamName, recoveryId, paneAttemptId) => `.omc/state/team/${teamName}/recovery/activation/${recoveryId}/${paneAttemptId}/ready.json`,
      recoveryActivate: (teamName, recoveryId, paneAttemptId) => `.omc/state/team/${teamName}/recovery/activation/${recoveryId}/${paneAttemptId}/activate.json`,
      recoveryRun: (teamName, recoveryId, paneAttemptId) => `.omc/state/team/${teamName}/recovery/activation/${recoveryId}/${paneAttemptId}/run.json`,
      recoveryRequestsRoot: () => ".omc/state/team-recovery/by-request",
      recoveryAdmissionLock: (payloadHash) => `.omc/state/team-recovery/admission-locks/${payloadHash}.lock`,
      recoveryLifecycleLock: (workspaceHash2, teamName) => `.omc/state/team-recovery/lifecycle-locks/${workspaceHash2}/${teamName}.lock`,
      recoveryRequestPending: (requestId) => `.omc/state/team-recovery/by-request/${requestId}.pending.json`,
      recoveryRequestResult: (requestId) => `.omc/state/team-recovery/by-request/${requestId}.result.json`,
      recoveryResultByTeam: (workspaceHash2, teamName, recoveryId) => `.omc/state/team-recovery/by-team/${workspaceHash2}/${teamName}/${recoveryId}.json`,
      recoveryFinalIndexLock: (workspaceHash2, teamName, recoveryId) => `.omc/state/team-recovery/index-locks/${workspaceHash2}/${teamName}/${recoveryId}.lock`,
      scalingRollbackFailure: (teamName, recordedAt) => `.omc/state/team/${teamName}/scaling-rollback/${recordedAt}.json`,
      recoveryPaneRollbackFailure: (teamName, recoveryId, paneAttemptId, recordedAt) => `.omc/state/team/${teamName}/recovery/rollback-failures/${recoveryId}/${paneAttemptId}-${recordedAt}.json`,
      recoveryAuditIndex: () => ".omc/state/team-recovery/audit.jsonl"
    };
  }
});

// src/team/governance.ts
var governance_exports = {};
__export(governance_exports, {
  DEFAULT_TEAM_GOVERNANCE: () => DEFAULT_TEAM_GOVERNANCE,
  DEFAULT_TEAM_TRANSPORT_POLICY: () => DEFAULT_TEAM_TRANSPORT_POLICY,
  getConfigGovernance: () => getConfigGovernance,
  isLinkedRalphProfile: () => isLinkedRalphProfile,
  normalizeTeamGovernance: () => normalizeTeamGovernance,
  normalizeTeamManifest: () => normalizeTeamManifest,
  normalizeTeamTransportPolicy: () => normalizeTeamTransportPolicy,
  resolveLifecycleProfile: () => resolveLifecycleProfile
});
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
function resolveLifecycleProfile(config, manifest) {
  if (manifest?.lifecycle_profile) return manifest.lifecycle_profile;
  if (config?.lifecycle_profile) return config.lifecycle_profile;
  return "default";
}
function isLinkedRalphProfile(config, manifest) {
  return resolveLifecycleProfile(config, manifest) === "linked_ralph";
}
var DEFAULT_TEAM_TRANSPORT_POLICY, DEFAULT_TEAM_GOVERNANCE;
var init_governance = __esm({
  "src/team/governance.ts"() {
    "use strict";
    DEFAULT_TEAM_TRANSPORT_POLICY = {
      display_mode: "split_pane",
      worker_launch_mode: "interactive",
      dispatch_mode: "hook_preferred_with_fallback",
      dispatch_ack_timeout_ms: 15e3
    };
    DEFAULT_TEAM_GOVERNANCE = {
      delegation_only: false,
      plan_approval_required: false,
      nested_teams_allowed: false,
      one_team_per_leader_session: true,
      cleanup_requires_all_workers_inactive: true
    };
  }
});

// src/shared/types.ts
var CANONICAL_TEAM_ROLES, CURSOR_EXECUTOR_TEAM_ROLES, KNOWN_AGENT_NAMES;
var init_types = __esm({
  "src/shared/types.ts"() {
    "use strict";
    CANONICAL_TEAM_ROLES = [
      "orchestrator",
      "planner",
      "analyst",
      "architect",
      "executor",
      "debugger",
      "critic",
      "code-reviewer",
      "security-reviewer",
      "test-engineer",
      "designer",
      "writer",
      "code-simplifier",
      "explore",
      "document-specialist"
    ];
    CURSOR_EXECUTOR_TEAM_ROLES = ["executor"];
    KNOWN_AGENT_NAMES = [
      "omc",
      "explore",
      "analyst",
      "planner",
      "architect",
      "debugger",
      "executor",
      "verifier",
      "securityReviewer",
      "codeReviewer",
      "testEngineer",
      "designer",
      "writer",
      "qaTester",
      "scientist",
      "tracer",
      "gitMaster",
      "codeSimplifier",
      "critic",
      "documentSpecialist"
    ];
  }
});

// src/team/team-owner-epoch.ts
import { createHash as createHash3, randomUUID } from "crypto";
import { existsSync as existsSync2, linkSync, mkdirSync as mkdirSync2, readFileSync as readFileSync2, readdirSync as readdirSync2, unlinkSync as unlinkSync2, writeFileSync as writeFileSync2 } from "fs";
import { dirname as dirname2, join as join4 } from "path";
import { execFileSync as execFileSync2 } from "node:child_process";
function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
}
function digest(value) {
  return createHash3("sha256").update(canonicalize(value)).digest("hex");
}
function recordBytes(record) {
  const payloadHash = digest(record);
  return canonicalize({ ...record, payload_hash: payloadHash });
}
function parseRecord(path4, expectedEpoch) {
  try {
    const parsed = JSON.parse(readFileSync2(path4, "utf8"));
    if (parsed.schema_version !== 1 || !Number.isSafeInteger(parsed.epoch) || parsed.epoch < 1 || expectedEpoch !== void 0 && parsed.epoch !== expectedEpoch || typeof parsed.nonce !== "string" || typeof parsed.pid !== "number" || !isValidProcessStartIdentity(parsed.process_started_at) || typeof parsed.payload_hash !== "string") return null;
    const { payload_hash, ...unsigned } = parsed;
    return digest(unsigned) === payload_hash ? parsed : null;
  } catch {
    return null;
  }
}
function darwinProcessStartFromKinfo(raw, nowSeconds = Math.floor(Date.now() / 1e3)) {
  if (raw.length < 16) return null;
  const seconds = raw.readBigUInt64LE(0);
  const micros = raw.readBigUInt64LE(8);
  if (seconds < 946684800n || seconds > BigInt(nowSeconds + 86400) || micros >= 1000000n) return null;
  return `${seconds}:${micros}`;
}
function processStartIdentityForPlatform(pid, platform = process.platform, exec3 = execFileSync2) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    if (platform === "linux") {
      const stat2 = readFileSync2(`/proc/${pid}/stat`, "utf8");
      const close = stat2.lastIndexOf(")");
      const fields = stat2.slice(close + 2).trim().split(/\s+/);
      const ticks = fields[19];
      return ticks ? `linux:${ticks}` : null;
    }
    if (platform === "win32") {
      const command = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`;
      const ticks = exec3(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        { encoding: "utf8", windowsHide: true }
      ).trim();
      return /^\d+$/.test(ticks) ? `win32:${ticks}` : null;
    }
    if (platform === "darwin") {
      try {
        const raw = exec3("/usr/sbin/sysctl", ["-b", `kern.proc.pid.${pid}`], {
          encoding: null,
          maxBuffer: 1024 * 1024,
          stdio: ["ignore", "pipe", "ignore"]
        });
        const birth = darwinProcessStartFromKinfo(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
        if (birth) return `darwin:${birth}`;
      } catch {
      }
      const started2 = exec3("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C", LANG: "C" }
      }).trim();
      const startedAtMs = Date.parse(started2);
      return started2 && Number.isFinite(startedAtMs) ? `darwin:${Math.floor(startedAtMs / 1e3)}:0` : null;
    }
    const started = exec3("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return started ? `${platform}:${started}` : null;
  } catch {
    return null;
  }
}
function isValidProcessStartIdentity(value, platform = process.platform) {
  if (typeof value !== "string" || value.length > 1024) return false;
  if (platform === "linux") return /^linux:[1-9]\d*$/.test(value);
  if (platform === "win32") return /^win32:[1-9]\d*$/.test(value);
  if (platform === "darwin") {
    const match = /^darwin:([1-9]\d*):(\d+)$/.exec(value);
    return match !== null && Number(match[2]) < 1e6;
  }
  const separator = value.indexOf(":");
  return separator > 0 && value.slice(0, separator) === platform && value.slice(separator + 1).length > 0 && !/[\u0000-\u001f\u007f]/.test(value.slice(separator + 1));
}
function currentProcessStartIdentity(pid = process.pid) {
  return processStartIdentityForPlatform(pid);
}
function processStartIdentitiesMayMatch(recorded, observed) {
  if (recorded === observed) return true;
  const recordedDarwin = /^darwin:([1-9]\d*):(\d+)$/.exec(recorded);
  const observedDarwin = /^darwin:([1-9]\d*):(\d+)$/.exec(observed);
  return recordedDarwin !== null && observedDarwin !== null && recordedDarwin[1] === observedDarwin[1] && (recordedDarwin[2] === "0" || observedDarwin[2] === "0");
}
function isProcessIdentityDead(record) {
  if (!Number.isSafeInteger(record.pid) || record.pid < 1 || !isValidProcessStartIdentity(record.process_started_at)) return false;
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    return error.code === "ESRCH";
  }
  const observed = currentProcessStartIdentity(record.pid);
  return isValidProcessStartIdentity(observed) && !processStartIdentitiesMayMatch(record.process_started_at, observed);
}
function readLatestOwnerEpoch(cwd, teamName) {
  const directory = absPath(cwd, TeamPaths.ownerEpochs(teamName));
  if (!existsSync2(directory)) return null;
  const epochs = readdirSync2(directory).map((name) => /^([1-9]\d*)\.json$/.exec(name)).filter((match) => match !== null).map((match) => Number(match[1])).sort((a, b) => b - a);
  const latestEpoch = epochs[0];
  if (latestEpoch === void 0) return null;
  const record = parseRecord(join4(directory, `${latestEpoch}.json`), latestEpoch);
  if (!record) throw new Error("invalid_owner_epoch_record");
  return record;
}
function publishOwnerEpoch(cwd, teamName, epoch, input = {}) {
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error("invalid_owner_epoch");
  const target = absPath(cwd, TeamPaths.ownerEpoch(teamName, epoch));
  mkdirSync2(dirname2(target), { recursive: true, mode: 448 });
  const start = input.processStartedAt ?? currentProcessStartIdentity(input.pid ?? process.pid);
  if (!isValidProcessStartIdentity(start)) throw new Error("process_start_identity_unavailable");
  const unsigned = {
    schema_version: 1,
    epoch,
    nonce: input.nonce ?? randomUUID(),
    pid: input.pid ?? process.pid,
    process_started_at: start,
    created_at: (/* @__PURE__ */ new Date()).toISOString(),
    ...input.heartbeat ? { heartbeat: input.heartbeat } : {}
  };
  const bytes = recordBytes(unsigned);
  const record = JSON.parse(bytes);
  const temp = join4(dirname2(target), `.${epoch}.${record.nonce}.${randomUUID()}.tmp`);
  writeFileSync2(temp, bytes, { encoding: "utf8", mode: 384, flush: true });
  try {
    linkSync(temp, target);
  } catch (error) {
    const existing = parseRecord(target, epoch);
    try {
      unlinkSync2(temp);
    } catch {
    }
    if (existing) return existing;
    throw error;
  }
  const verified = parseRecord(target, epoch);
  if (!verified || canonicalize(verified) !== bytes) throw new Error("owner_epoch_publication_verification_failed");
  unlinkSync2(temp);
  return verified;
}
function requireOwnerProcessIdentity(record, pid = process.pid, processStartedAt = currentProcessStartIdentity(pid)) {
  if (!processStartedAt || record.pid !== pid || record.process_started_at !== processStartedAt) {
    throw new Error("runtime_owner_fence_lost");
  }
  return record;
}
function checkOwnerFence(cwd, teamName, fence) {
  let latest;
  try {
    latest = readLatestOwnerEpoch(cwd, teamName);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!latest) return { ok: false, reason: "missing" };
  if (latest.epoch !== fence.epoch) return { ok: false, reason: "superseded" };
  if (latest.nonce !== fence.nonce) return { ok: false, reason: "mismatch" };
  return { ok: true, record: latest };
}
function requireOwnerFence(cwd, teamName, fence) {
  const result = checkOwnerFence(cwd, teamName, fence);
  if (!result.ok) throw new Error("runtime_owner_fence_lost");
  return result.record;
}
var init_team_owner_epoch = __esm({
  "src/team/team-owner-epoch.ts"() {
    "use strict";
    init_state_paths();
  }
});

// src/team/process-identity-lock.ts
import { linkSync as linkSync2, mkdirSync as mkdirSync3, readFileSync as readFileSync3, unlinkSync as unlinkSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname3 } from "node:path";
import { randomUUID as randomUUID2 } from "node:crypto";
function readLock(path4) {
  try {
    const record = JSON.parse(readFileSync3(path4, "utf8"));
    return record.schema_version === 1 && Number.isSafeInteger(record.pid) && record.pid > 0 && isValidProcessStartIdentity(record.process_started_at) && typeof record.nonce === "string" && record.nonce.length > 0 ? record : null;
  } catch {
    return null;
  }
}
async function withProcessIdentityFileLock(lockPath, fn, timeoutMs = 1e4) {
  const reclaimPath = `${lockPath}.reclaim`;
  mkdirSync3(dirname3(lockPath), { recursive: true, mode: 448 });
  const processStartedAt = currentProcessStartIdentity();
  if (!processStartedAt) throw new Error("process_start_identity_unavailable");
  const owner = {
    schema_version: 1,
    pid: process.pid,
    process_started_at: processStartedAt,
    nonce: randomUUID2(),
    created_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  const tempPath = `${lockPath}.${owner.nonce}.tmp`;
  writeFileSync3(tempPath, JSON.stringify(owner), { encoding: "utf8", mode: 384, flush: true });
  const deadline = Date.now() + timeoutMs;
  let acquired = false;
  try {
    while (!acquired) {
      const reclaimer = readLock(reclaimPath);
      if (reclaimer) {
        if (isProcessIdentityDead(reclaimer)) {
          try {
            unlinkSync3(reclaimPath);
          } catch {
          }
          continue;
        }
        if (Date.now() >= deadline) throw new Error("process_identity_lock_timeout");
        await new Promise((resolve7) => setTimeout(resolve7, 25));
        continue;
      }
      try {
        linkSync2(tempPath, lockPath);
        acquired = true;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const existing = readLock(lockPath);
        if (existing && isProcessIdentityDead(existing)) {
          try {
            linkSync2(tempPath, reclaimPath);
            const current = readLock(lockPath);
            if (current?.nonce === existing.nonce && isProcessIdentityDead(current)) unlinkSync3(lockPath);
            if (readLock(reclaimPath)?.nonce === owner.nonce) unlinkSync3(reclaimPath);
            continue;
          } catch (reclaimError) {
            if (reclaimError.code !== "EEXIST" && reclaimError.code !== "ENOENT") throw reclaimError;
          }
        }
        if (Date.now() >= deadline) throw new Error("process_identity_lock_timeout");
        await new Promise((resolve7) => setTimeout(resolve7, 25));
      }
    }
    return await fn();
  } finally {
    try {
      unlinkSync3(tempPath);
    } catch {
    }
    if (acquired && readLock(lockPath)?.nonce === owner.nonce) {
      try {
        unlinkSync3(lockPath);
      } catch {
      }
    }
    if (readLock(reclaimPath)?.nonce === owner.nonce) {
      try {
        unlinkSync3(reclaimPath);
      } catch {
      }
    }
  }
}
function withProcessIdentityFileLockSync(lockPath, fn) {
  const reclaimPath = `${lockPath}.reclaim`;
  mkdirSync3(dirname3(lockPath), { recursive: true, mode: 448 });
  const processStartedAt = currentProcessStartIdentity();
  if (!processStartedAt) throw new Error("process_start_identity_unavailable");
  const owner = {
    schema_version: 1,
    pid: process.pid,
    process_started_at: processStartedAt,
    nonce: randomUUID2(),
    created_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  const tempPath = `${lockPath}.${owner.nonce}.tmp`;
  writeFileSync3(tempPath, JSON.stringify(owner), { encoding: "utf8", mode: 384, flush: true });
  let acquired = false;
  try {
    for (let attempt = 0; attempt < 3 && !acquired; attempt++) {
      try {
        linkSync2(tempPath, lockPath);
        acquired = true;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const existing = readLock(lockPath);
        if (!existing || !isProcessIdentityDead(existing)) throw new Error("process_identity_lock_busy");
        try {
          linkSync2(tempPath, reclaimPath);
          const current = readLock(lockPath);
          if (current?.nonce === existing.nonce && isProcessIdentityDead(current)) unlinkSync3(lockPath);
          if (readLock(reclaimPath)?.nonce === owner.nonce) unlinkSync3(reclaimPath);
        } catch (reclaimError) {
          if (reclaimError.code !== "EEXIST" && reclaimError.code !== "ENOENT") throw reclaimError;
        }
      }
    }
    if (!acquired) throw new Error("process_identity_lock_busy");
    return fn();
  } finally {
    try {
      unlinkSync3(tempPath);
    } catch {
    }
    if (acquired && readLock(lockPath)?.nonce === owner.nonce) {
      try {
        unlinkSync3(lockPath);
      } catch {
      }
    }
    if (readLock(reclaimPath)?.nonce === owner.nonce) {
      try {
        unlinkSync3(reclaimPath);
      } catch {
      }
    }
  }
}
var init_process_identity_lock = __esm({
  "src/team/process-identity-lock.ts"() {
    "use strict";
    init_team_owner_epoch();
  }
});

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
      worktree_repo_root: backfillText(winner.worktree_repo_root, loser.worktree_repo_root),
      worktree_path: backfillText(winner.worktree_path, loser.worktree_path),
      worktree_branch: backfillText(winner.worktree_branch, loser.worktree_branch),
      worktree_detached: backfillBoolean(winner.worktree_detached, loser.worktree_detached),
      worktree_created: backfillBoolean(winner.worktree_created, loser.worktree_created),
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
    worker_count: workers.length > 0 ? workers.length : config.worker_count ?? 0
  };
}
var init_worker_canonicalization = __esm({
  "src/team/worker-canonicalization.ts"() {
    "use strict";
  }
});

// src/team/monitor.ts
import { existsSync as existsSync3 } from "fs";
import { readFile, mkdir } from "fs/promises";
import { dirname as dirname4 } from "path";
async function readJsonSafe(filePath) {
  try {
    if (!existsSync3(filePath)) return null;
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
async function readJsonFileState(filePath) {
  try {
    return { kind: "value", value: JSON.parse(await readFile(filePath, "utf8")) };
  } catch (error) {
    return error.code === "ENOENT" ? { kind: "missing" } : { kind: "invalid" };
  }
}
async function writeAtomic(filePath, data) {
  const { writeFile: writeFile9 } = await import("fs/promises");
  await mkdir(dirname4(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await writeFile9(tmpPath, data, "utf-8");
  const { rename: rename5 } = await import("fs/promises");
  await rename5(tmpPath, filePath);
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
    worktree_mode: manifest.worktree_mode,
    leader_pane_id: manifest.leader_pane_id,
    hud_pane_id: manifest.hud_pane_id,
    resize_hook_name: manifest.resize_hook_name,
    resize_hook_target: manifest.resize_hook_target,
    next_worker_index: manifest.next_worker_index,
    service_descriptor: manifest.service_descriptor
  };
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function isSafeCounter(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function isWorkerInfo(value) {
  if (!isRecord(value) || typeof value.name !== "string" || !WORKER_NAME_SAFE_PATTERN.test(value.name) || !isSafeCounter(value.index) || value.index < 1) return false;
  return (value.role === void 0 || typeof value.role === "string") && (value.assigned_tasks === void 0 || isStringArray(value.assigned_tasks)) && (value.worker_cli === void 0 || ["claude", "codex", "gemini", "cursor", "grok", "antigravity"].includes(value.worker_cli)) && (value.pid === void 0 || isSafeCounter(value.pid) && value.pid > 0) && (value.pane_id === void 0 || typeof value.pane_id === "string") && (value.working_dir === void 0 || typeof value.working_dir === "string") && (value.worktree_repo_root === void 0 || typeof value.worktree_repo_root === "string") && (value.worktree_path === void 0 || typeof value.worktree_path === "string") && (value.worktree_branch === void 0 || typeof value.worktree_branch === "string") && (value.worktree_detached === void 0 || typeof value.worktree_detached === "boolean") && (value.worktree_created === void 0 || typeof value.worktree_created === "boolean") && (value.team_state_root === void 0 || typeof value.team_state_root === "string") && (value.output_file === void 0 || typeof value.output_file === "string") && (value.recovery_id === void 0 || isNonEmptyString(value.recovery_id)) && (value.replacement_generation === void 0 || isSafeCounter(value.replacement_generation)) && (value.pane_attempt_id === void 0 || isNonEmptyString(value.pane_attempt_id)) && (value.operational_state === void 0 || ["starting", "active", "dead", "stopped"].includes(value.operational_state)) && (value.launch_descriptor === void 0 || isLaunchDescriptor(value.launch_descriptor));
}
function isLaunchDescriptor(value) {
  return isRecord(value) && value.schema_version === 1 && ["claude", "codex", "gemini", "cursor", "grok", "antigravity"].includes(value.provider) && (value.model === null || typeof value.model === "string") && isNonEmptyString(value.binary) && isStringArray(value.args);
}
function isOwnerEpoch(value) {
  return isRecord(value) && isSafeCounter(value.epoch) && value.epoch > 0 && isNonEmptyString(value.nonce) && isSafeCounter(value.pid) && value.pid > 0 && isNonEmptyString(value.process_started_at) && isTimestamp(value.created_at);
}
function isRecoveryAttempt(value) {
  return isRecord(value) && isNonEmptyString(value.request_id) && isNonEmptyString(value.recovery_id) && isNonEmptyString(value.worker_name) && isSafeCounter(value.owner_epoch) && value.owner_epoch > 0 && isNonEmptyString(value.owner_nonce) && ["reserved", "requeued", "ready", "active", "services_pending", "adopted", "failed"].includes(value.phase) && (value.original_pane_id === void 0 || typeof value.original_pane_id === "string") && isSafeCounter(value.state_revision) && isTimestamp(value.created_at) && isTimestamp(value.updated_at);
}
function isScaleUpAttempt(value) {
  return isRecord(value) && isNonEmptyString(value.operation_id) && ["reserved", "effects", "failed"].includes(value.phase) && isSafeCounter(value.pid) && value.pid > 0 && isNonEmptyString(value.process_started_at) && isSafeCounter(value.state_revision) && isTimestamp(value.created_at) && isTimestamp(value.updated_at) && (value.failure_reason === void 0 || typeof value.failure_reason === "string");
}
function isScaleDownAttempt(value) {
  return isRecord(value) && isNonEmptyString(value.operation_id) && ["draining", "effects", "failed"].includes(value.phase) && isSafeCounter(value.pid) && value.pid > 0 && isNonEmptyString(value.process_started_at) && Array.isArray(value.workers) && value.workers.every((worker) => isRecord(worker) && isNonEmptyString(worker.name) && (worker.pane_id === void 0 || typeof worker.pane_id === "string") && (worker.worktree_path === void 0 || typeof worker.worktree_path === "string") && (worker.worktree_created === void 0 || typeof worker.worktree_created === "boolean")) && isSafeCounter(value.state_revision) && isTimestamp(value.created_at) && isTimestamp(value.updated_at) && (value.failure_reason === void 0 || typeof value.failure_reason === "string");
}
function isServiceDescriptor(value) {
  return isRecord(value) && value.schema_version === 1 && isSafeCounter(value.service_generation) && isNonEmptyString(value.service_attempt_id) && typeof value.auto_merge_enabled === "boolean" && isNonEmptyString(value.workspace_root) && (value.leader_branch === void 0 || typeof value.leader_branch === "string") && ["disabled", "worker-auto-commit-v1"].includes(value.cadence_policy);
}
function isShutdownAttempt(value) {
  return isRecord(value) && isNonEmptyString(value.nonce) && isSafeCounter(value.pid) && value.pid > 0 && isNonEmptyString(value.process_started_at) && isSafeCounter(value.state_revision) && isTimestamp(value.created_at);
}
function isAllDeadRecovery(value) {
  return isRecord(value) && isTimestamp(value.detected_at) && isTimestamp(value.deadline_at) && isSafeCounter(value.state_revision);
}
function isTeamConfig(value, requireRevision, expectedTeamName) {
  if (!isRecord(value) || !isNonEmptyString(value.name) || expectedTeamName !== void 0 && value.name !== expectedTeamName || !isNonEmptyString(value.agent_type) || value.task !== void 0 && typeof value.task !== "string" || value.worker_launch_mode !== void 0 && !["interactive", "prompt"].includes(value.worker_launch_mode) || !isSafeCounter(value.worker_count) || value.max_workers !== void 0 && !isSafeCounter(value.max_workers) || !Array.isArray(value.workers) || value.worker_count !== value.workers.length || !value.workers.every(isWorkerInfo) || !hasUniqueWorkerIdentity(value.workers) || !isTimestamp(value.created_at) || !isNonEmptyString(value.tmux_session) || value.next_task_id !== void 0 && !isSafeCounter(value.next_task_id) || !isOptionalPolicy(value.policy) || !isOptionalGovernance(value.governance) || !isOptionalWorkspaceShape(value) || !isOptionalPaneShape(value) || !isOptionalRouting(value.resolved_routing)) return false;
  if (requireRevision ? !isSafeCounter(value.state_revision) : value.state_revision !== void 0 && !isSafeCounter(value.state_revision)) return false;
  if (!requireRevision && Object.hasOwn(value, "state_revision")) return false;
  return (value.lifecycle_state === void 0 || ["active", "shutting_down", "stopped"].includes(value.lifecycle_state)) && (value.runtime_owner_epoch === void 0 || isOwnerEpoch(value.runtime_owner_epoch)) && (value.active_recovery === void 0 || isRecoveryAttempt(value.active_recovery)) && (value.last_recovery === void 0 || isRecoveryAttempt(value.last_recovery)) && (value.active_scale_up === void 0 || isScaleUpAttempt(value.active_scale_up)) && (value.active_scale_down === void 0 || isScaleDownAttempt(value.active_scale_down)) && (value.service_descriptor === void 0 || isServiceDescriptor(value.service_descriptor)) && (value.shutdown_attempt === void 0 || isShutdownAttempt(value.shutdown_attempt)) && (value.all_dead_recovery === void 0 || isAllDeadRecovery(value.all_dead_recovery)) && hasMatchingActiveFenceRevisions(value);
}
function hasUniqueWorkerIdentity(workers) {
  const names = /* @__PURE__ */ new Set();
  const indices = /* @__PURE__ */ new Set();
  return workers.every((worker) => {
    if (!isRecord(worker) || typeof worker.name !== "string" || !WORKER_NAME_SAFE_PATTERN.test(worker.name) || typeof worker.index !== "number") return false;
    if (names.has(worker.name) || indices.has(worker.index)) return false;
    names.add(worker.name);
    indices.add(worker.index);
    return true;
  });
}
function isOptionalPolicy(value) {
  return value === void 0 || isRecord(value) && ["split_pane", "auto"].includes(value.display_mode) && ["interactive", "prompt"].includes(value.worker_launch_mode) && ["hook_preferred_with_fallback", "transport_direct"].includes(value.dispatch_mode) && isSafeCounter(value.dispatch_ack_timeout_ms);
}
function isOptionalGovernance(value) {
  return value === void 0 || isRecord(value) && typeof value.delegation_only === "boolean" && typeof value.plan_approval_required === "boolean" && typeof value.nested_teams_allowed === "boolean" && typeof value.one_team_per_leader_session === "boolean" && typeof value.cleanup_requires_all_workers_inactive === "boolean";
}
function isOptionalWorkspaceShape(value) {
  return (value.leader_cwd === void 0 || typeof value.leader_cwd === "string") && (value.team_state_root === void 0 || typeof value.team_state_root === "string") && (value.workspace_mode === void 0 || ["single", "worktree"].includes(value.workspace_mode)) && (value.worktree_mode === void 0 || ["disabled", "detached", "named"].includes(value.worktree_mode)) && (value.lifecycle_profile === void 0 || ["default", "linked_ralph"].includes(value.lifecycle_profile));
}
function isOptionalPaneShape(value) {
  return (value.leader_pane_id === void 0 || value.leader_pane_id === null || typeof value.leader_pane_id === "string") && (value.hud_pane_id === void 0 || value.hud_pane_id === null || typeof value.hud_pane_id === "string") && (value.resize_hook_name === void 0 || value.resize_hook_name === null || typeof value.resize_hook_name === "string") && (value.resize_hook_target === void 0 || value.resize_hook_target === null || typeof value.resize_hook_target === "string") && (value.next_worker_index === void 0 || isSafeCounter(value.next_worker_index) && value.next_worker_index > 0);
}
function isOptionalRouting(value) {
  if (value === void 0) return true;
  if (!isRecord(value) || Object.keys(value).length !== CANONICAL_TEAM_ROLES.length) return false;
  return CANONICAL_TEAM_ROLES.every((role) => isResolvedRoleRoute(value[role]));
}
function isResolvedRoleRoute(value) {
  return isRecord(value) && isRoleAssignment(value.primary) && isRoleAssignment(value.fallback);
}
function isRoleAssignment(value) {
  return isRecord(value) && ["claude", "codex", "gemini", "grok", "cursor", "antigravity"].includes(value.provider) && isNonEmptyString(value.model) && KNOWN_AGENT_NAMES.some((agent) => agent === value.agent);
}
function hasMatchingActiveFenceRevisions(value) {
  if (!isSafeCounter(value.state_revision)) return true;
  const revision = value.state_revision;
  return [value.active_recovery, value.active_scale_up, value.active_scale_down, value.shutdown_attempt, value.all_dead_recovery].every((fence) => fence === void 0 || isRecord(fence) && fence.state_revision === revision);
}
function alignActiveFenceRevisions(config, revision) {
  return {
    ...config,
    ...config.active_recovery ? { active_recovery: { ...config.active_recovery, state_revision: revision } } : {},
    ...config.active_scale_up ? { active_scale_up: { ...config.active_scale_up, state_revision: revision } } : {},
    ...config.active_scale_down ? { active_scale_down: { ...config.active_scale_down, state_revision: revision } } : {},
    ...config.shutdown_attempt ? { shutdown_attempt: { ...config.shutdown_attempt, state_revision: revision } } : {},
    ...config.all_dead_recovery ? { all_dead_recovery: { ...config.all_dead_recovery, state_revision: revision } } : {}
  };
}
function validateRevisionedTeamConfig(value, expectedTeamName) {
  return isTeamConfig(value, true, expectedTeamName) ? value : null;
}
function validateLegacyTeamConfig(value, expectedTeamName) {
  return isTeamConfig(value, false, expectedTeamName) ? value : null;
}
async function assertPersistedConfigPathBinding(teamName, cwd, includeManifestWhenAbsent = false) {
  const state = await readJsonFileState(absPath(cwd, TeamPaths.config(teamName)));
  if (state.kind === "invalid") throw new Error("invalid_persisted_state");
  if (state.kind === "value") {
    const valid = Object.hasOwn(state.value, "state_revision") ? validateRevisionedTeamConfig(state.value, teamName) : validateLegacyTeamConfig(state.value, teamName);
    if (!valid) throw new Error("invalid_persisted_state");
    return;
  }
  if (!includeManifestWhenAbsent) return;
  const manifestState = await readJsonFileState(absPath(cwd, TeamPaths.manifest(teamName)));
  if (manifestState.kind === "invalid") throw new Error("invalid_persisted_state");
  if (manifestState.kind === "value" && !validateLegacyTeamConfig(configFromManifest(normalizeTeamManifest(manifestState.value)), teamName)) {
    throw new Error("invalid_persisted_state");
  }
}
async function readTeamConfig(teamName, cwd) {
  const [configState, manifestState] = await Promise.all([
    readJsonFileState(absPath(cwd, TeamPaths.config(teamName))),
    readJsonFileState(absPath(cwd, TeamPaths.manifest(teamName)))
  ]);
  if (configState.kind === "invalid") throw new Error("invalid_persisted_state");
  const config = configState.kind === "value" ? configState.value : null;
  if (config && Object.hasOwn(config, "state_revision")) {
    const revisioned = validateRevisionedTeamConfig(config, teamName);
    if (!revisioned) throw new Error("invalid_persisted_state");
    return canonicalizeTeamConfigWorkers(revisioned);
  }
  if (config && !validateLegacyTeamConfig(config, teamName)) throw new Error("invalid_persisted_state");
  if (manifestState.kind === "invalid") throw new Error("invalid_persisted_state");
  const manifest = manifestState.kind === "value" ? normalizeTeamManifest(manifestState.value) : null;
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
async function readRevisionedTeamConfig(teamName, cwd) {
  const state = await readJsonFileState(absPath(cwd, TeamPaths.config(teamName)));
  if (state.kind === "invalid") throw new Error("invalid_persisted_state");
  if (state.kind === "missing") return null;
  const revisioned = validateRevisionedTeamConfig(state.value, teamName);
  if (revisioned) return { config: canonicalizeTeamConfigWorkers(revisioned), stateRevision: revisioned.state_revision };
  if (!validateLegacyTeamConfig(state.value, teamName)) throw new Error("invalid_persisted_state");
  return null;
}
function withTeamConfigMutationLock(teamName, cwd, fn) {
  return withProcessIdentityFileLock(absPath(cwd, TeamPaths.configMutationLock(teamName)), fn);
}
async function migrateTeamConfigRevision(teamName, cwd) {
  await assertPersistedConfigPathBinding(teamName, cwd, true);
  return withTeamConfigMutationLock(teamName, cwd, async () => {
    const configState = await readJsonFileState(absPath(cwd, TeamPaths.config(teamName)));
    if (configState.kind === "invalid") throw new Error("invalid_persisted_state");
    let current;
    if (configState.kind === "value") {
      const legacy = validateLegacyTeamConfig(configState.value, teamName);
      if (legacy) {
        current = legacy;
      } else {
        const revisioned2 = validateRevisionedTeamConfig(configState.value, teamName);
        if (!revisioned2) throw new Error("invalid_persisted_state");
        return { config: canonicalizeTeamConfigWorkers(revisioned2), stateRevision: revisioned2.state_revision };
      }
    } else {
      const manifestState = await readJsonFileState(absPath(cwd, TeamPaths.manifest(teamName)));
      if (manifestState.kind === "invalid") throw new Error("invalid_persisted_state");
      if (manifestState.kind === "missing") return null;
      current = configFromManifest(normalizeTeamManifest(manifestState.value));
    }
    const revisioned = validateRevisionedTeamConfig(current, teamName);
    if (revisioned) return { config: canonicalizeTeamConfigWorkers(revisioned), stateRevision: revisioned.state_revision };
    if (!validateLegacyTeamConfig(current, teamName)) throw new Error("invalid_persisted_state");
    current.state_revision = 0;
    current.lifecycle_state ??= "active";
    if (!validateRevisionedTeamConfig(current, teamName)) throw new Error("invalid_persisted_state");
    await saveTeamConfigUnlocked(current, cwd);
    return { config: canonicalizeTeamConfigWorkers(current), stateRevision: 0 };
  });
}
async function saveTeamConfigAtRevision(config, expectedRevision, cwd, afterCommit) {
  if (!validateRevisionedTeamConfig(config, config.name)) throw new Error("invalid_persisted_state");
  await assertPersistedConfigPathBinding(config.name, cwd);
  return withTeamConfigMutationLock(config.name, cwd, async () => {
    const current = await readRevisionedTeamConfig(config.name, cwd);
    if (!current || current.stateRevision !== expectedRevision) return false;
    if (!validateRevisionedTeamConfig(config, config.name)) throw new Error("invalid_persisted_state");
    await saveTeamConfigUnlocked(config, cwd);
    const verified = await readRevisionedTeamConfig(config.name, cwd);
    if (verified?.stateRevision !== config.state_revision) return false;
    await afterCommit?.();
    return true;
  });
}
async function readTeamManifest(teamName, cwd) {
  const state = await readJsonFileState(absPath(cwd, TeamPaths.manifest(teamName)));
  if (state.kind === "invalid") throw new Error("invalid_persisted_state");
  return state.kind === "value" ? normalizeTeamManifest(state.value) : null;
}
async function readWorkerStatus(teamName, workerName, cwd) {
  const data = await readJsonSafe(absPath(cwd, TeamPaths.workerStatus(teamName, workerName)));
  return data ?? { state: "unknown", updated_at: "" };
}
async function readWorkerHeartbeat(teamName, workerName, cwd) {
  return readJsonSafe(absPath(cwd, TeamPaths.heartbeat(teamName, workerName)));
}
async function readMonitorSnapshot(teamName, cwd) {
  const p = absPath(cwd, TeamPaths.monitorSnapshot(teamName));
  if (!existsSync3(p)) return null;
  try {
    const raw = await readFile(p, "utf-8");
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
      workerLivenessByName: parsed.workerLivenessByName ?? {},
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
async function writeShutdownRequest(teamName, workerName, fromWorker, cwd) {
  const data = {
    from: fromWorker,
    requested_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  await writeAtomic(absPath(cwd, TeamPaths.shutdownRequest(teamName, workerName)), JSON.stringify(data, null, 2));
}
async function readShutdownAck(teamName, workerName, cwd, requestedAfter) {
  const ack = await readJsonSafe(
    absPath(cwd, TeamPaths.shutdownAck(teamName, workerName))
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
  if (!existsSync3(tasksDir)) return [];
  const { readdir: readdir4 } = await import("fs/promises");
  const entries = await readdir4(tasksDir);
  const tasks = [];
  for (const entry of entries) {
    const match = /^(?:task-)?(\d+)\.json$/.exec(entry);
    if (!match) continue;
    const task = await readJsonSafe(absPath(cwd, `${TeamPaths.tasks(teamName)}/${entry}`));
    if (task) tasks.push(task);
  }
  return tasks.sort((a, b) => Number(a.id) - Number(b.id));
}
async function writeWorkerInbox(teamName, workerName, content, cwd) {
  await writeAtomic(absPath(cwd, TeamPaths.inbox(teamName, workerName)), content);
}
async function saveTeamConfigUnlocked(config, cwd) {
  const manifestPath = absPath(cwd, TeamPaths.manifest(config.name));
  const manifestState = await readJsonFileState(manifestPath);
  if (manifestState.kind === "invalid") throw new Error("invalid_persisted_state");
  const existingManifest = manifestState.kind === "value" ? manifestState.value : null;
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
      worktree_mode: config.worktree_mode,
      leader_pane_id: config.leader_pane_id,
      hud_pane_id: config.hud_pane_id,
      resize_hook_name: config.resize_hook_name,
      resize_hook_target: config.resize_hook_target,
      next_worker_index: config.next_worker_index,
      policy: config.policy ?? existingManifest.policy,
      governance: config.governance ?? existingManifest.governance,
      state_revision: config.state_revision,
      service_descriptor: config.service_descriptor
    });
    await writeAtomic(manifestPath, JSON.stringify(nextManifest, null, 2));
  }
  await writeAtomic(absPath(cwd, TeamPaths.config(config.name)), JSON.stringify(config, null, 2));
}
async function saveTeamConfig(config, cwd, expectedRevision) {
  const inputIsRevisioned = Object.hasOwn(config, "state_revision");
  if (!(inputIsRevisioned ? validateRevisionedTeamConfig(config, config.name) : validateLegacyTeamConfig(config, config.name))) {
    throw new Error("invalid_persisted_state");
  }
  await assertPersistedConfigPathBinding(config.name, cwd);
  await withTeamConfigMutationLock(config.name, cwd, async () => {
    const currentState = await readJsonFileState(absPath(cwd, TeamPaths.config(config.name)));
    if (currentState.kind === "invalid") throw new Error("invalid_persisted_state");
    const current = currentState.kind === "value" ? currentState.value : null;
    if (current && Object.hasOwn(current, "state_revision") && !validateRevisionedTeamConfig(current, config.name)) throw new Error("invalid_persisted_state");
    if (current && !Object.hasOwn(current, "state_revision") && !validateLegacyTeamConfig(current, config.name)) throw new Error("invalid_persisted_state");
    const currentRevision = current?.state_revision;
    let nextRevision;
    if (typeof currentRevision === "number" && Number.isSafeInteger(currentRevision)) {
      if (expectedRevision !== currentRevision || config.state_revision !== expectedRevision) {
        throw new Error("stale_state_revision");
      }
      nextRevision = currentRevision + 1;
    } else if (current) {
      if (expectedRevision !== void 0) throw new Error("stale_state_revision");
      nextRevision = 0;
    } else {
      nextRevision = config.state_revision ?? 0;
    }
    const committed = alignActiveFenceRevisions({ ...config, state_revision: nextRevision }, nextRevision);
    if (!validateRevisionedTeamConfig(committed, config.name)) throw new Error("invalid_persisted_state");
    await saveTeamConfigUnlocked(committed, cwd);
    Object.assign(config, committed);
  });
}
async function cleanupTeamState(teamName, cwd) {
  const root = absPath(cwd, TeamPaths.root(teamName));
  const { rm: rm6 } = await import("fs/promises");
  try {
    await rm6(root, { recursive: true, force: true });
  } catch {
  }
}
var init_monitor = __esm({
  "src/team/monitor.ts"() {
    "use strict";
    init_types();
    init_contracts();
    init_state_paths();
    init_process_identity_lock();
    init_governance();
    init_worker_canonicalization();
  }
});

// src/team/state/tasks.ts
import { randomUUID as randomUUID3 } from "crypto";
import { join as join5 } from "path";
import { existsSync as existsSync4 } from "fs";
import { readFile as readFile2, readdir } from "fs/promises";
async function computeTaskReadiness(teamName, taskId, cwd, deps) {
  const task = await deps.readTask(teamName, taskId, cwd);
  if (!task) return { ready: false, reason: "blocked_dependency", dependencies: [] };
  const depIds = task.depends_on ?? task.blocked_by ?? [];
  if (depIds.length === 0) return { ready: true };
  const depTasks = await Promise.all(depIds.map((depId) => deps.readTask(teamName, depId, cwd)));
  const incomplete = depIds.filter((_, idx) => depTasks[idx]?.status !== "completed");
  if (incomplete.length > 0) return { ready: false, reason: "blocked_dependency", dependencies: incomplete };
  return { ready: true };
}
async function claimTask(taskId, workerName, expectedVersion, deps) {
  const cfg = await deps.readTeamConfig(deps.teamName, deps.cwd);
  if (!cfg || !cfg.workers.some((w) => w.name === workerName)) return { ok: false, error: "worker_not_found" };
  const existing = await deps.readTask(deps.teamName, taskId, deps.cwd);
  if (!existing) return { ok: false, error: "task_not_found" };
  const readiness = await computeTaskReadiness(deps.teamName, taskId, deps.cwd, deps);
  if (readiness.ready === false) {
    return { ok: false, error: "blocked_dependency", dependencies: readiness.dependencies };
  }
  const lock = await deps.withTaskClaimLock(deps.teamName, taskId, deps.cwd, async () => {
    const current = await deps.readTask(deps.teamName, taskId, deps.cwd);
    if (!current) return { ok: false, error: "task_not_found" };
    const v = deps.normalizeTask(current);
    if (expectedVersion !== null && v.version !== expectedVersion) return { ok: false, error: "claim_conflict" };
    const readinessAfterLock = await computeTaskReadiness(deps.teamName, taskId, deps.cwd, deps);
    if (readinessAfterLock.ready === false) {
      return { ok: false, error: "blocked_dependency", dependencies: readinessAfterLock.dependencies };
    }
    if (deps.isTerminalTaskStatus(v.status)) return { ok: false, error: "already_terminal" };
    if (v.status === "in_progress") return { ok: false, error: "claim_conflict" };
    if (v.recovery_reservation) return { ok: false, error: "claim_conflict" };
    if (v.status === "pending" || v.status === "blocked") {
      if (v.claim) return { ok: false, error: "claim_conflict" };
      if (v.owner && v.owner !== workerName) return { ok: false, error: "claim_conflict" };
    }
    const claimToken = randomUUID3();
    const updated = {
      ...v,
      status: "in_progress",
      owner: workerName,
      claim: { owner: workerName, token: claimToken, leased_until: new Date(Date.now() + 15 * 60 * 1e3).toISOString() },
      version: v.version + 1
    };
    await deps.writeAtomic(deps.taskFilePath(deps.teamName, taskId, deps.cwd), JSON.stringify(updated, null, 2));
    return { ok: true, task: updated, claimToken };
  });
  if (!lock.ok) return { ok: false, error: "claim_conflict" };
  return lock.value;
}
function extractDelegationComplianceEvidence(task, terminalData) {
  const plan = task.delegation;
  if (!plan || plan.mode === "none") return null;
  if (plan.mode === "optional" && plan.required_parallel_probe !== true) return null;
  const result = typeof terminalData?.result === "string" ? terminalData.result : "";
  const spawnMatch = result.match(/^\s*Subagent spawn evidence:\s*(.+)$/im);
  if (spawnMatch?.[1]?.trim()) {
    const detail = spawnMatch[1].trim();
    if (!/^none\b|^0\b/i.test(detail)) {
      return { status: "spawned", source: "terminal_result", detail, recorded_at: (/* @__PURE__ */ new Date()).toISOString() };
    }
  }
  if (plan.skip_allowed_reason_required === true) {
    const skipMatch = result.match(/^\s*Subagent skip reason:\s*(.+)$/im);
    if (skipMatch?.[1]?.trim()) {
      return { status: "skipped", source: "terminal_result", detail: skipMatch[1].trim(), recorded_at: (/* @__PURE__ */ new Date()).toISOString() };
    }
  }
  return null;
}
function requiresDelegationComplianceEvidence(task) {
  const plan = task.delegation;
  return !!plan && (plan.mode === "auto" || plan.mode === "required" || plan.required_parallel_probe === true);
}
async function transitionTaskStatus(taskId, from, to, claimToken, terminalData, deps) {
  if (!deps.canTransitionTaskStatus(from, to)) return { ok: false, error: "invalid_transition" };
  const lock = await deps.withTaskClaimLock(deps.teamName, taskId, deps.cwd, async () => {
    const current = await deps.readTask(deps.teamName, taskId, deps.cwd);
    if (!current) return { ok: false, error: "task_not_found" };
    const v = deps.normalizeTask(current);
    if (deps.isTerminalTaskStatus(v.status)) return { ok: false, error: "already_terminal" };
    if (!deps.canTransitionTaskStatus(v.status, to)) return { ok: false, error: "invalid_transition" };
    if (v.status !== from) return { ok: false, error: "invalid_transition" };
    if (!v.owner || !v.claim || v.claim.owner !== v.owner || v.claim.token !== claimToken) {
      return { ok: false, error: "claim_conflict" };
    }
    if (new Date(v.claim.leased_until) <= /* @__PURE__ */ new Date()) return { ok: false, error: "lease_expired" };
    const normalizedResult = typeof terminalData?.result === "string" ? terminalData.result : void 0;
    const normalizedError = typeof terminalData?.error === "string" ? terminalData.error : void 0;
    const delegationCompliance = to === "completed" ? extractDelegationComplianceEvidence(v, terminalData) : null;
    if (to === "completed" && requiresDelegationComplianceEvidence(v) && !delegationCompliance) {
      return { ok: false, error: "missing_delegation_compliance_evidence" };
    }
    const updated = {
      ...v,
      status: to,
      completed_at: to === "completed" ? (/* @__PURE__ */ new Date()).toISOString() : v.completed_at,
      result: to === "completed" ? normalizedResult : void 0,
      error: to === "failed" ? normalizedError : void 0,
      delegation_compliance: to === "completed" ? delegationCompliance ?? v.delegation_compliance : v.delegation_compliance,
      claim: void 0,
      version: v.version + 1
    };
    await deps.writeAtomic(deps.taskFilePath(deps.teamName, taskId, deps.cwd), JSON.stringify(updated, null, 2));
    if (to === "completed") {
      await deps.appendTeamEvent(
        deps.teamName,
        { type: "task_completed", worker: updated.owner || "unknown", task_id: updated.id, message_id: null, reason: void 0 },
        deps.cwd
      );
    } else if (to === "failed") {
      await deps.appendTeamEvent(
        deps.teamName,
        { type: "task_failed", worker: updated.owner || "unknown", task_id: updated.id, message_id: null, reason: updated.error || "task_failed" },
        deps.cwd
      );
    }
    return { ok: true, task: updated };
  });
  if (!lock.ok) return { ok: false, error: "claim_conflict" };
  if (to === "completed") {
    const existing = await deps.readMonitorSnapshot(deps.teamName, deps.cwd);
    const updated = existing ? { ...existing, completedEventTaskIds: { ...existing.completedEventTaskIds ?? {}, [taskId]: true } } : {
      taskStatusById: {},
      workerAliveByName: {},
      workerLivenessByName: {},
      workerStateByName: {},
      workerTurnCountByName: {},
      workerTaskIdByName: {},
      mailboxNotifiedByMessageId: {},
      completedEventTaskIds: { [taskId]: true }
    };
    await deps.writeMonitorSnapshot(deps.teamName, updated, deps.cwd);
  }
  return lock.value;
}
async function releaseTaskClaim(taskId, claimToken, _workerName, deps) {
  const lock = await deps.withTaskClaimLock(deps.teamName, taskId, deps.cwd, async () => {
    const current = await deps.readTask(deps.teamName, taskId, deps.cwd);
    if (!current) return { ok: false, error: "task_not_found" };
    const v = deps.normalizeTask(current);
    if (v.status === "pending" && !v.claim && !v.owner) return { ok: true, task: v };
    if (v.status === "completed" || v.status === "failed") return { ok: false, error: "already_terminal" };
    if (!v.owner || !v.claim || v.claim.owner !== v.owner || v.claim.token !== claimToken) {
      return { ok: false, error: "claim_conflict" };
    }
    if (new Date(v.claim.leased_until) <= /* @__PURE__ */ new Date()) return { ok: false, error: "lease_expired" };
    const updated = {
      ...v,
      status: "pending",
      owner: void 0,
      claim: void 0,
      version: v.version + 1
    };
    await deps.writeAtomic(deps.taskFilePath(deps.teamName, taskId, deps.cwd), JSON.stringify(updated, null, 2));
    return { ok: true, task: updated };
  });
  if (!lock.ok) return { ok: false, error: "claim_conflict" };
  return lock.value;
}
async function listTasks(teamName, cwd, deps) {
  const tasksRoot = join5(deps.teamDir(teamName, cwd), "tasks");
  if (!existsSync4(tasksRoot)) return [];
  const entries = await readdir(tasksRoot, { withFileTypes: true });
  const matched = entries.flatMap((entry) => {
    if (!entry.isFile()) return [];
    const match = /^(?:task-)?(\d+)\.json$/.exec(entry.name);
    if (!match) return [];
    return [{ id: match[1], fileName: entry.name }];
  });
  const loaded = await Promise.all(
    matched.map(async ({ id, fileName }) => {
      try {
        const raw = await readFile2(join5(tasksRoot, fileName), "utf8");
        const parsed = JSON.parse(raw);
        if (!deps.isTeamTask(parsed)) return null;
        const normalized = deps.normalizeTask(parsed);
        if (normalized.id !== id) return null;
        return normalized;
      } catch {
        return null;
      }
    })
  );
  const tasks = [];
  for (const task of loaded) {
    if (task) tasks.push(task);
  }
  tasks.sort((a, b) => Number(a.id) - Number(b.id));
  return tasks;
}
function reservationFromSidecar(sidecar) {
  return { recovery_id: sidecar.recovery_id, request_id: sidecar.request_id, continuation_sequence: sidecar.continuation_sequence, checkpoint_path: sidecar.checkpoint_path, checkpoint_hash: sidecar.checkpoint_hash, replacement_worker: sidecar.replacement_worker, replacement_generation: sidecar.replacement_generation, adoption_token_hash: sidecar.adoption_token_hash, reserved_at: sidecar.created_at };
}
function checkpointError(error) {
  return `checkpoint_${error}`;
}
async function requeueRecoveredTask(input, deps) {
  const lock = await deps.withTaskClaimLock(deps.teamName, input.taskId, deps.cwd, async () => {
    const current = await deps.readTask(deps.teamName, input.taskId, deps.cwd);
    if (!current) return { ok: false, error: "task_not_found" };
    const task = deps.normalizeTask(current);
    const sidecar = await deps.readRecoverySidecar(deps.teamName, input.recoveryId, input.taskId, deps.cwd);
    if (sidecar === "malformed") return { ok: false, error: "task_requeue_failed" };
    if (sidecar) {
      const reservation2 = reservationFromSidecar(sidecar);
      const sameAttempt = sidecar.recovery_id === input.recoveryId && sidecar.request_id === input.requestId && sidecar.task_id === input.taskId && sidecar.replacement_worker === input.replacementWorker && sidecar.replacement_generation === input.replacementGeneration && sidecar.adoption_token_hash === input.adoptionTokenHash;
      if (!sameAttempt) return { ok: false, error: "task_requeue_failed" };
      if (task.status === "pending" && task.version === sidecar.old_task_version + 1 && !task.owner && !task.claim && JSON.stringify(task.recovery_reservation) === JSON.stringify(reservation2)) return { ok: true, task, reservation: reservation2, replayed: true };
      if (task.status !== "in_progress" || task.version !== sidecar.old_task_version || task.owner !== sidecar.old_owner || task.claim?.owner !== sidecar.old_owner || task.claim?.token !== sidecar.old_claim_token || task.claim?.leased_until !== sidecar.old_claim_leased_until) return { ok: false, error: "task_requeue_failed" };
      const checkpoint = await deps.readRecoveryCheckpoint(sidecar.checkpoint_path);
      if (!checkpoint.ok || checkpoint.checkpoint.resume_payload_hash !== sidecar.checkpoint_hash || checkpoint.checkpoint.sequence !== sidecar.continuation_sequence) return { ok: false, error: "task_requeue_failed" };
      const updated2 = { ...task, status: "pending", owner: void 0, claim: void 0, version: task.version + 1, recovery_reservation: reservation2 };
      await deps.writeAtomic(deps.taskFilePath(deps.teamName, input.taskId, deps.cwd), JSON.stringify(updated2, null, 2));
      return { ok: true, task: updated2, reservation: reservation2, replayed: false };
    }
    if (task.status !== "in_progress" || !task.owner || !task.claim || task.claim.owner !== task.owner || task.recovery_reservation) return { ok: false, error: "task_requeue_failed" };
    const selected = await deps.selectRecoveryCheckpoint(deps.teamName, task, deps.cwd);
    if (!selected.ok) return { ok: false, error: checkpointError(selected.error) };
    const createdAt = (/* @__PURE__ */ new Date()).toISOString();
    const next = { schema_version: 1, recovery_id: input.recoveryId, request_id: input.requestId, task_id: task.id, old_task_version: task.version, old_owner: task.owner, old_claim_token: task.claim.token, old_claim_leased_until: task.claim.leased_until, continuation_sequence: selected.checkpoint.sequence, checkpoint_path: selected.path, checkpoint_hash: selected.checkpoint.resume_payload_hash, replacement_worker: input.replacementWorker, replacement_generation: input.replacementGeneration, adoption_token_hash: input.adoptionTokenHash, created_at: createdAt };
    await deps.writeRecoverySidecar(deps.teamName, input.recoveryId, input.taskId, next, deps.cwd);
    const reservation = reservationFromSidecar(next);
    const updated = { ...task, status: "pending", owner: void 0, claim: void 0, version: task.version + 1, recovery_reservation: reservation };
    await deps.writeAtomic(deps.taskFilePath(deps.teamName, input.taskId, deps.cwd), JSON.stringify(updated, null, 2));
    return { ok: true, task: updated, reservation, replayed: false };
  });
  return lock.ok ? lock.value : { ok: false, error: "claim_conflict" };
}
async function adoptRecoveryReservations(taskIds, workerName, proof, deps) {
  const results = [];
  for (const taskId of [...taskIds].sort()) {
    const lock = await deps.withTaskClaimLock(deps.teamName, taskId, deps.cwd, async () => {
      const current = await deps.readTask(deps.teamName, taskId, deps.cwd);
      if (!current) return { ok: false, error: "task_not_found" };
      const task = deps.normalizeTask(current);
      const reservation = task.recovery_reservation;
      if (!reservation) {
        if (task.status === "in_progress" && task.owner === workerName && task.claim && task.recovery_adoption?.recovery_id === proof.recoveryId && task.recovery_adoption.request_id === proof.requestId && task.recovery_adoption.replacement_generation === proof.replacementGeneration) {
          const checkpoint2 = await deps.readRecoveryCheckpoint(task.recovery_adoption.checkpoint_path);
          return checkpoint2.ok ? { ok: true, task, claimToken: task.claim.token, checkpoint: checkpoint2.checkpoint, replayed: true } : { ok: false, error: checkpointError(checkpoint2.error) };
        }
        return { ok: false, error: "claim_conflict" };
      }
      if (task.status !== "pending" || task.owner || task.claim || reservation.recovery_id !== proof.recoveryId || reservation.request_id !== proof.requestId || reservation.replacement_worker !== workerName || reservation.replacement_generation !== proof.replacementGeneration || !deps.verifyAdoptionToken(proof.adoptionToken, reservation.adoption_token_hash)) return { ok: false, error: "claim_conflict" };
      const checkpoint = await deps.readRecoveryCheckpoint(reservation.checkpoint_path);
      if (!checkpoint.ok || checkpoint.checkpoint.resume_payload_hash !== reservation.checkpoint_hash || checkpoint.checkpoint.sequence !== reservation.continuation_sequence) return { ok: false, error: checkpointError(checkpoint.ok ? "stale" : checkpoint.error) };
      const claimToken = randomUUID3();
      const adoptedAt = (/* @__PURE__ */ new Date()).toISOString();
      const updated = { ...task, status: "in_progress", owner: workerName, claim: { owner: workerName, token: claimToken, leased_until: new Date(Date.now() + 15 * 60 * 1e3).toISOString() }, version: task.version + 1, recovery_reservation: void 0, recovery_adoption: { recovery_id: reservation.recovery_id, request_id: reservation.request_id, continuation_sequence: reservation.continuation_sequence, checkpoint_path: reservation.checkpoint_path, checkpoint_hash: reservation.checkpoint_hash, replacement_worker: workerName, replacement_generation: reservation.replacement_generation, adopted_at: adoptedAt } };
      await deps.writeAtomic(deps.taskFilePath(deps.teamName, taskId, deps.cwd), JSON.stringify(updated, null, 2));
      return { ok: true, task: updated, claimToken, checkpoint: checkpoint.checkpoint, replayed: false };
    });
    const result = lock.ok ? lock.value : { ok: false, error: "claim_conflict" };
    results.push(result);
    if (!result.ok) break;
  }
  return results;
}
var init_tasks = __esm({
  "src/team/state/tasks.ts"() {
    "use strict";
  }
});

// src/team/task-recovery-checkpoint.ts
import { createHash as createHash4 } from "node:crypto";
import { existsSync as existsSync5 } from "node:fs";
import { link, mkdir as mkdir2, open, readFile as readFile3, readdir as readdir2, rename, unlink } from "node:fs/promises";
import { basename as basename2, dirname as dirname5 } from "node:path";
function canonicalJson(value) {
  const seen = /* @__PURE__ */ new Set();
  const normalize4 = (current) => {
    if (current === null || typeof current === "string" || typeof current === "boolean") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new TypeError("Checkpoint payload must be finite JSON");
      return current;
    }
    if (Array.isArray(current)) return current.map(normalize4);
    if (typeof current === "object") {
      if (seen.has(current)) throw new TypeError("Checkpoint payload must not contain cycles");
      seen.add(current);
      const output2 = {};
      for (const key of Object.keys(current).sort()) {
        const child = current[key];
        if (child === void 0 || typeof child === "function" || typeof child === "symbol" || typeof child === "bigint") {
          throw new TypeError("Checkpoint payload must be JSON");
        }
        output2[key] = normalize4(child);
      }
      seen.delete(current);
      return output2;
    }
    throw new TypeError("Checkpoint payload must be JSON");
  };
  return JSON.stringify(normalize4(value));
}
function hashTaskRecoveryCheckpointPayload(payload) {
  return createHash4("sha256").update(canonicalJson(payload)).digest("hex");
}
function taskRecoveryClaimTokenHash(claimToken) {
  return createHash4("sha256").update(claimToken).digest("hex");
}
function checkpointPath(cwd, teamName, taskId, claimToken, sequence) {
  return absPath(cwd, TeamPaths.checkpoint(teamName, taskId, taskRecoveryClaimTokenHash(claimToken), sequence));
}
function latestPath(cwd, teamName, taskId, claimToken) {
  return absPath(cwd, TeamPaths.checkpointLatest(teamName, taskId, taskRecoveryClaimTokenHash(claimToken)));
}
async function syncDirectory(path4) {
  if (process.platform === "win32") return;
  const directory = await open(dirname5(path4), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function writeAtomic2(path4, content) {
  await mkdir2(dirname5(path4), { recursive: true });
  const temp = `${path4}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temp, "wx", 384);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path4);
  await syncDirectory(path4);
}
async function publishImmutableCheckpoint(path4, content) {
  await mkdir2(dirname5(path4), { recursive: true });
  const temp = `${path4}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  const handle = await open(temp, "wx", 384);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temp, path4);
    if (await readFile3(path4, "utf8") !== content) return "conflict";
    await syncDirectory(path4);
    return "created";
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return await readFile3(path4, "utf8").catch(() => "") === content ? "replayed" : "conflict";
  } finally {
    await unlink(temp).catch(() => void 0);
  }
}
function parseCheckpoint(value) {
  if (!value || typeof value !== "object") return null;
  const checkpoint = value;
  const sequence = checkpoint.sequence;
  const taskVersion = checkpoint.task_version;
  if (checkpoint.schema_version !== 1 || typeof checkpoint.team_name !== "string" || typeof checkpoint.task_id !== "string" || typeof checkpoint.worker_name !== "string" || typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence <= 0 || typeof taskVersion !== "number" || !Number.isSafeInteger(taskVersion) || taskVersion <= 0 || typeof checkpoint.claim_token !== "string" || typeof checkpoint.resume_payload_hash !== "string" || typeof checkpoint.updated_at !== "string") return null;
  try {
    if (hashTaskRecoveryCheckpointPayload(checkpoint.resume_payload) !== checkpoint.resume_payload_hash) return null;
  } catch {
    return null;
  }
  return checkpoint;
}
function sameCheckpointPublication(existing, candidate) {
  const { updated_at: _existingUpdatedAt, ...existingSemantic } = existing;
  const { updated_at: _candidateUpdatedAt, ...candidateSemantic } = candidate;
  return canonicalJson(existingSemantic) === canonicalJson(candidateSemantic);
}
function checkpointSequenceFromPath(path4) {
  const match = /^(\d+)\.json$/.exec(basename2(path4));
  if (!match) return null;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null;
}
async function readCheckpoint(path4) {
  const filenameSequence = checkpointSequenceFromPath(path4);
  if (filenameSequence === null) return null;
  try {
    const checkpoint = parseCheckpoint(JSON.parse(await readFile3(path4, "utf8")));
    return checkpoint?.sequence === filenameSequence ? checkpoint : null;
  } catch {
    return null;
  }
}
async function readCheckpointLatest(path4) {
  try {
    const value = JSON.parse(await readFile3(path4, "utf8"));
    return Number.isSafeInteger(value.sequence) && value.sequence > 0 ? { sequence: value.sequence } : null;
  } catch {
    return null;
  }
}
async function publishTaskRecoveryCheckpoint(input, cwd, access2) {
  if (!Number.isSafeInteger(input.sequence) || input.sequence <= 0 || !Number.isSafeInteger(input.taskVersion) || input.taskVersion <= 0) {
    return { ok: false, error: "invalid_checkpoint" };
  }
  let payloadHash;
  let payloadBytes;
  try {
    const serialized = canonicalJson(input.resumePayload);
    payloadBytes = Buffer.byteLength(serialized);
    payloadHash = createHash4("sha256").update(serialized).digest("hex");
  } catch {
    return { ok: false, error: "invalid_checkpoint" };
  }
  if (payloadBytes > MAX_TASK_RECOVERY_CHECKPOINT_BYTES) return { ok: false, error: "invalid_checkpoint" };
  const lock = await access2.withTaskLock(input.teamName, input.taskId, cwd, async () => {
    const task = await access2.readTask(input.teamName, input.taskId, cwd);
    if (!task || task.status !== "in_progress" || task.version !== input.taskVersion || task.owner !== input.workerName || !task.claim || task.claim.owner !== input.workerName || task.claim.token !== input.claimToken) {
      return { ok: false, error: "claim_conflict" };
    }
    const checkpoint = {
      schema_version: 1,
      team_name: input.teamName,
      task_id: input.taskId,
      worker_name: input.workerName,
      sequence: input.sequence,
      task_version: input.taskVersion,
      claim_token: input.claimToken,
      resume_payload_hash: payloadHash,
      resume_payload: input.resumePayload,
      updated_at: input.updatedAt ?? (/* @__PURE__ */ new Date()).toISOString()
    };
    const path4 = checkpointPath(cwd, input.teamName, input.taskId, input.claimToken, input.sequence);
    const existing = await readCheckpoint(path4);
    if (existing) {
      if (!sameCheckpointPublication(existing, checkpoint)) {
        return { ok: false, error: "publication_conflict" };
      }
      return { ok: true, checkpoint: existing, path: path4, replayed: true };
    }
    const publication = await publishImmutableCheckpoint(path4, JSON.stringify(checkpoint));
    if (publication !== "created") {
      const replayed = await readCheckpoint(path4);
      return replayed && sameCheckpointPublication(replayed, checkpoint) ? { ok: true, checkpoint: replayed, path: path4, replayed: true } : { ok: false, error: "publication_conflict" };
    }
    const latest = latestPath(cwd, input.teamName, input.taskId, input.claimToken);
    const existingLatest = await readCheckpointLatest(latest);
    if (!existingLatest || input.sequence >= existingLatest.sequence) {
      await writeAtomic2(latest, JSON.stringify({ sequence: input.sequence, path: path4, resume_payload_hash: payloadHash }));
    }
    return { ok: true, checkpoint, path: path4, replayed: false };
  });
  return lock.ok ? lock.value : { ok: false, error: "claim_conflict" };
}
async function selectTaskRecoveryCheckpoint(teamName, task, cwd) {
  if (!task.owner || !task.claim) return { ok: false, error: "stale" };
  const root = absPath(cwd, TeamPaths.checkpoints(teamName, task.id, taskRecoveryClaimTokenHash(task.claim.token)));
  if (!existsSync5(root)) return { ok: false, error: "missing" };
  let names;
  try {
    names = await readdir2(root);
  } catch {
    return { ok: false, error: "malformed" };
  }
  const paths = names.filter((name) => /^\d+\.json$/.test(name)).map((name) => `${root}/${name}`);
  if (paths.length === 0) return { ok: false, error: "missing" };
  const parsed = await Promise.all(paths.map(async (path4) => ({ path: path4, checkpoint: await readCheckpoint(path4) })));
  if (parsed.some(({ checkpoint }) => !checkpoint)) return { ok: false, error: "malformed" };
  const valid = parsed;
  const matching = valid.filter(({ checkpoint }) => checkpoint.team_name === teamName && checkpoint.task_id === task.id && checkpoint.worker_name === task.owner && checkpoint.task_version === task.version && checkpoint.claim_token === task.claim?.token);
  if (matching.length === 0) return { ok: false, error: "stale" };
  const highest = Math.max(...matching.map(({ checkpoint }) => checkpoint.sequence));
  const selected = matching.filter(({ checkpoint }) => checkpoint.sequence === highest);
  if (selected.length !== 1) return { ok: false, error: "ambiguous" };
  const otherHighest = valid.filter(({ checkpoint }) => checkpoint.sequence === highest && checkpoint.resume_payload_hash !== selected[0].checkpoint.resume_payload_hash);
  if (otherHighest.length > 0) return { ok: false, error: "ambiguous" };
  return { ok: true, checkpoint: selected[0].checkpoint, path: selected[0].path };
}
async function readTaskRecoveryCheckpoint(path4) {
  const checkpoint = await readCheckpoint(path4);
  return checkpoint ? { ok: true, checkpoint, path: path4 } : { ok: false, error: existsSync5(path4) ? "malformed" : "missing" };
}
var MAX_TASK_RECOVERY_CHECKPOINT_BYTES;
var init_task_recovery_checkpoint = __esm({
  "src/team/task-recovery-checkpoint.ts"() {
    "use strict";
    init_state_paths();
    MAX_TASK_RECOVERY_CHECKPOINT_BYTES = 64 * 1024;
  }
});

// src/team/team-ops.ts
var team_ops_exports = {};
__export(team_ops_exports, {
  teamAdoptRecoveryReservations: () => teamAdoptRecoveryReservations,
  teamAppendEvent: () => teamAppendEvent,
  teamBroadcast: () => teamBroadcast,
  teamClaimTask: () => teamClaimTask,
  teamCleanup: () => teamCleanup,
  teamCreateTask: () => teamCreateTask,
  teamGetSummary: () => teamGetSummary,
  teamListMailbox: () => teamListMailbox,
  teamListTasks: () => teamListTasks,
  teamMarkMessageDelivered: () => teamMarkMessageDelivered,
  teamMarkMessageNotified: () => teamMarkMessageNotified,
  teamPublishTaskRecoveryCheckpoint: () => teamPublishTaskRecoveryCheckpoint,
  teamReadCanonicalMailboxMessageStrict: () => teamReadCanonicalMailboxMessageStrict,
  teamReadConfig: () => teamReadConfig,
  teamReadManifest: () => teamReadManifest,
  teamReadMonitorSnapshot: () => teamReadMonitorSnapshot,
  teamReadShutdownAck: () => teamReadShutdownAck,
  teamReadTask: () => teamReadTask,
  teamReadTaskApproval: () => teamReadTaskApproval,
  teamReadWorkerHeartbeat: () => teamReadWorkerHeartbeat,
  teamReadWorkerStatus: () => teamReadWorkerStatus,
  teamReleaseTaskClaim: () => teamReleaseTaskClaim,
  teamRequeueRecoveredTask: () => teamRequeueRecoveredTask,
  teamSendMessage: () => teamSendMessage,
  teamTransitionTaskStatus: () => teamTransitionTaskStatus,
  teamUpdateTask: () => teamUpdateTask,
  teamUpdateWorkerHeartbeat: () => teamUpdateWorkerHeartbeat,
  teamWriteMonitorSnapshot: () => teamWriteMonitorSnapshot,
  teamWriteShutdownRequest: () => teamWriteShutdownRequest,
  teamWriteTaskApproval: () => teamWriteTaskApproval,
  teamWriteWorkerIdentity: () => teamWriteWorkerIdentity,
  teamWriteWorkerInbox: () => teamWriteWorkerInbox,
  withTaskClaimLock: () => withTaskClaimLock,
  writeAtomic: () => writeAtomic3
});
import { createHash as createHash5, randomUUID as randomUUID4 } from "node:crypto";
import { existsSync as existsSync6 } from "node:fs";
import { appendFile, mkdir as mkdir3, readFile as readFile4, rm, writeFile } from "node:fs/promises";
import { dirname as dirname6, join as join6 } from "node:path";
function teamDir(teamName, cwd) {
  return absPath(cwd, TeamPaths.root(teamName));
}
function normalizeTaskId(taskId) {
  const raw = String(taskId).trim();
  return raw.startsWith("task-") ? raw.slice("task-".length) : raw;
}
function canonicalTaskFilePath(teamName, taskId, cwd) {
  const normalizedTaskId = normalizeTaskId(taskId);
  return join6(absPath(cwd, TeamPaths.tasks(teamName)), `task-${normalizedTaskId}.json`);
}
function legacyTaskFilePath(teamName, taskId, cwd) {
  const normalizedTaskId = normalizeTaskId(taskId);
  return join6(absPath(cwd, TeamPaths.tasks(teamName)), `${normalizedTaskId}.json`);
}
function taskFileCandidates(teamName, taskId, cwd) {
  const canonical = canonicalTaskFilePath(teamName, taskId, cwd);
  const legacy = legacyTaskFilePath(teamName, taskId, cwd);
  return canonical === legacy ? [canonical] : [canonical, legacy];
}
async function writeAtomic3(path4, data) {
  const tmp = `${path4}.${process.pid}.tmp`;
  await mkdir3(dirname6(path4), { recursive: true });
  await writeFile(tmp, data, "utf8");
  const { rename: rename5 } = await import("node:fs/promises");
  await rename5(tmp, path4);
}
async function readJsonSafe2(path4) {
  try {
    if (!existsSync6(path4)) return null;
    const raw = await readFile4(path4, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function normalizeTask(task) {
  return { ...task, version: task.version ?? 1 };
}
function isTeamTask(value) {
  if (!value || typeof value !== "object") return false;
  const v = value;
  return typeof v.id === "string" && typeof v.subject === "string" && typeof v.status === "string";
}
async function withLock(lockPath, fn) {
  try {
    const value = await withProcessIdentityFileLock(lockPath, fn, 1);
    return { ok: true, value };
  } catch (error) {
    if (error instanceof Error && error.message === "process_identity_lock_timeout") return { ok: false };
    throw error;
  }
}
async function withTaskClaimLock(teamName, taskId, cwd, fn) {
  const lockDir = join6(teamDir(teamName, cwd), "tasks", `.lock-${taskId}`);
  return withLock(lockDir, fn);
}
async function withMailboxLock(teamName, workerName, cwd, fn) {
  const lockDir = absPath(cwd, TeamPaths.mailboxLockDir(teamName, workerName));
  const timeoutMs = 5e3;
  const deadline = Date.now() + timeoutMs;
  let delayMs = 20;
  while (Date.now() < deadline) {
    const result = await withLock(lockDir, fn);
    if (result.ok) return result.value;
    await new Promise((resolve7) => setTimeout(resolve7, delayMs));
    delayMs = Math.min(delayMs * 2, 200);
  }
  throw new Error(`Failed to acquire mailbox lock for ${workerName} after ${timeoutMs}ms`);
}
function configFromManifest2(manifest) {
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
    worktree_mode: manifest.worktree_mode,
    leader_pane_id: manifest.leader_pane_id,
    hud_pane_id: manifest.hud_pane_id,
    resize_hook_name: manifest.resize_hook_name,
    resize_hook_target: manifest.resize_hook_target,
    next_worker_index: manifest.next_worker_index
  };
}
function mergeTeamConfigSources(config, manifest) {
  if (!config && !manifest) return null;
  if (config && typeof config.state_revision === "number" && Number.isSafeInteger(config.state_revision)) {
    return canonicalizeTeamConfigWorkers(config);
  }
  if (!manifest) return config ? canonicalizeTeamConfigWorkers(config) : null;
  if (!config) return canonicalizeTeamConfigWorkers(configFromManifest2(manifest));
  return canonicalizeTeamConfigWorkers({
    ...configFromManifest2(manifest),
    ...config,
    workers: [...config.workers ?? [], ...manifest.workers ?? []],
    worker_count: Math.max(config.worker_count ?? 0, manifest.worker_count ?? 0),
    next_task_id: Math.max(config.next_task_id ?? 1, manifest.next_task_id ?? 1),
    max_workers: Math.max(config.max_workers ?? 0, 20)
  });
}
async function teamReadConfig(teamName, cwd) {
  const configPath = absPath(cwd, TeamPaths.config(teamName));
  const manifestPath = absPath(cwd, TeamPaths.manifest(teamName));
  const [manifest, config] = await Promise.all([
    teamReadManifest(teamName, cwd),
    readJsonSafe2(configPath)
  ]);
  if (!config && existsSync6(configPath)) throw new Error("invalid_persisted_state");
  if (config && typeof config.state_revision === "number" && Number.isSafeInteger(config.state_revision)) {
    return canonicalizeTeamConfigWorkers(config);
  }
  if (!manifest && existsSync6(manifestPath)) throw new Error("invalid_persisted_state");
  return mergeTeamConfigSources(config, manifest);
}
async function teamReadManifest(teamName, cwd) {
  const manifestPath = absPath(cwd, TeamPaths.manifest(teamName));
  const manifest = await readJsonSafe2(manifestPath);
  if (!manifest && existsSync6(manifestPath)) throw new Error("invalid_persisted_state");
  return manifest ? normalizeTeamManifest(manifest) : null;
}
async function teamCleanup(teamName, cwd) {
  await rm(teamDir(teamName, cwd), { recursive: true, force: true });
}
async function teamWriteWorkerIdentity(teamName, workerName, identity, cwd) {
  const p = absPath(cwd, TeamPaths.workerIdentity(teamName, workerName));
  await writeAtomic3(p, JSON.stringify(identity, null, 2));
}
async function teamReadWorkerHeartbeat(teamName, workerName, cwd) {
  const p = absPath(cwd, TeamPaths.heartbeat(teamName, workerName));
  return readJsonSafe2(p);
}
async function teamUpdateWorkerHeartbeat(teamName, workerName, heartbeat, cwd) {
  const p = absPath(cwd, TeamPaths.heartbeat(teamName, workerName));
  await writeAtomic3(p, JSON.stringify(heartbeat, null, 2));
}
async function teamReadWorkerStatus(teamName, workerName, cwd) {
  const unknownStatus = { state: "unknown", updated_at: "1970-01-01T00:00:00.000Z" };
  const p = absPath(cwd, TeamPaths.workerStatus(teamName, workerName));
  const status = await readJsonSafe2(p);
  return status ?? unknownStatus;
}
async function teamWriteWorkerInbox(teamName, workerName, prompt, cwd) {
  const p = absPath(cwd, TeamPaths.inbox(teamName, workerName));
  await writeAtomic3(p, prompt);
}
async function teamCreateTask(teamName, task, cwd) {
  const lockDir = join6(teamDir(teamName, cwd), ".lock-create-task");
  const timeoutMs = 5e3;
  const deadline = Date.now() + timeoutMs;
  let delayMs = 20;
  while (Date.now() < deadline) {
    const result = await withLock(lockDir, async () => {
      const revisioned = await migrateTeamConfigRevision(teamName, cwd);
      if (!revisioned) throw new Error(`Team ${teamName} not found`);
      if (revisioned.config.lifecycle_state === "shutting_down" || revisioned.config.lifecycle_state === "stopped") {
        throw new Error("team_mutation_busy");
      }
      const nextId = String(revisioned.config.next_task_id ?? 1);
      const created = {
        ...task,
        id: nextId,
        status: task.status ?? "pending",
        depends_on: task.depends_on ?? task.blocked_by ?? [],
        version: 1,
        created_at: (/* @__PURE__ */ new Date()).toISOString()
      };
      const serializedTask = JSON.stringify(created, null, 2);
      const createdTaskPath = join6(absPath(cwd, TeamPaths.tasks(teamName)), `task-${nextId}.json`);
      const taskLock = await withTaskClaimLock(teamName, nextId, cwd, async () => {
        await mkdir3(dirname6(createdTaskPath), { recursive: true });
        await writeAtomic3(createdTaskPath, serializedTask);
        const nextConfig = {
          ...revisioned.config,
          next_task_id: Number(nextId) + 1,
          state_revision: revisioned.stateRevision + 1
        };
        try {
          if (!await saveTeamConfigAtRevision(nextConfig, revisioned.stateRevision, cwd)) {
            throw new Error("stale_state_revision");
          }
        } catch (error) {
          const persisted = await readRevisionedTeamConfig(teamName, cwd).catch(() => null);
          const configCommitted = persisted?.stateRevision === nextConfig.state_revision && persisted?.config.next_task_id === nextConfig.next_task_id;
          if (!configCommitted && await readFile4(createdTaskPath, "utf8").catch(() => null) === serializedTask) {
            await rm(createdTaskPath, { force: true });
          }
          throw error;
        }
        return created;
      });
      if (!taskLock.ok) throw new Error(`Failed to acquire task claim lock for task ${nextId}`);
      return taskLock.value;
    });
    if (result.ok) return result.value;
    await new Promise((resolve7) => setTimeout(resolve7, delayMs));
    delayMs = Math.min(delayMs * 2, 200);
  }
  throw new Error(`Failed to acquire task creation lock for team ${teamName} after ${timeoutMs}ms`);
}
async function teamReadTask(teamName, taskId, cwd) {
  for (const candidate of taskFileCandidates(teamName, taskId, cwd)) {
    const task = await readJsonSafe2(candidate);
    if (!task || !isTeamTask(task)) continue;
    return normalizeTask(task);
  }
  return null;
}
async function teamListTasks(teamName, cwd) {
  return listTasks(teamName, cwd, {
    teamDir: (tn, c) => teamDir(tn, c),
    isTeamTask,
    normalizeTask
  });
}
async function teamUpdateTask(teamName, taskId, updates, cwd) {
  const timeoutMs = 5e3;
  const deadline = Date.now() + timeoutMs;
  let delayMs = 20;
  while (Date.now() < deadline) {
    const result = await withTaskClaimLock(teamName, taskId, cwd, async () => {
      const existing = await teamReadTask(teamName, taskId, cwd);
      if (!existing) return null;
      const merged = {
        ...normalizeTask(existing),
        ...updates,
        id: existing.id,
        created_at: existing.created_at,
        version: Math.max(1, existing.version ?? 1) + 1
      };
      const p = canonicalTaskFilePath(teamName, taskId, cwd);
      await writeAtomic3(p, JSON.stringify(merged, null, 2));
      return merged;
    });
    if (result.ok) return result.value;
    await new Promise((resolve7) => setTimeout(resolve7, delayMs));
    delayMs = Math.min(delayMs * 2, 200);
  }
  throw new Error(`Failed to acquire task update lock for task ${taskId} in team ${teamName} after ${timeoutMs}ms`);
}
async function teamClaimTask(teamName, taskId, workerName, expectedVersion, cwd) {
  const config = await teamReadConfig(teamName, cwd);
  const governance = normalizeTeamGovernance(config?.governance, config?.policy);
  if (governance.plan_approval_required) {
    const task = await teamReadTask(teamName, taskId, cwd);
    if (task?.requires_code_change) {
      const approval = await teamReadTaskApproval(teamName, taskId, cwd);
      if (!approval || approval.status !== "approved") {
        return { ok: false, error: "blocked_dependency", dependencies: ["approval-required"] };
      }
    }
  }
  return claimTask(taskId, workerName, expectedVersion, {
    teamName,
    cwd,
    readTask: teamReadTask,
    readTeamConfig: async (tn, c) => {
      const cfg = await teamReadConfig(tn, c);
      if (!cfg) return null;
      if (cfg.workers.length > 0) return cfg;
      const match = /^worker-(\d+)$/.exec(workerName);
      const workerIndex = match ? Number.parseInt(match[1], 10) : 0;
      if (workerIndex >= 1 && workerIndex <= (cfg.worker_count ?? 0)) {
        return {
          ...cfg,
          workers: Array.from({ length: cfg.worker_count ?? 0 }, (_, index) => ({
            name: `worker-${index + 1}`
          }))
        };
      }
      return cfg;
    },
    withTaskClaimLock,
    normalizeTask,
    isTerminalTaskStatus: isTerminalTeamTaskStatus,
    taskFilePath: (tn, tid, c) => canonicalTaskFilePath(tn, tid, c),
    writeAtomic: writeAtomic3
  });
}
async function teamTransitionTaskStatus(teamName, taskId, from, to, claimToken, cwd, terminalData) {
  return transitionTaskStatus(taskId, from, to, claimToken, terminalData, {
    teamName,
    cwd,
    readTask: teamReadTask,
    readTeamConfig: teamReadConfig,
    withTaskClaimLock,
    normalizeTask,
    isTerminalTaskStatus: isTerminalTeamTaskStatus,
    canTransitionTaskStatus: canTransitionTeamTaskStatus,
    taskFilePath: (tn, tid, c) => canonicalTaskFilePath(tn, tid, c),
    writeAtomic: writeAtomic3,
    appendTeamEvent: teamAppendEvent,
    readMonitorSnapshot: teamReadMonitorSnapshot,
    writeMonitorSnapshot: teamWriteMonitorSnapshot
  });
}
async function teamReleaseTaskClaim(teamName, taskId, claimToken, workerName, cwd) {
  return releaseTaskClaim(taskId, claimToken, workerName, {
    teamName,
    cwd,
    readTask: teamReadTask,
    readTeamConfig: teamReadConfig,
    withTaskClaimLock,
    normalizeTask,
    isTerminalTaskStatus: isTerminalTeamTaskStatus,
    taskFilePath: (tn, tid, c) => canonicalTaskFilePath(tn, tid, c),
    writeAtomic: writeAtomic3
  });
}
function recoveryTransitionDeps(teamName, cwd) {
  return {
    teamName,
    cwd,
    readTask: teamReadTask,
    readTeamConfig: teamReadConfig,
    withTaskClaimLock,
    normalizeTask,
    isTerminalTaskStatus: isTerminalTeamTaskStatus,
    taskFilePath: (tn, tid, c) => canonicalTaskFilePath(tn, tid, c),
    writeAtomic: writeAtomic3,
    readRecoverySidecar: async (tn, recoveryId, tid, c) => {
      const path4 = absPath(c, TeamPaths.taskRecoverySidecar(tn, recoveryId, tid));
      if (!existsSync6(path4)) return null;
      try {
        return JSON.parse(await readFile4(path4, "utf8"));
      } catch {
        return "malformed";
      }
    },
    writeRecoverySidecar: (tn, recoveryId, tid, sidecar, c) => writeAtomic3(absPath(c, TeamPaths.taskRecoverySidecar(tn, recoveryId, tid)), JSON.stringify(sidecar, null, 2)),
    selectRecoveryCheckpoint: selectTaskRecoveryCheckpoint,
    readRecoveryCheckpoint: readTaskRecoveryCheckpoint,
    verifyAdoptionToken: (token, hash) => createHash5("sha256").update(token).digest("hex") === hash
  };
}
async function teamPublishTaskRecoveryCheckpoint(input, cwd) {
  return publishTaskRecoveryCheckpoint(input, cwd, { readTask: async (tn, tid, c) => {
    const task = await teamReadTask(tn, tid, c);
    return task ? normalizeTask(task) : null;
  }, withTaskLock: withTaskClaimLock });
}
async function teamRequeueRecoveredTask(teamName, cwd, input) {
  return requeueRecoveredTask(input, recoveryTransitionDeps(teamName, cwd));
}
async function teamAdoptRecoveryReservations(teamName, cwd, taskIds, workerName, proof) {
  return adoptRecoveryReservations(taskIds, workerName, proof, recoveryTransitionDeps(teamName, cwd));
}
function normalizeLegacyMailboxMessage(raw) {
  if (raw.type === "notified") return null;
  const messageId = typeof raw.message_id === "string" && raw.message_id.trim() !== "" ? raw.message_id : typeof raw.id === "string" && raw.id.trim() !== "" ? raw.id : "";
  const fromWorker = typeof raw.from_worker === "string" && raw.from_worker.trim() !== "" ? raw.from_worker : typeof raw.from === "string" ? raw.from : "";
  const toWorker = typeof raw.to_worker === "string" && raw.to_worker.trim() !== "" ? raw.to_worker : typeof raw.to === "string" ? raw.to : "";
  const body = typeof raw.body === "string" ? raw.body : "";
  const createdAt = typeof raw.created_at === "string" && raw.created_at.trim() !== "" ? raw.created_at : typeof raw.createdAt === "string" ? raw.createdAt : "";
  if (!messageId || !fromWorker || !toWorker || !body || !createdAt) return null;
  return {
    message_id: messageId,
    from_worker: fromWorker,
    to_worker: toWorker,
    body,
    created_at: createdAt,
    ...typeof raw.notified_at === "string" ? { notified_at: raw.notified_at } : {},
    ...typeof raw.notifiedAt === "string" ? { notified_at: raw.notifiedAt } : {},
    ...typeof raw.delivered_at === "string" ? { delivered_at: raw.delivered_at } : {},
    ...typeof raw.deliveredAt === "string" ? { delivered_at: raw.deliveredAt } : {}
  };
}
async function readLegacyMailboxJsonl(teamName, workerName, cwd) {
  const legacyPath = absPath(cwd, TeamPaths.mailbox(teamName, workerName).replace(/\.json$/i, ".jsonl"));
  if (!existsSync6(legacyPath)) return { worker: workerName, messages: [] };
  try {
    const raw = await readFile4(legacyPath, "utf8");
    const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
    const byMessageId = /* @__PURE__ */ new Map();
    for (const line of lines) {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object") continue;
      const normalized = normalizeLegacyMailboxMessage(parsed);
      if (!normalized) continue;
      byMessageId.set(normalized.message_id, normalized);
    }
    return { worker: workerName, messages: [...byMessageId.values()] };
  } catch {
    return { worker: workerName, messages: [] };
  }
}
async function readMailbox(teamName, workerName, cwd) {
  const p = absPath(cwd, TeamPaths.mailbox(teamName, workerName));
  const mailbox = await readJsonSafe2(p);
  if (mailbox && Array.isArray(mailbox.messages)) {
    return { worker: workerName, messages: mailbox.messages };
  }
  return readLegacyMailboxJsonl(teamName, workerName, cwd);
}
function isStrictCanonicalMailboxRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function isStrictCanonicalMailboxText(value) {
  return typeof value === "string" && value.trim() !== "" && value === value.trim();
}
function isStrictCanonicalMailboxTimestamp(value) {
  return isStrictCanonicalMailboxText(value) && Number.isFinite(Date.parse(value));
}
function materializeStrictCanonicalMailboxMessage(raw) {
  const message = {
    message_id: raw.message_id,
    from_worker: raw.from_worker,
    to_worker: raw.to_worker,
    body: raw.body,
    created_at: raw.created_at
  };
  if ("notified_at" in raw) message.notified_at = raw.notified_at;
  if ("delivered_at" in raw) message.delivered_at = raw.delivered_at;
  return message;
}
function validateStrictCanonicalMailboxMessage(raw, messageIndex) {
  if (!isStrictCanonicalMailboxRecord(raw)) return { kind: "malformed_message", messageIndex, field: "$" };
  if (!isStrictCanonicalMailboxText(raw.message_id)) return { kind: "malformed_message", messageIndex, field: "message_id" };
  if (!isStrictCanonicalMailboxText(raw.from_worker)) return { kind: "malformed_message", messageIndex, field: "from_worker" };
  if (!isStrictCanonicalMailboxText(raw.to_worker)) return { kind: "malformed_message", messageIndex, field: "to_worker" };
  if (!isStrictCanonicalMailboxText(raw.body)) return { kind: "malformed_message", messageIndex, field: "body" };
  if (!isStrictCanonicalMailboxTimestamp(raw.created_at)) return { kind: "malformed_message", messageIndex, field: "created_at" };
  if ("notified_at" in raw && !isStrictCanonicalMailboxTimestamp(raw.notified_at)) {
    return { kind: "malformed_message", messageIndex, field: "notified_at" };
  }
  if ("delivered_at" in raw && !isStrictCanonicalMailboxTimestamp(raw.delivered_at)) {
    return { kind: "malformed_message", messageIndex, field: "delivered_at" };
  }
  return materializeStrictCanonicalMailboxMessage(raw);
}
async function teamReadCanonicalMailboxMessageStrict(teamName, workerName, messageId, cwd) {
  const path4 = absPath(cwd, TeamPaths.mailbox(teamName, workerName));
  let parsed;
  try {
    parsed = JSON.parse(await readFile4(path4, "utf8"));
  } catch (error) {
    const code = error.code;
    return code === "ENOENT" ? { kind: "store_missing" } : { kind: "malformed_store", cause: "json" };
  }
  if (!isStrictCanonicalMailboxRecord(parsed)) return { kind: "malformed_store", cause: "non_object" };
  if (parsed.worker !== workerName) return { kind: "wrong_owner" };
  if (!Array.isArray(parsed.messages)) return { kind: "malformed_store", cause: "messages_non_array" };
  const messages = [];
  for (let messageIndex2 = 0; messageIndex2 < parsed.messages.length; messageIndex2 += 1) {
    const validated = validateStrictCanonicalMailboxMessage(parsed.messages[messageIndex2], messageIndex2);
    if (!("message_id" in validated)) return validated;
    messages.push(validated);
  }
  const indexesByMessageId = /* @__PURE__ */ new Map();
  for (const [messageIndex2, message2] of messages.entries()) {
    const indexes = indexesByMessageId.get(message2.message_id) ?? [];
    indexes.push(messageIndex2);
    indexesByMessageId.set(message2.message_id, indexes);
  }
  const requestedIndexes = indexesByMessageId.get(messageId) ?? [];
  if (requestedIndexes.length > 1) {
    return { kind: "duplicate_message_id", messageId, messageIndexes: requestedIndexes };
  }
  const duplicate = [...indexesByMessageId.entries()].find(([, indexes]) => indexes.length > 1);
  if (duplicate) return { kind: "duplicate_message_id", messageId: duplicate[0], messageIndexes: duplicate[1] };
  if (requestedIndexes.length === 0) return { kind: "message_missing" };
  const messageIndex = requestedIndexes[0];
  const message = messages[messageIndex];
  if (message.to_worker !== workerName) return { kind: "recipient_mismatch", messageIndex };
  if (message.notified_at) return { kind: "replay_suppressed", message: { ...message }, marker: "notified_at" };
  if (message.delivered_at) return { kind: "replay_suppressed", message: { ...message }, marker: "delivered_at" };
  return { kind: "valid", message: { ...message } };
}
async function writeMailbox(teamName, workerName, mailbox, cwd) {
  const p = absPath(cwd, TeamPaths.mailbox(teamName, workerName));
  await writeAtomic3(p, JSON.stringify(mailbox, null, 2));
}
async function teamSendMessage(teamName, fromWorker, toWorker, body, cwd) {
  return withMailboxLock(teamName, toWorker, cwd, async () => {
    const mailbox = await readMailbox(teamName, toWorker, cwd);
    const message = {
      message_id: randomUUID4(),
      from_worker: fromWorker,
      to_worker: toWorker,
      body,
      created_at: (/* @__PURE__ */ new Date()).toISOString()
    };
    mailbox.messages.push(message);
    await writeMailbox(teamName, toWorker, mailbox, cwd);
    await teamAppendEvent(teamName, {
      type: "message_received",
      worker: toWorker,
      message_id: message.message_id
    }, cwd);
    return message;
  });
}
async function teamBroadcast(teamName, fromWorker, body, cwd) {
  const cfg = await teamReadConfig(teamName, cwd);
  if (!cfg) throw new Error(`Team ${teamName} not found`);
  const messages = [];
  for (const worker of cfg.workers) {
    if (worker.name === fromWorker) continue;
    const msg = await teamSendMessage(teamName, fromWorker, worker.name, body, cwd);
    messages.push(msg);
  }
  return messages;
}
async function teamListMailbox(teamName, workerName, cwd) {
  const mailbox = await readMailbox(teamName, workerName, cwd);
  return mailbox.messages;
}
async function teamMarkMessageDelivered(teamName, workerName, messageId, cwd) {
  return withMailboxLock(teamName, workerName, cwd, async () => {
    const mailbox = await readMailbox(teamName, workerName, cwd);
    const msg = mailbox.messages.find((m) => m.message_id === messageId);
    if (!msg) return false;
    msg.delivered_at = (/* @__PURE__ */ new Date()).toISOString();
    await writeMailbox(teamName, workerName, mailbox, cwd);
    return true;
  });
}
async function teamMarkMessageNotified(teamName, workerName, messageId, cwd) {
  return withMailboxLock(teamName, workerName, cwd, async () => {
    const mailbox = await readMailbox(teamName, workerName, cwd);
    const msg = mailbox.messages.find((m) => m.message_id === messageId);
    if (!msg) return false;
    msg.notified_at = (/* @__PURE__ */ new Date()).toISOString();
    await writeMailbox(teamName, workerName, mailbox, cwd);
    return true;
  });
}
async function teamAppendEvent(teamName, event, cwd) {
  const full = {
    event_id: randomUUID4(),
    team: teamName,
    created_at: (/* @__PURE__ */ new Date()).toISOString(),
    ...event
  };
  const p = absPath(cwd, TeamPaths.events(teamName));
  await mkdir3(dirname6(p), { recursive: true });
  await appendFile(p, `${JSON.stringify(full)}
`, "utf8");
  return full;
}
async function teamReadTaskApproval(teamName, taskId, cwd) {
  const p = absPath(cwd, TeamPaths.approval(teamName, taskId));
  return readJsonSafe2(p);
}
async function teamWriteTaskApproval(teamName, approval, cwd) {
  const p = absPath(cwd, TeamPaths.approval(teamName, approval.task_id));
  await writeAtomic3(p, JSON.stringify(approval, null, 2));
  await teamAppendEvent(teamName, {
    type: "approval_decision",
    worker: approval.reviewer,
    task_id: approval.task_id,
    reason: `${approval.status}: ${approval.decision_reason}`
  }, cwd);
}
async function teamGetSummary(teamName, cwd) {
  const startMs = Date.now();
  const cfg = await teamReadConfig(teamName, cwd);
  if (!cfg) return null;
  const tasksStartMs = Date.now();
  const tasks = await teamListTasks(teamName, cwd);
  const tasksLoadedMs = Date.now() - tasksStartMs;
  const counts = {
    total: tasks.length,
    pending: 0,
    blocked: 0,
    in_progress: 0,
    completed: 0,
    failed: 0
  };
  for (const t of tasks) {
    if (t.status in counts) counts[t.status]++;
  }
  const workersStartMs = Date.now();
  const workerEntries = [];
  const nonReporting = [];
  for (const w of cfg.workers) {
    const hb = await teamReadWorkerHeartbeat(teamName, w.name, cwd);
    const baseWorkerSummary = {
      name: w.name,
      working_dir: w.working_dir,
      worktree_repo_root: w.worktree_repo_root,
      worktree_path: w.worktree_path,
      worktree_branch: w.worktree_branch,
      worktree_detached: w.worktree_detached,
      worktree_created: w.worktree_created,
      team_state_root: w.team_state_root
    };
    if (!hb) {
      nonReporting.push(w.name);
      workerEntries.push({ ...baseWorkerSummary, alive: false, lastTurnAt: null, turnsWithoutProgress: 0 });
    } else {
      workerEntries.push({
        ...baseWorkerSummary,
        alive: hb.alive,
        lastTurnAt: hb.last_turn_at,
        turnsWithoutProgress: 0
      });
    }
  }
  const workersPollMs = Date.now() - workersStartMs;
  const performance2 = {
    total_ms: Date.now() - startMs,
    tasks_loaded_ms: tasksLoadedMs,
    workers_polled_ms: workersPollMs,
    task_count: tasks.length,
    worker_count: cfg.workers.length
  };
  return {
    teamName,
    workerCount: cfg.workers.length,
    team_state_root: cfg.team_state_root,
    workspace_mode: cfg.workspace_mode,
    worktree_mode: cfg.worktree_mode,
    tasks: counts,
    workers: workerEntries,
    nonReportingWorkers: nonReporting,
    performance: performance2
  };
}
async function teamWriteShutdownRequest(teamName, workerName, requestedBy, cwd) {
  const p = absPath(cwd, TeamPaths.shutdownRequest(teamName, workerName));
  await writeAtomic3(p, JSON.stringify({ requested_at: (/* @__PURE__ */ new Date()).toISOString(), requested_by: requestedBy }, null, 2));
}
async function teamReadShutdownAck(teamName, workerName, cwd, minUpdatedAt) {
  const ackPath = absPath(cwd, TeamPaths.shutdownAck(teamName, workerName));
  const parsed = await readJsonSafe2(ackPath);
  if (!parsed || parsed.status !== "accept" && parsed.status !== "reject") return null;
  if (typeof minUpdatedAt === "string" && minUpdatedAt.trim() !== "") {
    const minTs = Date.parse(minUpdatedAt);
    const ackTs = Date.parse(parsed.updated_at ?? "");
    if (!Number.isFinite(minTs) || !Number.isFinite(ackTs) || ackTs < minTs) return null;
  }
  return parsed;
}
async function teamReadMonitorSnapshot(teamName, cwd) {
  const p = absPath(cwd, TeamPaths.monitorSnapshot(teamName));
  return readJsonSafe2(p);
}
async function teamWriteMonitorSnapshot(teamName, snapshot, cwd) {
  const p = absPath(cwd, TeamPaths.monitorSnapshot(teamName));
  await writeAtomic3(p, JSON.stringify(snapshot, null, 2));
}
var init_team_ops = __esm({
  "src/team/team-ops.ts"() {
    "use strict";
    init_state_paths();
    init_governance();
    init_governance();
    init_monitor();
    init_process_identity_lock();
    init_contracts();
    init_tasks();
    init_task_recovery_checkpoint();
    init_worker_canonicalization();
  }
});

// src/team/fs-utils.ts
import { writeFileSync as writeFileSync4, existsSync as existsSync7, mkdirSync as mkdirSync4, renameSync, openSync, writeSync, closeSync, realpathSync as realpathSync2, constants } from "fs";
import { dirname as dirname7, resolve as resolve2, relative as relative2, basename as basename3, join as join7 } from "path";
function atomicWriteJson(filePath, data, mode = 384) {
  const dir = dirname7(filePath);
  if (!existsSync7(dir)) mkdirSync4(dir, { recursive: true, mode: 448 });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync4(tmpPath, JSON.stringify(data, null, 2) + "\n", { encoding: "utf-8", mode });
  renameSync(tmpPath, filePath);
}
function ensureDirWithMode(dirPath, mode = 448) {
  if (!existsSync7(dirPath)) mkdirSync4(dirPath, { recursive: true, mode });
}
function safeRealpath(p) {
  try {
    return realpathSync2(p);
  } catch {
    const segments = [];
    let current = resolve2(p);
    while (!existsSync7(current)) {
      segments.unshift(basename3(current));
      const parent = dirname7(current);
      if (parent === current) break;
      current = parent;
    }
    try {
      return join7(realpathSync2(current), ...segments);
    } catch {
      return resolve2(p);
    }
  }
}
function validateResolvedPath(resolvedPath, expectedBase) {
  const absResolved = safeRealpath(resolvedPath);
  const absBase = safeRealpath(expectedBase);
  const rel = relative2(absBase, absResolved);
  if (rel.startsWith("..") || resolve2(absBase, rel) !== absResolved) {
    throw new Error(`Path traversal detected: "${resolvedPath}" escapes base "${expectedBase}"`);
  }
}
var init_fs_utils = __esm({
  "src/team/fs-utils.ts"() {
    "use strict";
  }
});

// src/team/dispatch-queue.ts
import { randomUUID as randomUUID5 } from "crypto";
import { existsSync as existsSync8 } from "fs";
import { mkdir as mkdir4, readFile as readFile5, rm as rm2, stat, writeFile as writeFile2 } from "fs/promises";
import { dirname as dirname8, join as join8 } from "path";
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
function isDispatchTransportPreference(value) {
  return value === "hook_preferred_with_fallback" || value === "transport_direct" || value === "prompt_stdin";
}
function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function isStrictText(value) {
  return typeof value === "string" && value.trim() !== "" && value === value.trim();
}
function isStrictTimestamp(value) {
  return isStrictText(value) && Number.isFinite(Date.parse(value));
}
function isStrictNonNegativeInteger(value) {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
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
  if (!existsSync8(root)) throw new Error(`Team ${teamName} not found`);
  const lockDir = absPath(cwd, TeamPaths.dispatchLockDir(teamName));
  const ownerPath = join8(lockDir, "owner");
  const ownerToken = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const timeoutMs = resolveDispatchLockTimeoutMs(process.env);
  const deadline = Date.now() + timeoutMs;
  let pollMs = DISPATCH_LOCK_INITIAL_POLL_MS;
  await mkdir4(dirname8(lockDir), { recursive: true });
  while (true) {
    try {
      await mkdir4(lockDir, { recursive: false });
      try {
        await writeFile2(ownerPath, ownerToken, "utf8");
      } catch (error) {
        await rm2(lockDir, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      const err = error;
      if (err.code !== "EEXIST") throw error;
      try {
        const info = await stat(lockDir);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await rm2(lockDir, { recursive: true, force: true });
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
      await new Promise((resolve7) => setTimeout(resolve7, Math.floor(pollMs * jitter)));
      pollMs = Math.min(pollMs * 2, DISPATCH_LOCK_MAX_POLL_MS);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      const currentOwner = await readFile5(ownerPath, "utf8");
      if (currentOwner.trim() === ownerToken) {
        await rm2(lockDir, { recursive: true, force: true });
      }
    } catch {
    }
  }
}
async function readDispatchRequestsFromFile(teamName, cwd) {
  const path4 = absPath(cwd, TeamPaths.dispatchRequests(teamName));
  try {
    if (!existsSync8(path4)) return [];
    const raw = await readFile5(path4, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => normalizeDispatchRequest(teamName, entry)).filter((req) => req !== null);
  } catch {
    return [];
  }
}
async function writeDispatchRequestsToFile(teamName, requests, cwd) {
  const path4 = absPath(cwd, TeamPaths.dispatchRequests(teamName));
  const dir = dirname8(path4);
  ensureDirWithMode(dir);
  atomicWriteJson(path4, requests);
}
function normalizeDispatchRequest(teamName, raw, nowIso = (/* @__PURE__ */ new Date()).toISOString()) {
  if (!isDispatchKind(raw.kind)) return null;
  if (typeof raw.to_worker !== "string" || raw.to_worker.trim() === "") return null;
  if (typeof raw.trigger_message !== "string" || raw.trigger_message.trim() === "") return null;
  const status = isDispatchStatus(raw.status) ? raw.status : "pending";
  return {
    request_id: typeof raw.request_id === "string" && raw.request_id.trim() !== "" ? raw.request_id : randomUUID5(),
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
function strictMalformedRow(rowIndex, field) {
  return { kind: "malformed_row", rowIndex, field };
}
function materializeStrictDispatchRequest(raw) {
  const request = {
    request_id: raw.request_id,
    kind: raw.kind,
    team_name: raw.team_name,
    to_worker: raw.to_worker,
    trigger_message: raw.trigger_message,
    transport_preference: raw.transport_preference,
    fallback_allowed: raw.fallback_allowed,
    status: raw.status,
    attempt_count: raw.attempt_count,
    created_at: raw.created_at,
    updated_at: raw.updated_at
  };
  if ("worker_index" in raw) request.worker_index = raw.worker_index;
  if ("pane_id" in raw) request.pane_id = raw.pane_id;
  if ("message_id" in raw) request.message_id = raw.message_id;
  if ("inbox_correlation_key" in raw) request.inbox_correlation_key = raw.inbox_correlation_key;
  if ("notified_at" in raw) request.notified_at = raw.notified_at;
  if ("delivered_at" in raw) request.delivered_at = raw.delivered_at;
  if ("failed_at" in raw) request.failed_at = raw.failed_at;
  if ("last_reason" in raw) request.last_reason = raw.last_reason;
  return request;
}
function validateStrictDispatchRow(teamName, raw, rowIndex) {
  if (!isPlainRecord(raw)) return strictMalformedRow(rowIndex, "$");
  if (!isStrictText(raw.request_id)) return strictMalformedRow(rowIndex, "request_id");
  if (typeof raw.team_name !== "string" || raw.team_name === "") return strictMalformedRow(rowIndex, "team_name");
  if (raw.team_name !== teamName) return { kind: "team_mismatch", rowIndex };
  if (!isDispatchKind(raw.kind)) return { kind: "invalid_kind", rowIndex };
  if (!isStrictText(raw.to_worker)) return strictMalformedRow(rowIndex, "to_worker");
  if (!isStrictText(raw.trigger_message)) return strictMalformedRow(rowIndex, "trigger_message");
  if (!isDispatchTransportPreference(raw.transport_preference)) return strictMalformedRow(rowIndex, "transport_preference");
  if (typeof raw.fallback_allowed !== "boolean") return strictMalformedRow(rowIndex, "fallback_allowed");
  if (!isDispatchStatus(raw.status)) return { kind: "invalid_status", rowIndex };
  if (!isStrictNonNegativeInteger(raw.attempt_count)) return strictMalformedRow(rowIndex, "attempt_count");
  if (!isStrictTimestamp(raw.created_at)) return strictMalformedRow(rowIndex, "created_at");
  if (!isStrictTimestamp(raw.updated_at)) return strictMalformedRow(rowIndex, "updated_at");
  if (raw.kind === "mailbox" && !isStrictText(raw.message_id)) return strictMalformedRow(rowIndex, "message_id");
  if ("message_id" in raw && !isStrictText(raw.message_id)) return strictMalformedRow(rowIndex, "message_id");
  if ("worker_index" in raw && !isStrictNonNegativeInteger(raw.worker_index)) return strictMalformedRow(rowIndex, "worker_index");
  if ("pane_id" in raw && !isStrictText(raw.pane_id)) return strictMalformedRow(rowIndex, "pane_id");
  if ("inbox_correlation_key" in raw && !isStrictText(raw.inbox_correlation_key)) {
    return strictMalformedRow(rowIndex, "inbox_correlation_key");
  }
  if ("notified_at" in raw && !isStrictTimestamp(raw.notified_at)) return strictMalformedRow(rowIndex, "notified_at");
  if ("delivered_at" in raw && !isStrictTimestamp(raw.delivered_at)) return strictMalformedRow(rowIndex, "delivered_at");
  if ("failed_at" in raw && !isStrictTimestamp(raw.failed_at)) return strictMalformedRow(rowIndex, "failed_at");
  if ("last_reason" in raw && typeof raw.last_reason !== "string") return strictMalformedRow(rowIndex, "last_reason");
  return materializeStrictDispatchRequest(raw);
}
async function readStrictDispatchStore(teamName, cwd) {
  const path4 = absPath(cwd, TeamPaths.dispatchRequests(teamName));
  let parsed;
  try {
    parsed = JSON.parse(await readFile5(path4, "utf8"));
  } catch (error) {
    const code = error.code;
    return code === "ENOENT" ? { kind: "store_missing" } : { kind: "malformed_store", cause: "json" };
  }
  if (!Array.isArray(parsed)) return { kind: "malformed_store", cause: "non_array" };
  const rawRows = [];
  const requests = [];
  for (let rowIndex = 0; rowIndex < parsed.length; rowIndex += 1) {
    const raw = parsed[rowIndex];
    const validated = validateStrictDispatchRow(teamName, raw, rowIndex);
    if (!("request_id" in validated)) return validated;
    rawRows.push(raw);
    requests.push(validated);
  }
  return { kind: "valid_store", rawRows, requests };
}
function lookupStrictDispatchRequest(store, requestId) {
  const indexesByRequestId = /* @__PURE__ */ new Map();
  for (const [rowIndex2, request2] of store.requests.entries()) {
    const indexes = indexesByRequestId.get(request2.request_id) ?? [];
    indexes.push(rowIndex2);
    indexesByRequestId.set(request2.request_id, indexes);
  }
  const requestedIndexes = indexesByRequestId.get(requestId) ?? [];
  if (requestedIndexes.length > 1) {
    return { kind: "duplicate_request_id", requestId, rowIndexes: requestedIndexes };
  }
  const duplicateIndexes = [...indexesByRequestId.values()].filter((indexes) => indexes.length > 1).flat();
  if (duplicateIndexes.length > 0) return { kind: "ambiguous_request", rowIndexes: duplicateIndexes };
  if (requestedIndexes.length === 0) return { kind: "request_missing" };
  const rowIndex = requestedIndexes[0];
  const request = store.requests[rowIndex];
  if (request.kind !== "mailbox") return { kind: "invalid_kind", rowIndex };
  return { kind: "valid", request, rowIndex };
}
async function readStrictDispatchRequestWithIndex(teamName, requestId, cwd) {
  const store = await readStrictDispatchStore(teamName, cwd);
  if (store.kind !== "valid_store") return { read: store };
  return { read: lookupStrictDispatchRequest(store, requestId), store };
}
async function readDispatchRequestStrict(teamName, requestId, cwd) {
  const { read } = await readStrictDispatchRequestWithIndex(teamName, requestId, cwd);
  if (read.kind === "valid") return { kind: "valid", request: { ...read.request } };
  return read;
}
async function patchPendingDispatchReason(teamName, requestId, reason, cwd) {
  if (!existsSync8(absPath(cwd, TeamPaths.root(teamName)))) return { kind: "missing" };
  try {
    return await withDispatchLock(teamName, cwd, async () => {
      const { read, store } = await readStrictDispatchRequestWithIndex(teamName, requestId, cwd);
      if (read.kind === "store_missing" || read.kind === "request_missing") return { kind: "missing" };
      if (read.kind !== "valid") return { kind: "unsafe", read };
      if (!store) return { kind: "write_failed" };
      if (read.request.status !== "pending") return { kind: "not_pending", request: { ...read.request } };
      const nowIso = (/* @__PURE__ */ new Date()).toISOString();
      const nextRows = store.rawRows.map((row) => ({ ...row }));
      nextRows[read.rowIndex] = {
        ...nextRows[read.rowIndex],
        last_reason: reason,
        updated_at: nowIso
      };
      try {
        atomicWriteJson(absPath(cwd, TeamPaths.dispatchRequests(teamName)), nextRows);
      } catch {
        return { kind: "write_failed" };
      }
      return {
        kind: "patched",
        request: {
          ...read.request,
          last_reason: reason,
          updated_at: nowIso
        }
      };
    });
  } catch {
    return { kind: "write_failed" };
  }
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
        request_id: randomUUID5(),
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
async function listDispatchRequests(teamName, cwd, opts = {}) {
  const requests = await readDispatchRequestsFromFile(teamName, cwd);
  let filtered = requests;
  if (opts.status) filtered = filtered.filter((req) => req.status === opts.status);
  if (opts.kind) filtered = filtered.filter((req) => req.kind === opts.kind);
  if (opts.to_worker) filtered = filtered.filter((req) => req.to_worker === opts.to_worker);
  if (typeof opts.limit === "number" && opts.limit > 0) filtered = filtered.slice(0, opts.limit);
  return filtered;
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
async function markDispatchRequestDelivered(teamName, requestId, patch = {}, cwd) {
  const current = await readDispatchRequest(teamName, requestId, cwd);
  if (!current) return null;
  if (current.status === "delivered") return current;
  return await transitionDispatchRequest(teamName, requestId, current.status, "delivered", patch, cwd);
}
var OMC_DISPATCH_LOCK_TIMEOUT_ENV, DEFAULT_DISPATCH_LOCK_TIMEOUT_MS, MIN_DISPATCH_LOCK_TIMEOUT_MS, MAX_DISPATCH_LOCK_TIMEOUT_MS, DISPATCH_LOCK_INITIAL_POLL_MS, DISPATCH_LOCK_MAX_POLL_MS, LOCK_STALE_MS;
var init_dispatch_queue = __esm({
  "src/team/dispatch-queue.ts"() {
    "use strict";
    init_state_paths();
    init_fs_utils();
    init_contracts();
    OMC_DISPATCH_LOCK_TIMEOUT_ENV = "OMC_TEAM_DISPATCH_LOCK_TIMEOUT_MS";
    DEFAULT_DISPATCH_LOCK_TIMEOUT_MS = 15e3;
    MIN_DISPATCH_LOCK_TIMEOUT_MS = 1e3;
    MAX_DISPATCH_LOCK_TIMEOUT_MS = 12e4;
    DISPATCH_LOCK_INITIAL_POLL_MS = 25;
    DISPATCH_LOCK_MAX_POLL_MS = 500;
    LOCK_STALE_MS = 5 * 60 * 1e3;
  }
});

// src/team/mailbox-notification-guard.ts
function hasExactText(value) {
  return typeof value === "string" && value !== "" && value === value.trim();
}
function providerForTarget(providerTarget) {
  return providerTarget.startsWith("cmux:") ? "cmux" : "tmux";
}
function dispatchFailureReason(read) {
  switch (read.kind) {
    case "store_missing":
    case "request_missing":
      return "mailbox_request_missing";
    case "team_mismatch":
      return "mailbox_team_identity_mismatch";
    case "duplicate_request_id":
    case "ambiguous_request":
      return "mailbox_request_ambiguous";
    case "malformed_store":
    case "malformed_row":
    case "invalid_kind":
    case "invalid_status":
      return "mailbox_dispatch_store_invalid";
  }
  return "mailbox_dispatch_store_invalid";
}
function mailboxFailureReason(read) {
  switch (read.kind) {
    case "store_missing":
      return "mailbox_message_missing";
    case "malformed_store":
    case "malformed_message":
      return "mailbox_store_invalid";
    case "wrong_owner":
    case "recipient_mismatch":
      return "mailbox_recipient_mismatch";
    case "message_missing":
      return "mailbox_message_missing";
    case "duplicate_message_id":
      return "mailbox_message_ambiguous";
    case "replay_suppressed":
      return "mailbox_replay_suppressed";
  }
  return "mailbox_store_invalid";
}
function resolveCanonicalTarget(config, recipient) {
  if (!hasExactText(config.tmux_session)) return { reason: "mailbox_team_unavailable" };
  const providerTarget = config.tmux_session;
  const provider = providerForTarget(providerTarget);
  if (recipient === "leader-fixed") {
    if (!hasExactText(config.leader_pane_id)) return { reason: "leader_pane_missing_deferred" };
    return {
      target: {
        provider,
        providerTarget,
        recipient,
        recipientRole: "leader",
        paneId: config.leader_pane_id
      }
    };
  }
  if (!Array.isArray(config.workers)) return { reason: "mailbox_target_missing" };
  const worker = canonicalizeWorkers(config.workers).workers.find((candidate) => candidate.name === recipient);
  if (!worker || !hasExactText(worker.pane_id)) return { reason: "mailbox_target_missing" };
  return {
    target: {
      provider,
      providerTarget,
      recipient,
      recipientRole: "worker",
      paneId: worker.pane_id,
      ...typeof worker.index === "number" && Number.isFinite(worker.index) ? { workerIndex: worker.index } : {}
    }
  };
}
function ownershipFailureReason(ownership) {
  switch (ownership.kind) {
    case "unavailable":
      return "mailbox_membership_unresolvable";
    case "foreign":
      return "mailbox_target_foreign";
    case "provider_mismatch":
      return "mailbox_provider_mismatch";
    case "owned":
      return null;
  }
  return "mailbox_membership_unresolvable";
}
function evaluateMailboxNotificationGuard(input, state) {
  if (!hasExactText(input.teamName)) return { kind: "suppress", reason: "mailbox_team_unavailable" };
  if (!hasExactText(input.recipient) || !hasExactText(input.requestId) || !hasExactText(input.messageId) || !hasExactText(input.triggerMessage)) {
    return { kind: "suppress", reason: "mailbox_request_identity_mismatch" };
  }
  if (!state.config) return { kind: "suppress", reason: "mailbox_team_unavailable" };
  if (state.config.name !== input.teamName) return { kind: "suppress", reason: "mailbox_team_identity_mismatch" };
  if (state.dispatch.kind !== "valid") {
    return { kind: "suppress", reason: dispatchFailureReason(state.dispatch) };
  }
  const request = state.dispatch.request;
  if (request.status !== "pending") return { kind: "suppress", reason: "mailbox_request_not_pending" };
  const safePendingRequest = { ...request };
  if (request.request_id !== input.requestId || request.team_name !== input.teamName || request.to_worker !== input.recipient || request.message_id !== input.messageId || request.trigger_message !== input.triggerMessage) {
    return { kind: "suppress", reason: "mailbox_request_identity_mismatch", safePendingRequest };
  }
  const targetResolution = resolveCanonicalTarget(state.config, input.recipient);
  if ("reason" in targetResolution) {
    return { kind: "suppress", reason: targetResolution.reason, safePendingRequest };
  }
  const target = targetResolution.target;
  if (request.pane_id !== target.paneId) {
    return { kind: "suppress", reason: "mailbox_target_metadata_mismatch", safePendingRequest, target };
  }
  if (request.worker_index !== void 0 && request.worker_index !== target.workerIndex) {
    return { kind: "suppress", reason: "mailbox_target_metadata_mismatch", safePendingRequest, target };
  }
  if (state.mailbox.kind !== "valid") {
    return { kind: "suppress", reason: mailboxFailureReason(state.mailbox), safePendingRequest, target };
  }
  const message = state.mailbox.message;
  if (message.message_id !== input.messageId || message.to_worker !== input.recipient) {
    return { kind: "suppress", reason: "mailbox_recipient_mismatch", safePendingRequest, target };
  }
  const ownership = state.ownership;
  if (!ownership) return { kind: "suppress", reason: "mailbox_membership_unresolvable", safePendingRequest, target };
  if (ownership.kind !== "owned") {
    return {
      kind: "suppress",
      reason: ownershipFailureReason(ownership) ?? "mailbox_membership_unresolvable",
      safePendingRequest,
      target
    };
  }
  if (ownership.provider !== target.provider || ownership.providerTarget !== target.providerTarget || ownership.paneId !== target.paneId) {
    return { kind: "suppress", reason: "mailbox_provider_mismatch", safePendingRequest, target };
  }
  return {
    kind: "allow",
    target,
    request: { ...request },
    message: { ...message },
    securityTuple: {
      configName: state.config.name,
      configProviderTarget: state.config.tmux_session,
      recipient: input.recipient,
      recipientRole: target.recipientRole,
      canonicalPaneId: target.paneId,
      ...target.workerIndex !== void 0 ? { canonicalWorkerIndex: target.workerIndex } : {},
      requestId: request.request_id,
      requestKind: "mailbox",
      requestTeamName: request.team_name,
      requestRecipient: request.to_worker,
      requestMessageId: input.messageId,
      requestTriggerMessage: request.trigger_message,
      ...request.pane_id !== void 0 ? { requestPaneId: request.pane_id } : {},
      ...request.worker_index !== void 0 ? { requestWorkerIndex: request.worker_index } : {},
      requestTransportPreference: request.transport_preference,
      requestFallbackAllowed: request.fallback_allowed,
      requestStatus: "pending",
      mailboxOwner: input.recipient,
      mailboxMessageId: message.message_id,
      mailboxRecipient: message.to_worker,
      provider: target.provider,
      providerTarget: target.providerTarget,
      providerPaneId: target.paneId
    }
  };
}
function mailboxNotificationSecurityTupleEquals(left, right) {
  return left.configName === right.configName && left.configProviderTarget === right.configProviderTarget && left.recipient === right.recipient && left.recipientRole === right.recipientRole && left.canonicalPaneId === right.canonicalPaneId && left.canonicalWorkerIndex === right.canonicalWorkerIndex && left.requestId === right.requestId && left.requestKind === right.requestKind && left.requestTeamName === right.requestTeamName && left.requestRecipient === right.requestRecipient && left.requestMessageId === right.requestMessageId && left.requestTriggerMessage === right.requestTriggerMessage && left.requestPaneId === right.requestPaneId && left.requestWorkerIndex === right.requestWorkerIndex && left.requestTransportPreference === right.requestTransportPreference && left.requestFallbackAllowed === right.requestFallbackAllowed && left.requestStatus === right.requestStatus && left.mailboxOwner === right.mailboxOwner && left.mailboxMessageId === right.mailboxMessageId && left.mailboxRecipient === right.mailboxRecipient && left.provider === right.provider && left.providerTarget === right.providerTarget && left.providerPaneId === right.providerPaneId;
}
async function readCurrentMailboxNotificationGuard(input, cwd, dependencies = {}) {
  const readConfig = dependencies.readConfig ?? teamReadConfig;
  const readStrictDispatch = dependencies.readStrictDispatchRequest ?? readDispatchRequestStrict;
  const readStrictMailbox = dependencies.readStrictMailboxMessage ?? teamReadCanonicalMailboxMessageStrict;
  const [config, dispatch, mailbox] = await Promise.all([
    readConfig(input.teamName, cwd).catch(() => null),
    readStrictDispatch(input.teamName, input.requestId, cwd).catch(() => ({ kind: "malformed_store", cause: "json" })),
    readStrictMailbox(input.teamName, input.recipient, input.messageId, cwd).catch(() => ({ kind: "malformed_store", cause: "json" }))
  ]);
  const state = { config, dispatch, mailbox };
  const initial = evaluateMailboxNotificationGuard(input, state);
  if (initial.kind !== "suppress" || initial.reason !== "mailbox_membership_unresolvable" || !initial.target) {
    return initial;
  }
  const ownership = dependencies.verifyProviderOwnership ? await dependencies.verifyProviderOwnership(initial.target).catch(() => ({ kind: "unavailable" })) : { kind: "unavailable" };
  return evaluateMailboxNotificationGuard(input, { ...state, ownership });
}
var init_mailbox_notification_guard = __esm({
  "src/team/mailbox-notification-guard.ts"() {
    "use strict";
    init_dispatch_queue();
    init_team_ops();
    init_worker_canonicalization();
  }
});

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

// src/cli/tmux-utils.ts
import {
  exec,
  execFile,
  execFileSync as execFileSync3,
  execSync,
  spawnSync
} from "child_process";
import { basename as basename4, isAbsolute as isAbsolute3, win32 as win32Path } from "path";
import { promisify } from "util";
function tmuxEnv() {
  const { TMUX: _, PSMUX_SESSION: __, ...env } = process.env;
  return env;
}
function resolveEnv(opts) {
  return opts?.stripTmux ? tmuxEnv() : process.env;
}
function isUnixLikeOnWindows() {
  return process.platform === "win32" && !!(process.env.MSYSTEM || process.env.MINGW_PREFIX);
}
function isNativeWindowsShell() {
  return process.platform === "win32" && !isUnixLikeOnWindows();
}
function quoteForCmd(arg) {
  if (arg.length === 0) return '""';
  if (!/[\s"%^&|<>()]/.test(arg)) return arg;
  return `"${arg.replace(/(["%])/g, "$1$1")}"`;
}
function resolveTmuxInvocation(args) {
  const resolvedBinary = resolveTmuxBinaryPath();
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(resolvedBinary)) {
    const comspec = process.env.COMSPEC || "cmd.exe";
    const commandLine = [quoteForCmd(resolvedBinary), ...args.map(quoteForCmd)].join(" ");
    return {
      command: comspec,
      args: ["/d", "/s", "/c", commandLine]
    };
  }
  return {
    command: resolvedBinary,
    args
  };
}
function tmuxExec(args, opts) {
  const { stripTmux: _, ...execOpts } = opts ?? {};
  const invocation = resolveTmuxInvocation(args);
  return execFileSync3(invocation.command, invocation.args, { encoding: "utf-8", ...execOpts, env: resolveEnv(opts) });
}
async function tmuxExecAsync(args, opts) {
  const { stripTmux: _, timeout, ...rest } = opts ?? {};
  const invocation = resolveTmuxInvocation(args);
  return promisify(execFile)(invocation.command, invocation.args, {
    encoding: "utf-8",
    env: resolveEnv(opts),
    ...timeout !== void 0 ? { timeout } : {},
    ...rest
  });
}
function tmuxShell(command, opts) {
  const { stripTmux: _, ...execOpts } = opts ?? {};
  return execSync(`tmux ${command}`, { encoding: "utf-8", ...execOpts, env: resolveEnv(opts) });
}
async function tmuxShellAsync(command, opts) {
  const { stripTmux: _, timeout, ...rest } = opts ?? {};
  return promisify(exec)(`tmux ${command}`, {
    encoding: "utf-8",
    env: resolveEnv(opts),
    ...timeout !== void 0 ? { timeout } : {},
    ...rest
  });
}
async function tmuxCmdAsync(args, opts) {
  if (args.some((a) => a.includes("#{")) && !isNativeWindowsShell()) {
    const escaped = args.map((a) => "'" + a.replace(/'/g, "'\\''") + "'").join(" ");
    return tmuxShellAsync(escaped, opts);
  }
  return tmuxExecAsync(args, opts);
}
function resolveTmuxBinaryPath() {
  if (process.platform !== "win32") {
    return "tmux";
  }
  try {
    const result = spawnSync("where", ["tmux"], {
      timeout: 5e3,
      encoding: "utf8"
    });
    if (result.status !== 0) return "tmux";
    const candidates = result.stdout?.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) ?? [];
    const first = candidates[0];
    if (first && (isAbsolute3(first) || win32Path.isAbsolute(first))) {
      return first;
    }
  } catch {
  }
  return "tmux";
}
var init_tmux_utils = __esm({
  "src/cli/tmux-utils.ts"() {
    "use strict";
  }
});

// src/cli/tmux-clipboard.ts
function hasUniversalClipboardTerminalFeature(features) {
  return features.split(/\r?\n|,/).map((feature) => feature.trim()).some((feature) => feature === UNIVERSAL_CLIPBOARD_FEATURE || feature.startsWith(`${UNIVERSAL_CLIPBOARD_FEATURE}:`));
}
function configureTmuxClipboardForSession(sessionName2, opts) {
  tmuxExec(["set-option", "-t", sessionName2, "set-clipboard", "on"], opts);
  let terminalFeatures = "";
  try {
    terminalFeatures = String(tmuxExec(["show-options", "-t", sessionName2, "-v", "terminal-features"], opts) ?? "");
  } catch {
    terminalFeatures = "";
  }
  if (!hasUniversalClipboardTerminalFeature(terminalFeatures)) {
    tmuxExec(["set-option", "-at", sessionName2, "terminal-features", `,${UNIVERSAL_CLIPBOARD_FEATURE}`], opts);
  }
}
async function configureTmuxClipboardForSessionAsync(sessionName2, opts) {
  await tmuxExecAsync(["set-option", "-t", sessionName2, "set-clipboard", "on"], opts);
  let terminalFeatures = "";
  try {
    const result = await tmuxExecAsync(["show-options", "-t", sessionName2, "-v", "terminal-features"], opts);
    terminalFeatures = String(result.stdout ?? "");
  } catch {
    terminalFeatures = "";
  }
  if (!hasUniversalClipboardTerminalFeature(terminalFeatures)) {
    await tmuxExecAsync(["set-option", "-at", sessionName2, "terminal-features", `,${UNIVERSAL_CLIPBOARD_FEATURE}`], opts);
  }
}
var UNIVERSAL_CLIPBOARD_FEATURE;
var init_tmux_clipboard = __esm({
  "src/cli/tmux-clipboard.ts"() {
    "use strict";
    init_tmux_utils();
    UNIVERSAL_CLIPBOARD_FEATURE = "*:clipboard";
  }
});

// src/team/tmux-session.ts
var tmux_session_exports = {};
__export(tmux_session_exports, {
  applyMainVerticalLayout: () => applyMainVerticalLayout,
  buildWorkerLaunchSpec: () => buildWorkerLaunchSpec,
  buildWorkerStartCommand: () => buildWorkerStartCommand,
  captureTeamPane: () => captureTeamPane,
  createSession: () => createSession,
  createTeamSession: () => createTeamSession,
  detectTeamMultiplexerContext: () => detectTeamMultiplexerContext,
  getDefaultShell: () => getDefaultShell,
  getWorkerLiveness: () => getWorkerLiveness,
  injectToLeaderPane: () => injectToLeaderPane,
  invokeDirectMailboxEffect: () => invokeDirectMailboxEffect,
  isSessionAlive: () => isSessionAlive,
  isUnixLikeOnWindows: () => isUnixLikeOnWindows2,
  isWorkerAlive: () => isWorkerAlive,
  killSession: () => killSession,
  killTeamPane: () => killTeamPane,
  killTeamSession: () => killTeamSession,
  killWorkerPanes: () => killWorkerPanes,
  listActiveSessions: () => listActiveSessions,
  paneHasActiveTask: () => paneHasActiveTask,
  paneHasTrustPrompt: () => paneHasTrustPrompt,
  paneLooksReady: () => paneLooksReady,
  resolveShellFromCandidates: () => resolveShellFromCandidates,
  resolveSplitPaneWorkerPaneIds: () => resolveSplitPaneWorkerPaneIds,
  resolveSupportedShellAffinity: () => resolveSupportedShellAffinity,
  sanitizeName: () => sanitizeName,
  sendTeamPaneKey: () => sendTeamPaneKey,
  sendToWorker: () => sendToWorker,
  sessionName: () => sessionName,
  shouldAttemptAdaptiveRetry: () => shouldAttemptAdaptiveRetry,
  spawnBridgeInSession: () => spawnBridgeInSession,
  spawnWorkerInPane: () => spawnWorkerInPane,
  splitTeamWorkerPane: () => splitTeamWorkerPane,
  splitTeamWorkerPaneWithEvidence: () => splitTeamWorkerPaneWithEvidence,
  validateTmux: () => validateTmux,
  verifyTeamTargetOwnership: () => verifyTeamTargetOwnership,
  waitForPaneReady: () => waitForPaneReady
});
import { existsSync as existsSync9 } from "fs";
import { createHash as createHash6 } from "crypto";
import { execFile as execFile2 } from "child_process";
import { promisify as promisify2 } from "util";
import { join as join9, basename as basename5, isAbsolute as isAbsolute4, win32 } from "path";
import fs from "fs/promises";
function detectTeamMultiplexerContext(env = process.env) {
  if (env.TMUX) return "tmux";
  if (env.CMUX_SURFACE_ID) return "cmux";
  return "none";
}
function isUnixLikeOnWindows2() {
  return process.platform === "win32" && !!(process.env.MSYSTEM || process.env.MINGW_PREFIX);
}
async function applyMainVerticalLayout(teamTarget) {
  try {
    await tmuxExecAsync(["select-layout", "-t", teamTarget, "main-vertical"]);
  } catch {
  }
  try {
    const widthResult = await tmuxCmdAsync([
      "display-message",
      "-p",
      "-t",
      teamTarget,
      "#{window_width}"
    ]);
    const width = parseInt(widthResult.stdout.trim(), 10);
    if (Number.isFinite(width) && width >= 40) {
      const half = String(Math.floor(width / 2));
      await tmuxExecAsync(["set-window-option", "-t", teamTarget, "main-pane-width", half]);
      await tmuxExecAsync(["select-layout", "-t", teamTarget, "main-vertical"]);
    }
  } catch {
  }
}
function isCmuxContext() {
  return detectTeamMultiplexerContext() === "cmux";
}
function isCmuxSurfaceTarget(value) {
  return isCmuxContext() && typeof value === "string" && value.trim().length > 0 && !value.trim().startsWith("%");
}
async function cmuxExecAsync(args) {
  const result = await execFileAsync("cmux", args, { encoding: "utf-8" });
  return {
    stdout: typeof result.stdout === "string" ? result.stdout : String(result.stdout ?? ""),
    stderr: typeof result.stderr === "string" ? result.stderr : String(result.stderr ?? "")
  };
}
function getCmuxErrorText(error) {
  if (error instanceof Error) {
    const stderr = typeof error.stderr === "string" ? error.stderr : "";
    return `${error.message}
${stderr}`.trim();
  }
  return String(error);
}
function isCmuxDialectFailure(error) {
  const text = getCmuxErrorText(error);
  return /(?:unknown|unrecognized|invalid|unsupported) (?:command|subcommand|option)|no such (?:command|subcommand)|Found argument .*--surface.*wasn't expected|unexpected argument|unexpected option/i.test(text);
}
function redactCmuxFailureMessage(error, argLists) {
  let message = getCmuxErrorText(error);
  const commandNames = new Set(argLists.map((args) => args[0]).filter(Boolean));
  const sensitiveArgs = [...new Set(argLists.flatMap((args) => args).flatMap((arg) => {
    if (!arg || commandNames.has(arg)) return [];
    const fragments = arg.match(/[A-Za-z0-9_./:@=-]{4,}/g) ?? [];
    return [arg, ...fragments];
  }))].sort((a, b) => b.length - a.length);
  for (const arg of sensitiveArgs) {
    message = message.split(arg).join("[redacted]");
  }
  return message;
}
async function cmuxExecPrimaryWithLegacyFallback(primaryArgs, legacyArgs) {
  try {
    return await cmuxExecAsync(primaryArgs);
  } catch (primaryError) {
    if (!isCmuxDialectFailure(primaryError)) {
      const primaryMessage = redactCmuxFailureMessage(primaryError, [primaryArgs]);
      const error = new Error(
        `cmux command failed for current form: current=${primaryArgs[0] ?? "<unknown>"} (${primaryMessage})`
      );
      error.cause = primaryError;
      throw error;
    }
    try {
      return await cmuxExecAsync(legacyArgs);
    } catch (legacyError) {
      const primaryMessage = redactCmuxFailureMessage(primaryError, [primaryArgs, legacyArgs]);
      const legacyMessage = redactCmuxFailureMessage(legacyError, [primaryArgs, legacyArgs]);
      throw new Error(
        `cmux command failed for both current and legacy forms: current=${primaryArgs[0] ?? "<unknown>"} (${primaryMessage}); legacy=${legacyArgs[0] ?? "<unknown>"} (${legacyMessage})`
      );
    }
  }
}
function parseCmuxSurfaceId(output2) {
  const trimmed = output2.trim();
  const uuidMatch = trimmed.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (uuidMatch) return uuidMatch[0];
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const token = tokens[0] === "OK" ? tokens[1] : tokens[0];
  if (!token) throw new Error(`Failed to resolve cmux surface id: "${trimmed}"`);
  return token;
}
async function cmuxSplitSurface(targetSurfaceId, direction, _cwd) {
  const args = ["new-split", direction, "--surface", targetSurfaceId];
  if (process.env.CMUX_WORKSPACE_ID) args.push("--workspace", process.env.CMUX_WORKSPACE_ID);
  const result = await cmuxExecAsync(args);
  let paneId = null;
  try {
    paneId = parseCmuxSurfaceId(result.stdout);
  } catch {
  }
  return { ...result, paneId };
}
async function cmuxSendSurface(surfaceId, text) {
  await cmuxExecPrimaryWithLegacyFallback(
    ["send-surface", "--surface", surfaceId, text],
    ["send", "--surface", surfaceId, text]
  );
}
function normalizeCmuxKey(key) {
  const normalized = key.trim();
  const lower = normalized.toLowerCase();
  switch (lower) {
    case "enter":
    case "return":
    case "tab":
    case "escape":
    case "esc":
    case "backspace":
    case "delete":
    case "up":
    case "down":
    case "left":
    case "right":
      return lower === "return" ? "enter" : lower === "esc" ? "escape" : lower;
    default:
      return normalized;
  }
}
async function cmuxSendSurfaceKey(surfaceId, key) {
  const normalizedKey = normalizeCmuxKey(key);
  await cmuxExecPrimaryWithLegacyFallback(
    ["send-key-surface", "--surface", surfaceId, normalizedKey],
    ["send-key", "--surface", surfaceId, key]
  );
}
async function cmuxCaptureSurface(surfaceId) {
  const result = await cmuxExecPrimaryWithLegacyFallback(
    ["read-screen", "--surface", surfaceId],
    ["capture-pane", "--surface", surfaceId, "--scrollback"]
  );
  return result.stdout;
}
async function cmuxCloseSurface(surfaceId) {
  await cmuxExecAsync(["close-surface", "--surface", surfaceId]);
}
function isExactOpaqueCmuxIdentifier(value) {
  return typeof value === "string" && value.length > 0 && value === value.trim() && !/[\x00-\x1f\x7f\s]/.test(value);
}
function parseCmuxResourceIds(output2, collectionName) {
  let parsed;
  try {
    parsed = JSON.parse(output2);
  } catch {
    return null;
  }
  const entries = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray(parsed[collectionName]) ? parsed[collectionName] : null;
  if (!entries) return null;
  const ids = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const id = entry.id;
    if (!isExactOpaqueCmuxIdentifier(id)) return null;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}
async function verifyTeamTargetOwnership(target, dependencies = defaultMailboxTargetOwnershipDependencies) {
  const expectedProvider = target.providerTarget.startsWith("cmux:") ? "cmux" : "tmux";
  if (target.provider !== expectedProvider) return { kind: "provider_mismatch" };
  if (target.provider === "tmux") {
    if (typeof target.providerTarget !== "string" || target.providerTarget.length === 0 || target.providerTarget !== target.providerTarget.trim() || !TMUX_MAILBOX_TARGET.test(target.providerTarget) || !TMUX_MAILBOX_PANE_ID.test(target.paneId)) {
      return { kind: "unavailable" };
    }
    try {
      const result = await dependencies.tmuxExec([
        "list-panes",
        "-t",
        target.providerTarget,
        "-F",
        "#{pane_id}"
      ]);
      const paneIds = [];
      for (const line of result.stdout.split(/\r?\n/)) {
        const paneId = line.trim();
        if (!paneId) continue;
        if (!TMUX_MAILBOX_PANE_ID.test(paneId)) return { kind: "unavailable" };
        if (!paneIds.includes(paneId)) paneIds.push(paneId);
      }
      if (paneIds.length === 0) return { kind: "unavailable" };
      return paneIds.includes(target.paneId) ? { kind: "owned", provider: "tmux", providerTarget: target.providerTarget, paneId: target.paneId } : { kind: "foreign" };
    } catch {
      return { kind: "unavailable" };
    }
  }
  const workspace = target.providerTarget.slice("cmux:".length);
  if (!isExactOpaqueCmuxIdentifier(workspace) || !isExactOpaqueCmuxIdentifier(target.paneId) || TMUX_MAILBOX_PANE_ID.test(target.paneId)) {
    return { kind: "unavailable" };
  }
  try {
    const panes = parseCmuxResourceIds(
      (await dependencies.cmuxExec(["--json", "list-panes", "--workspace", workspace])).stdout,
      "panes"
    );
    if (!panes || panes.length === 0) return { kind: "unavailable" };
    for (const pane of panes) {
      const surfaces = parseCmuxResourceIds(
        (await dependencies.cmuxExec([
          "--json",
          "list-pane-surfaces",
          "--workspace",
          workspace,
          "--pane",
          pane
        ])).stdout,
        "surfaces"
      );
      if (!surfaces) return { kind: "unavailable" };
      if (surfaces.includes(target.paneId)) {
        return {
          kind: "owned",
          provider: "cmux",
          providerTarget: target.providerTarget,
          paneId: target.paneId
        };
      }
    }
    return { kind: "foreign" };
  } catch {
    return { kind: "unavailable" };
  }
}
async function invokeDirectMailboxEffect(target, message, dependencies = defaultDirectMailboxEffectDependencies) {
  if (!target.paneId || !message) return { kind: "not_attempted", reason: "mailbox_target_missing" };
  if (target.provider === "cmux" && !isCmuxContext()) {
    return { kind: "not_attempted", reason: "mailbox_membership_unresolvable" };
  }
  try {
    const notified = target.recipientRole === "leader" ? await dependencies.sendLeader(target.providerTarget, target.paneId, message) : await dependencies.sendWorker(target.providerTarget, target.paneId, message);
    return notified ? {
      kind: "confirmed",
      transport: "tmux_send_keys",
      reason: target.recipientRole === "leader" ? "leader_pane_notified" : "worker_pane_notified"
    } : {
      kind: "attempted_unconfirmed",
      transport: "tmux_send_keys",
      reason: "notification_delivery_uncertain",
      cause: "returned_false"
    };
  } catch {
    return {
      kind: "attempted_unconfirmed",
      transport: "tmux_send_keys",
      reason: "notification_delivery_uncertain",
      cause: "threw"
    };
  }
}
function getDefaultShell() {
  if (process.platform === "win32" && !isUnixLikeOnWindows2()) {
    return process.env.COMSPEC || "cmd.exe";
  }
  const shell = process.env.SHELL || "/bin/bash";
  const name = basename5(shell.replace(/\\/g, "/")).replace(/\.(exe|cmd|bat)$/i, "");
  if (!SUPPORTED_POSIX_SHELLS.has(name)) {
    return "/bin/sh";
  }
  return shell;
}
function pathEntries(envPath) {
  return (envPath ?? "").split(process.platform === "win32" ? ";" : ":").map((entry) => entry.trim()).filter(Boolean);
}
function pathCandidateNames(candidatePath) {
  const base = basename5(candidatePath.replace(/\\/g, "/"));
  const bare = base.replace(/\.(exe|cmd|bat)$/i, "");
  if (process.platform === "win32") {
    return Array.from(/* @__PURE__ */ new Set([`${bare}.exe`, `${bare}.cmd`, `${bare}.bat`, bare]));
  }
  return Array.from(/* @__PURE__ */ new Set([base, bare]));
}
function resolveShellFromPath(candidatePath) {
  for (const dir of pathEntries(process.env.PATH)) {
    for (const name of pathCandidateNames(candidatePath)) {
      const full = join9(dir, name);
      if (existsSync9(full)) return full;
    }
  }
  return null;
}
function resolveShellFromCandidates(paths, rcFile) {
  for (const p of paths) {
    if (existsSync9(p)) return { shell: p, rcFile };
    const resolvedFromPath = resolveShellFromPath(p);
    if (resolvedFromPath) return { shell: resolvedFromPath, rcFile };
  }
  return null;
}
function resolveSupportedShellAffinity(shellPath) {
  if (!shellPath) return null;
  const name = basename5(shellPath.replace(/\\/g, "/")).replace(/\.(exe|cmd|bat)$/i, "");
  if (name !== "zsh" && name !== "bash") return null;
  if (!existsSync9(shellPath)) return null;
  const home = process.env.HOME ?? "";
  const rcFile = home ? `${home}/.${name}rc` : null;
  return { shell: shellPath, rcFile };
}
function buildWorkerLaunchSpec(shellPath) {
  if (isUnixLikeOnWindows2()) {
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
function commandFingerprint(value) {
  return createHash6("sha256").update(value).digest("hex").slice(0, 12);
}
function redactWorkerStartCommandForLog(command) {
  return command.replace(/\b([A-Za-z_][A-Za-z0-9_]*)='[^']*'/g, "$1='<redacted>'").replace(/set "([A-Za-z_][A-Za-z0-9_]*)=[^"]*"/g, 'set "$1=<redacted>"').replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)='[^']*'/g, "$env:$1='<redacted>'").replace(
    /(--?[A-Za-z0-9_-]*(?:api[-_]?key|token|secret|password|credential|auth)[A-Za-z0-9_-]*)(?:=|\s+)(?:'[^']*'|"[^"]*"|\S+)/gi,
    "$1=<redacted>"
  );
}
function workerStartCommandPreview(command, maxLength = 180) {
  const redacted = redactWorkerStartCommandForLog(command).replace(/\s+/g, " ").trim();
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}\u2026` : redacted;
}
function logWorkerSpawnDiagnostic(message) {
  process.stderr.write(`[team/tmux-session] ${message}
`);
}
function paneCurrentCommandLooksReady(command) {
  const normalized = basename5(command.replace(/\\/g, "/")).replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
  return SUPPORTED_POSIX_SHELLS.has(normalized) || ["cmd", "powershell", "pwsh", "nu", "elvish"].includes(normalized);
}
async function getPaneCurrentCommandStatus(paneId) {
  try {
    const result = await tmuxCmdAsync([
      "display-message",
      "-p",
      "-t",
      paneId,
      "#{pane_dead} #{pane_current_command}"
    ], { timeout: 1e3 });
    const status = result.stdout.trim();
    const [dead, ...commandParts] = status.split(/\s+/);
    return { dead: dead === "1", command: commandParts.join(" ") };
  } catch {
    return null;
  }
}
function paneCurrentCommandLooksSubmitted(command) {
  return command.length > 0 && !paneCurrentCommandLooksReady(command);
}
async function waitForShellReady(paneId, opts = {}) {
  if (isCmuxSurfaceTarget(paneId)) return true;
  const envTimeout = Number.parseInt(process.env.OMC_TEAM_SHELL_READY_TIMEOUT_MS ?? "", 10);
  const timeoutMs = Number.isFinite(opts.timeoutMs) && (opts.timeoutMs ?? 0) > 0 ? Number(opts.timeoutMs) : Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 5e3;
  const pollIntervalMs = Number.isFinite(opts.pollIntervalMs) && (opts.pollIntervalMs ?? 0) > 0 ? Number(opts.pollIntervalMs) : 50;
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const status = await getPaneCurrentCommandStatus(paneId);
    if (status) {
      lastStatus = `${status.dead ? "1" : "0"} ${status.command}`.trim();
      if (status.dead) return false;
      if (paneCurrentCommandLooksReady(status.command)) {
        return true;
      }
    }
    await sleep(pollIntervalMs);
  }
  logWorkerSpawnDiagnostic(
    `worker shell readiness timed out pane=${paneId} timeoutMs=${timeoutMs} lastStatus=${JSON.stringify(lastStatus)}`
  );
  return false;
}
async function verifyWorkerStartCommandDelivered(paneId, startCmd) {
  if (isCmuxSurfaceTarget(paneId)) return true;
  const expected = normalizeTmuxCapture(startCmd);
  const compactExpected = normalizeTmuxCaptureForDelivery(startCmd);
  for (let attempt = 1; attempt <= 5; attempt++) {
    const captured = await capturePaneAsync(paneId, { joinWrappedLines: true });
    const normalizedCaptured = normalizeTmuxCapture(captured);
    if (normalizedCaptured.includes(expected)) {
      return true;
    }
    if (compactExpected.length > 0 && normalizeTmuxCaptureForDelivery(captured).includes(compactExpected)) {
      return true;
    }
    await sleep(50);
  }
  return false;
}
function resolvePositiveIntegerEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
async function verifyWorkerStartCommandSubmitted(paneId, startCmd, opts = {}) {
  if (isCmuxSurfaceTarget(paneId)) return true;
  const expected = normalizeTmuxCapture(startCmd);
  const compactExpected = normalizeTmuxCaptureForDelivery(startCmd);
  const timeoutMs = Number.isFinite(opts.timeoutMs) && (opts.timeoutMs ?? 0) > 0 ? Number(opts.timeoutMs) : resolvePositiveIntegerEnv("OMC_TEAM_START_SUBMIT_TIMEOUT_MS", 8e3);
  const maxPollIntervalMs = Number.isFinite(opts.maxPollIntervalMs) && (opts.maxPollIntervalMs ?? 0) > 0 ? Number(opts.maxPollIntervalMs) : 500;
  let pollIntervalMs = Number.isFinite(opts.initialPollIntervalMs) && (opts.initialPollIntervalMs ?? 0) > 0 ? Number(opts.initialPollIntervalMs) : 50;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const captured = await capturePaneAsync(paneId, { joinWrappedLines: true });
    const normalizedCaptured = normalizeTmuxCapture(captured);
    const commandStillBuffered = normalizedCaptured.includes(expected) || compactExpected.length > 0 && normalizeTmuxCaptureForDelivery(captured).includes(compactExpected);
    if (!commandStillBuffered) {
      return true;
    }
    const status = await getPaneCurrentCommandStatus(paneId);
    if (status?.dead) {
      return false;
    }
    if (status && paneCurrentCommandLooksSubmitted(status.command)) {
      return true;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(pollIntervalMs, remainingMs));
    pollIntervalMs = Math.min(Math.max(pollIntervalMs * 2, pollIntervalMs + 1), maxPollIntervalMs);
  }
  return false;
}
function workerPaneShellCommand() {
  if (process.platform === "win32" && !isUnixLikeOnWindows2()) {
    return [getDefaultShell()];
  }
  return [];
}
function escapeForCmdSet(value) {
  return value.replace(/(["%])/g, "$1$1");
}
function shellNameFromPath(shellPath) {
  const shellName = basename5(shellPath.replace(/\\/g, "/"));
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
  return isAbsolute4(value) || win32.isAbsolute(value);
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
  if (process.platform === "win32" && !isUnixLikeOnWindows2()) {
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
function validateTmux(hasTmuxContext = false) {
  if (hasTmuxContext) {
    return;
  }
  try {
    tmuxShell("-V", { stripTmux: true, timeout: 5e3, stdio: "pipe" });
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
function sessionName(teamName, workerName) {
  return `${TMUX_SESSION_PREFIX}-${sanitizeName(teamName)}-${sanitizeName(workerName)}`;
}
function createSession(teamName, workerName, workingDirectory) {
  const name = sessionName(teamName, workerName);
  try {
    tmuxExec(["kill-session", "-t", name], { stripTmux: true, stdio: "pipe", timeout: 5e3 });
  } catch {
  }
  const args = ["new-session", "-d", "-s", name, "-x", "200", "-y", "50"];
  if (workingDirectory) {
    args.push("-c", workingDirectory);
  }
  args.push(...workerPaneShellCommand());
  tmuxExec(args, { stripTmux: true, stdio: "pipe", timeout: 5e3 });
  try {
    configureTmuxClipboardForSession(name, { stripTmux: true, stdio: "pipe", timeout: 5e3 });
  } catch {
  }
  return name;
}
function killSession(teamName, workerName) {
  const name = sessionName(teamName, workerName);
  try {
    tmuxExec(["kill-session", "-t", name], { stripTmux: true, stdio: "pipe", timeout: 5e3 });
  } catch {
  }
}
function isSessionAlive(teamName, workerName) {
  const name = sessionName(teamName, workerName);
  try {
    tmuxExec(["has-session", "-t", name], { stripTmux: true, stdio: "pipe", timeout: 5e3 });
    return true;
  } catch {
    return false;
  }
}
function listActiveSessions(teamName) {
  const prefix = `${TMUX_SESSION_PREFIX}-${sanitizeName(teamName)}-`;
  try {
    const output2 = tmuxShell("list-sessions -F '#{session_name}'", {
      timeout: 5e3,
      stdio: ["pipe", "pipe", "pipe"]
    });
    return output2.trim().split("\n").filter((s) => s.startsWith(prefix)).map((s) => s.slice(prefix.length));
  } catch {
    return [];
  }
}
function quoteBridgeShellArg(value) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
function spawnBridgeInSession(tmuxSession, bridgeScriptPath, configFilePath) {
  const cmd = [process.execPath, bridgeScriptPath, "--config", configFilePath].map(quoteBridgeShellArg).join(" ");
  tmuxExec(["send-keys", "-t", tmuxSession, cmd, "Enter"], { stripTmux: true, stdio: "pipe", timeout: 5e3 });
}
async function splitTeamWorkerPaneWithEvidence(splitTarget, direction, cwd) {
  const provider = isCmuxContext() ? "cmux" : "tmux";
  try {
    if (provider === "cmux") {
      const splitResult2 = await cmuxSplitSurface(splitTarget, direction, cwd);
      return {
        commandSucceeded: true,
        provider,
        splitTarget,
        direction,
        rawOutput: splitResult2.stdout,
        stderr: splitResult2.stderr,
        paneId: splitResult2.paneId
      };
    }
    const splitType = direction === "right" ? "-h" : "-v";
    const splitResult = await tmuxExecAsync([
      "split-window",
      splitType,
      "-t",
      splitTarget,
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-c",
      cwd,
      ...workerPaneShellCommand()
    ]);
    const rawOutput = splitResult.stdout;
    const candidate = rawOutput.split("\n")[0]?.trim() ?? "";
    return {
      commandSucceeded: true,
      provider,
      splitTarget,
      direction,
      rawOutput,
      stderr: splitResult.stderr,
      paneId: /^%\d+$/.test(candidate) ? candidate : null
    };
  } catch (error) {
    const failure2 = error;
    return {
      commandSucceeded: false,
      provider,
      splitTarget,
      direction,
      rawOutput: typeof failure2.stdout === "string" ? failure2.stdout : "",
      stderr: typeof failure2.stderr === "string" ? failure2.stderr : typeof failure2.message === "string" ? failure2.message : String(error),
      paneId: null
    };
  }
}
async function splitTeamWorkerPane(splitTarget, direction, cwd) {
  return (await splitTeamWorkerPaneWithEvidence(splitTarget, direction, cwd)).paneId;
}
async function createTeamSession(teamName, workerCount, cwd, options = {}) {
  const multiplexerContext = detectTeamMultiplexerContext();
  const inTmux = multiplexerContext === "tmux";
  const inCmux = multiplexerContext === "cmux";
  const useDedicatedWindow = Boolean(options.newWindow && inTmux);
  if (multiplexerContext === "none") {
    validateTmux();
  }
  const envPaneIdRaw = (process.env.TMUX_PANE ?? "").trim();
  const envPaneId = /^%\d+$/.test(envPaneIdRaw) ? envPaneIdRaw : "";
  let sessionAndWindow = "";
  let leaderPaneId = envPaneId;
  let sessionMode = inTmux ? "split-pane" : "detached-session";
  if (inCmux) {
    const cmuxLeaderSurface = (process.env.CMUX_SURFACE_ID ?? "").trim();
    if (!cmuxLeaderSurface) {
      throw new Error("CMUX_SURFACE_ID is required to create a cmux team session");
    }
    sessionAndWindow = `cmux:${process.env.CMUX_WORKSPACE_ID || "workspace"}`;
    leaderPaneId = cmuxLeaderSurface;
    sessionMode = "split-pane";
  } else if (!inTmux) {
    const detachedSessionName = `${TMUX_SESSION_PREFIX}-${sanitizeName(teamName)}-${Date.now().toString(36)}`;
    const detachedResult = await tmuxExecAsync([
      "new-session",
      "-d",
      "-P",
      "-F",
      "#S:0 #{pane_id}",
      "-s",
      detachedSessionName,
      "-c",
      cwd,
      ...workerPaneShellCommand()
    ], { stripTmux: true });
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
      const targetedContextResult = await tmuxExecAsync([
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
    const contextResult = await tmuxCmdAsync([
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
    const newWindowResult = await tmuxExecAsync([
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
  if (!inCmux) {
    try {
      await configureTmuxClipboardForSessionAsync(resolvedSessionName);
    } catch {
    }
  }
  const workerPaneIds = [];
  if (workerCount <= 0) {
    if (!inCmux) {
      try {
        await tmuxExecAsync(["set-option", "-t", resolvedSessionName, "mouse", "on"]);
      } catch {
      }
      if (sessionMode !== "dedicated-window") {
        try {
          await tmuxExecAsync(["select-pane", "-t", leaderPaneId]);
        } catch {
        }
      }
    }
    return { sessionName: teamTarget, leaderPaneId, workerPaneIds, sessionMode };
  }
  for (let i = 0; i < workerCount; i++) {
    const splitTarget = i === 0 ? leaderPaneId : workerPaneIds[i - 1];
    if (inCmux) {
      const direction = i === 0 ? "right" : "down";
      const split = await cmuxSplitSurface(splitTarget, direction, cwd);
      if (!split.paneId) throw new Error(`Failed to resolve cmux surface id: ${JSON.stringify(split.stdout.trim())}`);
      workerPaneIds.push(split.paneId);
      continue;
    }
    const splitType = i === 0 ? "-h" : "-v";
    const splitResult = await tmuxCmdAsync([
      "split-window",
      splitType,
      "-t",
      splitTarget,
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-c",
      cwd,
      ...workerPaneShellCommand()
    ]);
    const paneId = splitResult.stdout.split("\n")[0]?.trim();
    if (paneId) {
      workerPaneIds.push(paneId);
    }
  }
  if (!inCmux) {
    await applyMainVerticalLayout(teamTarget);
    try {
      await tmuxExecAsync(["set-option", "-t", resolvedSessionName, "mouse", "on"]);
    } catch {
    }
    if (sessionMode !== "dedicated-window") {
      try {
        await tmuxExecAsync(["select-pane", "-t", leaderPaneId]);
      } catch {
      }
    }
  }
  await Promise.all(workerPaneIds.map((workerPaneId) => waitForShellReady(workerPaneId, { timeoutMs: 5e3 })));
  return { sessionName: teamTarget, leaderPaneId, workerPaneIds, sessionMode };
}
async function spawnWorkerInPane(sessionName2, paneId, config) {
  validateTeamName(config.teamName);
  const startCmd = buildWorkerStartCommand(config);
  const fingerprint = commandFingerprint(startCmd);
  const preview = workerStartCommandPreview(startCmd);
  logWorkerSpawnDiagnostic(
    `worker start delivery begin session=${sessionName2} pane=${paneId} worker=${config.workerName} cmdSha=${fingerprint} cmdPreview=${JSON.stringify(preview)}`
  );
  if (isCmuxSurfaceTarget(paneId)) {
    try {
      await cmuxSendSurface(paneId, startCmd);
      await cmuxSendSurfaceKey(paneId, "Enter");
      logWorkerSpawnDiagnostic(
        `worker start delivery sent session=${sessionName2} pane=${paneId} worker=${config.workerName} cmdSha=${fingerprint} sendStatus=0`
      );
      return;
    } catch (error) {
      logWorkerSpawnDiagnostic(
        `worker start delivery failed session=${sessionName2} pane=${paneId} worker=${config.workerName} cmdSha=${fingerprint} sendStatus=1 error=${JSON.stringify(error instanceof Error ? error.message : String(error))}`
      );
      throw error;
    }
  }
  const shellReady = await waitForShellReady(paneId);
  if (!shellReady) {
    const reason = `worker_start_shell_not_ready:${config.workerName}:${paneId}:${fingerprint}`;
    logWorkerSpawnDiagnostic(
      `worker start delivery failed session=${sessionName2} pane=${paneId} worker=${config.workerName} cmdSha=${fingerprint} sendStatus=not_attempted reason=shell_not_ready`
    );
    throw new Error(reason);
  }
  try {
    const sendResult = await tmuxExecAsync([
      "send-keys",
      "-t",
      paneId,
      "-l",
      startCmd
    ], { timeout: 5e3 });
    logWorkerSpawnDiagnostic(
      `worker start send-keys literal session=${sessionName2} pane=${paneId} worker=${config.workerName} cmdSha=${fingerprint} sendStatus=0 stderr=${JSON.stringify(sendResult.stderr.trim())}`
    );
  } catch (error) {
    logWorkerSpawnDiagnostic(
      `worker start send-keys literal failed session=${sessionName2} pane=${paneId} worker=${config.workerName} cmdSha=${fingerprint} sendStatus=1 error=${JSON.stringify(error instanceof Error ? error.message : String(error))}`
    );
    throw error;
  }
  const delivered = await verifyWorkerStartCommandDelivered(paneId, startCmd);
  if (!delivered) {
    const reason = `worker_start_delivery_unverified:${config.workerName}:${paneId}:${fingerprint}`;
    logWorkerSpawnDiagnostic(
      `worker start delivery verification failed session=${sessionName2} pane=${paneId} worker=${config.workerName} cmdSha=${fingerprint} cmdPreview=${JSON.stringify(preview)}`
    );
    throw new Error(reason);
  }
  try {
    const enterResult = await tmuxExecAsync(["send-keys", "-t", paneId, "Enter"], { timeout: 5e3 });
    logWorkerSpawnDiagnostic(
      `worker start submit key sent session=${sessionName2} pane=${paneId} worker=${config.workerName} cmdSha=${fingerprint} sendStatus=0 stderr=${JSON.stringify(enterResult.stderr.trim())}`
    );
    const submitted = await verifyWorkerStartCommandSubmitted(paneId, startCmd);
    if (!submitted) {
      const reason = `worker_start_submit_unverified:${config.workerName}:${paneId}:${fingerprint}`;
      logWorkerSpawnDiagnostic(
        `worker start submit verification failed session=${sessionName2} pane=${paneId} worker=${config.workerName} cmdSha=${fingerprint} cmdPreview=${JSON.stringify(preview)}`
      );
      throw new Error(reason);
    }
  } catch (error) {
    logWorkerSpawnDiagnostic(
      `worker start submit failed session=${sessionName2} pane=${paneId} worker=${config.workerName} cmdSha=${fingerprint} sendStatus=1 error=${JSON.stringify(error instanceof Error ? error.message : String(error))}`
    );
    throw error;
  }
}
function normalizeTmuxCapture(value) {
  return value.replace(/\r/g, "").replace(/\s+/g, " ").trim();
}
function normalizeTmuxCaptureForDelivery(value) {
  return value.replace(/\r/g, "").replace(/\s+/g, "");
}
async function capturePaneAsync(paneId, opts = {}) {
  try {
    if (isCmuxSurfaceTarget(paneId)) {
      return await cmuxCaptureSurface(paneId);
    }
    const args = opts.joinWrappedLines ? ["capture-pane", "-J", "-t", paneId, "-p", "-S", "-80"] : ["capture-pane", "-t", paneId, "-p", "-S", "-80"];
    const result = await tmuxExecAsync(args);
    return result.stdout;
  } catch {
    return "";
  }
}
async function captureTeamPane(paneId) {
  return capturePaneAsync(paneId);
}
async function sendTeamPaneKey(paneId, key) {
  if (isCmuxSurfaceTarget(paneId)) {
    await cmuxSendSurfaceKey(paneId, key);
    return;
  }
  await tmuxExecAsync(["send-keys", "-t", paneId, key]);
}
async function killTeamPane(paneId) {
  if (isCmuxSurfaceTarget(paneId)) {
    await cmuxCloseSurface(paneId);
    return;
  }
  await tmuxExecAsync(["kill-pane", "-t", paneId]);
}
function detectPaneTrustPromptKind(captured) {
  const lines = captured.split("\n").map((l) => l.replace(/\r/g, "").trim()).filter((l) => l.length > 0);
  const tail = lines.slice(-12);
  const hasDirectoryQuestion = tail.some((l) => /Do you trust the contents of this directory\?/i.test(l));
  const hasDirectoryChoices = tail.some((l) => /Yes,\s*continue|No,\s*quit|Press enter to continue/i.test(l));
  if (hasDirectoryQuestion && hasDirectoryChoices) return "directory";
  const hasHookReview = tail.some((l) => /Hooks need review/i.test(l));
  const hasHookTrustChoice = tail.some((l) => /Continue without trusting/i.test(l));
  const hasHookConfirm = tail.some((l) => /Press enter to confirm or esc to go back/i.test(l));
  if (hasHookReview && hasHookTrustChoice && hasHookConfirm) return "codex_hooks";
  return null;
}
function paneHasTrustPrompt(captured) {
  return detectPaneTrustPromptKind(captured) !== null;
}
function paneHasClaudeStartupBanner(captured) {
  const lines = captured.split("\n").map((line) => line.replace(/\r/g, "").trim()).filter((line) => line.length > 0).slice(-20);
  const lastPromptIndex = lines.findLastIndex(paneLineLooksLikeIdlePrompt);
  if (lastPromptIndex >= 0) return false;
  const lastStartupBannerIndex = lines.findLastIndex(
    (line) => /bypass\s+permissions\s+on/i.test(line) || /shift\+tab\s+to\s+cycle/i.test(line) || /^⏵⏵\s+/.test(line)
  );
  return lastStartupBannerIndex >= 0;
}
function paneIsBootstrapping(captured) {
  if (paneHasClaudeStartupBanner(captured)) return true;
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
function paneLineLooksLikeIdlePrompt(line) {
  return /^\s*(?:[│┃║▌▐▏▕╎┆┊]\s*)?[›>❯]\s*/u.test(line);
}
function paneLooksReady(captured) {
  const content = captured.trimEnd();
  if (content === "") return false;
  const lines = content.split("\n").map((line) => line.replace(/\r/g, "").trimEnd()).filter((line) => line.trim() !== "");
  if (lines.length === 0) return false;
  if (paneHasTrustPrompt(content)) return true;
  if (paneIsBootstrapping(content)) return false;
  const lastLine = lines[lines.length - 1];
  if (paneLineLooksLikeIdlePrompt(lastLine)) return true;
  return lines.some(paneLineLooksLikeIdlePrompt);
}
async function waitForPaneReady(paneId, opts = {}) {
  const envTimeout = Number.parseInt(process.env.OMC_SHELL_READY_TIMEOUT_MS ?? "", 10);
  const timeoutMs = Number.isFinite(opts.timeoutMs) && (opts.timeoutMs ?? 0) > 0 ? Number(opts.timeoutMs) : Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 3e4;
  const pollIntervalMs = Number.isFinite(opts.pollIntervalMs) && (opts.pollIntervalMs ?? 0) > 0 ? Number(opts.pollIntervalMs) : 250;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const captured = await capturePaneAsync(paneId);
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
  if (isCmuxSurfaceTarget(paneId)) return false;
  try {
    const result = await tmuxCmdAsync(["display-message", "-t", paneId, "-p", "#{pane_in_mode}"]);
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
    const sendKey = async (key) => {
      await sendTeamPaneKey(paneId, key);
    };
    if (await paneInCopyMode(paneId)) {
      return false;
    }
    const initialCapture = await capturePaneAsync(paneId);
    if (paneHasClaudeStartupBanner(initialCapture)) {
      return false;
    }
    const paneBusy = paneHasActiveTask(initialCapture);
    const trustPromptKind = detectPaneTrustPromptKind(initialCapture);
    if (trustPromptKind === "directory") {
      await sendKey("C-m");
      await sleep(120);
      await sendKey("C-m");
      await sleep(200);
    } else if (trustPromptKind === "codex_hooks") {
      await sendKey("3");
      await sleep(120);
      await sendKey("C-m");
      await sleep(200);
    }
    if (isCmuxSurfaceTarget(paneId)) {
      await cmuxSendSurface(paneId, message);
    } else {
      await tmuxExecAsync(["send-keys", "-t", paneId, "-l", "--", message]);
    }
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
      const checkCapture = await capturePaneAsync(paneId);
      if (!paneTailContainsLiteralLine(checkCapture, message)) return true;
      await sleep(140);
    }
    if (await paneInCopyMode(paneId)) {
      return false;
    }
    const finalCapture = await capturePaneAsync(paneId);
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
      await sleep(80);
      if (await paneInCopyMode(paneId)) {
        return false;
      }
      if (isCmuxSurfaceTarget(paneId)) {
        await cmuxSendSurface(paneId, message);
      } else {
        await tmuxExecAsync(["send-keys", "-t", paneId, "-l", "--", message]);
      }
      await sleep(120);
      for (let round = 0; round < 4; round++) {
        await sendKey("C-m");
        await sleep(180);
        await sendKey("C-m");
        await sleep(140);
        const retryCapture = await capturePaneAsync(paneId);
        if (!paneTailContainsLiteralLine(retryCapture, message)) return true;
      }
    }
    if (await paneInCopyMode(paneId)) {
      return false;
    }
    await sendKey("C-m");
    await sleep(120);
    await sendKey("C-m");
    await sleep(140);
    const finalCheckCapture = await capturePaneAsync(paneId);
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
    if (await paneInCopyMode(leaderPaneId)) {
      return false;
    }
    const captured = await capturePaneAsync(leaderPaneId);
    if (paneHasActiveTask(captured)) {
      if (isCmuxSurfaceTarget(leaderPaneId)) {
        await cmuxSendSurfaceKey(leaderPaneId, "C-c");
      } else {
        await tmuxExecAsync(["send-keys", "-t", leaderPaneId, "C-c"]);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  } catch {
  }
  return sendToWorker(sessionName2, leaderPaneId, prefixed);
}
function isTmuxPaneNotFoundError(error) {
  const err = error;
  const text = [err?.stderr, err?.stdout, err?.message].filter((part) => typeof part === "string").join("\n").toLowerCase();
  return /can't find pane|can't find window|can't find session|no such pane|pane not found|unknown pane/.test(text);
}
async function getWorkerLiveness(paneId) {
  if (isCmuxSurfaceTarget(paneId)) {
    try {
      await cmuxCaptureSurface(paneId);
      return "alive";
    } catch {
      return "unknown";
    }
  }
  try {
    const result = await tmuxCmdAsync([
      "display-message",
      "-t",
      paneId,
      "-p",
      "#{pane_dead}"
    ]);
    return result.stdout.trim() === "0" ? "alive" : "dead";
  } catch (error) {
    return isTmuxPaneNotFoundError(error) ? "dead" : "unknown";
  }
}
async function isWorkerAlive(paneId) {
  return await getWorkerLiveness(paneId) === "alive";
}
async function killWorkerPanes(opts) {
  const { paneIds, leaderPaneId, teamName, cwd, graceMs = 1e4 } = opts;
  if (!paneIds.length) return;
  const shutdownPath = join9(getOmcRoot(cwd), "state", "team", teamName, "shutdown.json");
  try {
    await fs.writeFile(shutdownPath, JSON.stringify({ requestedAt: Date.now() }));
    const aliveChecks = await Promise.all(paneIds.map((id) => isWorkerAlive(id)));
    if (aliveChecks.some((alive) => alive)) {
      await sleep(graceMs);
    }
  } catch {
  }
  for (const paneId of paneIds) {
    if (paneId === leaderPaneId) continue;
    try {
      await killTeamPane(paneId);
    } catch {
    }
  }
}
function isPaneId(value) {
  return typeof value === "string" && (/^%\d+$/.test(value.trim()) || isCmuxSurfaceTarget(value));
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
    const paneResult = await tmuxCmdAsync(["list-panes", "-t", sessionName2, "-F", "#{pane_id}"]);
    return dedupeWorkerPaneIds(
      [...resolved, ...paneResult.stdout.split("\n").map((paneId) => paneId.trim())],
      leaderPaneId
    );
  } catch {
    return resolved;
  }
}
async function killTeamSession(sessionName2, workerPaneIds, leaderPaneId, options = {}) {
  const sessionMode = options.sessionMode ?? (sessionName2.includes(":") ? "split-pane" : "detached-session");
  if (sessionMode === "split-pane") {
    if (!workerPaneIds?.length) return;
    for (const id of workerPaneIds) {
      if (id === leaderPaneId) continue;
      try {
        await killTeamPane(id);
      } catch {
      }
    }
    return;
  }
  if (sessionMode === "dedicated-window") {
    try {
      await tmuxExecAsync(["kill-window", "-t", sessionName2]);
    } catch {
    }
    return;
  }
  const sessionTarget = sessionName2.split(":")[0] ?? sessionName2;
  if (process.env.OMC_TEAM_ALLOW_KILL_CURRENT_SESSION !== "1" && process.env.TMUX) {
    try {
      const current = await tmuxCmdAsync(["display-message", "-p", "#S"]);
      const currentSessionName = current.stdout.trim();
      if (currentSessionName && currentSessionName === sessionTarget) {
        return;
      }
    } catch {
    }
  }
  try {
    await tmuxExecAsync(["kill-session", "-t", sessionTarget]);
  } catch {
  }
}
var sleep, execFileAsync, TMUX_SESSION_PREFIX, TMUX_MAILBOX_PANE_ID, TMUX_MAILBOX_TARGET, defaultMailboxTargetOwnershipDependencies, defaultDirectMailboxEffectDependencies, SUPPORTED_POSIX_SHELLS, ZSH_CANDIDATES, BASH_CANDIDATES, DANGEROUS_LAUNCH_BINARY_CHARS;
var init_tmux_session = __esm({
  "src/team/tmux-session.ts"() {
    "use strict";
    init_team_name();
    init_worktree_paths();
    init_tmux_utils();
    init_tmux_clipboard();
    sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    execFileAsync = promisify2(execFile2);
    TMUX_SESSION_PREFIX = "omc-team";
    TMUX_MAILBOX_PANE_ID = /^%\d+$/;
    TMUX_MAILBOX_TARGET = /^[^\s:]+(?::[^\s:]+)?$/;
    defaultMailboxTargetOwnershipDependencies = {
      tmuxExec: (args) => tmuxExecAsync(args),
      cmuxExec: cmuxExecAsync
    };
    defaultDirectMailboxEffectDependencies = {
      sendWorker: sendToWorker,
      sendLeader: injectToLeaderPane
    };
    SUPPORTED_POSIX_SHELLS = /* @__PURE__ */ new Set(["sh", "bash", "zsh", "fish", "ksh"]);
    ZSH_CANDIDATES = ["/bin/zsh", "/usr/bin/zsh", "/usr/local/bin/zsh", "/opt/homebrew/bin/zsh"];
    BASH_CANDIDATES = ["/bin/bash", "/usr/bin/bash"];
    DANGEROUS_LAUNCH_BINARY_CHARS = /[;&|`$()<>\n\r\t\0]/;
  }
});

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
var init_swallowed_error = __esm({
  "src/lib/swallowed-error.ts"() {
    "use strict";
  }
});

// src/team/mcp-comm.ts
import { realpathSync as realpathSync3 } from "node:fs";
import { basename as basename6, dirname as dirname9, join as join10 } from "node:path";
function isConfirmedNotification(outcome) {
  if (!outcome.ok) return false;
  if (outcome.transport !== "hook") return true;
  return outcome.reason !== "queued_for_hook_dispatch";
}
function isLeaderPaneMissingMailboxPersistedOutcome(request, outcome) {
  return request.to_worker === "leader-fixed" && outcome.ok && outcome.reason === "leader_pane_missing_mailbox_persisted";
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
function isExactText(value) {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}
function canonicalNotificationLockIdentity(lockPath) {
  try {
    return realpathSync3(lockPath);
  } catch {
    try {
      return join10(realpathSync3(dirname9(lockPath)), basename6(lockPath));
    } catch {
      return lockPath;
    }
  }
}
function managedOutcome(ok, transport, reason) {
  return { ok, transport, reason, notification_managed: true };
}
function defaultMailboxNotificationDependencies() {
  return {
    readGuard: (input, cwd) => readCurrentMailboxNotificationGuard(input, cwd, {
      verifyProviderOwnership: verifyTeamTargetOwnership
    }),
    readStrictDispatch: readDispatchRequestStrict,
    readStrictMailbox: teamReadCanonicalMailboxMessageStrict,
    invokeEffect: invokeDirectMailboxEffect,
    markMailbox: teamMarkMessageNotified,
    markDispatch: (teamName, requestId, cwd) => markDispatchRequestNotified(teamName, requestId, {}, cwd),
    patchPendingReason: patchPendingDispatchReason,
    withRequestLock: (lockPath, fn) => withProcessIdentityFileLock(lockPath, fn)
  };
}
function mergeMailboxNotificationDependencies(overrides) {
  return { ...defaultMailboxNotificationDependencies(), ...overrides };
}
function requestMatchesAttempt(request, params) {
  return request.request_id === params.requestId && request.kind === "mailbox" && request.team_name === params.teamName && request.to_worker === params.recipient && request.message_id === params.messageId;
}
function mailboxResultMatchesAttempt(read, params) {
  if (read.kind !== "valid" && read.kind !== "replay_suppressed") return false;
  return read.message.message_id === params.messageId && read.message.to_worker === params.recipient;
}
async function readMailboxMarkerState(params, deps) {
  try {
    const [dispatch, mailbox] = await Promise.all([
      deps.readStrictDispatch(params.teamName, params.requestId, params.cwd),
      deps.readStrictMailbox(params.teamName, params.recipient, params.messageId, params.cwd)
    ]);
    const dispatchMatches = dispatch.kind === "valid" && requestMatchesAttempt(dispatch.request, params);
    const mailboxMatches = mailboxResultMatchesAttempt(mailbox, params);
    return {
      safe: dispatchMatches && mailboxMatches,
      dispatchMarked: dispatchMatches && (dispatch.request.status === "notified" || dispatch.request.status === "delivered"),
      mailboxMarked: mailboxMatches && mailbox.kind === "replay_suppressed"
    };
  } catch {
    return { safe: false, dispatchMarked: false, mailboxMarked: false };
  }
}
async function writeAndVerifyMailboxMarkers(params, deps) {
  const before = await readMailboxMarkerState(params, deps);
  if (!before.safe) return before;
  const writes = [];
  if (!before.mailboxMarked) {
    writes.push(deps.markMailbox(params.teamName, params.recipient, params.messageId, params.cwd).catch(() => false));
  }
  if (!before.dispatchMarked) {
    writes.push(deps.markDispatch(params.teamName, params.requestId, params.cwd).catch(() => null));
  }
  await Promise.all(writes);
  return readMailboxMarkerState(params, deps);
}
function markerOutcome(state, confirmationReason) {
  if (state.mailboxMarked && state.dispatchMarked) {
    return managedOutcome(true, "tmux_send_keys", confirmationReason);
  }
  if (state.mailboxMarked) {
    return managedOutcome(true, "tmux_send_keys", "notification_commit_dispatch_failed");
  }
  if (state.dispatchMarked) {
    return managedOutcome(true, "tmux_send_keys", "notification_commit_mailbox_failed");
  }
  return managedOutcome(false, "tmux_send_keys", "notification_commit_uncertain");
}
async function persistPendingReason(params, deps, reason, canPatch) {
  if (!canPatch) return managedOutcome(false, "none", reason);
  try {
    const patched = await deps.patchPendingReason(params.teamName, params.requestId, reason, params.cwd);
    if (patched.kind === "patched") {
      if (reason === "leader_pane_missing_deferred") {
        return managedOutcome(true, "mailbox", "leader_pane_missing_mailbox_persisted");
      }
      return managedOutcome(false, "none", reason);
    }
  } catch {
  }
  return managedOutcome(false, "none", "pending_reason_persist_failed");
}
async function suppressFromGuard(params, deps, guard) {
  return persistPendingReason(params, deps, guard.reason, !!guard.safePendingRequest);
}
async function reconcileTombstone(params, deps, key, tombstone) {
  let state = await readMailboxMarkerState(params, deps);
  if (tombstone.cause === "commit") {
    state = await writeAndVerifyMailboxMarkers(params, deps);
    if (state.mailboxMarked && state.dispatchMarked) {
      mailboxNotificationTombstones.delete(key);
    }
    return markerOutcome(state, tombstone.confirmationReason);
  }
  if (state.mailboxMarked || state.dispatchMarked) {
    mailboxNotificationTombstones.delete(key);
    return markerOutcome(state, "worker_pane_notified");
  }
  return managedOutcome(false, "tmux_send_keys", "notification_delivery_uncertain");
}
async function runMailboxNotificationAttempt(params, overrides = {}) {
  if (!isExactText(params.teamName) || !isExactText(params.recipient) || !isExactText(params.requestId) || !isExactText(params.messageId) || !isExactText(params.triggerMessage)) {
    return managedOutcome(false, "none", "mailbox_request_identity_mismatch");
  }
  const deps = mergeMailboxNotificationDependencies(overrides);
  const lockPath = absPath(params.cwd, TeamPaths.mailboxNotificationLock(params.teamName, params.requestId));
  const key = canonicalNotificationLockIdentity(lockPath);
  try {
    return await deps.withRequestLock(lockPath, async () => {
      const existingTombstone = mailboxNotificationTombstones.get(key);
      if (existingTombstone) return reconcileTombstone(params, deps, key, existingTombstone);
      const guardInput = {
        teamName: params.teamName,
        recipient: params.recipient,
        requestId: params.requestId,
        messageId: params.messageId,
        triggerMessage: params.triggerMessage
      };
      const current = await deps.readGuard(guardInput, params.cwd);
      if (current.kind === "suppress") return suppressFromGuard(params, deps, current);
      const final = await deps.readGuard(guardInput, params.cwd);
      if (final.kind === "suppress") return suppressFromGuard(params, deps, final);
      if (!mailboxNotificationSecurityTupleEquals(current.securityTuple, final.securityTuple)) {
        return persistPendingReason(params, deps, "mailbox_security_tuple_changed", true);
      }
      mailboxNotificationTombstones.set(key, { cause: "delivery" });
      let effect;
      try {
        effect = await deps.invokeEffect(final.target, final.request.trigger_message);
      } catch {
        effect = {
          kind: "attempted_unconfirmed",
          transport: "tmux_send_keys",
          reason: "notification_delivery_uncertain",
          cause: "threw"
        };
      }
      if (effect.kind === "not_attempted") {
        mailboxNotificationTombstones.delete(key);
        return persistPendingReason(params, deps, effect.reason, true);
      }
      if (effect.kind === "attempted_unconfirmed") {
        return managedOutcome(false, effect.transport, "notification_delivery_uncertain");
      }
      mailboxNotificationTombstones.set(key, { cause: "commit", confirmationReason: effect.reason });
      const markers = await writeAndVerifyMailboxMarkers(params, deps);
      const outcome = markerOutcome(markers, effect.reason);
      if (markers.mailboxMarked && markers.dispatchMarked) mailboxNotificationTombstones.delete(key);
      return outcome;
    });
  } catch {
    return managedOutcome(false, "none", "mailbox_notification_busy");
  }
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
async function markLeaderPaneMissingDeferred(params) {
  const { teamName, request, cwd, messageId } = params;
  const logTransitionFailure = createSwallowedErrorLogger(
    "team.mcp-comm.markLeaderPaneMissingDeferred transitionDispatchRequest failed"
  );
  const current = await readDispatchRequest(teamName, request.request_id, cwd);
  if (!current) return;
  if (current.status !== "pending") return;
  await transitionDispatchRequest(
    teamName,
    request.request_id,
    current.status,
    current.status,
    {
      message_id: messageId ?? current.message_id,
      last_reason: "leader_pane_missing_deferred"
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
async function queueDirectMailboxMessage(params) {
  const message = await params.deps.sendDirectMessage(params.teamName, params.fromWorker, params.toWorker, params.body, params.cwd);
  const queued = await enqueueDispatchRequest(
    params.teamName,
    {
      kind: "mailbox",
      to_worker: params.toWorker,
      worker_index: params.toWorkerIndex,
      pane_id: params.toPaneId,
      trigger_message: params.triggerMessage,
      message_id: message.message_id,
      transport_preference: params.transportPreference,
      fallback_allowed: params.fallbackAllowed
    },
    params.cwd
  );
  if (queued.deduped) {
    return {
      ok: false,
      transport: "none",
      reason: "duplicate_pending_dispatch_request",
      request_id: queued.request.request_id,
      message_id: message.message_id
    };
  }
  const notifyOutcome = await Promise.resolve(params.notify(
    { workerName: params.toWorker, workerIndex: params.toWorkerIndex, paneId: params.toPaneId },
    params.triggerMessage,
    { request: queued.request, message_id: message.message_id }
  )).catch((error) => ({
    ok: false,
    transport: fallbackTransportForPreference(params.transportPreference),
    reason: notifyExceptionReason(error)
  }));
  const { notification_managed: notificationManaged, ...outcome } = {
    ...notifyOutcome,
    request_id: queued.request.request_id,
    message_id: message.message_id,
    to_worker: params.toWorker
  };
  if (notificationManaged) return outcome;
  if (isLeaderPaneMissingMailboxPersistedOutcome(queued.request, outcome)) {
    await markLeaderPaneMissingDeferred({
      teamName: params.teamName,
      request: queued.request,
      cwd: params.cwd,
      messageId: message.message_id
    });
    return outcome;
  }
  if (isConfirmedNotification(outcome)) {
    await params.deps.markMessageNotified(params.teamName, params.toWorker, message.message_id, params.cwd);
    await markDispatchRequestNotified(
      params.teamName,
      queued.request.request_id,
      { message_id: message.message_id, last_reason: outcome.reason },
      params.cwd
    );
  } else {
    await markImmediateDispatchFailure({
      teamName: params.teamName,
      request: queued.request,
      reason: outcome.reason,
      messageId: message.message_id,
      cwd: params.cwd
    });
  }
  return outcome;
}
async function queueBroadcastMailboxMessage(params) {
  const recipientNames = /* @__PURE__ */ new Set();
  const recipients = params.recipients.map((recipient, index) => {
    const duplicate = recipientNames.has(recipient.workerName);
    recipientNames.add(recipient.workerName);
    return { ...recipient, duplicate, index };
  });
  const outcomes = [];
  const persistedRecipients = [];
  for (const recipient of recipients) {
    if (recipient.duplicate) {
      outcomes[recipient.index] = {
        ok: false,
        transport: "none",
        reason: "broadcast_recipient_diverged",
        to_worker: recipient.workerName
      };
      continue;
    }
    const triggerMessage = params.triggerFor(recipient.workerName);
    const message = await params.deps.sendDirectMessage(
      params.teamName,
      params.fromWorker,
      recipient.workerName,
      params.body,
      params.cwd
    );
    persistedRecipients.push({ ...recipient, triggerMessage, message });
  }
  for (const recipient of persistedRecipients) {
    const queued = await enqueueDispatchRequest(
      params.teamName,
      {
        kind: "mailbox",
        to_worker: recipient.workerName,
        worker_index: recipient.workerIndex,
        pane_id: recipient.paneId,
        trigger_message: recipient.triggerMessage,
        message_id: recipient.message.message_id,
        transport_preference: params.transportPreference,
        fallback_allowed: params.fallbackAllowed
      },
      params.cwd
    );
    if (queued.deduped) {
      outcomes[recipient.index] = {
        ok: false,
        transport: "none",
        reason: "duplicate_pending_dispatch_request",
        request_id: queued.request.request_id,
        message_id: recipient.message.message_id,
        to_worker: recipient.workerName
      };
      continue;
    }
    if (recipient.message.to_worker !== recipient.workerName) {
      const reasonOutcome = await persistPendingReason(
        {
          teamName: params.teamName,
          recipient: recipient.workerName,
          requestId: queued.request.request_id,
          messageId: recipient.message.message_id,
          triggerMessage: recipient.triggerMessage,
          cwd: params.cwd
        },
        mergeMailboxNotificationDependencies({
          patchPendingReason: patchPendingDispatchReason
        }),
        "broadcast_recipient_diverged",
        true
      );
      const { notification_managed: _managed, ...outcome2 } = reasonOutcome;
      outcomes[recipient.index] = {
        ...outcome2,
        request_id: queued.request.request_id,
        message_id: recipient.message.message_id,
        to_worker: recipient.workerName
      };
      continue;
    }
    const notifyOutcome = await Promise.resolve(params.notify(
      { workerName: recipient.workerName, workerIndex: recipient.workerIndex, paneId: recipient.paneId },
      recipient.triggerMessage,
      { request: queued.request, message_id: recipient.message.message_id }
    )).catch((error) => ({
      ok: false,
      transport: fallbackTransportForPreference(params.transportPreference),
      reason: notifyExceptionReason(error)
    }));
    const { notification_managed: notificationManaged, ...outcome } = {
      ...notifyOutcome,
      request_id: queued.request.request_id,
      message_id: recipient.message.message_id,
      to_worker: recipient.workerName
    };
    outcomes[recipient.index] = outcome;
    if (notificationManaged) continue;
    if (isConfirmedNotification(outcome)) {
      await params.deps.markMessageNotified(params.teamName, recipient.workerName, recipient.message.message_id, params.cwd);
      await markDispatchRequestNotified(
        params.teamName,
        queued.request.request_id,
        { message_id: recipient.message.message_id, last_reason: outcome.reason },
        params.cwd
      );
    } else {
      await markImmediateDispatchFailure({
        teamName: params.teamName,
        request: queued.request,
        reason: outcome.reason,
        messageId: recipient.message.message_id,
        cwd: params.cwd
      });
    }
  }
  return outcomes;
}
var mailboxNotificationTombstones;
var init_mcp_comm = __esm({
  "src/team/mcp-comm.ts"() {
    "use strict";
    init_dispatch_queue();
    init_team_ops();
    init_mailbox_notification_guard();
    init_tmux_session();
    init_state_paths();
    init_process_identity_lock();
    init_swallowed_error();
    mailboxNotificationTombstones = /* @__PURE__ */ new Map();
  }
});

// src/agents/utils.ts
import { readFileSync as readFileSync4 } from "fs";
import { join as join11, dirname as dirname10, basename as basename7, resolve as resolve3, relative as relative3, isAbsolute as isAbsolute5 } from "path";
import { fileURLToPath } from "url";
function getPackageDir() {
  if (typeof __dirname !== "undefined" && __dirname) {
    const currentDirName = basename7(__dirname);
    const parentDirName = basename7(dirname10(__dirname));
    if (currentDirName === "bridge") {
      return join11(__dirname, "..");
    }
    if (currentDirName === "agents" && (parentDirName === "src" || parentDirName === "dist")) {
      return join11(__dirname, "..", "..");
    }
  }
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname2 = dirname10(__filename);
    const currentDirName = basename7(__dirname2);
    if (currentDirName === "bridge") {
      return join11(__dirname2, "..");
    }
    return join11(__dirname2, "..", "..");
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
    const agentsDir = join11(getPackageDir(), "agents");
    const agentPath = join11(agentsDir, `${agentName}.md`);
    const resolvedPath = resolve3(agentPath);
    const resolvedAgentsDir = resolve3(agentsDir);
    const rel = relative3(resolvedAgentsDir, resolvedPath);
    if (rel.startsWith("..") || isAbsolute5(rel)) {
      throw new Error(`Invalid agent name: path traversal detected`);
    }
    const content = readFileSync4(agentPath, "utf-8");
    return stripFrontmatter(content);
  } catch (error) {
    const message = error instanceof Error && error.message.includes("Invalid agent name") ? error.message : "Agent prompt file not found";
    console.warn(`[loadAgentPrompt] ${message}`);
    return `Agent: ${agentName}

Prompt unavailable.`;
  }
}
var init_utils = __esm({
  "src/agents/utils.ts"() {
    "use strict";
  }
});

// src/utils/skininthegamebros-user.ts
var init_skininthegamebros_user = __esm({
  "src/utils/skininthegamebros-user.ts"() {
    "use strict";
  }
});

// src/agents/skininthegamebros-guidance.ts
var init_skininthegamebros_guidance = __esm({
  "src/agents/skininthegamebros-guidance.ts"() {
    "use strict";
    init_skininthegamebros_user();
  }
});

// src/agents/prompt-helpers.ts
import { readdirSync as readdirSync3 } from "fs";
import { join as join12, dirname as dirname11, basename as basename8 } from "path";
import { fileURLToPath as fileURLToPath2 } from "url";
function getPackageDir2() {
  if (typeof __dirname !== "undefined" && __dirname) {
    const currentDirName = basename8(__dirname);
    const parentDirName = basename8(dirname11(__dirname));
    if (currentDirName === "bridge") {
      return join12(__dirname, "..");
    }
    if (currentDirName === "agents" && (parentDirName === "src" || parentDirName === "dist")) {
      return join12(__dirname, "..", "..");
    }
  }
  try {
    const __filename = fileURLToPath2(import.meta.url);
    const __dirname2 = dirname11(__filename);
    const currentDirName = basename8(__dirname2);
    if (currentDirName === "bridge") {
      return join12(__dirname2, "..");
    }
    return join12(__dirname2, "..", "..");
  } catch {
  }
  return process.cwd();
}
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
    const agentsDir = join12(getPackageDir2(), "agents");
    const files = readdirSync3(agentsDir);
    _cachedRoles = files.filter((f) => f.endsWith(".md")).map((f) => basename8(f, ".md")).sort();
  } catch (err) {
    console.error("[prompt-injection] CRITICAL: Could not scan agents/ directory for role discovery:", err);
    _cachedRoles = [];
  }
  return _cachedRoles;
}
function sanitizePromptContent(content, maxLength = 4e3) {
  if (!content) return "";
  let sanitized = content.length > maxLength ? content.slice(0, maxLength) : content;
  if (sanitized.length > 0) {
    const lastCode = sanitized.charCodeAt(sanitized.length - 1);
    if (lastCode >= 55296 && lastCode <= 56319) {
      sanitized = sanitized.slice(0, -1);
    }
  }
  sanitized = sanitized.replace(/<(\/?)(system-instructions|system-reminder|TASK_SUBJECT|TASK_DESCRIPTION|INBOX_MESSAGE)(?=[\s>/])[^>]*>/gi, "[$1$2]");
  return sanitized;
}
var _cachedRoles, VALID_AGENT_ROLES;
var init_prompt_helpers = __esm({
  "src/agents/prompt-helpers.ts"() {
    "use strict";
    init_utils();
    init_skininthegamebros_guidance();
    _cachedRoles = null;
    VALID_AGENT_ROLES = getValidAgentRoles();
  }
});

// src/utils/omc-cli-rendering.ts
import { spawnSync as spawnSync2 } from "child_process";
function commandExists(command, env) {
  const lookupCommand = process.platform === "win32" ? "where" : "which";
  const result = spawnSync2(lookupCommand, [command], {
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
function resolveInvocationPrefix(commandSuffix, options = {}) {
  void commandSuffix;
  return resolveOmcCliPrefix(options);
}
function formatOmcCliInvocation(commandSuffix, options = {}) {
  const suffix = commandSuffix.trim().replace(/^omc\s+/, "");
  return `${resolveInvocationPrefix(suffix, options)} ${suffix}`.trim();
}
var OMC_CLI_BINARY, OMC_PLUGIN_BRIDGE_PREFIX;
var init_omc_cli_rendering = __esm({
  "src/utils/omc-cli-rendering.ts"() {
    "use strict";
    OMC_CLI_BINARY = "omc";
    OMC_PLUGIN_BRIDGE_PREFIX = 'node "$CLAUDE_PLUGIN_ROOT"/bridge/cli.cjs';
  }
});

// src/utils/paths.ts
import { join as join13 } from "path";
import { existsSync as existsSync10, readFileSync as readFileSync5, readdirSync as readdirSync4, statSync, unlinkSync as unlinkSync4, rmSync, symlinkSync } from "fs";
import { homedir as homedir3 } from "os";
function getConfigDir() {
  if (process.platform === "win32") {
    return process.env.APPDATA || join13(homedir3(), "AppData", "Roaming");
  }
  return process.env.XDG_CONFIG_HOME || join13(homedir3(), ".config");
}
function getStateDir() {
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA || join13(homedir3(), "AppData", "Local");
  }
  return process.env.XDG_STATE_HOME || join13(homedir3(), ".local", "state");
}
function prefersXdgOmcDirs() {
  return process.platform !== "win32" && process.platform !== "darwin";
}
function getUserHomeDir() {
  if (process.platform === "win32") {
    return process.env.USERPROFILE || process.env.HOME || homedir3();
  }
  return process.env.HOME || homedir3();
}
function getLegacyOmcDir() {
  return join13(getUserHomeDir(), ".omc");
}
function getGlobalOmcStateRoot() {
  const explicitRoot = process.env.OMC_HOME?.trim();
  if (explicitRoot) {
    return join13(explicitRoot, "state");
  }
  if (prefersXdgOmcDirs()) {
    return join13(getStateDir(), "omc");
  }
  return join13(getLegacyOmcDir(), "state");
}
function getGlobalOmcStatePath(...segments) {
  return join13(getGlobalOmcStateRoot(), ...segments);
}
var STALE_THRESHOLD_MS;
var init_paths = __esm({
  "src/utils/paths.ts"() {
    "use strict";
    init_config_dir();
    STALE_THRESHOLD_MS = 24 * 60 * 60 * 1e3;
  }
});

// src/utils/jsonc.ts
function parseJsonc(content) {
  const cleaned = stripJsoncComments(content);
  return JSON.parse(cleaned);
}
function stripJsoncComments(content) {
  return stripTrailingCommas(stripComments(content));
}
function stripComments(content) {
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
function stripTrailingCommas(content) {
  let result = "";
  let i = 0;
  while (i < content.length) {
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
    if (content[i] === ",") {
      let j = i + 1;
      while (j < content.length && /\s/.test(content[j])) {
        j++;
      }
      if (content[j] === "}" || content[j] === "]") {
        i++;
        continue;
      }
    }
    result += content[i];
    i++;
  }
  return result;
}
var init_jsonc = __esm({
  "src/utils/jsonc.ts"() {
    "use strict";
  }
});

// src/utils/ssrf-guard.ts
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
var BLOCKED_HOST_PATTERNS, ALLOWED_SCHEMES;
var init_ssrf_guard = __esm({
  "src/utils/ssrf-guard.ts"() {
    "use strict";
    BLOCKED_HOST_PATTERNS = [
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
    ALLOWED_SCHEMES = ["https:", "http:"];
  }
});

// src/config/models.ts
function readEnvValue(key) {
  const value = process.env[key]?.trim();
  return value || void 0;
}
function resolveTierModelFromEnv(tier) {
  for (const key of TIER_ENV_KEYS[tier]) {
    const value = readEnvValue(key);
    if (value) {
      return value;
    }
  }
  return void 0;
}
function getDirectModelEnvValue() {
  for (const key of DIRECT_MODEL_ENV_KEYS) {
    const value = readEnvValue(key);
    if (value) {
      return value;
    }
  }
  return void 0;
}
function getProviderDetectionModelEnvValues() {
  const directModel = getDirectModelEnvValue();
  if (directModel) {
    return [directModel];
  }
  const values = /* @__PURE__ */ new Set();
  for (const tier of INHERIT_TIER_PRIORITY) {
    const value = resolveTierModelFromEnv(tier);
    if (value) {
      values.add(value);
    }
  }
  return [...values];
}
function getDirectProviderDetectionModelEnvValues() {
  const directModel = getDirectModelEnvValue();
  return directModel ? [directModel] : [];
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
  if (lower.includes("fable")) return "FABLE";
  return null;
}
function hasBedrockModelId(modelIds) {
  for (const modelId of modelIds) {
    if (/^((us|eu|ap|global)\.anthropic\.|anthropic\.claude)/i.test(modelId)) {
      return true;
    }
    if (/^arn:aws(-[^:]+)?:bedrock:/i.test(modelId) && /:(inference-profile|application-inference-profile)\//i.test(modelId) && modelId.toLowerCase().includes("claude")) {
      return true;
    }
  }
  return false;
}
function isBedrock() {
  if (process.env.CLAUDE_CODE_USE_BEDROCK === "1") {
    return true;
  }
  return hasBedrockModelId(getProviderDetectionModelEnvValues());
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
  return hasVertexModelId(getProviderDetectionModelEnvValues());
}
function hasVertexModelId(modelIds) {
  return modelIds.some((modelId) => modelId.toLowerCase().startsWith("vertex_ai/"));
}
function hasNonClaudeModelId(modelIds) {
  for (const modelId of modelIds) {
    const lower = modelId.toLowerCase();
    if (!lower.includes("claude") && !CLAUDE_TIER_ALIASES.has(lower)) {
      return true;
    }
  }
  return false;
}
function shouldAutoForceInherit() {
  if (process.env.OMC_ROUTING_FORCE_INHERIT === "true") {
    return true;
  }
  if (process.env.CLAUDE_CODE_USE_BEDROCK === "1") {
    return true;
  }
  if (process.env.CLAUDE_CODE_USE_VERTEX === "1") {
    return true;
  }
  const directModelValues = getDirectProviderDetectionModelEnvValues();
  if (hasBedrockModelId(directModelValues) || hasVertexModelId(directModelValues) || hasNonClaudeModelId(directModelValues)) {
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
var DIRECT_MODEL_ENV_KEYS, INHERIT_TIER_PRIORITY, CLAUDE_TIER_ALIASES, TIER_ENV_KEYS, CLAUDE_FAMILY_DEFAULTS, BUILTIN_TIER_MODEL_DEFAULTS, CLAUDE_FAMILY_HIGH_VARIANTS, BUILTIN_EXTERNAL_MODEL_DEFAULTS;
var init_models = __esm({
  "src/config/models.ts"() {
    "use strict";
    init_ssrf_guard();
    DIRECT_MODEL_ENV_KEYS = ["CLAUDE_MODEL", "ANTHROPIC_MODEL"];
    INHERIT_TIER_PRIORITY = ["MEDIUM", "HIGH", "LOW"];
    CLAUDE_TIER_ALIASES = /* @__PURE__ */ new Set(["sonnet", "opus", "haiku", "fable"]);
    TIER_ENV_KEYS = {
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
    CLAUDE_FAMILY_DEFAULTS = {
      HAIKU: "claude-haiku-4-5",
      SONNET: "claude-sonnet-5",
      OPUS: "claude-opus-4-8",
      FABLE: "claude-fable-5"
    };
    BUILTIN_TIER_MODEL_DEFAULTS = {
      LOW: CLAUDE_FAMILY_DEFAULTS.HAIKU,
      MEDIUM: CLAUDE_FAMILY_DEFAULTS.SONNET,
      HIGH: CLAUDE_FAMILY_DEFAULTS.OPUS
    };
    CLAUDE_FAMILY_HIGH_VARIANTS = {
      HAIKU: `${CLAUDE_FAMILY_DEFAULTS.HAIKU}-high`,
      SONNET: `${CLAUDE_FAMILY_DEFAULTS.SONNET}-high`,
      OPUS: `${CLAUDE_FAMILY_DEFAULTS.OPUS}-high`,
      FABLE: `${CLAUDE_FAMILY_DEFAULTS.FABLE}-high`
    };
    BUILTIN_EXTERNAL_MODEL_DEFAULTS = {
      codexModel: "gpt-5.3-codex",
      geminiModel: "gemini-3.1-pro-preview",
      antigravityModel: "Gemini 3.1 Pro (High)"
    };
  }
});

// src/features/delegation-routing/types.ts
function normalizeDelegationRole(role) {
  return DEPRECATED_ROLE_ALIASES[role] ?? role;
}
var DEPRECATED_ROLE_ALIASES;
var init_types2 = __esm({
  "src/features/delegation-routing/types.ts"() {
    "use strict";
    DEPRECATED_ROLE_ALIASES = {
      researcher: "document-specialist",
      "tdd-guide": "test-engineer",
      "api-reviewer": "code-reviewer",
      "performance-reviewer": "code-reviewer",
      "dependency-expert": "document-specialist",
      "quality-strategist": "code-reviewer",
      vision: "document-specialist",
      // Consolidated agent aliases (agent consolidation PR)
      "quality-reviewer": "code-reviewer",
      "deep-executor": "executor",
      "build-fixer": "debugger",
      "harsh-critic": "critic",
      // User-friendly short alias for /team role routing (plan AC-4)
      reviewer: "code-reviewer"
    };
  }
});

// src/features/delegation-routing/resolver.ts
function isDeprecatedMcpProvider(provider) {
  return provider ? DEPRECATED_MCP_PROVIDERS.has(provider) : false;
}
var DEPRECATED_MCP_PROVIDERS;
var init_resolver = __esm({
  "src/features/delegation-routing/resolver.ts"() {
    "use strict";
    init_types2();
    DEPRECATED_MCP_PROVIDERS = /* @__PURE__ */ new Set([
      "codex",
      "gemini"
    ]);
  }
});

// src/features/delegation-routing/index.ts
var init_delegation_routing = __esm({
  "src/features/delegation-routing/index.ts"() {
    "use strict";
    init_resolver();
    init_types2();
  }
});

// src/config/loader.ts
import { readFileSync as readFileSync6, existsSync as existsSync11 } from "fs";
import { join as join14, dirname as dirname12 } from "path";
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
    companyContext: {
      onError: "warn"
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
        geminiModel: BUILTIN_EXTERNAL_MODEL_DEFAULTS.geminiModel,
        antigravityModel: BUILTIN_EXTERNAL_MODEL_DEFAULTS.antigravityModel
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
    // /team role routing (Option E — /team-scoped per-role provider & model)
    // Empty defaults: zero behavior change until user opts in.
    team: {
      ops: {},
      roleRouting: {}
    },
    autopilot: {
      execution: "solo"
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
function getConfigPaths() {
  const userConfigDir = getConfigDir();
  return {
    user: join14(userConfigDir, "claude-omc", "config.jsonc"),
    project: join14(process.cwd(), ".claude", "omc.jsonc")
  };
}
function loadJsoncFile(path4) {
  if (!existsSync11(path4)) {
    return null;
  }
  try {
    const content = readFileSync6(path4, "utf-8");
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
    if (provider === "codex" || provider === "gemini" || provider === "antigravity") {
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
  if (process.env.OMC_EXTERNAL_MODELS_DEFAULT_GROK_MODEL) {
    externalModelsDefaults.grokModel = process.env.OMC_EXTERNAL_MODELS_DEFAULT_GROK_MODEL;
  } else if (process.env.OMC_GROK_DEFAULT_MODEL) {
    externalModelsDefaults.grokModel = process.env.OMC_GROK_DEFAULT_MODEL;
  }
  if (process.env.OMC_EXTERNAL_MODELS_DEFAULT_ANTIGRAVITY_MODEL) {
    externalModelsDefaults.antigravityModel = process.env.OMC_EXTERNAL_MODELS_DEFAULT_ANTIGRAVITY_MODEL;
  } else if (process.env.OMC_ANTIGRAVITY_DEFAULT_MODEL) {
    externalModelsDefaults.antigravityModel = process.env.OMC_ANTIGRAVITY_DEFAULT_MODEL;
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
  const teamRoleOverrides = parseTeamRoleOverridesFromEnv();
  if (teamRoleOverrides) {
    config.team = {
      ...config.team,
      roleRouting: {
        ...config.team?.roleRouting,
        ...teamRoleOverrides
      }
    };
  }
  return config;
}
function warnOnDeprecatedDelegationRouting(config) {
  const deprecatedProviders = /* @__PURE__ */ new Set();
  const defaultProvider = config.delegationRouting?.defaultProvider;
  if (isDeprecatedMcpProvider(defaultProvider)) {
    deprecatedProviders.add(defaultProvider);
  }
  const roles = config.delegationRouting?.roles ?? {};
  for (const route of Object.values(roles)) {
    const provider = route?.provider;
    if (isDeprecatedMcpProvider(provider)) {
      deprecatedProviders.add(provider);
    }
  }
  if (deprecatedProviders.size === 0) {
    return;
  }
  console.warn(
    "[OMC] delegationRouting to Codex/Gemini is deprecated and falls back to Claude Task. Use /team for Codex/Gemini CLI workers instead."
  );
}
function validateTeamConfig(config) {
  const team = config.team;
  if (!team || typeof team !== "object") return;
  const ops = team.ops;
  if (ops && typeof ops === "object") {
    if (ops.defaultAgentType !== void 0) {
      if (typeof ops.defaultAgentType !== "string" || !TEAM_ROLE_PROVIDERS.has(ops.defaultAgentType)) {
        throw new Error(
          `[OMC] team.ops.defaultAgentType: invalid value "${String(ops.defaultAgentType)}". Allowed: ${[...TEAM_ROLE_PROVIDERS].join(", ")}`
        );
      }
    }
    if (ops.worktreeMode !== void 0) {
      const allowed = /* @__PURE__ */ new Set(["disabled", "off", "detached", "branch", "named"]);
      if (typeof ops.worktreeMode !== "string" || !allowed.has(ops.worktreeMode)) {
        throw new Error(
          `[OMC] team.ops.worktreeMode: invalid value "${String(ops.worktreeMode)}". Allowed: ${[...allowed].join(", ")}`
        );
      }
    }
  }
  const roleRouting = team.roleRouting;
  if (!roleRouting || typeof roleRouting !== "object") return;
  for (const [rawRoleKey, rawSpec] of Object.entries(roleRouting)) {
    const normalized = normalizeDelegationRole(rawRoleKey);
    if (!CANONICAL_TEAM_ROLE_SET.has(normalized)) {
      throw new Error(
        `[OMC] team.roleRouting: unknown role "${rawRoleKey}". Allowed roles: ${[...CANONICAL_TEAM_ROLE_SET].join(", ")}`
      );
    }
    if (!rawSpec || typeof rawSpec !== "object" || Array.isArray(rawSpec)) {
      throw new Error(
        `[OMC] team.roleRouting.${rawRoleKey}: must be an object, got ${Array.isArray(rawSpec) ? "array" : typeof rawSpec}`
      );
    }
    const spec = rawSpec;
    if (normalized === "orchestrator") {
      for (const key of Object.keys(spec)) {
        if (key !== "model") {
          throw new Error(
            `[OMC] team.roleRouting.orchestrator: key "${key}" is not allowed (orchestrator is pinned to claude; only "model" is configurable)`
          );
        }
      }
      if (spec.model !== void 0 && !isValidModelValue(spec.model)) {
        throw new Error(
          `[OMC] team.roleRouting.orchestrator.model: must be a tier name (HIGH|MEDIUM|LOW) or model ID string, got ${typeof spec.model}`
        );
      }
      continue;
    }
    if (spec.provider !== void 0) {
      if (typeof spec.provider !== "string" || !TEAM_ROLE_PROVIDERS.has(spec.provider)) {
        throw new Error(
          `[OMC] team.roleRouting.${rawRoleKey}.provider: invalid value "${String(spec.provider)}". Allowed: ${[...TEAM_ROLE_PROVIDERS].join(", ")}`
        );
      }
      if (spec.provider === "cursor" && !CURSOR_EXECUTOR_TEAM_ROLE_SET.has(normalized)) {
        throw new Error(
          `[OMC] team.roleRouting.${rawRoleKey}.provider: cursor is only supported for executor-style roles (${[...CURSOR_EXECUTOR_TEAM_ROLE_SET].join(", ")})`
        );
      }
    }
    if (spec.model !== void 0 && !isValidModelValue(spec.model)) {
      throw new Error(
        `[OMC] team.roleRouting.${rawRoleKey}.model: must be a tier name (HIGH|MEDIUM|LOW) or a non-empty model ID string`
      );
    }
    if (spec.agent !== void 0) {
      if (typeof spec.agent !== "string" || !KNOWN_AGENT_NAME_SET.has(spec.agent)) {
        throw new Error(
          `[OMC] team.roleRouting.${rawRoleKey}.agent: unknown agent "${String(spec.agent)}". Allowed: ${[...KNOWN_AGENT_NAME_SET].join(", ")}`
        );
      }
    }
  }
}
function isAutopilotWorkflowSequence(stages) {
  return AUTOPILOT_WORKFLOW_SEQUENCES.some(
    (sequence) => stages.length === sequence.length && stages.every((stage, index) => typeof stage === "string" && stage === sequence[index])
  );
}
function workflowError(source, path4, message) {
  throw new Error(`[OMC] ${source} ${path4}: ${message}`);
}
function validateAutopilotWorkflows(config, source) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return;
  const autopilot = config.autopilot;
  if (autopilot === void 0) return;
  if (!autopilot || typeof autopilot !== "object" || Array.isArray(autopilot)) return;
  const workflows = autopilot.workflows;
  if (workflows === void 0) return;
  if (!workflows || typeof workflows !== "object" || Array.isArray(workflows)) {
    workflowError(source, "autopilot.workflows", "must be an object map");
  }
  for (const [name, profile] of Object.entries(workflows)) {
    const path4 = `autopilot.workflows.${name}`;
    if (!AUTOPILOT_WORKFLOW_NAME.test(name)) {
      workflowError(source, path4, "name must match ^[a-z][a-z0-9-]{0,62}$");
    }
    if (AUTOPILOT_WORKFLOW_RESERVED_NAMES.has(name)) {
      workflowError(source, path4, `name "${name}" is reserved`);
    }
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      workflowError(source, path4, "must be an object");
    }
    const profileRecord = profile;
    for (const key of Object.keys(profileRecord)) {
      if (key !== "version" && key !== "stages") {
        workflowError(source, `${path4}.${key}`, "unknown profile key");
      }
    }
    if (profileRecord.version !== 1) {
      workflowError(source, `${path4}.version`, "must be the number 1");
    }
    if (!Array.isArray(profileRecord.stages)) {
      workflowError(source, `${path4}.stages`, "must be an array");
    }
    if (!isAutopilotWorkflowSequence(profileRecord.stages)) {
      workflowError(
        source,
        `${path4}.stages`,
        "must be one of: [ralplan, execution], [ralplan, execution, ralph], [ralplan, execution, qa], [ralplan, execution, ralph, qa]"
      );
    }
  }
}
function composeAutopilotWorkflows(config, userConfig, projectConfig) {
  const userWorkflows = userConfig?.autopilot?.workflows;
  const projectWorkflows = projectConfig?.autopilot?.workflows;
  if (userWorkflows === void 0 && projectWorkflows === void 0) return config;
  return {
    ...config,
    autopilot: {
      ...config.autopilot,
      workflows: {
        ...userWorkflows,
        ...projectWorkflows
      }
    }
  };
}
function validateAutopilotConfig(config) {
  const autopilot = config.autopilot;
  if (!autopilot || typeof autopilot !== "object") return;
  validateAutopilotWorkflows(config, "effective");
  if (autopilot.execution !== void 0 && (typeof autopilot.execution !== "string" || !AUTOPILOT_EXECUTION_BACKENDS.has(autopilot.execution))) {
    throw new Error(
      `[OMC] autopilot.execution: invalid value "${String(autopilot.execution)}". Allowed: ${[...AUTOPILOT_EXECUTION_BACKENDS].join(", ")}`
    );
  }
  if (autopilot.planning !== void 0 && autopilot.planning !== false && (typeof autopilot.planning !== "string" || !AUTOPILOT_PLANNING_MODES.has(autopilot.planning))) {
    throw new Error(
      `[OMC] autopilot.planning: invalid value "${String(autopilot.planning)}". Allowed: ralplan, direct, false`
    );
  }
  const team = autopilot.team;
  if (!team || typeof team !== "object") return;
  if (team.agentTypes !== void 0) {
    if (!Array.isArray(team.agentTypes)) {
      throw new Error("[OMC] autopilot.team.agentTypes: must be an array");
    }
    for (const agentType of team.agentTypes) {
      if (typeof agentType !== "string" || !AUTOPILOT_TEAM_AGENT_TYPES.has(agentType)) {
        throw new Error(
          `[OMC] autopilot.team.agentTypes: invalid value "${String(agentType)}". Allowed: ${[...AUTOPILOT_TEAM_AGENT_TYPES].join(", ")}`
        );
      }
    }
  }
}
function isValidModelValue(value) {
  if (typeof value !== "string") return false;
  if (value.length === 0) return false;
  return TEAM_ROLE_TIERS.has(value) || value.length > 0;
}
function parseTeamRoleOverridesFromEnv() {
  const raw = process.env.OMC_TEAM_ROLE_OVERRIDES;
  if (!raw) return void 0;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn(
        "[OMC] OMC_TEAM_ROLE_OVERRIDES: expected a JSON object; ignoring."
      );
      return void 0;
    }
    return parsed;
  } catch (err) {
    console.warn(
      `[OMC] OMC_TEAM_ROLE_OVERRIDES: invalid JSON, ignoring (${err.message})`
    );
    return void 0;
  }
}
function loadConfig() {
  const paths = getConfigPaths();
  let config = buildDefaultConfig();
  const userConfig = loadJsoncFile(paths.user);
  if (userConfig) {
    validateAutopilotWorkflows(userConfig, "user");
    config = deepMerge(config, userConfig);
  }
  const projectConfig = loadJsoncFile(paths.project);
  if (projectConfig) {
    validateAutopilotWorkflows(projectConfig, "project");
    config = deepMerge(config, projectConfig);
  }
  config = composeAutopilotWorkflows(config, userConfig, projectConfig);
  const envConfig = loadEnvConfig();
  config = deepMerge(config, envConfig);
  if (config.routing?.forceInherit !== true && process.env.OMC_ROUTING_FORCE_INHERIT === void 0 && shouldAutoForceInherit()) {
    config.routing = {
      ...config.routing,
      forceInherit: true
    };
  }
  warnOnDeprecatedDelegationRouting(config);
  validateTeamConfig(config);
  validateAutopilotConfig(config);
  return config;
}
var DEFAULT_CONFIG, CANONICAL_TEAM_ROLE_SET, CURSOR_EXECUTOR_TEAM_ROLE_SET, KNOWN_AGENT_NAME_SET, TEAM_ROLE_PROVIDERS, TEAM_ROLE_TIERS, AUTOPILOT_EXECUTION_BACKENDS, AUTOPILOT_PLANNING_MODES, AUTOPILOT_TEAM_AGENT_TYPES, AUTOPILOT_WORKFLOW_NAME, AUTOPILOT_WORKFLOW_RESERVED_NAMES, AUTOPILOT_WORKFLOW_SEQUENCES;
var init_loader = __esm({
  "src/config/loader.ts"() {
    "use strict";
    init_types();
    init_paths();
    init_jsonc();
    init_models();
    init_types2();
    init_delegation_routing();
    DEFAULT_CONFIG = buildDefaultConfig();
    CANONICAL_TEAM_ROLE_SET = new Set(CANONICAL_TEAM_ROLES);
    CURSOR_EXECUTOR_TEAM_ROLE_SET = new Set(CURSOR_EXECUTOR_TEAM_ROLES);
    KNOWN_AGENT_NAME_SET = new Set(KNOWN_AGENT_NAMES);
    TEAM_ROLE_PROVIDERS = /* @__PURE__ */ new Set(["claude", "codex", "gemini", "grok", "cursor", "antigravity"]);
    TEAM_ROLE_TIERS = /* @__PURE__ */ new Set(["HIGH", "MEDIUM", "LOW"]);
    AUTOPILOT_EXECUTION_BACKENDS = /* @__PURE__ */ new Set(["team", "solo"]);
    AUTOPILOT_PLANNING_MODES = /* @__PURE__ */ new Set(["ralplan", "direct"]);
    AUTOPILOT_TEAM_AGENT_TYPES = /* @__PURE__ */ new Set([
      "claude",
      "codex",
      "gemini",
      "grok",
      "cursor",
      "antigravity"
    ]);
    AUTOPILOT_WORKFLOW_NAME = /^[a-z][a-z0-9-]{0,62}$/;
    AUTOPILOT_WORKFLOW_RESERVED_NAMES = /* @__PURE__ */ new Set([
      "autopilot",
      "ralplan",
      "execution",
      "ralph",
      "qa",
      "autoresearch",
      "ultraqa",
      "merge-readiness",
      "self-improve",
      "ultrawork",
      "ultrapilot",
      "swarm",
      "pipeline",
      "plan",
      "team",
      "cancel",
      "deep-interview",
      "deepsearch",
      "ultrathink",
      "tdd",
      "code-review",
      "security-review",
      "analyze",
      "search",
      "ultragoal",
      "default"
    ]);
    AUTOPILOT_WORKFLOW_SEQUENCES = [
      ["ralplan", "execution"],
      ["ralplan", "execution", "ralph"],
      ["ralplan", "execution", "qa"],
      ["ralplan", "execution", "ralph", "qa"]
    ];
  }
});

// src/agents/architect.ts
var ARCHITECT_PROMPT_METADATA, architectAgent;
var init_architect = __esm({
  "src/agents/architect.ts"() {
    "use strict";
    init_utils();
    ARCHITECT_PROMPT_METADATA = {
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
    architectAgent = {
      name: "architect",
      description: "Read-only consultation agent. High-IQ reasoning specialist for debugging hard problems and high-difficulty architecture design.",
      prompt: loadAgentPrompt("architect"),
      model: "opus",
      defaultModel: "opus",
      metadata: ARCHITECT_PROMPT_METADATA
    };
  }
});

// src/agents/designer.ts
var FRONTEND_ENGINEER_PROMPT_METADATA, designerAgent;
var init_designer = __esm({
  "src/agents/designer.ts"() {
    "use strict";
    init_utils();
    FRONTEND_ENGINEER_PROMPT_METADATA = {
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
    designerAgent = {
      name: "designer",
      description: `Designer-turned-developer who crafts stunning UI/UX even without design mockups. Use for VISUAL changes only (styling, layout, animation). Pure logic changes in frontend files should be handled directly.`,
      prompt: loadAgentPrompt("designer"),
      model: "sonnet",
      defaultModel: "sonnet",
      metadata: FRONTEND_ENGINEER_PROMPT_METADATA
    };
  }
});

// src/agents/writer.ts
var DOCUMENT_WRITER_PROMPT_METADATA, writerAgent;
var init_writer = __esm({
  "src/agents/writer.ts"() {
    "use strict";
    init_utils();
    DOCUMENT_WRITER_PROMPT_METADATA = {
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
    writerAgent = {
      name: "writer",
      description: `Technical writer who crafts clear, comprehensive documentation. Specializes in README files, API docs, architecture docs, and user guides.`,
      prompt: loadAgentPrompt("writer"),
      model: "haiku",
      defaultModel: "haiku",
      metadata: DOCUMENT_WRITER_PROMPT_METADATA
    };
  }
});

// src/agents/critic.ts
var CRITIC_PROMPT_METADATA, criticAgent;
var init_critic = __esm({
  "src/agents/critic.ts"() {
    "use strict";
    init_utils();
    CRITIC_PROMPT_METADATA = {
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
    criticAgent = {
      name: "critic",
      description: `Expert reviewer for evaluating work plans against rigorous clarity, verifiability, and completeness standards. Use after planner creates a work plan to validate it before execution.`,
      prompt: loadAgentPrompt("critic"),
      model: "opus",
      defaultModel: "opus",
      metadata: CRITIC_PROMPT_METADATA
    };
  }
});

// src/agents/analyst.ts
var ANALYST_PROMPT_METADATA, analystAgent;
var init_analyst = __esm({
  "src/agents/analyst.ts"() {
    "use strict";
    init_utils();
    ANALYST_PROMPT_METADATA = {
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
    analystAgent = {
      name: "analyst",
      description: `Pre-planning consultant that analyzes requests before implementation to identify hidden requirements, edge cases, and potential risks. Use before creating a work plan.`,
      prompt: loadAgentPrompt("analyst"),
      model: "opus",
      defaultModel: "opus",
      metadata: ANALYST_PROMPT_METADATA
    };
  }
});

// src/agents/executor.ts
var EXECUTOR_PROMPT_METADATA, executorAgent;
var init_executor = __esm({
  "src/agents/executor.ts"() {
    "use strict";
    init_utils();
    EXECUTOR_PROMPT_METADATA = {
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
    executorAgent = {
      name: "executor",
      description: "Focused task executor. Execute tasks directly. NEVER delegate or spawn other agents. Same discipline as OMC, no delegation.",
      prompt: loadAgentPrompt("executor"),
      model: "sonnet",
      defaultModel: "sonnet",
      metadata: EXECUTOR_PROMPT_METADATA
    };
  }
});

// src/agents/planner.ts
var PLANNER_PROMPT_METADATA, plannerAgent;
var init_planner = __esm({
  "src/agents/planner.ts"() {
    "use strict";
    init_utils();
    PLANNER_PROMPT_METADATA = {
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
    plannerAgent = {
      name: "planner",
      description: `Strategic planning consultant. Interviews users to understand requirements, then creates comprehensive work plans. NEVER implements - only plans.`,
      prompt: loadAgentPrompt("planner"),
      model: "opus",
      defaultModel: "opus",
      metadata: PLANNER_PROMPT_METADATA
    };
  }
});

// src/agents/qa-tester.ts
var QA_TESTER_PROMPT_METADATA, qaTesterAgent;
var init_qa_tester = __esm({
  "src/agents/qa-tester.ts"() {
    "use strict";
    init_utils();
    QA_TESTER_PROMPT_METADATA = {
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
    qaTesterAgent = {
      name: "qa-tester",
      description: "Interactive CLI testing specialist using tmux. Tests CLI applications, background services, and interactive tools. Manages test sessions, sends commands, verifies output, and ensures cleanup.",
      prompt: loadAgentPrompt("qa-tester"),
      model: "sonnet",
      defaultModel: "sonnet",
      metadata: QA_TESTER_PROMPT_METADATA
    };
  }
});

// src/agents/scientist.ts
var SCIENTIST_PROMPT_METADATA, scientistAgent;
var init_scientist = __esm({
  "src/agents/scientist.ts"() {
    "use strict";
    init_utils();
    SCIENTIST_PROMPT_METADATA = {
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
    scientistAgent = {
      name: "scientist",
      description: "Data analysis and research execution specialist. Executes Python code for EDA, statistical analysis, and generating data-driven findings. Works with CSV, JSON, Parquet files using pandas, numpy, scipy.",
      prompt: loadAgentPrompt("scientist"),
      model: "sonnet",
      defaultModel: "sonnet",
      metadata: SCIENTIST_PROMPT_METADATA
    };
  }
});

// src/agents/explore.ts
var EXPLORE_PROMPT_METADATA, exploreAgent;
var init_explore = __esm({
  "src/agents/explore.ts"() {
    "use strict";
    init_utils();
    EXPLORE_PROMPT_METADATA = {
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
    exploreAgent = {
      name: "explore",
      description: "Fast codebase exploration and pattern search. Use for finding files, understanding structure, locating implementations. Searches INTERNAL codebase only; external docs, literature, papers, and reference databases belong to document-specialist.",
      prompt: loadAgentPrompt("explore"),
      model: "haiku",
      defaultModel: "haiku",
      metadata: EXPLORE_PROMPT_METADATA
    };
  }
});

// src/agents/tracer.ts
var TRACER_PROMPT_METADATA, tracerAgent;
var init_tracer = __esm({
  "src/agents/tracer.ts"() {
    "use strict";
    init_utils();
    TRACER_PROMPT_METADATA = {
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
    tracerAgent = {
      name: "tracer",
      description: "Evidence-driven causal tracing specialist. Explains observed outcomes using competing hypotheses, evidence for and against, uncertainty tracking, and next-probe recommendations.",
      prompt: loadAgentPrompt("tracer"),
      model: "sonnet",
      defaultModel: "sonnet",
      metadata: TRACER_PROMPT_METADATA
    };
  }
});

// src/agents/document-specialist.ts
var DOCUMENT_SPECIALIST_PROMPT_METADATA, documentSpecialistAgent;
var init_document_specialist = __esm({
  "src/agents/document-specialist.ts"() {
    "use strict";
    init_utils();
    DOCUMENT_SPECIALIST_PROMPT_METADATA = {
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
    documentSpecialistAgent = {
      name: "document-specialist",
      description: "Document Specialist for documentation research and reference finding. Use for local repo docs, official docs, Context Hub / chub or other curated docs backends for API/framework correctness, GitHub examples, OSS implementations, external literature, academic papers, and reference/database lookups. Avoid internal implementation search; use explore for code discovery.",
      prompt: loadAgentPrompt("document-specialist"),
      model: "sonnet",
      defaultModel: "sonnet",
      metadata: DOCUMENT_SPECIALIST_PROMPT_METADATA
    };
  }
});

// src/agents/definitions.ts
var debuggerAgent, verifierAgent, testEngineerAgent, securityReviewerAgent, codeReviewerAgent, gitMasterAgent, codeSimplifierAgent;
var init_definitions = __esm({
  "src/agents/definitions.ts"() {
    "use strict";
    init_utils();
    init_loader();
    init_models();
    init_skininthegamebros_guidance();
    init_architect();
    init_designer();
    init_writer();
    init_critic();
    init_analyst();
    init_executor();
    init_planner();
    init_qa_tester();
    init_scientist();
    init_explore();
    init_tracer();
    init_document_specialist();
    init_architect();
    init_designer();
    init_writer();
    init_critic();
    init_analyst();
    init_executor();
    init_planner();
    init_qa_tester();
    init_scientist();
    init_explore();
    init_tracer();
    init_document_specialist();
    debuggerAgent = {
      name: "debugger",
      description: "Root-cause analysis, regression isolation, failure diagnosis (Sonnet).",
      prompt: loadAgentPrompt("debugger"),
      model: "sonnet",
      defaultModel: "sonnet"
    };
    verifierAgent = {
      name: "verifier",
      description: "Completion evidence, claim validation, test adequacy (Sonnet).",
      prompt: loadAgentPrompt("verifier"),
      model: "sonnet",
      defaultModel: "sonnet"
    };
    testEngineerAgent = {
      name: "test-engineer",
      description: "Test strategy, coverage, flaky test hardening (Sonnet).",
      prompt: loadAgentPrompt("test-engineer"),
      model: "sonnet",
      defaultModel: "sonnet"
    };
    securityReviewerAgent = {
      name: "security-reviewer",
      description: "Security vulnerability detection specialist (Sonnet). Use for security audits and OWASP detection.",
      prompt: loadAgentPrompt("security-reviewer"),
      model: "sonnet",
      defaultModel: "sonnet"
    };
    codeReviewerAgent = {
      name: "code-reviewer",
      description: "Expert code review specialist (Opus). Use for comprehensive code quality review.",
      prompt: loadAgentPrompt("code-reviewer"),
      model: "opus",
      defaultModel: "opus"
    };
    gitMasterAgent = {
      name: "git-master",
      description: "Git expert for atomic commits, rebasing, and history management with style detection",
      prompt: loadAgentPrompt("git-master"),
      model: "sonnet",
      defaultModel: "sonnet"
    };
    codeSimplifierAgent = {
      name: "code-simplifier",
      description: "Simplifies and refines code for clarity, consistency, and maintainability (Opus).",
      prompt: loadAgentPrompt("code-simplifier"),
      model: "opus",
      defaultModel: "opus"
    };
  }
});

// src/features/delegation-enforcer.ts
function normalizeToCcAlias(model) {
  if (isProviderSpecificModelId(model)) {
    return model;
  }
  const family = resolveClaudeFamily(model);
  return family ? FAMILY_TO_ALIAS[family] ?? model : model;
}
var FAMILY_TO_ALIAS;
var init_delegation_enforcer = __esm({
  "src/features/delegation-enforcer.ts"() {
    "use strict";
    init_definitions();
    init_types2();
    init_loader();
    init_models();
    FAMILY_TO_ALIAS = {
      SONNET: "sonnet",
      OPUS: "opus",
      HAIKU: "haiku",
      FABLE: "fable"
    };
  }
});

// src/lib/security-config.ts
import { existsSync as existsSync12, readFileSync as readFileSync7 } from "fs";
import { join as join15 } from "path";
function loadSecurityFromConfigFiles() {
  const paths = [
    join15(process.cwd(), ".claude", "omc.jsonc"),
    join15(getConfigDir(), "claude-omc", "config.jsonc")
  ];
  for (const configPath of paths) {
    if (!existsSync12(configPath)) continue;
    try {
      const content = readFileSync7(configPath, "utf-8");
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
var DEFAULTS, STRICT_OVERRIDES, cachedConfig;
var init_security_config = __esm({
  "src/lib/security-config.ts"() {
    "use strict";
    init_jsonc();
    init_paths();
    DEFAULTS = {
      restrictToolPaths: false,
      pythonSandbox: false,
      disableProjectSkills: false,
      disableAutoUpdate: false,
      hardMaxIterations: 500,
      disableRemoteMcp: false,
      disableExternalLLM: false
    };
    STRICT_OVERRIDES = {
      restrictToolPaths: true,
      pythonSandbox: true,
      disableProjectSkills: true,
      disableAutoUpdate: true,
      hardMaxIterations: 200,
      disableRemoteMcp: true,
      disableExternalLLM: true
    };
    cachedConfig = null;
  }
});

// src/team/model-contract.ts
import { spawnSync as spawnSync3 } from "child_process";
import { isAbsolute as isAbsolute6, normalize as normalize3, sep as sep3, win32 as win32Path2 } from "path";
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
    trusted.push(`${home}/.grok/bin`);
  }
  const custom = (process.env.OMC_TRUSTED_CLI_DIRS ?? "").split(":").map((part) => part.trim()).filter(Boolean).filter((part) => isAbsolute6(part));
  trusted.push(...custom);
  return trusted;
}
function isTrustedPrefix(resolvedPath) {
  const normalized = normalize3(resolvedPath);
  return getTrustedPrefixes().some((prefix) => {
    const p = normalize3(prefix);
    if (normalized === p) return true;
    const withSep = p.endsWith(sep3) ? p : p + sep3;
    return normalized.startsWith(withSep);
  });
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
  const result = spawnSync3(finder, [binary], {
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
  const resolvedPath = normalize3(firstLine);
  if (!isAbsolute6(resolvedPath)) {
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
function shouldUseClaudeBareMode(env = process.env) {
  return typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.trim().length > 0;
}
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
  if (isAbsolute6(binary)) return;
  if (/^[A-Za-z0-9._-]+$/.test(binary)) return;
  throw new Error(`Unsafe CLI binary reference: ${binary}`);
}
function resolveBinaryPath(binary) {
  validateBinaryRef(binary);
  if (isAbsolute6(binary)) return binary;
  try {
    const resolver = process.platform === "win32" ? "where" : "which";
    const result = spawnSync3(resolver, [binary], { timeout: 5e3, encoding: "utf8" });
    if (result.status !== 0) return binary;
    const lines = result.stdout?.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) ?? [];
    const firstPath = lines[0];
    const isResolvedAbsolute = !!firstPath && (isAbsolute6(firstPath) || win32Path2.isAbsolute(firstPath));
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
function validateWorkerLaunchDescriptor(value) {
  const descriptor = value;
  if (!descriptor || descriptor.schema_version !== 1 || typeof descriptor.provider !== "string" || !Object.prototype.hasOwnProperty.call(descriptor, "model") || descriptor.model !== null && (typeof descriptor.model !== "string" || descriptor.model.length === 0) || typeof descriptor.binary !== "string" || descriptor.binary.length === 0 || descriptor.binary.includes("\0") || !(isAbsolute6(descriptor.binary) || win32Path2.isAbsolute(descriptor.binary)) || !Array.isArray(descriptor.args) || descriptor.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new Error("Invalid worker launch descriptor");
  }
  getContract(descriptor.provider);
  return {
    schema_version: 1,
    provider: descriptor.provider,
    model: descriptor.model,
    binary: descriptor.binary,
    args: [...descriptor.args]
  };
}
function buildValidatedWorkerLaunchDescriptor(agentType, config, appendedArgs = []) {
  const [binary, ...args] = buildWorkerArgv(agentType, config);
  return validateWorkerLaunchDescriptor({
    schema_version: 1,
    provider: agentType,
    model: config.model ?? null,
    binary,
    args: [...args, ...appendedArgs]
  });
}
function getWorkerEnv(teamName, workerName, agentType, env = process.env) {
  validateTeamName(teamName);
  const workerEnv = {
    OMC_TEAM_WORKER: `${teamName}/${workerName}`,
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
function isHeadlessSupportedOnPlatform(agentType, platform = process.platform) {
  if (agentType === "antigravity" && platform === "win32") {
    return false;
  }
  return true;
}
function assertHeadlessSupported(agentType) {
  if (!isHeadlessSupportedOnPlatform(agentType)) {
    throw new Error(
      `CLI agent '${agentType}' headless/prompt mode is not supported on Windows: \`agy --print\` takes the prompt as an argv value (it cannot read stdin) and has known upstream Windows \`-p\` limitations. Run '${agentType}' team workers on macOS/Linux, or use the 'gemini' provider on Windows.`
    );
  }
}
function getPromptModeArgs(agentType, instruction) {
  const contract = getContract(agentType);
  if (!contract.supportsPromptMode) {
    return [];
  }
  assertHeadlessSupported(agentType);
  if (contract.promptModeFlag) {
    return [contract.promptModeFlag, instruction];
  }
  return [instruction];
}
var resolvedPathCache, UNTRUSTED_PATH_PATTERNS, CONTRACTS, WORKER_MODEL_ENV_ALLOWLIST;
var init_model_contract = __esm({
  "src/team/model-contract.ts"() {
    "use strict";
    init_team_name();
    init_delegation_enforcer();
    init_models();
    init_security_config();
    resolvedPathCache = /* @__PURE__ */ new Map();
    UNTRUSTED_PATH_PATTERNS = [
      /^\/tmp(\/|$)/,
      /^\/var\/tmp(\/|$)/,
      /^\/dev\/shm(\/|$)/
    ];
    CONTRACTS = {
      claude: {
        agentType: "claude",
        binary: "claude",
        installInstructions: "Install Claude CLI: https://claude.ai/download",
        buildLaunchArgs(model, extraFlags = []) {
          const args = ["--dangerously-skip-permissions"];
          if (shouldUseClaudeBareMode() && !extraFlags.includes("--bare")) {
            args.push("--bare");
          }
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
        // Team workers must be persistent interactive panes. Do not use `codex exec`
        // or positional prompt mode here; runtime dispatch writes inbox.md and nudges
        // the live Codex TUI with `codex` as the worker process.
        supportsPromptMode: false,
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
          const args = ["--approval-mode", "yolo"];
          if (model) args.push("--model", model);
          return [...args, ...extraFlags];
        },
        parseOutput(rawOutput) {
          return rawOutput.trim();
        }
      },
      grok: {
        agentType: "grok",
        binary: "grok",
        installInstructions: "Install Grok Build: https://build.grok.com",
        supportsPromptMode: true,
        promptModeFlag: "-p",
        buildLaunchArgs(model, extraFlags = []) {
          const args = ["--always-approve"];
          if (model) args.push("--model", model);
          return [...args, ...extraFlags];
        },
        parseOutput(rawOutput) {
          return rawOutput.trim();
        }
      },
      antigravity: {
        agentType: "antigravity",
        binary: "agy",
        installInstructions: "Install the Antigravity CLI (agy) per the official instructions at https://antigravity.google, then verify with `agy --version`.",
        supportsPromptMode: true,
        promptModeFlag: "-p",
        buildLaunchArgs(model, extraFlags = []) {
          const args = ["--dangerously-skip-permissions"];
          if (model) args.push("--model", model);
          return [...args, ...extraFlags];
        },
        parseOutput(rawOutput) {
          return rawOutput.trim();
        }
      },
      cursor: {
        agentType: "cursor",
        binary: "cursor-agent",
        installInstructions: "Install Cursor Agent CLI: see https://docs.cursor.com/cli",
        // cursor-agent runs as an interactive REPL — no exit-on-complete prompt mode.
        // Keep supportsPromptMode false so the verdict-file contract path
        // (CONTRACT_ROLES + shouldInjectContract) skips this provider; cursor
        // workers participate as executors only.
        supportsPromptMode: false,
        buildLaunchArgs(_model, extraFlags = []) {
          return [...extraFlags];
        },
        parseOutput(rawOutput) {
          return rawOutput.trim();
        }
      }
    };
    WORKER_MODEL_ENV_ALLOWLIST = [
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
      "OMC_GEMINI_DEFAULT_MODEL",
      "OMC_EXTERNAL_MODELS_DEFAULT_GROK_MODEL",
      "OMC_GROK_DEFAULT_MODEL",
      "OMC_EXTERNAL_MODELS_DEFAULT_ANTIGRAVITY_MODEL",
      "OMC_ANTIGRAVITY_DEFAULT_MODEL"
    ];
  }
});

// src/team/worker-bootstrap.ts
import { mkdir as mkdir5, writeFile as writeFile3, appendFile as appendFile2 } from "fs/promises";
import { join as join16, dirname as dirname13 } from "path";
function buildInstructionPath(...parts) {
  return join16(...parts).replaceAll("\\", "/");
}
function buildTeamStateInstructionPath(teamName, instructionStateRoot, ...teamRelativeParts) {
  const baseParts = instructionStateRoot === DEFAULT_INSTRUCTION_STATE_ROOT ? [instructionStateRoot, "team", teamName] : [instructionStateRoot];
  return buildInstructionPath(...baseParts, ...teamRelativeParts);
}
function generateTriggerMessage(teamName, workerName, teamStateRoot3 = DEFAULT_INSTRUCTION_STATE_ROOT) {
  const inboxPath = buildTeamStateInstructionPath(teamName, teamStateRoot3, "workers", workerName, "inbox.md");
  if (teamStateRoot3 !== DEFAULT_INSTRUCTION_STATE_ROOT) {
    return `Read ${inboxPath}, work now, report progress.`;
  }
  return `Read ${inboxPath}, execute now, report concrete progress.`;
}
function generatePromptModeStartupPrompt(teamName, workerName, teamStateRoot3 = DEFAULT_INSTRUCTION_STATE_ROOT, cliOutputContract) {
  const inboxPath = buildTeamStateInstructionPath(teamName, teamStateRoot3, "workers", workerName, "inbox.md");
  const base = `Open ${inboxPath}. Follow it and begin the assigned work.`;
  return cliOutputContract ? `${base}
${cliOutputContract}` : base;
}
function generateMailboxTriggerMessage(teamName, workerName, count = 1, teamStateRoot3 = DEFAULT_INSTRUCTION_STATE_ROOT) {
  const normalizedCount = Number.isFinite(count) ? Math.max(1, Math.floor(count)) : 1;
  const mailboxPath = buildTeamStateInstructionPath(teamName, teamStateRoot3, "mailbox", `${workerName}.json`);
  if (teamStateRoot3 !== DEFAULT_INSTRUCTION_STATE_ROOT) {
    return `${normalizedCount} new msg(s): check ${mailboxPath}, act and report progress.`;
  }
  return `${normalizedCount} new msg(s). Read ${mailboxPath}, act now, report concrete progress.`;
}
function renderRecoveryContinuationInstruction(instruction) {
  const checkpoint = formatOmcCliInvocation(`team api write-task-checkpoint --input "{\\"team_name\\":\\"${instruction.teamName}\\",\\"task_id\\":\\"${instruction.taskId}\\",\\"worker\\":\\"${instruction.workerName}\\",\\"claim_token\\":\\"${instruction.claimToken}\\",\\"task_version\\":${instruction.taskVersion},\\"sequence\\":<next_sequence>,\\"resume_payload\\":<safe_boundary_json>}" --json`);
  return [
    "## Recovery Continuation",
    `You own adopted task ${instruction.taskId} at checkpoint sequence ${instruction.sequence}.`,
    "Resume only from this owner-provided safe boundary; do not claim the task again or alter its lifecycle ownership.",
    `Checkpoint payload: \`${JSON.stringify(instruction.resumePayload)}\``,
    `Before a risky boundary and before yielding, publish the next authenticated checkpoint: \`${checkpoint}\`.`
  ].join("\n");
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
    case "cursor":
      return [
        "### Agent-Type Guidance (cursor)",
        "- You are an interactive REPL (cursor-agent), not a one-shot CLI. Stay in the session; the leader will continue to send prompts via mailbox.",
        `- You MUST run \`${claimTaskCommand}\` before starting work and \`${transitionTaskStatusCommand}\` when done. Then keep waiting for the next mailbox message; do NOT type \`/exit\` unless the leader sends an explicit shutdown.`,
        "- Reviewer/critic/security-review roles are NOT supported for cursor workers \u2014 those require a verdict-file write-and-exit which the REPL does not perform. Take only executor-style tasks."
      ].join("\n");
    case "grok":
      return [
        "### Agent-Type Guidance (grok)",
        `- Prefer short, explicit \`${teamApiCommand} ... --json\` commands and parse outputs before next step.`,
        "- If a command fails, report the exact stderr to leader-fixed before retrying.",
        `- You MUST run \`${claimTaskCommand}\` before starting work and \`${transitionTaskStatusCommand}\` when done.`
      ].join("\n");
    case "antigravity":
      return [
        "### Agent-Type Guidance (antigravity)",
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
  const { teamName, workerName, agentType, tasks, bootstrapInstructions } = params;
  const instructionStateRoot = params.instructionStateRoot ?? DEFAULT_INSTRUCTION_STATE_ROOT;
  const sanitizedTasks = tasks.map((t) => ({
    id: t.id,
    subject: sanitizePromptContent(t.subject),
    description: sanitizePromptContent(t.description)
  }));
  const sentinelPath = buildTeamStateInstructionPath(teamName, instructionStateRoot, "workers", workerName, ".ready");
  const heartbeatPath = buildTeamStateInstructionPath(teamName, instructionStateRoot, "workers", workerName, "heartbeat.json");
  const inboxPath = buildTeamStateInstructionPath(teamName, instructionStateRoot, "workers", workerName, "inbox.md");
  const statusPath = buildTeamStateInstructionPath(teamName, instructionStateRoot, "workers", workerName, "status.json");
  const shutdownAckPath = buildTeamStateInstructionPath(teamName, instructionStateRoot, "workers", workerName, "shutdown-ack.json");
  const claimTaskCommand = formatOmcCliInvocation(`team api claim-task --input "{\\"team_name\\":\\"${teamName}\\",\\"task_id\\":\\"<id>\\",\\"worker\\":\\"${workerName}\\"}" --json`);
  const sendAckCommand = formatOmcCliInvocation(`team api send-message --input "{\\"team_name\\":\\"${teamName}\\",\\"from_worker\\":\\"${workerName}\\",\\"to_worker\\":\\"leader-fixed\\",\\"body\\":\\"ACK: ${workerName} initialized\\"}" --json`);
  const completeTaskCommand = formatOmcCliInvocation(`team api transition-task-status --input "{\\"team_name\\":\\"${teamName}\\",\\"task_id\\":\\"<id>\\",\\"from\\":\\"in_progress\\",\\"to\\":\\"completed\\",\\"claim_token\\":\\"<claim_token>\\",\\"result\\":\\"Summary: <what changed>\\\\nVerification: <tests/checks run>\\\\nSubagent skip reason: worker protocol forbids nested subagents; completed focused probe in-session\\"}" --json`);
  const failTaskCommand = formatOmcCliInvocation(`team api transition-task-status --input "{\\"team_name\\":\\"${teamName}\\",\\"task_id\\":\\"<id>\\",\\"from\\":\\"in_progress\\",\\"to\\":\\"failed\\",\\"claim_token\\":\\"<claim_token>\\"}" --json`);
  const readTaskCommand = formatOmcCliInvocation(`team api read-task --input "{\\"team_name\\":\\"${teamName}\\",\\"task_id\\":\\"<id>\\"}" --json`);
  const releaseClaimCommand = formatOmcCliInvocation(`team api release-task-claim --input "{\\"team_name\\":\\"${teamName}\\",\\"task_id\\":\\"<id>\\",\\"claim_token\\":\\"<claim_token>\\",\\"worker\\":\\"${workerName}\\"}" --json`);
  const mailboxListCommand = formatOmcCliInvocation(`team api mailbox-list --input "{\\"team_name\\":\\"${teamName}\\",\\"worker\\":\\"${workerName}\\"}" --json`);
  const mailboxDeliveredCommand = formatOmcCliInvocation(`team api mailbox-mark-delivered --input "{\\"team_name\\":\\"${teamName}\\",\\"worker\\":\\"${workerName}\\",\\"message_id\\":\\"<id>\\"}" --json`);
  const checkpointTaskCommand = formatOmcCliInvocation(`team api write-task-checkpoint --input "{\\"team_name\\":\\"${teamName}\\",\\"task_id\\":\\"<id>\\",\\"worker\\":\\"${workerName}\\",\\"claim_token\\":\\"<claim_token>\\",\\"task_version\\":<current_task_version>,\\"sequence\\":<next_sequence>,\\"resume_payload\\":<safe_boundary_json>}" --json`);
  const teamApiCommand = formatOmcCliInvocation("team api");
  const teamCommand2 = formatOmcCliInvocation("team");
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

## Recovery-safe Boundaries
- While a task is claimed, publish an authenticated checkpoint before a risky operation, before handoff, and before stopping: \`${checkpointTaskCommand}\`.
- The resume payload must describe a completed safe boundary and the exact next action; never include credentials or future recovery IDs.
- Checkpoint publication is worker guidance only. Recovery activation is enforced by the runtime wrapper, not by prompt compliance.

## Identity
- **Team**: ${teamName}
- **Worker**: ${workerName}
- **Agent Type**: ${agentType}
- **Environment**: OMC_TEAM_WORKER=${teamName}/${workerName}

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
- Delegation compliance evidence (required for broad delegated tasks):
  - The completion command MUST include a \`result\` string with summary and verification evidence.
  - Because worker protocol forbids nested sub-agents, use: \`Subagent skip reason: <why in-session execution was safer/sufficient>\`
  - Only if the leader explicitly grants an exception to spawn nested help, use: \`Subagent spawn evidence: <count, child task names/thread ids, and integrated findings>\`
  - Completion is rejected with \`missing_delegation_compliance_evidence\` when required evidence is absent.

## Canonical Team State Root
- Resolve the team state root in this order: \`OMC_TEAM_STATE_ROOT\` env -> worker identity \`team_state_root\` -> config/manifest \`team_state_root\` -> ${params.cwd}/.omc/state/team/${teamName}.
- \`OMC_TEAM_STATE_ROOT\` is the team-specific root (\`.../.omc/state/team/${teamName}\`). When it is set, append worker/mailbox paths directly below it; do not append another \`team/${teamName}\` segment.
- Worktree-backed workers MUST use the canonical leader-owned state root for inbox, mailbox, task lifecycle, status, heartbeat, and shutdown files; do not use a local worktree \`.omc/state\` when \`OMC_TEAM_STATE_ROOT\` is set.

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
- To leader: \`${formatOmcCliInvocation(`team api send-message --input "{\\"team_name\\":\\"${teamName}\\",\\"from_worker\\":\\"${workerName}\\",\\"to_worker\\":\\"leader-fixed\\",\\"body\\":\\"<message>\\"}" --json`)}\`
- Check mailbox: \`${mailboxListCommand}\`
- Mark delivered: \`${mailboxDeliveredCommand}\`

## Startup Handshake (Required)
Before doing any task work, send exactly one startup ACK to the leader:
\`${sendAckCommand}\`

## Shutdown Protocol
When you see a shutdown request in your inbox:
1. Write your decision to: ${shutdownAckPath}
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
- Do NOT run team spawning/orchestration commands (for example: \`${teamCommand2} ...\`, \`omx team ...\`, \`$team\`, \`$ultrawork\`, \`$autopilot\`, \`$ralph\`).
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
async function composeInitialInbox(teamName, workerName, content, cwd, cliOutputContract) {
  const inboxPath = join16(cwd, `.omc/state/team/${teamName}/workers/${workerName}/inbox.md`);
  await mkdir5(dirname13(inboxPath), { recursive: true });
  const finalContent = cliOutputContract && !content.includes(cliOutputContract) ? `${content}
${cliOutputContract}` : content;
  await writeFile3(inboxPath, finalContent, "utf-8");
}
async function appendToInbox(teamName, workerName, message, cwd) {
  const safeTeam = sanitizeName(teamName);
  const safeWorker = sanitizeName(workerName);
  const inboxPath = join16(cwd, `.omc/state/team/${safeTeam}/workers/${safeWorker}/inbox.md`);
  validateResolvedPath(inboxPath, cwd);
  await mkdir5(dirname13(inboxPath), { recursive: true });
  await appendFile2(inboxPath, `

---
${message}`, "utf-8");
}
async function ensureWorkerStateDir(teamName, workerName, cwd) {
  const workerDir = join16(cwd, `.omc/state/team/${teamName}/workers/${workerName}`);
  await mkdir5(workerDir, { recursive: true });
  const mailboxDir = join16(cwd, `.omc/state/team/${teamName}/mailbox`);
  await mkdir5(mailboxDir, { recursive: true });
  const tasksDir = join16(cwd, `.omc/state/team/${teamName}/tasks`);
  await mkdir5(tasksDir, { recursive: true });
}
async function writeWorkerOverlay(params) {
  const { teamName, workerName, cwd } = params;
  const overlay = generateWorkerOverlay(params);
  const overlayPath = join16(cwd, `.omc/state/team/${teamName}/workers/${workerName}/AGENTS.md`);
  await mkdir5(dirname13(overlayPath), { recursive: true });
  await writeFile3(overlayPath, overlay, "utf-8");
  return overlayPath;
}
var DEFAULT_INSTRUCTION_STATE_ROOT;
var init_worker_bootstrap = __esm({
  "src/team/worker-bootstrap.ts"() {
    "use strict";
    init_prompt_helpers();
    init_omc_cli_rendering();
    init_tmux_session();
    init_fs_utils();
    init_model_contract();
    DEFAULT_INSTRUCTION_STATE_ROOT = ".omc/state";
  }
});

// src/lib/worktree-cleanup-safety.ts
import { existsSync as existsSync13, lstatSync, realpathSync as realpathSync4 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { isAbsolute as isAbsolute7, join as join17, parse as parse2, relative as relative4, resolve as resolve4 } from "node:path";
function realpathOrResolve(path4) {
  try {
    return realpathSync4(path4);
  } catch {
    return resolve4(path4);
  }
}
function assertSafeBoundary(path4, label) {
  const trimmed = path4.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label}_empty`);
  }
  if (trimmed.includes("\0")) {
    throw new Error(`${label}_contains_nul`);
  }
  const resolved = realpathOrResolve(trimmed);
  const root = parse2(resolved).root;
  const home = realpathOrResolve(homedir4());
  if (resolved === root) {
    throw new Error(`${label}_is_filesystem_root:${resolved}`);
  }
  if (resolved === home) {
    throw new Error(`${label}_is_home_directory:${resolved}`);
  }
  return resolved;
}
function isInside(parent, child) {
  const rel = relative4(parent, child);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute7(rel);
}
function validateWorktreeRemovalTarget(options) {
  const { candidatePath, expectedRoots, mainRepoRoots = [], requireExisting = true } = options;
  if (expectedRoots.length === 0) {
    throw new Error("expected_worktree_roots_empty");
  }
  const rawCandidate = candidatePath.trim();
  if (rawCandidate.length === 0) {
    throw new Error("worktree_path_empty");
  }
  if (rawCandidate.includes("\0")) {
    throw new Error("worktree_path_contains_nul");
  }
  if (rawCandidate === "." || rawCandidate === ".." || rawCandidate === "~") {
    throw new Error(`worktree_path_suspicious:${rawCandidate}`);
  }
  const lexicalPath = resolve4(rawCandidate);
  if (!existsSync13(lexicalPath)) {
    if (requireExisting) {
      throw new Error(`worktree_path_missing:${lexicalPath}`);
    }
  } else {
    const stat2 = lstatSync(lexicalPath);
    if (stat2.isSymbolicLink()) {
      throw new Error(`worktree_path_is_symlink:${lexicalPath}`);
    }
    if (!stat2.isDirectory()) {
      throw new Error(`worktree_path_not_directory:${lexicalPath}`);
    }
  }
  const resolvedPath = assertSafeBoundary(candidatePath, "worktree_path");
  const matchedRoot = expectedRoots.map((root) => assertSafeBoundary(root, "worktree_root")).find((root) => isInside(root, resolvedPath));
  if (!matchedRoot) {
    throw new Error(`worktree_path_outside_expected_roots:${resolvedPath}`);
  }
  for (const repoRoot of mainRepoRoots) {
    if (repoRoot.trim().length === 0) continue;
    const resolvedRepoRoot = realpathOrResolve(repoRoot);
    if (resolvedPath === resolvedRepoRoot) {
      throw new Error(`worktree_path_is_main_repo:${resolvedPath}`);
    }
  }
  if (existsSync13(join17(resolvedPath, ".git"))) {
    const gitStat = lstatSync(join17(resolvedPath, ".git"));
    if (gitStat.isDirectory()) {
      throw new Error(`worktree_path_is_main_repo:${resolvedPath}`);
    }
  }
  return { resolvedPath, matchedRoot };
}
var init_worktree_cleanup_safety = __esm({
  "src/lib/worktree-cleanup-safety.ts"() {
    "use strict";
  }
});

// src/lib/atomic-write.ts
import * as fs2 from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import * as crypto from "crypto";
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
async function atomicWriteJson2(filePath, data) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tempPath = path.join(dir, `.${base}.tmp.${crypto.randomUUID()}`);
  let success = false;
  try {
    ensureDirSync(dir);
    const jsonContent = Buffer.from(JSON.stringify(data, null, 2), "utf-8");
    const fd = await fs2.open(tempPath, "wx", 384);
    try {
      let offset = 0;
      while (offset < jsonContent.length) {
        const { bytesWritten } = await fd.write(
          jsonContent,
          offset,
          jsonContent.length - offset,
          offset
        );
        if (bytesWritten === 0) {
          throw new Error("Failed to write complete JSON payload");
        }
        offset += bytesWritten;
      }
      await fd.sync();
    } finally {
      await fd.close();
    }
    await fs2.rename(tempPath, filePath);
    success = true;
    try {
      const dirFd = await fs2.open(dir, "r");
      try {
        await dirFd.sync();
      } finally {
        await dirFd.close();
      }
    } catch {
    }
  } finally {
    if (!success) {
      await fs2.unlink(tempPath).catch(() => {
      });
    }
  }
}
var ATOMIC_BATCH_MAX_CONTENT_BYTES;
var init_atomic_write = __esm({
  "src/lib/atomic-write.ts"() {
    "use strict";
    ATOMIC_BATCH_MAX_CONTENT_BYTES = 1024 * 1024;
  }
});

// src/platform/process-utils.ts
import { execFileSync as execFileSync4, execFile as execFile3 } from "child_process";
import { promisify as promisify3 } from "util";
import * as fsPromises from "fs/promises";
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
var execFileAsync2;
var init_process_utils = __esm({
  "src/platform/process-utils.ts"() {
    "use strict";
    execFileAsync2 = promisify3(execFile3);
  }
});

// src/platform/index.ts
import * as path2 from "path";
import { readFileSync as readFileSync8 } from "fs";
var PLATFORM;
var init_platform = __esm({
  "src/platform/index.ts"() {
    "use strict";
    init_process_utils();
    PLATFORM = process.platform;
  }
});

// src/lib/file-lock.ts
var file_lock_exports = {};
__export(file_lock_exports, {
  acquireFileLock: () => acquireFileLock,
  acquireFileLockSync: () => acquireFileLockSync,
  lockPathFor: () => lockPathFor,
  releaseFileLock: () => releaseFileLock,
  releaseFileLockSync: () => releaseFileLockSync,
  withFileLock: () => withFileLock,
  withFileLockSync: () => withFileLockSync
});
import {
  openSync as openSync3,
  closeSync as closeSync3,
  unlinkSync as unlinkSync6,
  writeSync as writeSync3,
  readFileSync as readFileSync9,
  statSync as statSync2,
  constants as fsConstants
} from "fs";
import * as path3 from "path";
function isLockStale(lockPath, staleLockMs) {
  try {
    const stat2 = statSync2(lockPath);
    const ageMs = Date.now() - stat2.mtimeMs;
    if (ageMs < staleLockMs) return false;
    try {
      const raw = readFileSync9(lockPath, "utf-8");
      const payload = JSON.parse(raw);
      if (payload.pid && isProcessAlive(payload.pid)) return false;
    } catch {
    }
    return true;
  } catch {
    return false;
  }
}
function lockPathFor(filePath) {
  return filePath + ".lock";
}
function tryAcquireSync(lockPath, staleLockMs) {
  ensureDirSync(path3.dirname(lockPath));
  try {
    const fd = openSync3(
      lockPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      384
    );
    try {
      const payload = JSON.stringify({ pid: process.pid, timestamp: Date.now() });
      writeSync3(fd, payload, null, "utf-8");
    } catch (writeErr) {
      try {
        closeSync3(fd);
      } catch {
      }
      try {
        unlinkSync6(lockPath);
      } catch {
      }
      throw writeErr;
    }
    return { fd, path: lockPath };
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "EEXIST") {
      if (isLockStale(lockPath, staleLockMs)) {
        try {
          unlinkSync6(lockPath);
        } catch {
        }
        try {
          const fd = openSync3(
            lockPath,
            fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
            384
          );
          try {
            const payload = JSON.stringify({ pid: process.pid, timestamp: Date.now() });
            writeSync3(fd, payload, null, "utf-8");
          } catch (writeErr) {
            try {
              closeSync3(fd);
            } catch {
            }
            try {
              unlinkSync6(lockPath);
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
    closeSync3(handle.fd);
  } catch {
  }
  try {
    unlinkSync6(handle.path);
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
function sleep2(ms) {
  return new Promise((resolve7) => setTimeout(resolve7, ms));
}
async function acquireFileLock(lockPath, opts) {
  const staleLockMs = opts?.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const timeoutMs = opts?.timeoutMs ?? 0;
  const retryDelayMs = opts?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const handle = tryAcquireSync(lockPath, staleLockMs);
  if (handle || timeoutMs <= 0) return handle;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep2(Math.min(retryDelayMs, deadline - Date.now()));
    const retryHandle = tryAcquireSync(lockPath, staleLockMs);
    if (retryHandle) return retryHandle;
  }
  return null;
}
function releaseFileLock(handle) {
  releaseFileLockSync(handle);
}
async function withFileLock(lockPath, fn, opts) {
  const handle = await acquireFileLock(lockPath, opts);
  if (!handle) {
    throw new Error(`Failed to acquire file lock: ${lockPath}`);
  }
  try {
    return await fn();
  } finally {
    releaseFileLock(handle);
  }
}
var DEFAULT_STALE_LOCK_MS, DEFAULT_RETRY_DELAY_MS;
var init_file_lock = __esm({
  "src/lib/file-lock.ts"() {
    "use strict";
    init_atomic_write();
    init_platform();
    DEFAULT_STALE_LOCK_MS = 3e4;
    DEFAULT_RETRY_DELAY_MS = 50;
  }
});

// src/team/git-worktree.ts
import { existsSync as existsSync15, realpathSync as realpathSync5, readFileSync as readFileSync10, readdirSync as readdirSync5, rmSync as rmSync2, unlinkSync as unlinkSync7, writeFileSync as writeFileSync5 } from "node:fs";
import { join as join19, resolve as resolve5 } from "node:path";
import { execFileSync as execFileSync5 } from "node:child_process";
function getWorktreePath(repoRoot, teamName, workerName) {
  return join19(getOmcRoot(repoRoot), "team", sanitizeName(teamName), "worktrees", sanitizeName(workerName));
}
function getBranchName(teamName, workerName) {
  return `omc-team/${sanitizeName(teamName)}/${sanitizeName(workerName)}`;
}
function git(repoRoot, args, cwd = repoRoot) {
  return execFileSync5("git", args, { cwd, encoding: "utf-8", stdio: "pipe", windowsHide: true }).trim();
}
function isInsideGitRepo(repoRoot) {
  try {
    git(repoRoot, ["rev-parse", "--show-toplevel"]);
    return true;
  } catch {
    return false;
  }
}
function assertCleanLeaderWorktree(repoRoot) {
  const status = git(repoRoot, ["status", "--porcelain"]).split("\n").filter((line) => line.trim() !== "" && !/^\?\? \.omc(?:\/|$)/.test(line)).join("\n").trim();
  if (status.length > 0) {
    const error = new Error("leader_worktree_dirty: commit, stash, or clean changes before enabling team worktree mode");
    error.code = "leader_worktree_dirty";
    throw error;
  }
}
function canonicalPathForComparison(path4) {
  try {
    return realpathSync5(path4);
  } catch {
    return resolve5(path4);
  }
}
function getRegisteredWorktreeBranch(repoRoot, wtPath) {
  try {
    const output2 = git(repoRoot, ["worktree", "list", "--porcelain"]);
    const resolvedWtPath = canonicalPathForComparison(wtPath);
    let currentMatches = false;
    for (const line of output2.split("\n")) {
      if (line.startsWith("worktree ")) {
        currentMatches = canonicalPathForComparison(line.slice("worktree ".length).trim()) === resolvedWtPath;
        continue;
      }
      if (!currentMatches) continue;
      if (line.startsWith("branch ")) return line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
      if (line === "detached") return "HEAD";
    }
  } catch {
  }
  return void 0;
}
function isRegisteredWorktreePath(repoRoot, wtPath) {
  try {
    const output2 = git(repoRoot, ["worktree", "list", "--porcelain"]);
    const resolvedWtPath = canonicalPathForComparison(wtPath);
    return output2.split("\n").some((line) => line.startsWith("worktree ") && canonicalPathForComparison(line.slice("worktree ".length).trim()) === resolvedWtPath);
  } catch {
    return false;
  }
}
function isDetached(wtPath) {
  try {
    const branch = execFileSync5("git", ["branch", "--show-current"], { cwd: wtPath, encoding: "utf-8", stdio: "pipe", windowsHide: true }).trim();
    return branch.length === 0;
  } catch {
    return false;
  }
}
function isWorktreeDirty(wtPath) {
  return isWorktreeDirtyExcept(wtPath).dirty;
}
function normalizeStatusPath(rawPath) {
  const trimmed = rawPath.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}
function statusEntryPath(line) {
  const payload = line.slice(3);
  const renameSeparator = " -> ";
  const renameIndex = payload.indexOf(renameSeparator);
  return normalizeStatusPath(renameIndex >= 0 ? payload.slice(renameIndex + renameSeparator.length) : payload);
}
function isWorktreeDirtyExcept(wtPath, ignoredRootPaths = []) {
  try {
    const ignored = new Set(ignoredRootPaths);
    const entries = execFileSync5("git", ["status", "--porcelain"], { cwd: wtPath, encoding: "utf-8", stdio: "pipe", windowsHide: true }).split("\n").filter((line) => line.trim().length > 0);
    const relevantEntries = entries.filter((line) => !ignored.has(statusEntryPath(line)));
    return { dirty: relevantEntries.length > 0, entries: relevantEntries };
  } catch {
    return { dirty: true, entries: ["git_status_failed"] };
  }
}
function getMetadataPath(repoRoot, teamName) {
  return join19(getOmcRoot(repoRoot), "state", "team", sanitizeName(teamName), "worktrees.json");
}
function getLegacyMetadataPath(repoRoot, teamName) {
  return join19(getOmcRoot(repoRoot), "state", "team-bridge", sanitizeName(teamName), "worktrees.json");
}
function getWorkerStateDir(repoRoot, teamName, workerName) {
  return join19(getOmcRoot(repoRoot), "state", "team", sanitizeName(teamName), "workers", sanitizeName(workerName));
}
function getRootAgentsBackupPath(repoRoot, teamName, workerName) {
  return join19(getWorkerStateDir(repoRoot, teamName, workerName), "worktree-root-agents.json");
}
function readRootAgentsBackup(repoRoot, teamName, workerName) {
  const backupPath = getRootAgentsBackupPath(repoRoot, teamName, workerName);
  if (!existsSync15(backupPath)) return null;
  try {
    return JSON.parse(readFileSync10(backupPath, "utf-8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[omc] warning: worktree root AGENTS backup parse error: ${msg}
`);
    const error = new Error(`worktree_root_agents_backup_unreadable:${backupPath}:${msg}`);
    error.code = "worktree_root_agents_backup_unreadable";
    throw error;
  }
}
function installWorktreeRootAgents(teamName, workerName, repoRoot, worktreePath, overlayContent) {
  const omcRoot = getOmcRoot(repoRoot);
  validateResolvedPath(worktreePath, omcRoot);
  const agentsPath = join19(worktreePath, "AGENTS.md");
  validateResolvedPath(agentsPath, worktreePath);
  const backupPath = getRootAgentsBackupPath(repoRoot, teamName, workerName);
  validateResolvedPath(backupPath, omcRoot);
  ensureDirWithMode(getWorkerStateDir(repoRoot, teamName, workerName));
  const previous = readRootAgentsBackup(repoRoot, teamName, workerName);
  const currentContent = existsSync15(agentsPath) ? readFileSync10(agentsPath, "utf-8") : void 0;
  if (previous && currentContent !== void 0 && currentContent !== previous.installedContent) {
    const error = new Error(`agents_dirty: preserving modified worktree root AGENTS.md at ${agentsPath}`);
    error.code = "agents_dirty";
    throw error;
  }
  const backup = previous ? { ...previous, worktreePath, installedContent: overlayContent, installedAt: (/* @__PURE__ */ new Date()).toISOString() } : {
    worktreePath,
    hadOriginal: currentContent !== void 0,
    ...currentContent !== void 0 ? { originalContent: currentContent } : {},
    installedContent: overlayContent,
    installedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  atomicWriteJson(backupPath, backup);
  writeFileSync5(agentsPath, overlayContent, "utf-8");
}
function restoreWorktreeRootAgents(teamName, workerName, repoRoot, worktreePath) {
  const omcRoot = getOmcRoot(repoRoot);
  const backupPath = getRootAgentsBackupPath(repoRoot, teamName, workerName);
  validateResolvedPath(backupPath, omcRoot);
  const backup = readRootAgentsBackup(repoRoot, teamName, workerName);
  if (!backup) return { restored: false, reason: "no_backup" };
  const resolvedWorktreePath = worktreePath ?? backup.worktreePath;
  validateResolvedPath(resolvedWorktreePath, omcRoot);
  if (!existsSync15(resolvedWorktreePath)) {
    try {
      unlinkSync7(backupPath);
    } catch {
    }
    return { restored: false, reason: "worktree_missing" };
  }
  const agentsPath = join19(resolvedWorktreePath, "AGENTS.md");
  validateResolvedPath(agentsPath, resolvedWorktreePath);
  const currentContent = existsSync15(agentsPath) ? readFileSync10(agentsPath, "utf-8") : void 0;
  const isPartialInstallOriginal = backup.hadOriginal && currentContent === (backup.originalContent ?? "");
  if (currentContent !== void 0 && currentContent !== backup.installedContent && !isPartialInstallOriginal) {
    return { restored: false, reason: "agents_dirty" };
  }
  if (backup.hadOriginal) {
    writeFileSync5(agentsPath, backup.originalContent ?? "", "utf-8");
  } else if (existsSync15(agentsPath)) {
    unlinkSync7(agentsPath);
  }
  try {
    unlinkSync7(backupPath);
  } catch {
  }
  return { restored: true };
}
function readMetadataResult(repoRoot, teamName) {
  const paths = [getMetadataPath(repoRoot, teamName), getLegacyMetadataPath(repoRoot, teamName)];
  const byWorker = /* @__PURE__ */ new Map();
  const issues = [];
  for (const metaPath of paths) {
    if (!existsSync15(metaPath)) continue;
    try {
      const entries = JSON.parse(readFileSync10(metaPath, "utf-8"));
      for (const entry of entries) byWorker.set(entry.workerName, entry);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      issues.push({ path: metaPath, message });
      process.stderr.write(`[omc] warning: worktrees.json parse error at ${metaPath}: ${message}
`);
    }
  }
  return { entries: [...byWorker.values()], issues };
}
function readMetadata(repoRoot, teamName) {
  return readMetadataResult(repoRoot, teamName).entries;
}
function listRootAgentsBackupIssues(repoRoot, teamName, entries) {
  const workersDir = join19(getOmcRoot(repoRoot), "state", "team", sanitizeName(teamName), "workers");
  if (!existsSync15(workersDir)) return [];
  const knownWorkers = new Set(entries.map((entry) => sanitizeName(entry.workerName)));
  const issues = [];
  for (const workerName of readdirSync5(workersDir)) {
    const backupPath = join19(workersDir, workerName, "worktree-root-agents.json");
    if (!existsSync15(backupPath)) continue;
    try {
      JSON.parse(readFileSync10(backupPath, "utf-8"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      issues.push({ path: backupPath, message: `worktree_root_agents_backup_unreadable:${workerName}:${message}` });
      continue;
    }
    if (!knownWorkers.has(sanitizeName(workerName))) {
      issues.push({
        path: backupPath,
        message: `orphaned_worktree_root_agents_backup:${workerName}`
      });
    }
  }
  return issues;
}
function writeMetadata(repoRoot, teamName, entries) {
  const metaPath = getMetadataPath(repoRoot, teamName);
  validateResolvedPath(metaPath, join19(getOmcRoot(repoRoot), "state", "team"));
  ensureDirWithMode(join19(getOmcRoot(repoRoot), "state", "team", sanitizeName(teamName)));
  atomicWriteJson(metaPath, entries);
}
function recordMetadata(repoRoot, teamName, info) {
  const metaLockPath = getMetadataPath(repoRoot, teamName) + ".lock";
  withFileLockSync(metaLockPath, () => {
    const existing = readMetadata(repoRoot, teamName).filter((entry) => entry.workerName !== info.workerName);
    writeMetadata(repoRoot, teamName, [...existing, info]);
  });
}
function forgetMetadataUnlocked(repoRoot, teamName, workerName) {
  const existing = readMetadata(repoRoot, teamName).filter((entry) => entry.workerName !== workerName);
  writeMetadata(repoRoot, teamName, existing);
}
function assertCompatibleExistingWorktree(repoRoot, wtPath, expectedBranch, mode) {
  const registeredBranch = getRegisteredWorktreeBranch(repoRoot, wtPath);
  if (!registeredBranch) {
    const error = new Error(`worktree_path_mismatch: existing path is not a registered git worktree: ${wtPath}`);
    error.code = "worktree_path_mismatch";
    throw error;
  }
  if (isWorktreeDirty(wtPath)) {
    const error = new Error(`worktree_dirty: preserving dirty worker worktree at ${wtPath}`);
    error.code = "worktree_dirty";
    throw error;
  }
  if (mode === "named" && registeredBranch !== expectedBranch) {
    const error = new Error(`worktree_mismatch: expected branch ${expectedBranch} at ${wtPath}, found ${registeredBranch}`);
    error.code = "worktree_mismatch";
    throw error;
  }
  if (mode === "detached" && registeredBranch !== "HEAD") {
    const error = new Error(`worktree_mismatch: expected detached worktree at ${wtPath}, found ${registeredBranch}`);
    error.code = "worktree_mismatch";
    throw error;
  }
}
function normalizeTeamWorktreeMode(value) {
  if (typeof value !== "string") return "disabled";
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled", "detached"].includes(normalized)) return "detached";
  if (["branch", "named", "named-branch"].includes(normalized)) return "named";
  return "disabled";
}
function ensureWorkerWorktree(teamName, workerName, repoRoot, options = {}) {
  const mode = options.mode ?? "disabled";
  if (mode === "disabled") return null;
  if (!isInsideGitRepo(repoRoot)) {
    throw new Error(`not_a_git_repository: ${repoRoot}`);
  }
  if (options.requireCleanLeader !== false) {
    assertCleanLeaderWorktree(repoRoot);
  }
  const wtPath = getWorktreePath(repoRoot, teamName, workerName);
  const branch = mode === "named" ? getBranchName(teamName, workerName) : "HEAD";
  validateResolvedPath(wtPath, join19(getOmcRoot(repoRoot), "team"));
  try {
    execFileSync5("git", ["worktree", "prune"], { cwd: repoRoot, stdio: "pipe", windowsHide: true });
  } catch {
  }
  if (existsSync15(wtPath)) {
    assertCompatibleExistingWorktree(repoRoot, wtPath, branch, mode);
    const info2 = {
      path: wtPath,
      branch,
      workerName,
      teamName,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      repoRoot,
      mode,
      detached: isDetached(wtPath),
      created: false,
      reused: true
    };
    recordMetadata(repoRoot, teamName, info2);
    return info2;
  }
  const wtDir = join19(getOmcRoot(repoRoot), "team", sanitizeName(teamName), "worktrees");
  ensureDirWithMode(wtDir);
  const args = mode === "named" ? ["worktree", "add", "-b", branch, wtPath, options.baseRef ?? "HEAD"] : ["worktree", "add", "--detach", wtPath, options.baseRef ?? "HEAD"];
  execFileSync5("git", args, { cwd: repoRoot, stdio: "pipe", windowsHide: true });
  const info = {
    path: wtPath,
    branch,
    workerName,
    teamName,
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    repoRoot,
    mode,
    detached: mode === "detached",
    created: true,
    reused: false
  };
  recordMetadata(repoRoot, teamName, info);
  return info;
}
function checkWorkerWorktreeRemovalSafety(teamName, workerName, repoRoot, worktreePath) {
  const wtPath = worktreePath ?? getWorktreePath(repoRoot, teamName, workerName);
  const backup = readRootAgentsBackup(repoRoot, teamName, workerName);
  if (!existsSync15(wtPath)) return;
  validateWorktreeRemovalTarget({
    candidatePath: wtPath,
    expectedRoots: [join19(getOmcRoot(repoRoot), "team", sanitizeName(teamName), "worktrees")],
    mainRepoRoots: [repoRoot]
  });
  let ignoreRootAgents = false;
  if (backup) {
    const agentsPath = join19(wtPath, "AGENTS.md");
    validateResolvedPath(agentsPath, wtPath);
    const currentContent = existsSync15(agentsPath) ? readFileSync10(agentsPath, "utf-8") : void 0;
    const isPartialInstallOriginal = backup.hadOriginal && currentContent === (backup.originalContent ?? "");
    if (currentContent !== void 0 && currentContent !== backup.installedContent && !isPartialInstallOriginal) {
      const error = new Error(`agents_dirty: preserving modified worktree root AGENTS.md at ${agentsPath}`);
      error.code = "agents_dirty";
      throw error;
    }
    ignoreRootAgents = true;
  }
  const dirtyCheck = isWorktreeDirtyExcept(wtPath, ignoreRootAgents ? ["AGENTS.md"] : []);
  if (dirtyCheck.dirty) {
    const error = new Error(`worktree_dirty: preserving dirty worker worktree at ${wtPath}`);
    error.code = "worktree_dirty";
    throw error;
  }
}
function prepareWorkerWorktreeForRemoval(teamName, workerName, repoRoot, worktreePath) {
  const wtPath = worktreePath ?? getWorktreePath(repoRoot, teamName, workerName);
  checkWorkerWorktreeRemovalSafety(teamName, workerName, repoRoot, wtPath);
  const agentsRestore = restoreWorktreeRootAgents(teamName, workerName, repoRoot, wtPath);
  if (agentsRestore.reason === "agents_dirty") {
    const error = new Error(`agents_dirty: preserving modified worktree root AGENTS.md at ${join19(wtPath, "AGENTS.md")}`);
    error.code = "agents_dirty";
    throw error;
  }
}
function removeWorkerWorktree(teamName, workerName, repoRoot) {
  const wtPath = getWorktreePath(repoRoot, teamName, workerName);
  const branch = getBranchName(teamName, workerName);
  const metaLockPath = `${getMetadataPath(repoRoot, teamName)}.lock`;
  withFileLockSync(metaLockPath, () => {
    prepareWorkerWorktreeForRemoval(teamName, workerName, repoRoot, wtPath);
    const wasRegisteredWorktree = isRegisteredWorktreePath(repoRoot, wtPath);
    try {
      execFileSync5("git", ["worktree", "remove", wtPath], { cwd: repoRoot, stdio: "pipe", windowsHide: true });
    } catch (err) {
      if (wasRegisteredWorktree) {
        const detail = err instanceof Error && err.message ? `: ${err.message}` : "";
        const error = new Error(`worktree_remove_failed: preserving metadata for registered worker worktree at ${wtPath}${detail}`);
        error.code = "worktree_remove_failed";
        throw error;
      }
    }
    try {
      execFileSync5("git", ["worktree", "prune"], { cwd: repoRoot, stdio: "pipe", windowsHide: true });
    } catch {
    }
    try {
      execFileSync5("git", ["branch", "-D", branch], { cwd: repoRoot, stdio: "pipe", windowsHide: true });
    } catch {
    }
    if (existsSync15(wtPath) && !isRegisteredWorktreePath(repoRoot, wtPath)) {
      validateWorktreeRemovalTarget({
        candidatePath: wtPath,
        expectedRoots: [join19(getOmcRoot(repoRoot), "team", sanitizeName(teamName), "worktrees")],
        mainRepoRoots: [repoRoot]
      });
      rmSync2(wtPath, { recursive: true, force: true });
    }
    forgetMetadataUnlocked(repoRoot, teamName, workerName);
  });
}
function listTeamWorktrees(teamName, repoRoot) {
  return readMetadata(repoRoot, teamName);
}
function inspectTeamWorktreeCleanupSafety(teamName, repoRoot) {
  const metadata = readMetadataResult(repoRoot, teamName);
  const entries = metadata.entries;
  const backupIssues = listRootAgentsBackupIssues(repoRoot, teamName, entries);
  return {
    hasEvidence: entries.length > 0 || metadata.issues.length > 0 || backupIssues.length > 0,
    entries,
    blockers: [
      ...metadata.issues.map((issue, index) => ({
        workerName: `metadata-${index + 1}`,
        path: issue.path,
        reason: `worktree_metadata_unreadable:${issue.message}`
      })),
      ...backupIssues.map((issue, index) => ({
        workerName: `agents-backup-${index + 1}`,
        path: issue.path,
        reason: issue.message
      }))
    ]
  };
}
function cleanupTeamWorktrees(teamName, repoRoot) {
  const safety = inspectTeamWorktreeCleanupSafety(teamName, repoRoot);
  const entries = safety.entries;
  const removed = [];
  const preserved = [...safety.blockers];
  if (preserved.length > 0) {
    return { removed, preserved };
  }
  for (const entry of entries) {
    try {
      removeWorkerWorktree(teamName, entry.workerName, repoRoot);
      removed.push(entry.workerName);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      preserved.push({ workerName: entry.workerName, path: entry.path, reason });
      process.stderr.write(`[omc] warning: preserved worktree ${entry.path}: ${reason}
`);
    }
  }
  return { removed, preserved };
}
var init_git_worktree = __esm({
  "src/team/git-worktree.ts"() {
    "use strict";
    init_fs_utils();
    init_worktree_cleanup_safety();
    init_tmux_session();
    init_file_lock();
    init_worktree_paths();
  }
});

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
var init_allocation_policy = __esm({
  "src/team/allocation-policy.ts"() {
    "use strict";
  }
});

// src/team/events.ts
import { randomUUID as randomUUID7 } from "crypto";
import { dirname as dirname16 } from "path";
import { mkdir as mkdir7, readFile as readFile9, appendFile as appendFile3 } from "fs/promises";
import { existsSync as existsSync18 } from "fs";
async function appendTeamEvent(teamName, event, cwd) {
  const full = {
    event_id: randomUUID7(),
    team: teamName,
    created_at: (/* @__PURE__ */ new Date()).toISOString(),
    ...event
  };
  const p = absPath(cwd, TeamPaths.events(teamName));
  await mkdir7(dirname16(p), { recursive: true });
  await appendFile3(p, `${JSON.stringify(full)}
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
    const currentLiveness = worker.liveness ?? (worker.alive ? "alive" : "dead");
    if (prevAlive === true && currentLiveness === "dead") {
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
var init_events = __esm({
  "src/team/events.ts"() {
    "use strict";
    init_state_paths();
    init_swallowed_error();
  }
});

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
var init_phase_controller = __esm({
  "src/team/phase-controller.ts"() {
    "use strict";
  }
});

// src/team/stage-router.ts
function isTier(value) {
  return TIER_SET.has(value);
}
function getRoleRoutingSpec(roleRouting, role) {
  if (!roleRouting) return void 0;
  const normalizedRole = normalizeDelegationRole(role);
  const direct = roleRouting[normalizedRole];
  if (direct) return direct;
  for (const [rawRole, spec] of Object.entries(roleRouting)) {
    if (spec && normalizeDelegationRole(rawRole) === normalizedRole) {
      return spec;
    }
  }
  return void 0;
}
function resolveTierToModelId(tier, cfg) {
  const fromCfg = cfg.routing?.tierModels?.[tier];
  if (typeof fromCfg === "string" && fromCfg.length > 0) return fromCfg;
  return getDefaultTierModels()[tier];
}
function resolveClaudeModel(role, raw, cfg) {
  if (typeof raw === "string" && raw.length > 0) {
    return isTier(raw) ? resolveTierToModelId(raw, cfg) : raw;
  }
  return resolveTierToModelId(ROLE_DEFAULT_TIER[role], cfg);
}
function resolveExternalModel(provider, raw, cfg) {
  if (typeof raw === "string" && raw.length > 0 && !isTier(raw)) {
    return raw;
  }
  const defaults = cfg.externalModels?.defaults;
  if (provider === "codex") {
    return defaults?.codexModel ?? BUILTIN_EXTERNAL_MODEL_DEFAULTS.codexModel;
  }
  if (provider === "grok") {
    return defaults?.grokModel ?? "";
  }
  if (provider === "cursor") {
    return "";
  }
  if (provider === "antigravity") {
    return defaults?.antigravityModel ?? BUILTIN_EXTERNAL_MODEL_DEFAULTS.antigravityModel;
  }
  return defaults?.geminiModel ?? BUILTIN_EXTERNAL_MODEL_DEFAULTS.geminiModel;
}
function resolveRoleAssignment(role, cfg) {
  const normalized = normalizeDelegationRole(role);
  const canonical = isCanonicalRole(normalized) ? normalized : role;
  const roleRouting = cfg.team?.roleRouting;
  const spec = getRoleRoutingSpec(roleRouting, canonical);
  const isOrchestrator = canonical === "orchestrator";
  const provider = isOrchestrator ? "claude" : spec?.provider ?? "claude";
  if (provider === "cursor" && !CURSOR_EXECUTOR_TEAM_ROLE_SET2.has(canonical)) {
    throw new Error(
      `team.roleRouting.${canonical}.provider: cursor is only supported for executor-style roles (${[...CURSOR_EXECUTOR_TEAM_ROLE_SET2].join(", ")})`
    );
  }
  const model = provider === "claude" ? resolveClaudeModel(canonical, spec?.model, cfg) : resolveExternalModel(provider, spec?.model, cfg);
  const agent = spec?.agent ?? ROLE_TO_AGENT[canonical];
  return { provider, model, agent };
}
function isCanonicalRole(value) {
  return CANONICAL_TEAM_ROLES.includes(value);
}
function buildResolvedRoutingSnapshot(cfg) {
  const out = {};
  const roleRouting = cfg.team?.roleRouting;
  for (const role of CANONICAL_TEAM_ROLES) {
    const primary = resolveRoleAssignment(role, cfg);
    const spec = getRoleRoutingSpec(roleRouting, role);
    const isExternalPrimary = primary.provider !== "claude";
    const fallbackModelInput = isExternalPrimary && spec?.model && !isTier(spec.model) ? void 0 : spec?.model;
    const fallback = {
      provider: "claude",
      model: resolveClaudeModel(role, fallbackModelInput, cfg),
      agent: primary.agent
    };
    out[role] = { primary, fallback };
  }
  return out;
}
var ROLE_TO_AGENT, ROLE_DEFAULT_TIER, TIER_SET, CURSOR_EXECUTOR_TEAM_ROLE_SET2;
var init_stage_router = __esm({
  "src/team/stage-router.ts"() {
    "use strict";
    init_types();
    init_types2();
    init_models();
    ROLE_TO_AGENT = {
      orchestrator: "omc",
      planner: "planner",
      analyst: "analyst",
      architect: "architect",
      executor: "executor",
      debugger: "debugger",
      critic: "critic",
      "code-reviewer": "codeReviewer",
      "security-reviewer": "securityReviewer",
      "test-engineer": "testEngineer",
      designer: "designer",
      writer: "writer",
      "code-simplifier": "codeSimplifier",
      explore: "explore",
      "document-specialist": "documentSpecialist"
    };
    ROLE_DEFAULT_TIER = {
      orchestrator: "HIGH",
      planner: "HIGH",
      analyst: "HIGH",
      architect: "HIGH",
      executor: "MEDIUM",
      debugger: "MEDIUM",
      critic: "HIGH",
      "code-reviewer": "HIGH",
      "security-reviewer": "MEDIUM",
      "test-engineer": "MEDIUM",
      designer: "MEDIUM",
      writer: "LOW",
      "code-simplifier": "HIGH",
      explore: "LOW",
      "document-specialist": "MEDIUM"
    };
    TIER_SET = /* @__PURE__ */ new Set(["HIGH", "MEDIUM", "LOW"]);
    CURSOR_EXECUTOR_TEAM_ROLE_SET2 = new Set(CURSOR_EXECUTOR_TEAM_ROLES);
  }
});

// src/team/role-router.ts
function inferLaneIntent(text) {
  if (!text || text.trim().length === 0) return "unknown";
  for (const { intent, patterns } of INTENT_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        return intent;
      }
    }
  }
  return "unknown";
}
function routeTaskToRole(taskSubject, taskDescription, fallbackRole) {
  const combined = `${taskSubject} ${taskDescription}`.trim();
  const intent = inferLaneIntent(combined);
  const isSecurityDomain = SECURITY_DOMAIN_RE.test(combined);
  switch (intent) {
    case "build-fix":
      return { role: "build-fixer", confidence: "high", reason: "build-fix intent detected" };
    case "debug":
      return { role: "debugger", confidence: "high", reason: "debug intent detected" };
    case "docs":
      return { role: "writer", confidence: "high", reason: "docs intent detected" };
    case "design":
      return { role: "designer", confidence: "high", reason: "design intent detected" };
    case "cleanup":
      return { role: "code-simplifier", confidence: "high", reason: "cleanup intent detected" };
    case "review":
      if (isSecurityDomain) {
        return { role: "security-reviewer", confidence: "high", reason: "review intent with security domain detected" };
      }
      return { role: "quality-reviewer", confidence: "high", reason: "review intent detected" };
    case "verification":
      return { role: "test-engineer", confidence: "high", reason: "verification intent detected" };
    case "implementation":
      return {
        role: fallbackRole,
        confidence: "medium",
        reason: isSecurityDomain ? "implementation intent with security domain \u2014 stays on fallback role" : "implementation intent \u2014 using fallback role"
      };
    case "unknown":
    default: {
      const best = scoreByKeywords(combined);
      if (best) {
        return {
          role: best.role,
          confidence: "medium",
          reason: `keyword match (${best.count} hits) for role '${best.role}'`
        };
      }
      return {
        role: fallbackRole,
        confidence: "low",
        reason: "no clear intent signal \u2014 using fallback role"
      };
    }
  }
}
function scoreByKeywords(text) {
  let bestRole = null;
  let bestCount = 0;
  for (const [role, patterns] of Object.entries(ROLE_KEYWORDS)) {
    const count = patterns.filter((p) => p.test(text)).length;
    if (count > bestCount) {
      bestCount = count;
      bestRole = role;
    }
  }
  return bestRole && bestCount > 0 ? { role: bestRole, count: bestCount } : null;
}
var INTENT_PATTERNS, SECURITY_DOMAIN_RE, ROLE_KEYWORDS;
var init_role_router = __esm({
  "src/team/role-router.ts"() {
    "use strict";
    INTENT_PATTERNS = [
      {
        intent: "build-fix",
        patterns: [
          /\bfix(?:ing)?\s+(?:the\s+)?(?:build|ci|lint|compile|tsc|type.?check)/i,
          /\bfailing\s+build\b/i,
          /\bbuild\s+(?:error|fail|broken|fix)/i,
          /\btsc\s+error/i,
          /\bcompile\s+error/i,
          /\bci\s+(?:fail|broken|fix)/i
        ]
      },
      {
        intent: "debug",
        patterns: [
          /\bdebug(?:ging)?\b/i,
          /\btroubleshoot(?:ing)?\b/i,
          /\binvestigate\b/i,
          /\broot.?cause\b/i,
          /\bwhy\s+(?:is|does|did|are)\b/i,
          /\bdiagnos(?:e|ing)\b/i,
          /\btrace\s+(?:the|an?)\s+(?:bug|issue|error|problem)/i
        ]
      },
      {
        intent: "docs",
        patterns: [
          /\bdocument(?:ation|ing|ation)?\b/i,
          /\bwrite\s+(?:docs|readme|changelog|comments|jsdoc|tsdoc)/i,
          /\bupdate\s+(?:docs|readme|changelog)/i,
          /\badd\s+(?:docs|comments|jsdoc|tsdoc)\b/i,
          /\breadme\b/i,
          /\bchangelog\b/i
        ]
      },
      {
        intent: "design",
        patterns: [
          /\bdesign\b/i,
          /\barchitect(?:ure|ing)?\b/i,
          /\bui\s+(?:design|layout|component)/i,
          /\bux\b/i,
          /\bwireframe\b/i,
          /\bmockup\b/i,
          /\bprototype\b/i,
          /\bsystem\s+design\b/i,
          /\bapi\s+design\b/i
        ]
      },
      {
        intent: "cleanup",
        patterns: [
          /\bclean\s*up\b/i,
          /\brefactor(?:ing)?\b/i,
          /\bsimplif(?:y|ying)\b/i,
          /\bdead\s+code\b/i,
          /\bunused\s+(?:code|import|variable|function)\b/i,
          /\bremove\s+(?:dead|unused|legacy)\b/i,
          /\bdebt\b/i
        ]
      },
      {
        intent: "review",
        patterns: [
          /\breview\b/i,
          /\baudit\b/i,
          /\bpr\s+review\b/i,
          /\bcode\s+review\b/i,
          /\bcheck\s+(?:the\s+)?(?:code|pr|pull.?request)\b/i
        ]
      },
      {
        intent: "verification",
        patterns: [
          /\btest(?:ing|s)?\b/i,
          /\bverif(?:y|ication)\b/i,
          /\bvalidat(?:e|ion)\b/i,
          /\bunit\s+test\b/i,
          /\bintegration\s+test\b/i,
          /\be2e\b/i,
          /\bspec\b/i,
          /\bcoverage\b/i,
          /\bassert(?:ion)?\b/i
        ]
      },
      {
        intent: "implementation",
        patterns: [
          /\bimplement(?:ing|ation)?\b/i,
          /\badd\s+(?:the\s+)?(?:feature|function|method|class|endpoint|route)\b/i,
          /\bbuild\s+(?:the\s+)?(?:feature|component|module|service|api)\b/i,
          /\bcreate\s+(?:the\s+)?(?:feature|component|module|service|api|function)\b/i,
          /\bwrite\s+(?:the\s+)?(?:code|function|class|method|module)\b/i
        ]
      }
    ];
    SECURITY_DOMAIN_RE = /\b(?:auth(?:entication|orization)?|cve|injection|owasp|security|vulnerability|vuln|xss|csrf|sqli|rce|privilege.?escalat)\b/i;
    ROLE_KEYWORDS = {
      "build-fixer": [/\bbuild\b/i, /\bci\b/i, /\bcompile\b/i, /\btsc\b/i, /\blint\b/i],
      debugger: [/\bdebug\b/i, /\btroubleshoot\b/i, /\binvestigate\b/i, /\bdiagnos/i],
      writer: [/\bdoc(?:ument)?/i, /\breadme\b/i, /\bchangelog\b/i, /\bcomment/i],
      designer: [/\bdesign\b/i, /\barchitect/i, /\bui\b/i, /\bux\b/i, /\bwireframe\b/i],
      "code-simplifier": [/\brefactor/i, /\bclean/i, /\bsimplif/i, /\bdebt\b/i, /\bunused\b/i],
      "security-reviewer": [/\bsecurity\b/i, /\bvulnerabilit/i, /\bcve\b/i, /\bowasp\b/i, /\bxss\b/i],
      "quality-reviewer": [/\breview\b/i, /\baudit\b/i, /\bcheck\b/i],
      "test-engineer": [/\btest/i, /\bverif/i, /\bvalidat/i, /\bspec\b/i, /\bcoverage\b/i],
      executor: [/\bimplement/i, /\bbuild\b/i, /\bcreate\b/i, /\badd\b/i, /\bwrite\b/i]
    };
  }
});

// src/team/cli-worker-contract.ts
function shouldInjectContract(role, provider) {
  if (!role || !provider) return false;
  if (provider === "claude" || provider === "cursor") return false;
  return CONTRACT_ROLES.has(role);
}
function renderCliWorkerOutputContract(role, output_file) {
  return [
    "",
    "---",
    "## REQUIRED: Structured Verdict Output",
    "",
    `You are acting in the \`${role}\` role. Before you exit, write a JSON verdict to:`,
    "",
    `    ${output_file}`,
    "",
    "Schema (all keys required; `findings` may be an empty array):",
    "",
    "```json",
    "{",
    `  "role": "${role}",`,
    '  "task_id": "<task id from the assignment above>",',
    '  "verdict": "approve" | "revise" | "reject",',
    '  "summary": "one- or two-sentence overall assessment",',
    '  "findings": [',
    "    {",
    '      "severity": "critical" | "major" | "minor" | "nit",',
    '      "message": "what is wrong and why it matters",',
    '      "file": "optional/path/to/file",',
    '      "line": 42',
    "    }",
    "  ]",
    "}",
    "```",
    "",
    "Rules:",
    "- Write valid JSON only (no surrounding prose, no markdown fences in the file).",
    "- `verdict` MUST be one of `approve`, `revise`, or `reject`.",
    "- Each finding MUST carry a `severity` from the enum above.",
    "- Use `approve` only when you have no blocking concerns.",
    '- If you cannot produce a verdict, write `{"verdict":"revise", ...}` with an explanatory finding rather than exiting silently.',
    "- The team leader reads this file to mark the task complete; omitting it leaves the task stuck in_progress pending human review.",
    ""
  ].join("\n");
}
function parseCliWorkerVerdict(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`verdict_json_parse_failed: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("verdict_not_object");
  }
  const obj = parsed;
  const role = obj.role;
  if (typeof role !== "string" || !role) {
    throw new Error("verdict_missing_role");
  }
  const taskId = obj.task_id;
  if (typeof taskId !== "string" || !taskId) {
    throw new Error("verdict_missing_task_id");
  }
  const verdict = obj.verdict;
  if (typeof verdict !== "string" || !VALID_VERDICTS.has(verdict)) {
    throw new Error(`verdict_invalid_verdict:${String(verdict)}`);
  }
  const summary = obj.summary;
  if (typeof summary !== "string") {
    throw new Error("verdict_missing_summary");
  }
  const findingsRaw = obj.findings;
  if (!Array.isArray(findingsRaw)) {
    throw new Error("verdict_findings_not_array");
  }
  const findings = findingsRaw.map((entry, idx) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`verdict_finding_${idx}_not_object`);
    }
    const f = entry;
    const severity = f.severity;
    if (typeof severity !== "string" || !VALID_SEVERITIES.has(severity)) {
      throw new Error(`verdict_finding_${idx}_invalid_severity:${String(severity)}`);
    }
    const message = f.message;
    if (typeof message !== "string" || !message) {
      throw new Error(`verdict_finding_${idx}_missing_message`);
    }
    const finding = {
      severity,
      message
    };
    if (typeof f.file === "string" && f.file) finding.file = f.file;
    if (typeof f.line === "number" && Number.isFinite(f.line)) finding.line = f.line;
    return finding;
  });
  return {
    role,
    task_id: taskId,
    verdict,
    summary,
    findings
  };
}
function cliWorkerOutputFilePath(teamStateRootAbs, workerName) {
  return `${teamStateRootAbs.replaceAll("\\", "/")}/workers/${workerName}/verdict.json`;
}
var CONTRACT_ROLES, VALID_VERDICTS, VALID_SEVERITIES;
var init_cli_worker_contract = __esm({
  "src/team/cli-worker-contract.ts"() {
    "use strict";
    CONTRACT_ROLES = /* @__PURE__ */ new Set([
      "critic",
      "code-reviewer",
      "security-reviewer",
      "test-engineer"
    ]);
    VALID_VERDICTS = /* @__PURE__ */ new Set(["approve", "revise", "reject"]);
    VALID_SEVERITIES = /* @__PURE__ */ new Set(["critical", "major", "minor", "nit"]);
  }
});

// src/team/runtime-flags.ts
function isRuntimeV2Enabled(env = process.env) {
  const raw = env.OMC_RUNTIME_V2;
  if (!raw) return true;
  const normalized = raw.trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(normalized);
}
var init_runtime_flags = __esm({
  "src/team/runtime-flags.ts"() {
    "use strict";
  }
});

// src/team/merge-coordinator.ts
import { execFileSync as execFileSync6 } from "node:child_process";
import { appendFileSync, mkdirSync as mkdirSync6, readFileSync as readFileSync12 } from "node:fs";
import { isAbsolute as isAbsolute8, join as join22 } from "node:path";
function validateBranchName(branch) {
  if (!BRANCH_NAME_RE.test(branch)) {
    throw new Error(`Invalid branch name: "${branch}" \u2014 must match ${BRANCH_NAME_RE}`);
  }
}
function configureHarnessMergeAttributes(repoRoot) {
  execFileSync6("git", ["config", "merge.ours.driver", "true"], {
    cwd: repoRoot,
    stdio: "pipe",
    windowsHide: true
  });
  const commonDir = execFileSync6("git", ["rev-parse", "--git-common-dir"], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    windowsHide: true
  }).trim();
  const resolvedCommonDir = isAbsolute8(commonDir) ? commonDir : join22(repoRoot, commonDir);
  const infoDir = join22(resolvedCommonDir, "info");
  mkdirSync6(infoDir, { recursive: true });
  const attrPath = join22(infoDir, "attributes");
  let existing = "";
  try {
    existing = readFileSync12(attrPath, "utf-8");
  } catch {
  }
  const existingLines = new Set(existing.split("\n").map((l) => l.trim()));
  const missing = HARNESS_MERGE_PATHS.map((p) => `${p} merge=ours`).filter(
    (line) => !existingLines.has(line)
  );
  if (missing.length === 0) return;
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(attrPath, `${prefix}${missing.join("\n")}
`, "utf-8");
}
function checkMergeConflicts(workerBranch, baseBranch, repoRoot) {
  validateBranchName(workerBranch);
  validateBranchName(baseBranch);
  try {
    execFileSync6(
      "git",
      ["merge-tree", "--write-tree", baseBranch, workerBranch],
      { cwd: repoRoot, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
    );
    return [];
  } catch (err) {
    const error = err;
    if (error.status === 1 && typeof error.stdout === "string") {
      const lines = error.stdout.split("\n");
      const conflicts = [];
      for (const line of lines) {
        const match = line.match(/^CONFLICT\s.*?:\s+.*?\s+in\s+(.+)$/);
        if (match) {
          conflicts.push(match[1].trim());
        }
      }
      return conflicts.length > 0 ? conflicts : ["(merge-tree reported conflicts)"];
    }
  }
  const mergeBase = execFileSync6(
    "git",
    ["merge-base", baseBranch, workerBranch],
    { cwd: repoRoot, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
  ).trim();
  const baseDiff = execFileSync6(
    "git",
    ["diff", "--name-only", mergeBase, baseBranch],
    { cwd: repoRoot, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
  ).trim();
  const workerDiff = execFileSync6(
    "git",
    ["diff", "--name-only", mergeBase, workerBranch],
    { cwd: repoRoot, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
  ).trim();
  if (!baseDiff || !workerDiff) {
    return [];
  }
  const baseFiles = new Set(baseDiff.split("\n").filter((f) => f));
  const workerFiles = workerDiff.split("\n").filter((f) => f);
  return workerFiles.filter((f) => baseFiles.has(f));
}
function mergeWorkerBranch(workerBranch, baseBranch, repoRoot) {
  validateBranchName(workerBranch);
  validateBranchName(baseBranch);
  const workerName = workerBranch.split("/").pop() || workerBranch;
  try {
    try {
      execFileSync6("git", ["diff-index", "--quiet", "HEAD", "--"], {
        cwd: repoRoot,
        stdio: "pipe",
        windowsHide: true
      });
    } catch {
      throw new Error("Working tree has uncommitted changes \u2014 commit or stash before merging");
    }
    execFileSync6("git", ["checkout", baseBranch], {
      cwd: repoRoot,
      stdio: "pipe",
      windowsHide: true
    });
    execFileSync6("git", ["merge", "--no-ff", "-m", `Merge ${workerBranch} into ${baseBranch}`, workerBranch], {
      cwd: repoRoot,
      stdio: "pipe",
      windowsHide: true
    });
    const mergeCommit = execFileSync6("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
      windowsHide: true
    }).trim();
    return {
      workerName,
      branch: workerBranch,
      success: true,
      conflicts: [],
      mergeCommit
    };
  } catch (_err) {
    try {
      execFileSync6("git", ["merge", "--abort"], { cwd: repoRoot, stdio: "pipe", windowsHide: true });
    } catch {
    }
    const conflicts = checkMergeConflicts(workerBranch, baseBranch, repoRoot);
    return {
      workerName,
      branch: workerBranch,
      success: false,
      conflicts
    };
  }
}
var BRANCH_NAME_RE, HARNESS_MERGE_PATHS;
var init_merge_coordinator = __esm({
  "src/team/merge-coordinator.ts"() {
    "use strict";
    init_git_worktree();
    BRANCH_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/;
    HARNESS_MERGE_PATHS = ["AGENTS.md", ".claude/**"];
  }
});

// src/team/leader-inbox.ts
import { appendFile as appendFile4, mkdir as mkdir8, writeFile as writeFile5 } from "fs/promises";
import { existsSync as existsSync19 } from "fs";
import { dirname as dirname17, join as join23 } from "path";
function leaderInboxPath(teamName, cwd) {
  const safe = sanitizeName(teamName);
  return join23(cwd, `.omc/state/team/${safe}/leader/inbox.md`);
}
async function ensureLeaderInbox(teamName, cwd) {
  const inboxPath = leaderInboxPath(teamName, cwd);
  validateResolvedPath(inboxPath, cwd);
  await mkdir8(dirname17(inboxPath), { recursive: true });
  if (!existsSync19(inboxPath)) {
    await writeFile5(inboxPath, LEADER_INBOX_HEADER, "utf-8");
  }
  return inboxPath;
}
async function appendToLeaderInbox(teamName, message, cwd) {
  const inboxPath = leaderInboxPath(teamName, cwd);
  validateResolvedPath(inboxPath, cwd);
  await mkdir8(dirname17(inboxPath), { recursive: true });
  await appendFile4(inboxPath, `

---
${message}`, "utf-8");
}
function extendLeaderBootstrapPrompt(teamName) {
  const safe = sanitizeName(teamName);
  const path4 = `.omc/state/team/${safe}/leader/inbox.md`;
  return `Runtime notifications appear at ${path4} \u2014 check this file periodically and after long-running operations.`;
}
var LEADER_INBOX_HEADER;
var init_leader_inbox = __esm({
  "src/team/leader-inbox.ts"() {
    "use strict";
    init_tmux_session();
    init_fs_utils();
    LEADER_INBOX_HEADER = `# Leader Inbox

Runtime notifications (merge conflicts, rebase events, etc.) appear here.
Check this file periodically and after long-running operations.

---
`;
  }
});

// src/team/conflict-mailbox.ts
function sanitizeConflictPath(path4) {
  return path4.replace(/[`\r\n]/g, "?");
}
function formatMergeConflictForLeader(args) {
  const { workerName, workerBranch, leaderBranch, conflictingFiles, mergeBaseSha, observedAt } = args;
  const ts = new Date(observedAt).toISOString();
  const safeFiles = conflictingFiles.map(sanitizeConflictPath);
  const fileList = safeFiles.map((f) => `- \`${f}\``).join("\n");
  return `### Merge conflict: ${workerName} \u2192 ${leaderBranch}

**Worker branch:** \`${workerBranch}\`
**Leader branch:** \`${leaderBranch}\`
**Merge base:** \`${mergeBaseSha}\`
**Observed at:** ${ts}

**Conflicting files:**
${fileList}

**Leader: choose strategy.** To resolve, run:

\`\`\`sh
git checkout ${leaderBranch} && git merge --no-ff ${workerBranch}
# resolve conflicts in the files listed above
git add ${safeFiles.join(" ")}
git commit
\`\`\`

Or abort with \`git merge --abort\` to defer resolution.`;
}
function formatRebaseConflictForWorker(args) {
  const { workerName, workerBranch, leaderBranch, conflictingFiles, baseSha, worktreePath, observedAt } = args;
  const ts = new Date(observedAt).toISOString();
  const safeFiles = conflictingFiles.map(sanitizeConflictPath);
  const fileList = safeFiles.map((f) => `- \`${f}\``).join("\n");
  return `### Rebase conflict: ${workerName} onto ${leaderBranch}

**Worker branch:** \`${workerBranch}\`
**Base branch:** \`${leaderBranch}\`
**Base SHA:** \`${baseSha}\`
**Worktree:** \`${worktreePath}\`
**Observed at:** ${ts}

**Conflicting files:**
${fileList}

Resolve conflicts in your own pane, then \`git add <files>\` and \`git rebase --continue\`.
Cadence stays paused until \`.git/rebase-merge\` is gone.

Or run \`git rebase --abort\` to bail and return to the pre-rebase state.`;
}
var init_conflict_mailbox = __esm({
  "src/team/conflict-mailbox.ts"() {
    "use strict";
    init_worker_bootstrap();
    init_leader_inbox();
  }
});

// src/team/worker-commit-cadence.ts
import { existsSync as existsSync20, watch as fsWatch } from "fs";
import { readFile as readFile10, writeFile as writeFile6, mkdir as mkdir9, unlink as unlink3 } from "fs/promises";
import { join as join24, dirname as dirname18 } from "path";
import { exec as exec2 } from "child_process";
function ownsCadence(ctx) {
  const current = cadenceOwners.get(ctx.worktreePath);
  return !current || ctx.serviceGeneration === void 0 || current.serviceGeneration === ctx.serviceGeneration && current.attemptId === ctx.attemptId;
}
function registerCadenceOwner(ctx) {
  if (ctx.serviceGeneration === void 0 || ctx.attemptId === void 0) return true;
  const current = cadenceOwners.get(ctx.worktreePath);
  if (current && current.serviceGeneration > ctx.serviceGeneration) return false;
  cadenceOwners.set(ctx.worktreePath, { serviceGeneration: ctx.serviceGeneration, attemptId: ctx.attemptId });
  return true;
}
function assertSafeWorkerName(workerName) {
  if (!WORKER_NAME_RE.test(workerName)) {
    throw new Error(
      `Invalid worker name for shell hook: "${workerName}" \u2014 must match ${WORKER_NAME_RE}`
    );
  }
}
function buildHookCommand(workerName) {
  assertSafeWorkerName(workerName);
  return `sh -c 'rebase_dir=$(git rev-parse --git-path rebase-merge 2>/dev/null || printf %s .git/rebase-merge); merge_head=$(git rev-parse --git-path MERGE_HEAD 2>/dev/null || printf %s .git/MERGE_HEAD); if [ -d "$rebase_dir" ] || [ -f "$merge_head" ] || [ -e ${SENTINEL_FILENAME} ]; then exit 0; fi; git add -A && (git diff --cached --quiet || git commit -m "auto-commit by worker ${workerName} at $(date -Iseconds)")'`;
}
async function mergeSettingsWithHook(settingsPath, hookCommand) {
  let existing = { hooks: { PostToolUse: [] } };
  try {
    const raw = await readFile10(settingsPath, "utf-8");
    const parsed = JSON.parse(raw);
    existing = {
      ...parsed,
      hooks: {
        PostToolUse: [],
        ...parsed.hooks ?? {}
      }
    };
  } catch {
  }
  const filteredHooks = (existing.hooks.PostToolUse ?? []).filter(
    (h) => h.matcher !== HOOK_MATCHER
  );
  const newEntry = {
    matcher: HOOK_MATCHER,
    hooks: [{ type: "command", command: hookCommand }]
  };
  return {
    ...existing,
    hooks: {
      ...existing.hooks,
      PostToolUse: [...filteredHooks, newEntry]
    }
  };
}
async function installPostToolUseHook(worktreePath, workerName) {
  assertSafeWorkerName(workerName);
  if (isHookPaused(worktreePath)) {
    return;
  }
  const claudeDir = join24(worktreePath, ".claude");
  await mkdir9(claudeDir, { recursive: true });
  const settingsPath = join24(claudeDir, "settings.json");
  const hookCommand = buildHookCommand(workerName);
  const merged = await mergeSettingsWithHook(settingsPath, hookCommand);
  await writeFile6(settingsPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
}
async function pauseHookViaSentinel(worktreePath) {
  const sentinelPath = join24(worktreePath, SENTINEL_FILENAME);
  await mkdir9(dirname18(sentinelPath), { recursive: true });
  await writeFile6(sentinelPath, "", "utf-8");
}
async function resumeHookViaSentinel(worktreePath) {
  const sentinelPath = join24(worktreePath, SENTINEL_FILENAME);
  try {
    await unlink3(sentinelPath);
  } catch {
  }
}
function isHookPaused(worktreePath) {
  return existsSync20(join24(worktreePath, SENTINEL_FILENAME));
}
function startFallbackPoller(worktreePath, workerName, opts) {
  assertSafeWorkerName(workerName);
  const debounceMs = opts?.intervalMs ?? DEFAULT_POLL_DEBOUNCE_MS;
  let debounceTimer = null;
  let stopped = false;
  const runAutoCommit = () => {
    if (stopped) return;
    if (isHookPaused(worktreePath)) return;
    const cmd = buildHookCommand(workerName);
    exec2(cmd, { cwd: worktreePath }, (_err) => {
    });
  };
  const scheduleDebounce = () => {
    if (stopped) return;
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      runAutoCommit();
    }, debounceMs);
  };
  const watcher = fsWatch(worktreePath, { recursive: true }, (eventType, filename) => {
    if (stopped) return;
    if (filename && (filename.startsWith(".git") || filename.startsWith(".git/"))) return;
    scheduleDebounce();
  });
  return {
    stop() {
      stopped = true;
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      watcher.close();
    }
  };
}
async function installCommitCadence(ctx) {
  if (!registerCadenceOwner(ctx)) return { method: "none" };
  if (!ctx.enabled) {
    return { method: "none" };
  }
  if (ctx.agentType === "claude") {
    await installPostToolUseHook(ctx.worktreePath, ctx.workerName);
    return { method: "hook" };
  }
  return { method: "fallback-poll" };
}
async function uninstallCommitCadence(ctx, io = { readFile: readFile10, writeFile: writeFile6 }) {
  if (!ownsCadence(ctx)) return;
  const owner = cadenceOwners.get(ctx.worktreePath);
  const ownsRegisteredGeneration = owner && ctx.serviceGeneration !== void 0 && owner.serviceGeneration === ctx.serviceGeneration && owner.attemptId === ctx.attemptId;
  if (ctx.agentType !== "claude") {
    if (ownsRegisteredGeneration) cadenceOwners.delete(ctx.worktreePath);
    return;
  }
  const settingsPath = join24(ctx.worktreePath, ".claude", "settings.json");
  let raw;
  try {
    raw = await io.readFile(settingsPath, "utf-8");
  } catch (error) {
    if (typeof error === "object" && error !== null && error.code === "ENOENT") {
      if (ownsRegisteredGeneration) cadenceOwners.delete(ctx.worktreePath);
      return;
    }
    throw error;
  }
  const parsed = JSON.parse(raw);
  const filtered = (parsed.hooks?.PostToolUse ?? []).filter(
    (h) => h.matcher !== HOOK_MATCHER
  );
  const updated = {
    ...parsed,
    hooks: {
      ...parsed.hooks,
      PostToolUse: filtered
    }
  };
  await io.writeFile(settingsPath, JSON.stringify(updated, null, 2) + "\n", "utf-8");
  if (ownsRegisteredGeneration) cadenceOwners.delete(ctx.worktreePath);
}
var cadenceOwners, SENTINEL_FILENAME, HOOK_MATCHER, DEFAULT_POLL_DEBOUNCE_MS, WORKER_NAME_RE;
var init_worker_commit_cadence = __esm({
  "src/team/worker-commit-cadence.ts"() {
    "use strict";
    cadenceOwners = /* @__PURE__ */ new Map();
    SENTINEL_FILENAME = ".hook-paused";
    HOOK_MATCHER = "Write|Edit|MultiEdit";
    DEFAULT_POLL_DEBOUNCE_MS = 3e3;
    WORKER_NAME_RE = /^[A-Za-z0-9_-]{1,50}$/;
  }
});

// src/team/merge-orchestrator.ts
import { execFileSync as execFileSync7 } from "node:child_process";
import { existsSync as existsSync21 } from "node:fs";
import { mkdir as mkdir10, appendFile as appendFile5 } from "node:fs/promises";
import { dirname as dirname19, join as join25 } from "node:path";
function mergerWorktreePathFor(repoRoot, teamName) {
  return join25(getOmcRoot(repoRoot), "team", sanitizeName(teamName), "merger");
}
function persistedStatePath(repoRoot, teamName) {
  return join25(
    getOmcRoot(repoRoot),
    "state",
    "team",
    sanitizeName(teamName),
    "auto-merge-state.json"
  );
}
function teardownAuditPath(repoRoot, teamName) {
  return join25(
    getOmcRoot(repoRoot),
    "state",
    "team",
    sanitizeName(teamName),
    "teardown-audit.jsonl"
  );
}
function orchestratorEventLogPath(repoRoot, teamName) {
  return join25(
    getOmcRoot(repoRoot),
    "state",
    "team",
    sanitizeName(teamName),
    "orchestrator-events.jsonl"
  );
}
function assertLeaderBranchAllowed(leaderBranch) {
  const stripped = leaderBranch.replace(/^refs\/heads\//i, "").toLowerCase();
  if (stripped === "main" || stripped === "master") {
    throw new Error("auto-merge refuses main/master leader branch \u2014 use a feature branch");
  }
}
function assertRuntimeV2Gate() {
  if (!isRuntimeV2Enabled()) {
    throw new Error("auto-merge requires runtime v2 (OMC_RUNTIME_V2 is explicitly disabled).");
  }
}
async function appendEvent(repoRoot, teamName, event) {
  const path4 = orchestratorEventLogPath(repoRoot, teamName);
  await mkdir10(dirname19(path4), { recursive: true });
  const full = {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    team: teamName,
    ...event
  };
  await appendFile5(path4, `${JSON.stringify(full)}
`, "utf-8");
}
function createMutex() {
  let lock = Promise.resolve();
  return (fn) => {
    const next = lock.then(fn, fn);
    lock = next.catch(() => void 0);
    return next;
  };
}
function gitRevParseHead(repoRoot, branch) {
  return execFileSync7("git", ["rev-parse", `refs/heads/${branch}`], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
    windowsHide: true
  }).trim();
}
function gitPath(worktreePath, gitPathName) {
  try {
    const resolved = execFileSync7("git", ["rev-parse", "--git-path", gitPathName], {
      cwd: worktreePath,
      encoding: "utf-8",
      stdio: "pipe",
      windowsHide: true
    }).trim();
    if (resolved) return resolved;
  } catch {
  }
  return join25(worktreePath, ".git", gitPathName);
}
function isRebaseInProgress(worktreePath) {
  return existsSync21(gitPath(worktreePath, "rebase-merge"));
}
function isWorktreeRegistered(repoRoot, wtPath) {
  try {
    const out = execFileSync7("git", ["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
      windowsHide: true
    });
    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (line.slice("worktree ".length).trim() === wtPath) return true;
      }
    }
  } catch {
  }
  return false;
}
function ensureMergerWorktree(repoRoot, mergerPath, leaderBranch) {
  ensureDirWithMode(dirname19(mergerPath));
  if (existsSync21(mergerPath) && isWorktreeRegistered(repoRoot, mergerPath)) {
    return;
  }
  execFileSync7("git", ["worktree", "add", "--force", mergerPath, leaderBranch], {
    cwd: repoRoot,
    stdio: "pipe",
    windowsHide: true
  });
}
function preflightMergerWorktree(mergerPath, leaderBranch) {
  try {
    execFileSync7("git", ["fetch", "--no-tags", "origin", leaderBranch], {
      cwd: mergerPath,
      stdio: "pipe",
      windowsHide: true
    });
  } catch {
  }
  execFileSync7("git", ["reset", "--hard", leaderBranch], {
    cwd: mergerPath,
    stdio: "pipe",
    windowsHide: true
  });
}
function parseUUFiles(porcelainOutput) {
  const files = [];
  for (const line of porcelainOutput.split("\n")) {
    if (line.startsWith("UU ")) {
      files.push(line.slice(3).trim());
    } else if (line.startsWith("AA ") || line.startsWith("DD ")) {
      files.push(line.slice(3).trim());
    }
  }
  return files;
}
async function startMergeOrchestrator(config) {
  assertRuntimeV2Gate();
  assertLeaderBranchAllowed(config.leaderBranch);
  validateBranchName(config.leaderBranch);
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const drainTimeoutMs = config.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const mergerPath = mergerWorktreePathFor(config.repoRoot, config.teamName);
  validateResolvedPath(mergerPath, join25(getOmcRoot(config.repoRoot), "team"));
  ensureMergerWorktree(config.repoRoot, mergerPath, config.leaderBranch);
  await ensureLeaderInbox(config.teamName, config.cwd);
  configureHarnessMergeAttributes(config.repoRoot);
  const persistedPath = persistedStatePath(config.repoRoot, config.teamName);
  let persisted = { lastShas: {} };
  if (existsSync21(persistedPath)) {
    try {
      const { readFileSync: readFileSync18 } = await import("node:fs");
      persisted = JSON.parse(readFileSync18(persistedPath, "utf-8"));
    } catch {
      persisted = { lastShas: {} };
    }
  }
  const service = config.serviceGeneration === void 0 || config.serviceAttemptId === void 0 ? void 0 : { generation: config.serviceGeneration, attemptId: config.serviceAttemptId };
  const live = liveServiceOwners.get(config.teamName);
  if (service && live && (live.generation > service.generation || live.generation === service.generation && live.attemptId !== service.attemptId)) {
    throw new Error("auto_merge_service_owned_by_live_generation");
  }
  if (service) liveServiceOwners.set(config.teamName, service);
  const ownsService = () => !service || liveServiceOwners.get(config.teamName)?.generation === service.generation && liveServiceOwners.get(config.teamName)?.attemptId === service.attemptId;
  const workers = /* @__PURE__ */ new Map();
  const pausedWorkers = /* @__PURE__ */ new Set();
  const mutex = createMutex();
  let stopped = false;
  function persistState() {
    const payload = {
      lastShas: Object.fromEntries(
        Array.from(workers.values()).map((w) => [w.workerName, w.lastObservedSha])
      ),
      ...service ? { service } : {}
    };
    atomicWriteJson(persistedPath, payload);
  }
  async function fanOutRebase(triggeringWorker) {
    for (const other of workers.values()) {
      if (other.workerName === triggeringWorker) continue;
      const wtPath = other.workerWorktreePath;
      if (isRebaseInProgress(wtPath)) {
        await appendEvent(config.repoRoot, config.teamName, {
          type: "rebase_skipped_in_progress",
          worker: other.workerName,
          reason: "rebase-already-in-progress"
        });
        continue;
      }
      await appendEvent(config.repoRoot, config.teamName, {
        type: "rebase_triggered",
        worker: other.workerName
      });
      await pauseHookViaSentinel(wtPath);
      pausedWorkers.add(other.workerName);
      try {
        execFileSync7("git", ["fetch", "--no-tags", "origin", config.leaderBranch], {
          cwd: wtPath,
          stdio: "pipe",
          windowsHide: true
        });
      } catch {
      }
      try {
        execFileSync7("git", ["rebase", config.leaderBranch], {
          cwd: wtPath,
          stdio: "pipe",
          windowsHide: true
        });
        await resumeHookViaSentinel(wtPath);
        pausedWorkers.delete(other.workerName);
        await appendEvent(config.repoRoot, config.teamName, {
          type: "rebase_succeeded",
          worker: other.workerName
        });
      } catch {
        let conflictingFiles = [];
        try {
          const status = execFileSync7("git", ["status", "--porcelain"], {
            cwd: wtPath,
            encoding: "utf-8",
            stdio: "pipe",
            windowsHide: true
          });
          conflictingFiles = parseUUFiles(status);
        } catch {
          conflictingFiles = ["(rebase status unavailable)"];
        }
        const baseSha = (() => {
          try {
            return execFileSync7("git", ["rev-parse", `refs/heads/${config.leaderBranch}`], {
              cwd: config.repoRoot,
              encoding: "utf-8",
              stdio: "pipe",
              windowsHide: true
            }).trim();
          } catch {
            return "unknown";
          }
        })();
        const message = formatRebaseConflictForWorker({
          workerName: other.workerName,
          workerBranch: other.workerBranch,
          leaderBranch: config.leaderBranch,
          conflictingFiles,
          baseSha,
          worktreePath: wtPath,
          observedAt: Date.now()
        });
        try {
          await appendToInbox(config.teamName, other.workerName, message, config.cwd);
        } catch {
        }
        await appendEvent(config.repoRoot, config.teamName, {
          type: "rebase_conflict",
          worker: other.workerName,
          data: { conflictingFiles }
        });
      }
    }
  }
  async function attemptMergeForWorker(entry) {
    await mutex(async () => {
      const targetSha = entry.lastObservedSha;
      await appendEvent(config.repoRoot, config.teamName, {
        type: "merge_attempted",
        worker: entry.workerName,
        data: { targetSha }
      });
      try {
        preflightMergerWorktree(mergerPath, config.leaderBranch);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        entry.consecutiveFailures += 1;
        await appendEvent(config.repoRoot, config.teamName, {
          type: "merge_conflict",
          worker: entry.workerName,
          reason: `preflight_failed:${reason}`
        });
        return;
      }
      const conflicts = checkMergeConflicts(
        entry.workerBranch,
        config.leaderBranch,
        mergerPath
      );
      if (conflicts.length > 0) {
        let mergeBaseSha = "unknown";
        try {
          mergeBaseSha = execFileSync7(
            "git",
            ["merge-base", config.leaderBranch, entry.workerBranch],
            { cwd: mergerPath, encoding: "utf-8", stdio: "pipe", windowsHide: true }
          ).trim();
        } catch {
        }
        const message = formatMergeConflictForLeader({
          workerName: entry.workerName,
          workerBranch: entry.workerBranch,
          leaderBranch: config.leaderBranch,
          conflictingFiles: conflicts,
          mergeBaseSha,
          observedAt: Date.now()
        });
        try {
          await appendToLeaderInbox(config.teamName, message, config.cwd);
        } catch {
        }
        await appendEvent(config.repoRoot, config.teamName, {
          type: "merge_conflict",
          worker: entry.workerName,
          data: { conflictingFiles: conflicts, mergeBaseSha }
        });
        entry.consecutiveFailures += 1;
        return;
      }
      const result = mergeWorkerBranch(
        entry.workerBranch,
        config.leaderBranch,
        mergerPath
      );
      if (!result.success) {
        const message = formatMergeConflictForLeader({
          workerName: entry.workerName,
          workerBranch: entry.workerBranch,
          leaderBranch: config.leaderBranch,
          conflictingFiles: result.conflicts.length > 0 ? result.conflicts : ["(merge failed after clean check)"],
          mergeBaseSha: "unknown",
          observedAt: Date.now()
        });
        try {
          await appendToLeaderInbox(config.teamName, message, config.cwd);
        } catch {
        }
        await appendEvent(config.repoRoot, config.teamName, {
          type: "merge_conflict",
          worker: entry.workerName,
          data: { conflictingFiles: result.conflicts }
        });
        entry.consecutiveFailures += 1;
        return;
      }
      entry.lastMergedSha = targetSha;
      entry.consecutiveFailures = 0;
      await appendEvent(config.repoRoot, config.teamName, {
        type: "merge_succeeded",
        worker: entry.workerName,
        data: { mergeCommit: result.mergeCommit, targetSha }
      });
      if (stopped) return;
      await fanOutRebase(entry.workerName);
    });
  }
  async function runPollOnce() {
    if (stopped || !ownsService()) return;
    for (const entry of workers.values()) {
      const skipModulo = Math.min(30, Math.pow(2, entry.consecutiveFailures));
      if (skipModulo > 1 && pollTickCount % skipModulo !== 0) {
        continue;
      }
      if (pausedWorkers.has(entry.workerName)) {
        if (!isRebaseInProgress(entry.workerWorktreePath)) {
          await handleRebaseResolution(entry);
        } else {
          continue;
        }
      }
      let currentSha;
      try {
        currentSha = gitRevParseHead(config.repoRoot, entry.workerBranch);
      } catch (err) {
        entry.consecutiveFailures += 1;
        const reason = err instanceof Error ? err.message : String(err);
        await appendEvent(config.repoRoot, config.teamName, {
          type: "commit_observed",
          worker: entry.workerName,
          reason: `rev_parse_failed:${reason}`
        });
        continue;
      }
      if (currentSha && currentSha !== entry.lastObservedSha) {
        entry.lastObservedSha = currentSha;
        try {
          persistState();
        } catch {
        }
        await appendEvent(config.repoRoot, config.teamName, {
          type: "commit_observed",
          worker: entry.workerName,
          data: { sha: currentSha }
        });
        try {
          await attemptMergeForWorker(entry);
        } catch (err) {
          entry.consecutiveFailures += 1;
          const reason = err instanceof Error ? err.message : String(err);
          await appendEvent(config.repoRoot, config.teamName, {
            type: "merge_conflict",
            worker: entry.workerName,
            reason: `merge_threw:${reason}`
          });
        }
      }
    }
  }
  async function handleRebaseResolution(entry) {
    pausedWorkers.delete(entry.workerName);
    try {
      const status = execFileSync7("git", ["status", "--porcelain"], {
        cwd: entry.workerWorktreePath,
        encoding: "utf-8",
        stdio: "pipe",
        windowsHide: true
      }).trim();
      if (status.length > 0) {
        const dirtyFiles = status.split("\n").map((l) => l.trim().replace(/^\S+\s+/, "")).filter((s) => s.length > 0);
        const audit = `## Auto-commit audit: the following files were modified during rebase pause and will be folded into the next auto-commit:
${dirtyFiles.map((f) => `- \`${f}\``).join("\n")}`;
        try {
          await appendToInbox(config.teamName, entry.workerName, audit, config.cwd);
        } catch {
        }
      }
    } catch {
    }
    await resumeHookViaSentinel(entry.workerWorktreePath);
    await appendEvent(config.repoRoot, config.teamName, {
      type: "rebase_resolved",
      worker: entry.workerName
    });
  }
  let pollTickCount = 0;
  const interval = setInterval(() => {
    pollTickCount += 1;
    void runPollOnce().catch(() => {
    });
  }, pollIntervalMs);
  if (typeof interval.unref === "function") interval.unref();
  return {
    async registerWorker(workerName) {
      if (!ownsService()) return;
      if (workers.has(workerName)) return;
      const workerBranch = getBranchName(config.teamName, workerName);
      validateBranchName(workerBranch);
      const wtPath = getWorktreePath(config.repoRoot, config.teamName, workerName);
      let seedSha = persisted.lastShas[workerName] ?? "";
      if (!seedSha) {
        try {
          seedSha = gitRevParseHead(config.repoRoot, workerBranch);
        } catch {
          seedSha = "";
        }
      }
      workers.set(workerName, {
        workerName,
        workerBranch,
        workerWorktreePath: wtPath,
        lastObservedSha: seedSha,
        lastMergedSha: seedSha,
        consecutiveFailures: 0
      });
      try {
        persistState();
      } catch {
      }
    },
    async unregisterWorker(workerName) {
      if (!ownsService()) return;
      workers.delete(workerName);
      pausedWorkers.delete(workerName);
      try {
        persistState();
      } catch {
      }
    },
    async pollOnce() {
      await runPollOnce();
    },
    async drainAndStop() {
      if (!ownsService()) return { unmerged: [] };
      stopped = true;
      clearInterval(interval);
      const start = Date.now();
      const unmerged = [];
      const candidates = Array.from(workers.values()).filter(
        (w) => w.lastObservedSha && w.lastObservedSha !== w.lastMergedSha
      );
      for (const entry of candidates) {
        const remaining = drainTimeoutMs - (Date.now() - start);
        if (remaining <= 0) {
          unmerged.push({ workerName: entry.workerName, reason: "drain-timeout" });
          continue;
        }
        const merged = await Promise.race([
          (async () => {
            try {
              await attemptMergeForWorker(entry);
              return true;
            } catch {
              return false;
            }
          })(),
          new Promise((resolve7) => {
            const t = setTimeout(() => resolve7(false), remaining);
            if (typeof t.unref === "function") t.unref();
          })
        ]);
        if (!merged || entry.lastMergedSha !== entry.lastObservedSha) {
          unmerged.push({
            workerName: entry.workerName,
            reason: merged ? "merge-conflict" : "drain-timeout"
          });
        }
      }
      if (unmerged.length > 0) {
        const auditPath = teardownAuditPath(config.repoRoot, config.teamName);
        await mkdir10(dirname19(auditPath), { recursive: true });
        for (const u of unmerged) {
          const row = JSON.stringify({
            type: "unmerged_at_shutdown",
            ts: (/* @__PURE__ */ new Date()).toISOString(),
            team: config.teamName,
            worker: u.workerName,
            reason: u.reason
          });
          try {
            await appendFile5(auditPath, `${row}
`, "utf-8");
          } catch {
          }
        }
        const message = `## Teardown audit: unmerged worker branches at shutdown

${unmerged.map((u) => `- ${u.workerName}: ${u.reason}`).join("\n")}`;
        try {
          await appendToLeaderInbox(config.teamName, message, config.cwd);
        } catch {
        }
      }
      if (service && ownsService()) liveServiceOwners.delete(config.teamName);
      return { unmerged };
    },
    getState() {
      return {
        workers: Array.from(workers.keys()),
        lastShas: Object.fromEntries(
          Array.from(workers.values()).map((w) => [w.workerName, w.lastObservedSha])
        ),
        mergerWorktreePath: mergerPath
      };
    }
  };
}
async function recoverFromRestart(config) {
  const persistedPath = persistedStatePath(config.repoRoot, config.teamName);
  let persistedShasLoaded = 0;
  if (existsSync21(persistedPath)) {
    try {
      const { readFileSync: readFileSync18 } = await import("node:fs");
      const persisted = JSON.parse(readFileSync18(persistedPath, "utf-8"));
      persistedShasLoaded = Object.keys(persisted.lastShas ?? {}).length;
    } catch {
      persistedShasLoaded = 0;
    }
  }
  const orphanedRebases = [];
  let entries = [];
  try {
    entries = listTeamWorktrees(config.teamName, config.repoRoot).map((w) => ({
      workerName: w.workerName,
      path: w.path
    }));
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!isRebaseInProgress(entry.path)) continue;
    orphanedRebases.push(entry.workerName);
    const message = `### Runtime restart recovery \u2014 your branch is mid-rebase

Runtime restarted while your branch was mid-rebase onto \`${config.leaderBranch}\`.

**Worktree:** \`${entry.path}\`

Cadence remains paused. Resolve and \`git rebase --continue\`, or \`git rebase --abort\` to bail.
Cadence resumes once the git rebase state is gone.`;
    try {
      await appendToInbox(config.teamName, entry.workerName, message, config.cwd);
    } catch {
    }
  }
  if (orphanedRebases.length > 0 || persistedShasLoaded > 0) {
    try {
      await appendEvent(config.repoRoot, config.teamName, {
        type: "restart_recovery",
        data: { orphanedRebases, persistedShasLoaded }
      });
    } catch {
    }
  }
  return { orphanedRebases, persistedShasLoaded };
}
var liveServiceOwners, DEFAULT_POLL_INTERVAL_MS, DEFAULT_DRAIN_TIMEOUT_MS;
var init_merge_orchestrator = __esm({
  "src/team/merge-orchestrator.ts"() {
    "use strict";
    init_fs_utils();
    init_worktree_paths();
    init_runtime_flags();
    init_tmux_session();
    init_git_worktree();
    init_merge_coordinator();
    init_worker_bootstrap();
    init_leader_inbox();
    init_conflict_mailbox();
    init_worker_commit_cadence();
    liveServiceOwners = /* @__PURE__ */ new Map();
    DEFAULT_POLL_INTERVAL_MS = 1e3;
    DEFAULT_DRAIN_TIMEOUT_MS = 1e4;
  }
});

// src/team/recovery-request-store.ts
import { createHash as createHash7, randomUUID as randomUUID8 } from "crypto";
import { existsSync as existsSync22, linkSync as linkSync3, mkdirSync as mkdirSync7, readFileSync as readFileSync13, readdirSync as readdirSync7, renameSync as renameSync3, unlinkSync as unlinkSync9, writeFileSync as writeFileSync6 } from "fs";
import { dirname as dirname20, join as join26 } from "path";
function isSafeRecoveryRequestId(requestId) {
  return requestId.length > 0 && requestId.length <= 128 && requestId !== "." && requestId !== ".." && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(requestId);
}
function assertSafeRecoveryRequestId(requestId) {
  if (!isSafeRecoveryRequestId(requestId)) throw new Error("invalid_recovery_request_id");
}
function canonicalize2(value) {
  if (value === void 0) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize2).join(",")}]`;
  const object = value;
  return `{${Object.keys(object).filter((key) => object[key] !== void 0).sort().map((key) => `${JSON.stringify(key)}:${canonicalize2(object[key])}`).join(",")}}`;
}
function sha256(value) {
  return createHash7("sha256").update(canonicalize2(value)).digest("hex");
}
function parseCanonical(path4) {
  try {
    const text = readFileSync13(path4, "utf8");
    const parsed = JSON.parse(text);
    return canonicalize2(parsed) === text ? parsed : null;
  } catch {
    return null;
  }
}
function reservationPath(cwd, requestId) {
  assertSafeRecoveryRequestId(requestId);
  return absPath(cwd, TeamPaths.recoveryRequestPending(requestId));
}
function finalPath(cwd, requestId) {
  assertSafeRecoveryRequestId(requestId);
  return absPath(cwd, TeamPaths.recoveryRequestResult(requestId));
}
function phaseDirectory(cwd, requestId) {
  assertSafeRecoveryRequestId(requestId);
  return join26(dirname20(reservationPath(cwd, requestId)), "phases", requestId);
}
function publishImmutable(target, value) {
  const bytes = canonicalize2(value);
  mkdirSync7(dirname20(target), { recursive: true, mode: 448 });
  const temp = join26(dirname20(target), `.${randomUUID8()}.tmp`);
  writeFileSync6(temp, bytes, { encoding: "utf8", mode: 384, flush: true });
  try {
    linkSync3(temp, target);
  } catch (error) {
    const existing = parseCanonical(target);
    try {
      unlinkSync9(temp);
    } catch {
    }
    if (existing && canonicalize2(existing) === bytes) return existing;
    throw error;
  }
  const published = parseCanonical(target);
  if (!published || canonicalize2(published) !== bytes) throw new Error("immutable_recovery_record_verification_failed");
  unlinkSync9(temp);
  return published;
}
function replaceDerivedIndex(target, value) {
  const bytes = canonicalize2(value);
  mkdirSync7(dirname20(target), { recursive: true, mode: 448 });
  const temp = join26(dirname20(target), `.${randomUUID8()}.repair.tmp`);
  writeFileSync6(temp, bytes, { encoding: "utf8", mode: 384, flush: true });
  try {
    renameSync3(temp, target);
  } finally {
    if (existsSync22(temp)) unlinkSync9(temp);
  }
  const repaired = parseCanonical(target);
  if (!repaired || canonicalize2(repaired) !== bytes) throw new Error("immutable_recovery_record_verification_failed");
  return repaired;
}
function canonicalRecoveryPayloadHash(payload) {
  return sha256({ operation: payload.operation, workspace_hash: payload.workspaceHash, team_name: payload.teamName, worker_name: payload.workerName });
}
function reserveRecoveryRequest(cwd, requestId, payload, recoveryId = randomUUID8()) {
  assertSafeRecoveryRequestId(requestId);
  assertSafeRecoveryRequestId(recoveryId);
  const payloadHash = canonicalRecoveryPayloadHash(payload);
  const now = /* @__PURE__ */ new Date();
  const reservation = {
    schema_version: 1,
    kind: "reservation",
    request_id: requestId,
    payload_hash: payloadHash,
    operation: payload.operation,
    workspace_hash: payload.workspaceHash,
    team_name: payload.teamName,
    worker_name: payload.workerName,
    recovery_id: recoveryId,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + RETENTION_MS).toISOString()
  };
  try {
    return { kind: "created", reservation: publishImmutable(reservationPath(cwd, requestId), reservation) };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = readRecoveryRequestReservation(cwd, requestId);
    if (!existing) throw new Error("malformed_recovery_request_reservation");
    return existing.operation === payload.operation && existing.payload_hash === payloadHash && existing.workspace_hash === payload.workspaceHash && existing.team_name === payload.teamName && existing.worker_name === payload.workerName ? { kind: "joined", reservation: existing } : { kind: "conflict", reservation: existing };
  }
}
function aliasActiveRecoveryRequest(cwd, requestId, payload, active) {
  assertSafeRecoveryRequestId(requestId);
  assertSafeRecoveryRequestId(active.request_id);
  assertSafeRecoveryRequestId(active.recovery_id);
  const payloadHash = canonicalRecoveryPayloadHash(payload);
  if (active.operation !== payload.operation || active.payload_hash !== payloadHash || active.team_name !== payload.teamName || active.worker_name !== payload.workerName || active.workspace_hash !== payload.workspaceHash) return { kind: "conflict", reservation: active };
  const now = /* @__PURE__ */ new Date();
  const alias = {
    schema_version: 1,
    kind: "alias",
    request_id: requestId,
    payload_hash: payloadHash,
    operation: payload.operation,
    workspace_hash: payload.workspaceHash,
    team_name: payload.teamName,
    worker_name: payload.workerName,
    recovery_id: active.recovery_id,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + RETENTION_MS).toISOString(),
    alias_of_request_id: active.request_id
  };
  try {
    return { kind: "aliased", reservation: publishImmutable(reservationPath(cwd, requestId), alias) };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = readRecoveryRequestReservation(cwd, requestId);
    if (!existing) throw new Error("malformed_recovery_request_reservation");
    return existing.operation === payload.operation && existing.payload_hash === payloadHash && existing.workspace_hash === payload.workspaceHash && existing.team_name === payload.teamName && existing.worker_name === payload.workerName && existing.recovery_id === active.recovery_id ? { kind: "joined", reservation: existing } : { kind: "conflict", reservation: existing };
  }
}
function readRecoveryRequestReservation(cwd, requestId) {
  const reservation = parseCanonical(reservationPath(cwd, requestId));
  if (!reservation || reservation.schema_version !== 1 || reservation.kind !== "reservation" && reservation.kind !== "alias" || reservation.request_id !== requestId || reservation.operation !== "recover-worker" || typeof reservation.payload_hash !== "string" || !/^[a-f0-9]{64}$/.test(reservation.payload_hash) || typeof reservation.workspace_hash !== "string" || !/^[a-f0-9]{64}$/.test(reservation.workspace_hash) || typeof reservation.team_name !== "string" || reservation.team_name.length === 0 || typeof reservation.worker_name !== "string" || reservation.worker_name.length === 0 || reservation.payload_hash !== canonicalRecoveryPayloadHash({
    operation: reservation.operation,
    workspaceHash: reservation.workspace_hash,
    teamName: reservation.team_name,
    workerName: reservation.worker_name
  }) || typeof reservation.recovery_id !== "string" || !isSafeRecoveryRequestId(reservation.recovery_id) || typeof reservation.created_at !== "string" || !Number.isFinite(Date.parse(reservation.created_at)) || typeof reservation.expires_at !== "string" || !Number.isFinite(Date.parse(reservation.expires_at)) || reservation.kind === "alias" && (typeof reservation.alias_of_request_id !== "string" || !isSafeRecoveryRequestId(reservation.alias_of_request_id)) || reservation.kind === "reservation" && reservation.alias_of_request_id !== void 0) return null;
  return reservation;
}
function hasMatchingReservationTuple(left, right) {
  return left.operation === right.operation && left.payload_hash === right.payload_hash && left.workspace_hash === right.workspace_hash && left.team_name === right.team_name && left.worker_name === right.worker_name && left.recovery_id === right.recovery_id;
}
function resolveCanonicalRecoveryRequestId(cwd, requestId) {
  assertSafeRecoveryRequestId(requestId);
  const visited = /* @__PURE__ */ new Set();
  let currentRequestId = requestId;
  let alias = null;
  for (let depth = 0; depth < MAX_RECOVERY_ALIAS_DEPTH; depth += 1) {
    if (visited.has(currentRequestId)) return null;
    visited.add(currentRequestId);
    const reservation = readRecoveryRequestReservation(cwd, currentRequestId);
    if (!reservation) {
      if (alias || existsSync22(reservationPath(cwd, currentRequestId))) return null;
      return currentRequestId;
    }
    if (alias && !hasMatchingReservationTuple(alias, reservation)) return null;
    if (reservation.kind === "reservation") return currentRequestId;
    alias = reservation;
    currentRequestId = reservation.alias_of_request_id;
  }
  return null;
}
function hasMatchingRecoveryPhaseTuple(phase, reservation) {
  return phase.request_id === reservation.request_id && phase.recovery_id === reservation.recovery_id && phase.team_name === reservation.team_name && phase.worker_name === reservation.worker_name;
}
function isValidRecoveryPhase(phase, reservation) {
  return phase?.schema_version === 1 && phase.kind === "phase" && hasMatchingRecoveryPhaseTuple(phase, reservation) && ["reserved", "elected", "requeued", "ready", "active", "services_pending", "adopted"].includes(phase.phase) && ["none", "selected", "reserved", "adopted"].includes(phase.continuation) && ["not_started", "pending", "adopted"].includes(phase.adoption) && ["not_started", "pending", "synced", "repair_required"].includes(phase.services) && ["not_started", "synced", "repair_required"].includes(phase.manifest) && typeof phase.updated_at === "string" && Number.isFinite(Date.parse(phase.updated_at)) && (phase.state_revision === void 0 || Number.isSafeInteger(phase.state_revision) && phase.state_revision >= 0);
}
function writeRecoveryPhase(cwd, phase) {
  const reservation = readRecoveryRequestReservation(cwd, phase.request_id);
  if (!reservation || reservation.kind !== "reservation" || !hasMatchingRecoveryPhaseTuple(phase, reservation)) {
    throw new Error("invalid_persisted_state");
  }
  const sequence = `${Date.now().toString().padStart(16, "0")}-${process.hrtime.bigint().toString().padStart(20, "0")}-${randomUUID8()}.json`;
  return publishImmutable(join26(phaseDirectory(cwd, phase.request_id), sequence), { ...phase, schema_version: 1, kind: "phase", updated_at: phase.updated_at || (/* @__PURE__ */ new Date()).toISOString() });
}
function writeRecoveryFinal(cwd, outcome) {
  const reservation = readRecoveryRequestReservation(cwd, outcome.request_id);
  if (!reservation || reservation.kind !== "reservation" || reservation.recovery_id !== outcome.recovery_id || reservation.team_name !== outcome.team_name || reservation.worker_name !== outcome.worker_name) {
    throw new Error("invalid_persisted_state");
  }
  const final = { ...outcome, schema_version: 1, kind: "final" };
  if (!isMatchingRecoveryFinal(final, {
    requestId: outcome.request_id,
    recoveryId: outcome.recovery_id,
    teamName: outcome.team_name,
    workerName: outcome.worker_name
  })) throw new Error("invalid_persisted_state");
  const published = publishImmutable(finalPath(cwd, outcome.request_id), final);
  const byTeam = absPath(cwd, TeamPaths.recoveryResultByTeam(reservation.workspace_hash, outcome.team_name, outcome.recovery_id));
  const indexed = publishImmutable(byTeam, published);
  if (canonicalize2(indexed) !== canonicalize2(published)) throw new Error("immutable_recovery_record_verification_failed");
  return published;
}
function latestPhase(cwd, requestId) {
  const reservation = readRecoveryRequestReservation(cwd, requestId);
  if (!reservation || reservation.kind !== "reservation") return null;
  const directory = phaseDirectory(cwd, requestId);
  try {
    const candidates = readdirSync7(directory).filter((file) => file.endsWith(".json")).sort().reverse();
    if (candidates.length === 0) return null;
    const phase = parseCanonical(join26(directory, candidates[0]));
    return isValidRecoveryPhase(phase, reservation) ? phase : null;
  } catch {
  }
  return null;
}
function isStringArray2(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function isPlainRecord2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function hasExactUniqueKeys(values, record) {
  if (new Set(values).size !== values.length) return false;
  const expected = [...values].sort();
  const actual = Object.keys(record).sort();
  return expected.length === actual.length && expected.every((value, index) => value === actual[index]);
}
function isValidRecoveryResult(value) {
  if (!value || typeof value !== "object") return false;
  const result = value;
  if (typeof result.requestId !== "string" || typeof result.recoveryId !== "string" || typeof result.teamName !== "string" || typeof result.workerName !== "string" || typeof result.updatedAt !== "string" || !Number.isFinite(Date.parse(result.updatedAt)) || typeof result.committed !== "boolean") return false;
  if (result.outcome === "recovered" || result.outcome === "already_running") {
    if (result.committed !== true || typeof result.oldPaneId !== "string" && result.oldPaneId !== null || typeof result.newPaneId !== "string" || !result.newPaneId.trim() || result.outcome === "recovered" && (typeof result.oldPaneId !== "string" || !result.oldPaneId.trim()) || !isStringArray2(result.requeuedTaskIds) || !isPlainRecord2(result.continuationSequenceByTask) || !hasExactUniqueKeys(result.requeuedTaskIds, result.continuationSequenceByTask) || !Object.values(result.continuationSequenceByTask).every((sequence) => typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence > 0) || typeof result.stateRevision !== "number" || !Number.isSafeInteger(result.stateRevision) || result.activation !== "active" && result.activation !== "services_pending" || result.manifestSync !== "synced" && result.manifestSync !== "repair_required" || result.servicesSync !== "synced" && result.servicesSync !== "repair_required" || !isStringArray2(result.warnings) || !result.warnings.every((warning) => RECOVERY_WARNINGS.has(warning))) return false;
    return result.outcome !== "already_running" || result.requeuedTaskIds.length === 0;
  }
  return (result.outcome === "failed" || result.outcome === "commit_unknown") && result.committed === false && typeof result.error === "string" && RECOVERY_ERRORS.has(result.error) && (result.message === void 0 || typeof result.message === "string");
}
function readRecoveryFinalState(cwd, requestId) {
  const path4 = finalPath(cwd, requestId);
  if (!existsSync22(path4)) return { kind: "missing" };
  const final = parseCanonical(path4);
  if (!final || final.schema_version !== 1 || final.kind !== "final" || !isMatchingRecoveryFinal(final, { requestId })) {
    return { kind: "invalid" };
  }
  const reservation = readRecoveryRequestReservation(cwd, requestId);
  if (!reservation || reservation.kind !== "reservation" || reservation.recovery_id !== final.recovery_id || reservation.team_name !== final.team_name || reservation.worker_name !== final.worker_name) return { kind: "invalid" };
  const byTeam = absPath(cwd, TeamPaths.recoveryResultByTeam(reservation.workspace_hash, final.team_name, final.recovery_id));
  try {
    const expectedBytes = canonicalize2(final);
    const indexed = existsSync22(byTeam) ? parseCanonical(byTeam) : null;
    if (!indexed || canonicalize2(indexed) !== expectedBytes) {
      const lockPath = absPath(cwd, TeamPaths.recoveryFinalIndexLock(reservation.workspace_hash, final.team_name, final.recovery_id));
      withProcessIdentityFileLockSync(lockPath, () => {
        const current = existsSync22(byTeam) ? parseCanonical(byTeam) : null;
        if (!current || canonicalize2(current) !== expectedBytes) replaceDerivedIndex(byTeam, final);
      });
    }
    const verified = parseCanonical(byTeam);
    if (!verified || canonicalize2(verified) !== expectedBytes) return { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
  return { kind: "valid", final };
}
function isMatchingRecoveryFinal(outcome, expected = {}) {
  if (!outcome || outcome.kind !== "final" || !isValidRecoveryResult(outcome.result) || outcome.request_id !== outcome.result.requestId || outcome.recovery_id !== outcome.result.recoveryId || outcome.team_name !== outcome.result.teamName || outcome.worker_name !== outcome.result.workerName || expected.requestId !== void 0 && outcome.request_id !== expected.requestId || expected.recoveryId !== void 0 && outcome.recovery_id !== expected.recoveryId || expected.teamName !== void 0 && outcome.team_name !== expected.teamName || expected.workerName !== void 0 && outcome.worker_name !== expected.workerName || typeof outcome.completed_at !== "string" || !Number.isFinite(Date.parse(outcome.completed_at)) || typeof outcome.expires_at !== "string" || !Number.isFinite(Date.parse(outcome.expires_at)) || !["none", "selected", "reserved", "adopted"].includes(outcome.continuation) || !["not_started", "pending", "adopted"].includes(outcome.adoption) || !["synced", "repair_required", "terminal_degraded"].includes(outcome.services) || !["synced", "repair_required"].includes(outcome.manifest)) return false;
  const succeeded = outcome.result.outcome === "recovered" || outcome.result.outcome === "already_running";
  if (outcome.outcome !== (succeeded ? "succeeded" : outcome.result.outcome === "commit_unknown" ? "commit_unknown" : "failed")) return false;
  if (succeeded) {
    const success = outcome.result;
    const hasContinuations = success.requeuedTaskIds.length > 0;
    const servicesPending = success.servicesSync === "repair_required";
    return outcome.error === void 0 && outcome.continuation === (hasContinuations ? "adopted" : "none") && outcome.adoption === (hasContinuations ? "adopted" : "not_started") && outcome.services === success.servicesSync && outcome.manifest === success.manifestSync && success.manifestSync === "synced" && success.activation === (servicesPending ? "services_pending" : "active") && (servicesPending ? success.warnings.length === 1 && success.warnings[0] === "services_pending" : success.warnings.length === 0);
  }
  const failure2 = outcome.result;
  return outcome.continuation === "none" && outcome.adoption === "not_started" && outcome.error?.code === failure2.error && outcome.error?.message === failure2.message && outcome.error?.commit_uncertain === (failure2.outcome === "commit_unknown") && outcome.services === "terminal_degraded" && outcome.manifest === "repair_required";
}
function readRecoveryOutcome(cwd, requestId) {
  const canonicalRequestId = resolveCanonicalRecoveryRequestId(cwd, requestId);
  if (!canonicalRequestId) return null;
  const final = readRecoveryFinalState(cwd, canonicalRequestId);
  if (final.kind === "valid") return final.final;
  if (final.kind === "invalid") return null;
  return latestPhase(cwd, canonicalRequestId);
}
function readRecoveryResult(cwd, requestId) {
  const outcome = readRecoveryOutcome(cwd, requestId);
  return outcome?.kind === "final" ? outcome.result ?? null : null;
}
var RETENTION_MS, MAX_RECOVERY_ALIAS_DEPTH, RECOVERY_ERRORS, RECOVERY_WARNINGS;
var init_recovery_request_store = __esm({
  "src/team/recovery-request-store.ts"() {
    "use strict";
    init_state_paths();
    init_process_identity_lock();
    RETENTION_MS = 7 * 24 * 60 * 60 * 1e3;
    MAX_RECOVERY_ALIAS_DEPTH = 16;
    RECOVERY_ERRORS = /* @__PURE__ */ new Set([
      "invalid_input",
      "team_not_found",
      "worker_not_found",
      "runtime_v2_required",
      "invalid_persisted_state",
      "runtime_owner_unavailable",
      "runtime_owner_fence_lost",
      "recovery_request_timeout",
      "recovery_attempt_conflict",
      "team_mutation_busy",
      "team_mutation_resume_required",
      "team_shutting_down",
      "team_session_dead",
      "worker_liveness_unknown",
      "recovery_checkpoint_missing",
      "recovery_checkpoint_malformed",
      "recovery_checkpoint_ambiguous",
      "recovery_checkpoint_stale",
      "task_requeue_failed",
      "launch_metadata_incomplete",
      "launch_descriptor_unresolvable",
      "spawn_failed",
      "startup_ack_timeout",
      "worker_activation_failed",
      "auto_merge_unavailable",
      "stale_state_revision",
      "config_commit_failed"
    ]);
    RECOVERY_WARNINGS = /* @__PURE__ */ new Set([
      "projection_repair_required",
      "identity_repair_required",
      "services_pending",
      "event_repair_required",
      "result_repair_required"
    ]);
  }
});

// src/team/runtime-owner-client.ts
var runtime_owner_client_exports = {};
__export(runtime_owner_client_exports, {
  createRecoveryOwnerClient: () => createRecoveryOwnerClient,
  isExpectedRecoveryOwnerSuccessor: () => isExpectedRecoveryOwnerSuccessor,
  parseRecoveryIntent: () => parseRecoveryIntent,
  recoveryOwnerBootstrapTestHooks: () => recoveryOwnerBootstrapTestHooks,
  requestRuntimeOwnerRecovery: () => requestRuntimeOwnerRecovery,
  setRuntimeOwnerDispatch: () => setRuntimeOwnerDispatch,
  withRecoveryAdmissionLock: () => withRecoveryAdmissionLock
});
import { spawn } from "node:child_process";
import { createHash as createHash8, randomUUID as randomUUID9 } from "node:crypto";
import { existsSync as existsSync23, readdirSync as readdirSync8, readFileSync as readFileSync14 } from "node:fs";
import { link as link2, mkdir as mkdir11, open as open3, readFile as readFile11, unlink as unlink4 } from "node:fs/promises";
import { basename as basename10, dirname as dirname21, join as join27 } from "node:path";
function workspaceHash(cwd) {
  return createHash8("sha256").update(cwd).digest("hex");
}
function timeoutBudget(timeoutMs, minimum = MIN_RECOVERY_TIMEOUT_MS, maximum = MAX_RECOVERY_TIMEOUT_MS) {
  if (!Number.isFinite(timeoutMs)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.floor(timeoutMs)));
}
function resolveCanonicalReservation(cwd, reservation) {
  let current = reservation;
  const seen = /* @__PURE__ */ new Set();
  while (current.alias_of_request_id && !seen.has(current.request_id)) {
    seen.add(current.request_id);
    const parent = readRecoveryRequestReservation(cwd, current.alias_of_request_id);
    if (!parent || parent.operation !== reservation.operation || parent.payload_hash !== reservation.payload_hash || parent.workspace_hash !== reservation.workspace_hash || parent.team_name !== reservation.team_name || parent.worker_name !== reservation.worker_name || parent.recovery_id !== reservation.recovery_id) {
      throw new Error("invalid_persisted_state");
    }
    current = parent;
  }
  if (current.kind !== "reservation") throw new Error("invalid_persisted_state");
  return current;
}
function findActiveIdenticalReservation(cwd, payload) {
  const targetHash = canonicalRecoveryPayloadHash(payload);
  try {
    for (const name of readdirSync8(absPath(cwd, TeamPaths.recoveryRequestsRoot()))) {
      const match = /^(.+)\.pending\.json$/.exec(name);
      if (!match) continue;
      const reservation = readRecoveryRequestReservation(cwd, match[1]);
      if (!reservation || reservation.operation !== payload.operation || reservation.payload_hash !== targetHash || reservation.workspace_hash !== payload.workspaceHash || reservation.team_name !== payload.teamName || reservation.worker_name !== payload.workerName) continue;
      const canonical = resolveCanonicalReservation(cwd, reservation);
      const outcome = readRecoveryOutcome(cwd, canonical.request_id);
      if (!outcome || outcome.kind === "phase") return canonical;
    }
  } catch {
  }
  return null;
}
function withRecoveryAdmissionLock(cwd, payloadHash, fn) {
  return withProcessIdentityFileLock(absPath(cwd, TeamPaths.recoveryAdmissionLock(payloadHash)), fn);
}
function canonicalBootstrapCandidate(value) {
  return JSON.stringify(value);
}
function recoveryOwnerBootstrapCandidatePath(cwd, teamName, expectedEpoch, nonce) {
  return absPath(cwd, TeamPaths.recoveryOwnerBootstrapCandidate(teamName, expectedEpoch, nonce));
}
async function syncParentDirectory(path4) {
  const directory = await open3(dirname21(path4), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
function validateBootstrapCandidate(value, input, recoveryId, expectedEpoch, nonce, pid, processStartedAt, predecessor) {
  const candidate = value;
  if (!candidate || candidate.schema_version !== 1 || candidate.request_id !== input.requestId || candidate.recovery_id !== recoveryId || candidate.team_name !== input.teamName || candidate.worker_name !== input.workerName || candidate.expected_epoch !== expectedEpoch || candidate.nonce !== nonce || candidate.pid !== pid || candidate.process_started_at !== processStartedAt || candidate.predecessor_epoch !== (predecessor?.epoch ?? 0) || candidate.predecessor_nonce !== (predecessor?.nonce ?? null) || candidate.predecessor_pid !== (predecessor?.pid ?? null) || candidate.predecessor_process_started_at !== (predecessor?.process_started_at ?? null) || typeof candidate.created_at !== "string" || !Number.isFinite(Date.parse(candidate.created_at)) || typeof candidate.payload_hash !== "string") return false;
  const { payload_hash, ...unsigned } = candidate;
  return createHash8("sha256").update(canonicalBootstrapCandidate(unsigned)).digest("hex") === payload_hash;
}
async function publishRecoveryOwnerBootstrapCandidate(input, recoveryId, expectedEpoch, nonce, pid, processStartedAt, predecessor) {
  const unsigned = {
    schema_version: 1,
    request_id: input.requestId,
    recovery_id: recoveryId,
    team_name: input.teamName,
    worker_name: input.workerName,
    expected_epoch: expectedEpoch,
    nonce,
    pid,
    process_started_at: processStartedAt,
    predecessor_epoch: predecessor?.epoch ?? 0,
    predecessor_nonce: predecessor?.nonce ?? null,
    predecessor_pid: predecessor?.pid ?? null,
    predecessor_process_started_at: predecessor?.process_started_at ?? null,
    created_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  const candidate = {
    ...unsigned,
    payload_hash: createHash8("sha256").update(canonicalBootstrapCandidate(unsigned)).digest("hex")
  };
  const path4 = recoveryOwnerBootstrapCandidatePath(input.cwd, input.teamName, expectedEpoch, nonce);
  await mkdir11(dirname21(path4), { recursive: true, mode: 448 });
  const temporary = `${path4}.${process.pid}.${randomUUID9()}.candidate`;
  const handle = await open3(temporary, "wx", 384);
  try {
    await handle.writeFile(JSON.stringify(candidate), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link2(temporary, path4);
    const linked = JSON.parse(await readFile11(path4, "utf8"));
    if (!validateBootstrapCandidate(linked, input, recoveryId, expectedEpoch, nonce, pid, processStartedAt, predecessor)) {
      throw new Error("runtime_owner_bootstrap_candidate_mismatch");
    }
    await syncParentDirectory(path4);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const linked = JSON.parse(await readFile11(path4, "utf8"));
    if (!validateBootstrapCandidate(linked, input, recoveryId, expectedEpoch, nonce, pid, processStartedAt, predecessor)) {
      throw new Error("runtime_owner_bootstrap_candidate_mismatch");
    }
    await syncParentDirectory(path4);
  } finally {
    await unlink4(temporary).catch(() => void 0);
  }
}
function hasLiveOrUnknownBootstrapCandidate(input, recoveryId, expectedEpoch, predecessor) {
  const candidateDirectory = dirname21(recoveryOwnerBootstrapCandidatePath(input.cwd, input.teamName, expectedEpoch, "candidate"));
  const legacyCandidate = join27(dirname21(candidateDirectory), `${expectedEpoch}.json`);
  if (existsSync23(legacyCandidate)) return true;
  let entries;
  try {
    entries = readdirSync8(candidateDirectory);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    let value;
    try {
      value = JSON.parse(readFileSync14(join27(candidateDirectory, entry), "utf8"));
    } catch {
      return true;
    }
    if (!value || typeof value.nonce !== "string" || typeof value.pid !== "number" || typeof value.process_started_at !== "string" || !validateBootstrapCandidate(
      value,
      input,
      recoveryId,
      expectedEpoch,
      value.nonce,
      value.pid,
      value.process_started_at,
      predecessor
    ) || !isProcessIdentityDead({ pid: value.pid, process_started_at: value.process_started_at })) return true;
  }
  return false;
}
function parseRecoveryIntent(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("invalid_persisted_state");
  }
  const intent = value;
  if (intent?.schema_version !== 1 || intent.kind !== "recover-worker" || intent.operation !== "recover-worker" || typeof intent.workspace_hash !== "string" || !/^[a-f0-9]{64}$/.test(intent.workspace_hash) || typeof intent.payload_hash !== "string" || !/^[a-f0-9]{64}$/.test(intent.payload_hash) || typeof intent.request_id !== "string" || intent.request_id.length === 0 || typeof intent.recovery_id !== "string" || intent.recovery_id.length === 0 || typeof intent.team_name !== "string" || intent.team_name.length === 0 || typeof intent.worker_name !== "string" || intent.worker_name.length === 0 || intent.payload_hash !== canonicalRecoveryPayloadHash({
    operation: intent.operation,
    workspaceHash: intent.workspace_hash,
    teamName: intent.team_name,
    workerName: intent.worker_name
  }) || typeof intent.created_at !== "string" || !Number.isFinite(Date.parse(intent.created_at))) {
    throw new Error("invalid_persisted_state");
  }
  return intent;
}
function validateRecoveryIntent(intent, input, recoveryId) {
  const expectedWorkspaceHash = workspaceHash(input.cwd);
  const expectedPayloadHash = canonicalRecoveryPayloadHash({
    operation: "recover-worker",
    workspaceHash: expectedWorkspaceHash,
    teamName: input.teamName,
    workerName: input.workerName
  });
  if (intent.request_id !== input.requestId || intent.recovery_id !== recoveryId || intent.operation !== "recover-worker" || intent.workspace_hash !== expectedWorkspaceHash || intent.payload_hash !== expectedPayloadHash || intent.team_name !== input.teamName || intent.worker_name !== input.workerName) {
    throw new Error("invalid_persisted_state");
  }
}
async function publishIntent(input, recoveryId) {
  const path4 = absPath(input.cwd, TeamPaths.recoveryIntent(input.teamName, recoveryId));
  try {
    validateRecoveryIntent(parseRecoveryIntent(await readFile11(path4, "utf8")), input, recoveryId);
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const workspaceHashValue = workspaceHash(input.cwd);
  const intentPayload = {
    operation: "recover-worker",
    workspaceHash: workspaceHashValue,
    teamName: input.teamName,
    workerName: input.workerName
  };
  const intent = {
    schema_version: 1,
    kind: "recover-worker",
    request_id: input.requestId,
    recovery_id: recoveryId,
    operation: intentPayload.operation,
    workspace_hash: intentPayload.workspaceHash,
    payload_hash: canonicalRecoveryPayloadHash(intentPayload),
    team_name: input.teamName,
    worker_name: input.workerName,
    created_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  await mkdir11(dirname21(path4), { recursive: true, mode: 448 });
  const candidate = `${path4}.candidate.${process.pid}.${randomUUID9()}`;
  const candidateHandle = await open3(candidate, "wx", 384);
  try {
    await candidateHandle.writeFile(JSON.stringify(intent), "utf8");
    await candidateHandle.sync();
  } finally {
    await candidateHandle.close();
  }
  try {
    await link2(candidate, path4);
    validateRecoveryIntent(parseRecoveryIntent(await readFile11(path4, "utf8")), input, recoveryId);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    validateRecoveryIntent(parseRecoveryIntent(await readFile11(path4, "utf8")), input, recoveryId);
  } finally {
    await unlink4(candidate).catch(() => void 0);
  }
}
function timeoutResult(input, recoveryId) {
  return {
    outcome: "failed",
    committed: false,
    error: "recovery_request_timeout",
    requestId: input.requestId,
    recoveryId,
    teamName: input.teamName,
    workerName: input.workerName,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    message: "Timed out waiting for the persistent recovery owner."
  };
}
async function teamRecoveryState(cwd, teamName) {
  const configPath = absPath(cwd, TeamPaths.config(teamName));
  if (!existsSync23(configPath)) return "team_not_found";
  try {
    const revisioned = await readRevisionedTeamConfig(teamName, cwd);
    if (revisioned) return "v2";
    const config = JSON.parse(await readFile11(configPath, "utf8"));
    return validateLegacyTeamConfig(config, teamName) ? "runtime_v2_required" : "invalid_persisted_state";
  } catch {
    return "invalid_persisted_state";
  }
}
function terminalResult(input, recoveryId, error) {
  const message = error === "team_not_found" ? "The requested team does not exist." : error === "runtime_v2_required" ? "Dead-worker recovery requires runtime v2 state." : error === "invalid_persisted_state" ? "The authoritative team config is unreadable or malformed." : "The persistent runtime owner identity cannot be verified.";
  return {
    outcome: "failed",
    committed: false,
    error,
    requestId: input.requestId,
    recoveryId,
    teamName: input.teamName,
    workerName: input.workerName,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    message
  };
}
function persistTerminalResult(input, recoveryId, result) {
  writeRecoveryFinal(input.cwd, {
    schema_version: 1,
    kind: "final",
    request_id: input.requestId,
    recovery_id: recoveryId,
    team_name: input.teamName,
    worker_name: input.workerName,
    outcome: "failed",
    result,
    error: { code: "error" in result ? result.error : "runtime_owner_unavailable", message: result.message, commit_uncertain: false },
    continuation: "none",
    adoption: "not_started",
    services: "terminal_degraded",
    manifest: "repair_required",
    completed_at: result.updatedAt,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1e3).toISOString()
  });
  return result;
}
function ownerAvailability(cwd, teamName) {
  let owner;
  try {
    owner = readLatestOwnerEpoch(cwd, teamName);
  } catch {
    return "unknown";
  }
  if (!owner) return "missing";
  if (isProcessIdentityDead(owner)) return "dead";
  try {
    process.kill(owner.pid, 0);
    return currentProcessStartIdentity(owner.pid) === owner.process_started_at ? "live" : "unknown";
  } catch {
    return "unknown";
  }
}
function resolveRuntimeCliPath() {
  if (process.env.OMC_RUNTIME_CLI_PATH) return process.env.OMC_RUNTIME_CLI_PATH;
  if (typeof __dirname !== "undefined" && __dirname) {
    return basename10(__dirname) === "bridge" ? join27(__dirname, "runtime-cli.cjs") : join27(__dirname, "../../bridge/runtime-cli.cjs");
  }
  const entry = process.argv[1];
  if (entry && basename10(entry) === "runtime-cli.cjs") return entry;
  throw new Error("runtime_owner_bootstrap_path_unavailable");
}
function isExpectedRecoveryOwnerSuccessor(owner, expectedEpoch, childPid, childProcessStartedAt, fenceOk, expectedNonce) {
  return Boolean(owner && childProcessStartedAt && owner.epoch === expectedEpoch && owner.pid === childPid && owner.process_started_at === childProcessStartedAt && (!expectedNonce || owner.nonce === expectedNonce) && fenceOk);
}
async function bootstrapPersistentOwner(input, priorEpoch) {
  let predecessor;
  try {
    predecessor = readLatestOwnerEpoch(input.cwd, input.teamName);
  } catch {
    return false;
  }
  const reservation = readRecoveryRequestReservation(input.cwd, input.requestId);
  if (priorEpoch !== (predecessor?.epoch ?? null) || predecessor && !isProcessIdentityDead(predecessor) || !reservation || reservation.kind !== "reservation" || reservation.recovery_id.length === 0 || reservation.team_name !== input.teamName || reservation.worker_name !== input.workerName) return false;
  const predecessorEpoch = predecessor?.epoch ?? 0;
  const expectedEpoch = predecessorEpoch + 1;
  if (hasLiveOrUnknownBootstrapCandidate(input, reservation.recovery_id, expectedEpoch, predecessor)) return false;
  const bootstrapNonce = randomUUID9();
  const child = spawn(process.execPath, [resolveRuntimeCliPath()], {
    cwd: input.cwd,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      OMC_RECOVERY_OWNER_INPUT: JSON.stringify(input),
      OMC_RECOVERY_OWNER_EXPECTED_EPOCH: String(expectedEpoch),
      OMC_RECOVERY_OWNER_PREDECESSOR_EPOCH: String(predecessorEpoch),
      OMC_RECOVERY_OWNER_PREDECESSOR_NONCE: predecessor?.nonce ?? "",
      OMC_RECOVERY_OWNER_NONCE: bootstrapNonce,
      OMC_RECOVERY_OWNER_PREDECESSOR_PID: String(predecessor?.pid ?? 0),
      OMC_RECOVERY_OWNER_PREDECESSOR_STARTED_AT: predecessor?.process_started_at ?? "",
      OMC_RECOVERY_OWNER_RECOVERY_ID: reservation.recovery_id
    }
  });
  child.unref();
  if (!child.pid) return false;
  const childProcessStartedAt = currentProcessStartIdentity(child.pid);
  if (!childProcessStartedAt) return false;
  try {
    await publishRecoveryOwnerBootstrapCandidate(
      input,
      reservation.recovery_id,
      expectedEpoch,
      bootstrapNonce,
      child.pid,
      childProcessStartedAt,
      predecessor
    );
  } catch {
    return false;
  }
  const deadline = Date.now() + 1e4;
  while (Date.now() < deadline) {
    let owner;
    try {
      owner = readLatestOwnerEpoch(input.cwd, input.teamName);
    } catch {
      return false;
    }
    const config = await readRevisionedTeamConfig(input.teamName, input.cwd).catch(() => null);
    const configBound = config?.config.runtime_owner_epoch;
    const active = config?.config.active_recovery;
    const fenceOk = owner ? checkOwnerFence(input.cwd, input.teamName, { epoch: owner.epoch, nonce: owner.nonce }).ok : false;
    if (isExpectedRecoveryOwnerSuccessor(owner, expectedEpoch, child.pid, childProcessStartedAt, fenceOk, bootstrapNonce) && configBound?.epoch === expectedEpoch && configBound.nonce === bootstrapNonce && configBound.pid === child.pid && configBound.process_started_at === childProcessStartedAt && active?.request_id === input.requestId && active?.recovery_id === reservation.recovery_id && active?.worker_name === input.workerName && active?.owner_epoch === expectedEpoch && active?.owner_nonce === bootstrapNonce) return true;
    if (owner && (owner.epoch > expectedEpoch || owner.epoch === expectedEpoch && owner.pid !== child.pid)) return false;
    await new Promise((resolve7) => setTimeout(resolve7, 25));
  }
  return false;
}
function createRecoveryOwnerClient(dispatch, timing = {}) {
  return {
    async recoverDeadWorker(input) {
      const requestId = input.requestId || randomUUID9();
      const normalized = { ...input, requestId, timeoutMs: timeoutBudget(
        input.timeoutMs,
        timing.minTimeoutMs ?? MIN_RECOVERY_TIMEOUT_MS,
        timing.maxTimeoutMs ?? MAX_RECOVERY_TIMEOUT_MS
      ) };
      const payload = { operation: "recover-worker", workspaceHash: workspaceHash(normalized.cwd), teamName: normalized.teamName, workerName: normalized.workerName };
      const admitted = await withProcessIdentityFileLock(
        absPath(normalized.cwd, TeamPaths.recoveryLifecycleLock(payload.workspaceHash, normalized.teamName)),
        async () => {
          const admission2 = await withRecoveryAdmissionLock(normalized.cwd, canonicalRecoveryPayloadHash(payload), () => {
            const active = findActiveIdenticalReservation(normalized.cwd, payload);
            return active ? aliasActiveRecoveryRequest(normalized.cwd, requestId, payload, active) : reserveRecoveryRequest(normalized.cwd, requestId, payload);
          });
          if (admission2.kind === "conflict") return { kind: "conflict", admission: admission2 };
          const canonical2 = resolveCanonicalReservation(normalized.cwd, admission2.reservation);
          const prior = readRecoveryOutcome(normalized.cwd, canonical2.request_id);
          const priorFinalState = readRecoveryFinalState(normalized.cwd, canonical2.request_id);
          if (priorFinalState.kind === "invalid") throw new Error("invalid_persisted_state");
          if (isMatchingRecoveryFinal(prior, {
            requestId: canonical2.request_id,
            recoveryId: canonical2.recovery_id,
            teamName: normalized.teamName,
            workerName: normalized.workerName
          })) {
            return { kind: "final", result: prior.result };
          }
          const canonicalInput2 = { ...normalized, requestId: canonical2.request_id };
          if (timing.persistentOwnerBootstrap) {
            const state = await teamRecoveryState(normalized.cwd, normalized.teamName);
            if (state !== "v2") {
              const result = terminalResult(canonicalInput2, canonical2.recovery_id, state);
              return { kind: "final", result: persistTerminalResult(canonicalInput2, canonical2.recovery_id, result) };
            }
          }
          await publishIntent(canonicalInput2, canonical2.recovery_id);
          return { kind: "pending", admission: admission2, canonical: canonical2, canonicalInput: canonicalInput2 };
        }
      );
      if (admitted.kind === "conflict") {
        return {
          outcome: "failed",
          committed: false,
          error: "recovery_attempt_conflict",
          requestId,
          recoveryId: admitted.admission.reservation.recovery_id,
          teamName: normalized.teamName,
          workerName: normalized.workerName,
          updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
          message: "Request ID is already reserved for a different recovery payload."
        };
      }
      if (admitted.kind === "final") return admitted.result;
      const { admission, canonical, canonicalInput } = admitted;
      const outcomeRequestId = canonical.request_id;
      if (timing.persistentOwnerBootstrap) {
        const ownerReady = await withProcessIdentityFileLock(
          absPath(normalized.cwd, TeamPaths.recoveryLifecycleLock(payload.workspaceHash, normalized.teamName)),
          async () => {
            const state = await teamRecoveryState(normalized.cwd, normalized.teamName);
            if (state !== "v2") return false;
            const availability = ownerAvailability(normalized.cwd, normalized.teamName);
            if (availability === "unknown") return null;
            if (availability === "live") return true;
            let priorEpoch = null;
            try {
              priorEpoch = readLatestOwnerEpoch(normalized.cwd, normalized.teamName)?.epoch ?? null;
            } catch {
              return null;
            }
            return (timing.bootstrapOwner ?? bootstrapPersistentOwner)(canonicalInput, priorEpoch);
          }
        );
        if (ownerReady === null || ownerReady === false) {
        }
      } else if (admission.kind === "created") {
        void dispatch(canonicalInput).catch(() => {
        });
      }
      const deadline = Date.now() + normalized.timeoutMs;
      while (Date.now() < deadline) {
        const outcome = readRecoveryOutcome(normalized.cwd, outcomeRequestId);
        const finalState = readRecoveryFinalState(normalized.cwd, outcomeRequestId);
        if (finalState.kind === "invalid") throw new Error("invalid_persisted_state");
        if (isMatchingRecoveryFinal(outcome, {
          requestId: outcomeRequestId,
          recoveryId: canonical.recovery_id,
          teamName: normalized.teamName,
          workerName: normalized.workerName
        })) return outcome.result;
        await new Promise((resolve7) => setTimeout(resolve7, timing.pollIntervalMs ?? 250));
      }
      return timeoutResult(normalized, canonical.recovery_id);
    }
  };
}
function setRuntimeOwnerDispatch(dispatch) {
  installedRecoveryOwnerDispatch = dispatch;
}
async function requestRuntimeOwnerRecovery(input) {
  const dispatch = installedRecoveryOwnerDispatch ?? (async (ownerInput) => {
    const reservation = readRecoveryRequestReservation(ownerInput.cwd, ownerInput.requestId);
    return timeoutResult(ownerInput, reservation?.recovery_id ?? "");
  });
  return createRecoveryOwnerClient(dispatch, { persistentOwnerBootstrap: !installedRecoveryOwnerDispatch }).recoverDeadWorker(input);
}
var MIN_RECOVERY_TIMEOUT_MS, MAX_RECOVERY_TIMEOUT_MS, recoveryOwnerBootstrapTestHooks, installedRecoveryOwnerDispatch;
var init_runtime_owner_client = __esm({
  "src/team/runtime-owner-client.ts"() {
    "use strict";
    init_recovery_request_store();
    init_state_paths();
    init_team_owner_epoch();
    init_process_identity_lock();
    init_monitor();
    MIN_RECOVERY_TIMEOUT_MS = 18e4;
    MAX_RECOVERY_TIMEOUT_MS = 3e5;
    recoveryOwnerBootstrapTestHooks = {
      publishCandidate: publishRecoveryOwnerBootstrapCandidate,
      hasLiveOrUnknownCandidate: hasLiveOrUnknownBootstrapCandidate
    };
  }
});

// src/team/recovery-saga.ts
import { createHash as createHash9 } from "node:crypto";
function failure(input, error, message, reservationsWritten = false) {
  return {
    outcome: "failed",
    committed: false,
    error,
    message,
    ...reservationsWritten ? { reservationsWritten: true } : {},
    requestId: input.requestId,
    recoveryId: input.recoveryId,
    teamName: input.teamName,
    workerName: input.workerName,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
async function runRecoverySaga(input, deps) {
  const persistPhase = (value, continuation, adoption, services2 = "not_started") => {
    writeRecoveryPhase(deps.cwd, { schema_version: 1, kind: "phase", request_id: input.requestId, recovery_id: input.recoveryId, team_name: input.teamName, worker_name: input.workerName, phase: value, continuation, adoption, services: services2, manifest: "not_started", updated_at: (/* @__PURE__ */ new Date()).toISOString() });
  };
  const finalize = (result2, _continuation, _adoption, _services = "terminal_degraded") => result2;
  const liveness = await deps.getLiveness(input.teamName, input.workerName);
  if (liveness === "unknown") return finalize(failure(input, "worker_liveness_unknown"), "none", "not_started");
  if (liveness === "alive") {
    if (!input.originalPaneId?.trim()) return finalize(failure(input, "worker_liveness_unknown"), "none", "not_started");
    return finalize({ outcome: "already_running", committed: true, oldPaneId: null, newPaneId: input.originalPaneId, requeuedTaskIds: [], continuationSequenceByTask: {}, stateRevision: 0, activation: "active", manifestSync: "synced", servicesSync: "synced", warnings: [], requestId: input.requestId, recoveryId: input.recoveryId, teamName: input.teamName, workerName: input.workerName, updatedAt: (/* @__PURE__ */ new Date()).toISOString() }, "none", "not_started", "synced");
  }
  if (!input.originalPaneId?.trim()) return finalize(failure(input, "worker_liveness_unknown"), "none", "not_started");
  const tasks = await deps.listOwnedInProgressTasks(input.teamName, input.workerName);
  if (tasks.length === 0) persistPhase("reserved", "none", "not_started");
  const checks = await Promise.all(tasks.map((task) => deps.validateCheckpoint(input.teamName, task)));
  const rejected = checks.find((check) => !check.ok);
  if (rejected) return finalize(failure(input, rejected.error), "selected", "not_started");
  persistPhase("reserved", tasks.length ? "selected" : "none", "not_started");
  const adoptionTokenHash = createHash9("sha256").update(input.adoptionToken).digest("hex");
  const sequences = {};
  for (const task of tasks) {
    const result2 = await deps.requeue(input, task.id, adoptionTokenHash);
    if (!result2.ok) return finalize(failure(input, result2.error, void 0, Object.keys(sequences).length > 0), "reserved", "not_started");
    sequences[task.id] = result2.sequence;
    try {
      persistPhase("requeued", "reserved", "not_started");
    } catch (error) {
      return finalize(failure(input, "invalid_persisted_state", error instanceof Error ? error.message : String(error), true), "reserved", "not_started");
    }
  }
  const pane = await deps.spawnGatedPane(input);
  if (!pane.ok) return finalize(failure(input, pane.error), tasks.length ? "reserved" : "none", "not_started");
  if (!pane.paneId.trim()) return finalize(failure(input, "spawn_failed"), tasks.length ? "reserved" : "none", "not_started");
  let persisted;
  if (pane.committed) {
    persisted = { stateRevision: pane.stateRevision ?? 0, manifestSync: pane.manifestSync ?? "repair_required" };
  } else {
    try {
      persisted = await deps.persistActive(input, pane.paneId);
    } catch (error) {
      await deps.killAttemptPane(pane.paneAttemptId);
      return finalize(failure(input, "config_commit_failed", error instanceof Error ? error.message : String(error)), tasks.length ? "reserved" : "none", "not_started");
    }
  }
  if (persisted.manifestSync !== "synced") {
    return finalize({ ...failure(input, "config_commit_failed", "Replacement config committed but manifest projection requires repair."), outcome: "commit_unknown" }, tasks.length ? "reserved" : "none", tasks.length ? "pending" : "not_started");
  }
  const activated = await deps.activatePane(input, pane.paneAttemptId);
  if (!activated.ok) {
    return finalize({ ...failure(input, activated.error), outcome: "commit_unknown", message: "Replacement was committed but activation remains pending." }, tasks.length ? "reserved" : "none", tasks.length ? "pending" : "not_started");
  }
  persistPhase("ready", tasks.length ? "reserved" : "none", tasks.length ? "pending" : "not_started");
  let continuations = [];
  if (tasks.length) {
    const adopted = await deps.adoptAll(input, { recoveryId: input.recoveryId, requestId: input.requestId, replacementGeneration: input.replacementGeneration, adoptionToken: input.adoptionToken }, tasks.map((task) => task.id));
    if (!adopted.ok) {
      return finalize({ ...failure(input, adopted.error), outcome: "commit_unknown", message: "Replacement was committed but continuation adoption remains pending." }, "reserved", "pending");
    }
    continuations = adopted.continuations;
    persistPhase("adopted", "adopted", "adopted");
  }
  const services = await deps.repairServices(input);
  if (services === "synced") {
    await deps.writeRun(input, pane.paneAttemptId, continuations);
  } else {
    persistPhase("services_pending", tasks.length ? "adopted" : "none", tasks.length ? "adopted" : "not_started", "repair_required");
  }
  const result = { outcome: "recovered", committed: true, oldPaneId: input.originalPaneId, newPaneId: pane.paneId, requeuedTaskIds: tasks.map((task) => task.id), continuationSequenceByTask: sequences, stateRevision: persisted.stateRevision, activation: services === "synced" ? "active" : "services_pending", manifestSync: persisted.manifestSync, servicesSync: services, warnings: services === "synced" ? [] : ["services_pending"], requestId: input.requestId, recoveryId: input.recoveryId, teamName: input.teamName, workerName: input.workerName, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
  return finalize(result, tasks.length ? "adopted" : "none", tasks.length ? "adopted" : "not_started", services);
}
var init_recovery_saga = __esm({
  "src/team/recovery-saga.ts"() {
    "use strict";
    init_recovery_request_store();
  }
});

// src/team/worker-activation-gate.ts
import { mkdir as mkdir12, readFile as readFile12, rename as rename4, writeFile as writeFile7 } from "node:fs/promises";
async function waitForRecoveryGateRecord(path4, expected, timeoutMs, pollIntervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile12(path4, "utf8"));
      if (value.recovery_id === expected.recovery_id && value.worker_name === expected.worker_name && value.replacement_generation === expected.replacement_generation && value.pane_attempt_id === expected.pane_attempt_id) return true;
    } catch {
    }
    await new Promise((resolve7) => setTimeout(resolve7, pollIntervalMs));
  }
  return false;
}
var init_worker_activation_gate = __esm({
  "src/team/worker-activation-gate.ts"() {
    "use strict";
  }
});

// src/team/runtime-v2.ts
var runtime_v2_exports = {};
__export(runtime_v2_exports, {
  CircuitBreakerV2: () => CircuitBreakerV2,
  executeRecoverDeadWorkerV2Owner: () => executeRecoverDeadWorkerV2Owner,
  finalizeRecoveryOwnerResult: () => finalizeRecoveryOwnerResult,
  findActiveTeamsV2: () => findActiveTeamsV2,
  isRuntimeV2Enabled: () => isRuntimeV2Enabled,
  monitorTeamV2: () => monitorTeamV2,
  prepareRecoveryOwnerBootstrap: () => prepareRecoveryOwnerBootstrap,
  processCliWorkerVerdicts: () => processCliWorkerVerdicts,
  readRecoverDeadWorkerV2Outcome: () => readRecoverDeadWorkerV2Outcome,
  readRecoverDeadWorkerV2Result: () => readRecoverDeadWorkerV2Result,
  reconcileCommittedTeamServices: () => reconcileCommittedTeamServices,
  recoverDeadWorkerV2: () => recoverDeadWorkerV2,
  requeueDeadWorkerTasks: () => requeueDeadWorkerTasks,
  resolveCommittedRecoveryManifestSync: () => resolveCommittedRecoveryManifestSync,
  resolveCommittedRecoveryPaneAttempt: () => resolveCommittedRecoveryPaneAttempt,
  resolveTaskAssignment: () => resolveTaskAssignment,
  resumeTeamV2: () => resumeTeamV2,
  selectRecoveryReplayTasks: () => selectRecoveryReplayTasks,
  setRuntimeOwnerRecoveryClient: () => setRuntimeOwnerRecoveryClient,
  shutdownTeamV2: () => shutdownTeamV2,
  startTeamV2: () => startTeamV2,
  writeWatchdogFailedMarker: () => writeWatchdogFailedMarker
});
import { join as join28, resolve as resolve6 } from "path";
import { existsSync as existsSync24 } from "fs";
import { link as link3, mkdir as mkdir13, open as open4, readdir as readdir3, readFile as readFile13, rm as rm4, unlink as unlink5, writeFile as writeFile8 } from "fs/promises";
import { performance } from "perf_hooks";
import { execFileSync as execFileSync8 } from "node:child_process";
import { createHash as createHash10, randomUUID as randomUUID10 } from "node:crypto";
function setRuntimeOwnerRecoveryClient(client) {
  runtimeOwnerRecoveryClient = client;
}
function hasRequiredRecoveryPaneIdentities(result) {
  if (result.outcome !== "recovered" && result.outcome !== "already_running") return true;
  return Boolean(result.newPaneId.trim()) && (result.outcome !== "recovered" || Boolean(result.oldPaneId?.trim()));
}
async function recoverDeadWorkerV2(teamName, cwd, { workerName, requestId = randomUUID10(), timeoutMs = 18e4 }) {
  try {
    validateTeamName(teamName);
  } catch {
    return {
      outcome: "failed",
      committed: false,
      error: "invalid_input",
      requestId,
      recoveryId: "",
      teamName,
      workerName,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      message: "teamName is invalid."
    };
  }
  if (!cwd || !WORKER_NAME_SAFE_PATTERN.test(workerName) || !isSafeRecoveryRequestId(requestId) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 18e4 || timeoutMs > 3e5) {
    return {
      outcome: "failed",
      committed: false,
      error: "invalid_input",
      requestId,
      recoveryId: "",
      teamName,
      workerName,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      message: "cwd, workerName, and requestId are required; timeoutMs must be an integer from 180000 through 300000."
    };
  }
  const client = runtimeOwnerRecoveryClient ?? {
    requestRuntimeOwnerRecovery: (input) => Promise.resolve().then(() => (init_runtime_owner_client(), runtime_owner_client_exports)).then((module) => module.requestRuntimeOwnerRecovery(input))
  };
  const result = await client.requestRuntimeOwnerRecovery({ requestId, cwd, teamName, workerName, timeoutMs });
  if (hasRequiredRecoveryPaneIdentities(result)) return result;
  return {
    outcome: "failed",
    committed: false,
    error: "invalid_persisted_state",
    requestId: result.requestId,
    recoveryId: result.recoveryId,
    teamName: result.teamName,
    workerName: result.workerName,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    message: "Recovery success result omitted a required actual pane identity."
  };
}
async function readRecoverDeadWorkerV2Result(requestId, cwd = process.cwd()) {
  const result = readRecoveryResult(cwd, requestId);
  return !result || hasRequiredRecoveryPaneIdentities(result) ? result : null;
}
function readRecoverDeadWorkerV2Outcome(cwd, requestId) {
  return readRecoveryOutcome(cwd, requestId);
}
function isCursorExecutorContextTask(task) {
  const text = `${task.subject} ${task.description}`.trim();
  if (!text || CURSOR_UNSUPPORTED_REVIEW_INTENT_RE.test(text)) return false;
  if (!CURSOR_EXECUTOR_CONTEXT_RE.test(text)) return false;
  return CURSOR_EXECUTOR_CONTEXT_INTENTS.has(inferLaneIntent(text));
}
function registerTeamOrchestrator(teamName, handle, service) {
  orchestratorByTeam.set(teamName, { handle, ...service, registeredWorkers: /* @__PURE__ */ new Set() });
}
function getTeamOrchestrator(teamName) {
  return orchestratorByTeam.get(teamName)?.handle;
}
function unregisterTeamOrchestrator(teamName) {
  orchestratorByTeam.delete(teamName);
}
function registerTeamCadence(teamName, context, poller) {
  const entry = cadenceByTeam.get(teamName) ?? { entries: [] };
  entry.entries.push({ workerName: context.workerName, context, poller });
  cadenceByTeam.set(teamName, entry);
}
async function stopTeamCadence(teamName, strict = false) {
  const entry = cadenceByTeam.get(teamName);
  if (!entry) return;
  cadenceByTeam.delete(teamName);
  const failedEntries = [];
  for (const cadence of entry.entries) {
    let poller = cadence.poller;
    let context = cadence.context;
    if (poller) {
      try {
        poller.stop();
        poller = void 0;
      } catch {
      }
    }
    if (context) {
      try {
        await uninstallCommitCadence(context);
        context = void 0;
      } catch {
      }
    }
    if (poller || context) failedEntries.push({ workerName: cadence.workerName, poller, context });
  }
  if (failedEntries.length > 0) {
    cadenceByTeam.set(teamName, { entries: failedEntries });
    if (strict) throw new Error("service_teardown_incomplete");
  }
}
function cadenceContextMatches(candidate, expected) {
  const known = candidate.context;
  if (!known) return false;
  return candidate.workerName === expected.workerName && known.teamName === expected.teamName && known.worktreePath === expected.worktreePath && known.agentType === expected.agentType && known.serviceGeneration === expected.serviceGeneration && known.attemptId === expected.attemptId;
}
async function removeStaleTeamCadence(teamName, expectedContexts) {
  const entry = cadenceByTeam.get(teamName);
  if (!entry) return true;
  const retained = [];
  const matched = /* @__PURE__ */ new Set();
  let converged = true;
  for (const cadence of entry.entries) {
    const expected = expectedContexts.find((context2) => context2.workerName === cadence.workerName);
    const isExpected = expected && !matched.has(expected.workerName) && cadenceContextMatches(cadence, expected);
    if (isExpected) {
      matched.add(expected.workerName);
      retained.push(cadence);
      continue;
    }
    let poller = cadence.poller;
    let context = cadence.context;
    if (poller) {
      try {
        poller.stop();
        poller = void 0;
      } catch {
        converged = false;
      }
    }
    if (context) {
      try {
        await uninstallCommitCadence(context);
        context = void 0;
      } catch {
        converged = false;
      }
    }
    if (poller || context) retained.push({ workerName: cadence.workerName, poller, context });
  }
  if (retained.length > 0) cadenceByTeam.set(teamName, { entries: retained });
  else cadenceByTeam.delete(teamName);
  return converged;
}
async function reconcileCommittedTeamServices(config, cwd) {
  const scaleUp = config.active_scale_up;
  if (scaleUp) return "repair_required";
  const descriptor = config.service_descriptor;
  if (!descriptor || descriptor.schema_version !== 1 || !Number.isSafeInteger(descriptor.service_generation) || descriptor.service_generation < 1 || !descriptor.service_attempt_id || !descriptor.workspace_root) return "repair_required";
  if (!descriptor.auto_merge_enabled) {
    if (descriptor.cadence_policy !== "disabled") return "repair_required";
    const localService = orchestratorByTeam.get(config.name);
    try {
      if (localService) await localService.handle.drainAndStop();
      await stopTeamCadence(config.name, true);
      unregisterTeamOrchestrator(config.name);
      return "synced";
    } catch {
      return "repair_required";
    }
  }
  if (descriptor.cadence_policy !== "worker-auto-commit-v1" || !descriptor.leader_branch || config.worktree_mode !== "named") return "repair_required";
  try {
    for (const worker of config.workers) {
      const launch = validateWorkerLaunchDescriptor(worker.launch_descriptor);
      if (worker.worker_cli !== launch.provider || !worker.worktree_path) return "repair_required";
    }
    const localService = orchestratorByTeam.get(config.name);
    if (localService && (localService.serviceGeneration !== descriptor.service_generation || localService.serviceAttemptId !== descriptor.service_attempt_id)) {
      await localService.handle.drainAndStop();
      await stopTeamCadence(config.name, true);
      unregisterTeamOrchestrator(config.name);
    }
    let orchestrator = getTeamOrchestrator(config.name);
    if (!orchestrator) {
      orchestrator = await startMergeOrchestrator({
        teamName: config.name,
        repoRoot: descriptor.workspace_root,
        leaderBranch: descriptor.leader_branch,
        cwd,
        serviceGeneration: descriptor.service_generation,
        serviceAttemptId: descriptor.service_attempt_id
      });
      registerTeamOrchestrator(config.name, orchestrator, {
        serviceGeneration: descriptor.service_generation,
        serviceAttemptId: descriptor.service_attempt_id
      });
    }
    const local = orchestratorByTeam.get(config.name);
    if (!local) return "repair_required";
    const expectedContexts = config.workers.map((worker) => {
      const launch = validateWorkerLaunchDescriptor(worker.launch_descriptor);
      return {
        teamName: config.name,
        workerName: worker.name,
        worktreePath: worker.worktree_path,
        agentType: launch.provider,
        enabled: true,
        serviceGeneration: descriptor.service_generation,
        attemptId: descriptor.service_attempt_id
      };
    });
    const expectedWorkers = new Set(config.workers.map((worker) => worker.name));
    let staleOrchestratorRemovalFailed = false;
    for (const workerName of [...local.registeredWorkers]) {
      if (expectedWorkers.has(workerName)) continue;
      try {
        await orchestrator.unregisterWorker(workerName);
        local.registeredWorkers.delete(workerName);
      } catch {
        staleOrchestratorRemovalFailed = true;
      }
    }
    const cadenceRemovalsConverged = await removeStaleTeamCadence(config.name, expectedContexts);
    for (const worker of config.workers) {
      if (!local.registeredWorkers.has(worker.name)) {
        await orchestrator.registerWorker(worker.name);
        local.registeredWorkers.add(worker.name);
      }
    }
    const cadence = cadenceByTeam.get(config.name);
    for (const context of expectedContexts) {
      const installed = cadence?.entries.some((candidate) => cadenceContextMatches(candidate, context));
      if (installed) continue;
      const installedCadence = await installCommitCadence(context);
      registerTeamCadence(
        config.name,
        context,
        installedCadence.method === "fallback-poll" ? startFallbackPoller(context.worktreePath, context.workerName) : void 0
      );
    }
    const finalCadence = cadenceByTeam.get(config.name);
    const exactCadence = (finalCadence?.entries.length ?? 0) === expectedContexts.length && expectedContexts.every((context) => finalCadence?.entries.some((candidate) => cadenceContextMatches(candidate, context)));
    return cadenceRemovalsConverged && !staleOrchestratorRemovalFailed && exactCadence && local.registeredWorkers.size === expectedWorkers.size && [...expectedWorkers].every((workerName) => local.registeredWorkers.has(workerName)) ? "synced" : "repair_required";
  } catch {
    return "repair_required";
  }
}
function resolveLeaderBranch(cwd) {
  const out = execFileSync8("git", ["branch", "--show-current"], {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  }).trim();
  if (!out) {
    throw new Error("auto-merge requires a non-detached leader branch (git branch --show-current returned empty)");
  }
  return out;
}
function resolveTaskAssignment(task, resolvedRouting, roleRoutingConfig, resolvedBinaryPaths, fallbackAgent) {
  const canonicalRoles = new Set(CANONICAL_TEAM_ROLES);
  const hasExplicitRole = typeof task.role === "string" && task.role.length > 0;
  const rawRole = hasExplicitRole ? task.role : routeTaskToRole(task.subject, task.description, "executor").role;
  const normalized = normalizeDelegationRole(rawRole);
  const canonical = canonicalRoles.has(normalized) ? normalized : null;
  if (!canonical) {
    return { agentType: fallbackAgent, model: "", role: null };
  }
  const hasConfigForRole = !!getRoleRoutingSpec(
    roleRoutingConfig,
    canonical
  );
  if (fallbackAgent === "cursor") {
    if (CURSOR_EXECUTOR_TEAM_ROLES.includes(canonical)) {
      return { agentType: fallbackAgent, model: "", role: canonical };
    }
    if (!hasExplicitRole && !hasConfigForRole && isCursorExecutorContextTask(task)) {
      return { agentType: fallbackAgent, model: "", role: "executor" };
    }
  }
  if (!hasExplicitRole && !hasConfigForRole) {
    if (fallbackAgent === "cursor" && !CURSOR_EXECUTOR_TEAM_ROLES.includes(canonical)) {
      throw new Error(
        `Cursor workers are executor-style only; inferred role "${canonical}" for task "${task.subject}" must run on a native Claude/OMC reviewer agent or another supported CLI worker.`
      );
    }
    return { agentType: fallbackAgent, model: "", role: canonical };
  }
  if (hasExplicitRole && !hasConfigForRole && fallbackAgent !== "claude") {
    return { agentType: fallbackAgent, model: "", role: canonical };
  }
  const pair = resolvedRouting[canonical];
  if (!pair) {
    return { agentType: fallbackAgent, model: "", role: canonical };
  }
  const primaryProvider = pair.primary.provider;
  const chosen = resolvedBinaryPaths[primaryProvider] ? pair.primary : pair.fallback;
  return {
    agentType: chosen.provider,
    model: chosen.model,
    role: canonical
  };
}
function sanitizeTeamName(name) {
  const sanitized = name.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 30);
  if (!sanitized) throw new Error(`Invalid team name: "${name}" produces empty slug after sanitization`);
  return sanitized;
}
function shouldUseLaunchTimeCliResolution(reason) {
  return /untrusted location|relative path/i.test(reason);
}
function resolvePreflightBinaryPath(agentType) {
  assertHeadlessSupported(agentType);
  try {
    return { path: resolveValidatedBinaryPath(agentType), degraded: false };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (shouldUseLaunchTimeCliResolution(reason)) {
      return { path: getContract(agentType).binary, degraded: true, reason };
    }
    throw err;
  }
}
async function getWorkerPaneLiveness(paneId) {
  if (!paneId) return "unknown";
  return getWorkerLiveness(paneId);
}
async function captureWorkerPane(paneId) {
  if (!paneId) return "";
  return captureTeamPane(paneId);
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
function getTaskDependencyIds(task) {
  return task.depends_on ?? task.blocked_by ?? [];
}
function getMissingDependencyIds(task, taskById) {
  return getTaskDependencyIds(task).filter((dependencyId) => !taskById.has(dependencyId));
}
function buildV2TaskInstruction(teamName, workerName, task, taskId, cliOutputContract) {
  const claimTaskCommand = formatOmcCliInvocation(
    `team api claim-task --input '${JSON.stringify({ team_name: teamName, task_id: taskId, worker: workerName })}' --json`,
    {}
  );
  const completeTaskCommand = formatOmcCliInvocation(
    `team api transition-task-status --input '${JSON.stringify({ team_name: teamName, task_id: taskId, from: "in_progress", to: "completed", claim_token: "<claim_token>", result: "Summary: <what changed>\\nVerification: <tests/checks run>\\nSubagent skip reason: worker protocol forbids nested subagents; completed focused probe in-session" })}' --json`
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
    `   The result field is required for completion evidence. For broad delegated tasks, include either "Subagent skip reason: <why no nested worker was needed/allowed>" or, only when explicitly allowed by the leader, "Subagent spawn evidence: <child task names/thread ids and integrated findings>".`,
    `4. On failure (use claim_token from step 1):`,
    `   ${failTaskCommand}`,
    `5. ACK/progress replies are not a stop signal. Keep executing your assigned or next feasible work until the task is actually complete or failed, then transition and exit.`,
    ``,
    `## Task Assignment`,
    `Task ID: ${taskId}`,
    `Worker: ${workerName}`,
    `Subject: ${task.subject}`,
    ``,
    task.description,
    ``,
    `REMINDER: You MUST run transition-task-status before exiting. Do NOT write done.json or edit task files directly.`,
    ...cliOutputContract ? [cliOutputContract] : []
  ].join("\n");
}
async function notifyStartupInbox(sessionName2, paneId, message) {
  const notified = await notifyPaneWithRetry(sessionName2, paneId, message, 1);
  return notified ? { ok: true, transport: "tmux_send_keys", reason: "worker_pane_notified" } : { ok: false, transport: "tmux_send_keys", reason: "worker_notify_failed" };
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
function hasWorkerStatusProgress(status, taskId) {
  if (status.current_task_id === taskId) return true;
  return ["working", "blocked", "done", "failed"].includes(status.state);
}
async function hasWorkerTaskClaimEvidence(teamName, workerName, cwd, taskId) {
  try {
    const raw = await readFile13(absPath(cwd, TeamPaths.taskFile(teamName, taskId)), "utf-8");
    const task = JSON.parse(raw);
    return task.owner === workerName && ["in_progress", "completed", "failed"].includes(task.status);
  } catch {
    return false;
  }
}
async function hasWorkerStartupEvidence(teamName, workerName, taskId, cwd) {
  const [hasClaimEvidence, status] = await Promise.all([
    hasWorkerTaskClaimEvidence(teamName, workerName, cwd, taskId),
    readWorkerStatus(teamName, workerName, cwd)
  ]);
  return hasClaimEvidence || hasWorkerStatusProgress(status, taskId);
}
async function waitForWorkerStartupEvidence(teamName, workerName, taskId, cwd, attempts = 3, delayMs = 250) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (await hasWorkerStartupEvidence(teamName, workerName, taskId, cwd)) {
      return true;
    }
    if (attempt < attempts) {
      await new Promise((resolve7) => setTimeout(resolve7, delayMs));
    }
  }
  return false;
}
async function spawnV2Worker(opts) {
  const splitTarget = opts.existingWorkerPaneIds.length === 0 ? opts.leaderPaneId : opts.existingWorkerPaneIds[opts.existingWorkerPaneIds.length - 1];
  const splitDirection = opts.existingWorkerPaneIds.length === 0 ? "right" : "down";
  const paneId = await splitTeamWorkerPane(splitTarget, splitDirection, opts.workerCwd ?? opts.cwd);
  if (!paneId) {
    return { paneId: null, startupAssigned: false, startupFailureReason: "pane_id_missing" };
  }
  const usePromptMode = isPromptModeAgent(opts.agentType);
  const injectContract = shouldInjectContract(opts.role ?? null, opts.agentType);
  const outputFile = injectContract && opts.role ? cliWorkerOutputFilePath(teamStateRoot(opts.cwd, opts.teamName), opts.workerName) : void 0;
  const cliOutputContract = injectContract && opts.role && outputFile ? renderCliWorkerOutputContract(opts.role, outputFile) : void 0;
  const instruction = buildV2TaskInstruction(
    opts.teamName,
    opts.workerName,
    opts.task,
    opts.taskId,
    cliOutputContract
  );
  const instructionStateRoot = opts.worktreePath ? "$OMC_TEAM_STATE_ROOT" : void 0;
  const inboxTriggerMessage = generateTriggerMessage(opts.teamName, opts.workerName, instructionStateRoot);
  if (usePromptMode) {
    await composeInitialInbox(
      opts.teamName,
      opts.workerName,
      instruction,
      opts.cwd,
      cliOutputContract
    );
  }
  const envVars = {
    ...getWorkerEnv(opts.teamName, opts.workerName, opts.agentType),
    OMC_TEAM_STATE_ROOT: teamStateRoot(opts.cwd, opts.teamName),
    OMC_TEAM_LEADER_CWD: opts.cwd,
    ...opts.worktreePath ? { OMC_TEAM_WORKTREE_PATH: opts.worktreePath } : {},
    ...opts.workerCwd ? { OMC_TEAM_WORKER_CWD: opts.workerCwd } : {}
  };
  const launchDescriptor = opts.launchDescriptor;
  if (opts.autoMerge && opts.worktreePath) {
    const cadenceContext = {
      teamName: opts.teamName,
      workerName: opts.workerName,
      worktreePath: opts.worktreePath,
      agentType: opts.agentType,
      enabled: true
    };
    const cadence = await installCommitCadence(cadenceContext);
    const poller = cadence.method === "fallback-poll" ? startFallbackPoller(opts.worktreePath, opts.workerName) : void 0;
    registerTeamCadence(opts.teamName, cadenceContext, poller);
  }
  const paneConfig = {
    teamName: opts.teamName,
    workerName: opts.workerName,
    envVars,
    launchBinary: launchDescriptor.binary,
    launchArgs: [...launchDescriptor.args],
    cwd: opts.workerCwd ?? opts.cwd
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
    fallbackAllowed: DEFAULT_TEAM_TRANSPORT_POLICY.dispatch_mode === "hook_preferred_with_fallback",
    inboxCorrelationKey: `startup:${opts.workerName}:${opts.taskId}`,
    notify: async (_target, triggerMessage) => {
      if (usePromptMode) {
        return { ok: true, transport: "prompt_stdin", reason: "prompt_mode_launch_args" };
      }
      if (opts.agentType === "gemini") {
        const confirmed = await notifyPaneWithRetry(opts.sessionName, paneId, "1");
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
    let settled = await waitForWorkerStartupEvidence(
      opts.teamName,
      opts.workerName,
      opts.taskId,
      opts.cwd,
      6
    );
    for (let attempt = 1; !settled && attempt <= 4; attempt++) {
      try {
        await sendTeamPaneKey(paneId, "Enter");
      } catch {
        break;
      }
      settled = await waitForWorkerStartupEvidence(
        opts.teamName,
        opts.workerName,
        opts.taskId,
        opts.cwd,
        12
      );
    }
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
    startupAssigned: true,
    ...outputFile ? { outputFile } : {}
  };
}
function validateRecoveryAttemptSecret(value, input, recoveryId, replacementGeneration) {
  const secret = value;
  if (secret?.schema_version !== 1 || secret.request_id !== input.requestId || secret.recovery_id !== recoveryId || secret.worker_name !== input.workerName || secret.replacement_generation !== replacementGeneration || typeof secret.adoption_token !== "string" || secret.adoption_token.length === 0 || typeof secret.created_at !== "string" || !Number.isFinite(Date.parse(secret.created_at))) {
    throw new Error("invalid_persisted_state");
  }
  return secret;
}
async function recordRecoveryPaneRollbackFailure(input, recoveryId, pending, reason, liveness) {
  const recordedAt = Date.now();
  const path4 = absPath(input.cwd, TeamPaths.recoveryPaneRollbackFailure(input.teamName, recoveryId, pending.paneAttemptId, recordedAt));
  const candidate = `${path4}.candidate.${process.pid}.${randomUUID10()}`;
  await mkdir13(join28(path4, ".."), { recursive: true });
  const handle = await open4(candidate, "wx", 384);
  try {
    await handle.writeFile(JSON.stringify({
      schema_version: 1,
      team_name: input.teamName,
      worker_name: input.workerName,
      request_id: input.requestId,
      recovery_id: recoveryId,
      pane_id: pending.paneId,
      pane_attempt_id: pending.paneAttemptId,
      reason,
      liveness,
      recorded_at: new Date(recordedAt).toISOString()
    }, null, 2), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link3(candidate, path4);
  } finally {
    await unlink5(candidate).catch(() => void 0);
  }
  return path4;
}
async function recordUnaddressableRecoveryPaneFailure(input, recoveryId, paneAttemptId, reason, split) {
  const recordedAt = Date.now();
  const path4 = absPath(input.cwd, TeamPaths.recoveryPaneRollbackFailure(input.teamName, recoveryId, paneAttemptId, recordedAt));
  const candidate = `${path4}.candidate.${process.pid}.${randomUUID10()}`;
  await mkdir13(join28(path4, ".."), { recursive: true });
  const handle = await open4(candidate, "wx", 384);
  try {
    await handle.writeFile(JSON.stringify({
      schema_version: 1,
      team_name: input.teamName,
      worker_name: input.workerName,
      request_id: input.requestId,
      recovery_id: recoveryId,
      pane_id: null,
      pane_attempt_id: paneAttemptId,
      reason,
      liveness: "unknown",
      unaddressable: true,
      split,
      recorded_at: new Date(recordedAt).toISOString()
    }, null, 2), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link3(candidate, path4);
  } finally {
    await unlink5(candidate).catch(() => void 0);
  }
  return path4;
}
async function cleanupRecoveryPaneAttempt(input, recoveryId, pending, reason) {
  const { killTeamPane: killTeamPane2 } = await Promise.resolve().then(() => (init_tmux_session(), tmux_session_exports));
  let liveness = "unknown";
  for (let attempt = 0; attempt < 2; attempt++) {
    await killTeamPane2(pending.paneId).catch(() => void 0);
    liveness = await getWorkerLiveness(pending.paneId).catch(() => "unknown");
    if (liveness === "dead") {
      pendingRecoveryPanes.delete(recoveryId);
      return true;
    }
  }
  await recordRecoveryPaneRollbackFailure(input, recoveryId, pending, reason, liveness);
  return false;
}
function buildRecoveryPaneContext(input, sagaInput, config, worker, descriptor, paneId, paneAttemptId) {
  const agentType = descriptor.provider;
  const workerCwd = worker.working_dir ?? input.cwd;
  const promptMode = isPromptModeAgent(agentType);
  const providerEnv = {
    ...getWorkerEnv(input.teamName, sagaInput.workerName, agentType),
    OMC_TEAM_STATE_ROOT: teamStateRoot(input.cwd, input.teamName),
    OMC_TEAM_LEADER_CWD: input.cwd,
    ...worker.worktree_path ? { OMC_TEAM_WORKTREE_PATH: worker.worktree_path } : {}
  };
  const gate = {
    recoveryId: sagaInput.recoveryId,
    workerName: sagaInput.workerName,
    replacementGeneration: sagaInput.replacementGeneration,
    paneAttemptId,
    readyPath: absPath(input.cwd, TeamPaths.recoveryReady(input.teamName, sagaInput.recoveryId, paneAttemptId)),
    activatePath: absPath(input.cwd, TeamPaths.recoveryActivate(input.teamName, sagaInput.recoveryId, paneAttemptId)),
    runPath: absPath(input.cwd, TeamPaths.recoveryRun(input.teamName, sagaInput.recoveryId, paneAttemptId)),
    providerArgv: [descriptor.binary, ...descriptor.args],
    cwd: workerCwd,
    env: providerEnv,
    timeoutMs: 3e5
  };
  return { paneId, paneAttemptId, sessionName: config.tmux_session, config, worker, agentType, gate, promptMode };
}
function recoveryError(input, recoveryId, error, message) {
  return {
    outcome: "failed",
    committed: false,
    error,
    message,
    requestId: input.requestId,
    recoveryId,
    teamName: input.teamName,
    workerName: input.workerName,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function persistRecoveryFinal(input, recoveryId, result) {
  if (result.requestId !== input.requestId || result.recoveryId !== recoveryId || result.teamName !== input.teamName || result.workerName !== input.workerName) {
    throw new Error("invalid_persisted_state");
  }
  const existingFinalState = readRecoveryFinalState(input.cwd, input.requestId);
  if (existingFinalState.kind === "invalid") throw new Error("invalid_persisted_state");
  const existing = readRecoveryOutcome(input.cwd, input.requestId);
  if (isMatchingRecoveryFinal(existing, {
    requestId: input.requestId,
    recoveryId,
    teamName: input.teamName,
    workerName: input.workerName
  })) return existing.result;
  const succeeded = result.outcome === "recovered" || result.outcome === "already_running";
  const failureResult = succeeded ? void 0 : result;
  writeRecoveryFinal(input.cwd, {
    schema_version: 1,
    kind: "final",
    request_id: input.requestId,
    recovery_id: recoveryId,
    team_name: input.teamName,
    worker_name: input.workerName,
    outcome: succeeded ? "succeeded" : result.outcome === "commit_unknown" ? "commit_unknown" : "failed",
    result,
    error: failureResult ? { code: failureResult.error, message: failureResult.message, commit_uncertain: failureResult.outcome === "commit_unknown" } : void 0,
    continuation: succeeded && result.requeuedTaskIds.length > 0 ? "adopted" : "none",
    adoption: succeeded && result.requeuedTaskIds.length > 0 ? "adopted" : "not_started",
    services: succeeded ? result.servicesSync : "terminal_degraded",
    manifest: succeeded ? result.manifestSync : "repair_required",
    completed_at: (/* @__PURE__ */ new Date()).toISOString(),
    expires_at: new Date(Date.now() + 7 * 864e5).toISOString()
  });
  return result;
}
async function finalizeRecoveryOwnerResult(input, recoveryId, result, deps = {
  readRevisionedConfig: readRevisionedTeamConfig,
  saveConfigAtRevision: saveTeamConfigAtRevision,
  publishFinal: persistRecoveryFinal,
  withConfigLock: withTeamConfigMutationLock
}) {
  if (!hasRequiredRecoveryPaneIdentities(result)) {
    return recoveryError(
      input,
      recoveryId,
      "invalid_persisted_state",
      "Recovery success result omitted a required actual pane identity."
    );
  }
  const durableContinuation = deps.readDurableContinuation ? deps.readDurableContinuation(input.cwd, input.requestId, recoveryId) : (() => {
    const outcome = readRecoveryOutcome(input.cwd, input.requestId);
    return outcome?.kind === "phase" && outcome.recovery_id === recoveryId ? outcome.continuation : "none";
  })();
  const transientFailure = result.outcome === "commit_unknown" || result.outcome === "recovered" && result.activation === "services_pending" || result.outcome === "failed" && durableContinuation === "reserved" || result.outcome === "failed" && result.reservationsWritten === true || result.outcome === "failed" && [
    "spawn_failed",
    "startup_ack_timeout",
    "config_commit_failed",
    "worker_activation_failed",
    "auto_merge_unavailable",
    "stale_state_revision",
    "worker_liveness_unknown",
    "runtime_owner_unavailable",
    "runtime_owner_fence_lost"
  ].includes(result.error);
  if (transientFailure) {
    const pending = await deps.readRevisionedConfig(input.teamName, input.cwd);
    if (pending?.config.active_recovery?.recovery_id === recoveryId) {
      const phase = result.outcome === "recovered" && result.activation === "services_pending" ? "services_pending" : pending.config.active_recovery.phase;
      const nextRevision = pending.stateRevision + 1;
      await deps.saveConfigAtRevision({
        ...pending.config,
        state_revision: nextRevision,
        active_recovery: {
          ...pending.config.active_recovery,
          phase,
          state_revision: nextRevision,
          updated_at: (/* @__PURE__ */ new Date()).toISOString()
        }
      }, pending.stateRevision, input.cwd);
    }
    return result;
  }
  const terminal = await deps.readRevisionedConfig(input.teamName, input.cwd);
  const active = terminal?.config.active_recovery;
  if (terminal && active?.recovery_id === recoveryId && active.request_id === input.requestId && active.worker_name === input.workerName && active.owner_epoch === terminal.config.runtime_owner_epoch?.epoch && active.owner_nonce === terminal.config.runtime_owner_epoch?.nonce) {
    const phase = result.outcome === "recovered" || result.outcome === "already_running" ? "adopted" : "failed";
    const finalRevision = terminal.stateRevision + 1;
    const finalConfig = {
      ...terminal.config,
      active_recovery: void 0,
      last_recovery: {
        ...active,
        phase,
        state_revision: finalRevision,
        updated_at: (/* @__PURE__ */ new Date()).toISOString()
      },
      state_revision: finalRevision
    };
    let published = null;
    let saved = false;
    try {
      saved = await deps.saveConfigAtRevision(finalConfig, terminal.stateRevision, input.cwd, async () => {
        const verified = await deps.readRevisionedConfig(input.teamName, input.cwd);
        const verifiedLast = verified?.config.last_recovery;
        if (verified && !verified.config.active_recovery && verifiedLast?.recovery_id === recoveryId && verifiedLast.request_id === input.requestId && verifiedLast.worker_name === input.workerName && verifiedLast.phase === phase && verifiedLast.state_revision === finalRevision && verifiedLast.owner_epoch === verified.config.runtime_owner_epoch?.epoch && verifiedLast.owner_nonce === verified.config.runtime_owner_epoch?.nonce && verified.stateRevision === finalRevision) {
          published = deps.publishFinal(input, recoveryId, result);
        }
      });
    } catch {
      saved = false;
    }
    if (!saved || !published) {
      return { ...recoveryError(
        input,
        recoveryId,
        "stale_state_revision",
        "Recovery reached a terminal state, but config cleanup could not be verified."
      ), outcome: "commit_unknown" };
    }
    return published;
  }
  const withLock2 = deps.withConfigLock ?? (async (_teamName, _cwd, fn) => fn());
  return withLock2(input.teamName, input.cwd, async () => {
    const verified = await deps.readRevisionedConfig(input.teamName, input.cwd);
    const expectedPhase = result.outcome === "recovered" || result.outcome === "already_running" ? "adopted" : "failed";
    const verifiedLast = verified?.config.last_recovery;
    if (verified && !verified.config.active_recovery && verifiedLast?.recovery_id === recoveryId && verifiedLast.request_id === input.requestId && verifiedLast.worker_name === input.workerName && verifiedLast.phase === expectedPhase && verifiedLast.state_revision === verified.stateRevision && verifiedLast.owner_epoch === verified.config.runtime_owner_epoch?.epoch && verifiedLast.owner_nonce === verified.config.runtime_owner_epoch?.nonce) {
      return deps.publishFinal(input, recoveryId, result);
    }
    return { ...recoveryError(
      input,
      recoveryId,
      "stale_state_revision",
      "Recovery terminal state is no longer the active or last revision-checked attempt."
    ), outcome: "commit_unknown" };
  });
}
async function finalizeBoundRecoveryOwnerTerminal(input, recoveryId, result) {
  try {
    const current = await readRevisionedTeamConfig(input.teamName, input.cwd);
    const active = current?.config.active_recovery;
    if (active?.request_id === input.requestId && active.recovery_id === recoveryId && active.worker_name === input.workerName) {
      return finalizeRecoveryOwnerResult(input, recoveryId, result);
    }
  } catch {
  }
  return { ...recoveryError(
    input,
    recoveryId,
    "stale_state_revision",
    "Recovery terminal cleanup could not prove the exact active attempt."
  ), outcome: "commit_unknown" };
}
function selectRecoveryReplayTasks(tasks, workerName, recoveryId, committedPaneLiveness) {
  return tasks.filter((task) => task.recovery_reservation?.recovery_id === recoveryId || task.recovery_adoption?.recovery_id === recoveryId || (committedPaneLiveness === null || committedPaneLiveness === "dead") && task.status === "in_progress" && task.owner === workerName);
}
async function resolveCommittedRecoveryManifestSync(readManifest, expected) {
  try {
    const manifest = await readManifest();
    const projected = manifest?.workers.find((candidate) => candidate.name === expected.workerName);
    return projected?.pane_id === expected.paneId && projected.pane_attempt_id === expected.paneAttemptId && projected.recovery_id === expected.recoveryId && projected.replacement_generation === expected.replacementGeneration ? "synced" : "repair_required";
  } catch {
    return "repair_required";
  }
}
function resolveCommittedRecoveryPaneAttempt(activeRecovery, recoveryId, replacementGeneration, worker) {
  return activeRecovery?.recovery_id === recoveryId && worker.recovery_id === recoveryId && worker.replacement_generation === replacementGeneration && worker.pane_id && worker.pane_attempt_id ? { paneId: worker.pane_id, paneAttemptId: worker.pane_attempt_id } : null;
}
async function readOrCreateRecoveryAttempt(input, recoveryId, replacementGeneration) {
  const path4 = absPath(input.cwd, TeamPaths.recoveryAttempt(input.teamName, recoveryId));
  try {
    return validateRecoveryAttemptSecret(JSON.parse(await readFile13(path4, "utf8")), input, recoveryId, replacementGeneration);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const secret = {
    schema_version: 1,
    request_id: input.requestId,
    recovery_id: recoveryId,
    worker_name: input.workerName,
    replacement_generation: replacementGeneration,
    adoption_token: randomUUID10(),
    created_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  await mkdir13(join28(path4, ".."), { recursive: true });
  const candidate = `${path4}.candidate.${process.pid}.${randomUUID10()}`;
  const candidateHandle = await open4(candidate, "wx", 384);
  try {
    await candidateHandle.writeFile(JSON.stringify(secret, null, 2), "utf8");
    await candidateHandle.sync();
  } finally {
    await candidateHandle.close();
  }
  try {
    await link3(candidate, path4);
    return validateRecoveryAttemptSecret(JSON.parse(await readFile13(path4, "utf8")), input, recoveryId, replacementGeneration);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return validateRecoveryAttemptSecret(JSON.parse(await readFile13(path4, "utf8")), input, recoveryId, replacementGeneration);
  } finally {
    await unlink5(candidate).catch(() => void 0);
  }
}
function waitForBootstrapRecoveryEvidence(delayMs, signal) {
  return new Promise((resolve7, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("bootstrap_recovery_evidence_aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve7();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new Error("bootstrap_recovery_evidence_aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
async function hasBootstrapRecoveryEvidence(teamName, cwd, input, waitOptions = {}) {
  const bootstrap = input.bootstrap;
  if (!bootstrap) return true;
  const reservation = readRecoveryRequestReservation(cwd, input.requestId);
  if (!reservation || reservation.kind !== "reservation" || reservation.recovery_id !== bootstrap.recoveryId || reservation.team_name !== teamName || reservation.worker_name !== input.workerName) return false;
  try {
    const intent = parseRecoveryIntent(await readFile13(absPath(cwd, TeamPaths.recoveryIntent(teamName, bootstrap.recoveryId)), "utf8"));
    if (intent.request_id !== input.requestId || intent.recovery_id !== bootstrap.recoveryId || intent.team_name !== teamName || intent.worker_name !== input.workerName) return false;
    const now = waitOptions.now ?? Date.now;
    const timeoutMs = waitOptions.timeoutMs === void 0 ? BOOTSTRAP_RECOVERY_EVIDENCE_MAX_WAIT_MS : Number.isFinite(waitOptions.timeoutMs) ? Math.min(Math.max(waitOptions.timeoutMs, 0), BOOTSTRAP_RECOVERY_EVIDENCE_MAX_WAIT_MS) : 0;
    const deadline = now() + timeoutMs;
    const sleep3 = waitOptions.sleep ?? waitForBootstrapRecoveryEvidence;
    for (let attempt = 0; attempt <= Math.ceil(timeoutMs / BOOTSTRAP_RECOVERY_EVIDENCE_POLL_MS) && !waitOptions.signal?.aborted; attempt++) {
      const candidate = await readRecoveryOwnerBootstrapCandidate(teamName, cwd, bootstrap.expectedEpoch, bootstrap.nonce);
      if (candidate && candidateMatchesBootstrap(candidate, input)) return true;
      const owner = readLatestOwnerEpoch(cwd, teamName);
      if (owner && (owner.epoch > bootstrap.expectedEpoch || owner.epoch === bootstrap.expectedEpoch && (owner.pid !== bootstrap.pid || owner.process_started_at !== bootstrap.processStartedAt || owner.nonce !== bootstrap.nonce))) return false;
      const remainingMs = deadline - now();
      if (remainingMs <= 0) return false;
      await sleep3(Math.min(BOOTSTRAP_RECOVERY_EVIDENCE_POLL_MS, remainingMs), waitOptions.signal);
    }
    return false;
  } catch {
    return false;
  }
}
function recoveryOwnerBootstrapCandidatePath2(teamName, expectedEpoch, nonce) {
  return TeamPaths.recoveryOwnerBootstrapCandidate(teamName, expectedEpoch, nonce);
}
function isCanonicalBootstrapCandidate(value, expectedEpoch) {
  const candidate = value;
  if (!candidate || candidate.schema_version !== 1 || candidate.expected_epoch !== expectedEpoch || typeof candidate.request_id !== "string" || candidate.request_id.length === 0 || typeof candidate.recovery_id !== "string" || candidate.recovery_id.length === 0 || typeof candidate.team_name !== "string" || candidate.team_name.length === 0 || typeof candidate.worker_name !== "string" || candidate.worker_name.length === 0 || typeof candidate.nonce !== "string" || candidate.nonce.length === 0 || typeof candidate.pid !== "number" || !Number.isSafeInteger(candidate.pid) || candidate.pid < 1 || typeof candidate.process_started_at !== "string" || candidate.process_started_at.length === 0 || typeof candidate.predecessor_epoch !== "number" || !Number.isSafeInteger(candidate.predecessor_epoch) || candidate.predecessor_epoch < 0 || candidate.expected_epoch !== candidate.predecessor_epoch + 1 || candidate.predecessor_epoch === 0 && (candidate.predecessor_nonce !== null || candidate.predecessor_pid !== null || candidate.predecessor_process_started_at !== null) || candidate.predecessor_epoch > 0 && (typeof candidate.predecessor_nonce !== "string" || candidate.predecessor_nonce.length === 0 || typeof candidate.predecessor_pid !== "number" || !Number.isSafeInteger(candidate.predecessor_pid) || candidate.predecessor_pid < 1 || typeof candidate.predecessor_process_started_at !== "string" || candidate.predecessor_process_started_at.length === 0) || typeof candidate.created_at !== "string" || !Number.isFinite(Date.parse(candidate.created_at)) || typeof candidate.payload_hash !== "string") return false;
  const { payload_hash, ...unsigned } = candidate;
  return createHash10("sha256").update(JSON.stringify(unsigned)).digest("hex") === payload_hash;
}
async function readRecoveryOwnerBootstrapCandidate(teamName, cwd, expectedEpoch, nonce) {
  try {
    const value = JSON.parse(await readFile13(absPath(
      cwd,
      recoveryOwnerBootstrapCandidatePath2(teamName, expectedEpoch, nonce)
    ), "utf8"));
    return isCanonicalBootstrapCandidate(value, expectedEpoch) && value.nonce === nonce ? value : null;
  } catch {
    return null;
  }
}
function candidateMatchesBootstrap(candidate, input) {
  const bootstrap = input.bootstrap;
  return !!bootstrap && candidate.request_id === input.requestId && candidate.recovery_id === bootstrap.recoveryId && candidate.team_name === input.teamName && candidate.worker_name === input.workerName && candidate.expected_epoch === bootstrap.expectedEpoch && candidate.nonce === bootstrap.nonce && candidate.pid === bootstrap.pid && candidate.process_started_at === bootstrap.processStartedAt && candidate.predecessor_epoch === bootstrap.predecessorEpoch && candidate.predecessor_nonce === bootstrap.predecessorNonce && candidate.predecessor_pid === bootstrap.predecessorPid && candidate.predecessor_process_started_at === bootstrap.predecessorProcessStartedAt;
}
async function isExactDeadOrphanBootstrapCandidate(teamName, cwd, input, config, orphan) {
  const bootstrap = input.bootstrap;
  if (!bootstrap || !orphan || !isProcessIdentityDead(orphan) || orphan.epoch !== bootstrap.predecessorEpoch || orphan.nonce !== bootstrap.predecessorNonce || orphan.pid !== bootstrap.predecessorPid || orphan.process_started_at !== bootstrap.predecessorProcessStartedAt) return false;
  let expectedEpoch = bootstrap.expectedEpoch;
  let candidateNonce = bootstrap.nonce;
  let predecessor = orphan;
  for (; ; ) {
    const candidate = await readRecoveryOwnerBootstrapCandidate(teamName, cwd, expectedEpoch, candidateNonce);
    if (!candidate) return false;
    if (expectedEpoch === bootstrap.expectedEpoch) {
      if (!candidateMatchesBootstrap(candidate, input)) return false;
    } else if (candidate.request_id !== input.requestId || candidate.recovery_id !== bootstrap.recoveryId || candidate.team_name !== teamName || candidate.worker_name !== input.workerName || candidate.nonce !== predecessor.nonce || candidate.pid !== predecessor.pid || candidate.process_started_at !== predecessor.process_started_at) {
      return false;
    }
    if (candidate.predecessor_epoch === 0) {
      return !config.runtime_owner_epoch && !config.active_recovery;
    }
    const candidatePredecessor = candidate.predecessor_epoch === 0 ? null : {
      pid: candidate.predecessor_pid,
      process_started_at: candidate.predecessor_process_started_at
    };
    if (candidatePredecessor && !isProcessIdentityDead(candidatePredecessor)) return false;
    if (config.runtime_owner_epoch?.epoch === candidate.predecessor_epoch && config.runtime_owner_epoch.nonce === candidate.predecessor_nonce && config.runtime_owner_epoch.pid === candidate.predecessor_pid && config.runtime_owner_epoch.process_started_at === candidate.predecessor_process_started_at) {
      const active = config.active_recovery;
      return !!active && active.request_id === input.requestId && active.recovery_id === bootstrap.recoveryId && active.worker_name === input.workerName && active.owner_epoch === candidate.predecessor_epoch && active.owner_nonce === candidate.predecessor_nonce;
    }
    if (expectedEpoch <= 1 || candidate.predecessor_epoch !== expectedEpoch - 1) return false;
    predecessor = {
      epoch: candidate.predecessor_epoch,
      nonce: candidate.predecessor_nonce,
      pid: candidate.predecessor_pid,
      process_started_at: candidate.predecessor_process_started_at
    };
    expectedEpoch = candidate.predecessor_epoch;
    candidateNonce = predecessor.nonce;
  }
}
function isExactRecoverySidecar(value, task, input, active, replacementGeneration, adoptionToken) {
  const sidecar = value;
  const persisted = task.recovery_reservation ?? task.recovery_adoption;
  if (!sidecar || !persisted || sidecar.schema_version !== 1 || sidecar.recovery_id !== active.recovery_id || sidecar.request_id !== input.requestId || sidecar.task_id !== task.id || sidecar.old_owner !== input.workerName || typeof sidecar.old_task_version !== "number" || !Number.isSafeInteger(sidecar.old_task_version) || sidecar.old_task_version < 1 || typeof sidecar.old_claim_token !== "string" || sidecar.old_claim_token.length === 0 || typeof sidecar.old_claim_leased_until !== "string" || !Number.isFinite(Date.parse(sidecar.old_claim_leased_until)) || typeof sidecar.continuation_sequence !== "number" || !Number.isSafeInteger(sidecar.continuation_sequence) || sidecar.continuation_sequence < 1 || typeof sidecar.checkpoint_path !== "string" || sidecar.checkpoint_path.length === 0 || typeof sidecar.checkpoint_hash !== "string" || !/^[a-f0-9]{64}$/.test(sidecar.checkpoint_hash) || sidecar.replacement_worker !== input.workerName || sidecar.replacement_generation !== replacementGeneration || sidecar.adoption_token_hash !== createHash10("sha256").update(adoptionToken).digest("hex") || typeof sidecar.created_at !== "string" || !Number.isFinite(Date.parse(sidecar.created_at))) return false;
  const sameReservation = persisted.recovery_id === sidecar.recovery_id && persisted.request_id === sidecar.request_id && persisted.continuation_sequence === sidecar.continuation_sequence && persisted.checkpoint_path === sidecar.checkpoint_path && persisted.checkpoint_hash === sidecar.checkpoint_hash && persisted.replacement_worker === sidecar.replacement_worker && persisted.replacement_generation === sidecar.replacement_generation;
  if (!sameReservation) return false;
  if ("adoption_token_hash" in persisted && persisted.adoption_token_hash !== sidecar.adoption_token_hash) return false;
  if (task.recovery_reservation) {
    return task.status === "pending" && task.version === sidecar.old_task_version + 1 && !task.owner && !task.claim;
  }
  return task.status === "in_progress" && task.version === sidecar.old_task_version + 2 && task.owner === input.workerName && !!task.claim && task.claim.owner === input.workerName;
}
async function hasBootstrapActiveRecoveryEvidence(teamName, cwd, input, config) {
  const bootstrap = input.bootstrap;
  const active = config.active_recovery;
  if (!bootstrap || !active) return true;
  if (active.request_id !== input.requestId || active.recovery_id !== bootstrap.recoveryId || active.worker_name !== input.workerName) return false;
  const worker = config.workers.find((candidate) => candidate.name === input.workerName);
  const replacementGeneration = worker?.recovery_id === active.recovery_id && Number.isSafeInteger(worker.replacement_generation) ? worker.replacement_generation : (worker?.replacement_generation ?? 0) + 1;
  let attempt;
  try {
    attempt = validateRecoveryAttemptSecret(
      JSON.parse(await readFile13(absPath(cwd, TeamPaths.recoveryAttempt(teamName, active.recovery_id)), "utf8")),
      input,
      active.recovery_id,
      replacementGeneration
    );
  } catch {
    return false;
  }
  let tasks;
  try {
    tasks = await listTasksFromFiles(teamName, cwd);
  } catch {
    return false;
  }
  const continuations = tasks.filter((task) => task.recovery_reservation?.recovery_id === active.recovery_id || task.recovery_adoption?.recovery_id === active.recovery_id);
  const untouchedClaims = tasks.filter((task) => task.status === "in_progress" && task.owner === input.workerName && !continuations.some((continuation) => continuation.id === task.id));
  if (continuations.length === 0 && untouchedClaims.length === 0) return true;
  for (const task of continuations) {
    let sidecar;
    try {
      sidecar = JSON.parse(await readFile13(absPath(cwd, TeamPaths.taskRecoverySidecar(teamName, active.recovery_id, task.id)), "utf8"));
    } catch {
      return false;
    }
    if (!isExactRecoverySidecar(sidecar, task, input, active, replacementGeneration, attempt.adoption_token)) return false;
    const verified = sidecar;
    const checkpoint = await readTaskRecoveryCheckpoint(verified.checkpoint_path);
    if (!checkpoint.ok || checkpoint.checkpoint.team_name !== teamName || checkpoint.checkpoint.task_id !== task.id || checkpoint.checkpoint.worker_name !== verified.old_owner || checkpoint.checkpoint.task_version !== verified.old_task_version || checkpoint.checkpoint.claim_token !== verified.old_claim_token || checkpoint.checkpoint.sequence !== verified.continuation_sequence || checkpoint.checkpoint.resume_payload_hash !== verified.checkpoint_hash) return false;
  }
  for (const task of untouchedClaims) {
    const checkpoint = await selectTaskRecoveryCheckpoint(teamName, { ...task, version: task.version ?? 1 }, cwd);
    if (!checkpoint.ok) return false;
  }
  return true;
}
async function ensureRecoveryOwner(teamName, cwd, input, waitOptions) {
  let current = await readRevisionedTeamConfig(teamName, cwd);
  if (!current) current = await migrateTeamConfigRevision(teamName, cwd);
  if (!current) throw new Error("invalid_persisted_state");
  const processStartedAt = currentProcessStartIdentity();
  if (!processStartedAt) throw new Error("process_start_identity_unavailable");
  const bootstrap = input.bootstrap;
  let owner = readLatestOwnerEpoch(cwd, teamName);
  let bootstrapPredecessor = null;
  let exactDeadOrphan = false;
  if (bootstrap) {
    if (bootstrap.expectedEpoch !== bootstrap.predecessorEpoch + 1 || bootstrap.pid !== process.pid || bootstrap.processStartedAt !== processStartedAt || bootstrap.nonce.length === 0 || !await hasBootstrapRecoveryEvidence(teamName, cwd, input, waitOptions)) {
      throw new Error("runtime_owner_bootstrap_fence_lost");
    }
    const predecessor = owner;
    bootstrapPredecessor = predecessor;
    const alreadyPublished = predecessor?.epoch === bootstrap.expectedEpoch && predecessor.pid === bootstrap.pid && predecessor.process_started_at === bootstrap.processStartedAt && predecessor.nonce === bootstrap.nonce;
    exactDeadOrphan = !alreadyPublished && await isExactDeadOrphanBootstrapCandidate(
      teamName,
      cwd,
      input,
      current.config,
      predecessor
    );
    if (alreadyPublished) {
      const configAlreadyBound = current.config.runtime_owner_epoch?.epoch === bootstrap.expectedEpoch && current.config.runtime_owner_epoch?.nonce === bootstrap.nonce;
      const retryFromNoOwner = bootstrap.predecessorEpoch === 0 && !current.config.runtime_owner_epoch && (!current.config.active_recovery || await hasBootstrapActiveRecoveryEvidence(teamName, cwd, input, current.config));
      const retryFromPredecessor = bootstrap.predecessorEpoch > 0 && current.config.runtime_owner_epoch?.epoch === bootstrap.predecessorEpoch && current.config.runtime_owner_epoch?.nonce === bootstrap.predecessorNonce && current.config.active_recovery?.owner_epoch === bootstrap.predecessorEpoch && current.config.active_recovery?.owner_nonce === bootstrap.predecessorNonce && await hasBootstrapActiveRecoveryEvidence(teamName, cwd, input, current.config);
      if (!configAlreadyBound && !retryFromNoOwner && !retryFromPredecessor) {
        throw new Error("runtime_owner_bootstrap_rebind_rejected");
      }
      owner = predecessor;
    } else {
      const bootstrapFromNoOwner = bootstrap.predecessorEpoch === 0;
      if (bootstrapFromNoOwner) {
        if (predecessor || current.config.runtime_owner_epoch || current.config.active_recovery && !await hasBootstrapActiveRecoveryEvidence(teamName, cwd, input, current.config)) {
          throw new Error("runtime_owner_bootstrap_fence_lost");
        }
      } else if (!exactDeadOrphan && (!predecessor || predecessor.epoch !== bootstrap.predecessorEpoch || predecessor.nonce !== bootstrap.predecessorNonce || predecessor.pid !== bootstrap.predecessorPid || predecessor.process_started_at !== bootstrap.predecessorProcessStartedAt || !isProcessIdentityDead(predecessor) || current.config.runtime_owner_epoch?.epoch !== predecessor.epoch || current.config.runtime_owner_epoch?.nonce !== predecessor.nonce || current.config.active_recovery?.owner_epoch !== predecessor.epoch || current.config.active_recovery?.owner_nonce !== predecessor.nonce || !await hasBootstrapActiveRecoveryEvidence(teamName, cwd, input, current.config))) {
        throw new Error("runtime_owner_bootstrap_fence_lost");
      }
      owner = publishOwnerEpoch(cwd, teamName, bootstrap.expectedEpoch, {
        pid: bootstrap.pid,
        processStartedAt: bootstrap.processStartedAt,
        nonce: bootstrap.nonce
      });
      if (owner.epoch !== bootstrap.expectedEpoch || owner.pid !== bootstrap.pid || owner.process_started_at !== bootstrap.processStartedAt || owner.nonce !== bootstrap.nonce) {
        throw new Error("runtime_owner_bootstrap_fence_lost");
      }
    }
  } else if (!owner) {
    owner = publishOwnerEpoch(cwd, teamName, 1);
  } else if (owner.pid !== process.pid || owner.process_started_at !== processStartedAt) {
    throw new Error("runtime_owner_fence_lost");
  }
  const fence = { epoch: owner.epoch, nonce: owner.nonce };
  requireOwnerFence(cwd, teamName, fence);
  requireOwnerProcessIdentity(owner, process.pid, processStartedAt);
  for (let bindAttempt = 0; bindAttempt < 3 && (current.config.runtime_owner_epoch?.epoch !== owner.epoch || current.config.runtime_owner_epoch?.nonce !== owner.nonce); bindAttempt++) {
    if (current.config.runtime_owner_epoch && (current.config.runtime_owner_epoch.epoch !== owner.epoch || current.config.runtime_owner_epoch.nonce !== owner.nonce) && !(bootstrap && exactDeadOrphan && await isExactDeadOrphanBootstrapCandidate(
      teamName,
      cwd,
      input,
      current.config,
      bootstrapPredecessor
    ))) {
      throw new Error("runtime_owner_bootstrap_rebind_rejected");
    }
    if (bootstrap && current.config.active_recovery && !await hasBootstrapActiveRecoveryEvidence(teamName, cwd, input, current.config)) {
      throw new Error("runtime_owner_bootstrap_fence_lost");
    }
    const nextRevision = current.stateRevision + 1;
    const bootstrapWorker = bootstrap ? current.config.workers.find((candidate) => candidate.name === input.workerName) : void 0;
    const next = {
      ...current.config,
      state_revision: nextRevision,
      runtime_owner_epoch: owner,
      ...current.config.service_descriptor ? {
        service_descriptor: {
          ...current.config.service_descriptor,
          service_generation: current.config.service_descriptor.service_generation + 1,
          service_attempt_id: `${owner.epoch}:${owner.nonce}`
        }
      } : {},
      lifecycle_state: current.config.lifecycle_state ?? "active",
      active_recovery: current.config.active_recovery ? {
        ...current.config.active_recovery,
        owner_epoch: owner.epoch,
        owner_nonce: owner.nonce,
        state_revision: nextRevision,
        updated_at: (/* @__PURE__ */ new Date()).toISOString()
      } : bootstrap ? {
        request_id: input.requestId,
        recovery_id: bootstrap.recoveryId,
        worker_name: input.workerName,
        owner_epoch: owner.epoch,
        owner_nonce: owner.nonce,
        phase: "reserved",
        state_revision: nextRevision,
        created_at: (/* @__PURE__ */ new Date()).toISOString(),
        updated_at: (/* @__PURE__ */ new Date()).toISOString(),
        ...bootstrapWorker?.pane_id?.trim() ? { original_pane_id: bootstrapWorker.pane_id } : {}
      } : void 0
    };
    if (await saveTeamConfigAtRevision(next, current.stateRevision, cwd)) {
      current = { config: next, stateRevision: nextRevision };
      break;
    }
    const retry = await readRevisionedTeamConfig(teamName, cwd);
    if (!retry) throw new Error("invalid_persisted_state");
    current = retry;
  }
  if (!current) throw new Error("invalid_persisted_state");
  if (current.config.runtime_owner_epoch?.epoch !== owner.epoch || current.config.runtime_owner_epoch?.nonce !== owner.nonce) throw new Error("stale_state_revision");
  return { fence, config: current.config, stateRevision: current.stateRevision };
}
async function prepareRecoveryOwnerBootstrap(input, waitOptions) {
  const bootstrap = input.bootstrap;
  if (!bootstrap) throw new Error("runtime_owner_bootstrap_fence_lost");
  let owner = await ensureRecoveryOwner(input.teamName, input.cwd, input, waitOptions);
  if (owner.fence.epoch !== bootstrap.expectedEpoch || owner.config.runtime_owner_epoch?.epoch !== owner.fence.epoch || owner.config.runtime_owner_epoch.nonce !== owner.fence.nonce) {
    throw new Error("runtime_owner_bootstrap_rebind_rejected");
  }
  const active = owner.config.active_recovery;
  if (!active || active.request_id !== input.requestId || active.recovery_id !== bootstrap.recoveryId || active.worker_name !== input.workerName || active.owner_epoch !== owner.fence.epoch || active.owner_nonce !== owner.fence.nonce) {
    throw new Error("runtime_owner_bootstrap_rebind_rejected");
  }
}
async function executeRecoverDeadWorkerV2Owner(input) {
  const reservation = readRecoveryRequestReservation(input.cwd, input.requestId);
  const recoveryId = reservation?.recovery_id ?? randomUUID10();
  let ownerBound = false;
  try {
    const beforeOwner = await readRevisionedTeamConfig(input.teamName, input.cwd);
    if (beforeOwner?.config.active_scale_down || beforeOwner?.config.active_scale_up) {
      return recoveryError(input, recoveryId, "team_mutation_busy");
    }
    let owner = await ensureRecoveryOwner(input.teamName, input.cwd, input);
    ownerBound = true;
    const existingAttempt = owner.config.active_recovery;
    if (existingAttempt && (existingAttempt.request_id !== input.requestId || existingAttempt.recovery_id !== recoveryId || existingAttempt.worker_name !== input.workerName)) {
      return recoveryError(input, recoveryId, "team_mutation_busy");
    }
    if (!existingAttempt) {
      const nextRevision = owner.stateRevision + 1;
      const electedConfig = {
        ...owner.config,
        state_revision: nextRevision,
        active_recovery: {
          request_id: input.requestId,
          recovery_id: recoveryId,
          worker_name: input.workerName,
          owner_epoch: owner.fence.epoch,
          owner_nonce: owner.fence.nonce,
          phase: "reserved",
          state_revision: nextRevision,
          created_at: (/* @__PURE__ */ new Date()).toISOString(),
          updated_at: (/* @__PURE__ */ new Date()).toISOString()
        }
      };
      if (!await saveTeamConfigAtRevision(electedConfig, owner.stateRevision, input.cwd)) {
        return recoveryError(input, recoveryId, "stale_state_revision");
      }
      owner = { ...owner, config: electedConfig, stateRevision: nextRevision };
    }
    if (owner.config.lifecycle_state === "shutting_down" || owner.config.lifecycle_state === "stopped") {
      return finalizeBoundRecoveryOwnerTerminal(input, recoveryId, recoveryError(input, recoveryId, "team_shutting_down"));
    }
    if (owner.config.active_scale_down || owner.config.active_scale_up) return recoveryError(input, recoveryId, "team_mutation_busy");
    const worker = owner.config.workers.find((candidate) => candidate.name === input.workerName);
    if (!worker) return finalizeBoundRecoveryOwnerTerminal(input, recoveryId, recoveryError(input, recoveryId, "worker_not_found"));
    if (!worker.launch_descriptor) return finalizeBoundRecoveryOwnerTerminal(input, recoveryId, recoveryError(input, recoveryId, "launch_metadata_incomplete"));
    let launchDescriptor;
    try {
      launchDescriptor = validateWorkerLaunchDescriptor(worker.launch_descriptor);
      if (worker.worker_cli !== launchDescriptor.provider) throw new Error("provider mismatch");
    } catch {
      return finalizeBoundRecoveryOwnerTerminal(input, recoveryId, recoveryError(input, recoveryId, "launch_descriptor_unresolvable"));
    }
    if (!owner.config.tmux_session) return finalizeBoundRecoveryOwnerTerminal(input, recoveryId, recoveryError(input, recoveryId, "team_session_dead"));
    try {
      await tmuxExecAsync(["has-session", "-t", owner.config.tmux_session.split(":")[0]]);
    } catch {
      return finalizeBoundRecoveryOwnerTerminal(input, recoveryId, recoveryError(input, recoveryId, "team_session_dead"));
    }
    const replacementGeneration = existingAttempt && worker.recovery_id === recoveryId && typeof worker.replacement_generation === "number" ? worker.replacement_generation : (worker.replacement_generation ?? 0) + 1;
    const attempt = await readOrCreateRecoveryAttempt(input, recoveryId, replacementGeneration);
    const originalPaneId = existingAttempt?.original_pane_id ?? worker.pane_id;
    const ensureFence = async () => {
      requireOwnerFence(input.cwd, input.teamName, owner.fence);
      const current = await readRevisionedTeamConfig(input.teamName, input.cwd);
      if (!current || current.config.active_scale_down || current.config.active_scale_up || current.config.active_recovery?.recovery_id !== recoveryId || current.config.active_recovery.owner_epoch !== owner.fence.epoch || current.config.active_recovery.owner_nonce !== owner.fence.nonce) {
        throw new Error("runtime_owner_fence_lost");
      }
      return current.config;
    };
    let committedReplacementLiveness = null;
    const deps = {
      cwd: input.cwd,
      getLiveness: async () => {
        const config = await ensureFence();
        const currentWorker = config.workers.find((candidate) => candidate.name === input.workerName);
        const committedReplacement = existingAttempt?.recovery_id === recoveryId && currentWorker?.recovery_id === recoveryId && currentWorker.replacement_generation === attempt.replacement_generation && Boolean(currentWorker.pane_id && currentWorker.pane_attempt_id);
        if (!committedReplacement) {
          if (!originalPaneId?.trim() || currentWorker?.pane_id !== originalPaneId) return "unknown";
          return getWorkerPaneLiveness(originalPaneId);
        }
        committedReplacementLiveness = await getWorkerPaneLiveness(currentWorker?.pane_id);
        return committedReplacementLiveness === "unknown" ? "unknown" : "dead";
      },
      listOwnedInProgressTasks: async () => selectRecoveryReplayTasks(
        await listTasksFromFiles(input.teamName, input.cwd),
        input.workerName,
        recoveryId,
        committedReplacementLiveness
      ),
      validateCheckpoint: async (teamName, task) => {
        const persisted = task.recovery_reservation ?? task.recovery_adoption;
        if (persisted?.recovery_id === recoveryId) {
          const selected2 = await readTaskRecoveryCheckpoint(persisted.checkpoint_path);
          if (selected2.ok && selected2.checkpoint.sequence === persisted.continuation_sequence && selected2.checkpoint.resume_payload_hash === persisted.checkpoint_hash) {
            return { ok: true, sequence: selected2.checkpoint.sequence };
          }
          return { ok: false, error: selected2.ok ? "recovery_checkpoint_stale" : `recovery_checkpoint_${selected2.error}` };
        }
        const selected = await selectTaskRecoveryCheckpoint(teamName, { ...task, version: task.version ?? 1 }, input.cwd);
        if (selected.ok) return { ok: true, sequence: selected.checkpoint.sequence };
        const errorByState = {
          missing: "recovery_checkpoint_missing",
          malformed: "recovery_checkpoint_malformed",
          stale: "recovery_checkpoint_stale",
          ambiguous: "recovery_checkpoint_ambiguous"
        };
        return { ok: false, error: errorByState[selected.error] };
      },
      requeue: async (sagaInput2, taskId, adoptionTokenHash) => {
        await ensureFence();
        const currentTask = (await listTasksFromFiles(input.teamName, input.cwd)).find((task) => task.id === taskId);
        if (currentTask?.recovery_adoption?.recovery_id === sagaInput2.recoveryId) {
          return { ok: true, sequence: currentTask.recovery_adoption.continuation_sequence };
        }
        const result2 = await teamRequeueRecoveredTask(input.teamName, input.cwd, {
          recoveryId: sagaInput2.recoveryId,
          requestId: sagaInput2.requestId,
          taskId,
          replacementWorker: sagaInput2.workerName,
          replacementGeneration: sagaInput2.replacementGeneration,
          adoptionTokenHash
        });
        return result2.ok ? { ok: true, sequence: result2.reservation.continuation_sequence } : { ok: false, error: result2.error.startsWith("checkpoint_") ? `recovery_${result2.error}` : "task_requeue_failed" };
      },
      spawnGatedPane: async (sagaInput2) => {
        const config = await ensureFence();
        const currentWorker = config.workers.find((candidate) => candidate.name === sagaInput2.workerName);
        if (!currentWorker) return { ok: false, error: "worker_not_found" };
        const committedPane = resolveCommittedRecoveryPaneAttempt(existingAttempt, sagaInput2.recoveryId, sagaInput2.replacementGeneration, currentWorker);
        if (committedPane) {
          const committedPaneLiveness = await getWorkerPaneLiveness(committedPane.paneId);
          if (committedPaneLiveness === "unknown") return { ok: false, error: "runtime_owner_unavailable" };
          if (committedPaneLiveness === "alive") {
            let pending2 = pendingRecoveryPanes.get(sagaInput2.recoveryId);
            if (!pending2) {
              try {
                pending2 = buildRecoveryPaneContext(input, sagaInput2, config, currentWorker, launchDescriptor, committedPane.paneId, committedPane.paneAttemptId);
                pendingRecoveryPanes.set(sagaInput2.recoveryId, pending2);
              } catch {
                return { ok: false, error: "launch_descriptor_unresolvable" };
              }
            }
            const expected = {
              recovery_id: sagaInput2.recoveryId,
              worker_name: sagaInput2.workerName,
              replacement_generation: sagaInput2.replacementGeneration,
              pane_attempt_id: committedPane.paneAttemptId
            };
            const ready = await waitForRecoveryGateRecord(pending2.gate.readyPath, expected, 1e3);
            const manifest = await readTeamManifest(input.teamName, input.cwd);
            const projected = manifest?.workers.find((candidate) => candidate.name === sagaInput2.workerName);
            const projectedSameAttempt = projected?.pane_id === committedPane.paneId && projected.pane_attempt_id === committedPane.paneAttemptId && projected.recovery_id === sagaInput2.recoveryId && projected.replacement_generation === sagaInput2.replacementGeneration;
            if (!ready || !projectedSameAttempt) return { ok: false, error: "worker_activation_failed" };
            return {
              ok: true,
              paneId: pending2.paneId,
              paneAttemptId: pending2.paneAttemptId,
              committed: true,
              stateRevision: config.state_revision ?? 0,
              manifestSync: "synced"
            };
          }
        }
        const paneAttemptId = randomUUID10();
        let prepared;
        try {
          prepared = buildRecoveryPaneContext(input, sagaInput2, config, currentWorker, launchDescriptor, "", paneAttemptId);
          if (!process.argv[1]) throw new Error("runtime_cli_path_missing");
        } catch {
          return { ok: false, error: "launch_descriptor_unresolvable" };
        }
        const livePaneIds = [];
        for (const candidate of config.workers) {
          if (!candidate.pane_id || candidate.name === sagaInput2.workerName) continue;
          if (await getWorkerPaneLiveness(candidate.pane_id) === "alive") livePaneIds.push(candidate.pane_id);
        }
        const splitTarget = livePaneIds.at(-1) ?? config.leader_pane_id ?? "";
        if (!splitTarget) return { ok: false, error: "spawn_failed" };
        const splitDirection = livePaneIds.length > 0 ? "down" : "right";
        const split = await splitTeamWorkerPaneWithEvidence(splitTarget, splitDirection, prepared.gate.cwd);
        if (!split.paneId) {
          await recordUnaddressableRecoveryPaneFailure(
            input,
            sagaInput2.recoveryId,
            paneAttemptId,
            split.commandSucceeded ? "unaddressable_spawned_pane" : "split_command_uncertain",
            split
          );
          return { ok: false, error: "spawn_failed" };
        }
        const pending = { ...prepared, paneId: split.paneId };
        pendingRecoveryPanes.set(sagaInput2.recoveryId, pending);
        try {
          await spawnWorkerInPane(config.tmux_session, pending.paneId, {
            teamName: input.teamName,
            workerName: sagaInput2.workerName,
            envVars: { OMC_RECOVERY_GATE_SPEC: JSON.stringify(pending.gate) },
            launchBinary: process.execPath,
            launchArgs: [process.argv[1], "--recovery-gate"],
            cwd: pending.gate.cwd
          });
          const ready = await waitForRecoveryGateRecord(pending.gate.readyPath, {
            recovery_id: sagaInput2.recoveryId,
            worker_name: sagaInput2.workerName,
            replacement_generation: sagaInput2.replacementGeneration,
            pane_attempt_id: paneAttemptId
          }, 3e4);
          if (!ready) throw new Error("startup_ack_timeout");
          return { ok: true, paneId: pending.paneId, paneAttemptId, committed: false };
        } catch (error) {
          await cleanupRecoveryPaneAttempt(
            input,
            sagaInput2.recoveryId,
            pending,
            error instanceof Error ? error.message : "spawn_failed"
          );
          return { ok: false, error: error instanceof Error && error.message === "startup_ack_timeout" ? "startup_ack_timeout" : "spawn_failed" };
        }
      },
      persistActive: async (sagaInput2, paneId) => {
        await ensureFence();
        const current = await readRevisionedTeamConfig(input.teamName, input.cwd);
        if (!current) throw new Error("invalid_persisted_state");
        const pending = pendingRecoveryPanes.get(sagaInput2.recoveryId);
        if (!pending) throw new Error("worker_activation_failed");
        const nextWorkers = current.config.workers.map((candidate) => candidate.name === sagaInput2.workerName ? {
          ...candidate,
          pane_id: paneId,
          pane_attempt_id: pending.paneAttemptId,
          recovery_id: sagaInput2.recoveryId,
          replacement_generation: sagaInput2.replacementGeneration,
          operational_state: "active"
        } : candidate);
        const nextRevision = current.stateRevision + 1;
        const next = {
          ...current.config,
          workers: nextWorkers,
          state_revision: nextRevision,
          active_recovery: current.config.active_recovery ? { ...current.config.active_recovery, phase: "active", state_revision: nextRevision, updated_at: (/* @__PURE__ */ new Date()).toISOString() } : current.config.active_recovery
        };
        if (!await saveTeamConfigAtRevision(next, current.stateRevision, input.cwd)) throw new Error("stale_state_revision");
        const manifestSync = await resolveCommittedRecoveryManifestSync(
          () => readTeamManifest(input.teamName, input.cwd),
          {
            workerName: sagaInput2.workerName,
            paneId,
            paneAttemptId: pending.paneAttemptId,
            recoveryId: sagaInput2.recoveryId,
            replacementGeneration: sagaInput2.replacementGeneration
          }
        );
        return { stateRevision: nextRevision, manifestSync };
      },
      activatePane: async (sagaInput2, paneAttemptId) => {
        await ensureFence();
        const pending = pendingRecoveryPanes.get(sagaInput2.recoveryId);
        if (!pending || pending.paneAttemptId !== paneAttemptId) return { ok: false, error: "worker_activation_failed" };
        const record = {
          recovery_id: sagaInput2.recoveryId,
          worker_name: sagaInput2.workerName,
          replacement_generation: sagaInput2.replacementGeneration,
          pane_attempt_id: paneAttemptId,
          written_at: (/* @__PURE__ */ new Date()).toISOString()
        };
        await mkdir13(join28(pending.gate.activatePath, ".."), { recursive: true });
        await writeFile8(pending.gate.activatePath, JSON.stringify(record), "utf8");
        const adoptedReady = await waitForRecoveryGateRecord(`${pending.gate.readyPath}.adoption-ready`, record, 3e4);
        return adoptedReady ? { ok: true } : { ok: false, error: "worker_activation_failed" };
      },
      adoptAll: async (sagaInput2, proof, taskIds) => {
        await ensureFence();
        const results = await teamAdoptRecoveryReservations(input.teamName, input.cwd, taskIds, sagaInput2.workerName, proof);
        const failed = results.find((result2) => !result2.ok);
        if (failed && !failed.ok) {
          return { ok: false, error: failed.error.startsWith("checkpoint_") ? `recovery_${failed.error}` : "worker_activation_failed" };
        }
        const continuations = results.filter((result2) => result2.ok).map((result2) => ({
          taskId: result2.task.id,
          taskVersion: result2.task.version ?? 1,
          sequence: result2.checkpoint.sequence,
          payload: result2.checkpoint.resume_payload,
          claimToken: result2.claimToken
        }));
        return { ok: true, continuations };
      },
      repairServices: async () => {
        await ensureFence();
        const config = await readTeamConfig(input.teamName, input.cwd);
        return config ? reconcileCommittedTeamServices(config, input.cwd) : "repair_required";
      },
      writeRun: async (sagaInput2, paneAttemptId, continuations) => {
        await ensureFence();
        const pending = pendingRecoveryPanes.get(sagaInput2.recoveryId);
        if (!pending || pending.paneAttemptId !== paneAttemptId) throw new Error("worker_activation_failed");
        const instruction = continuations.length > 0 ? continuations.map((continuation) => renderRecoveryContinuationInstruction({
          teamName: input.teamName,
          workerName: sagaInput2.workerName,
          taskId: continuation.taskId,
          taskVersion: continuation.taskVersion,
          claimToken: continuation.claimToken,
          sequence: continuation.sequence,
          resumePayload: continuation.payload
        })).join("\n\n") : "Recovery completed for this idle worker. Wait for a real team task assignment and do not create or claim fake work.";
        await composeInitialInbox(input.teamName, sagaInput2.workerName, instruction, input.cwd);
        const record = {
          recovery_id: sagaInput2.recoveryId,
          worker_name: sagaInput2.workerName,
          replacement_generation: sagaInput2.replacementGeneration,
          pane_attempt_id: paneAttemptId,
          written_at: (/* @__PURE__ */ new Date()).toISOString()
        };
        const launchedPath = `${pending.gate.runPath}.launched`;
        if (!existsSync24(launchedPath)) {
          await writeFile8(pending.gate.runPath, JSON.stringify(record), "utf8");
          const launched = await waitForRecoveryGateRecord(launchedPath, record, 3e4);
          if (!launched) throw new Error("startup_ack_timeout");
        }
        if (!pending.promptMode) {
          if (!await waitForPaneReady(pending.paneId)) throw new Error("startup_ack_timeout");
          const outcome = await queueInboxInstruction({
            teamName: input.teamName,
            workerName: sagaInput2.workerName,
            workerIndex: pending.worker.index,
            paneId: pending.paneId,
            inbox: instruction,
            triggerMessage: generateTriggerMessage(
              input.teamName,
              sagaInput2.workerName,
              pending.worker.worktree_path ? "$OMC_TEAM_STATE_ROOT" : void 0
            ),
            cwd: input.cwd,
            transportPreference: "transport_direct",
            fallbackAllowed: DEFAULT_TEAM_TRANSPORT_POLICY.dispatch_mode === "hook_preferred_with_fallback",
            inboxCorrelationKey: `recovery:${sagaInput2.recoveryId}`,
            notify: async (_target, triggerMessage) => notifyStartupInbox(pending.sessionName, pending.paneId, triggerMessage),
            deps: { writeWorkerInbox }
          });
          if (!outcome.ok) throw new Error(outcome.reason ?? "worker_notify_failed");
        }
        pendingRecoveryPanes.delete(sagaInput2.recoveryId);
      },
      killAttemptPane: async (paneAttemptId) => {
        const pending = pendingRecoveryPanes.get(recoveryId);
        if (!pending || pending.paneAttemptId !== paneAttemptId) return;
        const cleaned = await cleanupRecoveryPaneAttempt(input, recoveryId, pending, "recovery_saga_rollback");
        if (!cleaned) throw new Error("worker_cleanup_incomplete");
      }
    };
    const sagaInput = {
      requestId: input.requestId,
      recoveryId,
      teamName: input.teamName,
      workerName: input.workerName,
      replacementGeneration: attempt.replacement_generation,
      adoptionToken: attempt.adoption_token,
      originalPaneId
    };
    const result = await runRecoverySaga(sagaInput, deps);
    return finalizeRecoveryOwnerResult(input, recoveryId, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message === "team_not_found" ? "team_not_found" : message === "invalid_persisted_state" ? "invalid_persisted_state" : message === "stale_state_revision" ? "stale_state_revision" : message === "runtime_owner_fence_lost" ? "runtime_owner_fence_lost" : "runtime_owner_unavailable";
    const result = recoveryError(input, recoveryId, code, message);
    return ownerBound && (code === "team_not_found" || code === "invalid_persisted_state") ? await finalizeBoundRecoveryOwnerTerminal(input, recoveryId, result) : code === "team_not_found" || code === "invalid_persisted_state" ? persistRecoveryFinal(input, recoveryId, result) : result;
  }
}
async function rollbackUnpersistedNativeWorktreeStartup(teamName, cwd, cause) {
  const safety = inspectTeamWorktreeCleanupSafety(teamName, cwd);
  const teamRoot = absPath(cwd, TeamPaths.root(teamName));
  const errorMessage = cause instanceof Error ? cause.message : String(cause);
  const recordedAt = (/* @__PURE__ */ new Date()).toISOString();
  const writeFailureMarker = async (extra = {}) => {
    await mkdir13(teamRoot, { recursive: true });
    await writeFile8(join28(teamRoot, "startup-failure.json"), JSON.stringify({
      reason: "startup_failed_before_config_persisted",
      error: errorMessage,
      recorded_at: recordedAt,
      ...extra
    }, null, 2), "utf-8");
  };
  if (!safety.hasEvidence) {
    await writeFailureMarker();
    return;
  }
  try {
    const cleanup = cleanupTeamWorktrees(teamName, cwd);
    if (cleanup.preserved.length === 0) {
      await rm4(teamRoot, { recursive: true, force: true });
    }
    await writeFailureMarker({ preserved: cleanup.preserved });
  } catch (rollbackError) {
    await writeFailureMarker({
      rollback_error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
    });
  }
}
async function rollbackStartedNativeWorktreeStartup(args) {
  try {
    await killTeamSession(
      args.sessionName,
      args.workerPaneIds,
      args.leaderPaneId ?? void 0,
      { sessionMode: args.sessionMode }
    );
  } catch (killError) {
    process.stderr.write(
      `[team/runtime-v2] startup rollback tmux cleanup failed: ${killError instanceof Error ? killError.message : String(killError)}
`
    );
  }
  await rollbackUnpersistedNativeWorktreeStartup(args.teamName, args.cwd, args.cause);
}
async function startTeamV2(config) {
  const sanitized = sanitizeTeamName(config.teamName);
  const leaderCwd = resolve6(config.cwd);
  validateTeamName(sanitized);
  const pluginCfg = config.pluginConfig ?? loadConfig();
  const resolvedRouting = buildResolvedRoutingSnapshot(pluginCfg);
  let worktreeMode = normalizeTeamWorktreeMode(
    process.env.OMC_TEAM_WORKTREE_MODE ?? pluginCfg.team?.ops?.worktreeMode
  );
  let autoMergeLeaderBranch;
  if (config.autoMerge) {
    if (!isRuntimeV2Enabled()) {
      throw new Error("auto-merge requires OMC_RUNTIME_V2=1 (this feature is v2-only).");
    }
    autoMergeLeaderBranch = resolveLeaderBranch(leaderCwd);
    const stripped = autoMergeLeaderBranch.replace(/^refs\/heads\//i, "").toLowerCase();
    if (stripped === "main" || stripped === "master") {
      throw new Error("auto-merge refuses main/master leader branch \u2014 use a feature branch");
    }
    if (worktreeMode !== "named") {
      worktreeMode = "named";
    }
  }
  const workspaceMode = worktreeMode === "disabled" ? "single" : "worktree";
  const declaredAgentTypes = config.agentTypes;
  const agentTypes = declaredAgentTypes.map((t) => {
    if (!isHeadlessSupportedOnPlatform(t)) {
      process.stderr.write(
        `[team/runtime-v2] ${t} headless mode is unsupported on this platform \u2014 using claude fallback for direct workers
`
      );
      return "claude";
    }
    return t;
  });
  const resolvedBinaryPaths = {};
  const missingBinaryReasons = [];
  for (const agentType of [...new Set(agentTypes)]) {
    try {
      resolvedBinaryPaths[agentType] = resolvePreflightBinaryPath(agentType).path;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      missingBinaryReasons.push({ agentType, reason });
    }
  }
  for (const { primary } of Object.values(resolvedRouting)) {
    const provider = primary.provider;
    if (resolvedBinaryPaths[provider]) continue;
    if (missingBinaryReasons.some((m) => m.agentType === provider)) continue;
    try {
      resolvedBinaryPaths[provider] = resolvePreflightBinaryPath(provider).path;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      missingBinaryReasons.push({ agentType: provider, reason });
    }
  }
  if (!resolvedBinaryPaths.claude) {
    try {
      resolvedBinaryPaths.claude = resolveValidatedBinaryPath("claude");
    } catch {
    }
  }
  await mkdir13(absPath(leaderCwd, TeamPaths.tasks(sanitized)), { recursive: true });
  await mkdir13(absPath(leaderCwd, TeamPaths.workers(sanitized)), { recursive: true });
  await mkdir13(join28(getOmcRoot(leaderCwd), "state", "team", sanitized, "mailbox"), { recursive: true });
  const missingBinaryLogFailure = createSwallowedErrorLogger(
    "team.runtime-v2.startTeamV2 cli_binary_missing event failed"
  );
  for (const { agentType, reason } of missingBinaryReasons) {
    process.stderr.write(
      `[team/runtime-v2] cli_binary_missing:${agentType}: ${reason} \u2014 falling back to claude snapshot (AC-8)
`
    );
    await appendTeamEvent(sanitized, {
      type: "team_leader_nudge",
      worker: "leader-fixed",
      reason: `cli_binary_missing:${agentType}:${reason}`
    }, leaderCwd).catch(missingBinaryLogFailure);
  }
  for (let i = 0; i < config.tasks.length; i++) {
    const taskId = String(i + 1);
    const taskFilePath = absPath(leaderCwd, TeamPaths.taskFile(sanitized, taskId));
    await mkdir13(join28(taskFilePath, ".."), { recursive: true });
    await writeFile8(taskFilePath, JSON.stringify({
      id: taskId,
      subject: config.tasks[i].subject,
      description: config.tasks[i].description,
      status: "pending",
      owner: null,
      result: null,
      ...config.tasks[i].role ? { role: config.tasks[i].role } : {},
      ...config.tasks[i].delegation ? { delegation: config.tasks[i].delegation } : {},
      created_at: (/* @__PURE__ */ new Date()).toISOString()
    }, null, 2), "utf-8");
  }
  const workerNames = Array.from({ length: config.workerCount }, (_, index) => `worker-${index + 1}`);
  const workerWorktrees = /* @__PURE__ */ new Map();
  try {
    if (worktreeMode !== "disabled") {
      for (const workerName of workerNames) {
        const worktree = ensureWorkerWorktree(sanitized, workerName, leaderCwd, {
          mode: worktreeMode,
          requireCleanLeader: true
        });
        if (worktree) workerWorktrees.set(workerName, worktree);
      }
    }
  } catch (error) {
    await rollbackUnpersistedNativeWorktreeStartup(sanitized, leaderCwd, error);
    throw error;
  }
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
      description: config.tasks[idx].description,
      ...config.tasks[idx].role ? { role: config.tasks[idx].role } : {}
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
  const startupByWorker = new Map(startupAllocations.map((item) => [item.workerName, item.taskIndex]));
  const preparedLaunches = /* @__PURE__ */ new Map();
  const resolveDefaultModel = (agentType) => {
    if (agentType === "codex") return process.env.OMC_EXTERNAL_MODELS_DEFAULT_CODEX_MODEL || process.env.OMC_CODEX_DEFAULT_MODEL || void 0;
    if (agentType === "gemini") return process.env.OMC_EXTERNAL_MODELS_DEFAULT_GEMINI_MODEL || process.env.OMC_GEMINI_DEFAULT_MODEL || void 0;
    if (agentType === "antigravity") return process.env.OMC_EXTERNAL_MODELS_DEFAULT_ANTIGRAVITY_MODEL || process.env.OMC_ANTIGRAVITY_DEFAULT_MODEL || void 0;
    if (agentType === "grok") return process.env.OMC_EXTERNAL_MODELS_DEFAULT_GROK_MODEL || process.env.OMC_GROK_DEFAULT_MODEL || void 0;
    if (agentType === "cursor") return void 0;
    return resolveClaudeWorkerModel();
  };
  for (let i = 0; i < workerNames.length; i++) {
    const workerName = workerNames[i];
    const taskIndex = startupByWorker.get(workerName);
    const fallbackAgent = agentTypes[i % agentTypes.length] ?? agentTypes[0] ?? "claude";
    const assignment = taskIndex === void 0 ? { agentType: fallbackAgent, model: resolveDefaultModel(fallbackAgent), role: void 0 } : resolveTaskAssignment(
      config.tasks[taskIndex],
      resolvedRouting,
      pluginCfg.team?.roleRouting,
      resolvedBinaryPaths,
      fallbackAgent
    );
    const effectiveModel = assignment.model || resolveDefaultModel(assignment.agentType);
    const worktree = workerWorktrees.get(workerName);
    const outputFile = taskIndex !== void 0 && assignment.role && shouldInjectContract(assignment.role, assignment.agentType) ? cliWorkerOutputFilePath(teamStateRoot(leaderCwd, sanitized), workerName) : void 0;
    const outputContract = outputFile && assignment.role ? renderCliWorkerOutputContract(assignment.role, outputFile) : void 0;
    const promptArgs = taskIndex !== void 0 && isPromptModeAgent(assignment.agentType) ? getPromptModeArgs(assignment.agentType, generatePromptModeStartupPrompt(
      sanitized,
      workerName,
      worktree ? "$OMC_TEAM_STATE_ROOT" : void 0,
      outputContract
    )) : [];
    const binary = resolvedBinaryPaths[assignment.agentType];
    if (!binary) throw new Error(`No validated binary available for ${assignment.agentType}`);
    const descriptor = buildValidatedWorkerLaunchDescriptor(assignment.agentType, {
      teamName: sanitized,
      workerName,
      cwd: worktree?.path ?? leaderCwd,
      resolvedBinaryPath: binary,
      model: effectiveModel
    }, promptArgs);
    preparedLaunches.set(workerName, {
      agentType: assignment.agentType,
      ...assignment.role ? { role: assignment.role } : {},
      descriptor
    });
  }
  try {
    for (let i = 0; i < workerNames.length; i++) {
      const wName = workerNames[i];
      const agentType = agentTypes[i % agentTypes.length] ?? agentTypes[0] ?? "claude";
      await ensureWorkerStateDir(sanitized, wName, leaderCwd);
      const overlayPath = await writeWorkerOverlay({
        teamName: sanitized,
        workerName: wName,
        agentType,
        tasks: config.tasks.map((t, idx) => ({
          id: String(idx + 1),
          subject: t.subject,
          description: t.description
        })),
        cwd: leaderCwd,
        ...config.rolePrompt ? { bootstrapInstructions: config.rolePrompt } : {},
        ...workerWorktrees.has(wName) ? { instructionStateRoot: "$OMC_TEAM_STATE_ROOT" } : {}
      });
      const worktree = workerWorktrees.get(wName);
      if (worktree) {
        const overlayContent = await readFile13(overlayPath, "utf-8");
        installWorktreeRootAgents(sanitized, wName, leaderCwd, worktree.path, overlayContent);
      }
    }
  } catch (error) {
    await rollbackUnpersistedNativeWorktreeStartup(sanitized, leaderCwd, error);
    throw error;
  }
  let session;
  try {
    session = await createTeamSession(sanitized, 0, leaderCwd, {
      newWindow: Boolean(config.newWindow)
    });
  } catch (error) {
    await rollbackUnpersistedNativeWorktreeStartup(sanitized, leaderCwd, error);
    throw error;
  }
  const sessionName2 = session.sessionName;
  const leaderPaneId = session.leaderPaneId;
  const ownsWindow = session.sessionMode !== "split-pane";
  const workerPaneIds = [];
  const workersInfo = workerNames.map((wName, i) => {
    const worktree = workerWorktrees.get(wName);
    return {
      name: wName,
      index: i + 1,
      role: config.workerRoles?.[i] ?? (agentTypes[i % agentTypes.length] ?? agentTypes[0] ?? "claude"),
      worker_cli: preparedLaunches.get(wName).descriptor.provider,
      launch_descriptor: preparedLaunches.get(wName).descriptor,
      assigned_tasks: [],
      working_dir: worktree?.path ?? leaderCwd,
      team_state_root: teamStateRoot(leaderCwd, sanitized),
      ...worktree ? {
        worktree_repo_root: leaderCwd,
        worktree_path: worktree.path,
        worktree_branch: worktree.branch,
        worktree_detached: worktree.detached,
        worktree_created: worktree.created
      } : {}
    };
  });
  const teamConfig = {
    name: sanitized,
    state_revision: 0,
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
    resolved_routing: resolvedRouting,
    workspace_mode: workspaceMode,
    worktree_mode: worktreeMode,
    service_descriptor: config.autoMerge ? {
      schema_version: 1,
      service_generation: 1,
      service_attempt_id: randomUUID10(),
      auto_merge_enabled: true,
      workspace_root: leaderCwd,
      leader_branch: autoMergeLeaderBranch,
      cadence_policy: "worker-auto-commit-v1"
    } : {
      schema_version: 1,
      service_generation: 1,
      service_attempt_id: randomUUID10(),
      auto_merge_enabled: false,
      workspace_root: leaderCwd,
      cadence_policy: "disabled"
    }
  };
  try {
    await saveTeamConfig(teamConfig, leaderCwd, teamConfig.state_revision);
  } catch (error) {
    await rollbackStartedNativeWorktreeStartup({
      teamName: sanitized,
      cwd: leaderCwd,
      cause: error,
      sessionName: sessionName2,
      leaderPaneId,
      workerPaneIds,
      sessionMode: session.sessionMode
    });
    throw error;
  }
  const permissionsSnapshot = {
    approval_mode: process.env.OMC_APPROVAL_MODE || "default",
    sandbox_mode: process.env.OMC_SANDBOX_MODE || "default",
    network_access: process.env.OMC_NETWORK_ACCESS === "1"
  };
  const teamManifest = {
    schema_version: 2,
    state_revision: 0,
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
    worktree_mode: teamConfig.worktree_mode,
    leader_pane_id: leaderPaneId,
    hud_pane_id: null,
    resize_hook_name: null,
    resize_hook_target: null,
    next_worker_index: teamConfig.next_worker_index,
    service_descriptor: teamConfig.service_descriptor
  };
  try {
    await writeFile8(absPath(leaderCwd, TeamPaths.manifest(sanitized)), JSON.stringify(teamManifest, null, 2), "utf-8");
  } catch (error) {
    await rollbackStartedNativeWorktreeStartup({
      teamName: sanitized,
      cwd: leaderCwd,
      cause: error,
      sessionName: sessionName2,
      leaderPaneId,
      workerPaneIds,
      sessionMode: session.sessionMode
    });
    throw error;
  }
  const initialStartupAllocations = [];
  const seenStartupWorkers = /* @__PURE__ */ new Set();
  for (const decision of startupAllocations) {
    if (seenStartupWorkers.has(decision.workerName)) continue;
    initialStartupAllocations.push(decision);
    seenStartupWorkers.add(decision.workerName);
    if (initialStartupAllocations.length >= config.workerCount) break;
  }
  try {
    for (const decision of initialStartupAllocations) {
      const wName = decision.workerName;
      const workerIndex = Number.parseInt(wName.replace("worker-", ""), 10) - 1;
      const taskId = String(decision.taskIndex + 1);
      const task = config.tasks[decision.taskIndex];
      if (!task || workerIndex < 0) continue;
      const prepared = preparedLaunches.get(wName);
      if (!prepared) continue;
      const workerLaunch = await spawnV2Worker({
        sessionName: sessionName2,
        leaderPaneId,
        existingWorkerPaneIds: workerPaneIds,
        teamName: sanitized,
        workerName: wName,
        workerIndex,
        agentType: prepared.agentType,
        launchDescriptor: prepared.descriptor,
        task,
        taskId,
        cwd: leaderCwd,
        workerCwd: workersInfo[workerIndex]?.working_dir ?? leaderCwd,
        worktreePath: workersInfo[workerIndex]?.worktree_path,
        autoMerge: Boolean(config.autoMerge),
        ...prepared.role ? { role: prepared.role } : {}
      });
      if (workerLaunch.paneId) {
        workerPaneIds.push(workerLaunch.paneId);
        const workerInfo = workersInfo[workerIndex];
        if (workerInfo) {
          workerInfo.pane_id = workerLaunch.paneId;
          workerInfo.assigned_tasks = workerLaunch.startupAssigned ? [taskId] : [];
          workerInfo.worker_cli = prepared.agentType;
          if (workerLaunch.outputFile) {
            workerInfo.output_file = workerLaunch.outputFile;
          }
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
  } catch (error) {
    await rollbackStartedNativeWorktreeStartup({
      teamName: sanitized,
      cwd: leaderCwd,
      cause: error,
      sessionName: sessionName2,
      leaderPaneId,
      workerPaneIds,
      sessionMode: session.sessionMode
    });
    throw error;
  }
  teamConfig.workers = workersInfo;
  try {
    await saveTeamConfig(teamConfig, leaderCwd, teamConfig.state_revision);
  } catch (error) {
    await rollbackStartedNativeWorktreeStartup({
      teamName: sanitized,
      cwd: leaderCwd,
      cause: error,
      sessionName: sessionName2,
      leaderPaneId,
      workerPaneIds,
      sessionMode: session.sessionMode
    });
    throw error;
  }
  const logEventFailure = createSwallowedErrorLogger(
    "team.runtime-v2.startTeamV2 appendTeamEvent failed"
  );
  appendTeamEvent(sanitized, {
    type: "team_leader_nudge",
    worker: "leader-fixed",
    reason: `start_team_v2: workers=${config.workerCount} tasks=${config.tasks.length} panes=${workerPaneIds.length}`
  }, leaderCwd).catch(logEventFailure);
  if (config.autoMerge && autoMergeLeaderBranch) {
    try {
      await ensureLeaderInbox(sanitized, leaderCwd);
      await appendToLeaderInbox(
        sanitized,
        extendLeaderBootstrapPrompt(sanitized),
        leaderCwd
      );
      try {
        await recoverFromRestart({
          teamName: sanitized,
          repoRoot: leaderCwd,
          leaderBranch: autoMergeLeaderBranch,
          cwd: leaderCwd
        });
      } catch (recErr) {
        process.stderr.write(`[team/runtime-v2] auto-merge recover-from-restart failed: ${recErr}
`);
      }
      const orchestrator = await startMergeOrchestrator({
        teamName: sanitized,
        repoRoot: leaderCwd,
        leaderBranch: autoMergeLeaderBranch,
        cwd: leaderCwd,
        serviceGeneration: teamConfig.service_descriptor.service_generation,
        serviceAttemptId: teamConfig.service_descriptor.service_attempt_id
      });
      registerTeamOrchestrator(sanitized, orchestrator, {
        serviceGeneration: teamConfig.service_descriptor.service_generation,
        serviceAttemptId: teamConfig.service_descriptor.service_attempt_id
      });
      for (const w of workersInfo) {
        await orchestrator.registerWorker(w.name);
      }
    } catch (orchErr) {
      await stopTeamCadence(sanitized);
      unregisterTeamOrchestrator(sanitized);
      await rollbackStartedNativeWorktreeStartup({
        teamName: sanitized,
        cwd: leaderCwd,
        cause: orchErr,
        sessionName: sessionName2,
        leaderPaneId,
        workerPaneIds,
        sessionMode: session.sessionMode
      });
      const reason = orchErr instanceof Error ? orchErr.message : String(orchErr);
      throw new Error(`auto-merge startup failed: ${reason}`);
    }
  }
  return {
    teamName: sanitized,
    sanitizedName: sanitized,
    sessionName: sessionName2,
    config: teamConfig,
    cwd: leaderCwd,
    ownsWindow
  };
}
async function writeWatchdogFailedMarker(teamName, cwd, reason) {
  const { writeFile: writeFile9 } = await import("fs/promises");
  const marker = {
    failedAt: Date.now(),
    reason,
    writtenBy: "runtime-v2"
  };
  const root = absPath(cwd, TeamPaths.root(sanitizeTeamName(teamName)));
  const markerPath = join28(root, "watchdog-failed.json");
  await mkdir13(root, { recursive: true });
  await writeFile9(markerPath, JSON.stringify(marker, null, 2), "utf-8");
}
async function requeueDeadWorkerTasks(teamName, deadWorkerNames, cwd) {
  const sanitized = sanitizeTeamName(teamName);
  const requeued = /* @__PURE__ */ new Set();
  for (const workerName of deadWorkerNames) {
    const outcome = await recoverDeadWorkerV2(sanitized, cwd, { workerName });
    if (outcome.outcome === "recovered") {
      for (const taskId of outcome.requeuedTaskIds) requeued.add(taskId);
    }
  }
  return [...requeued];
}
async function processCliWorkerVerdicts(teamName, cwd) {
  const sanitized = sanitizeTeamName(teamName);
  const config = await readTeamConfig(sanitized, cwd);
  if (!config) return [];
  const results = [];
  const logEventFailure = createSwallowedErrorLogger(
    "team.runtime-v2.processCliWorkerVerdicts appendTeamEvent failed"
  );
  const { rename: rename5 } = await import("fs/promises");
  const { readFileSync: readFileSync18, writeFileSync: writeFileSync8, existsSync: fsExistsSync } = await import("fs");
  const { withFileLockSync: withFileLockSync2 } = await Promise.resolve().then(() => (init_file_lock(), file_lock_exports));
  for (const worker of config.workers) {
    const outputFile = worker.output_file;
    if (!outputFile) continue;
    const liveness = await getWorkerPaneLiveness(worker.pane_id);
    if (liveness !== "dead") continue;
    if (!fsExistsSync(outputFile)) {
      results.push({ workerName: worker.name, taskId: null, status: "file_missing" });
      continue;
    }
    let payload;
    try {
      const raw = await readFile13(outputFile, "utf-8");
      payload = parseCliWorkerVerdict(raw);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await appendTeamEvent(sanitized, {
        type: "team_leader_nudge",
        worker: "leader-fixed",
        reason: `cli_worker_verdict_parse_failed:${worker.name}:${reason}`
      }, cwd).catch(logEventFailure);
      results.push({ workerName: worker.name, taskId: null, status: "parse_failed", reason });
      continue;
    }
    const candidateTaskIds = /* @__PURE__ */ new Set();
    if (payload.task_id) candidateTaskIds.add(payload.task_id);
    for (const id of worker.assigned_tasks ?? []) candidateTaskIds.add(id);
    let targetTaskId = null;
    let targetTaskPath = null;
    for (const taskId of candidateTaskIds) {
      const taskPath2 = absPath(cwd, TeamPaths.taskFile(sanitized, taskId));
      if (!fsExistsSync(taskPath2)) continue;
      try {
        const taskRaw = readFileSync18(taskPath2, "utf-8");
        const taskData = JSON.parse(taskRaw);
        if (taskData.owner === worker.name && taskData.status === "in_progress") {
          targetTaskId = taskId;
          targetTaskPath = taskPath2;
          break;
        }
      } catch {
      }
    }
    if (!targetTaskId || !targetTaskPath) {
      await appendTeamEvent(sanitized, {
        type: "team_leader_nudge",
        worker: "leader-fixed",
        reason: `cli_worker_verdict_no_in_progress_task:${worker.name}:verdict=${payload.verdict}`
      }, cwd).catch(logEventFailure);
      results.push({
        workerName: worker.name,
        taskId: payload.task_id,
        status: "no_in_progress_task",
        verdict: payload.verdict
      });
      continue;
    }
    const terminalStatus = payload.verdict === "approve" ? "completed" : "failed";
    let transitionOk = false;
    try {
      withFileLockSync2(targetTaskPath + ".lock", () => {
        const raw = readFileSync18(targetTaskPath, "utf-8");
        const taskData = JSON.parse(raw);
        if (taskData.status !== "in_progress" || taskData.owner !== worker.name) {
          return;
        }
        const prevMetadata = taskData.metadata && typeof taskData.metadata === "object" ? taskData.metadata : {};
        taskData.status = terminalStatus;
        taskData.completed_at = (/* @__PURE__ */ new Date()).toISOString();
        taskData.claim = void 0;
        taskData.metadata = {
          ...prevMetadata,
          verdict: payload.verdict,
          verdict_summary: payload.summary,
          verdict_findings: payload.findings,
          verdict_role: payload.role,
          verdict_source: "cli_worker_output_contract"
        };
        if (terminalStatus === "failed") {
          taskData.error = `cli_worker_verdict:${payload.verdict}:${payload.summary}`;
        }
        writeFileSync8(targetTaskPath, JSON.stringify(taskData, null, 2), "utf-8");
        transitionOk = true;
      });
    } catch {
    }
    if (!transitionOk) {
      results.push({
        workerName: worker.name,
        taskId: targetTaskId,
        status: "already_terminal",
        verdict: payload.verdict
      });
      continue;
    }
    await appendTeamEvent(sanitized, {
      type: terminalStatus === "completed" ? "task_completed" : "task_failed",
      worker: worker.name,
      task_id: targetTaskId,
      reason: `cli_worker_verdict:${payload.verdict}`
    }, cwd).catch(logEventFailure);
    try {
      await rename5(outputFile, outputFile + ".processed");
    } catch {
    }
    results.push({
      workerName: worker.name,
      taskId: targetTaskId,
      status: terminalStatus,
      verdict: payload.verdict
    });
  }
  return results;
}
async function monitorTeamV2(teamName, cwd) {
  const monitorStartMs = performance.now();
  const sanitized = sanitizeTeamName(teamName);
  const config = await readTeamConfig(sanitized, cwd);
  if (!config) return null;
  try {
    await processCliWorkerVerdicts(sanitized, cwd);
  } catch (err) {
    process.stderr.write(
      `[team/runtime-v2] processCliWorkerVerdicts failed: ${err instanceof Error ? err.message : String(err)}
`
    );
  }
  const previousSnapshot = await readMonitorSnapshot(sanitized, cwd);
  const listTasksStartMs = performance.now();
  const allTasks = await listTasksFromFiles(sanitized, cwd);
  const listTasksMs = performance.now() - listTasksStartMs;
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
  const workerScanStartMs = performance.now();
  const workerSignals = await Promise.all(
    config.workers.map(async (worker) => {
      const liveness = await getWorkerPaneLiveness(worker.pane_id);
      const alive = liveness === "alive";
      const [status, heartbeat, paneCapture] = await Promise.all([
        readWorkerStatus(sanitized, worker.name, cwd),
        readWorkerHeartbeat(sanitized, worker.name, cwd),
        alive ? captureWorkerPane(worker.pane_id) : Promise.resolve("")
      ]);
      return { worker, alive, liveness, status, heartbeat, paneCapture };
    })
  );
  const workerScanMs = performance.now() - workerScanStartMs;
  for (const { worker: w, alive, liveness, status, heartbeat, paneCapture } of workerSignals) {
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
      liveness,
      status,
      heartbeat,
      assignedTasks: w.assigned_tasks,
      working_dir: w.working_dir,
      worktree_repo_root: w.worktree_repo_root,
      worktree_path: w.worktree_path,
      worktree_branch: w.worktree_branch,
      worktree_detached: w.worktree_detached,
      worktree_created: w.worktree_created,
      team_state_root: w.team_state_root,
      turnsWithoutProgress
    });
    if (liveness === "dead") {
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
    const missingDependencyIds = outstandingTask ? getMissingDependencyIds(outstandingTask, taskById) : [];
    let stallReason = null;
    if (paneSuggestsIdle && missingDependencyIds.length > 0) {
      stallReason = "missing_dependency";
    } else if (paneSuggestsIdle && expectedTaskId !== "" && !hasWorkStartEvidence) {
      stallReason = "no_work_start_evidence";
    } else if (paneSuggestsIdle && expectedTaskId !== "" && (!statusFresh || !heartbeatFresh)) {
      stallReason = "stale_or_missing_worker_reports";
    } else if (paneSuggestsIdle && turnsWithoutProgress > 5) {
      stallReason = "no_meaningful_turn_progress";
    }
    if (stallReason) {
      nonReportingWorkers.push(w.name);
      if (stallReason === "missing_dependency") {
        recommendations.push(
          `Investigate ${w.name}: task-${outstandingTask?.id ?? expectedTaskId} is blocked by missing task ids [${missingDependencyIds.join(", ")}]; pane is idle at prompt`
        );
      } else if (stallReason === "no_work_start_evidence") {
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
  const allTasksTerminal = taskCounts.pending === 0 && taskCounts.blocked === 0 && taskCounts.in_progress === 0;
  for (const task of allTasks) {
    const missingDependencyIds = getMissingDependencyIds(task, taskById);
    if (missingDependencyIds.length === 0) {
      continue;
    }
    recommendations.push(
      `Investigate task-${task.id}: depends on missing task ids [${missingDependencyIds.join(", ")}]`
    );
  }
  const phase = inferPhase(allTasks.map((t) => ({
    status: t.status,
    metadata: void 0
  })));
  await emitMonitorDerivedEvents(
    sanitized,
    allTasks,
    workers.map((w) => ({ name: w.name, alive: w.alive, liveness: w.liveness, status: w.status })),
    previousSnapshot,
    cwd
  );
  const updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  const totalMs = performance.now() - monitorStartMs;
  await writeMonitorSnapshot(sanitized, {
    taskStatusById: Object.fromEntries(allTasks.map((t) => [t.id, t.status])),
    workerAliveByName: Object.fromEntries(workers.map((w) => [w.name, w.alive])),
    workerLivenessByName: Object.fromEntries(workers.map((w) => [w.name, w.liveness])),
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
    allTasksTerminal,
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
  const workspaceHash2 = createHash10("sha256").update(cwd).digest("hex");
  const lifecycleLock = absPath(cwd, TeamPaths.recoveryLifecycleLock(workspaceHash2, sanitized));
  const assertShutdownGate = async (currentConfig) => {
    if (force) return;
    const allTasks = await listTasksFromFiles(sanitized, cwd);
    const governance = getConfigGovernance(currentConfig);
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
    if (gate.allowed) return;
    const hasActiveWork = gate.pending > 0 || gate.blocked > 0 || gate.in_progress > 0;
    if (!governance.cleanup_requires_all_workers_inactive) {
      await appendTeamEvent(sanitized, {
        type: "team_leader_nudge",
        worker: "leader-fixed",
        reason: `cleanup_override_bypassed:pending=${gate.pending},blocked=${gate.blocked},in_progress=${gate.in_progress},failed=${gate.failed}`
      }, cwd).catch(logEventFailure);
      return;
    }
    if (ralph && !hasActiveWork) {
      await appendTeamEvent(sanitized, {
        type: "team_leader_nudge",
        worker: "leader-fixed",
        reason: `gate_bypassed:pending=${gate.pending},blocked=${gate.blocked},in_progress=${gate.in_progress},failed=${gate.failed}`
      }, cwd).catch(logEventFailure);
      return;
    }
    throw new Error(
      `shutdown_gate_blocked:pending=${gate.pending},blocked=${gate.blocked},in_progress=${gate.in_progress},failed=${gate.failed}`
    );
  };
  let ownedShutdownNonce = null;
  let config = await withProcessIdentityFileLock(lifecycleLock, async () => {
    const current = await migrateTeamConfigRevision(sanitized, cwd);
    if (!current) return null;
    if (current.config.active_recovery) throw new Error(`shutdown_blocked:active_recovery:${current.config.active_recovery.recovery_id}`);
    if (current.config.active_scale_down) throw new Error(`shutdown_blocked:active_scale_down:${current.config.active_scale_down.operation_id}`);
    if (current.config.active_scale_up) {
      throw new Error(`shutdown_blocked:active_scale_up:${current.config.active_scale_up.operation_id}`);
    }
    if (current.config.lifecycle_state === "stopped" || current.config.lifecycle_state === "shutting_down") return current.config;
    await assertShutdownGate(current.config);
    const processStartedAt = currentProcessStartIdentity();
    if (!processStartedAt) throw new Error("process_start_identity_unavailable");
    ownedShutdownNonce = randomUUID10();
    const nextRevision = current.stateRevision + 1;
    const next = {
      ...current.config,
      lifecycle_state: "shutting_down",
      state_revision: nextRevision,
      shutdown_attempt: {
        nonce: ownedShutdownNonce,
        pid: process.pid,
        process_started_at: processStartedAt,
        state_revision: nextRevision,
        created_at: (/* @__PURE__ */ new Date()).toISOString()
      }
    };
    if (!await saveTeamConfigAtRevision(next, current.stateRevision, cwd)) throw new Error("stale_state_revision");
    return next;
  });
  const revalidateShutdownFence = async () => withProcessIdentityFileLock(lifecycleLock, async () => {
    const current = await readRevisionedTeamConfig(sanitized, cwd);
    if (!current || !["shutting_down", "stopped"].includes(current.config.lifecycle_state ?? "") || current.config.active_recovery || current.config.active_scale_up) {
      throw new Error(current?.config.active_recovery ? `shutdown_blocked:active_recovery:${current.config.active_recovery.recovery_id}` : "shutdown_fence_lost");
    }
    return current.config;
  });
  const commitStoppedFence = async () => withProcessIdentityFileLock(lifecycleLock, async () => {
    const current = await readRevisionedTeamConfig(sanitized, cwd);
    if (!current || !["shutting_down", "stopped"].includes(current.config.lifecycle_state ?? "") || current.config.active_recovery || current.config.active_scale_up) {
      throw new Error(current?.config.active_recovery ? `shutdown_blocked:active_recovery:${current.config.active_recovery.recovery_id}` : "shutdown_fence_lost");
    }
    if (current.config.lifecycle_state === "stopped") return;
    const stopped = {
      ...current.config,
      lifecycle_state: "stopped",
      shutdown_attempt: void 0,
      state_revision: current.stateRevision + 1
    };
    if (!await saveTeamConfigAtRevision(stopped, current.stateRevision, cwd)) throw new Error("stale_state_revision");
  });
  const rollbackRejectedShutdownFence = async (expected) => withProcessIdentityFileLock(lifecycleLock, async () => {
    const current = await readRevisionedTeamConfig(sanitized, cwd);
    if (!ownedShutdownNonce || !current || current.config.lifecycle_state !== "shutting_down" || current.config.active_recovery || current.config.active_scale_up || current.stateRevision !== expected.state_revision || current.config.shutdown_attempt?.nonce !== ownedShutdownNonce) return false;
    const active = {
      ...current.config,
      lifecycle_state: "active",
      shutdown_attempt: void 0,
      state_revision: current.stateRevision + 1
    };
    return saveTeamConfigAtRevision(active, current.stateRevision, cwd);
  });
  const finalizeAutoMerge = async () => {
    const orchestrator = getTeamOrchestrator(sanitized);
    if (orchestrator) {
      try {
        const drainResult = await orchestrator.drainAndStop();
        if (drainResult.unmerged.length > 0) {
          await appendTeamEvent(sanitized, {
            type: "team_leader_nudge",
            worker: "leader-fixed",
            reason: `auto_merge_drain_unmerged:${drainResult.unmerged.map((u) => `${u.workerName}:${u.reason}`).join(",")}`
          }, cwd).catch(logEventFailure);
        }
        for (const w of config?.workers ?? []) {
          try {
            await orchestrator.unregisterWorker(w.name);
          } catch (err) {
            process.stderr.write(
              `[team/runtime-v2] orchestrator.unregisterWorker(${w.name}) failed: ${err}
`
            );
          }
        }
      } catch (err) {
        process.stderr.write(`[team/runtime-v2] orchestrator drainAndStop: ${err}
`);
      } finally {
        await stopTeamCadence(sanitized);
        unregisterTeamOrchestrator(sanitized);
      }
    } else {
      await stopTeamCadence(sanitized);
    }
  };
  if (!config) {
    const cleanupSafety = inspectTeamWorktreeCleanupSafety(sanitized, cwd);
    if (cleanupSafety.hasEvidence) {
      process.stderr.write("[team/runtime-v2] preserving team state because config is missing and worktree cleanup evidence remains\n");
      return;
    }
    await cleanupTeamState(sanitized, cwd);
    return;
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
      const shutdownAckPath = w.worktree_path ? `$OMC_TEAM_STATE_ROOT/workers/${w.name}/shutdown-ack.json` : TeamPaths.shutdownAck(sanitized, w.name);
      const shutdownInbox = `# Shutdown Request

All tasks are complete. Please wrap up and respond with a shutdown acknowledgement.

Write your ack to: ${shutdownAckPath}
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
      if (!await rollbackRejectedShutdownFence(config)) {
        throw new Error(`shutdown_rejected_fence_lost:${detail}`);
      }
      throw new Error(`shutdown_rejected:${detail}`);
    }
    const allDone = config.workers.every((w) => ackedWorkers.has(w.name));
    if (allDone) break;
    await new Promise((r) => setTimeout(r, 2e3));
  }
  config = await revalidateShutdownFence();
  const recordedWorkerPaneIds = config.workers.map((w) => w.pane_id).filter((p) => typeof p === "string" && p.trim().length > 0);
  try {
    const { killWorkerPanes: killWorkerPanes2, killTeamSession: killTeamSession2, resolveSplitPaneWorkerPaneIds: resolveSplitPaneWorkerPaneIds2, getWorkerLiveness: getWorkerLiveness2 } = await Promise.resolve().then(() => (init_tmux_session(), tmux_session_exports));
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
    const paneById = new Map(config.workers.filter((w) => typeof w.pane_id === "string" && w.pane_id.trim().length > 0).map((w) => [w.pane_id, w.name]));
    const liveness = await Promise.all(workerPaneIds.map(async (paneId) => [paneId, await getWorkerLiveness2(paneId)]));
    const aliveWorkers = liveness.filter(([, state]) => state === "alive").map(([paneId]) => paneById.get(paneId) ?? paneId);
    if (aliveWorkers.length > 0) {
      process.stderr.write(`[team/runtime-v2] preserving worktrees/state because worker pane(s) are still alive: ${aliveWorkers.join(", ")}
`);
      await finalizeAutoMerge();
      return;
    }
    const unknownWorkers = liveness.filter(([, state]) => state === "unknown").map(([paneId]) => paneById.get(paneId) ?? paneId);
    if (unknownWorkers.length > 0) {
      process.stderr.write(`[team/runtime-v2] preserving worktrees/state because worker pane liveness is unknown: ${unknownWorkers.join(", ")}
`);
      await finalizeAutoMerge();
      return;
    }
  } catch (err) {
    process.stderr.write(`[team/runtime-v2] tmux cleanup: ${err}
`);
    if (recordedWorkerPaneIds.length > 0) {
      process.stderr.write("[team/runtime-v2] preserving worktrees/state because tmux cleanup did not prove worker panes exited\n");
      await finalizeAutoMerge();
      return;
    }
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
  await finalizeAutoMerge();
  await commitStoppedFence();
  let preservedWorktrees = 0;
  try {
    const worktreeCleanup = cleanupTeamWorktrees(sanitized, cwd);
    preservedWorktrees = worktreeCleanup.preserved.length;
  } catch (err) {
    preservedWorktrees = 1;
    process.stderr.write(`[team/runtime-v2] worktree cleanup: ${err}
`);
  }
  if (preservedWorktrees === 0) {
    await cleanupTeamState(sanitized, cwd);
  } else {
    process.stderr.write(`[team/runtime-v2] preserved ${preservedWorktrees} worktree(s); keeping team state for follow-up cleanup
`);
  }
}
async function resumeTeamV2(teamName, cwd) {
  const sanitized = sanitizeTeamName(teamName);
  const config = await readTeamConfig(sanitized, cwd);
  if (!config) return null;
  try {
    const sessionName2 = config.tmux_session || `omc-team-${sanitized}`;
    await tmuxExecAsync(["has-session", "-t", sessionName2.split(":")[0]]);
    return {
      teamName: sanitized,
      sanitizedName: sanitized,
      sessionName: sessionName2,
      ownsWindow: config.tmux_window_owned === true,
      config,
      cwd
    };
  } catch {
    return null;
  }
}
async function findActiveTeamsV2(cwd) {
  const root = join28(getOmcRoot(cwd), "state", "team");
  if (!existsSync24(root)) return [];
  const entries = await readdir3(root, { withFileTypes: true });
  const active = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const teamName = e.name;
    const config = await readTeamConfig(teamName, cwd);
    if (config) {
      active.push(teamName);
    }
  }
  return active;
}
var runtimeOwnerRecoveryClient, orchestratorByTeam, CURSOR_UNSUPPORTED_REVIEW_INTENT_RE, CURSOR_EXECUTOR_CONTEXT_RE, CURSOR_EXECUTOR_CONTEXT_INTENTS, cadenceByTeam, MONITOR_SIGNAL_STALE_MS, pendingRecoveryPanes, BOOTSTRAP_RECOVERY_EVIDENCE_POLL_MS, BOOTSTRAP_RECOVERY_EVIDENCE_MAX_WAIT_MS, CIRCUIT_BREAKER_THRESHOLD, CircuitBreakerV2;
var init_runtime_v2 = __esm({
  "src/team/runtime-v2.ts"() {
    "use strict";
    init_tmux_utils();
    init_state_paths();
    init_worktree_paths();
    init_allocation_policy();
    init_monitor();
    init_events();
    init_governance();
    init_phase_controller();
    init_team_name();
    init_contracts();
    init_model_contract();
    init_tmux_session();
    init_worker_bootstrap();
    init_mcp_comm();
    init_git_worktree();
    init_omc_cli_rendering();
    init_swallowed_error();
    init_types();
    init_loader();
    init_stage_router();
    init_role_router();
    init_types2();
    init_cli_worker_contract();
    init_merge_orchestrator();
    init_leader_inbox();
    init_runtime_flags();
    init_worker_commit_cadence();
    init_recovery_request_store();
    init_runtime_owner_client();
    init_recovery_saga();
    init_task_recovery_checkpoint();
    init_team_ops();
    init_team_owner_epoch();
    init_process_identity_lock();
    init_worker_activation_gate();
    init_runtime_flags();
    orchestratorByTeam = /* @__PURE__ */ new Map();
    CURSOR_UNSUPPORTED_REVIEW_INTENT_RE = /\b(?:review|audit|critic|critique|security|vulnerabilit|cve|owasp|xss|csrf|sqli|verdict|approval|approve|final\s+decision)\b/i;
    CURSOR_EXECUTOR_CONTEXT_RE = /\b(?:implement|implementation|apply|edit|patch|fix|build|ci|lint|compile|tsc|type.?check|test|tests|debug|troubleshoot|investigate|root.?cause|diagnos|refactor|clean\s*up|simplif)\b/i;
    CURSOR_EXECUTOR_CONTEXT_INTENTS = /* @__PURE__ */ new Set([
      "implementation",
      "build-fix",
      "debug",
      "cleanup",
      "verification"
    ]);
    cadenceByTeam = /* @__PURE__ */ new Map();
    MONITOR_SIGNAL_STALE_MS = 3e4;
    pendingRecoveryPanes = /* @__PURE__ */ new Map();
    BOOTSTRAP_RECOVERY_EVIDENCE_POLL_MS = 25;
    BOOTSTRAP_RECOVERY_EVIDENCE_MAX_WAIT_MS = 1e3;
    CIRCUIT_BREAKER_THRESHOLD = 3;
    CircuitBreakerV2 = class {
      constructor(teamName, cwd, threshold = CIRCUIT_BREAKER_THRESHOLD) {
        this.teamName = teamName;
        this.cwd = cwd;
        this.threshold = threshold;
      }
      consecutiveFailures = 0;
      tripped = false;
      recordSuccess() {
        this.consecutiveFailures = 0;
      }
      async recordFailure(reason) {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.threshold && !this.tripped) {
          this.tripped = true;
          await writeWatchdogFailedMarker(this.teamName, this.cwd, reason);
          return true;
        }
        return false;
      }
      isTripped() {
        return this.tripped;
      }
    };
  }
});

// src/cli/team.ts
import { randomUUID as randomUUID11 } from "crypto";
import { spawn as spawn2 } from "child_process";
import { existsSync as existsSync27, mkdirSync as mkdirSync8, readFileSync as readFileSync17, writeFileSync as writeFileSync7 } from "fs";
import { readFile as readFile14, rm as rm5 } from "fs/promises";
import { dirname as dirname23, join as join31 } from "path";
import { fileURLToPath as fileURLToPath3 } from "url";

// src/team/api-interop.ts
init_worktree_paths();
init_contracts();
init_team_ops();
init_mcp_comm();
init_tmux_session();
init_dispatch_queue();
init_mailbox_notification_guard();
init_dispatch_queue();
init_worker_bootstrap();
import { existsSync as existsSync25, readFileSync as readFileSync15 } from "node:fs";
import { dirname as dirname22, join as join29, resolve as resolvePath } from "node:path";

// src/team/runtime.ts
init_tmux_utils();
init_model_contract();
init_team_name();
init_tmux_session();
init_worker_bootstrap();
init_git_worktree();
init_atomic_write();
import { mkdir as mkdir6, readFile as readFile8, rm as rm3, rename as rename3, writeFile as writeFile4 } from "fs/promises";
import { join as join21 } from "path";
import { existsSync as existsSync17 } from "fs";

// src/team/task-file-ops.ts
init_worktree_paths();
init_config_dir();
init_tmux_session();
init_fs_utils();
init_platform();
init_state_paths();
import { readFileSync as readFileSync11, readdirSync as readdirSync6, existsSync as existsSync16, openSync as openSync4, closeSync as closeSync4, unlinkSync as unlinkSync8, writeSync as writeSync4, statSync as statSync3, constants as fsConstants2 } from "fs";
import { join as join20 } from "path";

// src/team/runtime.ts
function stateRoot(cwd, teamName) {
  validateTeamName(teamName);
  return join21(cwd, `.omc/state/team/${teamName}`);
}
async function writeJson(filePath, data) {
  await atomicWriteJson2(filePath, data);
}
async function readJsonSafe3(filePath) {
  const isDoneSignalPath = filePath.endsWith("done.json");
  const maxAttempts = isDoneSignalPath ? 4 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const content = await readFile8(filePath, "utf-8");
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
    await new Promise((resolve7) => setTimeout(resolve7, 25));
  }
  return null;
}
function taskPath(root, taskId) {
  return join21(root, "tasks", `${taskId}.json`);
}
async function readTask(root, taskId) {
  return readJsonSafe3(taskPath(root, taskId));
}
async function monitorTeam(teamName, cwd, workerPaneIds) {
  validateTeamName(teamName);
  const monitorStartedAt = Date.now();
  const root = stateRoot(cwd, teamName);
  const taskScanStartedAt = Date.now();
  const taskCounts = { pending: 0, inProgress: 0, completed: 0, failed: 0 };
  try {
    const { readdir: readdir4 } = await import("fs/promises");
    const taskFiles = await readdir4(join21(root, "tasks"));
    for (const f of taskFiles.filter((f2) => f2.endsWith(".json"))) {
      const task = await readJsonSafe3(join21(root, "tasks", f));
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
    const heartbeatPath = join21(root, "workers", wName, "heartbeat.json");
    const heartbeat = await readJsonSafe3(heartbeatPath);
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
async function shutdownTeam(teamName, sessionName2, cwd, timeoutMs = 3e4, workerPaneIds, leaderPaneId, ownsWindow) {
  const root = stateRoot(cwd, teamName);
  await writeJson(join21(root, "shutdown.json"), {
    requestedAt: (/* @__PURE__ */ new Date()).toISOString(),
    teamName
  });
  const configData = await readJsonSafe3(join21(root, "config.json"));
  const CLI_AGENT_TYPES = /* @__PURE__ */ new Set(["claude", "codex", "gemini", "grok", "cursor", "antigravity"]);
  const agentTypes = configData?.agentTypes ?? [];
  const isCliWorkerTeam = agentTypes.length > 0 && agentTypes.every((t) => CLI_AGENT_TYPES.has(t));
  if (!isCliWorkerTeam) {
    const deadline = Date.now() + timeoutMs;
    const workerCount = configData?.workerCount ?? 0;
    const expectedAcks = Array.from({ length: workerCount }, (_, i) => `worker-${i + 1}`);
    while (Date.now() < deadline && expectedAcks.length > 0) {
      for (const wName of [...expectedAcks]) {
        const ackPath = join21(root, "workers", wName, "shutdown-ack.json");
        if (existsSync17(ackPath)) {
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
    await rm3(root, { recursive: true, force: true });
  } catch {
  }
}
async function resumeTeam(teamName, cwd) {
  const root = stateRoot(cwd, teamName);
  const configData = await readJsonSafe3(join21(root, "config.json"));
  if (!configData) return null;
  const sName = configData.tmuxSession || `omc-team-${teamName}`;
  try {
    await tmuxExecAsync(["has-session", "-t", sName.split(":")[0]]);
  } catch {
    return null;
  }
  const paneTarget = sName.includes(":") ? sName : sName.split(":")[0];
  const panesResult = await tmuxExecAsync([
    "list-panes",
    "-t",
    paneTarget,
    "-F",
    "#{pane_id}"
  ]);
  const allPanes = panesResult.stdout.trim().split("\n").filter(Boolean);
  const workerPaneIds = allPanes.slice(1);
  const workerNames = workerPaneIds.map((_, i) => `worker-${i + 1}`);
  const paneByWorker = new Map(
    workerNames.map((wName, i) => [wName, workerPaneIds[i] ?? ""])
  );
  const activeWorkers = /* @__PURE__ */ new Map();
  for (let i = 0; i < configData.tasks.length; i++) {
    const taskId = String(i + 1);
    const task = await readTask(root, taskId);
    if (task?.status === "in_progress" && task.owner) {
      const paneId = paneByWorker.get(task.owner) ?? "";
      activeWorkers.set(task.owner, {
        paneId,
        taskId,
        spawnedAt: task.assignedAt ? new Date(task.assignedAt).getTime() : Date.now()
      });
    }
  }
  return {
    teamName,
    sessionName: sName,
    leaderPaneId: configData.leaderPaneId ?? allPanes[0] ?? "",
    config: configData,
    workerNames,
    workerPaneIds,
    activeWorkers,
    cwd,
    ownsWindow: Boolean(configData.tmuxOwnsWindow)
  };
}

// src/team/api-interop.ts
init_runtime_v2();
init_recovery_request_store();
init_git_worktree();
init_swallowed_error();
var TEAM_UPDATE_TASK_MUTABLE_FIELDS = /* @__PURE__ */ new Set(["subject", "description", "blocked_by", "requires_code_change", "delegation"]);
var TEAM_UPDATE_TASK_REQUEST_FIELDS = /* @__PURE__ */ new Set(["team_name", "task_id", "workingDirectory", ...TEAM_UPDATE_TASK_MUTABLE_FIELDS]);
var RECOVER_WORKER_REQUEST_FIELDS = /* @__PURE__ */ new Set(["team_name", "worker", "request_id", "timeout_ms"]);
var WRITE_TASK_CHECKPOINT_REQUEST_FIELDS = /* @__PURE__ */ new Set([
  "team_name",
  "task_id",
  "worker",
  "claim_token",
  "task_version",
  "sequence",
  "resume_payload"
]);
var READ_RECOVERY_RESULT_REQUEST_FIELDS = /* @__PURE__ */ new Set(["team_name", "request_id"]);
var RECOVERY_ERROR_CODES = /* @__PURE__ */ new Set([
  "invalid_input",
  "team_not_found",
  "worker_not_found",
  "worker_not_dead",
  "runtime_v2_required",
  "invalid_persisted_state",
  "runtime_owner_unavailable",
  "runtime_owner_fence_lost",
  "recovery_request_timeout",
  "recovery_attempt_conflict",
  "team_mutation_busy",
  "team_mutation_resume_required",
  "team_shutting_down",
  "team_session_dead",
  "worker_liveness_unknown",
  "recovery_checkpoint_missing",
  "recovery_checkpoint_malformed",
  "recovery_checkpoint_ambiguous",
  "recovery_checkpoint_stale",
  "task_requeue_failed",
  "launch_metadata_incomplete",
  "launch_descriptor_unresolvable",
  "spawn_failed",
  "startup_ack_timeout",
  "worker_activation_failed",
  "auto_merge_unavailable",
  "stale_state_revision",
  "config_commit_failed"
]);
var TEAM_API_OPERATIONS = [
  "send-message",
  "broadcast",
  "mailbox-list",
  "mailbox-mark-delivered",
  "mailbox-mark-notified",
  "create-task",
  "read-task",
  "list-tasks",
  "update-task",
  "claim-task",
  "transition-task-status",
  "release-task-claim",
  "read-config",
  "read-manifest",
  "read-worker-status",
  "read-worker-heartbeat",
  "update-worker-heartbeat",
  "write-worker-inbox",
  "write-worker-identity",
  "append-event",
  "get-summary",
  "cleanup",
  "write-shutdown-request",
  "read-shutdown-ack",
  "read-monitor-snapshot",
  "write-monitor-snapshot",
  "read-task-approval",
  "write-task-approval",
  "orphan-cleanup",
  "recover-worker",
  "write-task-checkpoint",
  "read-recovery-result"
];
function isFiniteInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value);
}
function parseValidatedTaskIdArray(value, fieldName) {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array of task IDs (strings)`);
  }
  const taskIds = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error(`${fieldName} entries must be strings`);
    }
    const normalized = item.trim();
    if (!TASK_ID_SAFE_PATTERN.test(normalized)) {
      throw new Error(`${fieldName} contains invalid task ID: "${item}"`);
    }
    taskIds.push(normalized);
  }
  return taskIds;
}
function parseTaskDelegationPlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("delegation must be an object");
  }
  const raw = value;
  const mode = raw.mode;
  if (mode !== "none" && mode !== "optional" && mode !== "auto" && mode !== "required") {
    throw new Error("delegation.mode must be one of: none, optional, auto, required");
  }
  const plan = { mode };
  if ("max_parallel_subtasks" in raw) {
    if (!isFiniteInteger(raw.max_parallel_subtasks) || raw.max_parallel_subtasks < 1) {
      throw new Error("delegation.max_parallel_subtasks must be a positive integer when provided");
    }
    plan.max_parallel_subtasks = raw.max_parallel_subtasks;
  }
  if ("required_parallel_probe" in raw) {
    if (typeof raw.required_parallel_probe !== "boolean") throw new Error("delegation.required_parallel_probe must be a boolean when provided");
    plan.required_parallel_probe = raw.required_parallel_probe;
  }
  if ("spawn_before_serial_search_threshold" in raw) {
    if (!isFiniteInteger(raw.spawn_before_serial_search_threshold) || raw.spawn_before_serial_search_threshold < 1) {
      throw new Error("delegation.spawn_before_serial_search_threshold must be a positive integer when provided");
    }
    plan.spawn_before_serial_search_threshold = raw.spawn_before_serial_search_threshold;
  }
  if ("child_model_policy" in raw) {
    const policy = raw.child_model_policy;
    if (policy !== "standard" && policy !== "fast" && policy !== "inherit" && policy !== "frontier") {
      throw new Error("delegation.child_model_policy must be one of: standard, fast, inherit, frontier");
    }
    plan.child_model_policy = policy;
  }
  if ("child_model" in raw) {
    if (typeof raw.child_model !== "string") throw new Error("delegation.child_model must be a string when provided");
    plan.child_model = raw.child_model;
  }
  if ("subtask_candidates" in raw) {
    if (!Array.isArray(raw.subtask_candidates) || !raw.subtask_candidates.every((item) => typeof item === "string")) {
      throw new Error("delegation.subtask_candidates must be an array of strings when provided");
    }
    plan.subtask_candidates = raw.subtask_candidates;
  }
  if ("child_report_format" in raw) {
    const format = raw.child_report_format;
    if (format !== "bullets" && format !== "json") throw new Error("delegation.child_report_format must be bullets or json when provided");
    plan.child_report_format = format;
  }
  if ("skip_allowed_reason_required" in raw) {
    if (typeof raw.skip_allowed_reason_required !== "boolean") throw new Error("delegation.skip_allowed_reason_required must be a boolean when provided");
    plan.skip_allowed_reason_required = raw.skip_allowed_reason_required;
  }
  return plan;
}
function teamStateExists(teamName, candidateCwd) {
  if (!TEAM_NAME_SAFE_PATTERN.test(teamName)) return false;
  const teamRoot = join29(getOmcRoot(candidateCwd), "state", "team", teamName);
  return existsSync25(join29(teamRoot, "config.json")) || existsSync25(join29(teamRoot, "tasks")) || existsSync25(teamRoot);
}
function parseTeamWorkerEnv(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const match = /^([a-z0-9][a-z0-9-]{0,29})\/(worker-\d+)$/.exec(raw.trim());
  if (!match) return null;
  return { teamName: match[1], workerName: match[2] };
}
function parseTeamWorkerContextFromEnv(env = process.env) {
  return parseTeamWorkerEnv(env.OMC_TEAM_WORKER) ?? parseTeamWorkerEnv(env.OMX_TEAM_WORKER);
}
function readTeamStateRootFromEnv(env = process.env) {
  const candidate = typeof env.OMC_TEAM_STATE_ROOT === "string" && env.OMC_TEAM_STATE_ROOT.trim() !== "" ? env.OMC_TEAM_STATE_ROOT.trim() : typeof env.OMX_TEAM_STATE_ROOT === "string" && env.OMX_TEAM_STATE_ROOT.trim() !== "" ? env.OMX_TEAM_STATE_ROOT.trim() : "";
  return candidate || null;
}
function isRuntimeV2Config(config) {
  return !!config && typeof config === "object" && Array.isArray(config.workers);
}
function isLegacyRuntimeConfig(config) {
  return !!config && typeof config === "object" && Array.isArray(config.agentTypes);
}
function assertNoNativeWorktreeCleanupEvidence(teamName, cwd) {
  const safety = inspectTeamWorktreeCleanupSafety(teamName, cwd);
  if (!safety.hasEvidence) return;
  const evidence = safety.blockers.length > 0 ? safety.blockers : safety.entries.map((entry) => ({
    workerName: entry.workerName,
    path: entry.path,
    reason: "worktree_cleanup_evidence_present"
  }));
  const details = evidence.map((item) => `${item.workerName}:${item.reason}:${item.path}`).join(";");
  throw new Error(`cleanup_blocked:worktree_cleanup_evidence_present:${details}`);
}
async function executeTeamCleanupViaRuntime(teamName, cwd) {
  let config;
  try {
    config = await teamReadConfig(teamName, cwd);
  } catch (error) {
    assertNoNativeWorktreeCleanupEvidence(teamName, cwd);
    throw error;
  }
  if (!config) {
    assertNoNativeWorktreeCleanupEvidence(teamName, cwd);
    await teamCleanup(teamName, cwd);
    return;
  }
  if (isRuntimeV2Config(config)) {
    await shutdownTeamV2(teamName, cwd);
    return;
  }
  if (isLegacyRuntimeConfig(config)) {
    const legacyConfig = config;
    const sessionName2 = typeof legacyConfig.tmuxSession === "string" && legacyConfig.tmuxSession.trim() !== "" ? legacyConfig.tmuxSession.trim() : `omc-team-${teamName}`;
    const leaderPaneId = typeof legacyConfig.leaderPaneId === "string" && legacyConfig.leaderPaneId.trim() !== "" ? legacyConfig.leaderPaneId.trim() : void 0;
    await shutdownTeam(teamName, sessionName2, cwd, 3e4, void 0, leaderPaneId, legacyConfig.tmuxOwnsWindow === true);
    return;
  }
  assertNoNativeWorktreeCleanupEvidence(teamName, cwd);
  await teamCleanup(teamName, cwd);
}
function readTeamStateRootFromFile(path4) {
  if (!existsSync25(path4)) return null;
  try {
    const parsed = JSON.parse(readFileSync15(path4, "utf8"));
    return typeof parsed.team_state_root === "string" && parsed.team_state_root.trim() !== "" ? parsed.team_state_root.trim() : null;
  } catch {
    return null;
  }
}
function stateRootToWorkingDirectory(stateRoot2) {
  const absolute = resolvePath(stateRoot2);
  const normalized = absolute.replaceAll("\\", "/");
  for (const marker of ["/.omc/state/team/", "/.omx/state/team/"]) {
    const idx = normalized.lastIndexOf(marker);
    if (idx >= 0) {
      const workspaceRoot = absolute.slice(0, idx);
      if (workspaceRoot && workspaceRoot !== "/") return workspaceRoot;
      return dirname22(dirname22(dirname22(dirname22(absolute))));
    }
  }
  for (const marker of ["/.omc/state", "/.omx/state"]) {
    const idx = normalized.lastIndexOf(marker);
    if (idx >= 0) {
      const workspaceRoot = absolute.slice(0, idx);
      if (workspaceRoot && workspaceRoot !== "/") return workspaceRoot;
      return dirname22(dirname22(absolute));
    }
  }
  return dirname22(dirname22(absolute));
}
function resolveTeamWorkingDirectoryFromMetadata(teamName, candidateCwd, workerContext) {
  const teamRoot = join29(getOmcRoot(candidateCwd), "state", "team", teamName);
  if (!existsSync25(teamRoot)) return null;
  if (workerContext?.teamName === teamName) {
    const workerRoot = readTeamStateRootFromFile(join29(teamRoot, "workers", workerContext.workerName, "identity.json"));
    if (workerRoot) return stateRootToWorkingDirectory(workerRoot);
  }
  const fromConfig = readTeamStateRootFromFile(join29(teamRoot, "config.json"));
  if (fromConfig) return stateRootToWorkingDirectory(fromConfig);
  for (const manifestName of ["manifest.json", "manifest.v2.json"]) {
    const fromManifest = readTeamStateRootFromFile(join29(teamRoot, manifestName));
    if (fromManifest) return stateRootToWorkingDirectory(fromManifest);
  }
  return null;
}
function resolveTeamWorkingDirectory(teamName, preferredCwd) {
  const normalizedTeamName = String(teamName || "").trim();
  if (!normalizedTeamName) return preferredCwd;
  const envTeamStateRoot = readTeamStateRootFromEnv();
  if (typeof envTeamStateRoot === "string" && envTeamStateRoot.trim() !== "") {
    const envWorkingDirectory = stateRootToWorkingDirectory(envTeamStateRoot.trim());
    if (teamStateExists(normalizedTeamName, envWorkingDirectory)) {
      return envWorkingDirectory;
    }
  }
  const seeds = [];
  for (const seed of [preferredCwd, process.cwd()]) {
    if (typeof seed !== "string" || seed.trim() === "") continue;
    if (!seeds.includes(seed)) seeds.push(seed);
  }
  const workerContext = parseTeamWorkerContextFromEnv();
  for (const seed of seeds) {
    let cursor = seed;
    while (cursor) {
      if (teamStateExists(normalizedTeamName, cursor)) {
        return resolveTeamWorkingDirectoryFromMetadata(normalizedTeamName, cursor, workerContext) ?? cursor;
      }
      const parent = dirname22(cursor);
      if (!parent || parent === cursor) break;
      cursor = parent;
    }
  }
  return preferredCwd;
}
function normalizeTeamName(toolOrOperationName) {
  const normalized = toolOrOperationName.trim().toLowerCase();
  const withoutPrefix = normalized.startsWith("team_") ? normalized.slice("team_".length) : normalized;
  return withoutPrefix.replaceAll("_", "-");
}
function resolveTeamApiOperation(name) {
  const normalized = normalizeTeamName(name);
  return TEAM_API_OPERATIONS.includes(normalized) ? normalized : null;
}
var WORKTREE_TRIGGER_STATE_ROOT = "$OMC_TEAM_STATE_ROOT";
function resolveInstructionStateRoot(worktreePath) {
  return worktreePath ? WORKTREE_TRIGGER_STATE_ROOT : void 0;
}
function hasExactText2(value) {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}
async function readMailboxGuardWithCanonicalLeaderTarget(input, cwd) {
  let configPromise;
  const readConfig = () => {
    configPromise ??= teamReadConfig(input.teamName, cwd);
    return configPromise;
  };
  return readCurrentMailboxNotificationGuard(input, cwd, {
    readConfig,
    readStrictDispatchRequest: async (teamName, requestId, requestCwd) => {
      const [dispatch, config] = await Promise.all([
        readDispatchRequestStrict(teamName, requestId, requestCwd),
        readConfig()
      ]);
      const canonicalLeaderPaneId = config?.leader_pane_id;
      if (dispatch.kind === "valid" && input.recipient === "leader-fixed" && dispatch.request.to_worker === "leader-fixed" && dispatch.request.pane_id === void 0 && hasExactText2(canonicalLeaderPaneId)) {
        return { kind: "valid", request: { ...dispatch.request, pane_id: canonicalLeaderPaneId } };
      }
      return dispatch;
    },
    readStrictMailboxMessage: teamReadCanonicalMailboxMessageStrict,
    verifyProviderOwnership: verifyTeamTargetOwnership
  });
}
async function notifyMailboxTarget(params) {
  return runMailboxNotificationAttempt({
    teamName: params.teamName,
    recipient: params.toWorker,
    requestId: params.requestId,
    messageId: params.messageId,
    triggerMessage: params.triggerMessage,
    cwd: params.cwd
  }, {
    readGuard: readMailboxGuardWithCanonicalLeaderTarget
  });
}
function findWorkerDispatchTarget(teamName, toWorker, cwd) {
  return teamReadConfig(teamName, cwd).then((config) => {
    if (toWorker === "leader-fixed") {
      return { paneId: config?.leader_pane_id ?? void 0 };
    }
    const recipient = config?.workers.find((worker) => worker.name === toWorker);
    return {
      paneId: recipient?.pane_id,
      workerIndex: recipient?.index,
      instructionStateRoot: resolveInstructionStateRoot(recipient?.worktree_path)
    };
  });
}
async function findMailboxDispatchRequestId(teamName, workerName, messageId, cwd) {
  const requests = await listDispatchRequests(
    teamName,
    cwd,
    { kind: "mailbox", to_worker: workerName }
  );
  const matching = requests.filter((request) => request.message_id === messageId).sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
  return matching[0]?.request_id ?? null;
}
async function syncMailboxDispatchNotified(teamName, workerName, messageId, cwd) {
  const logDispatchSyncFailure = createSwallowedErrorLogger(
    "team.api-interop syncMailboxDispatchNotified dispatch state sync failed"
  );
  const requestId = await findMailboxDispatchRequestId(teamName, workerName, messageId, cwd);
  if (!requestId) return;
  await markDispatchRequestNotified(
    teamName,
    requestId,
    { message_id: messageId, last_reason: "mailbox_mark_notified" },
    cwd
  ).catch(logDispatchSyncFailure);
}
async function syncMailboxDispatchDelivered(teamName, workerName, messageId, cwd) {
  const logDispatchSyncFailure = createSwallowedErrorLogger(
    "team.api-interop syncMailboxDispatchDelivered dispatch state sync failed"
  );
  const requestId = await findMailboxDispatchRequestId(teamName, workerName, messageId, cwd);
  if (!requestId) return;
  await markDispatchRequestNotified(
    teamName,
    requestId,
    { message_id: messageId, last_reason: "mailbox_mark_delivered" },
    cwd
  ).catch(logDispatchSyncFailure);
  await markDispatchRequestDelivered(
    teamName,
    requestId,
    { message_id: messageId, last_reason: "mailbox_mark_delivered" },
    cwd
  ).catch(logDispatchSyncFailure);
}
function validateCommonFields(args) {
  const teamName = String(args.team_name || "").trim();
  if (teamName && !TEAM_NAME_SAFE_PATTERN.test(teamName)) {
    throw new Error(`Invalid team_name: "${teamName}". Must match /^[a-z0-9][a-z0-9-]{0,29}$/ (lowercase alphanumeric + hyphens, max 30 chars).`);
  }
  for (const workerField of ["worker", "from_worker", "to_worker"]) {
    const workerVal = String(args[workerField] || "").trim();
    if (workerVal && !WORKER_NAME_SAFE_PATTERN.test(workerVal)) {
      throw new Error(`Invalid ${workerField}: "${workerVal}". Must match /^[a-z0-9][a-z0-9-]{0,63}$/ (lowercase alphanumeric + hyphens, max 64 chars).`);
    }
  }
  const rawTaskId = String(args.task_id || "").trim();
  if (rawTaskId && !TASK_ID_SAFE_PATTERN.test(rawTaskId)) {
    throw new Error(`Invalid task_id: "${rawTaskId}". Must be a positive integer (digits only, max 20 digits).`);
  }
}
function unsupportedFields(args, allowed) {
  return Object.keys(args).filter((field) => !allowed.has(field));
}
function requiredString(args, field) {
  const value = args[field];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
async function executeTeamApiOperation(operation, args, fallbackCwd) {
  try {
    validateCommonFields(args);
    const teamNameForCwd = String(args.team_name || "").trim();
    const cwd = teamNameForCwd ? resolveTeamWorkingDirectory(teamNameForCwd, fallbackCwd) : fallbackCwd;
    switch (operation) {
      case "recover-worker": {
        const unsupported = unsupportedFields(args, RECOVER_WORKER_REQUEST_FIELDS);
        if (unsupported.length > 0) {
          return { ok: false, operation, error: { code: "invalid_input", message: `recover-worker received unsupported fields: ${unsupported.join(", ")}` } };
        }
        const teamName = requiredString(args, "team_name");
        const workerName = requiredString(args, "worker");
        const requestId = args.request_id;
        const timeoutMs = args.timeout_ms;
        const normalizedRequestId = typeof requestId === "string" ? requestId.trim() : void 0;
        if (!teamName || !workerName || requestId !== void 0 && (normalizedRequestId === void 0 || !isSafeRecoveryRequestId(normalizedRequestId)) || timeoutMs !== void 0 && (!isFiniteInteger(timeoutMs) || timeoutMs < 18e4 || timeoutMs > 3e5)) {
          return { ok: false, operation, error: { code: "invalid_input", message: "team_name and worker are required; request_id must be a path-safe 1-128 character opaque identifier and timeout_ms must be an integer from 180000 through 300000 when provided" } };
        }
        let result;
        try {
          result = await recoverDeadWorkerV2(teamName, cwd, {
            workerName,
            requestId: normalizedRequestId,
            timeoutMs
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (RECOVERY_ERROR_CODES.has(message)) {
            return { ok: false, operation, error: { code: message, message } };
          }
          throw error;
        }
        return { ok: true, operation, data: { result } };
      }
      case "write-task-checkpoint": {
        const unsupported = unsupportedFields(args, WRITE_TASK_CHECKPOINT_REQUEST_FIELDS);
        if (unsupported.length > 0) {
          return { ok: false, operation, error: { code: "invalid_input", message: `write-task-checkpoint received unsupported fields: ${unsupported.join(", ")}` } };
        }
        const teamName = requiredString(args, "team_name");
        const taskId = requiredString(args, "task_id");
        const workerName = requiredString(args, "worker");
        const claimToken = requiredString(args, "claim_token");
        const taskVersion = args.task_version;
        const sequence = args.sequence;
        if (!teamName || !taskId || !workerName || !claimToken || !Object.hasOwn(args, "resume_payload") || !isFiniteInteger(taskVersion) || taskVersion <= 0 || !isFiniteInteger(sequence) || sequence <= 0) {
          return { ok: false, operation, error: { code: "invalid_input", message: "team_name, task_id, worker, claim_token, positive task_version, positive sequence, and resume_payload are required" } };
        }
        const workerContext = parseTeamWorkerContextFromEnv();
        if (!workerContext) {
          return { ok: false, operation, error: { code: "worker_auth_required", message: "write-task-checkpoint requires OMC_TEAM_WORKER or OMX_TEAM_WORKER authentication" } };
        }
        if (workerContext.teamName !== teamName || workerContext.workerName !== workerName) {
          return { ok: false, operation, error: { code: "worker_auth_mismatch", message: "authenticated worker does not match team_name and worker" } };
        }
        const result = await teamPublishTaskRecoveryCheckpoint({
          teamName,
          taskId,
          workerName,
          claimToken,
          taskVersion,
          sequence,
          resumePayload: args.resume_payload
        }, cwd);
        return result.ok ? { ok: true, operation, data: result } : { ok: false, operation, error: { code: result.error, message: result.error } };
      }
      case "read-recovery-result": {
        const unsupported = unsupportedFields(args, READ_RECOVERY_RESULT_REQUEST_FIELDS);
        const teamName = requiredString(args, "team_name");
        const requestId = requiredString(args, "request_id");
        if (unsupported.length > 0 || !teamName || !requestId) {
          return {
            ok: false,
            operation,
            error: {
              code: "invalid_input",
              message: unsupported.length > 0 ? `read-recovery-result received unsupported fields: ${unsupported.join(", ")}` : "team_name and request_id are required"
            }
          };
        }
        const outcome = readRecoverDeadWorkerV2Outcome(cwd, requestId);
        return outcome ? { ok: true, operation, data: { outcome } } : { ok: false, operation, error: { code: "recovery_result_not_found", message: "recovery_result_not_found" } };
      }
      case "send-message": {
        const teamName = String(args.team_name || "").trim();
        const fromWorker = String(args.from_worker || "").trim();
        const toWorker = String(args.to_worker || "").trim();
        const body = String(args.body || "").trim();
        if (!fromWorker) {
          return { ok: false, operation, error: { code: "invalid_input", message: "from_worker is required. You must identify yourself." } };
        }
        if (!teamName || !toWorker || !body) {
          return { ok: false, operation, error: { code: "invalid_input", message: "team_name, from_worker, to_worker, body are required" } };
        }
        let message = null;
        const target = await findWorkerDispatchTarget(teamName, toWorker, cwd);
        const notificationOutcome = await queueDirectMailboxMessage({
          teamName,
          fromWorker,
          toWorker,
          toWorkerIndex: target.workerIndex,
          toPaneId: target.paneId,
          body,
          triggerMessage: generateMailboxTriggerMessage(teamName, toWorker, 1, target.instructionStateRoot),
          cwd,
          notify: (_target, resolvedTriggerMessage, context) => notifyMailboxTarget({
            teamName,
            toWorker: context.request.to_worker,
            triggerMessage: resolvedTriggerMessage,
            requestId: context.request.request_id,
            messageId: context.message_id ?? context.request.message_id ?? "",
            cwd
          }),
          deps: {
            sendDirectMessage: async (resolvedTeamName, resolvedFromWorker, resolvedToWorker, resolvedBody, resolvedCwd) => {
              message = await teamSendMessage(resolvedTeamName, resolvedFromWorker, resolvedToWorker, resolvedBody, resolvedCwd);
              return message;
            },
            broadcastMessage: teamBroadcast,
            markMessageNotified: (resolvedTeamName, workerName, messageId, resolvedCwd) => teamMarkMessageNotified(resolvedTeamName, workerName, messageId, resolvedCwd)
          }
        });
        return { ok: true, operation, data: { message, notification_outcome: notificationOutcome } };
      }
      case "broadcast": {
        const teamName = String(args.team_name || "").trim();
        const fromWorker = String(args.from_worker || "").trim();
        const body = String(args.body || "").trim();
        if (!teamName || !fromWorker || !body) {
          return { ok: false, operation, error: { code: "invalid_input", message: "team_name, from_worker, body are required" } };
        }
        const messages = [];
        const config = await teamReadConfig(teamName, cwd);
        if (!config) throw new Error(`Team ${teamName} not found`);
        const recipients = config.workers.filter((worker) => worker.name !== fromWorker).map((worker) => ({
          workerName: worker.name,
          workerIndex: worker.index,
          paneId: worker.pane_id,
          instructionStateRoot: resolveInstructionStateRoot(worker.worktree_path)
        }));
        const notificationOutcomes = await queueBroadcastMailboxMessage({
          teamName,
          fromWorker,
          recipients,
          body,
          cwd,
          triggerFor: (workerName) => generateMailboxTriggerMessage(
            teamName,
            workerName,
            1,
            recipients.find((recipient) => recipient.workerName === workerName)?.instructionStateRoot
          ),
          notify: (_target, resolvedTriggerMessage, context) => notifyMailboxTarget({
            teamName,
            toWorker: context.request.to_worker,
            triggerMessage: resolvedTriggerMessage,
            requestId: context.request.request_id,
            messageId: context.message_id ?? context.request.message_id ?? "",
            cwd
          }),
          deps: {
            sendDirectMessage: async (resolvedTeamName, resolvedFromWorker, resolvedToWorker, resolvedBody, resolvedCwd) => {
              const message = await teamSendMessage(
                resolvedTeamName,
                resolvedFromWorker,
                resolvedToWorker,
                resolvedBody,
                resolvedCwd
              );
              messages.push(message);
              return message;
            },
            // queueBroadcastMailboxMessage persists from the recipient snapshot via sendDirectMessage.
            broadcastMessage: async () => [],
            markMessageNotified: (resolvedTeamName, workerName, messageId, resolvedCwd) => teamMarkMessageNotified(resolvedTeamName, workerName, messageId, resolvedCwd)
          }
        });
        return { ok: true, operation, data: { count: messages.length, messages, notification_outcomes: notificationOutcomes } };
      }
      case "mailbox-list": {
        const teamName = String(args.team_name || "").trim();
        const worker = String(args.worker || "").trim();
        const includeDelivered = args.include_delivered !== false;
        if (!teamName || !worker) {
          return { ok: false, operation, error: { code: "invalid_input", message: "team_name and worker are required" } };
        }
        const all = await teamListMailbox(teamName, worker, cwd);
        const messages = includeDelivered ? all : all.filter((m) => !m.delivered_at);
        return { ok: true, operation, data: { worker, count: messages.length, messages } };
      }
      case "mailbox-mark-delivered": {
        const teamName = String(args.team_name || "").trim();
        const worker = String(args.worker || "").trim();
        const messageId = String(args.message_id || "").trim();
        if (!teamName || !worker || !messageId) {
          return { ok: false, operation, error: { code: "invalid_input", message: "team_name, worker, message_id are required" } };
        }
        const updated = await teamMarkMessageDelivered(teamName, worker, messageId, cwd);
        if (updated) {
          await syncMailboxDispatchDelivered(teamName, worker, messageId, cwd);
        }
        return { ok: true, operation, data: { worker, message_id: messageId, updated } };
      }
      case "mailbox-mark-notified": {
        const teamName = String(args.team_name || "").trim();
        const worker = String(args.worker || "").trim();
        const messageId = String(args.message_id || "").trim();
        if (!teamName || !worker || !messageId) {
          return { ok: false, operation, error: { code: "invalid_input", message: "team_name, worker, message_id are required" } };
        }
        const notified = await teamMarkMessageNotified(teamName, worker, messageId, cwd);
        if (notified) {
          await syncMailboxDispatchNotified(teamName, worker, messageId, cwd);
        }
        return { ok: true, operation, data: { worker, message_id: messageId, notified } };
      }
      case "create-task": {
        const teamName = String(args.team_name || "").trim();
        const subject = String(args.subject || "").trim();
        const description = String(args.description || "").trim();
        if (!teamName || !subject || !description) {
          return { ok: false, operation, error: { code: "invalid_input", message: "team_name, subject, description are required" } };
        }
        const owner = args.owner;
        const blockedBy = args.blocked_by;
        const requiresCodeChange = args.requires_code_change;
        let delegation;
        if ("delegation" in args) {
          try {
            delegation = parseTaskDelegationPlan(args.delegation);
          } catch (error) {
            return { ok: false, operation, error: { code: "invalid_input", message: error.message } };
          }
        }
        const task = await teamCreateTask(teamName, {
          subject,
          description,
          status: "pending",
          owner: owner || void 0,
          blocked_by: blockedBy,
          requires_code_change: requiresCodeChange,
          ...delegation ? { delegation } : {}
        }, cwd);
        return { ok: true, operation, data: { task } };
      }
      case "read-task": {
        const teamName = String(args.team_name || "").trim();
        const taskId = String(args.task_id || "").trim();
        if (!teamName || !taskId) {
          return { ok: false, operation, error: { code: "invalid_input", message: "team_name and task_id are required" } };
        }
        const task = await teamReadTask(teamName, taskId, cwd);
        return task ? { ok: true, operation, data: { task } } : { ok: false, operation, error: { code: "task_not_found", message: "task_not_found" } };
      }
      case "list-tasks": {
        const teamName = String(args.team_name || "").trim();
        if (!teamName) {
          return { ok: false, operation, error: { code: "invalid_input", message: "team_name is required" } };
        }
        const tasks = await teamListTasks(teamName, cwd);
        return { ok: true, operation, data: { count: tasks.length, tasks } };
      }
      case "update-task": {
        const teamName = String(args.team_name || "").trim();
        const taskId = String(args.task_id || "").trim();
        if (!teamName || !taskId) {
          return { ok: false, operation, error: { code: "invalid_input", message: "team_name and task_id are required" } };
        }
        const lifecycleFields = ["status", "owner", "result", "error"];
        const presentLifecycleFields = lifecycleFields.filter((f) => f in args);
        if (presentLifecycleFields.length > 0) {
          return { ok: false, operation, error: { code: "invalid_input", message: `team_update_task cannot mutate lifecycle fields: ${presentLifecycleFields.join(", ")}` } };
        }
        const unexpectedFields = Object.keys(args).filter((field) => !TEAM_UPDATE_TASK_REQUEST_FIELDS.has(field));
        if (unexpectedFields.length > 0) {
          return { ok: false, operation, error: { code: "invalid_input", message: `team_update_task received unsupported fields: ${unexpectedFields.join(", ")}` } };
        }
        const updates = {};
        if ("subject" in args) {
          if (typeof args.subject !== "string") {
            return { ok: false, operation, error: { code: "invalid_input", message: "subject must be a string when provided" } };
          }
          updates.subject = args.subject.trim();
        }
        if ("description" in args) {
          if (typeof args.description !== "string") {
            return { ok: false, operation, error: { code: "invalid_input", message: "description must be a string when provided" } };
          }
          updates.description = args.description.trim();
        }
        if ("requires_code_change" in args) {
          if (typeof args.requires_code_change !== "boolean") {
            return { ok: false, operation, error: { code: "invalid_input", message: "requires_code_change must be a boolean when provided" } };
          }
          updates.requires_code_change = args.requires_code_change;
        }
        if ("blocked_by" in args) {
          try {
            updates.blocked_by = parseValidatedTaskIdArray(args.blocked_by, "blocked_by");
          } catch (error) {
            return { ok: false, operation, error: { code: "invalid_input", message: error.message } };
          }
        }
        if ("delegation" in args) {
          try {
            updates.delegation = parseTaskDelegationPlan(args.delegation);
          } catch (error) {
            return { ok: false, operation, error: { code: "invalid_input", message: error.message } };
          }
        }
        const task = await teamUpdateTask(teamName, taskId, updates, cwd);
        return task ? { ok: true, operation, data: { task } } : { ok: false, operation, error: { code: "task_not_found", message: "task_not_found" } };
      }
      case "claim-task": {
        const teamName = String(args.team_name || "").trim();
        const taskId = String(args.task_id || "").trim();
        const worker = String(args.worker || "").trim();
        if (!teamName || !taskId || !worker) {
          return { ok: false, operation, error: { code: "invalid_input", message: "team_name, task_id, worker are required" } };
        }
        const rawExpectedVersion = args.expected_version;
        if (rawExpectedVersion !== void 0 && (!isFiniteInteger(rawExpectedVersion) || rawExpectedVersion < 1)) {
          return { ok: false, operation, error: { code: "invalid_input", message: "expected_version must be a positive integer when provided" } };
        }
        const result = await teamClaimTask(teamName, taskId, worker, rawExpectedVersion ?? null, cwd);
        return { ok: true, operation, data: result };
      }
      case "transition-task-status": {
        const teamName = String(args.team_name || "").trim();
        const taskId = String(args.task_id || "").trim();
        const from = String(args.from || "").trim();
        const to = String(args.to || "").trim();
        const claimToken = String(args.claim_token || "").trim();
        const transitionResult = args.result;
        const transitionError = args.error;
        if (!teamName || !taskId || !from || !to || !claimToken) {
          return { ok: false, operation, error: { code: "invalid_input", message: "team_name, task_id, from, to, claim_token are required" } };
        }
        const allowed = new Set(TEAM_TASK_STATUSES);
        if (!allowed.has(from) || !allowed.has(to)) {
          return { ok: false, operation, error: { code: "invalid_input", message: "from and to must be valid task statuses" } };
        }
        if (transitionResult !== void 0 && typeof transitionResult !== "string") {
          return { ok: false, operation, error: { code: "invalid_input", message: "result must be a string when provided" } };
        }
        if (transitionError !== void 0 && typeof transitionError !== "string") {
          return { ok: false, operation, error: { code: "invalid_input", message: "error must be a string when provided" } };
        }
        const result = await teamTransitionTaskStatus(
          teamName,
          taskId,
          from,
          to,
          claimToken,
          cwd,
          {
            result: typeof transitionResult === "string" ? transitionResult : void 0,
            error: typeof transitionError === "string" ? transitionError : void 0
          }
        );
        return { ok: true, operation, data: result };
      }
      case "release-task-claim": {
        const teamName = String(args.team_name || "").trim();
        const taskId = String(args.task_id || "").trim();
        const claimToken = String(args.claim_token || "").trim();
        const worker = String(args.worker || "").trim();
        if (!teamName || !taskId || !claimToken || !worker) {
          return { ok: false, operation, error: { code: "invalid_input", message: "team_name, task_id, claim_token, worker are required" } };
        }
        const result = await teamReleaseTaskClaim(teamName, taskId, claimToken, worker, cwd);
        return { ok: true, operation, data: result };
      }
      case "read-config": {
        const teamName = String(args.team_name || "").trim();
        if (!teamName) return { ok: false, operation, error: { code: "invalid_input", message: "team_name is required" } };
        const config = await teamReadConfig(teamName, cwd);
        return config ? { ok: true, operation, data: { config } } : { ok: false, operation, error: { code: "team_not_found", message: "team_not_found" } };
      }
      case "read-manifest": {
        const teamName = String(args.team_name || "").trim();
        if (!teamName) return { ok: false, operation, error: { code: "invalid_input", message: "team_name is required" } };
        const manifest = await teamReadManifest(teamName, cwd);
        return manifest ? { ok: true, operation, data: { manifest } } : { ok: false, operation, error: { code: "manifest_not_found", message: "manifest_not_found" } };
      }
      case "read-worker-status": {
        const teamName = String(args.team_name || "").trim();
        const worker = String(args.worker || "").trim();
        if (!teamName || !worker) return { ok: false, operation, error: { code: "invalid_input", message: "team_name and worker are required" } };
        const status = await teamReadWorkerStatus(teamName, worker, cwd);
        return { ok: true, operation, data: { worker, status } };
      }
      case "read-worker-heartbeat": {
        const teamName = String(args.team_name || "").trim();
        const worker = String(args.worker || "").trim();
        if (!teamName || !worker) return { ok: false, operation, error: { code: "invalid_input", message: "team_name and worker are required" } };
        const heartbeat = await teamReadWorkerHeartbeat(teamName, worker, cwd);
        return { ok: true, operation, data: { worker, heartbeat } };
      }
      case "update-worker-heartbeat": {
        const teamName = String(args.team_name || "").trim();
        const worker = String(args.worker || "").trim();
        const pid = args.pid;
        const turnCount = args.turn_count;
        const alive = args.alive;
        if (!teamName || !worker || typeof pid !== "number" || typeof turnCount !== "number" || typeof alive !== "boolean") {
          return { ok: false, operation, error: { code: "invalid_input", message: "team_name, worker, pid, turn_count, alive are required" } };
        }
        await teamUpdateWorkerHeartbeat(teamName, worker, { pid, turn_count: turnCount, alive, last_turn_at: (/* @__PURE__ */ new Date()).toISOString() }, cwd);
        return { ok: true, operation, data: { worker } };
      }
      case "write-worker-inbox": {
        const teamName = String(args.team_name || "").trim();
        const worker = String(args.worker || "").trim();
        const content = String(args.content || "").trim();
        if (!teamName || !worker || !content) {
          return { ok: false, operation, error: { code: "invalid_input", message: "team_name, worker, content are required" } };
        }
        await teamWriteWorkerInbox(teamName, worker, content, cwd);
        return { ok: true, operation, data: { worker } };
      }
      case "write-worker-identity": {
        const teamName = String(args.team_name || "").trim();
        const worker = String(args.worker || "").trim();
        const index = args.index;
        const role = String(args.role || "").trim();
        if (!teamName || !worker || typeof index !== "number" || !role) {
          return { ok: false, operation, error: { code: "invalid_input", message: "team_name, worker, index, role are required" } };
        }
        await teamWriteWorkerIdentity(teamName, worker, {
          name: worker,
          index,
          role,
          assigned_tasks: args.assigned_tasks ?? [],
          pid: args.pid,
          pane_id: args.pane_id,
          working_dir: args.working_dir,
          worktree_repo_root: args.worktree_repo_root,
          worktree_path: args.worktree_path,
          worktree_branch: args.worktree_branch,
          worktree_detached: args.worktree_detached,
          worktree_created: args.worktree_created,
          team_state_root: args.team_state_root
        }, cwd);
        return { ok: true, operation, data: { worker } };
      }
      case "append-event": {
        const teamName = String(args.team_name || "").trim();
        const eventType = String(args.type || "").trim();
        const worker = String(args.worker || "").trim();
        if (!teamName || !eventType || !worker) {
          return { ok: false, operation, error: { code: "invalid_input", message: "team_name, type, worker are required" } };
        }
        if (!TEAM_EVENT_TYPES.includes(eventType)) {
          return { ok: false, operation, error: { code: "invalid_input", message: `type must be one of: ${TEAM_EVENT_TYPES.join(", ")}` } };
        }
        const event = await teamAppendEvent(teamName, {
          type: eventType,
          worker,
          task_id: args.task_id,
          message_id: args.message_id ?? null,
          reason: args.reason
        }, cwd);
        return { ok: true, operation, data: { event } };
      }
      case "get-summary": {
        const teamName = String(args.team_name || "").trim();
        if (!teamName) return { ok: false, operation, error: { code: "invalid_input", message: "team_name is required" } };
        const summary = await teamGetSummary(teamName, cwd);
        return summary ? { ok: true, operation, data: { summary } } : { ok: false, operation, error: { code: "team_not_found", message: "team_not_found" } };
      }
      case "cleanup": {
        const teamName = String(args.team_name || "").trim();
        if (!teamName) return { ok: false, operation, error: { code: "invalid_input", message: "team_name is required" } };
        await executeTeamCleanupViaRuntime(teamName, cwd);
        return { ok: true, operation, data: { team_name: teamName } };
      }
      case "orphan-cleanup": {
        const teamName = String(args.team_name || "").trim();
        if (!teamName) return { ok: false, operation, error: { code: "invalid_input", message: "team_name is required" } };
        const safety = inspectTeamWorktreeCleanupSafety(teamName, cwd);
        if (safety.hasEvidence && args.acknowledge_lost_worktree_recovery !== true) {
          return {
            ok: false,
            operation,
            error: {
              code: "invalid_input",
              message: "orphan_cleanup_blocked:worktree_recovery_evidence_present; pass acknowledge_lost_worktree_recovery=true only after manually preserving or intentionally discarding worker worktrees and root AGENTS backups"
            }
          };
        }
        await teamCleanup(teamName, cwd);
        return { ok: true, operation, data: { team_name: teamName } };
      }
      case "write-shutdown-request": {
        const teamName = String(args.team_name || "").trim();
        const worker = String(args.worker || "").trim();
        const requestedBy = String(args.requested_by || "").trim();
        if (!teamName || !worker || !requestedBy) {
          return { ok: false, operation, error: { code: "invalid_input", message: "team_name, worker, requested_by are required" } };
        }
        await teamWriteShutdownRequest(teamName, worker, requestedBy, cwd);
        return { ok: true, operation, data: { worker } };
      }
      case "read-shutdown-ack": {
        const teamName = String(args.team_name || "").trim();
        const worker = String(args.worker || "").trim();
        if (!teamName || !worker) {
          return { ok: false, operation, error: { code: "invalid_input", message: "team_name and worker are required" } };
        }
        const ack = await teamReadShutdownAck(teamName, worker, cwd, args.min_updated_at);
        return { ok: true, operation, data: { worker, ack } };
      }
      case "read-monitor-snapshot": {
        const teamName = String(args.team_name || "").trim();
        if (!teamName) return { ok: false, operation, error: { code: "invalid_input", message: "team_name is required" } };
        const snapshot = await teamReadMonitorSnapshot(teamName, cwd);
        return { ok: true, operation, data: { snapshot } };
      }
      case "write-monitor-snapshot": {
        const teamName = String(args.team_name || "").trim();
        const snapshot = args.snapshot;
        if (!teamName || !snapshot) {
          return { ok: false, operation, error: { code: "invalid_input", message: "team_name and snapshot are required" } };
        }
        await teamWriteMonitorSnapshot(teamName, snapshot, cwd);
        return { ok: true, operation, data: {} };
      }
      case "read-task-approval": {
        const teamName = String(args.team_name || "").trim();
        const taskId = String(args.task_id || "").trim();
        if (!teamName || !taskId) {
          return { ok: false, operation, error: { code: "invalid_input", message: "team_name and task_id are required" } };
        }
        const approval = await teamReadTaskApproval(teamName, taskId, cwd);
        return { ok: true, operation, data: { approval } };
      }
      case "write-task-approval": {
        const teamName = String(args.team_name || "").trim();
        const taskId = String(args.task_id || "").trim();
        const status = String(args.status || "").trim();
        const reviewer = String(args.reviewer || "").trim();
        const decisionReason = String(args.decision_reason || "").trim();
        if (!teamName || !taskId || !status || !reviewer || !decisionReason) {
          return { ok: false, operation, error: { code: "invalid_input", message: "team_name, task_id, status, reviewer, decision_reason are required" } };
        }
        if (!TEAM_TASK_APPROVAL_STATUSES.includes(status)) {
          return { ok: false, operation, error: { code: "invalid_input", message: `status must be one of: ${TEAM_TASK_APPROVAL_STATUSES.join(", ")}` } };
        }
        const rawRequired = args.required;
        if (rawRequired !== void 0 && typeof rawRequired !== "boolean") {
          return { ok: false, operation, error: { code: "invalid_input", message: "required must be a boolean when provided" } };
        }
        await teamWriteTaskApproval(teamName, {
          task_id: taskId,
          required: rawRequired !== false,
          status,
          reviewer,
          decision_reason: decisionReason,
          decided_at: (/* @__PURE__ */ new Date()).toISOString()
        }, cwd);
        return { ok: true, operation, data: { task_id: taskId, status } };
      }
    }
  } catch (error) {
    return {
      ok: false,
      operation,
      error: {
        code: "operation_failed",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

// src/cli/team.ts
init_git_worktree();
init_tmux_session();
init_team_name();
init_monitor();
init_platform();
init_paths();

// src/planning/artifacts.ts
init_worktree_paths();
import { readdirSync as readdirSync9, readFileSync as readFileSync16, existsSync as existsSync26 } from "fs";
import { join as join30 } from "path";

// src/planning/artifact-names.ts
import { basename as basename11 } from "path";
var PLANNING_ARTIFACT_TIMESTAMP_PATTERN = /^\d{8}T\d{6}Z$/;
function legacyTestSpecSlug(fileNameOrPath) {
  const match = basename11(fileNameOrPath).match(/^test-?spec-(?<slug>.+)\.md$/i);
  return match?.groups?.slug ?? null;
}
function requiredTimestampedTestSpecFileName(prdArtifact) {
  return prdArtifact.kind === "prd" && prdArtifact.timestamp ? `test-spec-${prdArtifact.timestamp}-${prdArtifact.slug}.md` : null;
}
function splitTimestampPrefix(rawSlug) {
  const separatorIndex = rawSlug.indexOf("-");
  if (separatorIndex === -1) {
    return { slug: rawSlug };
  }
  const prefix = rawSlug.slice(0, separatorIndex);
  if (!PLANNING_ARTIFACT_TIMESTAMP_PATTERN.test(prefix)) {
    return { slug: rawSlug };
  }
  return {
    timestamp: prefix,
    slug: rawSlug.slice(separatorIndex + 1)
  };
}
function parsePlanningArtifactFileName(fileNameOrPath) {
  const fileName = basename11(fileNameOrPath);
  const autoresearchDeepInterviewMatch = fileName.match(
    /^deep-interview-autoresearch-(?<slug>.+)\.md$/i
  );
  if (autoresearchDeepInterviewMatch?.groups?.slug) {
    const parsedSlug = splitTimestampPrefix(autoresearchDeepInterviewMatch.groups.slug);
    if (!parsedSlug.slug) return null;
    return {
      kind: "deep-interview-autoresearch",
      ...parsedSlug
    };
  }
  const deepInterviewMatch = fileName.match(/^deep-interview-(?<slug>.+)\.md$/i);
  if (deepInterviewMatch?.groups?.slug) {
    const parsedSlug = splitTimestampPrefix(deepInterviewMatch.groups.slug);
    if (!parsedSlug.slug) return null;
    return {
      kind: "deep-interview",
      ...parsedSlug
    };
  }
  const prdMatch = fileName.match(/^prd-(?<slug>.+)\.md$/i);
  if (prdMatch?.groups?.slug) {
    const parsedSlug = splitTimestampPrefix(prdMatch.groups.slug);
    if (!parsedSlug.slug) return null;
    return {
      kind: "prd",
      ...parsedSlug
    };
  }
  const testSpecMatch = fileName.match(/^test-?spec-(?<slug>.+)\.md$/i);
  if (testSpecMatch?.groups?.slug) {
    const parsedSlug = splitTimestampPrefix(testSpecMatch.groups.slug);
    if (!parsedSlug.slug) return null;
    return {
      kind: "test-spec",
      ...parsedSlug
    };
  }
  return null;
}
function comparePlanningArtifactPaths(left, right) {
  const leftParsed = parsePlanningArtifactFileName(left);
  const rightParsed = parsePlanningArtifactFileName(right);
  if (leftParsed?.timestamp && rightParsed?.timestamp && leftParsed.timestamp !== rightParsed.timestamp) {
    return leftParsed.timestamp.localeCompare(rightParsed.timestamp);
  }
  if (leftParsed?.timestamp && !rightParsed?.timestamp) {
    return 1;
  }
  if (!leftParsed?.timestamp && rightParsed?.timestamp) {
    return -1;
  }
  return left.localeCompare(right);
}
function selectMatchingTestSpecsForPrd(prdPath, testSpecPaths) {
  if (!prdPath) {
    return [];
  }
  const prdArtifact = parsePlanningArtifactFileName(prdPath);
  if (prdArtifact?.kind !== "prd") {
    return [];
  }
  const requiredTimestampedFileName = requiredTimestampedTestSpecFileName(prdArtifact);
  return (requiredTimestampedFileName ? testSpecPaths.filter((path4) => basename11(path4) === requiredTimestampedFileName) : testSpecPaths.filter((path4) => legacyTestSpecSlug(path4) === prdArtifact.slug)).sort(comparePlanningArtifactPaths);
}
function selectLatestPlanningArtifactPath(paths) {
  return [...paths].sort(comparePlanningArtifactPaths).at(-1) ?? null;
}

// src/planning/artifacts.ts
function readFileSafe(path4) {
  try {
    return readFileSync16(path4, "utf-8");
  } catch {
    return null;
  }
}
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function getSectionContent(markdown, heading) {
  const headingRe = new RegExp(
    `^##\\s+${escapeRegex(heading)}[ \\t]*$`,
    "im"
  );
  const headingMatch = headingRe.exec(markdown);
  if (!headingMatch || headingMatch.index === void 0) return null;
  const bodyStart = headingMatch.index + headingMatch[0].length;
  const rest = markdown.slice(bodyStart).replace(/^\r?\n/, "");
  const nextHeadingMatch = /\r?\n##\s+/.exec(rest);
  const body = (nextHeadingMatch ? rest.slice(0, nextHeadingMatch.index) : rest).trim();
  return body.length > 0 ? body : null;
}
function hasRequiredSections(markdown, headings) {
  return headings.every(
    (heading) => getSectionContent(markdown, heading) !== null
  );
}
function getPlansDirCandidates(cwd) {
  return [join30(getOmcRoot(cwd), "plans"), join30(cwd, ".omx", "plans")];
}
function sortArtifactPathsDescending(paths) {
  return [...paths].sort((a, b) => comparePlanningArtifactPaths(b, a));
}
function hasCompletePlanningPair(prdPath, matchingTestSpecPaths) {
  if (matchingTestSpecPaths.length === 0) {
    return false;
  }
  const prd = readFileSafe(prdPath);
  const testSpec = readFileSafe(matchingTestSpecPaths[0]);
  if (!prd || !testSpec) {
    return false;
  }
  return hasRequiredSections(prd, [
    "Acceptance criteria",
    "Requirement coverage map"
  ]) && hasRequiredSections(testSpec, [
    "Unit coverage",
    "Verification mapping"
  ]);
}
function readPlanningArtifacts(cwd) {
  let entries;
  const prdPaths = [];
  const testSpecPaths = [];
  for (const plansDir of getPlansDirCandidates(cwd)) {
    if (!existsSync26(plansDir)) {
      continue;
    }
    try {
      entries = readdirSync9(plansDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith("prd-") && entry.endsWith(".md")) {
        prdPaths.push(join30(plansDir, entry));
      } else if (entry.startsWith("test-spec-") && entry.endsWith(".md")) {
        testSpecPaths.push(join30(plansDir, entry));
      }
    }
  }
  return {
    prdPaths: sortArtifactPathsDescending(prdPaths),
    testSpecPaths: sortArtifactPathsDescending(testSpecPaths)
  };
}
function decodeQuotedValue(raw) {
  const normalized = raw.trim();
  if (!normalized) return null;
  try {
    return JSON.parse(normalized);
  } catch {
    if (normalized.startsWith('"') && normalized.endsWith('"') || normalized.startsWith("'") && normalized.endsWith("'")) {
      return normalized.slice(1, -1);
    }
    return null;
  }
}
function launchHintPattern(mode) {
  return mode === "team" ? /(?<command>(?:om[cx]\s+team|\$team)(?:\s+ralph)?(?:\s+(?<count>\d+)(?::(?<role>[a-z][a-z0-9-]*))?)?\s+(?<task>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')(?<flags>(?:\s+--[\w-]+)*))/gi : /(?<command>(?:om[cx]\s+ralph|\$ralph)\s+(?<task>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')(?<flags>(?:\s+--[\w-]+)*))/gi;
}
function collectLaunchHintMatches(content, mode) {
  return [...content.matchAll(launchHintPattern(mode))];
}
function selectLaunchHintMatch(matches, normalizedTask, normalizedCommand) {
  const decodedMatches = matches.flatMap((match) => {
    const command = match[0]?.trim();
    const task = match.groups?.task ? decodeQuotedValue(match.groups.task) : null;
    if (!command || task == null) return [];
    const flags = match.groups?.flags ?? "";
    const workerCount = match.groups?.count ? Number.parseInt(match.groups.count, 10) : void 0;
    return [{
      command,
      task,
      ...workerCount == null ? {} : { workerCount },
      agentType: match.groups?.role || void 0,
      linkedRalph: /\sralph(?:\s|$)/.test(command) || parseFlags(flags).linkedRalph
    }];
  });
  const matchesToConsider = normalizedCommand ? decodedMatches.filter((match) => match.command === normalizedCommand) : normalizedTask ? decodedMatches.filter((match) => match.task.trim() === normalizedTask) : decodedMatches;
  if (matchesToConsider.length === 0) return { status: "no-match" };
  if (matchesToConsider.length > 1) return { status: "ambiguous" };
  return { status: "unique", ...matchesToConsider[0] };
}
function parseFlags(flagStr) {
  return {
    linkedRalph: /--linked-ralph/.test(flagStr)
  };
}
function readApprovedExecutionLaunchHintOutcome(cwd, mode, options = {}) {
  const artifacts = readPlanningArtifacts(cwd);
  if (artifacts.prdPaths.length === 0) return { status: "absent" };
  const prdPath = options.prdPath ? artifacts.prdPaths.includes(options.prdPath) ? options.prdPath : null : selectLatestPlanningArtifactPath(artifacts.prdPaths);
  const matchingTestSpecs = selectMatchingTestSpecsForPrd(
    prdPath,
    artifacts.testSpecPaths
  );
  if (!prdPath) return { status: "absent" };
  if (artifacts.testSpecPaths.length > 0 && matchingTestSpecs.length === 0) {
    return { status: "absent" };
  }
  const content = readFileSafe(prdPath);
  if (!content) return { status: "absent" };
  const selected = selectLaunchHintMatch(
    collectLaunchHintMatches(content, mode),
    options.task?.trim(),
    options.command?.trim()
  );
  if (selected.status === "ambiguous") return { status: "ambiguous" };
  if (selected.status !== "unique") return { status: "absent" };
  if (options.requirePlanningComplete && !hasCompletePlanningPair(prdPath, matchingTestSpecs)) {
    return { status: "incomplete" };
  }
  if (mode === "team") {
    return {
      status: "resolved",
      hint: {
        mode: "team",
        command: selected.command,
        task: selected.task,
        workerCount: selected.workerCount,
        agentType: selected.agentType,
        linkedRalph: selected.linkedRalph,
        sourcePath: prdPath
      }
    };
  }
  return {
    status: "resolved",
    hint: {
      mode: "ralph",
      command: selected.command,
      task: selected.task,
      linkedRalph: selected.linkedRalph,
      sourcePath: prdPath
    }
  };
}

// src/cli/team.ts
init_worktree_paths();
var JOB_ID_PATTERN = /^omc-[a-z0-9]{1,16}$/;
var VALID_CLI_AGENT_TYPES = /* @__PURE__ */ new Set(["claude", "codex", "gemini", "cursor", "grok", "antigravity"]);
var SUBCOMMANDS = /* @__PURE__ */ new Set(["start", "status", "wait", "cleanup", "resume", "shutdown", "api", "help", "--help", "-h"]);
var SUPPORTED_API_OPERATIONS = /* @__PURE__ */ new Set([
  "send-message",
  "broadcast",
  "mailbox-list",
  "mailbox-mark-delivered",
  "mailbox-mark-notified",
  "list-tasks",
  "read-task",
  "read-config",
  "get-summary",
  "orphan-cleanup",
  "recover-worker",
  "write-task-checkpoint",
  "read-recovery-result"
]);
var TEAM_API_USAGE = `
Usage:
  omc team api <operation> --input '<json>' [--json] [--cwd DIR]

Supported operations:
  ${Array.from(SUPPORTED_API_OPERATIONS).join(", ")}
`.trim();
function getTeamWorkerIdentityFromEnv(env = process.env) {
  const omc = typeof env.OMC_TEAM_WORKER === "string" ? env.OMC_TEAM_WORKER.trim() : "";
  if (omc) return omc;
  const omx = typeof env.OMX_TEAM_WORKER === "string" ? env.OMX_TEAM_WORKER.trim() : "";
  return omx || null;
}
async function assertTeamSpawnAllowed(cwd, env = process.env) {
  const workerIdentity = getTeamWorkerIdentityFromEnv(env);
  const { teamReadManifest: teamReadManifest2 } = await Promise.resolve().then(() => (init_team_ops(), team_ops_exports));
  const { findActiveTeamsV2: findActiveTeamsV22 } = await Promise.resolve().then(() => (init_runtime_v2(), runtime_v2_exports));
  const { DEFAULT_TEAM_GOVERNANCE: DEFAULT_TEAM_GOVERNANCE2, normalizeTeamGovernance: normalizeTeamGovernance2 } = await Promise.resolve().then(() => (init_governance(), governance_exports));
  if (workerIdentity) {
    const [parentTeamName] = workerIdentity.split("/");
    const parentManifest = parentTeamName ? await teamReadManifest2(parentTeamName, cwd) : null;
    const governance = normalizeTeamGovernance2(parentManifest?.governance, parentManifest?.policy);
    if (!governance.nested_teams_allowed) {
      throw new Error(
        `Worker context (${workerIdentity}) cannot start nested teams because nested_teams_allowed is false.`
      );
    }
    if (!governance.delegation_only) {
      throw new Error(
        `Worker context (${workerIdentity}) cannot start nested teams because delegation_only is false.`
      );
    }
    return;
  }
  const activeTeams = await findActiveTeamsV22(cwd);
  for (const activeTeam of activeTeams) {
    const manifest = await teamReadManifest2(activeTeam, cwd);
    const governance = normalizeTeamGovernance2(manifest?.governance, manifest?.policy);
    if (governance.one_team_per_leader_session ?? DEFAULT_TEAM_GOVERNANCE2.one_team_per_leader_session) {
      throw new Error(
        `Leader session already owns active team "${activeTeam}" and one_team_per_leader_session is enabled.`
      );
    }
  }
}
function resolveJobsDir(env = process.env) {
  return env.OMC_JOBS_DIR || getGlobalOmcStatePath("team-jobs");
}
function resolveRuntimeCliPath2(env = process.env) {
  if (env.OMC_RUNTIME_CLI_PATH) {
    return env.OMC_RUNTIME_CLI_PATH;
  }
  const moduleDir = dirname23(fileURLToPath3(import.meta.url));
  return join31(moduleDir, "../../bridge/runtime-cli.cjs");
}
function ensureJobsDir(jobsDir) {
  if (!existsSync27(jobsDir)) {
    mkdirSync8(jobsDir, { recursive: true });
  }
}
function jobPath(jobsDir, jobId) {
  return join31(jobsDir, `${jobId}.json`);
}
function resultArtifactPath(jobsDir, jobId) {
  return join31(jobsDir, `${jobId}-result.json`);
}
function panesArtifactPath(jobsDir, jobId) {
  return join31(jobsDir, `${jobId}-panes.json`);
}
function teamStateRoot2(cwd, teamName) {
  return join31(getOmcRoot(cwd), "state", "team", teamName);
}
function validateJobId(jobId) {
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new Error(`Invalid job id: ${jobId}`);
  }
}
function parseJsonSafe(content) {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}
async function resolveCleanupPaneEvidence(job, jobsDir, jobId) {
  const paneArtifact = await readFile14(panesArtifactPath(jobsDir, jobId), "utf-8").then((content) => parseJsonSafe(content)).catch(() => null);
  if (paneArtifact?.paneIds?.length) return { paneArtifact };
  const config = await readTeamConfig(job.teamName, job.cwd).catch(() => null);
  if (!config) {
    return { paneArtifact, livenessUnknownReason: "worker_liveness_unknown:no_config_or_panes" };
  }
  const configPaneIds = (config.workers ?? []).map((worker) => worker.pane_id).filter((paneId) => typeof paneId === "string" && paneId.trim().length > 0);
  if (configPaneIds.length > 0) {
    return {
      paneArtifact: {
        paneIds: configPaneIds,
        leaderPaneId: config.leader_pane_id ?? paneArtifact?.leaderPaneId ?? "",
        sessionName: config.tmux_session || paneArtifact?.sessionName,
        ownsWindow: config.tmux_window_owned ?? paneArtifact?.ownsWindow
      }
    };
  }
  const hasConfiguredWorkers = (config.workers ?? []).length > 0 || config.worker_count > 0;
  if (hasConfiguredWorkers) {
    return { paneArtifact, livenessUnknownReason: "worker_liveness_unknown:no_worker_pane_ids" };
  }
  return { paneArtifact };
}
function readJobFromDisk(jobId, jobsDir) {
  try {
    const content = readFileSync17(jobPath(jobsDir, jobId), "utf-8");
    return parseJsonSafe(content);
  } catch {
    return null;
  }
}
function writeJobToDisk(jobId, job, jobsDir) {
  ensureJobsDir(jobsDir);
  writeFileSync7(jobPath(jobsDir, jobId), JSON.stringify(job), "utf-8");
}
function parseJobResult(raw) {
  if (!raw) return void 0;
  const parsed = parseJsonSafe(raw);
  return parsed ?? raw;
}
function buildStatus(jobId, job) {
  return {
    jobId,
    status: job.status,
    elapsedSeconds: ((Date.now() - job.startedAt) / 1e3).toFixed(1),
    result: parseJobResult(job.result),
    stderr: job.stderr
  };
}
function generateJobId(now = Date.now()) {
  return `omc-${now.toString(36)}${randomUUID11().slice(0, 8)}`;
}
function convergeWithResultArtifact(jobId, job, jobsDir) {
  try {
    const artifactRaw = readFileSync17(resultArtifactPath(jobsDir, jobId), "utf-8");
    const artifactParsed = parseJsonSafe(artifactRaw);
    if (artifactParsed?.status === "completed" || artifactParsed?.status === "failed") {
      return {
        ...job,
        status: artifactParsed.status,
        result: artifactRaw
      };
    }
  } catch {
  }
  if (job.status === "running" && job.pid != null && !isProcessAlive(job.pid)) {
    return {
      ...job,
      status: "failed",
      result: job.result ?? JSON.stringify({ error: "Process no longer alive" })
    };
  }
  return job;
}
function output(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  console.log(value);
}
function toInt(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${flag} value: ${value}`);
  }
  return parsed;
}
function normalizeAgentType(value) {
  const normalized = value.trim().toLowerCase();
  if (!normalized) throw new Error("Agent type cannot be empty");
  if (!VALID_CLI_AGENT_TYPES.has(normalized)) {
    throw new Error(`Unsupported agent type: ${value}`);
  }
  return normalized;
}
function autoTeamName(task) {
  const slug = task.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "task";
  return `omc-${slug}-${Date.now().toString(36).slice(-4)}`;
}
function parseJsonInput(inputRaw) {
  if (!inputRaw || !inputRaw.trim()) return {};
  const parsed = parseJsonSafe(inputRaw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid --input JSON payload");
  }
  return parsed;
}
async function startTeamJob(input) {
  await assertTeamSpawnAllowed(input.cwd);
  validateTeamName(input.teamName);
  if (!Array.isArray(input.agentTypes) || input.agentTypes.length === 0) {
    throw new Error("agentTypes must be a non-empty array");
  }
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
    throw new Error("tasks must be a non-empty array");
  }
  const jobsDir = resolveJobsDir();
  const runtimeCliPath = resolveRuntimeCliPath2();
  const jobId = generateJobId();
  const job = {
    status: "running",
    startedAt: Date.now(),
    teamName: input.teamName,
    cwd: input.cwd
  };
  const child = spawn2(process.execPath, [runtimeCliPath], {
    env: {
      ...process.env,
      OMC_JOB_ID: jobId,
      OMC_JOBS_DIR: jobsDir
    },
    detached: true,
    stdio: ["pipe", "ignore", "ignore"]
  });
  const payload = {
    teamName: input.teamName,
    workerCount: input.workerCount,
    agentTypes: input.agentTypes,
    tasks: input.tasks,
    cwd: input.cwd,
    newWindow: input.newWindow,
    pollIntervalMs: input.pollIntervalMs,
    sentinelGateTimeoutMs: input.sentinelGateTimeoutMs,
    sentinelGatePollIntervalMs: input.sentinelGatePollIntervalMs,
    autoMerge: input.autoMerge
  };
  if (child.stdin && typeof child.stdin.on === "function") {
    child.stdin.on("error", () => {
    });
  }
  child.stdin?.write(JSON.stringify(payload));
  child.stdin?.end();
  child.unref();
  if (child.pid != null) {
    job.pid = child.pid;
  }
  writeJobToDisk(jobId, job, jobsDir);
  return {
    jobId,
    status: "running",
    pid: child.pid
  };
}
async function getTeamJobStatus(jobId) {
  validateJobId(jobId);
  const jobsDir = resolveJobsDir();
  const job = readJobFromDisk(jobId, jobsDir);
  if (!job) {
    throw new Error(`No job found: ${jobId}`);
  }
  const converged = convergeWithResultArtifact(jobId, job, jobsDir);
  if (JSON.stringify(converged) !== JSON.stringify(job)) {
    writeJobToDisk(jobId, converged, jobsDir);
  }
  return buildStatus(jobId, converged);
}
async function waitForTeamJob(jobId, options = {}) {
  const timeoutMs = Math.min(options.timeoutMs ?? 3e5, 36e5);
  const deadline = Date.now() + timeoutMs;
  let delayMs = 500;
  while (Date.now() < deadline) {
    const status2 = await getTeamJobStatus(jobId);
    if (status2.status !== "running") {
      return status2;
    }
    await new Promise((resolve7) => setTimeout(resolve7, delayMs));
    delayMs = Math.min(Math.floor(delayMs * 1.5), 2e3);
  }
  const status = await getTeamJobStatus(jobId);
  return {
    ...status,
    timedOut: true,
    error: `Timed out waiting for job ${jobId} after ${(timeoutMs / 1e3).toFixed(0)}s`
  };
}
async function cleanupTeamJob(jobId, graceMs = 1e4) {
  validateJobId(jobId);
  const jobsDir = resolveJobsDir();
  const job = readJobFromDisk(jobId, jobsDir);
  if (!job) {
    throw new Error(`No job found: ${jobId}`);
  }
  const { paneArtifact, livenessUnknownReason } = await resolveCleanupPaneEvidence(job, jobsDir, jobId);
  if (livenessUnknownReason) {
    writeJobToDisk(jobId, {
      ...job,
      cleanupBlockedAt: (/* @__PURE__ */ new Date()).toISOString(),
      cleanupBlockedReason: livenessUnknownReason
    }, jobsDir);
    return {
      jobId,
      message: `Preserved team state because worker liveness could not be proven (${livenessUnknownReason})`
    };
  }
  if (paneArtifact?.sessionName && (paneArtifact.ownsWindow === true || !paneArtifact.sessionName.includes(":"))) {
    const sessionMode = paneArtifact.ownsWindow === true ? paneArtifact.sessionName.includes(":") ? "dedicated-window" : "detached-session" : "detached-session";
    await killTeamSession(
      paneArtifact.sessionName,
      paneArtifact.paneIds,
      paneArtifact.leaderPaneId,
      { sessionMode }
    );
  } else if (paneArtifact?.paneIds?.length) {
    await killWorkerPanes({
      paneIds: paneArtifact.paneIds,
      leaderPaneId: paneArtifact.leaderPaneId,
      teamName: job.teamName,
      cwd: job.cwd,
      graceMs
    });
  }
  if (paneArtifact?.paneIds?.length) {
    const liveness = await Promise.all(paneArtifact.paneIds.map(async (paneId) => [paneId, await getWorkerLiveness(paneId)]));
    const alivePaneIds = liveness.filter(([, state]) => state === "alive").map(([paneId]) => paneId);
    const unknownPaneIds = liveness.filter(([, state]) => state === "unknown").map(([paneId]) => paneId);
    if (alivePaneIds.length > 0 || unknownPaneIds.length > 0) {
      const reason = alivePaneIds.length > 0 ? `worker_panes_still_alive:${alivePaneIds.join(",")}` : `worker_liveness_unknown:${unknownPaneIds.join(",")}`;
      writeJobToDisk(jobId, {
        ...job,
        cleanupBlockedAt: (/* @__PURE__ */ new Date()).toISOString(),
        cleanupBlockedReason: reason
      }, jobsDir);
      return {
        jobId,
        message: alivePaneIds.length > 0 ? `Preserved team state because worker pane(s) are still alive: ${alivePaneIds.join(", ")}` : `Preserved team state because worker pane liveness is unknown: ${unknownPaneIds.join(", ")}`
      };
    }
  }
  let preservedWorktrees = 0;
  try {
    const cleanupResult = cleanupTeamWorktrees(job.teamName, job.cwd);
    preservedWorktrees = cleanupResult.preserved.length;
  } catch {
    preservedWorktrees = 1;
  }
  if (preservedWorktrees > 0) {
    writeJobToDisk(jobId, {
      ...job,
      cleanupBlockedAt: (/* @__PURE__ */ new Date()).toISOString(),
      cleanupBlockedReason: `worktrees_preserved:${preservedWorktrees}`
    }, jobsDir);
    return {
      jobId,
      message: `Preserved team state because ${preservedWorktrees} worktree(s) require follow-up cleanup`
    };
  }
  await rm5(teamStateRoot2(job.cwd, job.teamName), {
    recursive: true,
    force: true
  }).catch(() => void 0);
  writeJobToDisk(jobId, {
    ...job,
    cleanedUpAt: (/* @__PURE__ */ new Date()).toISOString()
  }, jobsDir);
  return {
    jobId,
    message: paneArtifact?.ownsWindow ? "Cleaned up team tmux window" : paneArtifact?.paneIds?.length ? `Cleaned up ${paneArtifact.paneIds.length} worker pane(s)` : "No worker pane ids found for this job"
  };
}
async function teamStatusByTeamName(teamName, cwd = process.cwd()) {
  validateTeamName(teamName);
  const runtimeV2 = await Promise.resolve().then(() => (init_runtime_v2(), runtime_v2_exports));
  if (runtimeV2.isRuntimeV2Enabled()) {
    const snapshot2 = await runtimeV2.monitorTeamV2(teamName, cwd);
    if (!snapshot2) {
      return {
        teamName,
        running: false,
        error: "Team state not found"
      };
    }
    const config = await readTeamConfig(teamName, cwd);
    return {
      teamName,
      running: true,
      sessionName: config?.tmux_session,
      leaderPaneId: config?.leader_pane_id,
      workspace_mode: config?.workspace_mode,
      worktree_mode: config?.worktree_mode,
      team_state_root: config?.team_state_root,
      workerPaneIds: Array.from(new Set(
        (config?.workers ?? []).map((worker) => worker.pane_id).filter((paneId) => typeof paneId === "string" && paneId.trim().length > 0)
      )),
      workers: (config?.workers ?? []).map((worker) => ({
        name: worker.name,
        working_dir: worker.working_dir,
        worktree_repo_root: worker.worktree_repo_root,
        worktree_path: worker.worktree_path,
        worktree_branch: worker.worktree_branch,
        worktree_detached: worker.worktree_detached,
        worktree_created: worker.worktree_created,
        team_state_root: worker.team_state_root
      })),
      snapshot: snapshot2
    };
  }
  const runtime = await resumeTeam(teamName, cwd);
  if (!runtime) {
    return {
      teamName,
      running: false,
      error: "Team session is not currently resumable"
    };
  }
  const snapshot = await monitorTeam(teamName, cwd, runtime.workerPaneIds);
  return {
    teamName,
    running: true,
    sessionName: runtime.sessionName,
    leaderPaneId: runtime.leaderPaneId,
    workerPaneIds: runtime.workerPaneIds,
    snapshot
  };
}
async function teamResumeByName(teamName, cwd = process.cwd()) {
  validateTeamName(teamName);
  const runtime = await resumeTeam(teamName, cwd);
  if (!runtime) {
    return {
      teamName,
      resumed: false,
      error: "Team session is not currently resumable"
    };
  }
  return {
    teamName,
    resumed: true,
    sessionName: runtime.sessionName,
    leaderPaneId: runtime.leaderPaneId,
    workerPaneIds: runtime.workerPaneIds,
    activeWorkers: runtime.activeWorkers.size
  };
}
async function teamShutdownByName(teamName, options = {}) {
  validateTeamName(teamName);
  const cwd = options.cwd ?? process.cwd();
  const runtimeV2 = await Promise.resolve().then(() => (init_runtime_v2(), runtime_v2_exports));
  if (runtimeV2.isRuntimeV2Enabled()) {
    const config = await readTeamConfig(teamName, cwd);
    await runtimeV2.shutdownTeamV2(teamName, cwd, { force: Boolean(options.force) });
    return {
      teamName,
      shutdown: true,
      forced: Boolean(options.force),
      sessionFound: Boolean(config)
    };
  }
  const runtime = await resumeTeam(teamName, cwd);
  if (!runtime) {
    if (options.force) {
      await rm5(teamStateRoot2(cwd, teamName), { recursive: true, force: true }).catch(() => void 0);
      return {
        teamName,
        shutdown: true,
        forced: true,
        sessionFound: false
      };
    }
    throw new Error(`Team ${teamName} is not running. Use --force to clear stale state.`);
  }
  await shutdownTeam(
    runtime.teamName,
    runtime.sessionName,
    runtime.cwd,
    options.force ? 0 : 3e4,
    runtime.workerPaneIds,
    runtime.leaderPaneId,
    runtime.ownsWindow
  );
  return {
    teamName,
    shutdown: true,
    forced: Boolean(options.force),
    sessionFound: true
  };
}
async function executeTeamApiOperation2(operation, input, cwd = process.cwd()) {
  const canonicalOperation = resolveTeamApiOperation(operation);
  if (!canonicalOperation || !SUPPORTED_API_OPERATIONS.has(canonicalOperation)) {
    return {
      ok: false,
      operation,
      error: {
        code: "UNSUPPORTED_OPERATION",
        message: `Unsupported omc team api operation: ${operation}`
      }
    };
  }
  const normalizedInput = {
    ...input,
    ...typeof input.teamName === "string" && input.teamName.trim() !== "" && typeof input.team_name !== "string" ? { team_name: input.teamName } : {},
    ...typeof input.taskId === "string" && input.taskId.trim() !== "" && typeof input.task_id !== "string" ? { task_id: input.taskId } : {},
    ...typeof input.workerName === "string" && input.workerName.trim() !== "" && typeof input.worker !== "string" ? { worker: input.workerName } : {},
    ...typeof input.fromWorker === "string" && input.fromWorker.trim() !== "" && typeof input.from_worker !== "string" ? { from_worker: input.fromWorker } : {},
    ...typeof input.toWorker === "string" && input.toWorker.trim() !== "" && typeof input.to_worker !== "string" ? { to_worker: input.toWorker } : {},
    ...typeof input.messageId === "string" && input.messageId.trim() !== "" && typeof input.message_id !== "string" ? { message_id: input.messageId } : {},
    ...typeof input.claimToken === "string" && input.claimToken.trim() !== "" && typeof input.claim_token !== "string" ? { claim_token: input.claimToken } : {},
    ...typeof input.taskVersion === "number" && input.task_version === void 0 ? { task_version: input.taskVersion } : {},
    ...typeof input.resumePayload !== "undefined" && input.resume_payload === void 0 ? { resume_payload: input.resumePayload } : {},
    ...typeof input.requestId === "string" && input.requestId.trim() !== "" && typeof input.request_id !== "string" ? { request_id: input.requestId } : {},
    ...typeof input.timeoutMs === "number" && input.timeout_ms === void 0 ? { timeout_ms: input.timeoutMs } : {}
  };
  for (const alias of [
    "teamName",
    "taskId",
    "workerName",
    "fromWorker",
    "toWorker",
    "messageId",
    "claimToken",
    "taskVersion",
    "resumePayload",
    "requestId",
    "timeoutMs"
  ]) {
    delete normalizedInput[alias];
  }
  const result = await executeTeamApiOperation(canonicalOperation, normalizedInput, cwd);
  return result;
}
async function teamStartCommand(input, options = {}) {
  const result = await startTeamJob(input);
  output(result, Boolean(options.json));
  return result;
}
async function teamStatusCommand(jobId, options = {}) {
  const result = await getTeamJobStatus(jobId);
  output(result, Boolean(options.json));
  return result;
}
async function teamWaitCommand(jobId, waitOptions = {}, options = {}) {
  const result = await waitForTeamJob(jobId, waitOptions);
  output(result, Boolean(options.json));
  return result;
}
async function teamCleanupCommand(jobId, cleanupOptions = {}, options = {}) {
  const result = await cleanupTeamJob(jobId, cleanupOptions.graceMs);
  output(result, Boolean(options.json));
  return result;
}
var TEAM_USAGE = `
Usage:
  omc team start --agent <claude|codex|gemini|cursor|grok|antigravity>[,<agent>...] --task "<task>" [--count N] [--name TEAM] [--cwd DIR] [--new-window] [--auto-merge] [--json]
  omc team status <job_id|team_name> [--json] [--cwd DIR]
  omc team wait <job_id> [--timeout-ms MS] [--json]
  omc team cleanup <job_id> [--grace-ms MS] [--json]
  omc team resume <team_name> [--json] [--cwd DIR]
  omc team shutdown <team_name> [--force] [--json] [--cwd DIR]
  omc team api <operation> [--input '<json>'] [--json] [--cwd DIR]
  omc team [ralph] <N:agent-type[:role]> "task" [--json] [--cwd DIR] [--new-window]

Worktrees:
  Native per-worker git worktree mode is opt-in/config-gated with team.ops.worktreeMode or OMC_TEAM_WORKTREE_MODE=detached|named.
  Status JSON includes workspace_mode, worktree_mode, team_state_root, and per-worker worktree metadata.

Auto-merge (v2-only):
  --auto-merge          Enable per-commit auto-merge to leader and auto-rebase fanout.
                        Each worker runs in a dedicated git worktree on omc-team/{team}/{worker}.
                        Bursts of rapid worker commits coalesce to a single merge of HEAD.
                        Requires OMC_RUNTIME_V2=1. Leader branch must not be 'main' or 'master'.
                        Equivalent to OMC_TEAMS_AUTO_MERGE=1.

Examples:
  omc team start --agent codex --count 2 --task "review auth flow" --new-window
  omc team status omc-abc123
  omc team status auth-review
  omc team resume auth-review
  omc team shutdown auth-review --force
  omc team api list-tasks --input '{"teamName":"auth-review"}' --json
  omc team 3:codex "refactor launch command"

Worktree mode:
  Native worker worktrees are opt-in/config-gated for runtime-v2.
  Status surfaces workspace_mode, worktree_mode, team_state_root, and worker worktree metadata when enabled.
`.trim();
function parseStartArgs(args) {
  const agentValues = [];
  const taskValues = [];
  let teamName;
  let cwd = process.cwd();
  let count = 1;
  let json = false;
  let newWindow = false;
  let subjectPrefix = "Task";
  let pollIntervalMs;
  let sentinelGateTimeoutMs;
  let sentinelGatePollIntervalMs;
  let autoMerge = process.env.OMC_TEAMS_AUTO_MERGE === "1";
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    const next = args[i + 1];
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--new-window") {
      newWindow = true;
      continue;
    }
    if (token === "--auto-merge") {
      autoMerge = true;
      continue;
    }
    if (token === "--agent") {
      if (!next) throw new Error("Missing value after --agent");
      agentValues.push(...next.split(",").map(normalizeAgentType));
      i += 1;
      continue;
    }
    if (token.startsWith("--agent=")) {
      agentValues.push(...token.slice("--agent=".length).split(",").map(normalizeAgentType));
      continue;
    }
    if (token === "--task") {
      if (!next) throw new Error("Missing value after --task");
      taskValues.push(next);
      i += 1;
      continue;
    }
    if (token.startsWith("--task=")) {
      taskValues.push(token.slice("--task=".length));
      continue;
    }
    if (token === "--count") {
      if (!next) throw new Error("Missing value after --count");
      count = toInt(next, "--count");
      i += 1;
      continue;
    }
    if (token.startsWith("--count=")) {
      count = toInt(token.slice("--count=".length), "--count");
      continue;
    }
    if (token === "--name") {
      if (!next) throw new Error("Missing value after --name");
      teamName = next;
      i += 1;
      continue;
    }
    if (token.startsWith("--name=")) {
      teamName = token.slice("--name=".length);
      continue;
    }
    if (token === "--cwd") {
      if (!next) throw new Error("Missing value after --cwd");
      cwd = next;
      i += 1;
      continue;
    }
    if (token.startsWith("--cwd=")) {
      cwd = token.slice("--cwd=".length);
      continue;
    }
    if (token === "--subject") {
      if (!next) throw new Error("Missing value after --subject");
      subjectPrefix = next;
      i += 1;
      continue;
    }
    if (token.startsWith("--subject=")) {
      subjectPrefix = token.slice("--subject=".length);
      continue;
    }
    if (token === "--poll-interval-ms") {
      if (!next) throw new Error("Missing value after --poll-interval-ms");
      pollIntervalMs = toInt(next, "--poll-interval-ms");
      i += 1;
      continue;
    }
    if (token.startsWith("--poll-interval-ms=")) {
      pollIntervalMs = toInt(token.slice("--poll-interval-ms=".length), "--poll-interval-ms");
      continue;
    }
    if (token === "--sentinel-gate-timeout-ms") {
      if (!next) throw new Error("Missing value after --sentinel-gate-timeout-ms");
      sentinelGateTimeoutMs = toInt(next, "--sentinel-gate-timeout-ms");
      i += 1;
      continue;
    }
    if (token.startsWith("--sentinel-gate-timeout-ms=")) {
      sentinelGateTimeoutMs = toInt(token.slice("--sentinel-gate-timeout-ms=".length), "--sentinel-gate-timeout-ms");
      continue;
    }
    if (token === "--sentinel-gate-poll-interval-ms") {
      if (!next) throw new Error("Missing value after --sentinel-gate-poll-interval-ms");
      sentinelGatePollIntervalMs = toInt(next, "--sentinel-gate-poll-interval-ms");
      i += 1;
      continue;
    }
    if (token.startsWith("--sentinel-gate-poll-interval-ms=")) {
      sentinelGatePollIntervalMs = toInt(token.slice("--sentinel-gate-poll-interval-ms=".length), "--sentinel-gate-poll-interval-ms");
      continue;
    }
    throw new Error(`Unknown argument for "omc team start": ${token}`);
  }
  if (count < 1) throw new Error("--count must be >= 1");
  if (agentValues.length === 0) throw new Error("Missing required --agent");
  if (taskValues.length === 0) throw new Error("Missing required --task");
  const agentTypes = agentValues.length === 1 ? Array.from({ length: count }, () => agentValues[0]) : [...agentValues];
  if (agentValues.length > 1 && count !== 1) {
    throw new Error("Do not combine --count with multiple --agent values; either use one agent+count or explicit agent list.");
  }
  const taskDescriptions = taskValues.length === 1 ? Array.from({ length: agentTypes.length }, () => taskValues[0]) : [...taskValues];
  if (taskDescriptions.length !== agentTypes.length) {
    throw new Error(`Task count (${taskDescriptions.length}) must match worker count (${agentTypes.length}).`);
  }
  const resolvedTeamName = teamName && teamName.trim() ? teamName.trim() : autoTeamName(taskDescriptions[0]);
  const tasks = taskDescriptions.map((description, index) => ({
    subject: `${subjectPrefix} ${index + 1}`,
    description
  }));
  return {
    input: {
      teamName: resolvedTeamName,
      agentTypes,
      tasks,
      cwd,
      ...newWindow ? { newWindow: true } : {},
      ...pollIntervalMs != null ? { pollIntervalMs } : {},
      ...sentinelGateTimeoutMs != null ? { sentinelGateTimeoutMs } : {},
      ...sentinelGatePollIntervalMs != null ? { sentinelGatePollIntervalMs } : {},
      ...autoMerge ? { autoMerge: true } : {}
    },
    json
  };
}
function parseCommonJobArgs(args, command) {
  let json = false;
  let target;
  let cwd;
  let timeoutMs;
  let graceMs;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    const next = args[i + 1];
    if (!token.startsWith("-") && !target) {
      target = token;
      continue;
    }
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--cwd") {
      if (!next) throw new Error("Missing value after --cwd");
      cwd = next;
      i += 1;
      continue;
    }
    if (token.startsWith("--cwd=")) {
      cwd = token.slice("--cwd=".length);
      continue;
    }
    if (token === "--job-id") {
      if (!next) throw new Error("Missing value after --job-id");
      target = next;
      i += 1;
      continue;
    }
    if (token.startsWith("--job-id=")) {
      target = token.slice("--job-id=".length);
      continue;
    }
    if (command === "wait") {
      if (token === "--timeout-ms") {
        if (!next) throw new Error("Missing value after --timeout-ms");
        timeoutMs = toInt(next, "--timeout-ms");
        i += 1;
        continue;
      }
      if (token.startsWith("--timeout-ms=")) {
        timeoutMs = toInt(token.slice("--timeout-ms=".length), "--timeout-ms");
        continue;
      }
    }
    if (command === "cleanup") {
      if (token === "--grace-ms") {
        if (!next) throw new Error("Missing value after --grace-ms");
        graceMs = toInt(next, "--grace-ms");
        i += 1;
        continue;
      }
      if (token.startsWith("--grace-ms=")) {
        graceMs = toInt(token.slice("--grace-ms=".length), "--grace-ms");
        continue;
      }
    }
    throw new Error(`Unknown argument for "omc team ${command}": ${token}`);
  }
  if (!target) {
    throw new Error(`Missing required target for "omc team ${command}".`);
  }
  return {
    target,
    json,
    ...cwd ? { cwd } : {},
    ...timeoutMs != null ? { timeoutMs } : {},
    ...graceMs != null ? { graceMs } : {}
  };
}
function parseTeamTargetArgs(args, command) {
  let teamName;
  let json = false;
  let cwd;
  let force = false;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    const next = args[i + 1];
    if (!token.startsWith("-") && !teamName) {
      teamName = token;
      continue;
    }
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--cwd") {
      if (!next) throw new Error("Missing value after --cwd");
      cwd = next;
      i += 1;
      continue;
    }
    if (token.startsWith("--cwd=")) {
      cwd = token.slice("--cwd=".length);
      continue;
    }
    if (command === "shutdown" && token === "--force") {
      force = true;
      continue;
    }
    throw new Error(`Unknown argument for "omc team ${command}": ${token}`);
  }
  if (!teamName) {
    throw new Error(`Missing required <team_name> for "omc team ${command}".`);
  }
  return {
    teamName,
    json,
    ...cwd ? { cwd } : {},
    ...command === "shutdown" ? { force } : {}
  };
}
function parseApiArgs(args) {
  let operation;
  let inputRaw;
  let json = false;
  let cwd;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    const next = args[i + 1];
    if (!token.startsWith("-") && !operation) {
      operation = token;
      continue;
    }
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--input") {
      if (!next) throw new Error("Missing value after --input");
      inputRaw = next;
      i += 1;
      continue;
    }
    if (token.startsWith("--input=")) {
      inputRaw = token.slice("--input=".length);
      continue;
    }
    if (token === "--cwd") {
      if (!next) throw new Error("Missing value after --cwd");
      cwd = next;
      i += 1;
      continue;
    }
    if (token.startsWith("--cwd=")) {
      cwd = token.slice("--cwd=".length);
      continue;
    }
    throw new Error(`Unknown argument for "omc team api": ${token}`);
  }
  if (!operation) {
    throw new Error(`Missing required <operation> for "omc team api"

${TEAM_API_USAGE}`);
  }
  return {
    operation,
    input: parseJsonInput(inputRaw),
    json,
    ...cwd ? { cwd } : {}
  };
}
function parseLegacyStartAlias(args) {
  if (args.length < 2) return null;
  let index = 0;
  let ralph = false;
  if (args[index]?.toLowerCase() === "ralph") {
    ralph = true;
    index += 1;
  }
  const spec = args[index];
  if (!spec) return null;
  const match = spec.match(/^(\d+):([a-zA-Z0-9_-]+)(?::([a-zA-Z0-9_-]+))?$/);
  if (!match) return null;
  let workerCount = toInt(match[1], "worker-count");
  if (workerCount < 1) throw new Error("worker-count must be >= 1");
  let agentType = normalizeAgentType(match[2]);
  const role = match[3] || void 0;
  index += 1;
  let json = false;
  let cwd = process.cwd();
  let newWindow = false;
  let autoMerge = process.env.OMC_TEAMS_AUTO_MERGE === "1";
  const taskParts = [];
  for (let i = index; i < args.length; i += 1) {
    const token = args[i];
    const next = args[i + 1];
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--new-window") {
      newWindow = true;
      continue;
    }
    if (token === "--auto-merge") {
      autoMerge = true;
      continue;
    }
    if (token === "--cwd") {
      if (!next) throw new Error("Missing value after --cwd");
      cwd = next;
      i += 1;
      continue;
    }
    if (token.startsWith("--cwd=")) {
      cwd = token.slice("--cwd=".length);
      continue;
    }
    taskParts.push(token);
  }
  let task = taskParts.join(" ").trim();
  if (!task) throw new Error("Legacy start alias requires a task string");
  const shortFollowup = ["team", "/team", "team please", "run team", "start team"].includes(task.toLowerCase());
  if (shortFollowup) {
    const approvedHintOutcome = readApprovedExecutionLaunchHintOutcome(cwd, "team", {
      requirePlanningComplete: true
    });
    if (approvedHintOutcome.status === "ambiguous") {
      throw new Error("approved_execution_hint_ambiguous:team");
    }
    if (approvedHintOutcome.status === "incomplete") {
      throw new Error("approved_execution_hint_incomplete:team");
    }
    if (approvedHintOutcome.status === "resolved") {
      task = approvedHintOutcome.hint.task;
      workerCount = approvedHintOutcome.hint.workerCount ?? workerCount;
      agentType = approvedHintOutcome.hint.agentType ? normalizeAgentType(approvedHintOutcome.hint.agentType) : agentType;
      ralph = approvedHintOutcome.hint.linkedRalph === true ? true : ralph;
    }
  } else {
    const command = `omc team ${ralph ? "ralph " : ""}${spec} ${JSON.stringify(task)}`;
    const approvedHintOutcome = readApprovedExecutionLaunchHintOutcome(cwd, "team", {
      task,
      command
    });
    if (approvedHintOutcome.status === "ambiguous") {
      throw new Error("approved_execution_hint_ambiguous:team");
    }
  }
  return {
    workerCount,
    agentType,
    role,
    task,
    teamName: autoTeamName(task),
    ralph,
    json,
    cwd,
    ...newWindow ? { newWindow: true } : {},
    ...autoMerge ? { autoMerge: true } : {}
  };
}
async function teamCommand(argv) {
  const [commandRaw, ...rest] = argv;
  const command = (commandRaw || "").toLowerCase();
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(TEAM_USAGE);
    return;
  }
  if (command === "start") {
    const parsed = parseStartArgs(rest);
    await teamStartCommand(parsed.input, { json: parsed.json });
    return;
  }
  if (command === "status") {
    const parsed = parseCommonJobArgs(rest, "status");
    if (JOB_ID_PATTERN.test(parsed.target)) {
      await teamStatusCommand(parsed.target, { json: parsed.json });
      return;
    }
    const byTeam = await teamStatusByTeamName(parsed.target, parsed.cwd ?? process.cwd());
    output(byTeam, parsed.json);
    return;
  }
  if (command === "wait") {
    const parsed = parseCommonJobArgs(rest, "wait");
    await teamWaitCommand(parsed.target, { ...parsed.timeoutMs != null ? { timeoutMs: parsed.timeoutMs } : {} }, { json: parsed.json });
    return;
  }
  if (command === "cleanup") {
    const parsed = parseCommonJobArgs(rest, "cleanup");
    await teamCleanupCommand(parsed.target, { ...parsed.graceMs != null ? { graceMs: parsed.graceMs } : {} }, { json: parsed.json });
    return;
  }
  if (command === "resume") {
    const parsed = parseTeamTargetArgs(rest, "resume");
    const result = await teamResumeByName(parsed.teamName, parsed.cwd ?? process.cwd());
    output(result, parsed.json);
    return;
  }
  if (command === "shutdown") {
    const parsed = parseTeamTargetArgs(rest, "shutdown");
    const result = await teamShutdownByName(parsed.teamName, {
      cwd: parsed.cwd ?? process.cwd(),
      force: Boolean(parsed.force)
    });
    output(result, parsed.json);
    return;
  }
  if (command === "api") {
    if (rest.length === 0 || rest[0] === "help" || rest[0] === "--help" || rest[0] === "-h") {
      console.log(TEAM_API_USAGE);
      return;
    }
    const parsed = parseApiArgs(rest);
    const result = await executeTeamApiOperation2(parsed.operation, parsed.input, parsed.cwd ?? process.cwd());
    if (!result.ok && !parsed.json) {
      throw new Error(result.error?.message ?? "Team API operation failed");
    }
    output(result, parsed.json);
    return;
  }
  if (!SUBCOMMANDS.has(command)) {
    const legacy = parseLegacyStartAlias(argv);
    if (legacy) {
      const tasks = Array.from({ length: legacy.workerCount }, (_, idx) => ({
        subject: legacy.ralph ? `Ralph Task ${idx + 1}` : `Task ${idx + 1}`,
        description: legacy.task
      }));
      const result = await startTeamJob({
        teamName: legacy.teamName,
        workerCount: legacy.workerCount,
        agentTypes: Array.from({ length: legacy.workerCount }, () => legacy.agentType),
        tasks,
        cwd: legacy.cwd,
        ...legacy.newWindow ? { newWindow: true } : {},
        ...legacy.autoMerge ? { autoMerge: true } : {}
      });
      output(result, legacy.json);
      return;
    }
  }
  throw new Error(`Unknown team command: ${command}

${TEAM_USAGE}`);
}
async function main(argv) {
  await teamCommand(argv);
}
export {
  TEAM_USAGE,
  cleanupTeamJob,
  executeTeamApiOperation2 as executeTeamApiOperation,
  generateJobId,
  getTeamJobStatus,
  main,
  startTeamJob,
  teamCleanupCommand,
  teamCommand,
  teamResumeByName,
  teamShutdownByName,
  teamStartCommand,
  teamStatusByTeamName,
  teamStatusCommand,
  teamWaitCommand,
  waitForTeamJob
};
