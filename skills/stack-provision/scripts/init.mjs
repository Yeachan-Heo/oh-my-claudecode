#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonValidated, validateData, writeJson, writeJsonValidated } from './validation.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultConfigPath = resolve(scriptDir, '..', 'config', 'default-capability-packs.json');
const defaultOutRoot = '.omc/provisioned/runs';
const WEIGHTED_SCORE_WEIGHTS = Object.freeze({
  product_fit: 0.30,
  operability: 0.20,
  ecosystem_maturity: 0.20,
  performance: 0.15,
  security_compliance: 0.10,
  cost_efficiency: 0.05,
});

try {
  const result = run(process.argv.slice(2));
  emit(result);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function run(argv) {
  const options = parseArgs(argv);
  const config = readJsonValidated(resolve(options.configPath), 'config', options.configPath);
  const createdAt = process.env.OMC_STACK_PROVISION_NOW || new Date().toISOString();
  const input = readInput(options.rawInput);
  const stack = input.stack;

  if (stack.length === 0) {
    throw new Error('stack-provision: empty stack after parsing input');
  }

  const inferredSurfaces = inferSurfaces(stack, config);
  const explicitSurfaces = normalizeSurfaceList(options.surfaces, config);
  const inferredApplicationBlocks = inferApplicationBlocks(stack, config);
  const explicitApplicationBlocks = normalizeBlockList(options.blocks, config);
  const applicationBlocks = unique([...inferredApplicationBlocks, ...explicitApplicationBlocks]);
  const blockSurfaces = surfacesForBlocks(applicationBlocks, config);
  const surfaces = selectSurfaces({
    inferredSurfaces,
    explicitSurfaces,
    blockSurfaces,
    creativeIntent: options.creativeIntent,
    surfacesOnly: options.surfacesOnly,
    config,
  });

  if (surfaces.length === 0) {
    throw new Error(
      'stack-provision: no capability surfaces inferred; pass --surfaces=<surface,list>',
    );
  }

  const runId = options.runId || makeRunId(stack, surfaces, createdAt);
  const aspectsBySurface = buildAspectsBySurface(surfaces, options.aspects, options.creativeIntent, config);
  const capabilityPacks = collectCapabilityPacks(surfaces, config);
  const weightedScorecard = buildWeightedScorecard(stack, surfaces, applicationBlocks, config);
  const compatibilityReport = buildCompatibilityReport({
    stack,
    surfaces,
    applicationBlocks,
  });
  const researchRequired =
    compatibilityReport.summary.critical_unknown_pairs > 0 ||
    (compatibilityReport.overall_status === 'unknown' && weightedScorecard.summary.top2_gap < 8);
  const contract = {
    schema_version: 1,
    run_id: runId,
    created_at: createdAt,
    input: {
      raw: options.rawInput,
      adr_path: input.adrPath,
    },
    stack,
    surfaces,
    application_blocks: applicationBlocks,
    creative_intent: options.creativeIntent,
    aspects_by_surface: aspectsBySurface,
    capability_packs: capabilityPacks,
    weighted_scorecard: weightedScorecard,
    compatibility_report: compatibilityReport,
    policy: {
      human_gate_required: true,
      quarantine_required: true,
      allow_generated_install_by_default: false,
      provisioning_mode: 'strict-gate',
      critic_required: true,
      hard_rewind: true,
      max_rewinds: 2,
      research_required: researchRequired,
      provisioning_blocked: compatibilityReport.overall_status === 'blocked',
      strict_gate: {
        source_trust_min: 0.85,
        freshness_days_max: 180,
        checksum_required: true,
        license_conflict_allowed: false,
      },
      dry_run: options.dryRun,
      no_generate: options.noGenerate,
    },
  };

  const capabilityMatrix = {
    schema_version: 1,
    run_id: runId,
    surfaces,
    application_blocks: applicationBlocks,
    capability_packs: capabilityPacks,
    cells: buildMatrixCells(stack, surfaces, aspectsBySurface, config),
  };
  validateData('contract', contract, 'contract');
  validateData('capability-matrix', capabilityMatrix, 'capability-matrix');

  const reviewMarkdown = buildReviewMarkdown(contract, capabilityMatrix, config);
  const output = buildOutput(options.outRoot, runId, contract, capabilityMatrix, reviewMarkdown);

  if (!options.dryRun) {
    writeRun(output);
  }

  return {
    json: options.json,
    run_id: runId,
    created_at: createdAt,
    dry_run: options.dryRun,
    stack,
    surfaces,
    application_blocks: applicationBlocks,
    capability_packs: capabilityPacks,
    artifacts: output.artifacts,
    contract,
    capability_matrix: capabilityMatrix,
  };
}

function parseArgs(argv) {
  const options = {
    rawInput: '',
    surfaces: [],
    blocks: [],
    aspects: [],
    creativeIntent: '',
    configPath: defaultConfigPath,
    outRoot: defaultOutRoot,
    runId: '',
    dryRun: false,
    json: false,
    noGenerate: false,
    surfacesOnly: false,
  };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--no-generate') {
      options.noGenerate = true;
    } else if (arg === '--surfaces-only') {
      options.surfacesOnly = true;
    } else if (arg.startsWith('--surfaces=')) {
      options.surfaces = splitList(arg.slice('--surfaces='.length));
    } else if (arg === '--surfaces') {
      index += 1;
      options.surfaces = splitList(requireValue(argv[index], '--surfaces'));
    } else if (arg.startsWith('--blocks=')) {
      options.blocks = splitList(arg.slice('--blocks='.length));
    } else if (arg === '--blocks') {
      index += 1;
      options.blocks = splitList(requireValue(argv[index], '--blocks'));
    } else if (arg.startsWith('--aspects=')) {
      options.aspects = splitList(arg.slice('--aspects='.length));
    } else if (arg === '--aspects') {
      index += 1;
      options.aspects = splitList(requireValue(argv[index], '--aspects'));
    } else if (arg.startsWith('--creative-intent=')) {
      options.creativeIntent = arg.slice('--creative-intent='.length).trim();
    } else if (arg === '--creative-intent') {
      index += 1;
      options.creativeIntent = requireValue(argv[index], '--creative-intent').trim();
    } else if (arg.startsWith('--config=')) {
      options.configPath = arg.slice('--config='.length);
    } else if (arg === '--config') {
      index += 1;
      options.configPath = requireValue(argv[index], '--config');
    } else if (arg.startsWith('--out=')) {
      options.outRoot = arg.slice('--out='.length);
    } else if (arg === '--out') {
      index += 1;
      options.outRoot = requireValue(argv[index], '--out');
    } else if (arg.startsWith('--run-id=')) {
      options.runId = sanitizeSlug(arg.slice('--run-id='.length));
    } else if (arg === '--run-id') {
      index += 1;
      options.runId = sanitizeSlug(requireValue(argv[index], '--run-id'));
    } else if (arg.startsWith('--')) {
      throw new Error(`stack-provision: unknown option ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  options.rawInput = positional.join(' ').trim();
  if (!options.rawInput) {
    throw new Error('stack-provision: expected an ADR path or comma-separated stack list');
  }
  return options;
}

function requireValue(value, flag) {
  if (!value || value.startsWith('--')) {
    throw new Error(`stack-provision: ${flag} requires a value`);
  }
  return value;
}

function readInput(rawInput) {
  const path = resolve(rawInput);
  if (existsSync(path)) {
    const text = readFileSync(path, 'utf8');
    return {
      adrPath: path,
      stack: parseAdrStack(text),
    };
  }
  return {
    adrPath: null,
    stack: parseStackList(rawInput),
  };
}

function parseAdrStack(text) {
  const lines = text.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) =>
    /^#{2,4}\s+(decision|chosen stack|technology stack|stack)\b/i.test(line.trim()),
  );

  if (headingIndex === -1) {
    return parseStackList(text);
  }

  const block = [];
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^#{1,4}\s+/.test(line.trim())) {
      break;
    }
    block.push(line);
  }
  return parseStackList(block.join('\n'));
}

function parseStackList(value) {
  const entries = [];
  for (const line of value.split(/\r?\n/)) {
    const cleaned = line
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/^\s*\d+[.)]\s+/, '')
      .replace(/^\s*-\s*\[[ x]\]\s+/i, '')
      .replace(/[`*_]/g, '')
      .replace(/^[a-z][\w /-]{0,32}:\s+/i, '')
      .trim();

    if (!cleaned || /^#{1,6}\s/.test(cleaned)) {
      continue;
    }

    const source = cleaned.includes(',')
      ? cleaned
      : cleaned.replace(/\s+\|\s+/g, ',').replace(/\s+\+\s+/g, ',');

    for (const part of source.split(',')) {
      const candidate = normalizeTechnology(part);
      if (candidate) {
        entries.push(candidate);
      }
    }
  }
  return unique(entries);
}

