import type { BridgeConfig } from './types.js';
/**
 * Sanitize user-controlled content to prevent prompt injection.
 * - Truncates to maxLength
 * - Escapes XML-like delimiter tags that could confuse the prompt structure
 * @internal
 */
export declare function sanitizePromptContent(content: string, maxLength: number): string;
/** Main bridge daemon entry point */
export declare function runBridge(config: BridgeConfig): Promise<void>;
//# sourceMappingURL=mcp-team-bridge.d.ts.map