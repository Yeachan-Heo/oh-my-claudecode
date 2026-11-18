/**
 * The task_list MCP tool: its schema, its replies, and the opt-in registration
 * (OMC_TASK_LIST=1) together with OMC_DISABLE_TOOLS.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { taskListTool } from '../tools/task-list-tools.js';

const SAVED = process.env.OMC_TASK_LIST;

async function loadRegistry(taskList: string | undefined) {
  if (taskList === undefined) delete process.env.OMC_TASK_LIST;
  else process.env.OMC_TASK_LIST = taskList;
  vi.resetModules();
  return import('../mcp/tool-registry.js');
}

afterEach(() => {
  if (SAVED === undefined) delete process.env.OMC_TASK_LIST;
  else process.env.OMC_TASK_LIST = SAVED;
  vi.resetModules();
});

const call = (args: Record<string, unknown>) => taskListTool.handler(args) as Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}>;

describe('task_list registration', () => {
  it('is not registered without OMC_TASK_LIST=1', async () => {
    const registry = await loadRegistry(undefined);
    expect(registry.allTools.some((t) => t.name === 'task_list')).toBe(false);
    expect(registry.buildListToolsResponse().tools.some((t) => t.name === 'task_list')).toBe(false);
  });

  it('is not registered for any value other than 1', async () => {
    const registry = await loadRegistry('true');
    expect(registry.allTools.some((t) => t.name === 'task_list')).toBe(false);
  });

  it('is registered with OMC_TASK_LIST=1, with its schema and category', async () => {
    const registry = await loadRegistry('1');
    const entry = registry.allTools.find((t) => t.name === 'task_list');
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('task-list');
    const listed = registry.buildListToolsResponse().tools.find((t) => t.name === 'task_list');
    expect(listed).toBeDefined();
    const props = listed!.inputSchema.properties as Record<string, any>;
    expect(props.items.type).toBe('array');
    expect(props.items.items.properties.status.enum).toEqual(['pending', 'in_progress', 'completed']);
    expect(props.items.items.properties.note).toBeDefined();
    expect(props.items.items.required).toEqual(['content', 'status']);
    expect(props.advance.type).toBe('boolean');
    expect(props.done.items.type).toBe('integer');
    expect(props.start.type).toBe('integer');
    expect(listed!.inputSchema.required).toEqual([]);
  });

  it('OMC_DISABLE_TOOLS=task-list hides it like the other groups', async () => {
    const registry = await loadRegistry('1');
    expect(registry.getEnabledTools('task-list').some((t) => t.name === 'task_list')).toBe(false);
    expect(registry.getEnabledTools('lsp').some((t) => t.name === 'task_list')).toBe(true);
  });
});

// The in-process server (createOmcSession, omcToolsServer, getOmcToolNames) has its own tool aggregate next to the standalone registry.
describe('task_list in the in-process MCP server', () => {
  const SAVED_DISABLE = process.env.OMC_DISABLE_TOOLS;
  afterEach(() => {
    if (SAVED_DISABLE === undefined) delete process.env.OMC_DISABLE_TOOLS;
    else process.env.OMC_DISABLE_TOOLS = SAVED_DISABLE;
  });
  async function loadServer(taskList: string | undefined) {
    if (taskList === undefined) delete process.env.OMC_TASK_LIST;
    else process.env.OMC_TASK_LIST = taskList;
    vi.resetModules();
    return import('../mcp/omc-tools-server.js');
  }

  it('has no task_list tool without OMC_TASK_LIST=1, or for any other value', async () => {
    for (const value of [undefined, 'true', '0', '']) {
      const server = await loadServer(value);
      expect(server.omcToolNames, String(value)).not.toContain('mcp__t__task_list');
      expect(server.getOmcToolNames(), String(value)).not.toContain('mcp__t__task_list');
      expect(server._getAllToolNamesForTests(), String(value)).not.toContain('mcp__t__task_list');
    }
  }, 30_000);

  it('registers task_list with OMC_TASK_LIST=1 in the tool names and in the names createOmcSession allows', async () => {
    const server = await loadServer('1');
    expect(server.omcToolNames).toContain('mcp__t__task_list');
    expect(server.getOmcToolNames()).toContain('mcp__t__task_list');
    const { createOmcSession } = await import('../index.js');
    const session = createOmcSession({ skipConfigLoad: true, skipContextInjection: true });
    expect(session.queryOptions.options.allowedTools).toContain('mcp__t__task_list');
    expect((session.queryOptions.options.mcpServers as Record<string, unknown>).t).toBe(server.omcToolsServer);
  }, 30_000);

  it('takes the same tool and category as the standalone registry, and the category switch and OMC_DISABLE_TOOLS hide it', async () => {
    const server = await loadServer('1');
    const registry = await import('../mcp/tool-registry.js');
    expect(registry.allTools.find((t) => t.name === 'task_list')?.category).toBe('task-list');
    expect(server.getOmcToolNames({ includeTaskList: false })).not.toContain('mcp__t__task_list');
    expect(server.getOmcToolNames({ includeLsp: false })).toContain('mcp__t__task_list');
    // the full list stays unfiltered; the names the server exposes drop the group named in OMC_DISABLE_TOOLS
    process.env.OMC_DISABLE_TOOLS = 'task-list';
    const hidden = await loadServer('1');
    expect(hidden.omcToolNames).not.toContain('mcp__t__task_list');
    expect(hidden.getOmcToolNames()).not.toContain('mcp__t__task_list');
    expect(hidden._getAllToolNamesForTests()).toContain('mcp__t__task_list');
  }, 30_000);

  it('leaves the other tools as they were: the same names with and without the switch, task_list apart', async () => {
    const without = (await loadServer(undefined)).omcToolNames;
    const withIt = (await loadServer('1')).omcToolNames;
    expect(withIt.filter((n) => n !== 'mcp__t__task_list')).toEqual(without);
  }, 30_000);
});

describe('task_list replies', () => {
  it('accepts a whole list and names the task in progress', async () => {
    const r = await call({ items: [{ content: 'Read', status: 'completed' }, { content: 'Write hook', status: 'in_progress', note: 'why' }] });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe('List accepted: 2 task(s), in progress: Write hook.');
  });

  it('accepts items sent as JSON text, and advance, done and start', async () => {
    const r = await call({ items: JSON.stringify([{ content: 'A', status: 'pending' }]) });
    expect(r.isError).toBeUndefined();
    for (const args of [{ advance: true }, { done: [1] }, { start: 2 }]) {
      const v = await call(args);
      expect(v.isError).toBeUndefined();
      expect(v.content[0].text).toBe('Change accepted.');
    }
  });

  it('answers invalid calls with isError', async () => {
    const bad: Record<string, unknown>[] = [
      {},
      { items: [] },
      { items: [{ content: 'A', status: 'done' }] },
      { items: [{ content: ' ', status: 'pending' }] },
      { done: [0] },
      { advance: 'yes' },
      { advance: false },
    ];
    for (const args of bad) {
      const r = await call(args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
    }
  });

  it('rejects a note that is present but not a string, as the schema declares it, before it acknowledges the call', async () => {
    // the standalone server hands the raw arguments to the handler, so the handler holds every item to the schema
    for (const note of [5, true, null, {}, { text: 'x' }, [], ['a']]) {
      const r = await call({ items: [{ content: 'A', status: 'in_progress', note }] });
      expect(r.isError, JSON.stringify(note)).toBe(true);
      expect(r.content[0].text).toContain('note');
    }
    // one bad item among good ones, and the same list sent as JSON text
    expect((await call({ items: [{ content: 'A', status: 'pending' }, { content: 'B', status: 'pending', note: 5 }] })).isError).toBe(true);
    expect((await call({ items: JSON.stringify([{ content: 'A', status: 'pending', note: {} }]) })).isError).toBe(true);
    for (const note of [undefined, '', ' ', 'why']) {
      const r = await call({ items: [{ content: 'A', status: 'in_progress', note }] });
      expect(r.isError, JSON.stringify(note)).toBeUndefined();
    }
  });
});