function normalizeTechnology(value) {
  let normalized = value
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\b(v|version)\s*\d+(?:\.\d+)*\b/g, '')
    .replace(/\b\d+(?:\.\d+)*(?:\+|x)?\b/g, '')
    .replace(/\s+-\s+.*$/, '')
    .replace(/\s+for\s+.*$/, '')
    .replace(/[:;]+$/g, '')
    .trim();

  const aliases = new Map([
    ['nextjs', 'next.js'],
    ['next js', 'next.js'],
    ['reactjs', 'react'],
    ['nodejs', 'node'],
    ['postgresql', 'postgres'],
    ['tailwindcss', 'tailwind'],
    ['tailwind css', 'tailwind'],
    ['threejs', 'three.js'],
    ['framer motion', 'framer-motion'],
    ['github actions', 'github-actions'],
  ]);
  normalized = aliases.get(normalized) || normalized;

  return normalized
    .replace(/\s+/g, ' ')
    .replace(/^[^\w]+|[^\w. -]+$/g, '')
    .trim();
}

function normalizeSurfaceList(surfaces, config) {
  const known = new Set(Object.keys(config.surfaces));
  return unique(
    surfaces.map((surface) => {
      const normalized = surface.toLowerCase().trim();
      if (!known.has(normalized)) {
        throw new Error(`stack-provision: unknown surface "${surface}"`);
      }
      return normalized;
    }),
  );
}

