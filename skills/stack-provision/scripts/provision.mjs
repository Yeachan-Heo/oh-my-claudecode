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
const DEFAULT_STRICT_GATE = Object.freeze({
  source_trust_min: 0.85,
  freshness_days_max: 180,
  checksum_required: true,
  license_conflict_allowed: false,
});

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
    criticVerdict: '',
    researchAck: false,
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
    } else if (arg.startsWith('--critic-verdict=')) {
      options.criticVerdict = arg.slice('--critic-verdict='.length).trim();
    } else if (arg === '--critic-verdict') {
      index += 1;
      options.criticVerdict = requireValue(argv[index], '--critic-verdict').trim();
    } else if (arg === '--research-ack') {
      options.researchAck = true;
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
  if (options.criticVerdict && !['approve', 'revise', 'rewind'].includes(options.criticVerdict)) {
    throw new Error('stack-provision: --critic-verdict must be one of approve, revise, rewind');
  }

  return options;
}

async function discover(runDir, options) {
  const run = readRun(runDir);
  const config = readJsonValidated(resolve(options.configPath), 'config', options.configPath);
  const selectedSources = options.sources.length > 0
    ? options.sources
    : config.discovery_policy?.default_source_order || ['skills-sh', 'plugin-marketplace', 'github', 'installed', 'bundled', 'plugin'];
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
  const profile = localCandidateProfile(metadata, slug, description, source, config);
  const coverage = scoreCoverage(profile, slug, run.matrix.cells, config);

  if (coverage.covered_cells.length === 0) {
    return null;
  }

  const hash = sha256(content);
  const trust = localTrustMetadata(source);
  const baseRiskFlags = localRiskFlags(source, skillFile);
  const strictGate = evaluateStrictGateForCandidate({
    source_trust: trust.source_trust,
    freshness_days: trust.freshness_days,
    checksum_valid: true,
    license_status: trust.license_status,
    source,
    risk_flags: baseRiskFlags,
  }, strictGatePolicy(run.contract));
  const riskFlags = mergeStrictGateRiskFlags(baseRiskFlags, strictGate);
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
    risk_flags: riskFlags,
    source_quality: profile.sourceQuality,
    source_trust: strictGate.metrics.source_trust,
    freshness_days: strictGate.metrics.freshness_days,
    checksum_valid: strictGate.metrics.checksum_valid,
    license_status: strictGate.metrics.license_status,
    provenance: trust.provenance,
    strict_gate: strictGate,
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
  for (const query of discoveryQueries(run, config)) {
    try {
      entries.push(...await fetchJsonEntries(fallbackSearch(query), timeoutMs));
    } catch (error) {
      warnings.push(`${source} network search failed for ${query}: ${errorMessage(error)}`);
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
  for (const queryTerm of discoveryQueries(run, config)) {
    const orgQuery = orgs.map((org) => `org:${org}`).join(' ');
    const query = `${queryTerm} claude skill SKILL.md ${orgQuery}`.trim();
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
          tags: [queryTerm],
        });
      }
    } catch (error) {
      warnings.push(`github search failed for ${queryTerm}: ${errorMessage(error)}`);
    }
  }
  return normalizeExternalEntries('github', entries, run, config);
}

function normalizeExternalEntries(source, entries, run, config) {
  const candidates = [];
  for (const entry of entries) {
    const slug = sanitizeSlug(entry.slug || entry.name || entry.ref || entry.url || source);
    const description = String(entry.description || entry.summary || '');
    const profile = externalCandidateProfile(entry, slug, description, source, config);
    const coverage = scoreCoverage(profile, slug, run.matrix.cells, config);
    if (coverage.covered_cells.length === 0) {
      continue;
    }

    const install = externalInstall(source, entry, slug);
    const candidateBody = JSON.stringify({ source, entry, install });
    const candidateHash = install.kind === 'copy-skill' && install.source_path && existsSync(install.source_path)
      ? sha256(readFileSync(install.source_path, 'utf8'))
      : sha256(candidateBody);
    const trust = externalTrustMetadata(source, entry, profile.sourceQuality);
    const baseRiskFlags = externalRiskFlags(source, entry, install);
    const strictGate = evaluateStrictGateForCandidate({
      source_trust: trust.source_trust,
      freshness_days: trust.freshness_days,
      checksum_valid: true,
      license_status: trust.license_status,
      source,
      risk_flags: baseRiskFlags,
    }, strictGatePolicy(run.contract));
    const riskFlags = mergeStrictGateRiskFlags(baseRiskFlags, strictGate);
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
      risk_flags: riskFlags,
      source_quality: profile.sourceQuality,
      source_trust: strictGate.metrics.source_trust,
      freshness_days: strictGate.metrics.freshness_days,
      checksum_valid: strictGate.metrics.checksum_valid,
      license_status: strictGate.metrics.license_status,
      provenance: trust.provenance,
      strict_gate: strictGate,
      sha256: candidateHash,
      score: coverage.score,
      install,
    });
  }
  return candidates;
}

