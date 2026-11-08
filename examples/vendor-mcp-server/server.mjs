#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const TOOL = {
  name: "get_company_context",
  description: "Return informational-only company context as markdown.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural-language summary of the current task or workflow stage.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

function buildContext(query) {
  return [
    "# Company Context",
    "",
    "## Security",
    "- Handle customer data as confidential.",
    "- Prefer least-privilege defaults when access levels are unclear.",
    "",
    "## Review checklist",
    "- Keep changes narrow and reversible.",
    "- Preserve auditability for behavior changes.",
    "",
    "## Domain glossary",
    "- Tenant: a single customer workspace.",
    "- Policy: an organization rule that explains expected behavior.",
    "",
    "## Query summary",
    query,
  ].join("\n");
}

const server = new Server(
  {
    name: "company-context",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [TOOL],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name !== TOOL.name) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  const query = typeof args?.query === "string" ? args.query : "";
  const context = buildContext(query);

  return {
    content: [{ type: "text", text: context }],
    structuredContent: { context },
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
