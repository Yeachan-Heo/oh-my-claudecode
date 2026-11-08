#!/usr/bin/env node
/**
 * Graph runtime demo: writes a 3-node descriptor (agent analysis -> human
 * approval gate -> terminal verification) to a temp file and prints how to run
 * it. The script only WRITES the descriptor; the runner lands in wave 2.
 *
 * Usage:
 *   node scripts/graph-agent-demo.mjs [topic]
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const topic = process.argv[2] ?? "event-driven vs request-driven architecture";

function executableNode(id, extra) {
  return {
    id,
    kind: "agent",
    title: id,
    timeout_ms: 120_000,
    max_attempts: 3,
    effect_policy: { policy: "side_effect_free" },
    ...extra,
  };
}

const descriptor = {
  descriptor_version: 1,
  run_id: "run-agent-demo",
  revision_id: "rev-agent-demo",
  goal: `Produce a one-paragraph analysis of ${topic} and get human sign-off`,
  nodes: [
    executableNode("analyze", {
      title: "Analyze topic",
      instructions: `Write exactly one paragraph analyzing: ${topic}. No headings, no lists.`,
    }),
    {
      id: "approval",
      kind: "human-approval",
      title: "Approve analysis",
      prompt: `Approve the one-paragraph analysis of "${topic}"?`,
    },
    {
      id: "term",
      kind: "command",
      title: "Terminal verification",
      command: "echo approved",
      timeout_ms: 30_000,
      max_attempts: 1,
      effect_policy: { policy: "side_effect_free" },
    },
  ],
  edges: [
    { id: "e-analyze-approval", kind: "fixed", from: "analyze", to: "approval" },
    { id: "e-approval-term", kind: "fixed", from: "approval", to: "term" },
  ],
  entry_node_ids: ["analyze"],
  concurrency_limit: 1,
  terminal_verification_node_id: "term",
};

const dir = await mkdtemp(join(tmpdir(), "omc-graph-demo-"));
const file = join(dir, "demo-descriptor.json");
await writeFile(file, JSON.stringify(descriptor, null, 2), "utf8");

console.log(`Demo descriptor written to:\n  ${file}\n`);
console.log("Run it with:");
console.log(`  node bin/oh-my-claudecode.js graph run ${file}`);
console.log(`
Flow: agent node analyzes "${topic}", then a human-approval gate pauses the
run until you approve/deny, then a terminal command node verifies.`);
