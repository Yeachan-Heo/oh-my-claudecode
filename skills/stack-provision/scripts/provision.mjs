#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, readJsonValidated, validateData, writeJson, writeJsonValidated } from './validation.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const skillDir = resolve(scriptDir, '..');
const projectRoot = resolve(skillDir, '..', '..');
const defaultConfigPath = join(skillDir, 'config', 'default-capability-packs.json');
const maxSkillFiles = 1500;
const defaultTimeoutMs = 5000;
const batchApprovalSources = new Set(['installed-skill', 'bundled-skill']);
const infoRiskFlags = new Set(['already-installed-local-copy']);
const criticalRiskFlags = new Set([
  'prompt-authority-override',
  'hidden-network-behavior',
  'hardcoded-secret',
]);

try {
  const result = await run(process.argv.slice(2));
  emit(result);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function run(argv) {
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') {
    return usage();
  }

  const runDirArg = argv[1];
  if (!runDirArg || runDirArg.startsWith('--')) {
    throw new Error(`stack-provision: ${command} requires <run-dir>`);
  }

  const options = parseArgs(argv.slice(2));
  const runDir = resolve(runDirArg);

  if (command === 'discover') {
    return discover(runDir, options);
  }
  if (command === 'review') {
    return review(runDir, options);
  }
  if (command === 'promote') {
    return promote(runDir, options);
  }
  if (command === 'rollback') {
    return rollback(runDir, options);
  }
  if (command === 'verify') {
    return verify(runDir, options);
  }

  throw new Error(`stack-provision: unknown command "${command}"`);
}

function parseArgs(argv) {
  const options = {
    json: false,
    dryRun: false,
    network: false,
    timeoutMs: defaultTimeoutMs,
    configPath: defaultConfigPath,
    projectRoot,
    sources: [],
    installedRoots: [],
    bundledRoots: [],
    pluginRoots: [],
    skillsShIndex: '',
    pluginMarketplaceIndex: '',
    githubIndex: '',
    githubOrgs: [],
    limit: 250,
    approveIds: [],
    approveSources: [],
    approveLocal: false,
    reject: false,
    approvedBy: process.env.USER || 'unknown',
    skillRoot: '',
    manifestPath: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--network') {
      options.network = true;
    } else if (arg.startsWith('--timeout-ms=')) {
      options.timeoutMs = Number(arg.slice('--timeout-ms='.length));
    } else if (arg === '--timeout-ms') {
      index += 1;
      options.timeoutMs = Number(requireValue(argv[index], '--timeout-ms'));
    } else if (arg.startsWith('--limit=')) {
      options.limit = Number(arg.slice('--limit='.length));
    } else if (arg === '--limit') {
      index += 1;
      options.limit = Number(requireValue(argv[index], '--limit'));
    } else if (arg.startsWith('--config=')) {
      options.configPath = arg.slice('--config='.length);
    } else if (arg === '--config') {
      index += 1;
      options.configPath = requireValue(argv[index], '--config');
    } else if (arg.startsWith('--project-root=')) {
      options.projectRoot = resolve(arg.slice('--project-root='.length));
    } else if (arg === '--project-root') {
      index += 1;
      options.projectRoot = resolve(requireValue(argv[index], '--project-root'));
    } else if (arg.startsWith('--sources=')) {
      options.sources = splitList(arg.slice('--sources='.length));
    } else if (arg === '--sources') {
      index += 1;
      options.sources = splitList(requireValue(argv[index], '--sources'));
    } else if (arg.startsWith('--installed-root=')) {
      options.installedRoots.push(resolve(arg.slice('--installed-root='.length)));
    } else if (arg === '--installed-root') {
      index += 1;
      options.installedRoots.push(resolve(requireValue(argv[index], '--installed-root')));
    } else if (arg.startsWith('--bundled-root=')) {
      options.bundledRoots.push(resolve(arg.slice('--bundled-root='.length)));
    } else if (arg === '--bundled-root') {
      index += 1;
      options.bundledRoots.push(resolve(requireValue(argv[index], '--bundled-root')));
    } else if (arg.startsWith('--plugin-root=')) {
      options.pluginRoots.push(resolve(arg.slice('--plugin-root='.length)));
    } else if (arg === '--plugin-root') {
      index += 1;
      options.pluginRoots.push(resolve(requireValue(argv[index], '--plugin-root')));
    } else if (arg.startsWith('--skills-sh-index=')) {
      options.skillsShIndex = arg.slice('--skills-sh-index='.length);
    } else if (arg === '--skills-sh-index') {
      index += 1;
      options.skillsShIndex = requireValue(argv[index], '--skills-sh-index');
    } else if (arg.startsWith('--plugin-marketplace-index=')) {
      options.pluginMarketplaceIndex = arg.slice('--plugin-marketplace-index='.length);
    } else if (arg === '--plugin-marketplace-index') {
      index += 1;
      options.pluginMarketplaceIndex = requireValue(argv[index], '--plugin-marketplace-index');
    } else if (arg.startsWith('--github-index=')) {
      options.githubIndex = arg.slice('--github-index='.length);
    } else if (arg === '--github-index') {
      index += 1;
      options.githubIndex = requireValue(argv[index], '--github-index');
    } else if (arg.startsWith('--github-org=')) {
      options.githubOrgs.push(arg.slice('--github-org='.length));
    } else if (arg === '--github-org') {
      index += 1;
      options.githubOrgs.push(requireValue(argv[index], '--github-org'));
    } else if (arg.startsWith('--approve=')) {
      options.approveIds = splitList(arg.slice('--approve='.length));
    } else if (arg === '--approve') {
      index += 1;
      options.approveIds = splitList(requireValue(argv[index], '--approve'));
    } else if (arg.startsWith('--approve-source=')) {
      options.approveSources = splitList(arg.slice('--approve-source='.length));
    } else if (arg === '--approve-source') {
      index += 1;
      options.approveSources = splitList(requireValue(argv[index], '--approve-source'));
    } else if (arg === '--approve-local') {
      options.approveLocal = true;
    } else if (arg === '--reject') {
      options.reject = true;
    } else if (arg.startsWith('--approved-by=')) {
      options.approvedBy = arg.slice('--approved-by='.length);
    } else if (arg === '--approved-by') {
      index += 1;
      options.approvedBy = requireValue(argv[index], '--approved-by');
    } else if (arg.startsWith('--skill-root=')) {
      options.skillRoot = resolve(arg.slice('--skill-root='.length));
    } else if (arg === '--skill-root') {
      index += 1;
      options.skillRoot = resolve(requireValue(argv[index], '--skill-root'));
    } else if (arg.startsWith('--manifest=')) {
      options.manifestPath = resolve(arg.slice('--manifest='.length));
    } else if (arg === '--manifest') {
      index += 1;
      options.manifestPath = resolve(requireValue(argv[index], '--manifest'));
    } else {
      throw new Error(`stack-provision: unknown option ${arg}`);
    }
  }

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 100) {
    throw new Error('stack-provision: --timeout-ms must be a number >= 100');
  }
  if (!Number.isFinite(options.limit) || options.limit < 1) {
    throw new Error('stack-provision: --limit must be a number >= 1');
  }

  return options;
}

