#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonValidated, validateData, writeJson, writeJsonValidated } from './validation.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultConfigPath = resolve(scriptDir, '..', 'config', 'default-capability-packs.json');
const defaultOutRoot = '.omc/provisioned/runs';

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
  const surfaces = selectSurfaces({
    inferredSurfaces,
    explicitSurfaces,
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
    creative_intent: options.creativeIntent,
    aspects_by_surface: aspectsBySurface,
    capability_packs: capabilityPacks,
    policy: {
      human_gate_required: true,
      quarantine_required: true,
      allow_generated_install_by_default: false,
      dry_run: options.dryRun,
      no_generate: options.noGenerate,
    },
  };

  const capabilityMatrix = {
    schema_version: 1,
    run_id: runId,
    surfaces,
    capability_packs: capabilityPacks,
    cells: buildMatrixCells(stack, surfaces, aspectsBySurface, config, explicitSurfaces),
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

function inferSurfaces(stack, config) {
  const inferred = [];
  for (const [surface, definition] of Object.entries(config.surfaces)) {
    if (stack.some((technology) => technologyMatchesSurface(technology, definition))) {
      inferred.push(surface);
    }
  }
  return inferred;
}

function selectSurfaces({ inferredSurfaces, explicitSurfaces, creativeIntent, surfacesOnly, config }) {
  const selected = surfacesOnly
    ? explicitSurfaces
    : unique([...inferredSurfaces, ...explicitSurfaces]);

  if (creativeIntent && config.surfaces['visual-creative'] && !selected.includes('visual-creative')) {
    selected.push('visual-creative');
  }
  return selected;
}

function buildAspectsBySurface(surfaces, explicitAspects, creativeIntent, config) {
  const result = {};
  for (const surface of surfaces) {
    const defaults = config.surfaces[surface].default_aspects || [];
    if (explicitAspects.length === 0) {
      result[surface] = defaults;
    } else if (surface === 'visual-creative' && creativeIntent) {
      result[surface] = unique([...explicitAspects, ...defaults]);
    } else {
      result[surface] = explicitAspects;
    }
  }
  return result;
}

function collectCapabilityPacks(surfaces, config) {
  return unique(
    surfaces.flatMap((surface) => config.surfaces[surface].capability_packs || []),
  );
}

function buildMatrixCells(stack, surfaces, aspectsBySurface, config, explicitSurfaces) {
  const explicitSet = new Set(explicitSurfaces);
  const cells = [];
  for (const surface of surfaces) {
    const definition = config.surfaces[surface];
    const matchedStack = stack.filter((technology) => technologyMatchesSurface(technology, definition));
    const technologies = matchedStack.length > 0 || !explicitSet.has(surface)
      ? matchedStack
      : stack;

    for (const technology of technologies) {
      for (const aspect of aspectsBySurface[surface] || []) {
        cells.push({
          surface,
          technology,
          aspect,
          capability_packs: definition.capability_packs || [],
        });
      }
    }
  }
  return cells;
}

function technologyMatchesSurface(technology, definition) {
  const normalizedTechnology = compact(technology);
  return (definition.tech_match || []).some((matcher) => {
    const normalizedMatcher = compact(matcher);
    return (
      normalizedTechnology === normalizedMatcher ||
      normalizedTechnology.includes(normalizedMatcher)
    );
  });
}

function compact(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildOutput(outRoot, runId, contract, capabilityMatrix, reviewMarkdown) {
  const absoluteOutRoot = resolve(outRoot);
  const runDir = join(absoluteOutRoot, runId);
  const provisionRoot = dirname(absoluteOutRoot);
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

## Stack

${contract.stack.map((technology) => `- ${technology}`).join('\n')}

## Capability Surfaces

| Surface | Aspects |
| --- | --- |
${surfaceRows}

## Capability Packs

| Pack | Agents | Skills | Optional external |
| --- | --- | --- | --- |
${packRows}
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
5. Promote approved items and write manifest.json only after approval.
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
