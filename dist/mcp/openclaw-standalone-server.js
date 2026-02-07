/**
 * OpenClaw MCP Standalone Server
 *
 * This server is bundled into a standalone CJS file and registered in .mcp.json.
 * It's spawned by the Claude Agent SDK and communicates over stdio.
 */
import { detectOpenclawCli, isGatewayRunning, spawnOpenclawAgent, sendToSession, getOpenclawInfo, } from './openclaw-core.js';
let buffer = '';
process.stdin.on('data', (chunk) => {
    buffer += chunk.toString();
    // Process complete messages delimited by newline
    let boundary = buffer.indexOf('\\n');
    while (boundary !== -1) {
        const message = buffer.substring(0, boundary);
        buffer = buffer.substring(boundary + 1);
        if (message) {
            handleMessage(message);
        }
        boundary = buffer.indexOf('\\n');
    }
});
async function handleMessage(message) {
    try {
        const { id, command, payload } = JSON.parse(message);
        let result;
        switch (command) {
            case 'detect':
                result = detectOpenclawCli();
                break;
            case 'info':
                result = getOpenclawInfo();
                break;
            case 'isGatewayRunning':
                result = await isGatewayRunning();
                break;
            case 'spawn':
                result = await spawnOpenclawAgent(payload);
                break;
            case 'send':
                result = await sendToSession(payload.sessionKey, payload.message);
                break;
            default:
                result = { success: false, error: `Unknown command: ${command}` };
        }
        sendResponse(id, result);
    }
    catch (error) {
        sendResponse(null, { success: false, error: `Failed to process message: ${error.message}` });
    }
}
function sendResponse(id, payload) {
    try {
        const response = JSON.stringify({ id, payload });
        process.stdout.write(response + '\\n');
    }
    catch (error) {
        // Fallback for circular structures or other serialization errors
        const errorResponse = JSON.stringify({
            id,
            payload: { success: false, error: `Failed to serialize response: ${error.message}` }
        });
        process.stdout.write(errorResponse + '\\n');
    }
}
// Initial detection to cache the path
detectOpenclawCli();
// Notify the parent process that the server is ready
sendResponse('ready', { status: 'ready' });
//# sourceMappingURL=openclaw-standalone-server.js.map