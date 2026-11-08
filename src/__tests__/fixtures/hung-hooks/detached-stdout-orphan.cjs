'use strict';

const { spawn } = require('node:child_process');

const pidfile = process.env.OMC_TEST_PIDFILE || process.argv[2];
if (!pidfile) throw new Error('OMC_TEST_PIDFILE or argv[2] is required');

process.stdout.write('hook-ready\n');
process.stderr.write('hook-stderr\n');

const child = spawn(process.execPath, ['-e', `
  const { writeFileSync } = require('node:fs');
  writeFileSync(process.argv[1], String(process.pid));
  setInterval(() => {}, 1e9);
`, pidfile], {
  detached: true,
  stdio: 'inherit',
  windowsHide: true,
  env: process.env,
});
child.unref();
setInterval(() => {}, 1e9);
