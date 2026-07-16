import { randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import * as nativePath from 'node:path';
import { basename, dirname, resolve } from 'node:path';
import { analyzeLegacyClaudeMd, decodeClaudeMdUtf8 as decodeClaudeMdUtf8PreservingBom, OMC_END_MARKER, OMC_START_MARKER, parseClaudeMdMarkers, removeClaudeMdRanges } from './claude-md-analysis.js';

export const CLAUDE_MD_IMPORT_START = '<!-- OMC:IMPORT:START -->';
export const CLAUDE_MD_IMPORT_END = '<!-- OMC:IMPORT:END -->';
export const CLAUDE_MD_IMPORT_BLOCK = `${CLAUDE_MD_IMPORT_START}\n@CLAUDE-omc.md\n${CLAUDE_MD_IMPORT_END}\n`;

export type ClaudeMdTransactionMode = 'local' | 'global-overwrite' | 'global-preserve';
export type ClaudeMdTransactionExitCode = 0 | 3 | 4 | 5 | 6;

/** Metadata returned to callers. Content bytes and temporary paths are deliberately private. */
export interface ClaudeMdOperation { path: string; type: 'write' | 'delete'; existedBefore: boolean; }
export interface ClaudeMdTransactionResult {
  ok: boolean; exitCode: ClaudeMdTransactionExitCode; mode: ClaudeMdTransactionMode;
  operations: ClaudeMdOperation[]; completedOperations: ClaudeMdOperation[]; backups: string[];
  createdPaths: string[]; deletedPaths: string[]; mutatedPaths: string[];
  removedRanges: Array<{ start: number; end: number }>; removedVariants: string[]; warnings: string[];
  error?: string; failedPhase?: 'validation' | 'backup' | 'mutation' | 'rollback'; failedPath?: string;
  rollback: Array<{ path: string; ok: boolean; error?: string }>;
  tempCleanup: Array<{ path: string; ok: boolean; error?: string }>;
}

export interface ClaudeMdTransactionFs {
  existsSync: typeof nodeFs.existsSync; lstatSync: typeof nodeFs.lstatSync; mkdirSync: typeof nodeFs.mkdirSync;
  openSync: typeof nodeFs.openSync; closeSync: typeof nodeFs.closeSync; readFileSync: typeof nodeFs.readFileSync;
  renameSync: typeof nodeFs.renameSync; rmSync: typeof nodeFs.rmSync; unlinkSync: typeof nodeFs.unlinkSync;
  writeFileSync: typeof nodeFs.writeFileSync;
}
const defaultFs: ClaudeMdTransactionFs = nodeFs;

export interface ClaudeMdTransactionRequest {
  mode: ClaudeMdTransactionMode; root: string; source: string; sourceRoot?: string; version?: string;
  /** A coordinator-verified canonical buffer. This prevents a second source read/swap. */
  sourceBytes?: Buffer;
  /** Test-only synchronous filesystem seam. */
  fs?: ClaudeMdTransactionFs;
}
interface PreState { path: string; existedBefore: boolean; bytes?: Buffer; backupPath?: string; }
interface PlannedOperation extends ClaudeMdOperation { bytes?: Buffer; tempPath?: string; }

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function publicOperation(operation: PlannedOperation): ClaudeMdOperation { return { path: operation.path, type: operation.type, existedBefore: operation.existedBefore }; }
function failure(request: ClaudeMdTransactionRequest, code: ClaudeMdTransactionExitCode, error: string, phase: ClaudeMdTransactionResult['failedPhase'], path?: string): ClaudeMdTransactionResult {
  return { ok: false, exitCode: code, mode: request.mode, operations: [], completedOperations: [], backups: [], createdPaths: [], deletedPaths: [], mutatedPaths: [], removedRanges: [], removedVariants: [], warnings: [], error, failedPhase: phase, failedPath: path, rollback: [], tempCleanup: [] };
}

/** Decodes only valid UTF-8 without stripping a leading byte-order mark. */
export function decodeClaudeMdUtf8(bytes: Buffer, path: string): string {
  return decodeClaudeMdUtf8PreservingBom(bytes, path);
}

/**
 * Returns whether candidate is a strict lexical child of root using the supplied host path implementation.
 * The injectable path implementation exists solely for platform-independent lexical tests.
 */
export function isStrictChildPath(root: string, candidate: string, path: Pick<typeof nativePath, 'isAbsolute' | 'relative' | 'resolve'> = nativePath): boolean {
  if (/^(?:\\\\|\/\/)[?.](?:\\|\/)/.test(root) || /^(?:\\\\|\/\/)[?.](?:\\|\/)/.test(candidate)) return false;
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  const rel = path.relative(normalizedRoot, normalizedCandidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${nativePath.sep}`) && !rel.startsWith('../') && !rel.startsWith('..\\') && !path.isAbsolute(rel);
}

export function validateRootedRegularFile(root: string, path: string, allowAbsent = true, fs: ClaudeMdTransactionFs = defaultFs): string {
  const normalizedRoot = nativePath.resolve(root);
  const normalizedPath = nativePath.resolve(path);
  if (!isStrictChildPath(root, path)) {
    if (normalizedRoot === normalizedPath) throw new Error(`Not a regular file: ${normalizedPath}`);
    throw new Error(`Path escapes root: ${path}`);
  }
  if (!fs.existsSync(normalizedPath)) { if (allowAbsent) return normalizedPath; throw new Error(`Missing path: ${normalizedPath}`); }
  const stat = fs.lstatSync(normalizedPath);
  if (stat.isSymbolicLink()) throw new Error(`Refusing symlink: ${normalizedPath}`);
  if (!stat.isFile()) throw new Error(`Not a regular file: ${normalizedPath}`);
  return normalizedPath;
}

function cleanCanonical(source: string): string {
  const markers = parseClaudeMdMarkers(source);
  if (markers.state === 'corrupt') throw new Error(`Canonical source has corrupt OMC markers: ${markers.diagnostics.join(', ')}`);
  if (markers.state !== 'complete' || markers.managedRanges.length !== 1) throw new Error('Canonical source missing required OMC markers or does not contain exactly one complete managed block');
  const range = markers.managedRanges[0];
  return source.slice(range.contentStart, range.contentEnd).replace(/\r?\n$/, '');
}
function renderManaged(canonical: string, version?: string): string {
  const body = cleanCanonical(canonical).replace(/<!-- OMC:VERSION:[^\s]*? -->\r?\n?/g, '');
  return `${OMC_START_MARKER}\n${version ? `<!-- OMC:VERSION:${version} -->\n` : ''}${body}\n${OMC_END_MARKER}\n`;
}
function importRanges(content: string): Array<{ start: number; end: number }> {
  const lines = parseClaudeMdMarkers(content).lines;
  const ranges: Array<{ start: number; end: number }> = [];
  for (let index = 0; index + 2 < lines.length; index += 1) {
    if (lines[index].text === CLAUDE_MD_IMPORT_START && lines[index + 1].text === '@CLAUDE-omc.md' && lines[index + 2].text === CLAUDE_MD_IMPORT_END) {
      ranges.push({ start: lines[index].start, end: lines[index + 2].eolEnd });
      index += 2;
    }
  }
  return ranges;
}
function generatedHeaderRanges(markers: ReturnType<typeof parseClaudeMdMarkers>): Array<{ start: number; end: number }> {
  const generatedHeaders = new Set(['<!-- User customizations -->', '<!-- User customizations (recovered from corrupted markers) -->']);
  const ranges: Array<{ start: number; end: number }> = [];
  for (let index = 1; index < markers.lines.length; index += 1) {
    const header = markers.lines[index];
    const separator = markers.lines[index - 1];
    if (!generatedHeaders.has(header.text) || separator.text !== '') continue;
    if (markers.managedRanges.some(range => range.end === separator.start)) {
      ranges.push({ start: separator.start, end: header.eolEnd });
    }
  }
  return ranges;
}

function cleanedExisting(content: string): { content: string; ranges: Array<{ start: number; end: number }>; variants: string[] } {
  const analysis = analyzeLegacyClaudeMd(content);
  if (analysis.markers.state === 'corrupt') throw new Error(`Existing CLAUDE.md has corrupt OMC markers: ${analysis.markers.diagnostics.join(', ')}`);
  const imports = importRanges(content).filter(range => analysis.markers.outsideRanges.some(outside => range.start >= outside.start && range.end <= outside.end));
  const ranges = [...analysis.markers.managedRanges, ...analysis.exactMatches, ...imports, ...generatedHeaderRanges(analysis.markers)];
  return { content: removeClaudeMdRanges(content, ranges), ranges, variants: analysis.exactMatches.map(match => match.variantId) };
}
function mergeForOverwrite(existing: string | null, canonical: string, version?: string): { content: string; ranges: Array<{ start: number; end: number }>; variants: string[] } {
  const managed = renderManaged(canonical, version);
  if (existing === null) return { content: managed, ranges: [], variants: [] };
  const cleaned = cleanedExisting(existing);
  return { content: cleaned.content.length === 0 ? managed : `${managed}\n<!-- User customizations -->\n${cleaned.content}`, ranges: cleaned.ranges, variants: cleaned.variants };
}

function exclusiveVerifiedBackup(state: PreState, fs: ClaudeMdTransactionFs): string {
  const directory = dirname(state.path); const stem = `${basename(state.path)}.backup.${new Date().toISOString().replace(/[:.]/g, '-')}`;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const backup = `${directory}/${stem}.${randomBytes(12).toString('hex')}`;
    try {
      const fd = fs.openSync(backup, 'wx', 0o600);
      try { fs.writeFileSync(fd, state.bytes!); } finally { fs.closeSync(fd); }
      if (!fs.readFileSync(backup).equals(state.bytes!)) throw new Error(`Backup readback mismatch: ${backup}`);
      return backup;
    } catch (error) { try { fs.unlinkSync(backup); } catch { /* partial backup is best effort */ } if (attempt === 15) throw error; }
  }
  throw new Error('Unable to create backup');
}
function atomicWrite(operation: PlannedOperation, fs: ClaudeMdTransactionFs): void {
  const directory = dirname(operation.path); fs.mkdirSync(directory, { recursive: true });
  operation.tempPath = `${directory}/.${basename(operation.path)}.omc-tmp-${randomBytes(12).toString('hex')}`;
  fs.writeFileSync(operation.tempPath, operation.bytes!, { flag: 'wx', mode: 0o600 }); fs.renameSync(operation.tempPath, operation.path); operation.tempPath = undefined;
}
function cleanupTemps(operations: readonly PlannedOperation[], result: ClaudeMdTransactionResult, fs: ClaudeMdTransactionFs): void {
  for (const operation of operations) if (operation.tempPath) {
    const tempPath = operation.tempPath;
    try { fs.rmSync(tempPath, { force: true }); result.tempCleanup.push({ path: tempPath, ok: true }); } catch (error) { result.tempCleanup.push({ path: tempPath, ok: false, error: message(error) }); }
  }
}

export function executeClaudeMdTransaction(request: ClaudeMdTransactionRequest): ClaudeMdTransactionResult {
  const fs = request.fs ?? defaultFs;
  let root: string; let sourcePath: string;
  try {
    root = resolve(request.root); const rootStat = fs.lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`Invalid transaction root: ${root}`);
    sourcePath = validateRootedRegularFile(request.sourceRoot ?? root, request.source, !request.sourceBytes, fs);
  } catch (error) { return failure(request, 3, message(error), 'validation'); }
  const main = resolve(root, 'CLAUDE.md'); const companion = resolve(root, 'CLAUDE-omc.md');
  try {
    validateRootedRegularFile(root, main, true, fs); if (request.mode !== 'local') validateRootedRegularFile(root, companion, true, fs);
    const canonical = decodeClaudeMdUtf8(request.sourceBytes ?? fs.readFileSync(sourcePath), sourcePath);
    const mainBytes = fs.existsSync(main) ? fs.readFileSync(main) : undefined;
    const companionBytes = fs.existsSync(companion) ? fs.readFileSync(companion) : undefined;
    const mainText = mainBytes ? decodeClaudeMdUtf8(mainBytes, main) : null; if (companionBytes) decodeClaudeMdUtf8(companionBytes, companion);
    const overwrite = request.mode === 'global-preserve' ? { content: '', ranges: [], variants: [] } : mergeForOverwrite(mainText, canonical, request.version);
    const preserve = mainText === null ? { content: '', ranges: [], variants: [] } : request.mode === 'global-preserve' ? cleanedExisting(mainText) : { content: '', ranges: [], variants: [] };
    if (request.mode !== 'local' && companionBytes && parseClaudeMdMarkers(decodeClaudeMdUtf8(companionBytes, companion)).state === 'corrupt') throw new Error('Existing companion has corrupt OMC markers');
    const operations: PlannedOperation[] = [];
    if (request.mode === 'local') operations.push({ path: main, type: 'write', existedBefore: !!mainBytes, bytes: Buffer.from(overwrite.content, 'utf8') });
    else if (request.mode === 'global-overwrite') { operations.push({ path: main, type: 'write', existedBefore: !!mainBytes, bytes: Buffer.from(overwrite.content, 'utf8') }); if (companionBytes) operations.push({ path: companion, type: 'delete', existedBefore: true }); }
    else {
      const imports = mainText === null ? [] : importRanges(mainText);
      const mainIsAlreadyOwned = imports.length > 0 && preserve.ranges.length === imports.length;
      const mainContent = mainIsAlreadyOwned && mainBytes !== undefined ? mainBytes : Buffer.from(`${preserve.content}${preserve.content.length ? '\n\n' : ''}${CLAUDE_MD_IMPORT_BLOCK}`, 'utf8');
      operations.push({ path: companion, type: 'write', existedBefore: !!companionBytes, bytes: Buffer.from(renderManaged(canonical, request.version), 'utf8') });
      operations.push({ path: main, type: 'write', existedBefore: !!mainBytes, bytes: mainContent });
    }
    const effectiveOperations = operations.filter(operation => {
      if (operation.type === 'delete') return operation.existedBefore;
      const existingBytes = operation.path === main ? mainBytes : companionBytes;
      const plannedBytes = operation.bytes;
      if (plannedBytes === undefined) throw new Error(`Missing write bytes: ${operation.path}`);
      return existingBytes === undefined || !plannedBytes.equals(existingBytes);
    });
    const states = new Map<string, PreState>(effectiveOperations.map(operation => [operation.path, { path: operation.path, existedBefore: operation.existedBefore, bytes: operation.path === main ? mainBytes : companionBytes }]));
    const appliedMainCleanup = effectiveOperations.some(operation => operation.path === main);
    const result: ClaudeMdTransactionResult = { ok: false, exitCode: 0, mode: request.mode, operations: effectiveOperations.map(publicOperation), completedOperations: [], backups: [], createdPaths: [], deletedPaths: [], mutatedPaths: [], removedRanges: appliedMainCleanup ? request.mode === 'global-preserve' ? preserve.ranges : overwrite.ranges : [], removedVariants: appliedMainCleanup ? request.mode === 'global-preserve' ? preserve.variants : overwrite.variants : [], warnings: [], rollback: [], tempCleanup: [] };
    try { for (const state of states.values()) if (state.existedBefore) { state.backupPath = exclusiveVerifiedBackup(state, fs); result.backups.push(state.backupPath); } }
    catch (error) { result.exitCode = 4; result.error = message(error); result.failedPhase = 'backup'; return result; }
    try {
      for (const operation of effectiveOperations) { if (operation.type === 'write') atomicWrite(operation, fs); else fs.unlinkSync(operation.path); result.completedOperations.push(publicOperation(operation)); result.mutatedPaths.push(operation.path); if (!operation.existedBefore && operation.type === 'write') result.createdPaths.push(operation.path); if (operation.type === 'delete') result.deletedPaths.push(operation.path); }
      result.ok = true; result.exitCode = 0; return result;
    } catch (error) {
      result.error = message(error); result.failedPhase = 'mutation'; result.failedPath = effectiveOperations.find(operation => !result.completedOperations.some(done => done.path === operation.path))?.path;
      const rollbackOperations: PlannedOperation[] = [];
      for (const operation of [...result.completedOperations].reverse()) {
        const state = states.get(operation.path)!;
        try {
          if (state.existedBefore) {
            const rollbackOperation: PlannedOperation = { path: state.path, type: 'write', existedBefore: true, bytes: state.bytes };
            rollbackOperations.push(rollbackOperation);
            atomicWrite(rollbackOperation, fs);
          } else if (fs.existsSync(state.path)) fs.unlinkSync(state.path);
          result.rollback.push({ path: state.path, ok: true });
        }
        catch (rollbackError) { result.failedPhase = 'rollback'; result.failedPath = state.path; result.rollback.push({ path: state.path, ok: false, error: message(rollbackError) }); }
      }
      cleanupTemps([...effectiveOperations, ...rollbackOperations], result, fs); result.exitCode = result.rollback.every(item => item.ok) && result.tempCleanup.every(item => item.ok) ? 5 : 6; return result;
    }
  } catch (error) { return failure(request, 3, message(error), 'validation'); }
}