function localCandidateProfile(metadata, slug, description, source, config) {
  const sourceQuality = sourceQualityForCandidate(source, { url: null, name: metadata.name || slug }, config);
  return candidateProfile({
    slug,
    sourceQuality,
    skills: [slug, ...metadataValues(metadata, 'name', 'skill')],
    surfaces: metadataValues(metadata, 'surfaces', 'surface'),
    technologies: metadataValues(metadata, 'technologies', 'technology', 'tech', 'stack'),
    aspects: metadataValues(metadata, 'aspects', 'aspect'),
    capabilityPacks: metadataValues(metadata, 'capability_packs', 'capability-packs', 'packs'),
    methodologies: metadataValues(metadata, 'methodologies', 'methodology', 'practices', 'guidelines'),
    fields: [
      slug,
      metadata.name,
      metadata.title,
      metadata.summary,
      metadata.description,
      description,
      ...metadataValues(metadata, 'tags', 'keywords', 'triggers'),
      ...metadataValues(metadata, 'methodologies', 'methodology', 'practices', 'guidelines'),
      ...metadataValues(metadata, 'surfaces', 'surface'),
      ...metadataValues(metadata, 'technologies', 'technology', 'tech', 'stack'),
      ...metadataValues(metadata, 'aspects', 'aspect'),
      ...metadataValues(metadata, 'capability_packs', 'capability-packs', 'packs'),
    ],
  });
}

function externalCandidateProfile(entry, slug, description, source, config) {
  const sourceQuality = sourceQualityForCandidate(source, entry, config);
  return candidateProfile({
    slug,
    sourceQuality,
    skills: [slug, ...entryValues(entry, 'name', 'slug', 'ref')],
    surfaces: entryValues(entry, 'surfaces', 'surface'),
    technologies: entryValues(entry, 'technologies', 'technology', 'tech', 'stack'),
    aspects: entryValues(entry, 'aspects', 'aspect'),
    capabilityPacks: entryValues(entry, 'capability_packs', 'capabilityPacks', 'packs'),
    methodologies: entryValues(entry, 'methodologies', 'methodology', 'practices', 'guidelines'),
    fields: [
      slug,
      entry.name,
      entry.title,
      description,
      entry.summary,
      entry.url,
      entry.ref,
      ...entryValues(entry, 'tags', 'keywords'),
      ...entryValues(entry, 'methodologies', 'methodology', 'practices', 'guidelines'),
      ...entryValues(entry, 'surfaces', 'surface'),
      ...entryValues(entry, 'technologies', 'technology', 'tech', 'stack'),
      ...entryValues(entry, 'aspects', 'aspect'),
      ...entryValues(entry, 'capability_packs', 'capabilityPacks', 'packs'),
    ],
  });
}

function sourceQualityForCandidate(source, entry, config) {
  const policy = config.discovery_policy || {};
  const weights = policy.source_quality_weights || {};
  const signals = [];
  let score = 0;
  const url = String(entry.url || entry.html_url || entry.skill_md_url || entry.source_url || '');
  const domain = domainFromUrl(url);

  const addSignal = (signal, weightKey) => {
    const weight = Number(weights[weightKey] || 0);
    if (weight <= 0 || signals.includes(signal)) {
      return;
    }
    signals.push(signal);
    score += weight;
  };

  if (['skills-sh', 'plugin-marketplace', 'github'].includes(source)) {
    addSignal('external-index', 'external_index');
  }
  if (source === 'installed-skill') {
    addSignal('installed-local', 'installed_local');
  }
  if (domain && domainMatches(domain, policy.professional_source_domains || [])) {
    addSignal('professional-domain', 'professional_domain');
  }
  if (domain && domainMatches(domain, policy.specialized_platform_domains || [])) {
    addSignal('specialized-platform', 'specialized_platform');
  }

  const githubOrg = githubOrgFromUrl(url);
  if (githubOrg && includesNormalized(policy.trusted_github_orgs || [], githubOrg)) {
    addSignal('trusted-github-org', 'trusted_github_org');
  }

  return { score, signals };
}

