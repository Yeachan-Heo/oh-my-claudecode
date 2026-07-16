import { createHash, randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { closeSync, constants as fsConstants, existsSync, fstatSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from 'fs';
import { TextDecoder } from 'util';
import { homedir } from 'os';
import { basename, dirname, join, parse, resolve, sep } from 'path';
import { getClaudeConfigDir } from './config-dir.mjs';
import { resolveCanonicalWorkflowStagePrompt } from './workflow-stage-prompts.mjs';

const SEQUENCES = Object.freeze([Object.freeze(['ralplan', 'execution']), Object.freeze(['ralplan', 'execution', 'ralph']), Object.freeze(['ralplan', 'execution', 'qa']), Object.freeze(['ralplan', 'execution', 'ralph', 'qa'])]);
const SIGNALS = { ralplan: 'PIPELINE_RALPLAN_COMPLETE', execution: 'PIPELINE_EXECUTION_COMPLETE', ralph: 'PIPELINE_RALPH_COMPLETE', qa: 'PIPELINE_QA_COMPLETE' };
const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const RESERVED_WORKFLOW_NAMES = new Set(['autopilot', 'ralplan', 'execution', 'ralph', 'qa', 'autoresearch', 'ultraqa', 'merge-readiness', 'self-improve', 'ultrawork', 'ultragoal', 'ultrapilot', 'swarm', 'pipeline', 'plan', 'team', 'cancel', 'deep-interview', 'deepsearch', 'ultrathink', 'tdd', 'code-review', 'security-review', 'analyze', 'search', 'default']);
const TRANSCRIPT_CHUNK_BYTES = 64 * 1024;
const MAX_JSONL_RECORD_BYTES = 8 * 1024 * 1024;
export const WORKFLOW_TRANSCRIPT_RECORD_TOO_LARGE = 'workflow_transcript_record_too_large';
const workflowTranscriptFailures = new Map();
export function takeWorkflowTranscriptFailure(sessionId) { if (!sessionId) return null; const failure = workflowTranscriptFailures.get(sessionId) || null; workflowTranscriptFailures.delete(sessionId); return failure; }
function clearWorkflowTranscriptFailure(sessionId) { if (sessionId) workflowTranscriptFailures.delete(sessionId); }



function workflowPlatform() { return process.env.NODE_ENV === 'test' && process.env.OMC_WORKFLOW_TEST_PLATFORM ? process.env.OMC_WORKFLOW_TEST_PLATFORM : process.platform; }
export function isWorkflowRuntimeSupported() { return workflowPlatform() === 'linux' && process.env.OMC_WORKFLOW_TEST_FLOCK_AVAILABLE !== '0' && (existsSync('/usr/bin/flock') || existsSync('/bin/flock')); }
function assertWorkflowRuntimeSupported() { if (!isWorkflowRuntimeSupported()) throw new Error('named autopilot workflow profiles require Linux with flock'); }
function isApprovedSequence(stages) { return Array.isArray(stages) && SEQUENCES.some(sequence => stages.length === sequence.length && stages.every((stage, index) => typeof stage === 'string' && stage === sequence[index])); }

function stripJsonc(value) { let result = ''; let quoted = false; let escaped = false; for (let i = 0; i < value.length; i += 1) { const char = value[i]; if (quoted) { result += char; if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; } if (char === '"') { quoted = true; result += char; continue; } if (char === '/' && value[i + 1] === '/') { while (i < value.length && value[i] !== '\n') i += 1; result += '\n'; continue; } if (char === '/' && value[i + 1] === '*') { i += 2; while (i < value.length && !(value[i] === '*' && value[i + 1] === '/')) i += 1; i += 1; continue; } result += char; } return result.replace(/,(\s*[}\]])/g, '$1'); }
function readConfig(path) { if (!existsSync(path)) return {}; try { return JSON.parse(stripJsonc(readFileSync(path, 'utf8'))); } catch { throw new Error(`invalid JSONC in ${path}`); } }
function validateDefinitions(config, source) { const workflows = config?.autopilot?.workflows; if (workflows === undefined) return {}; if (!workflows || typeof workflows !== 'object' || Array.isArray(workflows)) throw new Error(`${source} autopilot.workflows must be an object map`); for (const [name, profile] of Object.entries(workflows)) { if (!NAME.test(name)) throw new Error(`${source} autopilot.workflows.${name} name must match ^[a-z][a-z0-9-]{0,62}$`); if (RESERVED_WORKFLOW_NAMES.has(name)) throw new Error(`${source} autopilot.workflows.${name} name "${name}" is reserved`); if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error(`${source} autopilot.workflows.${name} must be an object`); const unknownKey = Object.keys(profile).find(key => key !== 'version' && key !== 'stages'); if (unknownKey) throw new Error(`${source} autopilot.workflows.${name}.${unknownKey} unknown profile key`); if (profile.version !== 1) throw new Error(`${source} autopilot.workflows.${name}.version must be the number 1`); if (!Array.isArray(profile.stages)) throw new Error(`${source} autopilot.workflows.${name}.stages must be an array`); if (!isApprovedSequence(profile.stages)) throw new Error(`${source} autopilot.workflows.${name}.stages must be one of: [ralplan, execution], [ralplan, execution, ralph], [ralplan, execution, qa], [ralplan, execution, ralph, qa]`); } return workflows; }
export function parseWorkflowInvocation(prompt) { const command = typeof prompt === 'string' && prompt.match(/^\s*\/(?:oh-my-claudecode:|omc:)?autopilot(?:\s|$)/); if (!command) return { kind: 'not-workflow-invocation' }; const invocation = prompt.slice(command[0].length); if (!/^\s*--workflow(?:\s|$|=)/.test(invocation)) return { kind: 'not-workflow-invocation' }; if (/^\s*--workflow=/.test(invocation)) return { kind: 'invalid-explicit-workflow-invocation', error: 'Use --workflow <name> followed by a task.' }; const match = invocation.match(/^\s*--workflow\s+(\S+)(?:\s+([\s\S]*?\S))?\s*$/); if (!match) return { kind: 'invalid-explicit-workflow-invocation', error: 'Use /autopilot --workflow <name> <task>.' }; if (!NAME.test(match[1])) return { kind: 'invalid-explicit-workflow-invocation', error: 'Workflow name must match ^[a-z][a-z0-9-]{0,62}$.' }; if (!match[2]) return { kind: 'invalid-explicit-workflow-invocation', error: 'Provide a task after the workflow name.' }; return { kind: 'valid', workflowName: match[1], task: match[2] }; }
function getOmcUserConfigDir() { if (process.platform === 'win32') return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'); return process.env.XDG_CONFIG_HOME || join(homedir(), '.config'); }
function resolveProjectWorkflowConfig(directory) { let current; try { current = realpathSync(resolve(directory)); } catch { current = resolve(directory); } const project = current; let root = null; try { const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: current, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000, windowsHide: true }).trim(); if (top) { try { root = realpathSync(top); } catch { root = resolve(top); } } } catch {} if (!root) { let boundary = null; while (true) { if (existsSync(join(current, '.omc-workspace'))) { boundary = current; break; } const parent = dirname(current); if (parent === current) break; current = parent; } if (!boundary) return join(project, '.claude', 'omc.jsonc'); root = boundary; current = project; } while (true) { const config = join(current, '.claude', 'omc.jsonc'); if (existsSync(config)) return config; if (current === root) return join(root, '.claude', 'omc.jsonc'); current = dirname(current); }
}
export function selectWorkflowProfile(directory, workflowName) { assertWorkflowRuntimeSupported(); const user = validateDefinitions(readConfig(join(getOmcUserConfigDir(), 'claude-omc', 'config.jsonc')), 'user'); const project = validateDefinitions(readConfig(resolveProjectWorkflowConfig(directory)), 'project'); const profile = { ...user, ...project }[workflowName]; if (!profile) throw new Error(`workflow profile "${workflowName}" was not found`); const descriptor = { descriptorVersion: 1, workflowName, profileVersion: 1, stages: [...profile.stages] }; return { ...descriptor, profileHash: createHash('sha256').update(canonicalJson(descriptor)).digest('hex') }; }
function canonicalJson(value) { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`; return JSON.stringify(value); }

function hasValidWorkflowHash(workflow) {
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) return false;
  const keys = Object.keys(workflow).sort();
  const expectedKeys = ['descriptorVersion', 'profileHash', 'profileVersion', 'stages', 'workflowName'];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) return false;
  if (workflow.descriptorVersion !== 1 || workflow.profileVersion !== 1 || typeof workflow.workflowName !== 'string' || !NAME.test(workflow.workflowName) || RESERVED_WORKFLOW_NAMES.has(workflow.workflowName) || !isApprovedSequence(workflow.stages) || typeof workflow.profileHash !== 'string' || !/^[a-f0-9]{64}$/.test(workflow.profileHash)) return false;
  const descriptor = { descriptorVersion: 1, workflowName: workflow.workflowName, profileVersion: 1, stages: workflow.stages };
  return createHash('sha256').update(canonicalJson(descriptor)).digest('hex') === workflow.profileHash;
}
export function isValidWorkflowDescriptor(workflow) { return hasValidWorkflowHash(workflow); }
export function resolveWorkflowStagePrompt(state, stageId) {
  const task = typeof state?.prompt === 'string' ? state.prompt.trim() : '';
  const workflow = state?.workflow;
  if (!task || !hasValidWorkflowHash(workflow) || !workflow.stages.includes(stageId)) return null;
  return resolveCanonicalWorkflowStagePrompt(stageId, task);
}
function transcriptRoot() { return realpathSync(resolve(getClaudeConfigDir(), 'projects')); }
function fileIdentity(stat, contentSha256) { return { device: Number(stat.dev), inode: Number(stat.ino), size: Number(stat.size), mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString(), contentSha256 }; }
function hashRange(fd, start, end) { const hash = createHash('sha256'); const chunk = Buffer.allocUnsafe(TRANSCRIPT_CHUNK_BYTES); for (let offset = start; offset < end;) { const count = readSync(fd, chunk, 0, Math.min(chunk.length, end - offset), offset); if (count <= 0) return null; hash.update(chunk.subarray(0, count)); offset += count; } return hash.digest('hex'); }
function scanJsonl(fd, start, end, sessionId, callback, hash) { const chunk = Buffer.allocUnsafe(TRANSCRIPT_CHUNK_BYTES); const record = Buffer.allocUnsafe(MAX_JSONL_RECORD_BYTES + 1); let recordBytes = 0; let byteOffset = start; let lineNumber = 0; const decodeRecord = length => { try { return new TextDecoder('utf-8', { fatal: true }).decode(record.subarray(0, length)); } catch { return null; } }; const emitRecord = crlf => { const length = recordBytes - (crlf && recordBytes > 0 && record[recordBytes - 1] === 0x0d ? 1 : 0); const line = decodeRecord(length); if (line === null) return false; return !callback || callback(line, byteOffset, lineNumber, createHash('sha256').update(record.subarray(0, length)).digest('hex')) !== false; }; for (let offset = start; offset < end;) { const maxRead = recordBytes >= MAX_JSONL_RECORD_BYTES ? 1 : MAX_JSONL_RECORD_BYTES + 1 - recordBytes; const count = readSync(fd, chunk, 0, Math.min(chunk.length, end - offset, maxRead), offset); if (count <= 0) return false; hash?.update(chunk.subarray(0, count)); for (let index = 0; index < count; index += 1) { const byte = chunk[index]; if (byte === 0x0a) { if (!emitRecord(true)) return false; byteOffset += recordBytes + 1; recordBytes = 0; lineNumber += 1; } else if ((recordBytes === MAX_JSONL_RECORD_BYTES && byte !== 0x0d) || recordBytes > MAX_JSONL_RECORD_BYTES) { workflowTranscriptFailures.set(sessionId, WORKFLOW_TRANSCRIPT_RECORD_TOO_LARGE); return false; } else { record[recordBytes++] = byte; } } offset += count; } if (recordBytes > MAX_JSONL_RECORD_BYTES) { workflowTranscriptFailures.set(sessionId, WORKFLOW_TRANSCRIPT_RECORD_TOO_LARGE); return false; } return recordBytes === 0 || emitRecord(false); }
function readStableTranscript(path, sessionId) {
  if (!isWorkflowRuntimeSupported() || !existsSync('/proc/self/fd') || typeof fsConstants.O_NOFOLLOW !== 'number' || typeof fsConstants.O_DIRECTORY !== 'number') return null;
  const absolute = resolve(path); const pathRoot = parse(absolute).root; const components = absolute.slice(pathRoot.length).split(sep).filter(Boolean); if (components.length === 0) return null;
  let fd;
  try {
    fd = openSync(pathRoot, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY); const pathIdentity = [];
    for (let index = 0; index < components.length; index += 1) { const isFinal = index === components.length - 1; const nextFd = openSync(`/proc/self/fd/${fd}/${components[index]}`, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (isFinal ? 0 : fsConstants.O_DIRECTORY)); const nextStat = fstatSync(nextFd); pathIdentity.push({ device: Number(nextStat.dev), inode: Number(nextStat.ino) }); if ((isFinal && !nextStat.isFile()) || (!isFinal && !nextStat.isDirectory())) { closeSync(nextFd); return null; } closeSync(fd); fd = nextFd; }
    const before = fstatSync(fd, { bigint: true }); const size = Number(before.size); const canonicalPath = realpathSync(`/proc/self/fd/${fd}`); const root = transcriptRoot(); if (!canonicalPath.startsWith(root + sep) || basename(canonicalPath) !== `${sessionId}.jsonl`) return null;
    const hash = createHash('sha256'); if (!scanJsonl(fd, 0, size, sessionId, undefined, hash)) return null; const contentSha256 = hash.digest('hex');
    if (process.env.NODE_ENV === 'test' && process.env.OMC_WORKFLOW_TEST_MUTATE_AFTER_READ_BASE64) writeFileSync(canonicalPath, Buffer.from(process.env.OMC_WORKFLOW_TEST_MUTATE_AFTER_READ_BASE64, 'base64'));
    const after = fstatSync(fd, { bigint: true }); if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) return null;
    const stableFd = fd; const identity = fileIdentity(after, contentSha256); const stable = { fd: stableFd, identity, canonicalPath, pathIdentity, root, hashRange: (start, end) => start >= 0 && end >= start && end <= size ? hashRange(stableFd, start, end) : null, scanJsonl: (start, end, callback) => start >= 0 && end >= start && end <= size ? scanJsonl(stableFd, start, end, sessionId, callback) : false };
    fd = undefined; return stable;
  } catch { return null; } finally { if (fd !== undefined) { try { closeSync(fd); } catch {} } }
}
function closeStableTranscript(transcript) { try { closeSync(transcript?.fd); } catch {} }
function activationBoundary(transcriptPath, sessionId) {
  const transcript = readStableTranscript(transcriptPath, sessionId);
  return transcript ? (() => { try { return Object.freeze({ transcriptPath: transcript.canonicalPath, transcriptRoot: transcript.root, transcriptBasename: basename(transcript.canonicalPath), sessionId, byteOffset: transcript.identity.size, fileIdentity: transcript.identity }); } finally { closeStableTranscript(transcript); } })() : null;
}
export function createWorkflowState({ directory, sessionId, task, workflow, transcriptPath }) { clearWorkflowTranscriptFailure(sessionId); const boundary = typeof transcriptPath === 'string' && transcriptPath ? activationBoundary(transcriptPath, sessionId) : null; if (!boundary) return null; const now = new Date().toISOString(); const stages = workflow.stages.map((id, index) => ({ id, status: index === 0 ? 'active' : 'pending', iterations: 0, ...(index === 0 ? { startedAt: now } : {}) })); return { active: true, mode: 'autopilot', prompt: task, directory, project_dir: directory, project_path: directory, session_id: sessionId, workflowRunId: randomUUID(), started_at: now, updated_at: now, last_checked_at: now, phase: workflow.stages[0], workflow, pipelineTracking: { stages, currentStageIndex: 0, trackingRevision: 0, activationBoundary: boundary, completionObservations: [] } }; }
function isFiniteInteger(value) { return Number.isSafeInteger(value) && value >= 0; }
function hasExactKeys(value, keys) { if (!value || typeof value !== 'object' || Array.isArray(value)) return false; const actual = Object.keys(value).sort(); const expected = [...keys].sort(); return actual.length === expected.length && actual.every((key, index) => key === expected[index]); }
function isTimestamp(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function isFileIdentity(value) { return hasExactKeys(value, ['device', 'inode', 'size', 'mtimeNs', 'ctimeNs', 'contentSha256']) && isFiniteInteger(value.device) && isFiniteInteger(value.inode) && isFiniteInteger(value.size) && /^\d+$/.test(value.mtimeNs) && /^\d+$/.test(value.ctimeNs) && /^[a-f0-9]{64}$/.test(value.contentSha256); }
function isBoundary(value, sessionId, root) { return hasExactKeys(value, ['transcriptPath', 'transcriptRoot', 'transcriptBasename', 'sessionId', 'byteOffset', 'fileIdentity']) && typeof value.transcriptPath === 'string' && value.transcriptPath.startsWith(root + sep) && value.transcriptRoot === root && value.transcriptBasename === `${sessionId}.jsonl` && value.sessionId === sessionId && isFiniteInteger(value.byteOffset) && isFileIdentity(value.fileIdentity) && value.fileIdentity.size === value.byteOffset; }
function hasAuthenticatedBoundary(value, sessionId, root) {
  if (!isBoundary(value, sessionId, root)) return false;
  const transcript = readStableTranscript(value.transcriptPath, sessionId);
  if (!transcript) return false;
  try {
    if (transcript.root !== root || transcript.canonicalPath !== value.transcriptPath || basename(transcript.canonicalPath) !== `${sessionId}.jsonl`) return false;
    return transcript.identity.device === value.fileIdentity.device && transcript.identity.inode === value.fileIdentity.inode && transcript.identity.size >= value.byteOffset && transcript.hashRange(0, value.byteOffset) === value.fileIdentity.contentSha256;
  } finally { closeStableTranscript(transcript); }
}
function hasAuthenticatedObservation(observation, sessionId, root) {
  if (!hasAuthenticatedBoundary(observation.activationBoundary, sessionId, root)) return false;
  const transcript = readStableTranscript(observation.activationBoundary.transcriptPath, sessionId);
  try {
    if (transcript.root !== root || transcript.canonicalPath !== observation.activationBoundary.transcriptPath || transcript.identity.device !== observation.stableFile.device || transcript.identity.inode !== observation.stableFile.inode || transcript.identity.size < observation.stableFile.size || transcript.hashRange(0, observation.stableFile.size) !== observation.stableFile.contentSha256) return false;
    const boundary = observation.activationBoundary; if (observation.byteOffset < boundary.byteOffset || observation.byteOffset >= observation.stableFile.size) return false;
    let authenticated = false;
    if (!transcript.scanJsonl(boundary.byteOffset, observation.stableFile.size, (line, byteOffset, lineNumber, recordContentSha256) => { if (byteOffset !== observation.byteOffset || lineNumber !== observation.lineNumber) return true; let record; try { record = JSON.parse(line); } catch { return false; } const text = assistantText(record); authenticated = recordContentSha256 === observation.recordContentSha256 && recordSessionId(record) === sessionId && record?.type === 'assistant' && record?.message?.role === 'assistant' && !record?.isMeta && !record?.isReplay && !record?.replay && !record?.meta && text !== null && !text.includes('<local-command-stdout>') && text.trim() === `Signal: ${SIGNALS[observation.stageId]}`; return true; })) return false;
    return authenticated;
  } finally { closeStableTranscript(transcript); }
}

export function isValidWorkflowTrackingState(state, sessionId = state?.session_id) { clearWorkflowTranscriptFailure(sessionId);
  try {
    const workflow = state?.workflow; const tracking = state?.pipelineTracking; const root = transcriptRoot();
    if (typeof state?.prompt !== 'string' || state.prompt.trim().length === 0) return false;
    if (!hasValidWorkflowHash(workflow) || typeof state?.workflowRunId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(state.workflowRunId) || state?.session_id !== sessionId) return false;
    const terminal = state?.active === false && state?.phase === 'complete';
    const maxIndex = terminal ? workflow.stages.length : workflow.stages.length - 1;
    if (!hasExactKeys(tracking, ['stages', 'currentStageIndex', 'trackingRevision', 'activationBoundary', 'completionObservations']) || !Array.isArray(tracking.stages) || !Array.isArray(tracking.completionObservations) || !isFiniteInteger(tracking.currentStageIndex) || tracking.currentStageIndex > maxIndex || !isFiniteInteger(tracking.trackingRevision) || tracking.trackingRevision !== tracking.currentStageIndex || (terminal && (tracking.currentStageIndex !== workflow.stages.length || tracking.trackingRevision !== workflow.stages.length || tracking.completionObservations.length !== workflow.stages.length))) return false;
    if (!terminal && !((state.active === true || state.active === false) && state.phase === workflow.stages[tracking.currentStageIndex])) return false;
    if (tracking.stages.length !== workflow.stages.length || tracking.completionObservations.length !== tracking.currentStageIndex || !hasAuthenticatedBoundary(tracking.activationBoundary, sessionId, root)) return false;
    for (let index = 0; index < tracking.stages.length; index += 1) {
      const stage = tracking.stages[index]; const expectedStatus = terminal || index < tracking.currentStageIndex ? 'complete' : index === tracking.currentStageIndex ? 'active' : 'pending';
      const expectedKeys = expectedStatus === 'complete' ? ['id', 'status', 'iterations', 'startedAt', 'completedAt'] : expectedStatus === 'active' ? ['id', 'status', 'iterations', 'startedAt'] : ['id', 'status', 'iterations'];
      if (!hasExactKeys(stage, expectedKeys) || stage.id !== workflow.stages[index] || stage.status !== expectedStatus || !isFiniteInteger(stage.iterations) || (stage.startedAt !== undefined && !isTimestamp(stage.startedAt)) || (stage.completedAt !== undefined && !isTimestamp(stage.completedAt))) return false;
    }
    let previousObservation = null;
    const validObservations = tracking.completionObservations.every((observation, index) => {
      if (!hasExactKeys(observation, ['stageId', 'sessionId', 'signalId', 'lineNumber', 'byteOffset', 'recordContentSha256', 'stableFile', 'activationBoundary', 'observedAt'])) return false;
      if (observation.stageId !== workflow.stages[index] || observation.sessionId !== sessionId || observation.signalId !== SIGNALS[observation.stageId] || !isFiniteInteger(observation.lineNumber) || !isFiniteInteger(observation.byteOffset) || !/^[a-f0-9]{64}$/.test(observation.recordContentSha256) || !isTimestamp(observation.observedAt) || !isFileIdentity(observation.stableFile) || !hasAuthenticatedObservation(observation, sessionId, root)) return false;
      if (previousObservation && (observation.activationBoundary.transcriptPath !== previousObservation.activationBoundary.transcriptPath || observation.activationBoundary.byteOffset !== previousObservation.stableFile.size || canonicalJson(observation.activationBoundary.fileIdentity) !== canonicalJson(previousObservation.stableFile))) return false;
      previousObservation = observation;
      return true;
    });
    if (!validObservations) return false;
    if (tracking.currentStageIndex > 0) {
      const latest = tracking.completionObservations.at(-1);
      if (tracking.activationBoundary.transcriptPath !== latest.activationBoundary.transcriptPath || tracking.activationBoundary.byteOffset !== latest.stableFile.size || canonicalJson(tracking.activationBoundary.fileIdentity) !== canonicalJson(latest.stableFile)) return false;
    }
    return true;
  } catch { return false; }
}

function recordSessionId(record) { return record?.sessionId; }
function assistantText(record) {
  const content = record?.message?.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const text = [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) text.push(block.text);
    else if (block?.type === 'thinking' && typeof block.thinking === 'string') continue;
    else if (block?.type === 'redacted_thinking' && typeof block.data === 'string') continue;
    else return null;
  }
  return text.length > 0 ? text.join('') : null;
}
function completionEvidence(transcript, start, end, signal, sessionId) { let evidence = null; const valid = transcript.scanJsonl(start, end, (line, byteOffset, lineNumber, recordContentSha256) => { if (line.trim().length === 0) return false; let record; try { record = JSON.parse(line); } catch { return false; } const text = assistantText(record); const isAssistant = recordSessionId(record) === sessionId && record?.type === 'assistant' && record?.message?.role === 'assistant' && !record?.isMeta && !record?.isReplay && !record?.replay && !record?.meta && text !== null; if (!evidence && isAssistant && !text.includes('<local-command-stdout>') && text.trim() === `Signal: ${signal}`) evidence = { byteOffset, lineNumber, recordContentSha256 }; return true; }); return valid ? evidence : null; }
export function advanceWorkflowOnStop(state, input, sessionId) { clearWorkflowTranscriptFailure(sessionId);
  const workflow = state?.workflow; const tracking = state?.pipelineTracking;
  if (!isValidWorkflowTrackingState(state, sessionId)) return null;
  const index = tracking.currentStageIndex; const stageId = workflow.stages[index];
  const suppliedPath = input.transcript_path || input.transcriptPath; const boundary = tracking.activationBoundary;
  const transcript = typeof suppliedPath === 'string' ? readStableTranscript(suppliedPath, sessionId) : null;
  const absolute = transcript?.canonicalPath;
  if (!boundary || !transcript || absolute !== boundary.transcriptPath || boundary.transcriptRoot !== transcript.root || boundary.transcriptBasename !== `${sessionId}.jsonl` || boundary.sessionId !== sessionId || !Number.isSafeInteger(boundary.byteOffset) || boundary.byteOffset < 0) { closeStableTranscript(transcript); return null; }
  if (transcript.identity.size < boundary.byteOffset || boundary.fileIdentity.device !== transcript.identity.device || boundary.fileIdentity.inode !== transcript.identity.inode || transcript.hashRange(0, boundary.byteOffset) !== boundary.fileIdentity.contentSha256) { closeStableTranscript(transcript); return null; }
  const evidence = completionEvidence(transcript, boundary.byteOffset, transcript.identity.size, SIGNALS[stageId], sessionId); if (!evidence) { closeStableTranscript(transcript); return null; }
  const revision = Number.isSafeInteger(tracking.trackingRevision) ? tracking.trackingRevision : 0; const observedAt = new Date().toISOString(); const nextIndex = index + 1; const nextStage = workflow.stages[nextIndex] || null; const nextStagePrompt = nextStage ? resolveWorkflowStagePrompt(state, nextStage) : null; if (nextStage && !nextStagePrompt) { closeStableTranscript(transcript); return null; }
  const updated = JSON.parse(JSON.stringify(state)); updated.pipelineTracking.stages[index].status = 'complete'; updated.pipelineTracking.stages[index].completedAt = observedAt;
  if (nextStage) { updated.pipelineTracking.stages[nextIndex].status = 'active'; updated.pipelineTracking.stages[nextIndex].startedAt = observedAt; updated.pipelineTracking.activationBoundary = Object.freeze({ transcriptPath: absolute, transcriptRoot: transcript.root, transcriptBasename: basename(absolute), sessionId, byteOffset: transcript.identity.size, fileIdentity: transcript.identity }); updated.phase = nextStage; } else { updated.active = false; updated.phase = 'complete'; }
  updated.pipelineTracking.currentStageIndex = nextIndex; updated.pipelineTracking.trackingRevision = revision + 1; updated.pipelineTracking.completionObservations = [...(Array.isArray(tracking.completionObservations) ? tracking.completionObservations : []), Object.freeze({ stageId, sessionId, signalId: SIGNALS[stageId], lineNumber: evidence.lineNumber, byteOffset: evidence.byteOffset, recordContentSha256: evidence.recordContentSha256, stableFile: Object.freeze(transcript.identity), activationBoundary: Object.freeze({ transcriptPath: boundary.transcriptPath, transcriptRoot: boundary.transcriptRoot, transcriptBasename: boundary.transcriptBasename, sessionId: boundary.sessionId, byteOffset: boundary.byteOffset, fileIdentity: boundary.fileIdentity }), observedAt })]; updated.updated_at = observedAt; updated.last_checked_at = observedAt;
  const result = { updated, nextStage, nextStagePrompt, expectedRevision: revision, expectedProfileHash: workflow.profileHash, expectedWorkflowRunId: state.workflowRunId, expectedSessionId: sessionId, expectedStageId: stageId, expectedStageIndex: index, expectedTranscriptPath: absolute, expectedTranscriptIdentity: transcript.identity, expectedTranscriptPathIdentity: transcript.pathIdentity, expectedEvidenceHash: evidence.recordContentSha256 }; closeStableTranscript(transcript); return result;
}
export function refreshWorkflowBoundaryForCommit(advance) {
  clearWorkflowTranscriptFailure(advance.expectedSessionId);
  const transcript = readStableTranscript(advance.expectedTranscriptPath, advance.expectedSessionId);
  if (!transcript) return false;
  try {
    if (transcript.canonicalPath !== advance.expectedTranscriptPath || canonicalJson(transcript.identity) !== canonicalJson(advance.expectedTranscriptIdentity) || canonicalJson(transcript.pathIdentity) !== canonicalJson(advance.expectedTranscriptPathIdentity)) return false;
    const observation = advance.updated?.pipelineTracking?.completionObservations?.at(-1);
    const boundary = observation?.activationBoundary;
    if (!boundary || transcript.identity.size < boundary.byteOffset) return false;
    const evidence = completionEvidence(transcript, boundary.byteOffset, transcript.identity.size, SIGNALS[advance.expectedStageId], advance.expectedSessionId);
    if (!evidence || evidence.recordContentSha256 !== advance.expectedEvidenceHash) return false;
    advance.updated.pipelineTracking.activationBoundary = Object.freeze({ transcriptPath: transcript.canonicalPath, transcriptRoot: transcript.root, transcriptBasename: basename(transcript.canonicalPath), sessionId: advance.expectedSessionId, byteOffset: transcript.identity.size, fileIdentity: transcript.identity });
    return true;
  } finally { closeStableTranscript(transcript); }
}
