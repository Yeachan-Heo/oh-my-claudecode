#!/usr/bin/env node
// Enforce pnpm as the only package manager for this repo.
// Runs as the `preinstall` lifecycle script.
//
// Strategy: block only the package managers that positively identify themselves
// (npm, yarn, bun always set `npm_config_user_agent` to their own name). pnpm is
// allowed, and so is an empty/undetectable agent — pnpm runs lifecycle scripts
// without a user-agent on its "already up to date" fast path, and failing closed
// there would reject legitimate pnpm installs. `npm install` always sets the UA,
// so the realistic "don't use npm" case is still fully blocked.
const ua = process.env.npm_config_user_agent || "";
const agent = ua.split("/")[0];
const blocked = ["npm", "yarn", "bun"];

if (blocked.includes(agent)) {
  console.error(
    `\nThis repository is pnpm-only (detected "${agent}").\n` +
      "  Use:      pnpm install\n" +
      "  No pnpm?  corepack enable && corepack prepare pnpm@11.1.3 --activate\n"
  );
  process.exit(1);
}