async function discover(runDir, options) {
  const run = readRun(runDir);
  const config = readJsonValidated(resolve(options.configPath), 'config', options.configPath);
  const selectedSources = options.sources.length > 0
    ? options.sources
    : ['installed', 'bundled', 'plugin', 'skills-sh', 'plugin-marketplace', 'github'];
  const warnings = [];
  const allCandidates = [];

  for (const source of selectedSources) {
    if (source === 'installed') {
      allCandidates.push(...discoverLocalSkills({
        source: 'installed-skill',
        roots: defaultInstalledRoots(options),
        run,
        config,
        warnings,
        maxDepth: 6,
      }));
    } else if (source === 'bundled') {
      allCandidates.push(...discoverLocalSkills({
        source: 'bundled-skill',
        roots: defaultBundledRoots(options),
        run,
        config,
        warnings,
        maxDepth: 3,
      }));
    } else if (source === 'plugin') {
      allCandidates.push(...discoverLocalSkills({
        source: 'plugin-skill',
        roots: defaultPluginRoots(options),
        run,
        config,
        warnings,
        maxDepth: 8,
      }));
    } else if (source === 'skills-sh') {
      allCandidates.push(...await discoverIndexSource({
        source: 'skills-sh',
        index: options.skillsShIndex,
        run,
        config,
        warnings,
        network: options.network,
        timeoutMs: options.timeoutMs,
        fallbackSearch: (technology) => `https://skills.sh/api/search?q=${encodeURIComponent(technology)}`,
      }));
    } else if (source === 'plugin-marketplace') {
      allCandidates.push(...await discoverIndexSource({
        source: 'plugin-marketplace',
        index: options.pluginMarketplaceIndex,
        run,
        config,
        warnings,
        network: options.network,
        timeoutMs: options.timeoutMs,
        fallbackSearch: null,
      }));
    } else if (source === 'github') {
      allCandidates.push(...await discoverGithub({
        index: options.githubIndex,
        orgs: options.githubOrgs,
        run,
        config,
        warnings,
        network: options.network,
        timeoutMs: options.timeoutMs,
      }));
    } else {
      warnings.push(`unknown source skipped: ${source}`);
    }
  }

  const candidates = dedupeCandidates(allCandidates)
    .sort((a, b) => b.score - a.score || a.candidate_id.localeCompare(b.candidate_id))
    .slice(0, options.limit);
  const coverage = buildCoverage(run.matrix, candidates);
  const candidatesDoc = {
    schema_version: 1,
    run_id: run.contract.run_id,
    created_at: now(),
    sources: selectedSources,
    warnings,
    candidates,
  };

  writeJsonValidated(join(runDir, 'candidates.json'), candidatesDoc, 'candidates');
  writeJsonValidated(join(runDir, 'coverage.json'), coverage, 'coverage');
  writeJson(join(runDir, 'state.json'), {
    ...run.state,
    status: 'discovered',
    current_phase: 'discovery',
    updated_at: now(),
    artifacts: {
      ...(run.state.artifacts || {}),
      candidates: join(runDir, 'candidates.json'),
      coverage: join(runDir, 'coverage.json'),
    },
  });

  return {
    json: options.json,
    command: 'discover',
    run_id: run.contract.run_id,
    candidates: candidates.length,
    coverage_summary: coverage.summary,
    warnings,
    artifacts: {
      candidates: join(runDir, 'candidates.json'),
      coverage: join(runDir, 'coverage.json'),
    },
  };
}

function discoverLocalSkills({ source, roots, run, config, warnings, maxDepth }) {
  const candidates = [];
  for (const root of roots) {
    if (!existsSync(root)) {
      warnings.push(`${source} root not found: ${root}`);
      continue;
    }

    for (const skillFile of findSkillFiles(root, maxDepth)) {
      const candidate = localSkillCandidate(source, root, skillFile, run, config);
      if (candidate) {
        candidates.push(candidate);
      }
    }
  }
  return candidates;
}

