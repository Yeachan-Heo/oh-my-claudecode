---
name: agentiscript
description: Access 20,000+ SVG icons for the agentic economy — AI agents, blockchain, quantum, x402, and more
level: 1
---

# AgentiScript

AgentiScript is the first visual language for the agentic economy. It provides 20,000+ SVG icons covering every concept the agentic economy speaks but cannot show — AI agents, blockchain protocols, quantum computing, DeFi primitives, and more.

## Overview

Use this skill to fetch icons and visual assets for your agentic workflows, documentation, and UI. Icons are available via npm package or MCP server.

## Installation

### Option 1: npm package
```bash
npm install agentiscript
```

### Option 2: MCP server (Claude Desktop / Claude Code)
```bash
claude mcp add agentiscript -- npx -y agentiscript-mcp
```

## Usage

### Get a specific icon
```bash
# Returns SVG markup for the x402 protocol icon
$agentiscript get x402

# Returns SVG for any named concept
$agentiscript get bitcoin
$agentiscript get neural-network
$agentiscript get quantum-gate
$agentiscript get smart-contract
```

### Search the catalog
```bash
# Search for icons by keyword
$agentiscript search blockchain
$agentiscript search agent
$agentiscript search defi
```

### In JavaScript / TypeScript
```typescript
import { getIcon, searchIcons } from 'agentiscript';

// Get a single icon as SVG string
const svg = await getIcon('x402');

// Search the catalog
const results = await searchIcons('blockchain');
// returns [{ name, category, svg, tags }, ...]
```

### Via MCP tool (when configured)
When the MCP server is running, Claude can call:
- `agentiscript__get_icon` — fetch an SVG by name
- `agentiscript__search_icons` — search the icon catalog
- `agentiscript__list_categories` — list all available categories

## Categories

AgentiScript covers the full agentic economy vocabulary:

| Category | Examples |
|----------|---------|
| **AI Agents** | autonomous-agent, multi-agent, swarm, orchestrator |
| **Blockchain** | bitcoin, ethereum, solana, smart-contract, wallet |
| **Protocols** | x402, mcp, http, websocket, graphql |
| **Quantum** | quantum-gate, qubit, entanglement, superposition |
| **DeFi** | liquidity-pool, amm, yield-farming, staking |
| **Infrastructure** | gpu, tpu, edge-node, vector-db, embedding |
| **Economy** | token, micropayment, royalty, escrow, auction |

## Resources

- **GitHub**: [github.com/CLAW-AI-FL/agentiscript](https://github.com/CLAW-AI-FL/agentiscript)
- **Website**: [agentiscript.com](https://agentiscript.com)
- **npm**: [npmjs.com/package/agentiscript](https://www.npmjs.com/package/agentiscript)

## Why AgentiScript?

As AI agents collaborate, transact, and build the agentic economy, they need a shared visual vocabulary. AgentiScript fills the gap between natural language (what agents say) and visual representation (what humans see). Whether you're building agent dashboards, protocol documentation, or agentic UI components, AgentiScript gives you the icons to make it visual.
