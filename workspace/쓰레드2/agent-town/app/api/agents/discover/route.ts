/**
 * GET /api/agents/discover
 *
 * Scans ~/.openclaw/agents/ and ~/.openclaw/openclaw.json to discover
 * non-main independent agents configured in OpenClaw.
 * Returns AgentConfig[] for the frontend to consume.
 */

import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createLogger } from "@/lib/logger";

const log = createLogger("agents/discover");

interface DiscoveredAgent {
  agentId: string;
  workspace?: string;
  model?: string;
  identity?: { name?: string; emoji?: string; avatar?: string };
  soul?: string;
}

const OPENCLAW_DIR = path.join(os.homedir(), ".openclaw");
const OPENCLAW_CONFIG = path.join(OPENCLAW_DIR, "openclaw.json");
const AGENTS_DIR = path.join(OPENCLAW_DIR, "agents");

/** Ensure resolved target is within the allowed base directory. */
function isSafePath(base: string, target: string): boolean {
  const resolved = path.resolve(target);
  return resolved.startsWith(base + path.sep) || resolved === base;
}

/** Validate agentId: no path separators or traversal. */
function isValidAgentId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id) && !id.includes("..");
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readTextFile(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf-8");
  } catch {
    return null;
  }
}

/** Parse IDENTITY.md frontmatter-style fields (Name:, Emoji:, Avatar:). */
function parseIdentityMd(content: string): { name?: string; emoji?: string; avatar?: string } {
  const result: { name?: string; emoji?: string; avatar?: string } = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    const match = trimmed.match(/^\*\*(\w+):\*\*\s*(.+)/);
    if (match) {
      const key = match[1].toLowerCase();
      const value = match[2].trim();
      if (key === "name") result.name = value;
      else if (key === "emoji") result.emoji = value;
      else if (key === "avatar") result.avatar = value;
    }
  }
  return result;
}

