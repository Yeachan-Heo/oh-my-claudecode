/**
 * MCP Bridge for Cross-Tool Interoperability
 *
 * Provides MCP tool definitions for communication between OMC and OMX.
 * Tools allow sending tasks and messages between the two systems.
 */
import { z } from 'zod';
import { addSharedTask, readSharedTasks, addSharedMessage, readSharedMessages, markMessageAsRead, } from './shared-state.js';
import { listOmxTeams, readOmxTeamConfig, listOmxMailboxMessages, sendOmxDirectMessage, broadcastOmxMessage, listOmxTasks, } from './omx-team-state.js';
export function getInteropMode(env = process.env) {
    const raw = (env.OMX_OMC_INTEROP_MODE || 'off').toLowerCase();
    if (raw === 'observe' || raw === 'active') {
        return raw;
    }
    return 'off';
}
export function canUseOmxDirectWriteBridge(env = process.env) {
    const interopEnabled = env.OMX_OMC_INTEROP_ENABLED === '1';
    const toolsEnabled = env.OMC_INTEROP_TOOLS_ENABLED === '1';
    const mode = getInteropMode(env);
    return interopEnabled && toolsEnabled && mode === 'active';
}
function resolveWorkingDirectory(workingDirectory) {
    return workingDirectory || process.cwd();
}
function getInteropSource(target) {
    return target === 'omc' ? 'omx' : 'omc';
}
function formatToolError(action, error) {
    return {
        content: [{
                type: 'text',
                text: `Error ${action}: ${error instanceof Error ? error.message : String(error)}`,
            }],
        isError: true,
    };
}
function truncatePreview(text, maxChars) {
    return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}