function normalizeBlockList(blocks, config) {
  return unique(blocks.map((block) => normalizeBlock(block, config)));
}

function normalizeBlock(block, config) {
  const normalized = block.toLowerCase().trim().replace(/\s+/g, '-');
  const blocks = config.application_blocks || {};
  if (blocks[normalized]) {
    return blocks[normalized].canonical || normalized;
  }

  for (const [name, definition] of Object.entries(blocks)) {
    const aliases = definition.aliases || [];
    if (aliases.some((alias) => compact(alias) === compact(block))) {
      return definition.canonical || name;
    }
  }

  throw new Error(`stack-provision: unknown application block "${block}"`);
}

function inferApplicationBlocks(stack, config) {
  const blocks = config.application_blocks || {};
  const inferred = [];
  for (const [name, definition] of Object.entries(blocks)) {
    const aliases = [name, ...(definition.aliases || [])];
    const surfaceDefinition = definition.surface ? config.surfaces?.[definition.surface] : null;
    if (stack.some((technology) =>
      aliases.some((alias) => technologyMatches(technology, alias)) ||
      (surfaceDefinition && technologyMatchesSurface(technology, surfaceDefinition))
    )) {
      inferred.push(definition.canonical || name);
    }
  }
  return unique(inferred);
}

function surfacesForBlocks(blocks, config) {
  const blockDefinitions = config.application_blocks || {};
  return unique(
    blocks
      .map((block) => blockDefinitions[block]?.surface)
      .filter((surface) => surface && config.surfaces[surface]),
  );
}

function inferSurfaces(stack, config) {
  const inferred = [];
  for (const [surface, definition] of Object.entries(config.surfaces)) {
    if (stack.some((technology) => technologyMatchesSurface(technology, definition))) {
      inferred.push(surface);
    }
  }
  return inferred;
}