function strictGatePolicy(contract) {
  return {
    source_trust_min: Number(contract?.policy?.strict_gate?.source_trust_min ?? DEFAULT_STRICT_GATE.source_trust_min),
    freshness_days_max: Number(contract?.policy?.strict_gate?.freshness_days_max ?? DEFAULT_STRICT_GATE.freshness_days_max),
    checksum_required: contract?.policy?.strict_gate?.checksum_required ?? DEFAULT_STRICT_GATE.checksum_required,
    license_conflict_allowed:
      contract?.policy?.strict_gate?.license_conflict_allowed ?? DEFAULT_STRICT_GATE.license_conflict_allowed,
  };
}

function localTrustMetadata(source) {
  if (source === 'bundled-skill') {
    return {
      source_trust: 0.98,
      freshness_days: 0,
      license_status: 'no-conflict',
      provenance: 'bundled-local',
    };
  }
  if (source === 'installed-skill') {
    return {
      source_trust: 0.95,
      freshness_days: 0,
      license_status: 'no-conflict',
      provenance: 'installed-local',
    };
  }
  return {
    source_trust: 0.88,
    freshness_days: 0,
    license_status: 'unknown',
    provenance: 'plugin-cache',
  };
}

function externalTrustMetadata(source, entry, sourceQuality) {
  const freshness = freshnessDaysFromEntry(entry);
  const stars = Number(entry.stars || entry.stargazers_count || 0);
  let trust = source === 'github' ? 0.66 : 0.7;
  trust += Math.min(0.2, Number(sourceQuality?.score || 0) / 40);
  trust += stars >= 100 ? 0.12 : stars >= 25 ? 0.08 : stars >= 10 ? 0.05 : 0;
  trust -= (freshness != null && freshness > 365) ? 0.1 : 0;
  trust = clamp01(trust);
  return {
    source_trust: Number(trust.toFixed(3)),
    freshness_days: freshness,
    license_status: normalizeLicenseStatus(entry),
    provenance: source === 'github' ? 'github-index' : `${source}-index`,
  };
}

function freshnessDaysFromEntry(entry) {
  const raw = entry.last_updated || entry.updated_at || entry.published_at || entry.lastUpdate;
  if (!raw) {
    return null;
  }
  const parsed = Date.parse(String(raw));
  if (!Number.isFinite(parsed)) {
    return null;
  }
  const deltaMs = Date.now() - parsed;
  if (deltaMs < 0) {
    return 0;
  }
  return Math.floor(deltaMs / (24 * 60 * 60 * 1000));
}

function normalizeLicenseStatus(entry) {
  const raw = String(
    entry.license || entry.license_id || entry.licenseName || entry.spdx || '',
  ).toLowerCase();
  if (!raw) {
    return 'unknown';
  }
  if (/(gpl-3|agpl|non-commercial|proprietary|unknown-license-conflict)/.test(raw)) {
    return 'conflict';
  }
  return 'no-conflict';
}

function evaluateStrictGateForCandidate(candidate, policy) {
  const reasons = [];
  const metrics = {
    source_trust: Number(candidate.source_trust ?? 0),
    freshness_days: candidate.freshness_days ?? null,
    checksum_valid: candidate.checksum_valid !== false,
    license_status: candidate.license_status || 'unknown',
  };

  if (metrics.source_trust < policy.source_trust_min) {
    reasons.push(`source_trust<${policy.source_trust_min}`);
  }

  const isLocalCandidate = ['bundled-skill', 'installed-skill', 'plugin-skill'].includes(candidate.source);
  if (metrics.freshness_days == null) {
    if (!isLocalCandidate) {
      reasons.push('freshness_unknown');
    }
  } else if (metrics.freshness_days > policy.freshness_days_max) {
    reasons.push(`freshness>${policy.freshness_days_max}d`);
  }

  if (policy.checksum_required && !metrics.checksum_valid) {
    reasons.push('checksum_invalid');
  }
  if (!policy.license_conflict_allowed && metrics.license_status === 'conflict') {
    reasons.push('license_conflict');
  }

  return {
    install_allowed: reasons.length === 0,
    reasons,
    metrics,
  };
}

