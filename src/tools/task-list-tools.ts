/**
 * Task List Tool
 *
 * MCP tool `task_list`: the task list of a subagent. Registered only when OMC_TASK_LIST=1, in the standalone registry
 * (tool-registry.ts), in the in-process server (omc-tools-server.ts) and in the public aggregate `allCustomTools` (index.ts), which
 * `omc capabilities` reads.
 * The server does not know which agent calls it, so the tool checks the shape of the call and confirms it; the PostToolUse hook
 * scripts/jev-task-list-state.mjs saves the list per agent_id.
 */

import { z } from 'zod';

const TASK_LIST_STATUSES = ['pending', 'in_progress', 'completed'] as const;

const taskListArray = (value: unknown): unknown[] | null => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.length <= TASK_LIST_JSON_MAX && value.trim().startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
};

// A list has at most TASK_LIST_MAX tasks, so a task number above that, and a list of numbers longer than that, change nothing: they are refused
// instead of accepted, since the hook would not save the call (an event over the size the reader accepts) and the answer would be a false
// "accepted", and an argument of any length would be walked.
const TASK_LIST_MAX = 50;
// A text of a task (content, note) is at most this long, and a list sent as JSON text at most TASK_LIST_JSON_MAX characters: the lengths are
// checked before a string is trimmed, parsed or masked, so a call with an enormous text is refused without being walked. The hook cuts a text
// to the same length before it masks it (RAW_TEXT_MAX in scripts/lib/jev-task-list.mjs), so a call accepted here is saved as sent.
const TASK_LIST_TEXT_MAX = 2000;
const TASK_LIST_JSON_MAX = 2 * TASK_LIST_MAX * TASK_LIST_TEXT_MAX + 10_000;

const taskListPositive = (value: unknown): boolean => {
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return Number.isInteger(n) && (n as number) >= 1 && (n as number) <= TASK_LIST_MAX;
};

const taskListSchema = {
  items: z.array(z.object({
    content: z.string().max(TASK_LIST_TEXT_MAX).describe('One checkable result'),
    status: z.enum(TASK_LIST_STATUSES),
    note: z.string().max(TASK_LIST_TEXT_MAX).optional().describe('Task in progress: 1-2 sentences, what you are doing now and why'),
  })).optional().describe('The whole list in order; replaces the previous one'),
  advance: z.boolean().optional().describe('Complete the task in progress and start the next pending one'),
  done: z.array(z.number().int().min(1).max(TASK_LIST_MAX)).max(TASK_LIST_MAX).optional().describe('1-based numbers of tasks to mark completed'),
  start: z.number().int().min(1).max(TASK_LIST_MAX).optional().describe('1-based number of the task to mark in_progress'),
};

type TaskListItem = { content?: unknown; status?: unknown; note?: unknown };

// An item as the schema declares it, checked here because the standalone server hands over the raw arguments: content a non-empty
// string, status one of the three, note absent or a string. The PostToolUse hook (updateShape in scripts/lib/jev-task-list.mjs)
// applies the same rule, so a call that is accepted here is saved as sent.
const taskListItemOk = (x: TaskListItem | null | undefined): boolean =>
  !!x &&
  typeof x.content === 'string' &&
  x.content.length <= TASK_LIST_TEXT_MAX &&
  x.content.trim() !== '' &&
  TASK_LIST_STATUSES.includes(x.status as typeof TASK_LIST_STATUSES[number]) &&
  (x.note === undefined || (typeof x.note === 'string' && x.note.length <= TASK_LIST_TEXT_MAX));

export const taskListTool = {
  name: 'task_list',
  description: 'Task list of a subagent. Send the whole list as items, or advance/done/start as in update_plan. One task = one checkable result; in_progress before the work, completed after it; the task in progress gets a note: what you are doing and why.',
  schema: taskListSchema,
  handler: async (args: unknown) => {
    const input = (args ?? {}) as Record<string, unknown>;
    const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });
    const items = input.items === undefined ? undefined : taskListArray(input.items);
    if (input.items !== undefined && (!items || items.length === 0 || items.length > 50 || !(items as TaskListItem[]).every(taskListItemOk))) {
      return fail('items: 1-50 tasks, each with a non-empty content, a status pending, in_progress or completed, and a note that, when present, is a string of at most 2000 characters (content too).');
    }
    const done = input.done === undefined ? undefined : taskListArray(input.done);
    if (input.done !== undefined && (!done || done.length > TASK_LIST_MAX || !done.every(taskListPositive))) return fail('done: a list of at most 50 task numbers, each from 1 to 50.');
    if (input.start !== undefined && !taskListPositive(input.start)) return fail('start: a task number from 1 to 50.');
    if (input.advance !== undefined && typeof input.advance !== 'boolean') return fail('advance: true or false.');
    if (!items && !done && input.start === undefined && input.advance !== true) return fail('Send items, or advance, done or start.');
    const current = items ? (items as TaskListItem[]).filter((x) => x.status === 'in_progress').map((x) => String(x.content).trim()) : [];
    const text = items
      ? `List accepted: ${items.length} task(s), in progress: ${current.length ? current.join('; ') : 'none'}.`
      : 'Change accepted.';
    return { content: [{ type: 'text' as const, text: text.length > 400 ? `${text.slice(0, 399)}…` : text }] };
  },
};
