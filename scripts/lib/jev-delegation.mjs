// The named-only Jev point `delegation` for a coordinator session: should this Agent/Task call go to an agent or to
// a separate background session (scripts/jev-session.mjs)? The Agent hook asks only for a call made by the session
// itself (not by a subagent) in a session whose role is `coordinator` (OMC_SESSION_ROLE, set through the env block of
// the settings file that scripts/jev-session.mjs passes to the session). The code gives facts, Jev judges; the hook
// never denies and never changes the call: with the point active the answer `session` only adds a hint.
// Only node built-ins are imported.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SESSION_ROLES = ['coordinator', 'worker'];

export const DELEGATION_QUESTIONS = {
  delegation: {
    type: 'choice',
    instructions: 'A coordinator session is handing this task to a background agent right now. The agent lives in the process of this session: its report returns to the coordinator\'s transcript, and a restart of the session interrupts it. A separate background session has its own transcript and its own plan and survives a restart of the coordinator. Where should this task be done? The length of the brief and its formal conditions (language rules, bans, report format) do not decide; what counts is the work that has to be done.',
    criteria: {
      agent: 'Agent: a small step that ends with a short report: search, reading, diagnosis, a single fix or script, a review, a measurement, a copy, a check; usually up to a few dozen minutes, without gates of its own and without further tracks',
      session: 'Session: an independent track of multi-track work lasting hours: several steps or tracks with their own gates, measurements and state, which have to survive a restart of the coordinator and must not load its transcript',
    },
  },
};

// The role of this session from the env block of the launcher's settings file; anything else (unset, a typo) is an ordinary session.
export function sessionRoleFacts(env = process.env) {
  const role = typeof env.OMC_SESSION_ROLE === 'string' ? env.OMC_SESSION_ROLE.trim().toLowerCase() : '';
  if (!SESSION_ROLES.includes(role)) return null;
  return { role, coordinator: String(env.OMC_SESSION_COORDINATOR || '').slice(0, 64) || undefined, name: String(env.OMC_SESSION_NAME || '').slice(0, 120) || undefined };
}

// Agents the tracker (SubagentStart/Stop) lists as running in THIS session: the session-scoped file only (the legacy shared files mix sessions), entries
// started within 6 hours (an agent whose stop was never seen stays "running" for ever). undefined when the file is missing or unreadable: no number is better than a guess.
export function readRunningAgents(stateDir, sessionId, now = Date.now()) {
  try {
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) || !stateDir) return undefined;
    const file = join(stateDir, 'sessions', sessionId, 'subagent-tracking-state.json');
    if (!existsSync(file)) return undefined;
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (!data || !Array.isArray(data.agents)) return undefined;
    return data.agents.filter((a) => a && a.status === 'running' && Number.isFinite(Date.parse(a.started_at)) && now - Date.parse(a.started_at) < 6 * 3600 * 1000).length;
  } catch { return undefined; }
}

// The state sent to Jev: the facts and the task (the resolver masks and bounds it). tool_name and subagent_type as in model-routing.
// Key names: the state mask hides the value of a key that ends in `session`, hence running_agents, not agents_running_in_session.
export function delegationState({ toolName, toolInput, facts, running }) {
  return {
    tool_name: toolName, subagent_type: String(toolInput?.subagent_type || ''), task: String(toolInput?.prompt || ''), description: String(toolInput?.description || ''),
    session_role: facts.role, run_in_background: toolInput?.run_in_background === true, ...(running !== undefined ? { running_agents: running } : {}),
  };
}

// The answer: session or agent (the "delegation" choice); anything else is no decision.
export function decideDelegation(answers) {
  const answer = answers?.delegation;
  const choice = typeof answer?.choice === 'string' ? answer.choice.trim().toLowerCase() : undefined;
  const raw = answer?.confidence;
  return { choice: choice === 'agent' || choice === 'session' ? choice : undefined, confidence: typeof raw === 'number' && raw >= 0 && raw <= 1 ? raw : null };
}

// Context for the coordinator when Jev says "session": facts and a pointer, no refusal. The command works from any shell: node plus
// the absolute path of the launcher of this very plugin copy (a wrapper on PATH is not required to exist).
export function delegationHintText({ running, sessionId }) {
  const own = typeof sessionId === 'string' && sessionId ? sessionId.slice(0, 8) : '<id of this session>';
  const launcher = fileURLToPath(new URL('../jev-session.mjs', import.meta.url));
  return '[Jev, delegation] This session is a coordinator, and Jev rates this task as an independent track of work lasting hours: consider a separate background session instead of an agent (`node ' + launcher + ' --role worker --coordinator ' + own + ' --brief <file> --name "<name>"`). ' +
    (running !== undefined ? `Agents the registry of this session marks as running (entries from the last 6 hours; the OMC registry may count differently): ${running}. ` : '') + 'A restart of this session interrupts background agents. This is only a hint: the agent call is not blocked, small steps still go to agents.';
}
