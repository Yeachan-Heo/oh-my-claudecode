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
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const GENERATED_ROOTS = Object.freeze(['dist', 'bridge']);
const MODULE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);
const RESOLVABLE_EXTENSIONS = ['.js', '.cjs', '.mjs', '.json'];
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

function isTestOrFixturePath(repoPath) {
  const segments = repoPath.split('/');
  const fileName = segments.at(-1) ?? '';
  return segments.some(segment => segment === '__tests__' || segment === 'tests' || segment === 'fixtures')
    || /\.(?:test|spec)\.[cm]?js$/.test(fileName);
}

function isRuntimeArtifactCandidate(repoPath) {
  return (isModulePath(repoPath) || repoPath.endsWith('.py') || repoPath.endsWith('.sh'))
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

function collectDeclaredGeneratedPayloads(packageJson) {
  if (!Array.isArray(packageJson.files)) fail('package.json files must be an array');
  const paths = new Set();
  for (const value of packageJson.files) {
    if (typeof value !== 'string') fail('package.json files entries must be strings');
    const repoPath = normalizeRepoPath(value, 'package.json files entry');
    if (isGeneratedPath(repoPath) && extname(repoPath)) paths.add(repoPath);
  }
  return paths;
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

function generatedJoinPath(node) {
  if (!ts.isCallExpression(node)) return null;
  const expression = node.expression;
  const name = ts.isIdentifier(expression)
    ? expression.text
    : ts.isPropertyAccessExpression(expression)
      ? expression.name.text
      : '';
  if (name !== 'join' && name !== 'resolve') return null;
  const parts = node.arguments.map(argument =>
    ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument) ? argument.text : null,
  );
  const rootIndex = parts.findIndex(part => part === 'dist' || part === 'bridge');
  if (rootIndex < 0 || parts.slice(rootIndex).some(part => part === null)) return null;
  const repoPath = parts.slice(rootIndex).join('/');
  return extname(repoPath) ? normalizeRepoPath(repoPath, 'computed generated runtime path') : null;
}

function containsGeneratedJoin(node) {
  let found = false;
  const visit = current => {
    if (generatedJoinPath(current)) found = true;
    else if (!found) ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function containsStaticLocalUrl(node) {
  let found = false;
  const visit = current => {
    if (ts.isNewExpression(current)
      && ts.isIdentifier(current.expression)
      && current.expression.text === 'URL'
      && current.arguments?.length
      && (ts.isStringLiteral(current.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(current.arguments[0]))
      && (current.arguments[0].text.startsWith('./') || current.arguments[0].text.startsWith('../'))) {
      found = true;
    } else if (!found) {
      ts.forEachChild(current, visit);
    }
  };
  visit(node);
  return found;
}

function containsPotentialLocalReference(node) {
  let found = false;
  const visit = current => {
    if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
      if (current.text.startsWith('./') || current.text.startsWith('../') || current.text === 'dist' || current.text === 'bridge') found = true;
    }
    if (!found) ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function moduleReferences(source, repoPath) {
  const sourceFile = ts.createSourceFile(repoPath, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  if (sourceFile.parseDiagnostics.length > 0) {
    const diagnostic = sourceFile.parseDiagnostics[0];
    fail(`cannot parse runtime module ${repoPath}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`);
  }

  const local = new Set();
  const generated = new Set();
  const aliases = new Map();
  const collectAliases = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer))
      && (node.initializer.text.startsWith('./') || node.initializer.text.startsWith('../'))) {
      aliases.set(node.name.text, node.initializer.text);
    }
    ts.forEachChild(node, collectAliases);
  };
  collectAliases(sourceFile);

  const addLocal = node => {
    if (!node) return false;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (node.text.startsWith('./') || node.text.startsWith('../')) {
        local.add(node.text);
        return true;
      }
      return false;
    }
    if (ts.isIdentifier(node) && aliases.has(node.text)) {
      local.add(aliases.get(node.text));
      return true;
    }
    return false;
  };
  const visit = node => {
    const generatedPath = generatedJoinPath(node);
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
        if (!addLocal(argument) && argument && containsPotentialLocalReference(argument)
          && !containsGeneratedJoin(argument) && !containsStaticLocalUrl(argument)) {
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

    if (isModulePath(repoPath)) {
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

export function collectPluginRuntimeClosure(root = process.cwd(), { trustedPackageJson = null } = {}) {
  const packageJson = readJson(root, 'package.json');
  const { paths: manifestEntrypoints, pluginJson } = collectManifestEntrypoints(root);
  const declaredPackage = trustedPackageJson ?? packageJson;
  const declaredGeneratedPayloads = collectDeclaredGeneratedPayloads(declaredPackage);
  const initialPaths = new Set([
    ...manifestEntrypoints,
    ...collectPackageBinEntrypoints(declaredPackage),
    ...declaredGeneratedPayloads,
  ]);
  const standaloneBundles = new Set(
    [...declaredGeneratedPayloads].filter(path => isWithin(path, 'bridge') && isModulePath(path)),
  );
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

function requireCheckPrBase(root, base) {
  if (typeof base !== 'string' || !/^[0-9a-f]{40}$/i.test(base)) {
    fail('check-pr base must be a 40-character hexadecimal commit SHA');
  }
  const result = git(root, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { allowFailure: true });
  if (result.status !== 0) fail(`check-pr base commit is not available: ${base}`);
  const head = git(root, ['rev-parse', 'HEAD']).stdout.trim().toLowerCase();
  const normalized = base.toLowerCase();
  if (normalized === head) fail('check-pr base must differ from HEAD');
  const ancestor = git(root, ['merge-base', '--is-ancestor', normalized, head], { allowFailure: true });
  if (ancestor.status !== 0) fail(`check-pr base is not an ancestor of HEAD: ${base}`);
  return normalized;
}

function requiredGeneratedPaths(surface) {
  return surface.requiredPaths.filter(path => isGeneratedPath(path));
}

function trackedPathsAtHead(root, paths) {
  if (paths.length === 0) return new Set();
  return new Set(gitNullPaths(root, ['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', ...paths]));
}

function changedGeneratedPathsSince(root, base) {
  return gitNullPaths(root, ['diff', '--name-only', '-z', '--no-renames', base, 'HEAD', '--', ...GENERATED_ROOTS]);
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
  const surface = collectPluginRuntimeClosure(root, { trustedPackageJson });
  const requiredGenerated = requiredGeneratedPaths(surface);
  const trackedAtHead = trackedPathsAtHead(root, requiredGenerated);
  const missingTrackedPaths = requiredGenerated.filter(path => !trackedAtHead.has(path));
  if (missingTrackedPaths.length > 0) {
    fail(`required generated runtime artifacts are not tracked at HEAD: ${formatPaths(missingTrackedPaths)}`);
  }
  const changedGeneratedPaths = changedGeneratedPathsSince(root, verifiedBase);
  const required = new Set(requiredGenerated);
  const outOfClosurePaths = changedGeneratedPaths.filter(path => !required.has(path));
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
    ...[...new Set([...status.untracked, ...ignoredUntracked])].filter(path => isWithin(path, 'bridge') && isRuntimeArtifactCandidate(path) && !required.has(path)),
  ]);
  return {
    ...surface,
    ignoredUntrackedRequiredPaths: ignoredUntrackedRequiredPaths.sort(comparePaths),
    stagePaths: stagePaths.sort(comparePaths),
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
  if (surface.unrelatedGeneratedExtras.length > 0) {
    fail(`refusing to stage unrelated generated artifacts: ${formatPaths(surface.unrelatedGeneratedExtras)}`);
  }
  const args = buildStageArguments(surface.stagePaths);
  if (args) {
    const result = spawnSync('git', args, { cwd: root, stdio: 'inherit' });
    if (result.error) fail(`git ${args.join(' ')} could not start: ${result.error.message}`);
    if (result.status !== 0) fail(`git ${args.join(' ')} failed with exit ${result.status}`);
  }
  const expected = new Set(surface.stagePaths);
  const cached = cachedGeneratedPaths(root);
  const unexpected = cached.filter(path => !expected.has(path));
  const missing = [...expected].filter(path => !cached.includes(path));
  if (unexpected.length > 0 || missing.length > 0) {
    fail(`staged generated delta is not exact; unexpected: ${formatPaths(unexpected) || 'none'}; missing: ${formatPaths(missing) || 'none'}`);
  }
  if (!args) console.log('plugin shipping surface: no generated runtime artifacts need staging.');
  else console.log(`plugin shipping surface staged: ${surface.stagePaths.join(', ')}`);
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