function selectSurfaces({ inferredSurfaces, explicitSurfaces, blockSurfaces, creativeIntent, surfacesOnly, config }) {
  const selected = surfacesOnly
    ? unique([...explicitSurfaces, ...blockSurfaces])
    : unique([...inferredSurfaces, ...explicitSurfaces, ...blockSurfaces]);

  if (creativeIntent && config.surfaces['visual-creative'] && !selected.includes('visual-creative')) {
    selected.push('visual-creative');
  }
  return selected;
}

function buildAspectsBySurface(surfaces, explicitAspects, creativeIntent, config) {
  const result = {};
  for (const surface of surfaces) {
    const defaults = config.surfaces[surface].default_aspects || [];
    const relevantExplicit = explicitAspects.filter((aspect) => defaults.includes(aspect));
    if (explicitAspects.length === 0) {
      result[surface] = defaults;
    } else if (surface === 'visual-creative' && creativeIntent) {
      result[surface] = unique([...relevantExplicit, ...defaults]);
    } else {
      result[surface] = relevantExplicit;
    }
  }
  return result;
}

function collectCapabilityPacks(surfaces, config) {
  return unique(
    surfaces.flatMap((surface) => config.surfaces[surface].capability_packs || []),
  );
}

function buildMatrixCells(stack, surfaces, aspectsBySurface, config) {
  const cells = [];
  for (const surface of surfaces) {
    const definition = config.surfaces[surface];
    const matchedStack = stack.filter((technology) => technologyMatchesSurface(technology, definition));
    const technologies = matchedStack.length > 0 ? matchedStack : [surface];

    for (const technology of technologies) {
      const aspects = aspectsForTechnology(technology, surface, aspectsBySurface[surface] || [], definition);
      for (const aspect of aspects) {
        cells.push({
          surface,
          technology,
          aspect,
          capability_packs: capabilityPacksForAspect(definition, aspect),
        });
      }
    }
  }
  return cells;
}

function aspectsForTechnology(technology, surface, baseAspects, definition) {
  if (technology === surface) {
    return baseAspects;
  }

  const profile = (definition.aspect_profiles || []).find((candidate) =>
    (candidate.tech_match || []).some((matcher) => technologyMatches(technology, matcher)),
  );
  if (!profile) {
    return baseAspects;
  }

  const allowed = new Set(profile.aspects || []);
  return baseAspects.filter((aspect) => allowed.has(aspect));
}

function capabilityPacksForAspect(definition, aspect) {
  const mapped = definition.aspect_capability_packs?.[aspect] || [];
  return mapped.length > 0 ? mapped : (definition.capability_packs || []);
}