/** Extract the first ~200 chars of SOUL.md as a summary. */
function parseSoulSummary(content: string): string {
  const cleaned = content.replace(/^#.*$/gm, "").trim();
  return cleaned.length > 200 ? cleaned.slice(0, 200) + "…" : cleaned;
}

function resolveModel(model: unknown): string | undefined {
  if (typeof model === "string") return model;
  if (model && typeof model === "object" && "primary" in model) {
    return (model as { primary?: string }).primary;
  }
  return undefined;
}

export async function GET() {
  // When using Auggie provider, agent discovery is not applicable
  if (process.env.AGENT_PROVIDER === "auggie") {
    return NextResponse.json({ agents: [] });
  }

  const agents: DiscoveredAgent[] = [];

  try {
    // 1. Read openclaw.json config for agent list entries
    const configAgents = new Map<
      string,
      { workspace?: string; model?: string; identity?: DiscoveredAgent["identity"] }
    >();
    let defaultWorkspace: string | undefined;
    let defaultModel: string | undefined;

    if (await fileExists(OPENCLAW_CONFIG)) {
      const raw = await readTextFile(OPENCLAW_CONFIG);
      if (raw) {
        try {
          const config = JSON.parse(raw);
          defaultWorkspace = config?.agents?.defaults?.workspace;
          defaultModel = resolveModel(config?.agents?.defaults?.model);
          const list = config?.agents?.list;
          if (Array.isArray(list)) {
            for (const entry of list) {
              if (entry.id && entry.id !== "main" && isValidAgentId(entry.id)) {
                configAgents.set(entry.id, {
                  workspace: entry.workspace,
                  model: resolveModel(entry.model),
                  identity: entry.identity,
                });
              }
            }
          }
        } catch {
          /* ignore parse errors */
        }
      }
    }

    // 2. Scan agents directory for any agents not in config (manual discovery)
    const agentIds = new Set<string>(configAgents.keys());
    if (await fileExists(AGENTS_DIR)) {
      const entries = await fs.readdir(AGENTS_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== "main" && isValidAgentId(entry.name)) {
          agentIds.add(entry.name);
        }
      }
    }

    // 3. Build full agent info for each discovered agent
    for (const agentId of agentIds) {
      const configEntry = configAgents.get(agentId);
      const agentDir = path.join(AGENTS_DIR, agentId);
      if (!isSafePath(AGENTS_DIR, agentDir)) continue;
      const workspace = configEntry?.workspace ?? defaultWorkspace;

      // Try to read IDENTITY.md from the agent's workspace
      let identity = configEntry?.identity;
      if (!identity?.name && workspace) {
        const identityPath = path.join(workspace, "IDENTITY.md");
        const identityContent = await readTextFile(identityPath);
        if (identityContent) {
          identity = { ...identity, ...parseIdentityMd(identityContent) };
        }
      }
      // Also try agent-specific workspace if different
      if (!identity?.name) {
        const agentWorkspace = path.join(agentDir, "workspace");
        if (await fileExists(agentWorkspace)) {
          const identityPath = path.join(agentWorkspace, "IDENTITY.md");
          const identityContent = await readTextFile(identityPath);
          if (identityContent) {
            identity = { ...identity, ...parseIdentityMd(identityContent) };
          }
        }
      }

      // Try to read SOUL.md summary
      let soul: string | undefined;
      if (workspace) {
        const soulContent = await readTextFile(path.join(workspace, "SOUL.md"));
        if (soulContent) soul = parseSoulSummary(soulContent);
      }

      agents.push({
        agentId,
        workspace,
        model: configEntry?.model ?? defaultModel,
        identity: identity ?? { name: agentId },
        soul,
      });
    }
    // 4. Fallback: scan agent-mux tmux sessions (BiniLab agents)
    if (agents.length === 0) {
      try {
        const { execSync } = await import("node:child_process");
        const TMUX_SESSION = process.env.BINILAB_TMUX_SESSION ?? "binilab";
        const windowsRaw = execSync(
          `tmux list-windows -t ${TMUX_SESSION} -F "#{window_name}" 2>/dev/null`,
          { encoding: "utf-8" },
        ).trim();

        const BINILAB_AGENTS: Record<string, { name: string; emoji: string; role: string }> = {
          "ceo": { name: "민준(CEO)", emoji: "👔", role: "CEO" },
          "minjun-ceo": { name: "민준(CEO)", emoji: "👔", role: "CEO" },
          "seoyeon": { name: "서연(분석팀장)", emoji: "📊", role: "분석팀장" },
          "seoyeon-analyst": { name: "서연(분석팀장)", emoji: "📊", role: "분석팀장" },
          "bini-beauty-editor": { name: "빈이(뷰티 크리에이터)", emoji: "💄", role: "뷰티 크리에이터" },
          "doyun-qa": { name: "도윤(QA)", emoji: "🔍", role: "품질수검" },
          "junho-researcher": { name: "준호(트렌드헌터)", emoji: "🔎", role: "트렌드헌터" },
          "taeho-engineer": { name: "태호(엔지니어)", emoji: "⚙️", role: "엔지니어" },
          "jihyun-marketing-lead": { name: "지현(마케팅팀장)", emoji: "📢", role: "마케팅팀장" },
          "hana-health-editor": { name: "하나(건강 에디터)", emoji: "🏥", role: "건강 에디터" },
          "sora-lifestyle-editor": { name: "소라(생활 에디터)", emoji: "🏠", role: "생활 에디터" },
          "jiu-diet-editor": { name: "지우(다이어트 에디터)", emoji: "🥗", role: "다이어트 에디터" },
        };

        for (const windowName of windowsRaw.split("\n")) {
          if (windowName === "main" || !windowName) continue;
          const info = BINILAB_AGENTS[windowName];
          agents.push({
            agentId: windowName,
            workspace: process.cwd(),
            model: "claude",
            identity: {
              name: info?.name ?? windowName,
              emoji: info?.emoji ?? "🤖",
            },
            soul: info ? `BiniLab ${info.role}` : undefined,
          });
        }
        log.info(`agent-mux: found ${agents.length} agents in tmux session '${TMUX_SESSION}'`);
      } catch {
        // tmux not available or session not found — no agents
      }
    }
  } catch (err) {
    log.error("scan failed:", err);
    return NextResponse.json({ agents: [], error: String(err) }, { status: 500 });
  }

  return NextResponse.json({ agents });
}
