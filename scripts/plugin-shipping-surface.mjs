#!/usr/bin/env node
/**
 * Verify and stage the generated runtime files a plugin checkout must carry.
 *
 * The closure starts from plugin/runtime entrypoints and explicit package payloads.
 * It never treats the existing generated tree as an entrypoint and never stages a
 * generated directory.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import ts from 'typescript';

const GENERATED_ROOTS = Object.freeze(['dist', 'bridge']);
const MODULE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);
const DECLARATION_EXTENSION = '.d.ts';
const RESOLVABLE_EXTENSIONS = ['.js', '.cjs', '.mjs', '.json', '.d.ts'];
const OPTIONAL_BRIDGE_PAYLOADS = Object.freeze([
  'bridge/gyoshu_bridge.py',
  'bridge/run-mcp-server.sh',
]);

function fail(message) {
  throw new Error(message);
}

function comparePaths(left, right) {
  return left.localeCompare(right);
}

function isInside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function normalizeRepoPath(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty path`);
  if (value.includes('\\') || value.includes('\0') || isAbsolute(value)) {
    fail(`${label} must be a relative POSIX path`);
  }
  const normalized = value.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalized || normalized.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    fail(`${label} must stay within the package root`);
  }
  return normalized;
}

function containedRegularFile(root, repoPath, label = repoPath) {
  const normalized = normalizeRepoPath(repoPath, label);
  const rootReal = realpathSync(root);
  let current = rootReal;
  for (const segment of normalized.split('/')) {
    current = join(current, segment);
    if (!existsSync(current)) fail(`required generated runtime file is missing: ${normalized}`);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) fail(`${label} must not traverse a symbolic link: ${normalized}`);
  }
  if (!lstatSync(current).isFile()) fail(`${label} must be a regular file: ${normalized}`);
  if (!isInside(rootReal, realpathSync(current))) fail(`${label} escapes package root: ${normalized}`);
  return { repoPath: normalized, absolutePath: current };
}

function readText(root, repoPath, label = repoPath) {
  const file = containedRegularFile(root, repoPath, label);
  return readFileSync(file.absolutePath, 'utf8');
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readJson(root, repoPath, label = repoPath) {
  return parseJson(readText(root, repoPath, label), label);
}

function git(root, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.error) fail(`git ${args.join(' ')} could not start: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    fail(`git ${args.join(' ')} failed: ${detail}`);
  }
  return result;
}

function gitNullPaths(root, args) {
  return git(root, args).stdout.split('\0').filter(Boolean).map(path => normalizeRepoPath(path, 'Git path'));
}

function readJsonAtCommit(root, commit, repoPath) {
  const result = git(root, ['show', `${commit}:${repoPath}`], { allowFailure: true });
  if (result.status !== 0) fail(`cannot read ${repoPath} from base commit ${commit}`);
  return parseJson(result.stdout, `${repoPath} at ${commit}`);
}

function isWithin(repoPath, directory) {
  return repoPath === directory || repoPath.startsWith(`${directory}/`);
}

function isGeneratedPath(repoPath) {
  return GENERATED_ROOTS.some(root => isWithin(repoPath, root));
}

function isModulePath(repoPath) {
  return MODULE_EXTENSIONS.has(extname(repoPath));
}

function isDeclarationPath(repoPath) {
  return repoPath.endsWith(DECLARATION_EXTENSION);
}

function isTestOrFixturePath(repoPath) {
  const segments = repoPath.split('/');
  const fileName = segments.at(-1) ?? '';
  return segments.some(segment => segment === '__tests__' || segment === 'tests' || segment === 'fixtures')
    || /\.(?:test|spec)\.[cm]?js$/.test(fileName);
}

function isRuntimeArtifactCandidate(repoPath) {
  return (isModulePath(repoPath) || isDeclarationPath(repoPath) || repoPath.endsWith('.py') || repoPath.endsWith('.sh'))
    && !isTestOrFixturePath(repoPath);
}


function addPackagePath(paths, value, label) {
  if (typeof value !== 'string') return;
  const repoPath = normalizeRepoPath(value, label);
  paths.add(repoPath);
}

function collectPackageBinEntrypoints(packageJson) {
  const paths = new Set();
  if (typeof packageJson.bin === 'string') addPackagePath(paths, packageJson.bin, 'package.json bin');
  else if (packageJson.bin && typeof packageJson.bin === 'object') {
    for (const [name, value] of Object.entries(packageJson.bin)) {
      addPackagePath(paths, value, `package.json bin ${name}`);
    }
  }
  return paths;
}

function collectPackagePublicEntrypoints(packageJson) {
  const paths = collectPackageBinEntrypoints(packageJson);
  addPackagePath(paths, packageJson.main, 'package.json main');
  addPackagePath(paths, packageJson.types, 'package.json types');
  const collectExports = (value, label) => {
    if (typeof value === 'string') addPackagePath(paths, value, label);
    else if (Array.isArray(value)) value.forEach((target, index) => collectExports(target, `${label}[${index}]`));
    else if (value && typeof value === 'object') {
      for (const [condition, target] of Object.entries(value)) collectExports(target, `${label}.${condition}`);
    }
  };
  collectExports(packageJson.exports, 'package.json exports');
  return paths;
}

function collectDeclaredGeneratedPayloads(root, packageJson, { directoryCommit = null, presentAtRoot = false } = {}) {
  if (!Array.isArray(packageJson.files)) fail('package.json files must be an array');
  const paths = new Set();
  const standaloneBundles = new Set();
  const collectDirectory = repoPath => {
    if (directoryCommit) {
      for (const child of gitNullPaths(root, ['ls-tree', '-r', '--name-only', '-z', directoryCommit, '--', repoPath])) {
        if (isRuntimeArtifactCandidate(child) && (!presentAtRoot || existsSync(join(root, child)))) paths.add(child);
      }
      return;
    }
    const absolutePath = join(root, repoPath);
    if (!existsSync(absolutePath)) fail(`required generated runtime directory is missing: ${repoPath}`);
    const stat = lstatSync(absolutePath);
    if (stat.isSymbolicLink()) fail(`package.json files entry must not traverse a symbolic link: ${repoPath}`);
    if (!stat.isDirectory()) fail(`package.json files entry must be a directory: ${repoPath}`);
    for (const entry of readdirSync(absolutePath, { withFileTypes: true })) {
      const child = `${repoPath}/${entry.name}`;
      if (entry.isSymbolicLink()) fail(`package.json files entry must not traverse a symbolic link: ${child}`);
      if (entry.isDirectory()) collectDirectory(child);
      else if (entry.isFile() && isRuntimeArtifactCandidate(child)) paths.add(child);
    }
  };
  for (const value of packageJson.files) {
    if (typeof value !== 'string') fail('package.json files entries must be strings');
    const repoPath = normalizeRepoPath(value, 'package.json files entry');
    if (!isGeneratedPath(repoPath)) continue;
    if (extname(repoPath)) {
      paths.add(repoPath);
      if (isWithin(repoPath, 'bridge') && isModulePath(repoPath)) standaloneBundles.add(repoPath);
    }
    else collectDirectory(repoPath);
  }
  return { paths, standaloneBundles };
}

function pluginRootPaths(value, label) {
  if (typeof value !== 'string') return [];
  const paths = [];
  const pattern = /"?(?:\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT)"?\/([A-Za-z0-9_./-]+)/g;
  for (const match of value.matchAll(pattern)) paths.push(normalizeRepoPath(match[1], label));
  return paths;
}

function collectManifestEntrypoints(root) {
  const paths = new Set(['.claude-plugin/plugin.json']);
  const pluginJson = readJson(root, '.claude-plugin/plugin.json');
  if (existsSync(join(root, '.claude-plugin', 'marketplace.json'))) paths.add('.claude-plugin/marketplace.json');

  if (typeof pluginJson.mcpServers === 'string') {
    const mcpPath = normalizeRepoPath(pluginJson.mcpServers, '.claude-plugin/plugin.json mcpServers');
    paths.add(mcpPath);
    const mcpJson = readJson(root, mcpPath);
    for (const [name, server] of Object.entries(mcpJson.mcpServers ?? {})) {
      if (!server || typeof server !== 'object') fail(`${mcpPath} mcpServers.${name} must be an object`);
      for (const value of [server.command, ...(Array.isArray(server.args) ? server.args : [])]) {
        for (const repoPath of pluginRootPaths(value, `${mcpPath} mcpServers.${name}`)) paths.add(repoPath);
      }
    }
  }

  if (existsSync(join(root, 'hooks', 'hooks.json'))) {
    paths.add('hooks/hooks.json');
    const hooksJson = readJson(root, 'hooks/hooks.json');
    for (const groups of Object.values(hooksJson.hooks ?? {})) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        if (!Array.isArray(group?.hooks)) continue;
        for (const hook of group.hooks) {
          for (const repoPath of pluginRootPaths(hook?.command, 'hooks/hooks.json command')) paths.add(repoPath);
        }
      }
    }
  }

  if (existsSync(join(root, 'scripts', 'setup-claude-md.sh'))) paths.add('scripts/setup-claude-md.sh');
  if (existsSync(join(root, 'scripts', 'lib', 'config-dir.sh'))) paths.add('scripts/lib/config-dir.sh');
  for (const path of OPTIONAL_BRIDGE_PAYLOADS) if (existsSync(join(root, path))) paths.add(path);
  return { paths, pluginJson };
}

function pathJoinName(node) {
  if (!ts.isCallExpression(node)) return null;
  const expression = node.expression;
  const name = ts.isIdentifier(expression)
    ? expression.text
    : ts.isPropertyAccessExpression(expression)
      ? expression.name.text
      : '';
  return name === 'join' || name === 'resolve' ? name : null;
}

function unwrapPathWrapper(node) {
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'href') return unwrapPathWrapper(node.expression);
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
    && (node.expression.text === 'pathToFileURL' || node.expression.text === 'fileURLToPath')
    && node.arguments.length === 1) return unwrapPathWrapper(node.arguments[0]);
  return node;
}

function isImportMetaUrl(node) {
  return ts.isPropertyAccessExpression(node) && node.name.text === 'url'
    && ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
    && node.expression.name.text === 'meta';
}

function collectConstantBindings(sourceFile) {
  const bindings = new Map();
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const)) {
      bindings.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bindings;
}

function staticValue(node, bindings, resolving = new Set()) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node) && bindings.has(node.text) && !resolving.has(node.text)) {
    const next = new Set(resolving);
    next.add(node.text);
    return staticValue(bindings.get(node.text), bindings, next);
  }
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL'
    && node.arguments?.length === 2 && isImportMetaUrl(node.arguments[1])) return staticValue(node.arguments[0], bindings, resolving);
  if (ts.isArrayLiteralExpression(node)) {
    const values = [];
    for (const element of node.elements) {
      const value = staticValue(ts.isSpreadElement(element) ? element.expression : element, bindings, resolving);
      if (typeof value === 'string') values.push(value);
      else if (Array.isArray(value)) values.push(...value);
      else return null;
    }
    return values;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticValue(node.left, bindings, resolving);
    const right = staticValue(node.right, bindings, resolving);
    return typeof left === 'string' && typeof right === 'string' ? left + right : null;
  }
  if (pathJoinName(node)) {
    const parts = [];
    for (const argument of node.arguments) {
      const value = staticValue(ts.isSpreadElement(argument) ? argument.expression : argument, bindings, resolving);
      if (typeof value === 'string') parts.push(value);
      else if (ts.isSpreadElement(argument) && Array.isArray(value)) parts.push(...value);
      else return null;
    }
    return parts.join('/');
  }
  return null;
}


function generatedJoinPath(node, bindings) {
  const pathNode = unwrapPathWrapper(node);
  if (!pathJoinName(pathNode)) return null;
  const parts = [];
  for (const argument of pathNode.arguments) {
    const value = staticValue(ts.isSpreadElement(argument) ? argument.expression : argument, bindings);
    if (typeof value === 'string') parts.push(...value.split('/'));
    else if (ts.isSpreadElement(argument) && Array.isArray(value)) {
      for (const part of value) parts.push(...part.split('/'));
    } else parts.push(null);
  }
  const rootIndex = parts.findIndex(part => part === 'dist' || part === 'bridge');
  if (rootIndex < 0) return null;
  if (parts.slice(rootIndex).some(part => part === null)) return null;
  const generatedPath = parts.slice(rootIndex).join('/');
  if (!extname(generatedPath)) return null;
  return normalizeRepoPath(generatedPath, 'computed generated runtime path');
}

function containsPotentialLocalReference(node, bindings) {
  const value = staticValue(node, bindings);
  if (typeof value === 'string') {
    return value.startsWith('./') || value.startsWith('../') || value === 'dist' || value === 'bridge';
  }
  let found = false;
  ts.forEachChild(node, current => {
    if (!found) found = containsPotentialLocalReference(current, bindings);
  });
  return found;
}

function moduleReferences(source, repoPath) {
  const sourceFile = ts.createSourceFile(repoPath, source, ts.ScriptTarget.Latest, true, isDeclarationPath(repoPath) ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  if (sourceFile.parseDiagnostics.length > 0) {
    const diagnostic = sourceFile.parseDiagnostics[0];
    fail(`cannot parse runtime module ${repoPath}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`);
  }

  const local = new Set();
  if (isDeclarationPath(repoPath)) {
    for (const reference of ts.preProcessFile(source, true, true).referencedFiles) {
      if (reference.fileName.startsWith('./') || reference.fileName.startsWith('../')) local.add(reference.fileName);
    }
  }
  const generated = new Set();
  const bindings = collectConstantBindings(sourceFile);
  const addLocal = node => {
    if (!node) return false;
    const value = staticValue(node, bindings);
    if (typeof value === 'string' && (value.startsWith('./') || value.startsWith('../'))) {
      local.add(value);
      return true;
    }
    return false;
  };
  const visit = node => {
    const generatedPath = generatedJoinPath(node, bindings);
    if (generatedPath) generated.add(generatedPath);

    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) addLocal(node.moduleSpecifier);
    else if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const directRequire = ts.isIdentifier(expression) && expression.text === 'require';
      const dynamicImport = expression.kind === ts.SyntaxKind.ImportKeyword;
      const requireResolve = ts.isPropertyAccessExpression(expression)
        && ts.isIdentifier(expression.expression)
        && expression.expression.text === 'require'
        && expression.name.text === 'resolve';
      const moduleRequire = ts.isPropertyAccessExpression(expression) && expression.name.text === 'require';
      if (directRequire || dynamicImport || requireResolve || moduleRequire) {
        const argument = node.arguments[0];
        if (!addLocal(argument) && argument && containsPotentialLocalReference(argument, bindings)
          && !generatedJoinPath(argument, bindings)) {
          fail(`ambiguous local runtime load in ${repoPath}: ${argument.getText(sourceFile)}`);
        }
      }
    } else if (ts.isNewExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'URL'
      && node.arguments?.length) {
      addLocal(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return {
    local: [...local].sort(comparePaths),
    generated: [...generated].sort(comparePaths),
  };
}

function resolveLocalReference(root, importer, specifier) {
  const base = resolve(dirname(join(root, importer)), specifier);
  if (!isInside(realpathSync(root), base)) fail(`runtime import escapes package root: ${importer} -> ${specifier}`);
  const candidates = [base];
  if (isDeclarationPath(importer) && MODULE_EXTENSIONS.has(extname(base))) {
    candidates.push(`${base.slice(0, -extname(base).length)}${DECLARATION_EXTENSION}`);
  }
  if (!extname(base)) {
    for (const extension of RESOLVABLE_EXTENSIONS) candidates.push(`${base}${extension}`);
    for (const extension of RESOLVABLE_EXTENSIONS) candidates.push(join(base, `index${extension}`));
  }
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const repoPath = normalizeRepoPath(relative(root, candidate).split(sep).join('/'), 'resolved runtime dependency');
    containedRegularFile(root, repoPath, `runtime dependency ${importer} -> ${specifier}`);
    return repoPath;
  }
  fail(`reachable generated runtime module is missing: ${importer} -> ${specifier}`);
}

function collectRuntimeClosure(root, initialPaths, standaloneBundles) {
  const requiredPaths = new Set();
  const queue = [...initialPaths].sort(comparePaths);
  while (queue.length > 0) {
    const repoPath = queue.shift();
    if (requiredPaths.has(repoPath)) continue;
    if (isGeneratedPath(repoPath) && isTestOrFixturePath(repoPath)) {
      fail(`generated test or fixture cannot enter runtime closure: ${repoPath}`);
    }
    const file = containedRegularFile(root, repoPath);
    requiredPaths.add(repoPath);
    const source = readFileSync(file.absolutePath, 'utf8');

    if (isModulePath(repoPath) || isDeclarationPath(repoPath)) {
      const references = moduleReferences(source, repoPath);
      for (const generatedPath of references.generated) {
        if (!requiredPaths.has(generatedPath)) queue.push(generatedPath);
      }
      if (!standaloneBundles.has(repoPath)) {
        for (const specifier of references.local) {
          const dependency = resolveLocalReference(root, repoPath, specifier);
          if (!requiredPaths.has(dependency)) queue.push(dependency);
        }
      }
    }
    queue.sort(comparePaths);
  }
  return requiredPaths;
}

function validateCoordinatorHandshake(root, requiredPaths, packageJson, pluginJson) {
  const coordinator = 'bridge/claude-md-coordinator.cjs';
  if (!requiredPaths.has(coordinator)) fail(`required generated runtime file is missing: ${coordinator}`);
  const coordinatorFile = containedRegularFile(root, coordinator, 'coordinator artifact');
  const sourceFile = containedRegularFile(root, 'docs/CLAUDE.md', 'canonical coordinator source');
  requiredPaths.add('docs/CLAUDE.md');

  const result = spawnSync(process.execPath, [coordinatorFile.absolutePath, '--handshake'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    fail(`coordinator handshake is unavailable: ${detail}`);
  }
  const handshake = parseJson(result.stdout, 'coordinator handshake');
  if (!handshake || handshake.schemaVersion !== 1 || typeof handshake.engineVersion !== 'string'
    || typeof handshake.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(handshake.sourceSha256)) {
    fail('coordinator handshake response is invalid');
  }
  const sourceSha256 = createHash('sha256').update(readFileSync(sourceFile.absolutePath)).digest('hex');
  if (handshake.sourceSha256 !== sourceSha256) {
    fail(`coordinator source digest mismatch: ${coordinator} handshake does not match docs/CLAUDE.md`);
  }
  const versions = [packageJson.version, pluginJson.version].filter(value => typeof value === 'string');
  if (existsSync(join(root, '.claude-plugin', 'marketplace.json'))) {
    const marketplace = readJson(root, '.claude-plugin/marketplace.json');
    if (typeof marketplace.version === 'string') versions.push(marketplace.version);
    if (Array.isArray(marketplace.plugins)) {
      for (const plugin of marketplace.plugins) if (typeof plugin?.version === 'string') versions.push(plugin.version);
    }
  }
  if (versions.length === 0 || versions.some(version => version !== handshake.engineVersion)) {
    fail(`coordinator engine version mismatch: handshake ${handshake.engineVersion}; manifests ${versions.join(', ')}`);
  }
}

export function collectPluginRuntimeClosure(root = process.cwd(), {
  trustedPackageJson = null,
  trustedDirectoryCommit = null,
  presentTrustedDirectoryPayloads = false,
} = {}) {
  const packageJson = readJson(root, 'package.json');
  const { paths: manifestEntrypoints, pluginJson } = collectManifestEntrypoints(root);
  const declaredPackage = trustedPackageJson ?? packageJson;
  const { paths: declaredGeneratedPayloads, standaloneBundles } = collectDeclaredGeneratedPayloads(root, declaredPackage, {
    directoryCommit: trustedDirectoryCommit,
    presentAtRoot: presentTrustedDirectoryPayloads,
  });
  const initialPaths = new Set([
    ...manifestEntrypoints,
    ...collectPackagePublicEntrypoints(declaredPackage),
    ...declaredGeneratedPayloads,
  ]);
  const requiredPaths = collectRuntimeClosure(root, initialPaths, standaloneBundles);
  validateCoordinatorHandshake(root, requiredPaths, packageJson, pluginJson);
  return {
    generatedRoots: [...GENERATED_ROOTS],
    requiredPaths: [...requiredPaths].sort(comparePaths),
  };
}

function collectStatusPaths(root) {
  const entries = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).stdout.split('\0');
  const staged = new Set();
  const worktree = new Set();
  const untracked = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (entry.length < 4) fail('git status returned a malformed porcelain entry');
    const status = entry.slice(0, 2);
    const path = normalizeRepoPath(entry.slice(3), 'Git status path');
    if (status === '??') untracked.add(path);
    else {
      if (status[0] !== ' ') staged.add(path);
      if (status[1] !== ' ') worktree.add(path);
    }
    if (status[0] === 'R' || status[0] === 'C') {
      const original = entries[index + 1];
      if (!original) fail('git status returned a malformed rename entry');
      staged.add(normalizeRepoPath(original, 'Git status rename path'));
      index += 1;
    }
  }
  return { staged, worktree, untracked };
}

function collectIgnoredUntracked(root) {
  return new Set(gitNullPaths(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']));
}

function formatPaths(paths) {
  return [...paths].sort(comparePaths).join(', ');
}

export function buildStageArguments(paths) {
  const normalized = [...new Set(paths)].sort(comparePaths);
  if (normalized.length === 0) return null;
  return ['add', '-f', '--', ...normalized];
}

// This local maintainer diagnostic executes candidate runtime/coordinator content.
// It is never an authorization check for pull requests.
function requireCheckPrBase(root, base) {
  if (typeof base !== 'string' || !/^[0-9a-f]{40}$/i.test(base)) {
    fail('check-pr base must be a 40-character hexadecimal commit SHA');
  }
  const baseCommit = git(root, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { allowFailure: true });
  if (baseCommit.status !== 0) fail(`check-pr base commit is not available: ${base}`);
  const head = git(root, ['rev-parse', 'HEAD']).stdout.trim().toLowerCase();
  const mergeBaseResult = git(root, ['merge-base', '--all', baseCommit.stdout.trim(), head], { allowFailure: true });
  const mergeBases = mergeBaseResult.status === 0
    ? mergeBaseResult.stdout.trim().split(/\s+/).filter(Boolean)
    : [];
  if (mergeBases.length === 0) fail('check-pr has no common merge base with HEAD');
  if (mergeBases.length !== 1) fail(`check-pr has ambiguous merge bases: ${mergeBases.length}`);
  const mergeBase = git(root, ['rev-parse', '--verify', '--quiet', `${mergeBases[0]}^{commit}`], { allowFailure: true });
  if (mergeBase.status !== 0) fail('check-pr merge base commit is not available');
  const canonicalMergeBase = mergeBase.stdout.trim().toLowerCase();
  const baseAncestor = git(root, ['merge-base', '--is-ancestor', canonicalMergeBase, baseCommit.stdout.trim()], { allowFailure: true });
  if (baseAncestor.status !== 0) fail('check-pr merge base is not an ancestor of the supplied base');
  const headAncestor = git(root, ['merge-base', '--is-ancestor', canonicalMergeBase, head], { allowFailure: true });
  if (headAncestor.status !== 0) fail('check-pr merge base is not an ancestor of HEAD');
  return canonicalMergeBase;
}

function requiredGeneratedPaths(surface) {
  return surface.requiredPaths.filter(path => isGeneratedPath(path));
}

function trackedPathsAtHead(root, paths) {
  if (paths.length === 0) return new Set();
  return new Set(gitNullPaths(root, ['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', ...paths]));
}

function collectRuntimeClosureAtCommit(root, commit) {
  const snapshot = mkdtempSync(join(tmpdir(), 'omc-plugin-shipping-surface-'));
  rmSync(snapshot, { recursive: true, force: true });
  try {
    git(root, ['worktree', 'add', '--detach', snapshot, commit]);
    return collectPluginRuntimeClosure(snapshot);
  } finally {
    git(root, ['worktree', 'remove', '--force', snapshot], { allowFailure: true });
    rmSync(snapshot, { recursive: true, force: true });
  }
}

function changedGeneratedPathsSince(root, base) {
  return gitNullPaths(root, ['diff', '--name-only', '-z', '--no-renames', base, 'HEAD', '--', ...GENERATED_ROOTS]);
}

function deletedGeneratedPathsSince(root, base) {
  return gitNullPaths(root, ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=D', base, 'HEAD', '--', ...GENERATED_ROOTS]);
}

function cachedGeneratedPaths(root) {
  return gitNullPaths(root, ['diff', '--cached', '--name-only', '-z', '--', ...GENERATED_ROOTS]);
}

export function inspectPullRequestShippingSurface(root, base) {
  const verifiedBase = requireCheckPrBase(root, base);
  if (git(root, ['status', '--porcelain=v1', '--untracked-files=all']).stdout.trim()) {
    fail('check-pr requires a clean checkout of the exact HEAD commit');
  }
  const trustedPackageJson = readJsonAtCommit(root, verifiedBase, 'package.json');
  const surface = collectPluginRuntimeClosure(root, {
    trustedPackageJson,
    trustedDirectoryCommit: verifiedBase,
    presentTrustedDirectoryPayloads: true,
  });
  const requiredGenerated = requiredGeneratedPaths(surface);
  const trackedAtHead = trackedPathsAtHead(root, requiredGenerated);
  const missingTrackedPaths = requiredGenerated.filter(path => !trackedAtHead.has(path));
  if (missingTrackedPaths.length > 0) {
    fail(`required generated runtime artifacts are not tracked at HEAD: ${formatPaths(missingTrackedPaths)}`);
  }
  const changedGeneratedPaths = changedGeneratedPathsSince(root, verifiedBase);
  const deletedGeneratedPaths = deletedGeneratedPathsSince(root, verifiedBase);
  const required = new Set(requiredGenerated);
  const previousGenerated = deletedGeneratedPaths.length > 0
    ? new Set(requiredGeneratedPaths(collectRuntimeClosureAtCommit(root, verifiedBase)))
    : new Set();
  const outOfClosurePaths = changedGeneratedPaths.filter(path => !required.has(path)
    && !(previousGenerated.has(path) && !trackedPathsAtHead(root, [path]).has(path)));
  if (outOfClosurePaths.length > 0) {
    fail(`pull request changes generated artifacts outside the runtime closure: ${formatPaths(outOfClosurePaths)}`);
  }
  return { ...surface, base: verifiedBase, changedGeneratedPaths: [...new Set(changedGeneratedPaths)].sort(comparePaths) };
}

export function inspectPluginShippingSurface(root = process.cwd()) {
  const surface = collectPluginRuntimeClosure(root);
  const required = new Set(surface.requiredPaths);
  const ignoredUntracked = collectIgnoredUntracked(root);
  const status = collectStatusPaths(root);
  const allChanged = new Set([...status.staged, ...status.worktree, ...status.untracked, ...ignoredUntracked]);
  const ignoredUntrackedRequiredPaths = [...ignoredUntracked].filter(path => required.has(path));
  const stagePaths = [...required].filter(path => isGeneratedPath(path) && allChanged.has(path));
  const unrelatedGeneratedExtras = new Set([
    ...[...status.staged, ...status.worktree].filter(path => isGeneratedPath(path) && isRuntimeArtifactCandidate(path) && !required.has(path)),
    ...[...new Set([...status.untracked, ...ignoredUntracked])].filter(path => isGeneratedPath(path) && isRuntimeArtifactCandidate(path) && !required.has(path)),
  ]);
  return {
    ...surface,
    ignoredUntrackedRequiredPaths: ignoredUntrackedRequiredPaths.sort(comparePaths),
    stagePaths: stagePaths.sort(comparePaths),
    changedGeneratedPaths: [...allChanged].filter(path => isGeneratedPath(path) && isRuntimeArtifactCandidate(path)).sort(comparePaths),
    unrelatedGeneratedExtras: [...unrelatedGeneratedExtras].sort(comparePaths),
  };
}

function verify(root) {
  const surface = inspectPluginShippingSurface(root);
  const waiting = surface.ignoredUntrackedRequiredPaths.length;
  console.log(`plugin shipping surface verified: ${surface.requiredPaths.length} required runtime artifact(s); ${waiting} ignored-and-untracked artifact(s) await staging.`);
  if (waiting > 0) console.log(`plugin shipping surface ignored-and-untracked: ${surface.ignoredUntrackedRequiredPaths.join(', ')}`);
  return surface;
}

function checkPullRequest(root, base) {
  const surface = inspectPullRequestShippingSurface(root, base);
  console.log(`plugin shipping surface PR check verified: ${surface.requiredPaths.length} required runtime artifact(s); ${surface.changedGeneratedPaths.length} generated artifact change(s) since ${surface.base}.`);
}

function stage(root) {
  const surface = verify(root);
  const deletedGeneratedPaths = surface.changedGeneratedPaths.filter(path => !existsSync(join(root, path)));
  const previousGenerated = deletedGeneratedPaths.length > 0
    ? new Set(requiredGeneratedPaths(collectRuntimeClosureAtCommit(root, 'HEAD')))
    : new Set();
  const deletedPreviousClosurePaths = deletedGeneratedPaths.filter(path => previousGenerated.has(path));
  const allowedDeleted = new Set(deletedPreviousClosurePaths);
  const unrelatedGeneratedExtras = surface.unrelatedGeneratedExtras.filter(path => !allowedDeleted.has(path));
  if (unrelatedGeneratedExtras.length > 0) {
    fail(`refusing to stage unrelated generated artifacts: ${formatPaths(unrelatedGeneratedExtras)}`);
  }
  const stagePaths = [...new Set([...surface.stagePaths, ...deletedPreviousClosurePaths])].sort(comparePaths);
  const args = buildStageArguments(stagePaths);
  if (args) {
    const result = spawnSync('git', args, { cwd: root, stdio: 'inherit' });
    if (result.error) fail(`git ${args.join(' ')} could not start: ${result.error.message}`);
    if (result.status !== 0) fail(`git ${args.join(' ')} failed with exit ${result.status}`);
  }
  const expected = new Set(stagePaths);
  const cached = cachedGeneratedPaths(root);
  const unexpected = cached.filter(path => !expected.has(path));
  const missing = [...expected].filter(path => !cached.includes(path));
  if (unexpected.length > 0 || missing.length > 0) {
    fail(`staged generated delta is not exact; unexpected: ${formatPaths(unexpected) || 'none'}; missing: ${formatPaths(missing) || 'none'}`);
  }
  if (!args) console.log('plugin shipping surface: no generated runtime artifacts need staging.');
  else console.log(`plugin shipping surface staged: ${stagePaths.join(', ')}`);
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'verify' && args.length === 0) verify(process.cwd());
  else if (command === 'stage' && args.length === 0) stage(process.cwd());
  else if (command === 'check-pr' && args.length === 2 && args[0] === '--base') checkPullRequest(process.cwd(), args[1]);
  else fail('usage: node scripts/plugin-shipping-surface.mjs <verify|stage|check-pr --base <sha>>');
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(`plugin shipping surface: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