function buildWeightedScorecard(stack, surfaces, applicationBlocks, config) {
  const maturityLeaders = new Set([
    'node', 'react', 'next.js', 'postgres', 'mysql', 'redis', 'supabase',
    'playwright', 'flutter', 'dart', 'go', 'rust', 'kafka', 'sentry',
  ].map(compact));
  const securityLeaders = new Set([
    'clerk', 'auth0', 'keycloak', 'supabase-auth', 'oidc', 'oauth', 'postgres',
    'stripe', 'sentry', 'opentelemetry',
  ].map(compact));
  const costHeavy = new Set([
    'datadog', 'newrelic', 'auth0', 'launchdarkly', 'optimizely', 'snowflake',
  ].map(compact));
  const perfLeaders = new Set([
    'rust', 'go', 'redis', 'kafka', 'postgres', 'flutter', 'node', 'fastify',
  ].map(compact));

  const cellsByTech = new Map();
  for (const [surface, definition] of Object.entries(config.surfaces || {})) {
    for (const matcher of definition.tech_match || []) {
      const key = compact(matcher);
      if (!cellsByTech.has(key)) {
        cellsByTech.set(key, new Set());
      }
      cellsByTech.get(key).add(surface);
    }
  }

  const items = stack.map((technology) => {
    const normalized = compact(technology);
    const matchedSurfaces = surfaces.filter((surface) =>
      technologyMatchesSurface(technology, config.surfaces[surface] || {}),
    );
    const discoveredSurfaceCount = [...cellsByTech.entries()]
      .filter(([matcher]) => matcher === normalized || normalized.startsWith(matcher) || matcher.startsWith(normalized))
      .reduce((count, [, set]) => count + set.size, 0);
    const productFit = clampScore(55 + matchedSurfaces.length * 15 + (applicationBlocks.length > 0 ? 5 : 0));
    const operability = clampScore(50 + discoveredSurfaceCount * 8);
    const ecosystemMaturity = maturityLeaders.has(normalized)
      ? 90
      : clampScore(58 + discoveredSurfaceCount * 7);
    const performance = perfLeaders.has(normalized)
      ? 88
      : clampScore(62 + Math.min(18, matchedSurfaces.length * 6));
    const securityCompliance = securityLeaders.has(normalized)
      ? 88
      : clampScore(64 + (applicationBlocks.includes('auth') || applicationBlocks.includes('finance-transactions') ? 8 : 0));
    const costEfficiency = costHeavy.has(normalized) ? 52 : 74;
    const weightedScore = Number(((
      productFit * WEIGHTED_SCORE_WEIGHTS.product_fit +
      operability * WEIGHTED_SCORE_WEIGHTS.operability +
      ecosystemMaturity * WEIGHTED_SCORE_WEIGHTS.ecosystem_maturity +
      performance * WEIGHTED_SCORE_WEIGHTS.performance +
      securityCompliance * WEIGHTED_SCORE_WEIGHTS.security_compliance +
      costEfficiency * WEIGHTED_SCORE_WEIGHTS.cost_efficiency
    )).toFixed(3));

    return {
      technology,
      criteria: {
        product_fit: productFit,
        operability,
        ecosystem_maturity: ecosystemMaturity,
        performance,
        security_compliance: securityCompliance,
        cost_efficiency: costEfficiency,
      },
      matched_surfaces: matchedSurfaces,
      weighted_score: weightedScore,
    };
  }).sort((a, b) => b.weighted_score - a.weighted_score || a.technology.localeCompare(b.technology));

  const top2Gap = items.length >= 2
    ? Number((items[0].weighted_score - items[1].weighted_score).toFixed(3))
    : 100;

  return {
    schema_version: 1,
    weights: WEIGHTED_SCORE_WEIGHTS,
    items,
    summary: {
      top_technology: items[0]?.technology || null,
      top_score: items[0]?.weighted_score || 0,
      top2_gap: top2Gap,
    },
  };
}

