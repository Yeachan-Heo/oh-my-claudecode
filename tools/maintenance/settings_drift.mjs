#!/usr/bin/env node
// Compare the OMC part of a settings.json with a reference template and report the differences.
//
//   node settings_drift.mjs --template <file> [--config-dir <dir>] [--settings <file>] [--machine-specific <KEY>]...
//
// --template          reference template (required); format in tools/maintenance/README.md
// --config-dir        Claude Code configuration directory (default $CLAUDE_CONFIG_DIR or ~/.claude); settings.json is read from it
// --settings          settings.json file directly (wins over --config-dir)
// --machine-specific  env key whose value belongs to the machine (a path, for example); only its presence is compared and its
//                     value is never printed. Repeatable; adds to the template's `machine_specific` list
// Exit code: 0 no differences, 1 differences found, 2 error (missing file, bad JSON, bad usage). Node 20+, built-in modules only.
//
// Safety: reads only the OMC_* keys of `env`, `modelSettings.*.autoCompactWindow`, the top-level `autoCompactWindow` and the
// env keys the template lists. It prints no other key. Values of machine-specific keys are not printed, only their presence;
// values of keys with key/token/secret/password in the name are hidden.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const USAGE = 'usage: node settings_drift.mjs --template <file> [--config-dir <dir>] [--settings <file>] [--machine-specific <KEY>]...';

function parseArgs(argv) {
  const opts = { configDir: null, template: null, settings: null, machineSpecific: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) { console.error(`missing value for ${a}`); process.exit(2); }
      return v;
    };
    if (a === '--config-dir') opts.configDir = value();
    else if (a === '--template') opts.template = value();
    else if (a === '--settings') opts.settings = value();
    else if (a === '--machine-specific') opts.machineSpecific.push(value());
    else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else { console.error(`unknown option: ${a}`); process.exit(2); }
  }
  return opts;
}

function load(file, label) {
  if (!existsSync(file)) { console.error(`missing file (${label}): ${file}`); process.exit(2); }
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { console.error(`bad JSON (${label}): ${file}: ${e.message}`); process.exit(2); }
}

const secret = (name) => /key|token|secret|passw/i.test(name);
const show = (name, v) => (secret(name) ? '<hidden>' : JSON.stringify(v));

const opts = parseArgs(process.argv.slice(2));
if (!opts.template) { console.error(`--template is required\n${USAGE}`); process.exit(2); }
const configDir = opts.configDir || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const settingsFile = resolve(opts.settings || join(configDir, 'settings.json'));
const templateFile = resolve(opts.template);
const template = load(templateFile, 'template');
const settings = load(settingsFile, 'settings.json');

const templateEnv = template.env && typeof template.env === 'object' ? template.env : {};
const machineSpecific = new Set([...(Array.isArray(template.machine_specific) ? template.machine_specific : []), ...opts.machineSpecific]);
const env = settings.env && typeof settings.env === 'object' ? settings.env : {};
const differences = [];
let matching = 0;

for (const [k, expected] of Object.entries(templateEnv)) {
  if (machineSpecific.has(k)) { if (k in env) matching++; } // presence only; a missing one is reported below, without the template value
  else if (!(k in env)) differences.push(`env ${k}: missing in settings (template ${show(k, expected)})`);
  else if (String(env[k]) !== String(expected)) differences.push(`env ${k}: settings ${show(k, env[k])}, template ${show(k, expected)}`);
  else matching++;
}
for (const k of Object.keys(env)) {
  if (!k.startsWith('OMC_')) continue;
  if (k in templateEnv) continue;
  if (machineSpecific.has(k)) { matching++; continue; } // presence is enough, the value belongs to the machine (not printed)
  differences.push(`env ${k}: present in settings (${show(k, env[k])}), not in the template`);
}
for (const k of machineSpecific) if (!(k in env)) differences.push(`env ${k}: missing in settings (machine-specific variable, the value belongs to the machine)`);
for (const k of Array.isArray(template.forbidden_env) ? template.forbidden_env : []) {
  if (k in env) differences.push(`env ${k}: set in settings (${show(k, env[k])}), the template forbids it (it wins over modelSettings)`);
  else matching++;
}

const modelSettings = settings.modelSettings && typeof settings.modelSettings === 'object' ? settings.modelSettings : {};
const templateModelSettings = template.modelSettings && typeof template.modelSettings === 'object' ? template.modelSettings : {};
for (const [model, fields] of Object.entries(templateModelSettings)) {
  for (const [field, expected] of Object.entries(fields || {})) {
    const actual = modelSettings[model] && modelSettings[model][field];
    if (actual === undefined) differences.push(`modelSettings.${model}.${field}: missing in settings (template ${JSON.stringify(expected)})`);
    else if (actual !== expected) differences.push(`modelSettings.${model}.${field}: settings ${JSON.stringify(actual)}, template ${JSON.stringify(expected)}`);
    else matching++;
  }
}
if (template.no_top_level_autoCompactWindow) {
  if ('autoCompactWindow' in settings) differences.push(`autoCompactWindow (top level): ${JSON.stringify(settings.autoCompactWindow)} in settings, the template wants no top-level value (it can mislead where modelSettings applies)`);
  else matching++;
}

console.log(`settings: ${settingsFile}`);
console.log(`template: ${templateFile}`);
console.log(`matching entries: ${matching}, differences: ${differences.length}`);
for (const d of differences) console.log(`  DIFFERENCE ${d}`);
process.exit(differences.length ? 1 : 0);
