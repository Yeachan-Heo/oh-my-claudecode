#!/usr/bin/env node
/**
 * Quick demo: spawn a 2-worker tmux team and show the split panes.
 * Usage: node scripts/demo-team.mjs
 */
import { startTeam } from '../dist/team/runtime.js';

const config = {
  teamName: 'demo',
  workerCount: 2,
  agentTypes: ['claude', 'claude'],
  tasks: [
    { subject: 'Write a haiku about tmux', description: 'Write a short haiku (3 lines, 5-7-5 syllables) about tmux split panes. Output it and exit.' },
    { subject: 'Write a haiku about Claude', description: 'Write a short haiku (3 lines, 5-7-5 syllables) about AI assistants. Output it and exit.' },
  ],
  cwd: process.cwd(),
};

console.log('Starting team "demo" with 2 Claude workers...');
const runtime = await startTeam(config);
console.log('\nTeam started!');
console.log(`  tmux session: ${runtime.sessionName}`);
console.log(`  workers: ${runtime.workerNames.join(', ')}`);
console.log(`  pane IDs: ${runtime.workerPaneIds.join(', ')}`);
console.log('\nAttach with:');
console.log(`  tmux attach -t ${runtime.sessionName}`);
