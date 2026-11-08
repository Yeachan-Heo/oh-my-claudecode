#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessRisk } from './risk-assess.mjs';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--commit' || arg === '--staged' || arg === '--staged-only') options.stagedOnly = true;
    else if (arg === '--context') options.context = argv[++index];
    else if (arg === '--cwd') options.cwd = argv[++index];
    else if (arg === '--json') options.json = true;
  }
  if (!options.context && process.env.OMC_REVIEW_GATE_CONTEXT) {
    options.context = process.env.OMC_REVIEW_GATE_CONTEXT;
  }
  if (options.context === 'commit') options.stagedOnly = true;
  return options;
}

export function evaluateReviewGate(options = {}) {
  const risk = assessRisk(options);
  if (risk.level === 'unknown') {
    return { action: 'BLOCK', exitCode: 2, message: `Review gate could not assess risk: ${risk.reason}`, risk };
  }
  if (risk.level === 'none' || risk.level === 'low') {
    return { action: 'ALLOW', exitCode: 0, message: `Review gate passed: ${risk.reason}`, risk };
  }
  if (risk.level === 'critical' || risk.level === 'high') {
    return { action: 'BLOCK', exitCode: 2, message: `Review required for ${risk.level}-risk changes: ${risk.reason}`, risk };
  }
  return { action: 'WARN', exitCode: 1, message: `Review recommended for medium-risk changes: ${risk.reason}`, risk };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const options = parseArgs(process.argv.slice(2));
  const result = evaluateReviewGate(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result.message);
  }
  process.exit(result.exitCode);
}
