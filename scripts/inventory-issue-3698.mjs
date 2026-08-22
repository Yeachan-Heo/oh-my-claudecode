#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

const root = process.cwd();
async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'coverage'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path));
    else out.push(path);
  }
  return out;
}
const files = await walk(root);
const rel = files.map((p) => relative(root, p).replaceAll('\\', '/')).sort();
const skills = rel.filter((p) => /^skills\/[^/]+\/SKILL\.md$/.test(p)).map((p) => p.split('/')[1]);
const commands = rel.filter((p) => /^commands\/[^/]+\.md$/.test(p)).map((p) => p.slice('commands/'.length, -3));
const hooks = rel.filter((p) => p.startsWith('src/hooks/'));
const workflows = rel.filter((p) => p.startsWith('.github/workflows/'));
const agents = rel.filter((p) => /^src\/agents\/[^/]+\.ts$/.test(p)).map((p) => p.slice('src/agents/'.length, -3));
const promptSources = rel.filter((p) => /(^|\/)(CLAUDE\.md|.*prompt.*|prompts?\/)/i.test(p));
const digest = createHash('sha256').update(JSON.stringify(rel)).digest('hex');
const result = {
  schemaVersion: 1,
  generatedAt: process.env.ISSUE_3698_INVENTORY_TIMESTAMP ?? null,
  repository: 'Yeachan-Heo/oh-my-claudecode',
  base: '05c800f40d1ad53b42a78609d2667ef4f726808b',
  planningHead: process.env.ISSUE_3698_PLANNING_HEAD ?? 'b4d55efc28d39252afe95ec99e86a49975b012e8',
  counts: { skills: skills.length, commands: commands.length, hookFiles: hooks.length, workflows: workflows.length, agentDefinitions: agents.length, promptLikeFiles: promptSources.length },
  public: { skills, commands, agents },
  paths: { hookFiles: hooks, workflows, promptSources },
  inventorySha256: digest,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
