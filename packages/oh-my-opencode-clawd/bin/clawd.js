#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CLAWD_DIR = join(homedir(), '.clawd');
const PID_FILE = join(CLAWD_DIR, 'clawd.pid');
const LOG_FILE = join(CLAWD_DIR, 'clawd.log');

function ensureDir() {
  if (!existsSync(CLAWD_DIR)) {
    mkdirSync(CLAWD_DIR, { recursive: true });
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
  if (isRunning()) {
    console.log('clawd is already running');
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

  console.log(`clawd started (PID: ${child.pid})`);
}

function stop() {
  if (!isRunning()) {
    console.log('clawd is not running');
    return;
  }

  const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
  try {
    process.kill(pid, 'SIGTERM');
    unlinkSync(PID_FILE);
    console.log('clawd stopped');
  } catch (err) {
    console.error('Failed to stop clawd:', err.message);
  }
}

function status() {
  if (isRunning()) {
    const pid = readFileSync(PID_FILE, 'utf8').trim();
    console.log(`clawd is running (PID: ${pid})`);
  } else {
    console.log('clawd is not running');
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
    console.log('Usage: clawd <start|stop|status>');
    process.exit(1);
}