function localSkillCandidate(source, root, skillFile, run, config) {
  const content = readFileSync(skillFile, 'utf8');
  const metadata = parseFrontmatter(content);
  const slug = sanitizeSlug(metadata.name || basename(dirname(skillFile)));
  const description = metadata.description || firstNonEmptyLine(content) || slug;
  const text = `${slug}\n${description}\n${content.slice(0, 12000)}`.toLowerCase();
  const coverage = scoreCoverage(text, slug, run.matrix.cells, config);

  if (coverage.covered_cells.length === 0) {
    return null;
  }

  const hash = sha256(content);
  return {
    candidate_id: stableId(source, `${relative(root, skillFile)}:${hash}`),
    source,
    title: metadata.name || slug,
    slug,
    summary: description,
    url: null,
    path: skillFile,
    install_target: `${slug}/SKILL.md`,
    covered_surface: unique(coverage.covered_cells.map((cell) => cell.surface)),
    covered_technology: unique(coverage.covered_cells.map((cell) => cell.technology)),
    covered_aspects: unique(coverage.covered_cells.map((cell) => cell.aspect)),
    covered_cells: coverage.covered_cells,
    risk_flags: localRiskFlags(source, skillFile),
    sha256: hash,
    score: coverage.score,
    install: {
      kind: 'copy-skill',
      source_path: skillFile,
      target_slug: slug,
    },
  };
}

async function discoverIndexSource({ source, index, run, config, warnings, network, timeoutMs, fallbackSearch }) {
  if (index) {
    const entries = await readIndexEntries(index, timeoutMs);
    return normalizeExternalEntries(source, entries, run, config);
  }

  if (!network || !fallbackSearch) {
    warnings.push(`${source} skipped: provide --${source === 'skills-sh' ? 'skills-sh-index' : 'plugin-marketplace-index'} or --network`);
    return [];
  }

  const entries = [];
  for (const technology of run.contract.stack) {
    try {
      entries.push(...await fetchJsonEntries(fallbackSearch(technology), timeoutMs));
    } catch (error) {
      warnings.push(`${source} network search failed for ${technology}: ${errorMessage(error)}`);
    }
  }
  return normalizeExternalEntries(source, entries, run, config);
}

