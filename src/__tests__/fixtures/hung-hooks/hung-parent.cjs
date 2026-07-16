'use strict';

const { spawn } = require('node:child_process');
const { join } = require('node:path');

const pidfile = process.env.OMC_TEST_PIDFILE || process.argv[2];
spawn(process.execPath, [join(__dirname, 'hung-grandchild.cjs'), pidfile], {
  detached: false,
  stdio: 'ignore',
  env: process.env,
});
setInterval(() => {}, 1e9);
