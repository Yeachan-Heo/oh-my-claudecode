import Ajv2020 from 'ajv/dist/2020.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const schemaDir = resolve(scriptDir, '..', 'schemas');
const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  validateFormats: false,
});
const validators = new Map();

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function readJsonValidated(path, schemaName, label = path) {
  const value = readJson(path);
  validateData(schemaName, value, label);
  return value;
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function writeJsonValidated(path, value, schemaName, label = path) {
  validateData(schemaName, value, label);
  writeJson(path, value);
}

export function validateData(schemaName, value, label = schemaName) {
  const validate = validatorFor(schemaName);
  if (validate(value)) {
    return;
  }

  const details = (validate.errors || [])
    .map((error) => {
      const location = error.instancePath || '/';
      return `${location} ${error.message}`;
    })
    .join('; ');
  throw new Error(`stack-provision: ${label} failed ${schemaName} schema validation: ${details}`);
}

function validatorFor(schemaName) {
  if (validators.has(schemaName)) {
    return validators.get(schemaName);
  }

  const path = join(schemaDir, `${schemaName}.schema.json`);
  if (!existsSync(path)) {
    throw new Error(`stack-provision: schema not found: ${path}`);
  }
  const schema = readJson(path);
  const validate = ajv.compile(schema);
  validators.set(schemaName, validate);
  return validate;
}
