#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MONKEY_DIR = join(homedir(), '.omc-monkey');
const PID_FILE = join(MONKEY_DIR, 'state', 'monkey.pid');
const LOG_FILE = join(MONKEY_DIR, 'monkey.log');
// TODO: align LOG_FILE with config.ts getLogPath() -> ~/.omc-monkey/logs/monkey.log

function ensureDir() {
  if (!existsSync(MONKEY_DIR)) {
    mkdirSync(MONKEY_DIR, { recursive: true });
  }
}

function isRunning() {
  if (!existsSync(PID_FILE)) return false;
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
    process.kill(pid, 0); // Check if process exists
    return true;
  } catch {
    // Process doesn't exist, clean up stale PID file
    try { unlinkSync(PID_FILE); } catch {}
    return false;
  }
}

function start() {
  ensureDir();
  mkdirSync(join(MONKEY_DIR, 'state'), { recursive: true });
  if (isRunning()) {
    console.log('monkey is already running');
    process.exit(1);
  }

  const serverPath = join(__dirname, '..', 'dist', 'index.js');
  const child = spawn('node', [serverPath], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env }
  });

  writeFileSync(PID_FILE, String(child.pid));
  child.unref();

  console.log(`monkey started (PID: ${child.pid})`);
}

function stop() {
  if (!isRunning()) {
    console.log('monkey is not running');
    return;
  }

  const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
  try {
    process.kill(pid, 'SIGTERM');
    unlinkSync(PID_FILE);
    console.log('monkey stopped');
  } catch (err) {
    console.error('Failed to stop monkey:', err.message);
  }
}

function status() {
  if (isRunning()) {
    const pid = readFileSync(PID_FILE, 'utf8').trim();
    console.log(`monkey is running (PID: ${pid})`);
  } else {
    console.log('monkey is not running');
  }
}

const command = process.argv[2];

switch (command) {
  case 'start':
    start();
    break;
  case 'stop':
    stop();
    break;
  case 'status':
    status();
    break;
  default:
    console.log('Usage: monkey <start|stop|status>');
    process.exit(1);
}
