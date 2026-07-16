'use strict';

const { writeFileSync } = require('node:fs');

const pidfile = process.env.OMC_TEST_PIDFILE || process.argv[2];
if (!pidfile) throw new Error('OMC_TEST_PIDFILE or argv[2] is required');
writeFileSync(pidfile, String(process.pid));
setInterval(() => {}, 1e9);
