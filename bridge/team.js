var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

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
import { join } from "path";
function normalizeTaskFileStem(taskId) {
  const trimmed = String(taskId).trim().replace(/\.json$/i, "");
  if (/^task-\d+$/.test(trimmed)) return trimmed;
  if (/^\d+$/.test(trimmed)) return `task-${trimmed}`;
  return trimmed;
}
function absPath(cwd, relativePath) {
  return join(cwd, relativePath);
}
function teamStateRoot(cwd, teamName) {
  return join(cwd, TeamPaths.root(teamName));
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
      workerIdentity: (teamName, workerName) => `.omc/state/team/${teamName}/workers/${workerName}/identity.json`,
      workerAgentsMd: (teamName) => `.omc/state/team/${teamName}/worker-agents.md`,
      shutdownRequest: (teamName, workerName) => `.omc/state/team/${teamName}/workers/${workerName}/shutdown-request.json`
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

// src/team/state/tasks.ts
import { randomUUID } from "crypto";
import { join as join2 } from "path";
import { existsSync } from "fs";
import { readFile, readdir } from "fs/promises";
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
    if (v.status === "pending" || v.status === "blocked") {
      if (v.claim) return { ok: false, error: "claim_conflict" };
      if (v.owner && v.owner !== workerName) return { ok: false, error: "claim_conflict" };
    }
    const claimToken = randomUUID();
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
async function transitionTaskStatus(taskId, from, to, claimToken, deps) {
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
    const updated = {
      ...v,
      status: to,
      completed_at: (/* @__PURE__ */ new Date()).toISOString(),
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
  const tasksRoot = join2(deps.teamDir(teamName, cwd), "tasks");
  if (!existsSync(tasksRoot)) return [];
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
        const raw = await readFile(join2(tasksRoot, fileName), "utf8");
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
var init_tasks = __esm({
  "src/team/state/tasks.ts"() {
    "use strict";
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
    workers
  };
}
var init_worker_canonicalization = __esm({
  "src/team/worker-canonicalization.ts"() {
    "use strict";
  }
});

// src/team/team-ops.ts
var team_ops_exports = {};
__export(team_ops_exports, {
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
  teamReadConfig: () => teamReadConfig,
  teamReadManifest: () => teamReadManifest,
  teamReadMonitorSnapshot: () => teamReadMonitorSnapshot,
  teamReadShutdownAck: () => teamReadShutdownAck,
  teamReadTask: () => teamReadTask,
  teamReadTaskApproval: () => teamReadTaskApproval,
  teamReadWorkerHeartbeat: () => teamReadWorkerHeartbeat,
  teamReadWorkerStatus: () => teamReadWorkerStatus,
  teamReleaseTaskClaim: () => teamReleaseTaskClaim,
  teamSendMessage: () => teamSendMessage,
  teamTransitionTaskStatus: () => teamTransitionTaskStatus,
  teamUpdateTask: () => teamUpdateTask,
  teamUpdateWorkerHeartbeat: () => teamUpdateWorkerHeartbeat,
  teamWriteMonitorSnapshot: () => teamWriteMonitorSnapshot,
  teamWriteShutdownRequest: () => teamWriteShutdownRequest,
  teamWriteTaskApproval: () => teamWriteTaskApproval,
  teamWriteWorkerIdentity: () => teamWriteWorkerIdentity,
  teamWriteWorkerInbox: () => teamWriteWorkerInbox,
  writeAtomic: () => writeAtomic
});
import { randomUUID as randomUUID2 } from "node:crypto";
import { existsSync as existsSync2 } from "node:fs";
import { appendFile, mkdir, readFile as readFile2, rm, writeFile } from "node:fs/promises";
import { dirname, join as join3 } from "node:path";
function teamDir(teamName, cwd) {
  return absPath(cwd, TeamPaths.root(teamName));
}
function normalizeTaskId(taskId) {
  const raw = String(taskId).trim();
  return raw.startsWith("task-") ? raw.slice("task-".length) : raw;
}
function canonicalTaskFilePath(teamName, taskId, cwd) {
  const normalizedTaskId = normalizeTaskId(taskId);
  return join3(absPath(cwd, TeamPaths.tasks(teamName)), `task-${normalizedTaskId}.json`);
}
function legacyTaskFilePath(teamName, taskId, cwd) {
  const normalizedTaskId = normalizeTaskId(taskId);
  return join3(absPath(cwd, TeamPaths.tasks(teamName)), `${normalizedTaskId}.json`);
}
function taskFileCandidates(teamName, taskId, cwd) {
  const canonical = canonicalTaskFilePath(teamName, taskId, cwd);
  const legacy = legacyTaskFilePath(teamName, taskId, cwd);
  return canonical === legacy ? [canonical] : [canonical, legacy];
}
async function writeAtomic(path, data) {
  const tmp = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, data, "utf8");
  const { rename: rename2 } = await import("node:fs/promises");
  await rename2(tmp, path);
}
async function readJsonSafe(path) {
  try {
    if (!existsSync2(path)) return null;
    const raw = await readFile2(path, "utf8");
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
async function withLock(lockDir, fn) {
  const STALE_MS = 3e4;
  try {
    await mkdir(lockDir, { recursive: false });
  } catch (err) {
    if (err.code === "EEXIST") {
      try {
        const { stat: stat2 } = await import("node:fs/promises");
        const s = await stat2(lockDir);
        if (Date.now() - s.mtimeMs > STALE_MS) {
          await rm(lockDir, { recursive: true, force: true });
          try {
            await mkdir(lockDir, { recursive: false });
          } catch {
            return { ok: false };
          }
        } else {
          return { ok: false };
        }
      } catch {
        return { ok: false };
      }
    } else {
      throw err;
    }
  }
  try {
    const result = await fn();
    return { ok: true, value: result };
  } finally {
    await rm(lockDir, { recursive: true, force: true }).catch(() => {
    });
  }
}
async function withTaskClaimLock(teamName, taskId, cwd, fn) {
  const lockDir = join3(teamDir(teamName, cwd), "tasks", `.lock-${taskId}`);
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
    await new Promise((resolve4) => setTimeout(resolve4, delayMs));
    delayMs = Math.min(delayMs * 2, 200);
  }
  throw new Error(`Failed to acquire mailbox lock for ${workerName} after ${timeoutMs}ms`);
}
async function teamReadConfig(teamName, cwd) {
  const manifest = await teamReadManifest(teamName, cwd);
  if (manifest) {
    return canonicalizeTeamConfigWorkers({
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
    });
  }
  const configPath = absPath(cwd, TeamPaths.config(teamName));
  const config = await readJsonSafe(configPath);
  return config ? canonicalizeTeamConfigWorkers(config) : null;
}
async function teamReadManifest(teamName, cwd) {
  const manifestPath = absPath(cwd, TeamPaths.manifest(teamName));
  const manifest = await readJsonSafe(manifestPath);
  return manifest ? normalizeTeamManifest(manifest) : null;
}
async function teamCleanup(teamName, cwd) {
  await rm(teamDir(teamName, cwd), { recursive: true, force: true });
}
async function teamWriteWorkerIdentity(teamName, workerName, identity, cwd) {
  const p = absPath(cwd, TeamPaths.workerIdentity(teamName, workerName));
  await writeAtomic(p, JSON.stringify(identity, null, 2));
}
async function teamReadWorkerHeartbeat(teamName, workerName, cwd) {
  const p = absPath(cwd, TeamPaths.heartbeat(teamName, workerName));
  return readJsonSafe(p);
}
async function teamUpdateWorkerHeartbeat(teamName, workerName, heartbeat, cwd) {
  const p = absPath(cwd, TeamPaths.heartbeat(teamName, workerName));
  await writeAtomic(p, JSON.stringify(heartbeat, null, 2));
}
async function teamReadWorkerStatus(teamName, workerName, cwd) {
  const unknownStatus = { state: "unknown", updated_at: "1970-01-01T00:00:00.000Z" };
  const p = absPath(cwd, TeamPaths.workerStatus(teamName, workerName));
  const status = await readJsonSafe(p);
  return status ?? unknownStatus;
}
async function teamWriteWorkerInbox(teamName, workerName, prompt, cwd) {
  const p = absPath(cwd, TeamPaths.inbox(teamName, workerName));
  await writeAtomic(p, prompt);
}
async function teamCreateTask(teamName, task, cwd) {
  const cfg = await teamReadConfig(teamName, cwd);
  if (!cfg) throw new Error(`Team ${teamName} not found`);
  const nextId = String(cfg.next_task_id ?? 1);
  const created = {
    ...task,
    id: nextId,
    status: task.status ?? "pending",
    depends_on: task.depends_on ?? task.blocked_by ?? [],
    version: 1,
    created_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  const taskPath2 = absPath(cwd, TeamPaths.tasks(teamName));
  await mkdir(taskPath2, { recursive: true });
  await writeAtomic(join3(taskPath2, `task-${nextId}.json`), JSON.stringify(created, null, 2));
  cfg.next_task_id = Number(nextId) + 1;
  await writeAtomic(absPath(cwd, TeamPaths.config(teamName)), JSON.stringify(cfg, null, 2));
  return created;
}
async function teamReadTask(teamName, taskId, cwd) {
  for (const candidate of taskFileCandidates(teamName, taskId, cwd)) {
    const task = await readJsonSafe(candidate);
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
  await writeAtomic(p, JSON.stringify(merged, null, 2));
  return merged;
}
async function teamClaimTask(teamName, taskId, workerName, expectedVersion, cwd) {
  const manifest = await teamReadManifest(teamName, cwd);
  const governance = normalizeTeamGovernance(manifest?.governance, manifest?.policy);
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
    readTeamConfig: teamReadConfig,
    withTaskClaimLock,
    normalizeTask,
    isTerminalTaskStatus: isTerminalTeamTaskStatus,
    taskFilePath: (tn, tid, c) => canonicalTaskFilePath(tn, tid, c),
    writeAtomic
  });
}
async function teamTransitionTaskStatus(teamName, taskId, from, to, claimToken, cwd) {
  return transitionTaskStatus(taskId, from, to, claimToken, {
    teamName,
    cwd,
    readTask: teamReadTask,
    readTeamConfig: teamReadConfig,
    withTaskClaimLock,
    normalizeTask,
    isTerminalTaskStatus: isTerminalTeamTaskStatus,
    canTransitionTaskStatus: canTransitionTeamTaskStatus,
    taskFilePath: (tn, tid, c) => canonicalTaskFilePath(tn, tid, c),
    writeAtomic,
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
    writeAtomic
  });
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
  if (!existsSync2(legacyPath)) return { worker: workerName, messages: [] };
  try {
    const raw = await readFile2(legacyPath, "utf8");
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
  const mailbox = await readJsonSafe(p);
  if (mailbox && Array.isArray(mailbox.messages)) {
    return { worker: workerName, messages: mailbox.messages };
  }
  return readLegacyMailboxJsonl(teamName, workerName, cwd);
}
async function writeMailbox(teamName, workerName, mailbox, cwd) {
  const p = absPath(cwd, TeamPaths.mailbox(teamName, workerName));
  await writeAtomic(p, JSON.stringify(mailbox, null, 2));
}
async function teamSendMessage(teamName, fromWorker, toWorker, body, cwd) {
  return withMailboxLock(teamName, toWorker, cwd, async () => {
    const mailbox = await readMailbox(teamName, toWorker, cwd);
    const message = {
      message_id: randomUUID2(),
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
    event_id: randomUUID2(),
    team: teamName,
    created_at: (/* @__PURE__ */ new Date()).toISOString(),
    ...event
  };
  const p = absPath(cwd, TeamPaths.events(teamName));
  await mkdir(dirname(p), { recursive: true });
  await appendFile(p, `${JSON.stringify(full)}
`, "utf8");
  return full;
}
async function teamReadTaskApproval(teamName, taskId, cwd) {
  const p = absPath(cwd, TeamPaths.approval(teamName, taskId));
  return readJsonSafe(p);
}
async function teamWriteTaskApproval(teamName, approval, cwd) {
  const p = absPath(cwd, TeamPaths.approval(teamName, approval.task_id));
  await writeAtomic(p, JSON.stringify(approval, null, 2));
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
    if (!hb) {
      nonReporting.push(w.name);
      workerEntries.push({ name: w.name, alive: false, lastTurnAt: null, turnsWithoutProgress: 0 });
    } else {
      workerEntries.push({
        name: w.name,
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
    tasks: counts,
    workers: workerEntries,
    nonReportingWorkers: nonReporting,
    performance: performance2
  };
}
async function teamWriteShutdownRequest(teamName, workerName, requestedBy, cwd) {
  const p = absPath(cwd, TeamPaths.shutdownRequest(teamName, workerName));
  await writeAtomic(p, JSON.stringify({ requested_at: (/* @__PURE__ */ new Date()).toISOString(), requested_by: requestedBy }, null, 2));
}
async function teamReadShutdownAck(teamName, workerName, cwd, minUpdatedAt) {
  const ackPath = absPath(cwd, TeamPaths.shutdownAck(teamName, workerName));
  const parsed = await readJsonSafe(ackPath);
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
  return readJsonSafe(p);
}
async function teamWriteMonitorSnapshot(teamName, snapshot, cwd) {
  const p = absPath(cwd, TeamPaths.monitorSnapshot(teamName));
  await writeAtomic(p, JSON.stringify(snapshot, null, 2));
}
var init_team_ops = __esm({
  "src/team/team-ops.ts"() {
    "use strict";
    init_state_paths();
    init_governance();
    init_governance();
    init_contracts();
    init_tasks();
    init_worker_canonicalization();
  }
});

// src/team/fs-utils.ts
import { writeFileSync, existsSync as existsSync3, mkdirSync, renameSync, openSync, writeSync, closeSync, realpathSync, constants } from "fs";
import { dirname as dirname2, resolve, relative, basename } from "path";
function atomicWriteJson(filePath, data, mode = 384) {
  const dir = dirname2(filePath);
  if (!existsSync3(dir)) mkdirSync(dir, { recursive: true, mode: 448 });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", { encoding: "utf-8", mode });
  renameSync(tmpPath, filePath);
}
function ensureDirWithMode(dirPath, mode = 448) {
  if (!existsSync3(dirPath)) mkdirSync(dirPath, { recursive: true, mode });
}
function safeRealpath(p) {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname2(p);
    const name = basename(p);
    try {
      return resolve(realpathSync(parent), name);
    } catch {
      return resolve(p);
    }
  }
}
function validateResolvedPath(resolvedPath, expectedBase) {
  const absResolved = safeRealpath(resolvedPath);
  const absBase = safeRealpath(expectedBase);
  const rel = relative(absBase, absResolved);
  if (rel.startsWith("..") || resolve(absBase, rel) !== absResolved) {
    throw new Error(`Path traversal detected: "${resolvedPath}" escapes base "${expectedBase}"`);
  }
}
var init_fs_utils = __esm({
  "src/team/fs-utils.ts"() {
    "use strict";
  }
});

// src/team/dispatch-queue.ts
import { randomUUID as randomUUID3 } from "crypto";
import { existsSync as existsSync4 } from "fs";
import { mkdir as mkdir2, readFile as readFile3, rm as rm2, stat, writeFile as writeFile2 } from "fs/promises";
import { dirname as dirname3, join as join4 } from "path";
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
  if (!existsSync4(root)) throw new Error(`Team ${teamName} not found`);
  const lockDir = absPath(cwd, TeamPaths.dispatchLockDir(teamName));
  const ownerPath = join4(lockDir, "owner");
  const ownerToken = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const timeoutMs = resolveDispatchLockTimeoutMs(process.env);
  const deadline = Date.now() + timeoutMs;
  let pollMs = DISPATCH_LOCK_INITIAL_POLL_MS;
  await mkdir2(dirname3(lockDir), { recursive: true });
  while (true) {
    try {
      await mkdir2(lockDir, { recursive: false });
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
      await new Promise((resolve4) => setTimeout(resolve4, Math.floor(pollMs * jitter)));
      pollMs = Math.min(pollMs * 2, DISPATCH_LOCK_MAX_POLL_MS);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      const currentOwner = await readFile3(ownerPath, "utf8");
      if (currentOwner.trim() === ownerToken) {
        await rm2(lockDir, { recursive: true, force: true });
      }
    } catch {
    }
  }
}
async function readDispatchRequestsFromFile(teamName, cwd) {
  const path = absPath(cwd, TeamPaths.dispatchRequests(teamName));
  try {
    if (!existsSync4(path)) return [];
    const raw = await readFile3(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => normalizeDispatchRequest(teamName, entry)).filter((req) => req !== null);
  } catch {
    return [];
  }
}
async function writeDispatchRequestsToFile(teamName, requests, cwd) {
  const path = absPath(cwd, TeamPaths.dispatchRequests(teamName));
  const dir = dirname3(path);
  ensureDirWithMode(dir);
  atomicWriteJson(path, requests);
}
function normalizeDispatchRequest(teamName, raw, nowIso = (/* @__PURE__ */ new Date()).toISOString()) {
  if (!isDispatchKind(raw.kind)) return null;
  if (typeof raw.to_worker !== "string" || raw.to_worker.trim() === "") return null;
  if (typeof raw.trigger_message !== "string" || raw.trigger_message.trim() === "") return null;
  const status = isDispatchStatus(raw.status) ? raw.status : "pending";
  return {
    request_id: typeof raw.request_id === "string" && raw.request_id.trim() !== "" ? raw.request_id : randomUUID3(),
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
        request_id: randomUUID3(),
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

// src/team/mcp-comm.ts
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
async function markImmediateDispatchFailure(params) {
  const { teamName, request, reason, messageId, cwd } = params;
  if (request.transport_preference === "hook_preferred_with_fallback") return;
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
  ).catch(() => {
  });
}
async function markLeaderPaneMissingDeferred(params) {
  const { teamName, request, cwd, messageId } = params;
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
  ).catch(() => {
  });
}
async function queueInboxInstruction(params) {
  await params.deps.writeWorkerInbox(params.teamName, params.workerName, params.inbox, params.cwd);
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
  const outcome = {
    ...notifyOutcome,
    request_id: queued.request.request_id,
    message_id: message.message_id,
    to_worker: params.toWorker
  };
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
  const messages = await params.deps.broadcastMessage(params.teamName, params.fromWorker, params.body, params.cwd);
  const recipientByName = new Map(params.recipients.map((r) => [r.workerName, r]));
  const outcomes = [];
  for (const message of messages) {
    const recipient = recipientByName.get(message.to_worker);
    if (!recipient) continue;
    const queued = await enqueueDispatchRequest(
      params.teamName,
      {
        kind: "mailbox",
        to_worker: recipient.workerName,
        worker_index: recipient.workerIndex,
        pane_id: recipient.paneId,
        trigger_message: params.triggerFor(recipient.workerName),
        message_id: message.message_id,
        transport_preference: params.transportPreference,
        fallback_allowed: params.fallbackAllowed
      },
      params.cwd
    );
    if (queued.deduped) {
      outcomes.push({
        ok: false,
        transport: "none",
        reason: "duplicate_pending_dispatch_request",
        request_id: queued.request.request_id,
        message_id: message.message_id,
        to_worker: recipient.workerName
      });
      continue;
    }
    const notifyOutcome = await Promise.resolve(params.notify(
      { workerName: recipient.workerName, workerIndex: recipient.workerIndex, paneId: recipient.paneId },
      params.triggerFor(recipient.workerName),
      { request: queued.request, message_id: message.message_id }
    )).catch((error) => ({
      ok: false,
      transport: fallbackTransportForPreference(params.transportPreference),
      reason: notifyExceptionReason(error)
    }));
    const outcome = {
      ...notifyOutcome,
      request_id: queued.request.request_id,
      message_id: message.message_id,
      to_worker: recipient.workerName
    };
    outcomes.push(outcome);
    if (isConfirmedNotification(outcome)) {
      await params.deps.markMessageNotified(params.teamName, recipient.workerName, message.message_id, params.cwd);
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
  }
  return outcomes;
}
var init_mcp_comm = __esm({
  "src/team/mcp-comm.ts"() {
    "use strict";
    init_dispatch_queue();
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

// src/team/tmux-session.ts
var tmux_session_exports = {};
__export(tmux_session_exports, {
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
import { exec, execFile, execSync, execFileSync } from "child_process";
import { existsSync as existsSync5 } from "fs";
import { join as join5, basename as basename2, isAbsolute, win32 } from "path";
import { promisify } from "util";
import fs from "fs/promises";
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
function getDefaultShell() {
  if (process.platform === "win32" && !isUnixLikeOnWindows()) {
    return process.env.COMSPEC || "cmd.exe";
  }
  const shell = process.env.SHELL || "/bin/bash";
  const name = basename2(shell.replace(/\\/g, "/")).replace(/\.(exe|cmd|bat)$/i, "");
  if (!SUPPORTED_POSIX_SHELLS.has(name)) {
    return "/bin/sh";
  }
  return shell;
}
function resolveShellFromCandidates(paths, rcFile) {
  for (const p of paths) {
    if (existsSync5(p)) return { shell: p, rcFile };
  }
  return null;
}
function resolveSupportedShellAffinity(shellPath) {
  if (!shellPath) return null;
  const name = basename2(shellPath.replace(/\\/g, "/")).replace(/\.(exe|cmd|bat)$/i, "");
  if (name !== "zsh" && name !== "bash") return null;
  if (!existsSync5(shellPath)) return null;
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
  const shellName = basename2(shellPath.replace(/\\/g, "/"));
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
  return isAbsolute(value) || win32.isAbsolute(value);
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
    execSync("tmux -V", { encoding: "utf-8", timeout: 5e3, stdio: "pipe" });
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
    execFileSync("tmux", ["kill-session", "-t", name], { stdio: "pipe", timeout: 5e3 });
  } catch {
  }
  const args = ["new-session", "-d", "-s", name, "-x", "200", "-y", "50"];
  if (workingDirectory) {
    args.push("-c", workingDirectory);
  }
  execFileSync("tmux", args, { stdio: "pipe", timeout: 5e3 });
  return name;
}
function killSession(teamName, workerName) {
  const name = sessionName(teamName, workerName);
  try {
    execFileSync("tmux", ["kill-session", "-t", name], { stdio: "pipe", timeout: 5e3 });
  } catch {
  }
}
function isSessionAlive(teamName, workerName) {
  const name = sessionName(teamName, workerName);
  try {
    execFileSync("tmux", ["has-session", "-t", name], { stdio: "pipe", timeout: 5e3 });
    return true;
  } catch {
    return false;
  }
}
function listActiveSessions(teamName) {
  const prefix = `${TMUX_SESSION_PREFIX}-${sanitizeName(teamName)}-`;
  try {
    const output2 = execSync("tmux list-sessions -F '#{session_name}'", {
      encoding: "utf-8",
      timeout: 5e3,
      stdio: ["pipe", "pipe", "pipe"]
    });
    return output2.trim().split("\n").filter((s) => s.startsWith(prefix)).map((s) => s.slice(prefix.length));
  } catch {
    return [];
  }
}
function spawnBridgeInSession(tmuxSession, bridgeScriptPath, configFilePath) {
  const cmd = `node "${bridgeScriptPath}" --config "${configFilePath}"`;
  execFileSync("tmux", ["send-keys", "-t", tmuxSession, cmd, "Enter"], { stdio: "pipe", timeout: 5e3 });
}
async function createTeamSession(teamName, workerCount, cwd, options = {}) {
  const { execFile: execFile3 } = await import("child_process");
  const { promisify: promisify2 } = await import("util");
  const execFileAsync = promisify2(execFile3);
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
  if (useDedicatedWindow) {
    const targetSession = sessionAndWindow.split(":")[0] ?? sessionAndWindow;
    const windowName = `omc-${sanitizeName(teamName)}`.slice(0, 32);
    const newWindowResult = await execFileAsync("tmux", [
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
      await execFileAsync("tmux", ["set-option", "-t", resolvedSessionName, "mouse", "on"]);
    } catch {
    }
    if (sessionMode !== "dedicated-window") {
      try {
        await execFileAsync("tmux", ["select-pane", "-t", leaderPaneId]);
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
  if (sessionMode !== "dedicated-window") {
    try {
      await execFileAsync("tmux", ["select-pane", "-t", leaderPaneId]);
    } catch {
    }
  }
  await new Promise((r) => setTimeout(r, 300));
  return { sessionName: teamTarget, leaderPaneId, workerPaneIds, sessionMode };
}
async function spawnWorkerInPane(sessionName2, paneId, config) {
  const { execFile: execFile3 } = await import("child_process");
  const { promisify: promisify2 } = await import("util");
  const execFileAsync = promisify2(execFile3);
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
    const { execFile: execFile3 } = await import("child_process");
    const { promisify: promisify2 } = await import("util");
    const execFileAsync = promisify2(execFile3);
    const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
    const sendKey = async (key) => {
      await execFileAsync("tmux", ["send-keys", "-t", paneId, key]);
    };
    if (await paneInCopyMode(paneId)) {
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
    if (await paneInCopyMode(paneId)) {
      return false;
    }
    const finalCapture = await capturePaneAsync(paneId, execFileAsync);
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
    if (await paneInCopyMode(paneId)) {
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
    const { execFile: execFile3 } = await import("child_process");
    const { promisify: promisify2 } = await import("util");
    const execFileAsync = promisify2(execFile3);
    if (await paneInCopyMode(leaderPaneId)) {
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
  const shutdownPath = join5(cwd, ".omc", "state", "team", teamName, "shutdown.json");
  try {
    await fs.writeFile(shutdownPath, JSON.stringify({ requestedAt: Date.now() }));
    const aliveChecks = await Promise.all(paneIds.map((id) => isWorkerAlive(id)));
    if (aliveChecks.some((alive) => alive)) {
      await sleep(graceMs);
    }
  } catch {
  }
  const { execFile: execFile3 } = await import("child_process");
  const { promisify: promisify2 } = await import("util");
  const execFileAsync = promisify2(execFile3);
  for (const paneId of paneIds) {
    if (paneId === leaderPaneId) continue;
    try {
      await execFileAsync("tmux", ["kill-pane", "-t", paneId]);
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
  const { execFile: execFile3 } = await import("child_process");
  const { promisify: promisify2 } = await import("util");
  const execFileAsync = promisify2(execFile3);
  const sessionMode = options.sessionMode ?? (sessionName2.includes(":") ? "split-pane" : "detached-session");
  if (sessionMode === "split-pane") {
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
  if (sessionMode === "dedicated-window") {
    try {
      await execFileAsync("tmux", ["kill-window", "-t", sessionName2]);
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
    await execFileAsync("tmux", ["kill-session", "-t", sessionTarget]);
  } catch {
  }
}
var sleep, TMUX_SESSION_PREFIX, promisifiedExec, promisifiedExecFile, SUPPORTED_POSIX_SHELLS, ZSH_CANDIDATES, BASH_CANDIDATES, DANGEROUS_LAUNCH_BINARY_CHARS;
var init_tmux_session = __esm({
  "src/team/tmux-session.ts"() {
    "use strict";
    init_team_name();
    sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    TMUX_SESSION_PREFIX = "omc-team";
    promisifiedExec = promisify(exec);
    promisifiedExecFile = promisify(execFile);
    SUPPORTED_POSIX_SHELLS = /* @__PURE__ */ new Set(["sh", "bash", "zsh", "fish", "ksh"]);
    ZSH_CANDIDATES = ["/bin/zsh", "/usr/bin/zsh", "/usr/local/bin/zsh", "/opt/homebrew/bin/zsh"];
    BASH_CANDIDATES = ["/bin/bash", "/usr/bin/bash"];
    DANGEROUS_LAUNCH_BINARY_CHARS = /[;&|`$()<>\n\r\t\0]/;
  }
});

// src/agents/utils.ts
import { readFileSync } from "fs";
import { join as join6, dirname as dirname4, basename as basename3, resolve as resolve2, relative as relative2, isAbsolute as isAbsolute2 } from "path";
import { fileURLToPath } from "url";
function getPackageDir() {
  if (typeof __dirname !== "undefined" && __dirname) {
    const currentDirName = basename3(__dirname);
    const parentDirName = basename3(dirname4(__dirname));
    if (currentDirName === "bridge") {
      return join6(__dirname, "..");
    }
    if (currentDirName === "agents" && (parentDirName === "src" || parentDirName === "dist")) {
      return join6(__dirname, "..", "..");
    }
  }
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname2 = dirname4(__filename);
    return join6(__dirname2, "..", "..");
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
    const agentsDir = join6(getPackageDir(), "agents");
    const agentPath = join6(agentsDir, `${agentName}.md`);
    const resolvedPath = resolve2(agentPath);
    const resolvedAgentsDir = resolve2(agentsDir);
    const rel = relative2(resolvedAgentsDir, resolvedPath);
    if (rel.startsWith("..") || isAbsolute2(rel)) {
      throw new Error(`Invalid agent name: path traversal detected`);
    }
    const content = readFileSync(agentPath, "utf-8");
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

// src/agents/prompt-helpers.ts
import { readdirSync } from "fs";
import { join as join7, dirname as dirname5, basename as basename4 } from "path";
import { fileURLToPath as fileURLToPath2 } from "url";
function getPackageDir2() {
  if (typeof __dirname !== "undefined" && __dirname) {
    const currentDirName = basename4(__dirname);
    const parentDirName = basename4(dirname5(__dirname));
    if (currentDirName === "bridge") {
      return join7(__dirname, "..");
    }
    if (currentDirName === "agents" && (parentDirName === "src" || parentDirName === "dist")) {
      return join7(__dirname, "..", "..");
    }
  }
  try {
    const __filename = fileURLToPath2(import.meta.url);
    const __dirname2 = dirname5(__filename);
    return join7(__dirname2, "..", "..");
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
    const agentsDir = join7(getPackageDir2(), "agents");
    const files = readdirSync(agentsDir);
    _cachedRoles = files.filter((f) => f.endsWith(".md")).map((f) => basename4(f, ".md")).sort();
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
  sanitized = sanitized.replace(/<(\/?)(TASK_SUBJECT)[^>]*>/gi, "[$1$2]");
  sanitized = sanitized.replace(/<(\/?)(TASK_DESCRIPTION)[^>]*>/gi, "[$1$2]");
  sanitized = sanitized.replace(/<(\/?)(INBOX_MESSAGE)[^>]*>/gi, "[$1$2]");
  sanitized = sanitized.replace(/<(\/?)(INSTRUCTIONS)[^>]*>/gi, "[$1$2]");
  sanitized = sanitized.replace(/<(\/?)(SYSTEM)[^>]*>/gi, "[$1$2]");
  return sanitized;
}
var _cachedRoles, VALID_AGENT_ROLES;
var init_prompt_helpers = __esm({
  "src/agents/prompt-helpers.ts"() {
    "use strict";
    init_utils();
    _cachedRoles = null;
    VALID_AGENT_ROLES = getValidAgentRoles();
  }
});

// src/utils/omc-cli-rendering.ts
import { spawnSync } from "child_process";
function commandExists(command, env) {
  const lookupCommand = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(lookupCommand, [command], {
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
var OMC_CLI_BINARY, OMC_PLUGIN_BRIDGE_PREFIX;
var init_omc_cli_rendering = __esm({
  "src/utils/omc-cli-rendering.ts"() {
    "use strict";
    OMC_CLI_BINARY = "omc";
    OMC_PLUGIN_BRIDGE_PREFIX = 'node "$CLAUDE_PLUGIN_ROOT"/bridge/cli.cjs';
  }
});

// src/utils/config-dir.ts
var init_config_dir = __esm({
  "src/utils/config-dir.ts"() {
    "use strict";
  }
});

// src/utils/paths.ts
import { join as join8 } from "path";
import { existsSync as existsSync6, readFileSync as readFileSync2, readdirSync as readdirSync2, statSync, unlinkSync, rmSync } from "fs";
import { homedir } from "os";
var STALE_THRESHOLD_MS;
var init_paths = __esm({
  "src/utils/paths.ts"() {
    "use strict";
    init_config_dir();
    STALE_THRESHOLD_MS = 24 * 60 * 60 * 1e3;
  }
});

// src/utils/jsonc.ts
var init_jsonc = __esm({
  "src/utils/jsonc.ts"() {
    "use strict";
  }
});

// src/utils/ssrf-guard.ts
var init_ssrf_guard = __esm({
  "src/utils/ssrf-guard.ts"() {
    "use strict";
  }
});

// src/config/models.ts
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
var TIER_ENV_KEYS, CLAUDE_FAMILY_DEFAULTS, BUILTIN_TIER_MODEL_DEFAULTS, CLAUDE_FAMILY_HIGH_VARIANTS, BUILTIN_EXTERNAL_MODEL_DEFAULTS;
var init_models = __esm({
  "src/config/models.ts"() {
    "use strict";
    init_ssrf_guard();
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
      SONNET: "claude-sonnet-4-6",
      OPUS: "claude-opus-4-6"
    };
    BUILTIN_TIER_MODEL_DEFAULTS = {
      LOW: CLAUDE_FAMILY_DEFAULTS.HAIKU,
      MEDIUM: CLAUDE_FAMILY_DEFAULTS.SONNET,
      HIGH: CLAUDE_FAMILY_DEFAULTS.OPUS
    };
    CLAUDE_FAMILY_HIGH_VARIANTS = {
      HAIKU: `${CLAUDE_FAMILY_DEFAULTS.HAIKU}-high`,
      SONNET: `${CLAUDE_FAMILY_DEFAULTS.SONNET}-high`,
      OPUS: `${CLAUDE_FAMILY_DEFAULTS.OPUS}-high`
    };
    BUILTIN_EXTERNAL_MODEL_DEFAULTS = {
      codexModel: "gpt-5.3-codex",
      geminiModel: "gemini-3.1-pro-preview"
    };
  }
});

// src/config/loader.ts
import { readFileSync as readFileSync3, existsSync as existsSync7 } from "fs";
import { join as join9, dirname as dirname6 } from "path";
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
    }
  };
}
var DEFAULT_CONFIG;
var init_loader = __esm({
  "src/config/loader.ts"() {
    "use strict";
    init_paths();
    init_jsonc();
    init_models();
    DEFAULT_CONFIG = buildDefaultConfig();
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

// src/features/delegation-routing/types.ts
var init_types = __esm({
  "src/features/delegation-routing/types.ts"() {
    "use strict";
  }
});

// src/features/delegation-enforcer.ts
function normalizeToCcAlias(model) {
  const family = resolveClaudeFamily(model);
  return family ? FAMILY_TO_ALIAS[family] ?? model : model;
}
var FAMILY_TO_ALIAS;
var init_delegation_enforcer = __esm({
  "src/features/delegation-enforcer.ts"() {
    "use strict";
    init_definitions();
    init_types();
    init_loader();
    init_models();
    FAMILY_TO_ALIAS = {
      SONNET: "sonnet",
      OPUS: "opus",
      HAIKU: "haiku"
    };
  }
});

// src/team/model-contract.ts
import { spawnSync as spawnSync2 } from "child_process";
import { isAbsolute as isAbsolute3, normalize, win32 as win32Path } from "path";
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
  const custom = (process.env.OMC_TRUSTED_CLI_DIRS ?? "").split(":").map((part) => part.trim()).filter(Boolean).filter((part) => isAbsolute3(part));
  trusted.push(...custom);
  return trusted;
}
function isTrustedPrefix(resolvedPath) {
  const normalized = normalize(resolvedPath);
  return getTrustedPrefixes().some((prefix) => normalized.startsWith(normalize(prefix)));
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
  const result = spawnSync2(finder, [binary], {
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
  const resolvedPath = normalize(firstLine);
  if (!isAbsolute3(resolvedPath)) {
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
function getContract(agentType) {
  const contract = CONTRACTS[agentType];
  if (!contract) {
    throw new Error(`Unknown agent type: ${agentType}. Supported: ${Object.keys(CONTRACTS).join(", ")}`);
  }
  return contract;
}
function validateBinaryRef(binary) {
  if (isAbsolute3(binary)) return;
  if (/^[A-Za-z0-9._-]+$/.test(binary)) return;
  throw new Error(`Unsafe CLI binary reference: ${binary}`);
}
function resolveBinaryPath(binary) {
  validateBinaryRef(binary);
  if (isAbsolute3(binary)) return binary;
  try {
    const resolver = process.platform === "win32" ? "where" : "which";
    const result = spawnSync2(resolver, [binary], { timeout: 5e3, encoding: "utf8" });
    if (result.status !== 0) return binary;
    const lines = result.stdout?.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) ?? [];
    const firstPath = lines[0];
    const isResolvedAbsolute = !!firstPath && (isAbsolute3(firstPath) || win32Path.isAbsolute(firstPath));
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
var resolvedPathCache, UNTRUSTED_PATH_PATTERNS, CONTRACTS, WORKER_MODEL_ENV_ALLOWLIST;
var init_model_contract = __esm({
  "src/team/model-contract.ts"() {
    "use strict";
    init_team_name();
    init_delegation_enforcer();
    init_models();
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
      "OMC_GEMINI_DEFAULT_MODEL"
    ];
  }
});

// src/team/worker-bootstrap.ts
import { mkdir as mkdir3, writeFile as writeFile3, appendFile as appendFile2 } from "fs/promises";
import { join as join10, dirname as dirname7 } from "path";
function buildInstructionPath(...parts) {
  return join10(...parts).replaceAll("\\", "/");
}
function generateTriggerMessage(teamName, workerName, teamStateRoot3 = ".omc/state") {
  const inboxPath = buildInstructionPath(teamStateRoot3, "team", teamName, "workers", workerName, "inbox.md");
  if (teamStateRoot3 !== ".omc/state") {
    return `Read ${inboxPath}, work now, report progress.`;
  }
  return `Read ${inboxPath}, start work now, report concrete progress (not ACK-only), and keep executing your assigned or next feasible work.`;
}
function generateMailboxTriggerMessage(teamName, workerName, count = 1, teamStateRoot3 = ".omc/state") {
  const normalizedCount = Number.isFinite(count) ? Math.max(1, Math.floor(count)) : 1;
  const mailboxPath = buildInstructionPath(teamStateRoot3, "team", teamName, "mailbox", `${workerName}.json`);
  if (teamStateRoot3 !== ".omc/state") {
    return `${normalizedCount} new msg(s): check ${mailboxPath}, act and report progress.`;
  }
  return `You have ${normalizedCount} new message(s). Check ${mailboxPath}, act now, reply with concrete progress (not ACK-only), and keep executing your assigned or next feasible work.`;
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
  const { teamName, workerName, agentType, tasks, bootstrapInstructions } = params;
  const sanitizedTasks = tasks.map((t) => ({
    id: t.id,
    subject: sanitizePromptContent(t.subject),
    description: sanitizePromptContent(t.description)
  }));
  const sentinelPath = `.omc/state/team/${teamName}/workers/${workerName}/.ready`;
  const heartbeatPath = `.omc/state/team/${teamName}/workers/${workerName}/heartbeat.json`;
  const inboxPath = `.omc/state/team/${teamName}/workers/${workerName}/inbox.md`;
  const statusPath = `.omc/state/team/${teamName}/workers/${workerName}/status.json`;
  const claimTaskCommand = formatOmcCliInvocation(`team api claim-task --input "{\\"team_name\\":\\"${teamName}\\",\\"task_id\\":\\"<id>\\",\\"worker\\":\\"${workerName}\\"}" --json`);
  const sendAckCommand = formatOmcCliInvocation(`team api send-message --input "{\\"team_name\\":\\"${teamName}\\",\\"from_worker\\":\\"${workerName}\\",\\"to_worker\\":\\"leader-fixed\\",\\"body\\":\\"ACK: ${workerName} initialized\\"}" --json`);
  const completeTaskCommand = formatOmcCliInvocation(`team api transition-task-status --input "{\\"team_name\\":\\"${teamName}\\",\\"task_id\\":\\"<id>\\",\\"from\\":\\"in_progress\\",\\"to\\":\\"completed\\",\\"claim_token\\":\\"<claim_token>\\"}" --json`);
  const failTaskCommand = formatOmcCliInvocation(`team api transition-task-status --input "{\\"team_name\\":\\"${teamName}\\",\\"task_id\\":\\"<id>\\",\\"from\\":\\"in_progress\\",\\"to\\":\\"failed\\",\\"claim_token\\":\\"<claim_token>\\"}" --json`);
  const readTaskCommand = formatOmcCliInvocation(`team api read-task --input "{\\"team_name\\":\\"${teamName}\\",\\"task_id\\":\\"<id>\\"}" --json`);
  const releaseClaimCommand = formatOmcCliInvocation(`team api release-task-claim --input "{\\"team_name\\":\\"${teamName}\\",\\"task_id\\":\\"<id>\\",\\"claim_token\\":\\"<claim_token>\\",\\"worker\\":\\"${workerName}\\"}" --json`);
  const mailboxListCommand = formatOmcCliInvocation(`team api mailbox-list --input "{\\"team_name\\":\\"${teamName}\\",\\"worker\\":\\"${workerName}\\"}" --json`);
  const mailboxDeliveredCommand = formatOmcCliInvocation(`team api mailbox-mark-delivered --input "{\\"team_name\\":\\"${teamName}\\",\\"worker\\":\\"${workerName}\\",\\"message_id\\":\\"<id>\\"}" --json`);
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
1. Write your decision to: .omc/state/team/${teamName}/workers/${workerName}/shutdown-ack.json
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
async function composeInitialInbox(teamName, workerName, content, cwd) {
  const inboxPath = join10(cwd, `.omc/state/team/${teamName}/workers/${workerName}/inbox.md`);
  await mkdir3(dirname7(inboxPath), { recursive: true });
  await writeFile3(inboxPath, content, "utf-8");
}
async function ensureWorkerStateDir(teamName, workerName, cwd) {
  const workerDir = join10(cwd, `.omc/state/team/${teamName}/workers/${workerName}`);
  await mkdir3(workerDir, { recursive: true });
  const mailboxDir = join10(cwd, `.omc/state/team/${teamName}/mailbox`);
  await mkdir3(mailboxDir, { recursive: true });
  const tasksDir = join10(cwd, `.omc/state/team/${teamName}/tasks`);
  await mkdir3(tasksDir, { recursive: true });
}
async function writeWorkerOverlay(params) {
  const { teamName, workerName, cwd } = params;
  const overlay = generateWorkerOverlay(params);
  const overlayPath = join10(cwd, `.omc/state/team/${teamName}/workers/${workerName}/AGENTS.md`);
  await mkdir3(dirname7(overlayPath), { recursive: true });
  await writeFile3(overlayPath, overlay, "utf-8");
  return overlayPath;
}
var init_worker_bootstrap = __esm({
  "src/team/worker-bootstrap.ts"() {
    "use strict";
    init_prompt_helpers();
    init_omc_cli_rendering();
    init_model_contract();
  }
});

// src/team/git-worktree.ts
import { existsSync as existsSync8, readFileSync as readFileSync4 } from "node:fs";
import { join as join11 } from "node:path";
import { execFileSync as execFileSync2 } from "node:child_process";
function getWorktreePath(repoRoot, teamName, workerName) {
  return join11(repoRoot, ".omc", "worktrees", sanitizeName(teamName), sanitizeName(workerName));
}
function getBranchName(teamName, workerName) {
  return `omc-team/${sanitizeName(teamName)}/${sanitizeName(workerName)}`;
}
function getMetadataPath(repoRoot, teamName) {
  return join11(repoRoot, ".omc", "state", "team-bridge", sanitizeName(teamName), "worktrees.json");
}
function readMetadata(repoRoot, teamName) {
  const metaPath = getMetadataPath(repoRoot, teamName);
  if (!existsSync8(metaPath)) return [];
  try {
    return JSON.parse(readFileSync4(metaPath, "utf-8"));
  } catch {
    return [];
  }
}
function writeMetadata(repoRoot, teamName, entries) {
  const metaPath = getMetadataPath(repoRoot, teamName);
  validateResolvedPath(metaPath, repoRoot);
  const dir = join11(repoRoot, ".omc", "state", "team-bridge", sanitizeName(teamName));
  ensureDirWithMode(dir);
  atomicWriteJson(metaPath, entries);
}
function removeWorkerWorktree(teamName, workerName, repoRoot) {
  const wtPath = getWorktreePath(repoRoot, teamName, workerName);
  const branch = getBranchName(teamName, workerName);
  try {
    execFileSync2("git", ["worktree", "remove", "--force", wtPath], { cwd: repoRoot, stdio: "pipe" });
  } catch {
  }
  try {
    execFileSync2("git", ["worktree", "prune"], { cwd: repoRoot, stdio: "pipe" });
  } catch {
  }
  try {
    execFileSync2("git", ["branch", "-D", branch], { cwd: repoRoot, stdio: "pipe" });
  } catch {
  }
  const existing = readMetadata(repoRoot, teamName);
  const updated = existing.filter((e) => e.workerName !== workerName);
  writeMetadata(repoRoot, teamName, updated);
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
var init_git_worktree = __esm({
  "src/team/git-worktree.ts"() {
    "use strict";
    init_fs_utils();
    init_tmux_session();
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

// src/team/monitor.ts
import { existsSync as existsSync11 } from "fs";
import { readFile as readFile5, mkdir as mkdir5 } from "fs/promises";
import { dirname as dirname8 } from "path";
async function readJsonSafe3(filePath) {
  try {
    if (!existsSync11(filePath)) return null;
    const raw = await readFile5(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
async function writeAtomic2(filePath, data) {
  const { writeFile: writeFile6 } = await import("fs/promises");
  await mkdir5(dirname8(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await writeFile6(tmpPath, data, "utf-8");
  const { rename: rename2 } = await import("fs/promises");
  await rename2(tmpPath, filePath);
}
async function readTeamConfig(teamName, cwd) {
  const config = await readJsonSafe3(absPath(cwd, TeamPaths.config(teamName)));
  return config ? canonicalizeTeamConfigWorkers(config) : null;
}
async function readWorkerStatus(teamName, workerName, cwd) {
  const data = await readJsonSafe3(absPath(cwd, TeamPaths.workerStatus(teamName, workerName)));
  return data ?? { state: "unknown", updated_at: "" };
}
async function readWorkerHeartbeat(teamName, workerName, cwd) {
  return readJsonSafe3(absPath(cwd, TeamPaths.heartbeat(teamName, workerName)));
}
async function readMonitorSnapshot(teamName, cwd) {
  const p = absPath(cwd, TeamPaths.monitorSnapshot(teamName));
  if (!existsSync11(p)) return null;
  try {
    const raw = await readFile5(p, "utf-8");
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
  await writeAtomic2(absPath(cwd, TeamPaths.monitorSnapshot(teamName)), JSON.stringify(snapshot, null, 2));
}
async function writeShutdownRequest(teamName, workerName, fromWorker, cwd) {
  const data = {
    from: fromWorker,
    requested_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  await writeAtomic2(absPath(cwd, TeamPaths.shutdownRequest(teamName, workerName)), JSON.stringify(data, null, 2));
}
async function readShutdownAck(teamName, workerName, cwd, requestedAfter) {
  const ack = await readJsonSafe3(
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
  if (!existsSync11(tasksDir)) return [];
  const { readdir: readdir3 } = await import("fs/promises");
  const entries = await readdir3(tasksDir);
  const tasks = [];
  for (const entry of entries) {
    const match = /^(?:task-)?(\d+)\.json$/.exec(entry);
    if (!match) continue;
    const task = await readJsonSafe3(absPath(cwd, `${TeamPaths.tasks(teamName)}/${entry}`));
    if (task) tasks.push(task);
  }
  return tasks.sort((a, b) => Number(a.id) - Number(b.id));
}
async function writeWorkerInbox(teamName, workerName, content, cwd) {
  await writeAtomic2(absPath(cwd, TeamPaths.inbox(teamName, workerName)), content);
}
async function saveTeamConfig(config, cwd) {
  await writeAtomic2(absPath(cwd, TeamPaths.config(config.name)), JSON.stringify(config, null, 2));
  const manifestPath = absPath(cwd, TeamPaths.manifest(config.name));
  const existingManifest = await readJsonSafe3(manifestPath);
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
    await writeAtomic2(manifestPath, JSON.stringify(nextManifest, null, 2));
  }
}
async function cleanupTeamState(teamName, cwd) {
  const root = absPath(cwd, TeamPaths.root(teamName));
  const { rm: rm5 } = await import("fs/promises");
  try {
    await rm5(root, { recursive: true, force: true });
  } catch {
  }
}
var init_monitor = __esm({
  "src/team/monitor.ts"() {
    "use strict";
    init_state_paths();
    init_governance();
    init_worker_canonicalization();
  }
});

// src/team/events.ts
import { randomUUID as randomUUID4 } from "crypto";
import { dirname as dirname9 } from "path";
import { mkdir as mkdir6, readFile as readFile6, appendFile as appendFile3 } from "fs/promises";
import { existsSync as existsSync12 } from "fs";
async function appendTeamEvent(teamName, event, cwd) {
  const full = {
    event_id: randomUUID4(),
    team: teamName,
    created_at: (/* @__PURE__ */ new Date()).toISOString(),
    ...event
  };
  const p = absPath(cwd, TeamPaths.events(teamName));
  await mkdir6(dirname9(p), { recursive: true });
  await appendFile3(p, `${JSON.stringify(full)}
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
var init_events = __esm({
  "src/team/events.ts"() {
    "use strict";
    init_state_paths();
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
var init_phase_controller = __esm({
  "src/team/phase-controller.ts"() {
    "use strict";
  }
});

// src/team/runtime-v2.ts
var runtime_v2_exports = {};
__export(runtime_v2_exports, {
  CircuitBreakerV2: () => CircuitBreakerV2,
  findActiveTeamsV2: () => findActiveTeamsV2,
  isRuntimeV2Enabled: () => isRuntimeV2Enabled,
  monitorTeamV2: () => monitorTeamV2,
  requeueDeadWorkerTasks: () => requeueDeadWorkerTasks,
  resumeTeamV2: () => resumeTeamV2,
  shutdownTeamV2: () => shutdownTeamV2,
  startTeamV2: () => startTeamV2,
  writeWatchdogFailedMarker: () => writeWatchdogFailedMarker
});
import { execFile as execFile2 } from "child_process";
import { join as join14, resolve as resolve3 } from "path";
import { existsSync as existsSync13 } from "fs";
import { mkdir as mkdir7, readdir as readdir2, readFile as readFile7, writeFile as writeFile5 } from "fs/promises";
import { performance } from "perf_hooks";
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
async function captureWorkerPane(paneId) {
  if (!paneId) return "";
  return await new Promise((resolve4) => {
    execFile2("tmux", ["capture-pane", "-t", paneId, "-p", "-S", "-80"], (err, stdout) => {
      if (err) resolve4("");
      else resolve4(stdout ?? "");
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
function buildV2TaskInstruction(teamName, workerName, task, taskId) {
  const claimTaskCommand = formatOmcCliInvocation(
    `team api claim-task --input '${JSON.stringify({ team_name: teamName, task_id: taskId, worker: workerName })}' --json`,
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
    `Worker: ${workerName}`,
    `Subject: ${task.subject}`,
    ``,
    task.description,
    ``,
    `REMINDER: You MUST run transition-task-status before exiting. Do NOT write done.json or edit task files directly.`
  ].join("\n");
}
async function notifyStartupInbox(sessionName2, paneId, message) {
  const notified = await notifyPaneWithRetry(sessionName2, paneId, message);
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
    const raw = await readFile7(absPath(cwd, TeamPaths.taskFile(teamName, taskId)), "utf-8");
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
      await new Promise((resolve4) => setTimeout(resolve4, delayMs));
    }
  }
  return false;
}
async function spawnV2Worker(opts) {
  const { execFile: execFile3 } = await import("child_process");
  const { promisify: promisify2 } = await import("util");
  const execFileAsync = promisify2(execFile3);
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
    const settled = await waitForWorkerStartupEvidence(
      opts.teamName,
      opts.workerName,
      opts.taskId,
      opts.cwd
    );
    if (!settled) {
      const renotified = await notifyStartupInbox(opts.sessionName, paneId, inboxTriggerMessage);
      if (!renotified.ok) {
        return {
          paneId,
          startupAssigned: false,
          startupFailureReason: `${renotified.reason}:startup_evidence_missing`
        };
      }
      const settledAfterRetry = await waitForWorkerStartupEvidence(
        opts.teamName,
        opts.workerName,
        opts.taskId,
        opts.cwd
      );
      if (!settledAfterRetry) {
        return {
          paneId,
          startupAssigned: false,
          startupFailureReason: "claude_startup_evidence_missing"
        };
      }
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
  const leaderCwd = resolve3(config.cwd);
  validateTeamName(sanitized);
  const agentTypes = config.agentTypes;
  const resolvedBinaryPaths = {};
  for (const agentType of [...new Set(agentTypes)]) {
    resolvedBinaryPaths[agentType] = resolveValidatedBinaryPath(agentType);
  }
  await mkdir7(absPath(leaderCwd, TeamPaths.tasks(sanitized)), { recursive: true });
  await mkdir7(absPath(leaderCwd, TeamPaths.workers(sanitized)), { recursive: true });
  await mkdir7(join14(leaderCwd, ".omc", "state", "team", sanitized, "mailbox"), { recursive: true });
  for (let i = 0; i < config.tasks.length; i++) {
    const taskId = String(i + 1);
    const taskFilePath = absPath(leaderCwd, TeamPaths.taskFile(sanitized, taskId));
    await mkdir7(join14(taskFilePath, ".."), { recursive: true });
    await writeFile5(taskFilePath, JSON.stringify({
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
  await writeFile5(absPath(leaderCwd, TeamPaths.manifest(sanitized)), JSON.stringify(teamManifest, null, 2), "utf-8");
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
      await appendTeamEvent(sanitized, {
        type: "team_leader_nudge",
        worker: "leader-fixed",
        reason: `startup_manual_intervention_required:${wName}:${workerLaunch.startupFailureReason}`
      }, leaderCwd);
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
    cwd: leaderCwd,
    ownsWindow
  };
}
async function writeWatchdogFailedMarker(teamName, cwd, reason) {
  const { writeFile: writeFile6 } = await import("fs/promises");
  const marker = {
    failedAt: Date.now(),
    reason,
    writtenBy: "runtime-v2"
  };
  const root = absPath(cwd, TeamPaths.root(sanitizeTeamName(teamName)));
  const markerPath = join14(root, "watchdog-failed.json");
  await mkdir7(root, { recursive: true });
  await writeFile6(markerPath, JSON.stringify(marker, null, 2), "utf-8");
}
async function requeueDeadWorkerTasks(teamName, deadWorkerNames, cwd) {
  const sanitized = sanitizeTeamName(teamName);
  const tasks = await listTasksFromFiles(sanitized, cwd);
  const requeued = [];
  const deadSet = new Set(deadWorkerNames);
  for (const task of tasks) {
    if (task.status !== "in_progress") continue;
    if (!task.owner || !deadSet.has(task.owner)) continue;
    const sidecarPath = absPath(cwd, `${TeamPaths.tasks(sanitized)}/${task.id}.failure.json`);
    const sidecar = {
      taskId: task.id,
      lastError: `worker_dead:${task.owner}`,
      retryCount: 0,
      lastFailedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    const { writeFile: writeFile6 } = await import("fs/promises");
    await mkdir7(absPath(cwd, TeamPaths.tasks(sanitized)), { recursive: true });
    await writeFile6(sidecarPath, JSON.stringify(sidecar, null, 2), "utf-8");
    const taskPath2 = absPath(cwd, TeamPaths.taskFile(sanitized, task.id));
    try {
      const raw = await import("fs/promises").then((fs2) => fs2.readFile(taskPath2, "utf-8"));
      const taskData = JSON.parse(raw);
      taskData.status = "pending";
      taskData.owner = void 0;
      taskData.claim = void 0;
      await writeFile6(taskPath2, JSON.stringify(taskData, null, 2), "utf-8");
      requeued.push(task.id);
    } catch {
    }
    await appendTeamEvent(sanitized, {
      type: "team_leader_nudge",
      worker: "leader-fixed",
      task_id: task.id,
      reason: `requeue_dead_worker:${task.owner}`
    }, cwd).catch(() => {
    });
  }
  return requeued;
}
async function monitorTeamV2(teamName, cwd) {
  const monitorStartMs = performance.now();
  const sanitized = sanitizeTeamName(teamName);
  const config = await readTeamConfig(sanitized, cwd);
  if (!config) return null;
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
      const alive = await isWorkerPaneAlive(worker.pane_id);
      const [status, heartbeat, paneCapture] = await Promise.all([
        readWorkerStatus(sanitized, worker.name, cwd),
        readWorkerHeartbeat(sanitized, worker.name, cwd),
        alive ? captureWorkerPane(worker.pane_id) : Promise.resolve("")
      ]);
      return { worker, alive, status, heartbeat, paneCapture };
    })
  );
  const workerScanMs = performance.now() - workerScanStartMs;
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
  const allTasksTerminal = taskCounts.pending === 0 && taskCounts.blocked === 0 && taskCounts.in_progress === 0;
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
  const totalMs = performance.now() - monitorStartMs;
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
    }, cwd).catch(() => {
    });
    if (!gate.allowed) {
      const hasActiveWork = gate.pending > 0 || gate.blocked > 0 || gate.in_progress > 0;
      if (!governance.cleanup_requires_all_workers_inactive) {
        await appendTeamEvent(sanitized, {
          type: "team_leader_nudge",
          worker: "leader-fixed",
          reason: `cleanup_override_bypassed:pending=${gate.pending},blocked=${gate.blocked},in_progress=${gate.in_progress},failed=${gate.failed}`
        }, cwd).catch(() => {
        });
      } else if (ralph && !hasActiveWork) {
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
    }, cwd).catch(() => {
    });
  }
  try {
    cleanupTeamWorktrees(sanitized, cwd);
  } catch (err) {
    process.stderr.write(`[team/runtime-v2] worktree cleanup: ${err}
`);
  }
  await cleanupTeamState(sanitized, cwd);
}
async function resumeTeamV2(teamName, cwd) {
  const sanitized = sanitizeTeamName(teamName);
  const config = await readTeamConfig(sanitized, cwd);
  if (!config) return null;
  try {
    const { execFile: execFile3 } = await import("child_process");
    const { promisify: promisify2 } = await import("util");
    const execFileAsync = promisify2(execFile3);
    const sessionName2 = config.tmux_session || `omc-team-${sanitized}`;
    await execFileAsync("tmux", ["has-session", "-t", sessionName2.split(":")[0]]);
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
  const root = join14(cwd, ".omc", "state", "team");
  if (!existsSync13(root)) return [];
  const entries = await readdir2(root, { withFileTypes: true });
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
var MONITOR_SIGNAL_STALE_MS, CIRCUIT_BREAKER_THRESHOLD, CircuitBreakerV2;
var init_runtime_v2 = __esm({
  "src/team/runtime-v2.ts"() {
    "use strict";
    init_state_paths();
    init_allocation_policy();
    init_monitor();
    init_events();
    init_governance();
    init_phase_controller();
    init_team_name();
    init_model_contract();
    init_tmux_session();
    init_worker_bootstrap();
    init_mcp_comm();
    init_git_worktree();
    init_omc_cli_rendering();
    MONITOR_SIGNAL_STALE_MS = 3e4;
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
import { spawn } from "child_process";
import { existsSync as existsSync15, mkdirSync as mkdirSync2, readFileSync as readFileSync7, writeFileSync as writeFileSync2 } from "fs";
import { readFile as readFile8, rm as rm4 } from "fs/promises";
import { homedir as homedir2 } from "os";
import { dirname as dirname11, join as join16 } from "path";
import { fileURLToPath as fileURLToPath3 } from "url";

// src/team/api-interop.ts
init_contracts();
init_team_ops();
init_mcp_comm();
init_tmux_session();
init_dispatch_queue();
init_worker_bootstrap();
import { existsSync as existsSync14, readFileSync as readFileSync6 } from "node:fs";
import { dirname as dirname10, join as join15, resolve as resolvePath } from "node:path";

// src/team/runtime.ts
init_model_contract();
init_team_name();
init_tmux_session();
init_worker_bootstrap();
init_git_worktree();
import { mkdir as mkdir4, writeFile as writeFile4, readFile as readFile4, rm as rm3, rename } from "fs/promises";
import { join as join13 } from "path";
import { existsSync as existsSync10 } from "fs";

// src/team/task-file-ops.ts
init_paths();
init_tmux_session();
init_fs_utils();
init_state_paths();
import { readFileSync as readFileSync5, readdirSync as readdirSync3, existsSync as existsSync9, openSync as openSync2, closeSync as closeSync2, unlinkSync as unlinkSync2, writeSync as writeSync2, statSync as statSync2, constants as fsConstants } from "fs";
import { join as join12 } from "path";

// src/team/runtime.ts
function stateRoot(cwd, teamName) {
  validateTeamName(teamName);
  return join13(cwd, `.omc/state/team/${teamName}`);
}
async function writeJson(filePath, data) {
  await mkdir4(join13(filePath, ".."), { recursive: true });
  await writeFile4(filePath, JSON.stringify(data, null, 2), "utf-8");
}
async function readJsonSafe2(filePath) {
  const isDoneSignalPath = filePath.endsWith("done.json");
  const maxAttempts = isDoneSignalPath ? 4 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const content = await readFile4(filePath, "utf-8");
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
    await new Promise((resolve4) => setTimeout(resolve4, 25));
  }
  return null;
}
function taskPath(root, taskId) {
  return join13(root, "tasks", `${taskId}.json`);
}
async function readTask(root, taskId) {
  return readJsonSafe2(taskPath(root, taskId));
}
async function monitorTeam(teamName, cwd, workerPaneIds) {
  validateTeamName(teamName);
  const monitorStartedAt = Date.now();
  const root = stateRoot(cwd, teamName);
  const taskScanStartedAt = Date.now();
  const taskCounts = { pending: 0, inProgress: 0, completed: 0, failed: 0 };
  try {
    const { readdir: readdir3 } = await import("fs/promises");
    const taskFiles = await readdir3(join13(root, "tasks"));
    for (const f of taskFiles.filter((f2) => f2.endsWith(".json"))) {
      const task = await readJsonSafe2(join13(root, "tasks", f));
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
    const heartbeatPath = join13(root, "workers", wName, "heartbeat.json");
    const heartbeat = await readJsonSafe2(heartbeatPath);
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
  await writeJson(join13(root, "shutdown.json"), {
    requestedAt: (/* @__PURE__ */ new Date()).toISOString(),
    teamName
  });
  const configData = await readJsonSafe2(join13(root, "config.json"));
  const CLI_AGENT_TYPES = /* @__PURE__ */ new Set(["claude", "codex", "gemini"]);
  const agentTypes = configData?.agentTypes ?? [];
  const isCliWorkerTeam = agentTypes.length > 0 && agentTypes.every((t) => CLI_AGENT_TYPES.has(t));
  if (!isCliWorkerTeam) {
    const deadline = Date.now() + timeoutMs;
    const workerCount = configData?.workerCount ?? 0;
    const expectedAcks = Array.from({ length: workerCount }, (_, i) => `worker-${i + 1}`);
    while (Date.now() < deadline && expectedAcks.length > 0) {
      for (const wName of [...expectedAcks]) {
        const ackPath = join13(root, "workers", wName, "shutdown-ack.json");
        if (existsSync10(ackPath)) {
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
  const configData = await readJsonSafe2(join13(root, "config.json"));
  if (!configData) return null;
  const { execFile: execFile3 } = await import("child_process");
  const { promisify: promisify2 } = await import("util");
  const execFileAsync = promisify2(execFile3);
  const sName = configData.tmuxSession || `omc-team-${teamName}`;
  try {
    await execFileAsync("tmux", ["has-session", "-t", sName.split(":")[0]]);
  } catch {
    return null;
  }
  const paneTarget = sName.includes(":") ? sName : sName.split(":")[0];
  const panesResult = await execFileAsync("tmux", [
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
var TEAM_UPDATE_TASK_MUTABLE_FIELDS = /* @__PURE__ */ new Set(["subject", "description", "blocked_by", "requires_code_change"]);
var TEAM_UPDATE_TASK_REQUEST_FIELDS = /* @__PURE__ */ new Set(["team_name", "task_id", "workingDirectory", ...TEAM_UPDATE_TASK_MUTABLE_FIELDS]);
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
  "orphan-cleanup"
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
function teamStateExists(teamName, candidateCwd) {
  if (!TEAM_NAME_SAFE_PATTERN.test(teamName)) return false;
  const teamRoot = join15(candidateCwd, ".omc", "state", "team", teamName);
  return existsSync14(join15(teamRoot, "config.json")) || existsSync14(join15(teamRoot, "tasks")) || existsSync14(teamRoot);
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
async function executeTeamCleanupViaRuntime(teamName, cwd) {
  const config = await teamReadConfig(teamName, cwd);
  if (!config) {
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
  await teamCleanup(teamName, cwd);
}
function readTeamStateRootFromFile(path) {
  if (!existsSync14(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync6(path, "utf8"));
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
      return dirname10(dirname10(dirname10(dirname10(absolute))));
    }
  }
  for (const marker of ["/.omc/state", "/.omx/state"]) {
    const idx = normalized.lastIndexOf(marker);
    if (idx >= 0) {
      const workspaceRoot = absolute.slice(0, idx);
      if (workspaceRoot && workspaceRoot !== "/") return workspaceRoot;
      return dirname10(dirname10(absolute));
    }
  }
  return dirname10(dirname10(absolute));
}
function resolveTeamWorkingDirectoryFromMetadata(teamName, candidateCwd, workerContext) {
  const teamRoot = join15(candidateCwd, ".omc", "state", "team", teamName);
  if (!existsSync14(teamRoot)) return null;
  if (workerContext?.teamName === teamName) {
    const workerRoot = readTeamStateRootFromFile(join15(teamRoot, "workers", workerContext.workerName, "identity.json"));
    if (workerRoot) return stateRootToWorkingDirectory(workerRoot);
  }
  const fromConfig = readTeamStateRootFromFile(join15(teamRoot, "config.json"));
  if (fromConfig) return stateRootToWorkingDirectory(fromConfig);
  const fromManifest = readTeamStateRootFromFile(join15(teamRoot, "manifest.v2.json"));
  if (fromManifest) return stateRootToWorkingDirectory(fromManifest);
  return null;
}
function resolveTeamWorkingDirectory(teamName, preferredCwd) {
  const normalizedTeamName = String(teamName || "").trim();
  if (!normalizedTeamName) return preferredCwd;
  const envTeamStateRoot = readTeamStateRootFromEnv();
  if (typeof envTeamStateRoot === "string" && envTeamStateRoot.trim() !== "") {
    return stateRootToWorkingDirectory(envTeamStateRoot.trim());
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
      const parent = dirname10(cursor);
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
var QUEUED_FOR_HOOK_DISPATCH_REASON = "queued_for_hook_dispatch";
var LEADER_PANE_MISSING_MAILBOX_PERSISTED_REASON = "leader_pane_missing_mailbox_persisted";
var WORKTREE_TRIGGER_STATE_ROOT = "$OMC_TEAM_STATE_ROOT";
function resolveInstructionStateRoot(worktreePath) {
  return worktreePath ? WORKTREE_TRIGGER_STATE_ROOT : void 0;
}
function queuedForHookDispatch() {
  return {
    ok: true,
    transport: "hook",
    reason: QUEUED_FOR_HOOK_DISPATCH_REASON
  };
}
async function notifyMailboxTarget(teamName, toWorker, triggerMessage, cwd) {
  const config = await teamReadConfig(teamName, cwd);
  if (!config) return queuedForHookDispatch();
  const sessionName2 = typeof config.tmux_session === "string" ? config.tmux_session.trim() : "";
  if (!sessionName2) return queuedForHookDispatch();
  if (toWorker === "leader-fixed") {
    const leaderPaneId = typeof config.leader_pane_id === "string" ? config.leader_pane_id.trim() : "";
    if (!leaderPaneId) {
      return {
        ok: true,
        transport: "mailbox",
        reason: LEADER_PANE_MISSING_MAILBOX_PERSISTED_REASON
      };
    }
    const injected = await injectToLeaderPane(sessionName2, leaderPaneId, triggerMessage);
    return injected ? { ok: true, transport: "tmux_send_keys", reason: "leader_pane_notified" } : queuedForHookDispatch();
  }
  const workerPaneId = config.workers.find((worker) => worker.name === toWorker)?.pane_id?.trim();
  if (!workerPaneId) return queuedForHookDispatch();
  const notified = await sendToWorker(sessionName2, workerPaneId, triggerMessage);
  return notified ? { ok: true, transport: "tmux_send_keys", reason: "worker_pane_notified" } : queuedForHookDispatch();
}
function findWorkerDispatchTarget(teamName, toWorker, cwd) {
  return teamReadConfig(teamName, cwd).then((config) => {
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
  const requestId = await findMailboxDispatchRequestId(teamName, workerName, messageId, cwd);
  if (!requestId) return;
  await markDispatchRequestNotified(
    teamName,
    requestId,
    { message_id: messageId, last_reason: "mailbox_mark_notified" },
    cwd
  ).catch(() => {
  });
}
async function syncMailboxDispatchDelivered(teamName, workerName, messageId, cwd) {
  const requestId = await findMailboxDispatchRequestId(teamName, workerName, messageId, cwd);
  if (!requestId) return;
  await markDispatchRequestNotified(
    teamName,
    requestId,
    { message_id: messageId, last_reason: "mailbox_mark_delivered" },
    cwd
  ).catch(() => {
  });
  await markDispatchRequestDelivered(
    teamName,
    requestId,
    { message_id: messageId, last_reason: "mailbox_mark_delivered" },
    cwd
  ).catch(() => {
  });
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
async function executeTeamApiOperation(operation, args, fallbackCwd) {
  try {
    validateCommonFields(args);
    const teamNameForCwd = String(args.team_name || "").trim();
    const cwd = teamNameForCwd ? resolveTeamWorkingDirectory(teamNameForCwd, fallbackCwd) : fallbackCwd;
    switch (operation) {
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
        await queueDirectMailboxMessage({
          teamName,
          fromWorker,
          toWorker,
          toWorkerIndex: target.workerIndex,
          toPaneId: target.paneId,
          body,
          triggerMessage: generateMailboxTriggerMessage(teamName, toWorker, 1, target.instructionStateRoot),
          cwd,
          notify: ({ workerName }, triggerMessage) => notifyMailboxTarget(teamName, workerName, triggerMessage, cwd),
          deps: {
            sendDirectMessage: async (resolvedTeamName, resolvedFromWorker, resolvedToWorker, resolvedBody, resolvedCwd) => {
              message = await teamSendMessage(resolvedTeamName, resolvedFromWorker, resolvedToWorker, resolvedBody, resolvedCwd);
              return message;
            },
            broadcastMessage: teamBroadcast,
            markMessageNotified: async (resolvedTeamName, workerName, messageId, resolvedCwd) => {
              await teamMarkMessageNotified(resolvedTeamName, workerName, messageId, resolvedCwd);
            }
          }
        });
        return { ok: true, operation, data: { message } };
      }
      case "broadcast": {
        const teamName = String(args.team_name || "").trim();
        const fromWorker = String(args.from_worker || "").trim();
        const body = String(args.body || "").trim();
        if (!teamName || !fromWorker || !body) {
          return { ok: false, operation, error: { code: "invalid_input", message: "team_name, from_worker, body are required" } };
        }
        let messages = [];
        const config = await teamReadConfig(teamName, cwd);
        const recipients = (config?.workers ?? []).filter((worker) => worker.name !== fromWorker).map((worker) => ({
          workerName: worker.name,
          workerIndex: worker.index,
          paneId: worker.pane_id,
          instructionStateRoot: resolveInstructionStateRoot(worker.worktree_path)
        }));
        await queueBroadcastMailboxMessage({
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
          notify: ({ workerName }, triggerMessage) => notifyMailboxTarget(teamName, workerName, triggerMessage, cwd),
          deps: {
            sendDirectMessage: teamSendMessage,
            broadcastMessage: async (resolvedTeamName, resolvedFromWorker, resolvedBody, resolvedCwd) => {
              messages = await teamBroadcast(resolvedTeamName, resolvedFromWorker, resolvedBody, resolvedCwd);
              return messages;
            },
            markMessageNotified: async (resolvedTeamName, workerName, messageId, resolvedCwd) => {
              await teamMarkMessageNotified(resolvedTeamName, workerName, messageId, resolvedCwd);
            }
          }
        });
        return { ok: true, operation, data: { count: messages.length, messages } };
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
        const task = await teamCreateTask(teamName, {
          subject,
          description,
          status: "pending",
          owner: owner || void 0,
          blocked_by: blockedBy,
          requires_code_change: requiresCodeChange
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
        if (!teamName || !taskId || !from || !to || !claimToken) {
          return { ok: false, operation, error: { code: "invalid_input", message: "team_name, task_id, from, to, claim_token are required" } };
        }
        const allowed = new Set(TEAM_TASK_STATUSES);
        if (!allowed.has(from) || !allowed.has(to)) {
          return { ok: false, operation, error: { code: "invalid_input", message: "from and to must be valid task statuses" } };
        }
        const result = await teamTransitionTaskStatus(teamName, taskId, from, to, claimToken, cwd);
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
          worktree_path: args.worktree_path,
          worktree_branch: args.worktree_branch,
          worktree_detached: args.worktree_detached,
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
var JOB_ID_PATTERN = /^omc-[a-z0-9]{1,12}$/;
var VALID_CLI_AGENT_TYPES = /* @__PURE__ */ new Set(["claude", "codex", "gemini"]);
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
  "orphan-cleanup"
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
  return env.OMC_JOBS_DIR || join16(homedir2(), ".omc", "team-jobs");
}
function resolveRuntimeCliPath(env = process.env) {
  if (env.OMC_RUNTIME_CLI_PATH) {
    return env.OMC_RUNTIME_CLI_PATH;
  }
  const moduleDir = dirname11(fileURLToPath3(import.meta.url));
  return join16(moduleDir, "../../bridge/runtime-cli.cjs");
}
function ensureJobsDir(jobsDir) {
  if (!existsSync15(jobsDir)) {
    mkdirSync2(jobsDir, { recursive: true });
  }
}
function jobPath(jobsDir, jobId) {
  return join16(jobsDir, `${jobId}.json`);
}
function resultArtifactPath(jobsDir, jobId) {
  return join16(jobsDir, `${jobId}-result.json`);
}
function panesArtifactPath(jobsDir, jobId) {
  return join16(jobsDir, `${jobId}-panes.json`);
}
function teamStateRoot2(cwd, teamName) {
  return join16(cwd, ".omc", "state", "team", teamName);
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
function readJobFromDisk(jobId, jobsDir) {
  try {
    const content = readFileSync7(jobPath(jobsDir, jobId), "utf-8");
    return parseJsonSafe(content);
  } catch {
    return null;
  }
}
function writeJobToDisk(jobId, job, jobsDir) {
  ensureJobsDir(jobsDir);
  writeFileSync2(jobPath(jobsDir, jobId), JSON.stringify(job), "utf-8");
}
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
  return `omc-${now.toString(36)}`;
}
function convergeWithResultArtifact(jobId, job, jobsDir) {
  try {
    const artifactRaw = readFileSync7(resultArtifactPath(jobsDir, jobId), "utf-8");
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
  if (job.status === "running" && job.pid != null && !isPidAlive(job.pid)) {
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
  const runtimeCliPath = resolveRuntimeCliPath();
  const jobId = generateJobId();
  const job = {
    status: "running",
    startedAt: Date.now(),
    teamName: input.teamName,
    cwd: input.cwd
  };
  const child = spawn("node", [runtimeCliPath], {
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
    sentinelGatePollIntervalMs: input.sentinelGatePollIntervalMs
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
    await new Promise((resolve4) => setTimeout(resolve4, delayMs));
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
  const paneArtifact = await readFile8(panesArtifactPath(jobsDir, jobId), "utf-8").then((content) => parseJsonSafe(content)).catch(() => null);
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
  await rm4(teamStateRoot2(job.cwd, job.teamName), {
    recursive: true,
    force: true
  }).catch(() => void 0);
  try {
    cleanupTeamWorktrees(job.teamName, job.cwd);
  } catch {
  }
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
      workerPaneIds: Array.from(new Set(
        (config?.workers ?? []).map((worker) => worker.pane_id).filter((paneId) => typeof paneId === "string" && paneId.trim().length > 0)
      )),
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
      await rm4(teamStateRoot2(cwd, teamName), { recursive: true, force: true }).catch(() => void 0);
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
    ...typeof input.messageId === "string" && input.messageId.trim() !== "" && typeof input.message_id !== "string" ? { message_id: input.messageId } : {}
  };
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
  omc team start --agent <claude|codex|gemini>[,<agent>...] --task "<task>" [--count N] [--name TEAM] [--cwd DIR] [--new-window] [--json]
  omc team status <job_id|team_name> [--json] [--cwd DIR]
  omc team wait <job_id> [--timeout-ms MS] [--json]
  omc team cleanup <job_id> [--grace-ms MS] [--json]
  omc team resume <team_name> [--json] [--cwd DIR]
  omc team shutdown <team_name> [--force] [--json] [--cwd DIR]
  omc team api <operation> [--input '<json>'] [--json] [--cwd DIR]
  omc team [ralph] <N:agent-type[:role]> "task" [--json] [--cwd DIR] [--new-window]

Examples:
  omc team start --agent codex --count 2 --task "review auth flow" --new-window
  omc team status omc-abc123
  omc team status auth-review
  omc team resume auth-review
  omc team shutdown auth-review --force
  omc team api list-tasks --input '{"teamName":"auth-review"}' --json
  omc team 3:codex "refactor launch command"
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
      ...sentinelGatePollIntervalMs != null ? { sentinelGatePollIntervalMs } : {}
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
  const workerCount = toInt(match[1], "worker-count");
  if (workerCount < 1) throw new Error("worker-count must be >= 1");
  const agentType = normalizeAgentType(match[2]);
  const role = match[3] || void 0;
  index += 1;
  let json = false;
  let cwd = process.cwd();
  let newWindow = false;
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
  const task = taskParts.join(" ").trim();
  if (!task) throw new Error("Legacy start alias requires a task string");
  return {
    workerCount,
    agentType,
    role,
    task,
    teamName: autoTeamName(task),
    ralph,
    json,
    cwd,
    ...newWindow ? { newWindow: true } : {}
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
        ...legacy.newWindow ? { newWindow: true } : {}
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