function formatArtifactDescriptorLines(label, descriptor) {
    if (!descriptor)
        return [];
    const lines = [`- **${label} artifact:** \`${descriptor.path}\``];
    if (descriptor.sizeBytes !== undefined) {
        lines.push(`- **${label} size:** ${descriptor.sizeBytes} bytes`);
    }
    if (descriptor.contentHash) {
        lines.push(`- **${label} hash:** \`${descriptor.contentHash.slice(0, 16)}…\``);
    }
    return lines;
}
// ============================================================================
// interop_send_task - Send a task to the other tool
// ============================================================================
export const interopSendTaskTool = {
    name: 'interop_send_task',
    description: 'Send a task to the other tool (OMC -> OMX or OMX -> OMC) for execution. The task will be queued in shared state for the target tool to pick up.',
    schema: {
        target: z.enum(['omc', 'omx']).describe('Target tool to send the task to'),
        type: z.enum(['analyze', 'implement', 'review', 'test', 'custom']).describe('Type of task'),
        description: z.string().describe('Task description'),
        context: z.record(z.string(), z.unknown()).optional().describe('Additional context data'),
        files: z.array(z.string()).optional().describe('List of relevant file paths'),
        workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
    },
    handler: async (args) => {
        const { target, type, description, context, files, workingDirectory } = args;
        try {
            const cwd = resolveWorkingDirectory(workingDirectory);
            const source = getInteropSource(target);
            const task = addSharedTask(cwd, {
                source,
                target,
                type,
                description,
                context,
                files,
            });
            return {
                content: [{
                        type: 'text',
                        text: `## Task Sent to ${target.toUpperCase()}\n\n` +
                            `**Task ID:** ${task.id}\n` +
                            `**Type:** ${task.type}\n` +
                            `**Description:** ${task.description}\n` +
                            (task.descriptionArtifact ? `**Description artifact:** ${task.descriptionArtifact.path}\n` : '') +
                            `**Status:** ${task.status}\n` +
                            `**Created:** ${task.createdAt}\n\n` +
                            (task.files ? `**Files:** ${task.files.join(', ')}\n\n` : '') +
                            `The task has been queued for ${target.toUpperCase()} to pick up.`
                    }]
            };
        }
        catch (error) {
            return formatToolError('sending task', error);
        }
    }
};
// ============================================================================
// interop_read_results - Read task results from the other tool
// ============================================================================
export const interopReadResultsTool = {
    name: 'interop_read_results',
    description: 'Read task results from the shared interop state. Can filter by source tool and status.',
    schema: {
        source: z.enum(['omc', 'omx']).optional().describe('Filter by source tool'),
        status: z.enum(['pending', 'in_progress', 'completed', 'failed']).optional().describe('Filter by task status'),
        limit: z.number().optional().describe('Maximum number of tasks to return (default: 10)'),
        workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
    },
    handler: async (args) => {
        const { source, status, limit = 10, workingDirectory } = args;
        try {
            const cwd = resolveWorkingDirectory(workingDirectory);
            const tasks = readSharedTasks(cwd, {
                source: source,
                status: status,
            });
            const limitedTasks = tasks.slice(0, limit);
            if (limitedTasks.length === 0) {
                return {
                    content: [{
                            type: 'text',
                            text: '## No Tasks Found\n\nNo tasks match the specified filters.'
                        }]
                };
            }
            const lines = [
                `## Tasks (${limitedTasks.length}${tasks.length > limit ? ` of ${tasks.length}` : ''})\n`
            ];
            for (const task of limitedTasks) {
                const statusIcon = task.status === 'completed' ? '✓' :
                    task.status === 'failed' ? '✗' :
                        task.status === 'in_progress' ? '⋯' : '○';
                lines.push(`### ${statusIcon} ${task.id}`);
                lines.push(`- **Type:** ${task.type}`);
                lines.push(`- **Source:** ${task.source.toUpperCase()} → **Target:** ${task.target.toUpperCase()}`);
                lines.push(`- **Status:** ${task.status}`);
                lines.push(`- **Description:** ${task.description}`);
                lines.push(`- **Created:** ${task.createdAt}`);
                lines.push(...formatArtifactDescriptorLines('Description', task.descriptionArtifact));
                if (task.files && task.files.length > 0) {
                    lines.push(`- **Files:** ${task.files.join(', ')}`);
                }
                if (task.result) {
                    lines.push(`- **Result:** ${truncatePreview(task.result, 200)}`);
                }
                lines.push(...formatArtifactDescriptorLines('Result', task.resultArtifact));
                if (task.error) {
                    lines.push(`- **Error:** ${task.error}`);
                }
                if (task.completedAt) {
                    lines.push(`- **Completed:** ${task.completedAt}`);
                }
                lines.push('');
            }
            return {
                content: [{
                        type: 'text',
                        text: lines.join('\n')
                    }]
            };
        }
        catch (error) {
            return formatToolError('reading tasks', error);
        }
    }
};
// ============================================================================
// interop_send_message - Send a message to the other tool
// ============================================================================
export const interopSendMessageTool = {
    name: 'interop_send_message',
    description: 'Send a message to the other tool for informational purposes or coordination.',
    schema: {
        target: z.enum(['omc', 'omx']).describe('Target tool to send the message to'),
        content: z.string().describe('Message content'),
        metadata: z.record(z.string(), z.unknown()).optional().describe('Additional metadata'),
        workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
    },
    handler: async (args) => {
        const { target, content, metadata, workingDirectory } = args;
        try {
            const cwd = resolveWorkingDirectory(workingDirectory);
            const source = getInteropSource(target);
            const message = addSharedMessage(cwd, {
                source,
                target,
                content,
                metadata,
            });
            return {
                content: [{
                        type: 'text',
                        text: `## Message Sent to ${target.toUpperCase()}\n\n` +
                            `**Message ID:** ${message.id}\n` +
                            `**Content:** ${message.content}\n` +
                            (message.contentArtifact ? `**Content artifact:** ${message.contentArtifact.path}\n` : '') +
                            `**Timestamp:** ${message.timestamp}\n\n` +
                            `The message has been queued for ${target.toUpperCase()}.`
                    }]
            };
        }
        catch (error) {
            return formatToolError('sending message', error);
        }
    }
};
// ============================================================================
// interop_read_messages - Read messages from the other tool
// ============================================================================
export const interopReadMessagesTool = {
    name: 'interop_read_messages',
    description: 'Read messages from the shared interop state. Can filter by source tool and read status.',
    schema: {
        source: z.enum(['omc', 'omx']).optional().describe('Filter by source tool'),
        unreadOnly: z.boolean().optional().describe('Show only unread messages (default: false)'),
        limit: z.number().optional().describe('Maximum number of messages to return (default: 10)'),
        markAsRead: z.boolean().optional().describe('Mark retrieved messages as read (default: false)'),
        workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
    },
    handler: async (args) => {
        const { source, unreadOnly = false, limit = 10, markAsRead = false, workingDirectory } = args;
        try {
            const cwd = resolveWorkingDirectory(workingDirectory);
            const messages = readSharedMessages(cwd, {
                source: source,
                unreadOnly,
            });
            const limitedMessages = messages.slice(0, limit);
            if (limitedMessages.length === 0) {
                return {
                    content: [{
                            type: 'text',
                            text: '## No Messages Found\n\nNo messages match the specified filters.'
                        }]
                };
            }
            // Mark messages as read if requested
            if (markAsRead) {
                for (const message of limitedMessages) {
                    markMessageAsRead(cwd, message.id);
                }
            }
            const lines = [
                `## Messages (${limitedMessages.length}${messages.length > limit ? ` of ${messages.length}` : ''})\n`
            ];
            for (const message of limitedMessages) {
                const readIcon = message.read ? '✓' : '○';
                lines.push(`### ${readIcon} ${message.id}`);
                lines.push(`- **From:** ${message.source.toUpperCase()} → **To:** ${message.target.toUpperCase()}`);
                lines.push(`- **Content:** ${message.content}`);
                lines.push(`- **Timestamp:** ${message.timestamp}`);
                lines.push(`- **Read:** ${message.read ? 'Yes' : 'No'}`);
                lines.push(...formatArtifactDescriptorLines('Content', message.contentArtifact));
                if (message.metadata) {
                    lines.push(`- **Metadata:** ${JSON.stringify(message.metadata)}`);
                }
                lines.push('');
            }
            if (markAsRead) {
                lines.push(`\n*${limitedMessages.length} message(s) marked as read*`);
            }
            return {
                content: [{
                        type: 'text',
                        text: lines.join('\n')
                    }]
            };
        }
        catch (error) {
            return formatToolError('reading messages', error);
        }
    }
};
// ============================================================================
// interop_list_omx_teams - List active omx teams
// ============================================================================
export const interopListOmxTeamsTool = {
    name: 'interop_list_omx_teams',
    description: 'List active OMX (oh-my-codex) teams from .omx/state/team/. Shows team names and basic configuration.',
    schema: {
        workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
    },
    handler: async (args) => {
        try {
            const cwd = resolveWorkingDirectory(args.workingDirectory);
            const teamNames = await listOmxTeams(cwd);
            if (teamNames.length === 0) {
                return {
                    content: [{
                            type: 'text',
                            text: '## No OMX Teams Found\n\nNo active OMX teams detected in .omx/state/team/.'
                        }]
                };
            }
            const lines = [`## OMX Teams (${teamNames.length})\n`];
            for (const name of teamNames) {
                const config = await readOmxTeamConfig(name, cwd);
                if (config) {
                    lines.push(`### ${name}`);
                    lines.push(`- **Task:** ${config.task}`);
                    lines.push(`- **Workers:** ${config.worker_count} (${config.agent_type})`);
                    lines.push(`- **Created:** ${config.created_at}`);
                    lines.push(`- **Workers:** ${config.workers.map((w) => w.name).join(', ')}`);
                    lines.push('');
                }
                else {
                    lines.push(`### ${name} (config not readable)\n`);
                }
            }
            return {
                content: [{
                        type: 'text',
                        text: lines.join('\n')
                    }]
            };
        }
        catch (error) {
            return formatToolError('listing OMX teams', error);
        }
    }
};
// ============================================================================
// interop_send_omx_message - Send message to omx team mailbox
// ============================================================================
export const interopSendOmxMessageTool = {
    name: 'interop_send_omx_message',
    description: 'Send a message to an OMX team worker mailbox using the native omx format. Supports direct messages and broadcasts.',
    schema: {
        teamName: z.string().describe('OMX team name'),
        fromWorker: z.string().describe('Sender worker name (e.g., "omc-bridge")'),
        toWorker: z.string().describe('Target worker name (ignored if broadcast=true)'),
        body: z.string().describe('Message body'),
        broadcast: z.boolean().optional().describe('Broadcast to all workers (default: false)'),
        workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
    },
    handler: async (args) => {
        try {
            if (!canUseOmxDirectWriteBridge()) {
                return {
                    content: [{
                            type: 'text',
                            text: 'Direct OMX mailbox writes are disabled. Use broker-mediated team_* MCP path or enable active interop flags explicitly.'
                        }],
                    isError: true
                };
            }
            const cwd = resolveWorkingDirectory(args.workingDirectory);
            if (args.broadcast) {
                const messages = await broadcastOmxMessage(args.teamName, args.fromWorker, args.body, cwd);
                return {
                    content: [{
                            type: 'text',
                            text: `## Broadcast Sent to OMX Team: ${args.teamName}\n\n` +
                                `**From:** ${args.fromWorker}\n` +
                                `**Recipients:** ${messages.length}\n` +
                                `**Message IDs:** ${messages.map((m) => m.message_id).join(', ')}\n\n` +
                                `Message delivered to ${messages.length} worker mailbox(es).`
                        }]
                };
            }
            const msg = await sendOmxDirectMessage(args.teamName, args.fromWorker, args.toWorker, args.body, cwd);
            return {
                content: [{
                        type: 'text',
                        text: `## Message Sent to OMX Worker\n\n` +
                            `**Team:** ${args.teamName}\n` +
                            `**From:** ${msg.from_worker}\n` +
                            `**To:** ${msg.to_worker}\n` +
                            `**Message ID:** ${msg.message_id}\n` +
                            `**Created:** ${msg.created_at}\n\n` +
                            `Message delivered to ${msg.to_worker}'s mailbox.`
                    }]
            };
        }
        catch (error) {
            return formatToolError('sending OMX message', error);
        }
    }
};
// ============================================================================
// interop_read_omx_messages - Read messages from omx team mailbox
// ============================================================================
export const interopReadOmxMessagesTool = {
    name: 'interop_read_omx_messages',
    description: 'Read messages from an OMX team worker mailbox.',
    schema: {
        teamName: z.string().describe('OMX team name'),
        workerName: z.string().describe('Worker name whose mailbox to read'),
        limit: z.number().optional().describe('Maximum number of messages to return (default: 20)'),
        workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
    },
    handler: async (args) => {
        try {
            const cwd = resolveWorkingDirectory(args.workingDirectory);
            const limit = args.limit ?? 20;
            const messages = await listOmxMailboxMessages(args.teamName, args.workerName, cwd);
            if (messages.length === 0) {
                return {
                    content: [{
                            type: 'text',
                            text: `## No Messages\n\nNo messages in ${args.workerName}'s mailbox for team ${args.teamName}.`
                        }]
                };
            }
            const limited = messages.slice(-limit); // most recent N messages
            const lines = [
                `## OMX Mailbox: ${args.workerName} @ ${args.teamName} (${limited.length}${messages.length > limit ? ` of ${messages.length}` : ''})\n`
            ];
            for (const msg of limited) {
                const deliveredIcon = msg.delivered_at ? '✓' : '○';
                lines.push(`### ${deliveredIcon} ${msg.message_id}`);
                lines.push(`- **From:** ${msg.from_worker}`);
                lines.push(`- **To:** ${msg.to_worker}`);
                lines.push(`- **Body:** ${truncatePreview(msg.body, 300)}`);
                lines.push(`- **Created:** ${msg.created_at}`);
                if (msg.delivered_at)
                    lines.push(`- **Delivered:** ${msg.delivered_at}`);
                lines.push('');
            }
            return {
                content: [{
                        type: 'text',
                        text: lines.join('\n')
                    }]
            };
        }
        catch (error) {
            return formatToolError('reading OMX messages', error);
        }
    }
};
// ============================================================================
// interop_read_omx_tasks - Read omx team tasks
// ============================================================================
export const interopReadOmxTasksTool = {
    name: 'interop_read_omx_tasks',
    description: 'Read tasks from an OMX team. Can filter by status.',
    schema: {
        teamName: z.string().describe('OMX team name'),
        status: z.enum(['pending', 'blocked', 'in_progress', 'completed', 'failed']).optional().describe('Filter by task status'),
        limit: z.number().optional().describe('Maximum number of tasks to return (default: 20)'),
        workingDirectory: z.string().optional().describe('Working directory (defaults to cwd)'),
    },
    handler: async (args) => {
        try {
            const cwd = resolveWorkingDirectory(args.workingDirectory);
            const limit = args.limit ?? 20;
            let tasks = await listOmxTasks(args.teamName, cwd);
            if (args.status) {
                tasks = tasks.filter((t) => t.status === args.status);
            }
            if (tasks.length === 0) {
                return {
                    content: [{
                            type: 'text',
                            text: `## No Tasks\n\nNo tasks found for OMX team ${args.teamName}${args.status ? ` with status "${args.status}"` : ''}.`
                        }]
                };
            }
            const limited = tasks.slice(0, limit);
            const lines = [
                `## OMX Tasks: ${args.teamName} (${limited.length}${tasks.length > limit ? ` of ${tasks.length}` : ''})\n`
            ];
            for (const task of limited) {
                const statusIcon = task.status === 'completed' ? '✓' :
                    task.status === 'failed' ? '✗' :
                        task.status === 'in_progress' ? '⋯' :
                            task.status === 'blocked' ? '⊘' : '○';
                lines.push(`### ${statusIcon} Task ${task.id}: ${task.subject}`);
                lines.push(`- **Status:** ${task.status}`);
                if (task.owner)
                    lines.push(`- **Owner:** ${task.owner}`);
                lines.push(`- **Description:** ${truncatePreview(task.description, 200)}`);
                lines.push(`- **Created:** ${task.created_at}`);
                if (task.result)
                    lines.push(`- **Result:** ${truncatePreview(task.result, 200)}`);
                if (task.error)
                    lines.push(`- **Error:** ${task.error}`);
                if (task.completed_at)
                    lines.push(`- **Completed:** ${task.completed_at}`);
                lines.push('');
            }
            return {
                content: [{
                        type: 'text',
                        text: lines.join('\n')
                    }]
            };
        }
        catch (error) {
            return formatToolError('reading OMX tasks', error);
        }
    }
};
/**
 * Get all interop MCP tools for registration
 */
export function getInteropTools() {
    return [
        interopSendTaskTool,
        interopReadResultsTool,
        interopSendMessageTool,
        interopReadMessagesTool,
        interopListOmxTeamsTool,
        interopSendOmxMessageTool,
        interopReadOmxMessagesTool,
        interopReadOmxTasksTool,
    ];
}
//# sourceMappingURL=mcp-bridge.js.map