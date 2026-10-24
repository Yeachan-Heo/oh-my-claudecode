#!/usr/bin/env node
/**
 * Validate project playbook extensions under .omc/playbooks/.
 *
 * Mechanism credit: the extends/anchor-check pattern derives from pstack's
 * check-playbooks validator (https://github.com/cursor/plugins/tree/main/pstack,
 * ported at https://github.com/michael-denyer/pstack-claude), reimplemented
 * for OMC's skills tree.
 *
 * A project playbook is a Markdown file at .omc/playbooks/<name>.md whose
 * frontmatter declares:
 *   extends: <bundled-skill-name>[, <bundled-skill-name>...]
 *   when: <one sentence naming the requests it serves>
 * Its body may carry change items of the form **After** "<quoted text>",
 * **Before**, **Replace**, or **In**, where the quoted text must appear in
 * the extended skill's SKILL.md. A pstack upgrade that rewrites a step
 * breaks the anchor, and this script names it instead of letting the change
 * float loose.
 *
 * Usage: node scripts/check-omc-playbooks.mjs [project-root] [--skills-root <path>]
 * Skills root resolution: --skills-root > $CLAUDE_PLUGIN_ROOT/skills >
 * ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills. Exit 0 valid (or no playbooks),
 * exit 1 with one line per problem.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const skillsRootFlag = readFlagValue('--skills-root');
const projectRoot = resolve(
  args.find((a) => !a.startsWith('--') && a !== readFlagValue('--skills-root')) ?? '.',
);

function readFlagValue(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function resolveSkillsRoot() {
  if (skillsRootFlag) return resolve(skillsRootFlag);
  if (process.env.CLAUDE_PLUGIN_ROOT) return join(process.env.CLAUDE_PLUGIN_ROOT, 'skills');
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  return join(configDir, 'skills');
}

const ANCHOR_RE = /\*\*(After|Before|Replace|In)\*\*\s+"([^"]+)"/g;

function parseFrontmatter(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return fields;
}

function main() {
  const playbooksDir = join(projectRoot, '.omc', 'playbooks');
  if (!existsSync(playbooksDir)) {
    console.log('check-omc-playbooks: no .omc/playbooks directory — nothing to check');
    return 0;
  }
  const skillsRoot = resolveSkillsRoot();
  const problems = [];
  const files = readdirSync(playbooksDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort();

  if (files.length === 0) {
    console.log('check-omc-playbooks: no project playbooks — nothing to check');
    return 0;
  }

  for (const file of files) {
    const source = readFileSync(join(playbooksDir, file), 'utf8');
    const fields = parseFrontmatter(source);
    const extendsValue = fields.extends;
    if (!extendsValue) {
      problems.push(`${file}: frontmatter is missing an "extends:" field`);
      continue;
    }
    if (!fields.when) {
      problems.push(`${file}: frontmatter is missing a "when:" field`);
    }
    const baseNames = extendsValue.split(',').map((s) => s.trim()).filter(Boolean);
    for (const base of baseNames) {
      const skillPath = join(skillsRoot, base, 'SKILL.md');
      if (!existsSync(skillPath)) {
        problems.push(`${file}: extends "${base}" but no bundled skill named "${base}" exists (skills root: ${skillsRoot})`);
        continue;
      }
      const skillBody = readFileSync(skillPath, 'utf8');
      ANCHOR_RE.lastIndex = 0;
      let anchor;
      while ((anchor = ANCHOR_RE.exec(source)) !== null) {
        const quoted = anchor[2];
        if (!skillBody.includes(quoted)) {
          problems.push(
            `${file}: ${anchor[1]} anchor "${quoted}" does not appear in ${base}/SKILL.md — the bundled step text changed; re-anchor the change`,
          );
        }
      }
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`check-omc-playbooks: ${problem}`);
    return 1;
  }
  console.log(`check-omc-playbooks: ${files.length} project playbook(s) valid against ${skillsRoot}`);
  return 0;
}

process.exit(main());