function mergeStrictGateRiskFlags(riskFlags, strictGate) {
  const flags = new Set(riskFlags || []);
  if (!strictGate.install_allowed) {
    flags.add('strict-gate-failed');
    for (const reason of strictGate.reasons) {
      flags.add(`strict-gate:${reason}`);
    }
  }
  return [...flags];
}

function discoveryQueries(run, config) {
  const queries = [];
  const policy = config.discovery_policy || {};
  const cells = run.matrix?.cells || [];

  queries.push(...toList(run.contract?.stack));
  for (const cell of cells) {
    queries.push(cell.surface, cell.technology, cell.aspect);
    queries.push(`${cell.surface} ${cell.aspect}`);
    if (cell.technology !== cell.surface) {
      queries.push(`${cell.technology} ${cell.aspect}`);
      queries.push(`${cell.technology} ${cell.surface}`);
      queries.push(`${cell.technology} ${cell.surface} ${cell.aspect}`);
    }
    for (const alias of aspectAliases(cell, config)) {
      queries.push(alias);
      queries.push(`${cell.surface} ${alias}`);
      if (cell.technology !== cell.surface) {
        queries.push(`${cell.technology} ${alias}`);
      }
    }
  }

  const expanded = [];
  for (const query of queries) {
    expanded.push(query);
    expanded.push(...queryExpansions(query, policy));
  }

  return uniqueQueries(expanded).slice(0, 80);
}

function queryExpansions(query, policy) {
  const text = String(query || '').trim();
  if (!text) {
    return [];
  }
  const expanded = [];
  const spaced = text.replace(/[-_]+/g, ' ');
  if (spaced !== text) {
    expanded.push(spaced);
  }

  const expansionMap = policy.query_expansions || {};
  const compacted = compact(text);
  for (const [key, values] of Object.entries(expansionMap)) {
    const normalizedKey = compact(key);
    if (
      normalizedKey &&
      (compacted === normalizedKey ||
        containsToken(text, key) ||
        containsToken(spaced, key))
    ) {
      expanded.push(...toList(values));
    }
  }

  return expanded;
}

function uniqueQueries(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const query = String(value || '').replace(/\s+/g, ' ').trim();
    const key = query.toLowerCase();
    if (!query || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(query);
  }
  return result;
}

function domainFromUrl(url) {
  if (!url) {
    return '';
  }
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function domainMatches(domain, configuredDomains) {
  const normalizedDomain = String(domain || '').toLowerCase().replace(/^www\./, '');
  return toList(configuredDomains).some((value) => {
    const configured = String(value || '').toLowerCase().replace(/^www\./, '');
    return configured &&
      (normalizedDomain === configured || normalizedDomain.endsWith(`.${configured}`));
  });
}

function githubOrgFromUrl(url) {
  if (!url) {
    return '';
  }
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (host !== 'github.com') {
      return '';
    }
    return parsed.pathname.split('/').filter(Boolean)[0] || '';
  } catch {
    return '';
  }
}

function candidateProfile({ slug, sourceQuality, skills, surfaces, technologies, aspects, capabilityPacks, methodologies, fields }) {
  const cleanFields = fields
    .flatMap((value) => toList(value))
    .map((value) => String(value).trim())
    .filter(Boolean);
  return {
    slug,
    text: unique(cleanFields).join('\n').toLowerCase(),
    skills: normalizeList(skills),
    surfaces: normalizeList(surfaces),
    technologies: normalizeList(technologies),
    aspects: normalizeList(aspects),
    capabilityPacks: normalizeList(capabilityPacks),
    methodologies: normalizeList(methodologies),
    sourceQuality,
  };
}

function metadataValues(metadata, ...keys) {
  return keys.flatMap((key) => toList(metadata[key]));
}

function entryValues(entry, ...keys) {
  return keys.flatMap((key) => toList(entry[key]));
}

