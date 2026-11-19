#!/usr/bin/env node
/**
 * Settings merge tool.
 *
 * Merges one or more JSON merge patches (RFC 7396: `null` deletes a key,
 * plain objects merge recursively, arrays and other values replace) into a
 * settings JSON file and writes the result atomically (temp file in the same
 * directory, then rename), so the destination only ever holds a complete file.
 * The input file is never modified: the result goes to `--output`, so the
 * input doubles as the backup copy.
 *
 * Prints the change list on stdout (path, before -> after). Values whose key
 * looks secret-like or whose JSON form is longer than 200 characters are
 * printed as <redacted>.
 *
 * Usage:
 *   node scripts/settings-merge.mjs --settings <file> --output <file> \
 *     [--patch <file> ...] [--template-out <file> --template <file>]
 *
 * Exit codes: 0 done, 2 error (invalid patch or template JSON, missing file,
 * bad arguments); the settings file itself is parsed without a guard, so
 * invalid settings JSON fails with an uncaught error.
 * Node 20+, built-in modules only.
 */

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const finish = (code, text) => {
  if (text) (code === 0 ? console.log : console.error)(text);
  process.exit(code);
};
const BOM = String.fromCharCode(0xfeff);
const readJsonFile = (file) => {
  if (!existsSync(file)) finish(2, `Missing file ${file}`);
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(new RegExp('^' + BOM), ''));
  } catch (error) {
    return finish(2, `${file}: invalid JSON (${error.message})`);
  }
};

const isPlainObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

const hasSecretKey = (value) => {
  if (Array.isArray(value)) return value.some(hasSecretKey);
  if (!isPlainObject(value)) return false;
  for (const key of Object.keys(value)) {
    if (/key|token|secret|pass|auth|credential/i.test(key)) return true;
    if (hasSecretKey(value[key])) return true;
  }
  return false;
};

const mask = (path, value) => {
  const text = JSON.stringify(value);
  if (/key|token|secret|pass|auth|credential/i.test(path) || text === undefined || text.length > 200 || hasSecretKey(value)) return '<redacted>';
  return text;
};

const changes = [];
const args = { settings: null, output: null, patches: [], templateOut: null, template: null };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const next = () => argv[++i] ?? finish(2, `Missing value for ${argv[i - 1]}`);
  if (argv[i] === '--settings') args.settings = resolve(next());
  else if (argv[i] === '--output') args.output = resolve(next());
  else if (argv[i] === '--patch') args.patches.push(resolve(next()));
  else if (argv[i] === '--template-out') args.templateOut = resolve(next());
  else if (argv[i] === '--template') args.template = resolve(next());
  else finish(2, `Unknown argument: ${argv[i]}`);
}
if (!args.settings || !args.output) finish(2, 'Usage: settings-merge.mjs --settings <file> --output <file> [--patch <file> ...] [--template-out <file> --template <file>]');
if (args.templateOut && !args.template) finish(2, '--template-out requires --template <file>');
// RFC 7396 merge with comment keys; records changes (path, before, after).
function mergePatch(target, patch, prefix) {
  for (const [key, value] of Object.entries(patch)) {
    if (key.startsWith('_')) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (value === null) {
      if (key in target) {
        changes.push([path, mask(path, target[key]), '(deleted)']);
        delete target[key];
      }
    } else if (isPlainObject(value)) {
      if (!isPlainObject(target[key])) {
        if (key in target) changes.push([path, mask(path, target[key]), '(object)']);
        target[key] = {};
      }
      mergePatch(target[key], value, path);
    } else if (JSON.stringify(target[key]) !== JSON.stringify(value)) {
      changes.push([path, key in target ? mask(path, target[key]) : '(missing)', mask(path, value)]);
      target[key] = value;
    }
  }
}

const inputText = readFileSync(args.settings, 'utf8');
let result = JSON.parse(inputText.replace(new RegExp('^' + BOM), ''));
for (const patchFile of args.patches) mergePatch(result, readJsonFile(patchFile), '');
const inputMode = statSync(args.settings).mode & 0o777;
const writeAtomically = (file, text, mode) => {
  const tmp = `${file}.settings-merge-${process.pid}.tmp`;
  const fd = openSync(tmp, 'wx', mode);
  try {
    writeFileSync(fd, text, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // Windows may briefly reject rename (antivirus, open handle); 5 attempts 150 ms apart.
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(tmp, file);
      break;
    } catch (error) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) {
        try {
          unlinkSync(tmp);
        } catch {
          /* nothing to clean up */
        }
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    }
  }
};

writeAtomically(args.output, JSON.stringify(result, null, 2) + '\n', inputMode);
for (const [path, before, after] of changes) console.log(`${path}: ${before} -> ${after}`);
console.log(`changes: ${changes.length}; output: ${args.output}`);
if (args.templateOut) {
  const template = readJsonFile(args.template);
  const machineEnv = new Set(template.machineEnv || []);
  const env = {};
  for (const [key, value] of Object.entries(result.env || {})) {
    if (/^OMC_/.test(key) && !machineEnv.has(key) && typeof value === 'string') env[key] = value;
  }
  const modelSettings = {};
  for (const [model, config] of Object.entries(result.modelSettings || {})) {
    if (isPlainObject(config) && config.autoCompactWindow !== undefined) modelSettings[model] = { autoCompactWindow: config.autoCompactWindow };
  }
  const next = { ...template, env, modelSettings };
  if (result.autoCompactWindow !== undefined) next.autoCompactWindow = result.autoCompactWindow;
  else delete next.autoCompactWindow;
  writeAtomically(args.templateOut, JSON.stringify(next, null, 2) + '\n', 0o644);
  console.log(`template: ${args.templateOut} (${Object.keys(env).length} OMC_* keys)`);
}