async function discoverGithub({ index, orgs, run, config, warnings, network, timeoutMs }) {
  if (index) {
    const entries = await readIndexEntries(index, timeoutMs);
    return normalizeExternalEntries('github', entries, run, config);
  }

  if (!network) {
    warnings.push('github skipped: provide --github-index or --network');
    return [];
  }

  const entries = [];
  for (const technology of run.contract.stack) {
    const orgQuery = orgs.map((org) => `org:${org}`).join(' ');
    const query = `${technology} claude skill SKILL.md ${orgQuery}`.trim();
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=5`;
    try {
      const payload = await fetchJson(url, timeoutMs);
      const items = Array.isArray(payload.items) ? payload.items : [];
      for (const item of items) {
        entries.push({
          name: item.full_name || item.name,
          description: item.description || '',
          url: item.html_url,
          stars: item.stargazers_count,
          last_updated: item.updated_at,
          source: 'github',
          tags: [technology],
        });
      }
    } catch (error) {
      warnings.push(`github search failed for ${technology}: ${errorMessage(error)}`);
    }
  }
  return normalizeExternalEntries('github', entries, run, config);
}

function normalizeExternalEntries(source, entries, run, config) {
  const candidates = [];
  for (const entry of entries) {
    const slug = sanitizeSlug(entry.slug || entry.name || entry.ref || entry.url || source);
    const description = String(entry.description || entry.summary || '');
    const text = [
      slug,
      entry.name,
      entry.title,
      description,
      entry.url,
      entry.ref,
      ...(Array.isArray(entry.tags) ? entry.tags : []),
      ...(Array.isArray(entry.keywords) ? entry.keywords : []),
    ].filter(Boolean).join('\n').toLowerCase();
    const coverage = scoreCoverage(text, slug, run.matrix.cells, config);
    if (coverage.covered_cells.length === 0) {
      continue;
    }

    const install = externalInstall(source, entry, slug);
    const candidateBody = JSON.stringify({ source, entry, install });
    const candidateHash = install.kind === 'copy-skill' && install.source_path && existsSync(install.source_path)
      ? sha256(readFileSync(install.source_path, 'utf8'))
      : sha256(candidateBody);
    candidates.push({
      candidate_id: stableId(source, `${slug}:${candidateHash}`),
      source,
      title: entry.title || entry.name || slug,
      slug,
      summary: description || entry.url || slug,
      url: entry.url || null,
      path: entry.content_path ? resolve(entry.content_path) : null,
      install_target: install.target || null,
      covered_surface: unique(coverage.covered_cells.map((cell) => cell.surface)),
      covered_technology: unique(coverage.covered_cells.map((cell) => cell.technology)),
      covered_aspects: unique(coverage.covered_cells.map((cell) => cell.aspect)),
      covered_cells: coverage.covered_cells,
      risk_flags: externalRiskFlags(source, entry, install),
      sha256: candidateHash,
      score: coverage.score,
      install,
    });
  }
  return candidates;
}

function externalInstall(source, entry, slug) {
  if (entry.content_path) {
    return {
      kind: 'copy-skill',
      source_path: resolve(entry.content_path),
      target_slug: slug,
    };
  }
  if (entry.skill_md_url) {
    return {
      kind: 'download-skill',
      source_url: entry.skill_md_url,
      target_slug: slug,
    };
  }
  if (source === 'plugin-marketplace') {
    return {
      kind: 'plugin-install',
      command: entry.install_cmd || `/plugin install ${entry.ref || entry.slug || slug}`,
      target: entry.ref || slug,
    };
  }
  return {
    kind: 'external-command',
    command: entry.install_cmd || entry.command || `review manually: ${entry.url || slug}`,
    target: slug,
  };
}

function review(runDir, options) {
  const run = readRun(runDir);
  const candidatesDoc = readJsonValidated(join(runDir, 'candidates.json'), 'candidates');
  const candidates = candidatesDoc.candidates || [];
  const planItems = candidates.map((candidate) => ({
    candidate_id: candidate.candidate_id,
    candidate_hash: candidate.sha256,
    source: candidate.source,
    slug: candidate.slug,
    title: candidate.title,
    install: candidate.install,
    risk_flags: candidate.risk_flags || [],
  }));
  const installPlan = {
    schema_version: 1,
    run_id: run.contract.run_id,
    created_at: now(),
    items: planItems,
    hash: sha256(JSON.stringify(planItems)),
  };
  const approvalSelection = selectApprovals(candidates, options);
  const approvedIds = approvalSelection.approvedIds;
  const approvedItems = options.reject
    ? []
    : candidates
      .filter((candidate) => approvedIds.has(candidate.candidate_id))
      .map((candidate) => ({
        candidate_id: candidate.candidate_id,
        candidate_hash: candidate.sha256,
        decision: 'approve',
        reason: 'selected by stack-provision review command',
      }));
  const decision = {
    schema_version: 1,
    run_id: run.contract.run_id,
    install_plan_hash: installPlan.hash,
    approved_items: approvedItems,
    confirmation: {
      approved: approvedItems.length > 0 && !options.reject,
      approved_at: now(),
      approved_by: options.approvedBy,
    },
    approval_policy: approvalSelection.policy,
  };
  const reviewMarkdown = renderReviewMarkdown(run.contract, candidatesDoc, installPlan, decision);

  writeJsonValidated(join(runDir, 'install-plan.json'), installPlan, 'install-plan');
  writeJsonValidated(join(runDir, 'review-decision.json'), decision, 'review');
  writeFileSync(join(runDir, 'review.md'), reviewMarkdown, 'utf8');
  writeJson(join(runDir, 'state.json'), {
    ...run.state,
    status: decision.confirmation.approved ? 'reviewed' : 'review_required',
    current_phase: 'review',
    updated_at: now(),
    artifacts: {
      ...(run.state.artifacts || {}),
      install_plan: join(runDir, 'install-plan.json'),
      review_decision: join(runDir, 'review-decision.json'),
      review: join(runDir, 'review.md'),
    },
  });

  return {
    json: options.json,
    command: 'review',
    run_id: run.contract.run_id,
    candidates: candidates.length,
    approved: approvedItems.length,
    approved_ids: approvedItems.map((item) => item.candidate_id),
    install_plan_hash: installPlan.hash,
    artifacts: {
      install_plan: join(runDir, 'install-plan.json'),
      review_decision: join(runDir, 'review-decision.json'),
      review: join(runDir, 'review.md'),
    },
  };
}

async function promote(runDir, options) {
  const run = readRun(runDir);
  const candidatesDoc = readJsonValidated(join(runDir, 'candidates.json'), 'candidates');
  const installPlan = readJsonValidated(join(runDir, 'install-plan.json'), 'install-plan');
  const decision = readJsonValidated(join(runDir, 'review-decision.json'), 'review');

  if (!decision.confirmation?.approved) {
    throw new Error('stack-provision: review confirmation is not approved; promotion blocked');
  }
  if (installPlan.hash !== decision.install_plan_hash) {
    throw new Error('stack-provision: install plan hash mismatch; rerun review');
  }

  const computedHash = sha256(JSON.stringify(installPlan.items || []));
  if (computedHash !== installPlan.hash) {
    throw new Error('stack-provision: install plan content changed after review');
  }

  const skillRoot = options.skillRoot || join(homedir(), '.codex', 'skills', 'omc-provisioned');
  const candidateById = new Map((candidatesDoc.candidates || []).map((candidate) => [candidate.candidate_id, candidate]));
  const installed = [];
  const pendingUserActions = [];
  const rollbackOps = [];
  const errors = [];

  for (const approved of decision.approved_items || []) {
    const candidate = candidateById.get(approved.candidate_id);
    if (!candidate) {
      errors.push(`approved candidate not found: ${approved.candidate_id}`);
      continue;
    }
    if (candidate.sha256 !== approved.candidate_hash) {
      errors.push(`approved candidate hash mismatch: ${approved.candidate_id}`);
      continue;
    }

    try {
      const outcome = await promoteCandidate(candidate, runDir, skillRoot, options);
      if (outcome.installed) {
        installed.push(outcome.installed);
      }
      if (outcome.pending_user_action) {
        pendingUserActions.push(outcome.pending_user_action);
      }
      if (outcome.rollback) {
        rollbackOps.push(outcome.rollback);
      }
    } catch (error) {
      errors.push(`${candidate.candidate_id}: ${errorMessage(error)}`);
    }
  }

  const manifest = {
    schema_version: 1,
    run_id: run.contract.run_id,
    created_at: now(),
    status: errors.length > 0
      ? (installed.length > 0 || pendingUserActions.length > 0 ? 'partial' : 'failed')
      : (options.dryRun ? 'dry_run' : 'success'),
    installed,
    pending_user_actions: pendingUserActions,
    rollback: rollbackOps,
    errors,
  };

  const manifestPath = options.manifestPath || join(runDir, 'manifest.json');
  writeJsonValidated(manifestPath, manifest, 'manifest');
  writeJson(join(runDir, 'state.json'), {
    ...run.state,
    status: manifest.status,
    current_phase: 'promote',
    updated_at: now(),
    artifacts: {
      ...(run.state.artifacts || {}),
      manifest: manifestPath,
    },
  });

  return {
    json: options.json,
    command: 'promote',
    run_id: run.contract.run_id,
    status: manifest.status,
    installed: installed.length,
    pending_user_actions: pendingUserActions.length,
    errors,
    manifest: manifestPath,
  };
}

async function promoteCandidate(candidate, runDir, skillRoot, options) {
  const install = candidate.install || {};
  if (install.kind === 'copy-skill') {
    return copySkillCandidate(candidate, install.source_path, runDir, skillRoot, options);
  }
  if (install.kind === 'download-skill') {
    if (!options.network) {
      return pendingAction(candidate, `download and review ${install.source_url}`);
    }
    const content = await fetchText(install.source_url, options.timeoutMs);
    const tempSource = join(runDir, 'downloads', sanitizeSlug(candidate.slug), 'SKILL.md');
    mkdirSync(dirname(tempSource), { recursive: true });
    writeFileSync(tempSource, content, 'utf8');
    return copySkillCandidate(candidate, tempSource, runDir, skillRoot, options);
  }
  if (install.kind === 'plugin-install' || install.kind === 'external-command') {
    return pendingAction(candidate, install.command || `review manually: ${candidate.url || candidate.slug}`);
  }
  return pendingAction(candidate, `unsupported install kind: ${install.kind || 'unknown'}`);
}

function copySkillCandidate(candidate, sourcePath, runDir, skillRoot, options) {
  if (!sourcePath || !existsSync(sourcePath)) {
    throw new Error(`source skill file not found: ${sourcePath}`);
  }

  const content = readFileSync(sourcePath, 'utf8');
  const sourceHash = sha256(content);
  if (candidate.install?.kind === 'copy-skill' && candidate.sha256 !== sourceHash) {
    throw new Error('source content hash changed after discovery');
  }

  const targetSlug = sanitizeSlug(candidate.install?.target_slug || candidate.slug);
  const targetPath = join(skillRoot, targetSlug, 'SKILL.md');
  const backupPath = existsSync(targetPath)
    ? join(runDir, 'backups', targetSlug, `SKILL.${Date.now()}.bak.md`)
    : null;

  if (!options.dryRun) {
    mkdirSync(dirname(targetPath), { recursive: true });
    if (backupPath) {
      mkdirSync(dirname(backupPath), { recursive: true });
      copyFileSync(targetPath, backupPath);
    }
    copyFileSync(sourcePath, targetPath);
  }

  return {
    installed: {
      slug: targetSlug,
      source: candidate.source,
      target_path: targetPath,
      sha256: sourceHash,
      backup_path: backupPath,
      candidate_id: candidate.candidate_id,
    },
    rollback: {
      operation: backupPath ? 'restore_backup' : 'remove',
      target_path: targetPath,
      backup_path: backupPath,
    },
  };
}

function pendingAction(candidate, command) {
  return {
    pending_user_action: {
      candidate_id: candidate.candidate_id,
      slug: candidate.slug,
      source: candidate.source,
      command,
      rollback: 'manual',
    },
    rollback: {
      operation: 'manual_plugin_uninstall',
      target_path: candidate.install?.target || candidate.slug,
      backup_path: null,
    },
  };
}

function rollback(runDir, options) {
  const manifestPath = options.manifestPath || join(runDir, 'manifest.json');
  const manifest = readJsonValidated(manifestPath, 'manifest');
  const actions = [];
  const errors = [];

  for (const op of [...(manifest.rollback || [])].reverse()) {
    try {
      if (op.operation === 'remove') {
        if (!options.dryRun && existsSync(op.target_path)) {
          rmSync(op.target_path, { force: true });
          removeEmptyParents(dirname(op.target_path), dirname(dirname(op.target_path)));
        }
        actions.push({ ...op, status: 'removed' });
      } else if (op.operation === 'restore_backup') {
        if (!op.backup_path || !existsSync(op.backup_path)) {
          throw new Error(`backup missing for ${op.target_path}`);
        }
        if (!options.dryRun) {
          mkdirSync(dirname(op.target_path), { recursive: true });
          copyFileSync(op.backup_path, op.target_path);
        }
        actions.push({ ...op, status: 'restored' });
      } else if (op.operation === 'manual_plugin_uninstall') {
        actions.push({ ...op, status: 'manual_action_required' });
      } else {
        throw new Error(`unknown rollback operation: ${op.operation}`);
      }
    } catch (error) {
      errors.push(`${op.target_path}: ${errorMessage(error)}`);
    }
  }

  const rollbackReport = {
    schema_version: 1,
    run_id: manifest.run_id,
    created_at: now(),
    status: errors.length > 0 ? 'partial' : 'rolled_back',
    actions,
    errors,
  };
  writeJson(join(runDir, 'rollback-report.json'), rollbackReport);
  writeJsonValidated(manifestPath, {
    ...manifest,
    status: errors.length > 0 ? 'partial' : 'rolled_back',
    rolled_back_at: now(),
  }, 'manifest');

  return {
    json: options.json,
    command: 'rollback',
    run_id: manifest.run_id,
    status: rollbackReport.status,
    actions: actions.length,
    errors,
    rollback_report: join(runDir, 'rollback-report.json'),
  };
}

function verify(runDir, options) {
  const manifestPath = options.manifestPath || join(runDir, 'manifest.json');
  const manifest = readJsonValidated(manifestPath, 'manifest');
  const errors = [];

  for (const item of manifest.installed || []) {
    if (!existsSync(item.target_path)) {
      errors.push(`missing installed file: ${item.target_path}`);
      continue;
    }
    const currentHash = sha256(readFileSync(item.target_path, 'utf8'));
    if (currentHash !== item.sha256) {
      errors.push(`hash mismatch: ${item.target_path}`);
    }
  }

  const report = {
    schema_version: 1,
    run_id: manifest.run_id,
    created_at: now(),
    status: errors.length > 0 ? 'failed' : 'success',
    checked: (manifest.installed || []).length,
    pending_user_actions: (manifest.pending_user_actions || []).length,
    errors,
  };
  validateData('manifest', manifest, manifestPath);
  writeJson(join(runDir, 'verify-report.json'), report);

  return {
    json: options.json,
    command: 'verify',
    run_id: manifest.run_id,
    status: report.status,
    checked: report.checked,
    pending_user_actions: report.pending_user_actions,
    errors,
    verify_report: join(runDir, 'verify-report.json'),
  };
}

function buildCoverage(matrix, candidates) {
  const cells = matrix.cells.map((cell, index) => {
    const candidateIds = candidates
      .filter((candidate) => candidate.covered_cells.some((covered) => covered.cell_id === cellId(index, cell)))
      .map((candidate) => candidate.candidate_id);
    return {
      ...cell,
      cell_id: cellId(index, cell),
      candidate_ids: candidateIds,
      best_candidate_id: candidateIds[0] || null,
      status: candidateIds.length > 0 ? 'covered' : 'gap',
    };
  });
  const covered = cells.filter((cell) => cell.status === 'covered').length;
  return {
    schema_version: 1,
    run_id: matrix.run_id,
    created_at: now(),
    summary: {
      total_cells: cells.length,
      covered_cells: covered,
      gap_cells: cells.length - covered,
      coverage_ratio: cells.length === 0 ? 0 : Number((covered / cells.length).toFixed(4)),
    },
    cells,
  };
}

function dedupeCandidates(candidates) {
  const byKey = new Map();
  for (const candidate of candidates) {
    const key = [
      candidate.source,
      candidate.slug,
      candidate.path || candidate.url || candidate.install?.command || candidate.candidate_id,
    ].join('\0');
    const existing = byKey.get(key);
    if (!existing || candidate.score > existing.score) {
      byKey.set(key, candidate);
    }
  }
  return [...byKey.values()];
}

function scoreCoverage(text, slug, cells, config) {
  const covered = [];
  let score = 0;
  cells.forEach((cell, index) => {
    let cellScore = 0;
    if (containsToken(text, cell.technology)) cellScore += 6;
    if (containsToken(text, cell.aspect)) cellScore += 4;
    if (containsToken(text, cell.surface)) cellScore += 2;
    for (const pack of cell.capability_packs || []) {
      if (containsToken(text, pack)) cellScore += 3;
      const packDefinition = config.capability_packs?.[pack] || {};
      if ((packDefinition.skills || []).some((skill) => sanitizeSlug(skill) === slug || containsToken(text, skill))) {
        cellScore += 10;
      }
      if ((packDefinition.agents || []).some((agent) => containsToken(text, agent))) {
        cellScore += 2;
      }
    }
    if (cellScore > 0) {
      score += cellScore;
      covered.push({
        cell_id: cellId(index, cell),
        surface: cell.surface,
        technology: cell.technology,
        aspect: cell.aspect,
        score: cellScore,
      });
    }
  });
  return {
    score,
    covered_cells: covered,
  };
}

function cellId(index, cell) {
  return stableId('cell', `${index}:${cell.surface}:${cell.technology}:${cell.aspect}`);
}

function selectApprovals(candidates, options) {
  if (options.reject) {
    return {
      approvedIds: new Set(),
      policy: {
        mode: 'reject',
        explicit_required: [],
        batch_approved: [],
      },
    };
  }
  const candidateById = new Map(candidates.map((candidate) => [candidate.candidate_id, candidate]));
  const unknownIds = options.approveIds.filter((id) => !candidateById.has(id));
  if (unknownIds.length > 0) {
    throw new Error(`stack-provision: unknown approval candidate id(s): ${unknownIds.join(', ')}`);
  }

  const explicitIds = new Set(options.approveIds);
  const approved = new Set(explicitIds);
  const approvedSources = new Set(options.approveSources);
  const blocked = [];
  const batchApproved = [];

  for (const candidate of candidates) {
    const selectedBySource = approvedSources.has(candidate.source);
    const selectedByLocal = options.approveLocal && ['installed-skill', 'bundled-skill', 'plugin-skill'].includes(candidate.source);
    if (!selectedBySource && !selectedByLocal) {
      continue;
    }

    if (explicitIds.has(candidate.candidate_id)) {
      continue;
    }

    if (requiresExplicitApproval(candidate)) {
      blocked.push(approvalBlock(candidate));
      continue;
    }

    if (!approved.has(candidate.candidate_id)) {
      approved.add(candidate.candidate_id);
      batchApproved.push(candidate.candidate_id);
    }
  }

  if (blocked.length > 0) {
    const details = blocked
      .map((item) => `${item.candidate_id} (${item.source}; ${item.reason})`)
      .join(', ');
    throw new Error(
      `stack-provision: source-level approval blocked for candidates that require explicit review; use --approve=<candidate-id> after reviewing them: ${details}`,
    );
  }

  return {
    approvedIds: approved,
    policy: {
      mode: 'explicit-id-required-for-risk',
      explicit_required: candidates
        .filter((candidate) => requiresExplicitApproval(candidate))
        .map(approvalBlock),
      explicit_approved: [...explicitIds],
      batch_approved: batchApproved,
      source_level_allowed_sources: [...batchApprovalSources],
    },
  };
}

function renderReviewMarkdown(contract, candidatesDoc, installPlan, decision) {
  const lines = [
    `# Stack Provision Review - ${contract.run_id}`,
    '',
    `Install plan hash: ${installPlan.hash}`,
    `Approved: ${decision.confirmation.approved ? 'yes' : 'no'}`,
    `Approved items: ${decision.approved_items.length}`,
    `Approval policy: source-level approval is allowed only for low-risk installed/bundled candidates; external, plugin-cache, generated, download, command, and warning/critical candidates require explicit candidate IDs.`,
    '',
    '## Candidates',
    '',
  ];

  for (const candidate of candidatesDoc.candidates || []) {
    const approved = decision.approved_items.some((item) => item.candidate_id === candidate.candidate_id);
    lines.push(
      `### ${approved ? 'APPROVED' : 'REVIEW'} ${candidate.candidate_id}`,
      '',
      `- Source: ${candidate.source}`,
      `- Slug: ${candidate.slug}`,
      `- Summary: ${candidate.summary}`,
      `- URL/path: ${candidate.url || candidate.path || 'none'}`,
      `- Install kind: ${candidate.install?.kind || 'unknown'}`,
      `- Risk flags: ${(candidate.risk_flags || []).join(', ') || 'none'}`,
      `- Risk severity: ${formatRiskSeverities(candidate)}`,
      `- Approval mode: ${requiresExplicitApproval(candidate) ? 'explicit candidate id required' : 'source-level eligible'}`,
      `- Covered surfaces: ${(candidate.covered_surface || []).join(', ')}`,
      `- Covered technologies: ${(candidate.covered_technology || []).join(', ')}`,
      `- Covered aspects: ${(candidate.covered_aspects || []).join(', ')}`,
      '',
      '#### Preview',
      '',
      renderCandidatePreview(candidate),
      '',
    );
  }

  if ((candidatesDoc.warnings || []).length > 0) {
    lines.push('## Warnings', '');
    for (const warning of candidatesDoc.warnings) {
      lines.push(`- ${warning}`);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function requiresExplicitApproval(candidate) {
  return !batchApprovalSources.has(candidate.source) ||
    (candidate.risk_flags || []).some((flag) => riskFlagSeverity(flag) !== 'info');
}

function approvalBlock(candidate) {
  const flags = candidate.risk_flags || [];
  const flagDetails = flags.length > 0
    ? flags.map((flag) => `${flag}:${riskFlagSeverity(flag)}`).join('|')
    : 'source requires explicit approval';
  return {
    candidate_id: candidate.candidate_id,
    source: candidate.source,
    risk_flags: flags,
    reason: flagDetails,
  };
}

function riskFlagSeverity(flag) {
  if (criticalRiskFlags.has(flag)) {
    return 'critical';
  }
  if (infoRiskFlags.has(flag)) {
    return 'info';
  }
  return 'warning';
}

function formatRiskSeverities(candidate) {
  const flags = candidate.risk_flags || [];
  if (flags.length === 0) {
    return 'none';
  }
  return flags.map((flag) => `${riskFlagSeverity(flag)}:${flag}`).join(', ');
}

function renderCandidatePreview(candidate) {
  const sourcePath = candidate.install?.source_path || candidate.path;
  if (sourcePath && existsSync(sourcePath)) {
    const content = readFileSync(sourcePath, 'utf8');
    return fencedPreview(clipPreview(content));
  }

  if (candidate.install?.kind === 'download-skill') {
    return `No local SKILL.md preview available before network download. Review URL manually: ${candidate.install.source_url || candidate.url || 'unknown'}`;
  }
  if (candidate.install?.kind === 'plugin-install' || candidate.install?.kind === 'external-command') {
    return `No local SKILL.md preview available. Pending user action: ${candidate.install.command || candidate.url || candidate.slug}`;
  }
  return 'No local SKILL.md preview available.';
}

function clipPreview(content) {
  const lines = content
    .split(/\r?\n/)
    .slice(0, 80)
    .join('\n')
    .trim();
  return lines.length > 1800 ? `${lines.slice(0, 1800).trimEnd()}\n...` : lines;
}

function fencedPreview(content) {
  return [
    '```markdown',
    content.replace(/```/g, '``\\`'),
    '```',
  ].join('\n');
}

function readRun(runDir) {
  const contractPath = join(runDir, 'contract.json');
  const matrixPath = join(runDir, 'capability-matrix.json');
  const statePath = join(runDir, 'state.json');
  if (!existsSync(contractPath) || !existsSync(matrixPath)) {
    throw new Error(`stack-provision: run directory missing contract/matrix: ${runDir}`);
  }
  return {
    contract: readJsonValidated(contractPath, 'contract'),
    matrix: readJsonValidated(matrixPath, 'capability-matrix'),
    state: existsSync(statePath) ? readJson(statePath) : {},
  };
}

function findSkillFiles(root, maxDepth) {
  const results = [];
  walk(root, 0);
  return results;

  function walk(dir, depth) {
    if (results.length >= maxSkillFiles || depth > maxDepth) {
      return;
    }
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') {
        continue;
      }
      const path = join(dir, entry.name);
      if (entry.isFile() && entry.name === 'SKILL.md') {
        results.push(path);
      } else if (entry.isDirectory()) {
        walk(path, depth + 1);
      }
    }
  }
}

function parseFrontmatter(content) {
  if (!content.startsWith('---\n')) {
    return {};
  }
  const end = content.indexOf('\n---', 4);
  if (end === -1) {
    return {};
  }
  const metadata = {};
  const frontmatter = content.slice(4, end).split(/\r?\n/);
  for (const line of frontmatter) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    metadata[match[1]] = match[2].replace(/^['"]|['"]$/g, '').trim();
  }
  return metadata;
}

function firstNonEmptyLine(content) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('---') && !line.startsWith('#')) || '';
}

function defaultInstalledRoots(options) {
  if (options.installedRoots.length > 0) {
    return unique(options.installedRoots);
  }
  return unique([
    ...splitPathList(process.env.STACK_PROVISION_INSTALLED_SKILL_ROOTS || ''),
    join(homedir(), '.codex', 'skills'),
    join(homedir(), '.agents', 'skills'),
    join(homedir(), '.claude', 'skills'),
  ]);
}

function defaultBundledRoots(options) {
  if (options.bundledRoots.length > 0) {
    return unique(options.bundledRoots);
  }
  return unique([
    join(options.projectRoot, 'skills'),
  ]);
}

function defaultPluginRoots(options) {
  if (options.pluginRoots.length > 0) {
    return unique(options.pluginRoots);
  }
  return unique([
    ...splitPathList(process.env.STACK_PROVISION_PLUGIN_SKILL_ROOTS || ''),
    join(homedir(), '.codex', 'plugins'),
    join(homedir(), '.codex', 'plugins', 'cache'),
    join(homedir(), '.claude', 'plugins'),
  ]);
}

async function readIndexEntries(index, timeoutMs) {
  const payload = isUrl(index)
    ? await fetchJson(index, timeoutMs)
    : readJson(resolve(index));
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload.candidates)) {
    return payload.candidates;
  }
  if (Array.isArray(payload.items)) {
    return payload.items;
  }
  if (Array.isArray(payload.results)) {
    return payload.results;
  }
  return [];
}