function toList(value) {
  if (value == null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => toList(item));
  }
  const raw = String(value).trim();
  if (!raw) {
    return [];
  }
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return raw
      .slice(1, -1)
      .split(',')
      .map((item) => item.replace(/^['"]|['"]$/g, '').trim())
      .filter(Boolean);
  }
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeList(values) {
  return unique(
    toList(values)
      .map((value) => compact(value))
      .filter(Boolean),
  );
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
    source_trust: candidate.source_trust ?? null,
    freshness_days: candidate.freshness_days ?? null,
    checksum_valid: candidate.checksum_valid !== false,
    license_status: candidate.license_status || 'unknown',
    provenance: candidate.provenance || null,
    strict_gate: candidate.strict_gate || evaluateStrictGateForCandidate({
      source_trust: candidate.source_trust ?? 0,
      freshness_days: candidate.freshness_days ?? null,
      checksum_valid: candidate.checksum_valid !== false,
      license_status: candidate.license_status || 'unknown',
      source: candidate.source,
      risk_flags: candidate.risk_flags || [],
    }, strictGatePolicy(run.contract)),
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
  const criticVerdict = options.criticVerdict || (options.reject ? 'revise' : (approvedItems.length > 0 ? 'approve' : 'revise'));
  const researchRequired = run.contract?.policy?.research_required === true;
  const decision = {
    schema_version: 1,
    run_id: run.contract.run_id,
    install_plan_hash: installPlan.hash,
    approved_items: approvedItems,
    confirmation: {
      approved: approvedItems.length > 0 && !options.reject,
      approved_at: now(),
      approved_by: options.approvedBy,
      critic_verdict: criticVerdict,
      research_acknowledged: researchRequired ? options.researchAck : true,
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

  if (run.contract?.policy?.provisioning_blocked) {
    throw new Error('stack-provision: compatibility report is blocked; resolve strategy conflicts before provisioning');
  }

  if (!decision.confirmation?.approved) {
    throw new Error('stack-provision: review confirmation is not approved; promotion blocked');
  }
  if (decision.confirmation?.critic_verdict !== 'approve') {
    throw new Error('stack-provision: critic verdict is not approve; promotion blocked');
  }
  if (run.contract?.policy?.research_required && decision.confirmation?.research_acknowledged !== true) {
    throw new Error('stack-provision: research acknowledgement required before promotion');
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
  const quarantined = [];
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
    const strictGate = candidate.strict_gate || evaluateStrictGateForCandidate({
      source_trust: candidate.source_trust ?? 0,
      freshness_days: candidate.freshness_days ?? null,
      checksum_valid: candidate.checksum_valid !== false,
      license_status: candidate.license_status || 'unknown',
      source: candidate.source,
      risk_flags: candidate.risk_flags || [],
    }, strictGatePolicy(run.contract));
    if (!strictGate.install_allowed) {
      const quarantine = quarantineCandidate(candidate, runDir, strictGate, options.dryRun);
      quarantined.push(quarantine.quarantined);
      pendingUserActions.push(quarantine.pending_user_action);
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
    quarantined,
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
    quarantined: quarantined.length,
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

function quarantineCandidate(candidate, runDir, strictGate, dryRun = false) {
  const quarantineDir = join(runDir, 'quarantine', sanitizeSlug(candidate.slug));
  const quarantinePath = join(quarantineDir, `${sanitizeSlug(candidate.candidate_id)}.json`);
  if (!dryRun) {
    mkdirSync(quarantineDir, { recursive: true });
    writeJson(quarantinePath, {
      candidate_id: candidate.candidate_id,
      slug: candidate.slug,
      source: candidate.source,
      strict_gate: strictGate,
      created_at: now(),
    });
  }
  return {
    quarantined: {
      candidate_id: candidate.candidate_id,
      slug: candidate.slug,
      source: candidate.source,
      quarantine_path: quarantinePath,
      reasons: strictGate.reasons,
    },
    pending_user_action: {
      candidate_id: candidate.candidate_id,
      slug: candidate.slug,
      source: candidate.source,
      command: `manual approve required after strict gate review: ${strictGate.reasons.join(', ')}`,
      rollback: 'none (quarantined)',
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
    const candidateMatches = candidates
      .map((candidate) => {
        const covered = candidate.covered_cells.find((item) => item.cell_id === cellId(index, cell));
        return covered ? { candidate, covered } : null;
      })
      .filter(Boolean)
      .sort((a, b) =>
        b.covered.score - a.covered.score ||
        b.candidate.score - a.candidate.score ||
        a.candidate.candidate_id.localeCompare(b.candidate.candidate_id),
      );
    const candidateIds = candidateMatches.map((match) => match.candidate.candidate_id);
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

function scoreCoverage(profile, slug, cells, config) {
  const covered = [];
  let score = 0;
  cells.forEach((cell, index) => {
    if (isBlockedByNegativeRule(profile, slug, cell, config)) {
      return;
    }

    const signals = coverageSignals(profile, slug, cell, config);
    if (!isCoverageEligible(signals, cell)) {
      return;
    }

    const cellScore = (
      (signals.hasTechnology ? 6 : 0) +
      (signals.hasAspect ? 4 : 0) +
      (signals.hasSurface ? 2 : 0) +
      (signals.hasPack ? 3 : 0) +
      (signals.hasMappedSkill ? 10 : 0) +
      (signals.hasMappedAgent ? 2 : 0) +
      signals.sourceQualityScore
    );
    score += cellScore;
    covered.push({
      cell_id: cellId(index, cell),
      surface: cell.surface,
      technology: cell.technology,
      aspect: cell.aspect,
      score: cellScore,
      signals: signalNames(signals),
    });
  });
  return {
    score,
    covered_cells: covered,
  };
}

function coverageSignals(profile, slug, cell, config) {
  const text = profile.text;
  const aliases = aspectAliases(cell, config);
  const hasSurface = containsToken(text, cell.surface) || includesNormalized(profile.surfaces, cell.surface);
  const hasTechnology = cell.technology === cell.surface
    ? hasSurface
    : containsToken(text, cell.technology) || includesNormalized(profile.technologies, cell.technology);
  const hasAspect = containsToken(text, cell.aspect) ||
    includesNormalized(profile.aspects, cell.aspect) ||
    aliases.some((alias) =>
      containsToken(text, alias) ||
      includesNormalized(profile.aspects, alias) ||
      includesNormalized(profile.methodologies, alias),
    );
  let hasPack = false;
  let hasMappedSkill = false;
  let hasMappedAgent = false;
  const sourceQualityScore = Number(profile.sourceQuality?.score || 0);

  for (const pack of cell.capability_packs || []) {
    const packDefinition = config.capability_packs?.[pack] || {};
    hasPack = hasPack || containsToken(text, pack) || includesNormalized(profile.capabilityPacks, pack);
    hasMappedSkill = hasMappedSkill || (packDefinition.skills || []).some((skill) =>
      sanitizeSlug(skill) === slug ||
      containsToken(text, skill) ||
      includesNormalized(profile.skills, skill),
    );
    hasMappedAgent = hasMappedAgent || (packDefinition.agents || []).some((agent) =>
      containsToken(text, agent),
    );
  }

  return {
    hasSurface,
    hasTechnology,
    hasAspect,
    hasPack,
    hasMappedSkill,
    hasMappedAgent,
    sourceQualityScore,
  };
}

function isCoverageEligible(signals, cell) {
  return signals.hasMappedSkill ||
    (signals.hasTechnology && (signals.hasAspect || signals.hasPack)) ||
    (cell.technology === cell.surface && signals.hasSurface && signals.hasAspect);
}

function signalNames(signals) {
  return Object.entries(signals)
    .filter(([, value]) => value === true || (typeof value === 'number' && value > 0))
    .map(([name]) => name);
}

function aspectAliases(cell, config) {
  const surfaceAliases = config.surfaces?.[cell.surface]?.aspect_aliases || {};
  const globalAliases = config.matching?.aspect_aliases || {};
  return unique([
    ...toList(surfaceAliases[cell.aspect]),
    ...toList(globalAliases[cell.aspect]),
  ]);
}

function isBlockedByNegativeRule(profile, slug, cell, config) {
  const rules = config.matching?.negative_rules || [];
  return rules.some((rule) =>
    matchesCandidateRule(rule, profile, slug) &&
    matchesCellRule(rule, cell),
  );
}

function matchesCandidateRule(rule, profile, slug) {
  const slugRules = rule.slug_match || [];
  if (slugRules.length === 0) {
    return false;
  }
  return slugRules.some((ruleSlug) =>
    containsToken(slug, ruleSlug) ||
    includesNormalized(profile.skills, ruleSlug) ||
    containsToken(profile.text, ruleSlug),
  );
}

function matchesCellRule(rule, cell) {
  return matchesRuleList(rule.surfaces, cell.surface) &&
    matchesRuleList(rule.technologies, cell.technology) &&
    matchesRuleList(rule.aspects, cell.aspect) &&
    matchesAnyRuleList(rule.capability_packs, cell.capability_packs || []);
}

function matchesRuleList(ruleValues, value) {
  return !Array.isArray(ruleValues) ||
    ruleValues.length === 0 ||
    includesNormalized(ruleValues, value);
}

function matchesAnyRuleList(ruleValues, values) {
  return !Array.isArray(ruleValues) ||
    ruleValues.length === 0 ||
    values.some((value) => includesNormalized(ruleValues, value));
}

function includesNormalized(values, value) {
  const normalized = compact(value);
  return normalized.length > 0 && values.some((candidate) => compact(candidate) === normalized);
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
  const strictPolicy = strictGatePolicy(contract);
  const lines = [
    `# Stack Provision Review - ${contract.run_id}`,
    '',
    `Install plan hash: ${installPlan.hash}`,
    `Approved: ${decision.confirmation.approved ? 'yes' : 'no'}`,
    `Approved items: ${decision.approved_items.length}`,
    `Critic verdict: ${decision.confirmation.critic_verdict || 'unknown'}`,
    `Research acknowledged: ${decision.confirmation.research_acknowledged === true ? 'yes' : 'no'}`,
    `Provisioning mode: ${contract.policy?.provisioning_mode || 'strict-gate'}`,
    `Strict gate thresholds: source_trust>=${strictPolicy.source_trust_min}, freshness<=${strictPolicy.freshness_days_max}d, checksum=${strictPolicy.checksum_required}, license_conflict_allowed=${strictPolicy.license_conflict_allowed}`,
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
      `- Source quality: ${formatSourceQuality(candidate)}`,
      `- Source trust: ${formatSourceTrust(candidate)}`,
      `- Freshness days: ${candidate.freshness_days ?? 'unknown'}`,
      `- Checksum valid: ${candidate.checksum_valid !== false ? 'yes' : 'no'}`,
      `- License status: ${candidate.license_status || 'unknown'}`,
      `- Provenance: ${candidate.provenance || 'unknown'}`,
      `- Strict gate: ${formatStrictGate(candidate)}`,
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

function formatSourceQuality(candidate) {
  const score = Number(candidate.source_quality?.score || 0);
  const signals = candidate.source_quality?.signals || [];
  return `${score}${signals.length > 0 ? ` (${signals.join(', ')})` : ''}`;
}

function formatSourceTrust(candidate) {
  const score = Number(candidate.source_trust ?? 0);
  return Number.isFinite(score) ? score.toFixed(3) : '0.000';
}

function formatStrictGate(candidate) {
  const gate = candidate.strict_gate || {};
  if (gate.install_allowed === true) {
    return 'pass';
  }
  const reasons = Array.isArray(gate.reasons) ? gate.reasons : [];
  return reasons.length > 0 ? `fail (${reasons.join(', ')})` : 'fail';
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
  let currentKey = null;
  for (const line of frontmatter) {
    const listMatch = /^\s*-\s*(.+)$/.exec(line);
    if (listMatch && currentKey) {
      const existing = Array.isArray(metadata[currentKey]) ? metadata[currentKey] : [];
      metadata[currentKey] = [
        ...existing,
        parseMetadataValue(listMatch[1]),
      ];
      continue;
    }

    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) {
      currentKey = null;
      continue;
    }
    const key = match[1];
    const value = match[2].trim();
    metadata[key] = value ? parseMetadataValue(value) : [];
    currentKey = value ? null : key;
  }
  return metadata;
}

function parseMetadataValue(value) {
  return String(value).replace(/^['"]|['"]$/g, '').trim();
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
  const parts = String(token)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (parts.length === 0) {
    return false;
  }
  const pattern = parts.map(escapeRegExp).join('[^a-z0-9]+');
  return new RegExp(`(^|[^a-z0-9])${pattern}([^a-z0-9]|$)`, 'i').test(String(text));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function clamp01(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
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
      'node skills/stack-provision/scripts/provision.mjs review <run-dir> [--approve=<ids>|--approve-source=<source>|--approve-local|--reject|--critic-verdict=<approve|revise|rewind>|--research-ack]',
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
