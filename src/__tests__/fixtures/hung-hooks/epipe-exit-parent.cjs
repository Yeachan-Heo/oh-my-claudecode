'use strict';

const { spawn } = require('node:child_process');
const { join } = require('node:path');

const pidfile = process.env.OMC_TEST_PIDFILE || process.argv[2];
if (!pidfile) throw new Error('OMC_TEST_PIDFILE or argv[2] is required');

process.stdout.on('error', () => process.exit(0));
process.stderr.on('error', () => process.exit(0));

spawn(process.execPath, [join(__dirname, 'hung-grandchild.cjs'), pidfile], {
  detached: false,
  stdio: 'ignore',
  env: process.env,
});

setInterval(() => {
  process.stdout.write('tick\n');
}, 200);