async function fetchJsonEntries(url, timeoutMs) {
  const payload = await fetchJson(url, timeoutMs);
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.candidates)) return payload.candidates;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.results)) return payload.results;
  return [];
}

async function fetchJson(url, timeoutMs) {
  const text = await fetchText(url, timeoutMs);
  return JSON.parse(text);
}

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json,text/plain,*/*' },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function localRiskFlags(source, skillFile) {
  const flags = [];
  if (source === 'plugin-skill') {
    flags.push('plugin-cache-source');
  }
  if (source === 'installed-skill') {
    flags.push('already-installed-local-copy');
  }
  if (!isInside(skillFile, projectRoot) && source === 'bundled-skill') {
    flags.push('bundled-root-outside-project');
  }
  return flags;
}

function externalRiskFlags(source, entry, install) {
  const flags = ['external-source'];
  if (source === 'github' && Number(entry.stars || 0) < 10) {
    flags.push('low-star-count');
  }
  if (!entry.url && !entry.content_path) {
    flags.push('missing-url');
  }
  if (install.kind === 'external-command' || install.kind === 'plugin-install') {
    flags.push('manual-command-required');
  }
  if (install.kind === 'download-skill') {
    flags.push('network-download-required');
  }
  return flags;
}

function removeEmptyParents(dir, boundary) {
  let current = resolve(dir);
  const stop = resolve(boundary);
  while (current.startsWith(stop) && current !== stop) {
    try {
      if (readdirSync(current).length > 0) {
        return;
      }
      rmSync(current, { recursive: false, force: true });
      current = dirname(current);
    } catch {
      return;
    }
  }
}

function containsToken(text, token) {
  const normalizedText = compact(text);
  const normalizedToken = compact(token);
  return normalizedToken.length > 0 && normalizedText.includes(normalizedToken);
}

function stableId(prefix, value) {
  return `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function sanitizeSlug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || 'skill';
}

function splitList(value) {
  return unique(
    String(value)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function splitPathList(value) {
  return unique(
    String(value)
      .split(':')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => resolve(item)),
  );
}

function unique(values) {
  return [...new Set(values)];
}

function compact(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isInside(path, root) {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
}

function isUrl(value) {
  return /^https?:\/\//i.test(value);
}

function now() {
  return process.env.OMC_STACK_PROVISION_NOW || new Date().toISOString();
}

function requireValue(value, flag) {
  if (!value || value.startsWith('--')) {
    throw new Error(`stack-provision: ${flag} requires a value`);
  }
  return value;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function usage() {
  return {
    json: true,
    usage: [
      'node skills/stack-provision/scripts/provision.mjs discover <run-dir> [--sources=installed,bundled,plugin,skills-sh,plugin-marketplace,github]',
      'node skills/stack-provision/scripts/provision.mjs review <run-dir> [--approve=<ids>|--approve-source=<source>|--approve-local|--reject]',
      'node skills/stack-provision/scripts/provision.mjs promote <run-dir> --skill-root=<dir>',
      'node skills/stack-provision/scripts/provision.mjs rollback <run-dir>',
      'node skills/stack-provision/scripts/provision.mjs verify <run-dir>',
    ],
  };
}

function emit(result) {
  if (result.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.usage) {
    console.log(result.usage.join('\n'));
    return;
  }
  const parts = [
    `stack-provision ${result.command}`,
    `run=${result.run_id}`,
  ];
  if (result.status) parts.push(`status=${result.status}`);
  if (typeof result.candidates === 'number') parts.push(`candidates=${result.candidates}`);
  if (typeof result.approved === 'number') parts.push(`approved=${result.approved}`);
  if (typeof result.installed === 'number') parts.push(`installed=${result.installed}`);
  if (Array.isArray(result.errors) && result.errors.length > 0) parts.push(`errors=${result.errors.length}`);
  console.log(parts.join(' '));
}