function buildCompatibilityReport({ stack, surfaces, applicationBlocks }) {
  const normalizedStack = new Set(stack.map(compact));
  const hasAny = (values) => values.some((value) => normalizedStack.has(compact(value)));
  const blocks = [];
  if (applicationBlocks.includes('auth')) blocks.push('auth');
  if (applicationBlocks.includes('product-analytics')) blocks.push('analytics');
  if (hasAny(['telemetry', 'opentelemetry', 'sentry', 'datadog', 'newrelic'])) blocks.push('telemetry');
  if (surfaces.some((surface) => ['frontend-engineering', 'frontend-product', 'visual-creative'].includes(surface))) {
    blocks.push('frontend-core');
  }
  if (surfaces.some((surface) => ['backend', 'auth-identity', 'product-analytics', 'finance-transactions', 'data-ai', 'mobile'].includes(surface))) {
    blocks.push('backend-core');
  }
  if (hasAny(['graphql', 'rest', 'queue', 'kafka', 'webhook', 'gql', 'ffi', 'foreign-function-interface', 'edge-runtime', 'cloudflare-workers', 'workerd'])) {
    blocks.push('integration-layer');
  }

  const keyBlocks = unique(blocks);
  const pairs = [];
  for (let left = 0; left < keyBlocks.length; left += 1) {
    for (let right = left + 1; right < keyBlocks.length; right += 1) {
      const a = keyBlocks[left];
      const b = keyBlocks[right];
      const reasons = [];
      const blockers = [];
      let status = 'compatible';

      const hasFfi = hasAny(['ffi', 'foreign-function-interface']);
      const edgeRuntime = hasAny(['edge-runtime', 'cloudflare-workers', 'workerd', 'deno-deploy']);
      if (hasFfi && edgeRuntime) {
        status = 'blocked';
        blockers.push('abi-ffi-runtime-conflict');
        reasons.push('FFI/ABI integration is incompatible with edge sandbox runtimes.');
      }

      const mixedNativeStacks = hasAny(['react-native']) && hasAny(['flutter']);
      if (status !== 'blocked' && mixedNativeStacks && (a === 'frontend-core' || b === 'frontend-core')) {
        status = 'blocked';
        blockers.push('runtime-toolchain-conflict');
        reasons.push('React Native and Flutter together introduce conflicting native runtime/toolchain requirements.');
      }

      const missingTelemetry = !hasAny(['opentelemetry', 'sentry', 'datadog', 'newrelic']);
      if (status === 'compatible' && ((a === 'telemetry' && b === 'backend-core') || (b === 'telemetry' && a === 'backend-core')) && missingTelemetry) {
        status = 'unknown';
        reasons.push('Telemetry block exists without a concrete telemetry stack decision.');
      }

      if (status === 'compatible' && ((a === 'auth' && b === 'analytics') || (a === 'analytics' && b === 'auth'))) {
        status = 'risky';
        reasons.push('Auth and analytics require explicit privacy-safe instrumentation and consent boundaries.');
      }

      if (status === 'compatible' && hasFfi && !hasAny(['rust', 'c', 'cpp', 'node'])) {
        status = 'unknown';
        reasons.push('FFI is present without explicit runtime/toolchain pairing evidence.');
      }

      pairs.push({
        left: a,
        right: b,
        status,
        reasons,
        blockers,
      });
    }
  }

  const summary = {
    total_pairs: pairs.length,
    compatible_pairs: pairs.filter((pair) => pair.status === 'compatible').length,
    risky_pairs: pairs.filter((pair) => pair.status === 'risky').length,
    blocked_pairs: pairs.filter((pair) => pair.status === 'blocked').length,
    unknown_pairs: pairs.filter((pair) => pair.status === 'unknown').length,
    critical_unknown_pairs: pairs.filter((pair) =>
      pair.status === 'unknown' && (
        pair.left === 'auth' || pair.right === 'auth' ||
        pair.left === 'backend-core' || pair.right === 'backend-core' ||
        pair.left === 'integration-layer' || pair.right === 'integration-layer'
      )
    ).length,
  };

  let overallStatus = 'compatible';
  if (summary.blocked_pairs > 0) {
    overallStatus = 'blocked';
  } else if (summary.unknown_pairs > 0) {
    overallStatus = 'unknown';
  } else if (summary.risky_pairs > 0) {
    overallStatus = 'risky';
  }

  return {
    schema_version: 1,
    key_blocks: keyBlocks,
    pairs,
    summary,
    overall_status: overallStatus,
  };
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Number(value)));
}

function technologyMatchesSurface(technology, definition) {
  return (definition.tech_match || []).some((matcher) => {
    return technologyMatches(technology, matcher);
  });
}

function technologyMatches(technology, matcher) {
  const normalizedTechnology = compact(technology);
  const normalizedMatcher = compact(matcher);
  return (
    normalizedTechnology === normalizedMatcher ||
    (normalizedMatcher.length >= 5 && (
      normalizedTechnology.startsWith(normalizedMatcher) ||
      normalizedTechnology.endsWith(normalizedMatcher)
    ))
  );
}

