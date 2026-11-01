'use strict';
/**
 * Windows executable search hardening (CJS hook runtime).
 * Source of truth: src/utils/windows-search.ts — keep in sync.
 */

const VARIABLE = 'NoDefaultCurrentDirectoryInExePath';

function isVariable(key) {
  return key.toUpperCase() === VARIABLE.toUpperCase();
}

function hardenWindowsExeSearch() {
  if (process.platform !== 'win32') return;
  for (const key of Object.keys(process.env)) {
    if (isVariable(key)) delete process.env[key];
  }
  process.env[VARIABLE] = '1';
}

function childEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (process.platform !== 'win32' || !isVariable(key)) out[key] = value;
  }
  if (process.platform === 'win32') out[VARIABLE] = '1';
  return out;
}

module.exports = { hardenWindowsExeSearch, childEnv };
