export interface RouteResult {
    method: 'native' | 'inbox';
    details: string;
}
export interface BroadcastResult {
    nativeRecipients: string[];
    inboxRecipients: string[];
}
/**
 * Route a message to a team member regardless of backend.
 * - Claude native: returns instruction to use SendMessage tool
 * - MCP worker: appends to worker's inbox JSONL
 */
export declare function routeMessage(teamName: string, recipientName: string, content: string, workingDirectory: string): RouteResult;
/**
 * Broadcast to all team members.
 * - Claude native: returns list for SendMessage broadcast
 * - MCP workers: appends to each worker's inbox
 */
export declare function broadcastToTeam(teamName: string, content: string, workingDirectory: string): BroadcastResult;
//# sourceMappingURL=message-router.d.ts.map