function compact(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildOutput(outRoot, runId, contract, capabilityMatrix, reviewMarkdown) {
  const absoluteOutRoot = resolve(outRoot);
  const runDir = join(absoluteOutRoot, runId);
  const provisionRoot = dirname(absoluteOutRoot);
  const pipelineProfile = inferPipelineProfile(contract.surfaces || []);
  const compatibilityStatus = normalizeCompatibilityStatus(contract.compatibility_report?.overall_status);
  const confidence = Number((((contract.weighted_scorecard?.summary?.top_score || 0) / 100)).toFixed(3));
  const artifacts = {
    run_dir: runDir,
    contract: join(runDir, 'contract.json'),
    capability_matrix: join(runDir, 'capability-matrix.json'),
    state: join(runDir, 'state.json'),
    review: join(runDir, 'review.md'),
    current: join(provisionRoot, 'current.json'),
  };
  const state = {
    schema_version: 1,
    run_id: runId,
    status: contract.policy.dry_run ? 'dry_run' : 'initialized',
    current_phase: 'contract',
    pipeline_profile: pipelineProfile,
    current_subphase: 'intake',
    strategy_iteration: 1,
    rewind_count: 0,
    max_rewinds: contract.policy.max_rewinds ?? 2,
    risk_level: riskLevelFromCompatibility(compatibilityStatus),
    confidence,
    research_required: contract.policy.research_required === true,
    compatibility_status: compatibilityStatus,
    provisioning_mode: contract.policy.provisioning_mode || 'strict-gate',
    created_at: contract.created_at,
    artifacts,
  };

  return {
    artifacts,
    contract,
    capabilityMatrix,
    reviewMarkdown,
    state,
    current: {
      schema_version: 1,
      run_id: runId,
      run_dir: runDir,
      updated_at: contract.created_at,
    },
  };
}

function inferPipelineProfile(surfaces) {
  const normalized = new Set((surfaces || []).map((surface) => String(surface).toLowerCase()));
  if (
    normalized.has('frontend-engineering') ||
    normalized.has('frontend-product') ||
    normalized.has('visual-creative')
  ) {
    return 'product-pipeline';
  }
  if (normalized.has('backend') || normalized.has('auth-identity') || normalized.has('finance-transactions')) {
    return 'backend-pipeline';
  }
  return 'default';
}

function normalizeCompatibilityStatus(value) {
  if (value === 'blocked' || value === 'unknown' || value === 'risky' || value === 'compatible') {
    return value;
  }
  return 'unknown';
}

function riskLevelFromCompatibility(status) {
  if (status === 'blocked') return 'critical';
  if (status === 'unknown') return 'high';
  if (status === 'risky') return 'medium';
  return 'low';
}

function writeRun(output) {
  mkdirSync(output.artifacts.run_dir, { recursive: true });
  writeJsonValidated(output.artifacts.contract, output.contract, 'contract');
  writeJsonValidated(output.artifacts.capability_matrix, output.capabilityMatrix, 'capability-matrix');
  writeJson(output.artifacts.state, output.state);
  writeFileSync(output.artifacts.review, output.reviewMarkdown, 'utf8');
  writeJson(output.artifacts.current, output.current);
}

function buildReviewMarkdown(contract, capabilityMatrix, config) {
  const packRows = contract.capability_packs
    .map((pack) => {
      const details = config.capability_packs[pack] || {};
      const agents = (details.agents || []).join(', ') || 'none';
      const skills = (details.skills || []).join(', ') || 'none';
      const external = details.optional_external ? 'yes' : 'no';
      return `| ${pack} | ${agents} | ${skills} | ${external} |`;
    })
    .join('\n');

  const surfaceRows = contract.surfaces
    .map((surface) => {
      const aspects = (contract.aspects_by_surface[surface] || []).join(', ');
      return `| ${surface} | ${aspects} |`;
    })
    .join('\n');

  const blockRows = (contract.application_blocks || [])
    .map((block) => {
      const surface = config.application_blocks?.[block]?.surface || 'unknown';
      return `| ${block} | ${surface} |`;
    })
    .join('\n') || '| none | none |';
  const scoreRows = (contract.weighted_scorecard?.items || [])
    .map((item) => {
      return `| ${item.technology} | ${item.criteria.product_fit} | ${item.criteria.operability} | ${item.criteria.ecosystem_maturity} | ${item.criteria.performance} | ${item.criteria.security_compliance} | ${item.criteria.cost_efficiency} | ${item.weighted_score} |`;
    })
    .join('\n') || '| none | 0 | 0 | 0 | 0 | 0 | 0 | 0 |';
  const compatibilityRows = (contract.compatibility_report?.pairs || [])
    .map((pair) => {
      return `| ${pair.left} | ${pair.right} | ${pair.status} | ${(pair.reasons || []).join('; ') || 'none'} |`;
    })
    .join('\n') || '| none | none | compatible | none |';

  const visualSection = contract.surfaces.includes('visual-creative')
    ? `
## Visual-Creative Contract

Use this surface for art direction, visual language, inspiration synthesis, generated bitmap assets, iconography, typography, illustration, motion, and visual QA. Load only the context files that exist:

${(config.surfaces['visual-creative'].required_context || []).map((item) => `- ${item}`).join('\n')}
`
    : '';

  return `# Stack Provision Review - ${contract.run_id}

## Input

- Created: ${contract.created_at}
- Raw input: ${contract.input.raw}
- ADR path: ${contract.input.adr_path || 'none'}
- Dry run: ${String(contract.policy.dry_run)}
- Generated installs allowed by default: ${String(contract.policy.allow_generated_install_by_default)}
- Provisioning mode: ${contract.policy.provisioning_mode}
- Critic verdict required: ${String(contract.policy.critic_required)}
- Research required before provisioning: ${String(contract.policy.research_required)}

## Stack

${contract.stack.map((technology) => `- ${technology}`).join('\n')}

## Capability Surfaces

| Surface | Aspects |
| --- | --- |
${surfaceRows}

## Application Blocks

| Block | Surface |
| --- | --- |
${blockRows}

## Capability Packs

| Pack | Agents | Skills | Optional external |
| --- | --- | --- | --- |
${packRows}
## Weighted Scorecard

Weights: Product Fit 30%, Operability 20%, Ecosystem Maturity 20%, Performance 15%, Security/Compliance 10%, Cost 5%.

| Technology | Product Fit | Operability | Ecosystem | Performance | Security | Cost | Weighted |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${scoreRows}

Top-2 score gap: ${contract.weighted_scorecard?.summary?.top2_gap ?? 'n/a'}

## Compatibility Report

Overall status: ${contract.compatibility_report?.overall_status || 'unknown'}

| Left block | Right block | Status | Notes |
| --- | --- | --- | --- |
${compatibilityRows}

Critical unknown pairs: ${contract.compatibility_report?.summary?.critical_unknown_pairs ?? 0}

${visualSection}
## Matrix Summary

- Surfaces: ${contract.surfaces.length}
- Capability packs: ${contract.capability_packs.length}
- Matrix cells: ${capabilityMatrix.cells.length}
- Human review gate: required
- Quarantine before promotion: required

## Next Phases

1. Run discovery against this capability matrix.
2. Score candidates by source, provenance, freshness, maintenance, coverage, and prompt-injection risk.
3. Write candidates and generated drafts only under this run directory.
4. Present the install plan for explicit human approval.
5. Promote approved items and write manifest.json only after critic-approved review.
6. Enforce strict gate before install: source trust >= 0.85, freshness <= 180 days, checksum valid, no license conflict.
`;
}

function makeRunId(stack, surfaces, createdAt) {
  const date = createdAt.slice(0, 10);
  const slug = sanitizeSlug([...stack.slice(0, 3), ...surfaces.slice(0, 2)].join('-'));
  const hash = createHash('sha256')
    .update(JSON.stringify({ stack, surfaces, createdAt }))
    .digest('hex')
    .slice(0, 8);
  return `${date}-${slug}-${hash}`;
}

function sanitizeSlug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

function splitList(value) {
  return unique(
    String(value)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function unique(values) {
  return [...new Set(values)];
}

function emit(result) {
  if (result.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Stack provision run: ${result.run_id}`);
  console.log(`Stack: ${result.stack.join(', ')}`);
  console.log(`Surfaces: ${result.surfaces.join(', ')}`);
  console.log(`Capability packs: ${result.capability_packs.join(', ')}`);
  if (result.dry_run) {
    console.log('Dry run: no files written');
  } else {
    console.log(`Run directory: ${result.artifacts.run_dir}`);
    console.log(`Review: ${result.artifacts.review}`);
  }
}
