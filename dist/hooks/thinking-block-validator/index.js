/**
 * Proactive Thinking Block Validator Hook
 *
 * Prevents "Expected thinking/redacted_thinking but found tool_use" errors
 * by validating and fixing message structure BEFORE sending to Anthropic API.
 *
 * This hook runs on the "experimental.chat.messages.transform" hook point,
 * which is called before messages are converted to ModelMessage format and
 * sent to the API.
 *
 * Key differences from session-recovery hook:
 * - PROACTIVE (prevents error) vs REACTIVE (fixes after error)
 * - Runs BEFORE API call vs AFTER API error
 * - User never sees the error vs User sees error then recovery
 *
 * Ported from oh-my-opencode's thinking-block-validator hook.
 */
import { CONTENT_PART_TYPES, THINKING_PART_TYPES, DEFAULT_THINKING_CONTENT, SYNTHETIC_THINKING_ID_PREFIX, HOOK_NAME, } from "./constants.js";
export * from "./types.js";
export * from "./constants.js";
function isContentPartType(type) {
    return CONTENT_PART_TYPES.includes(type);
}
function isThinkingPartType(type) {
    return THINKING_PART_TYPES.includes(type);
}
export function isExtendedThinkingModel(modelID) {
    if (!modelID)
        return false;
    const lower = modelID.toLowerCase();
    if (lower.includes("thinking") || lower.endsWith("-high")) {
        return true;
    }
    return (lower.includes("claude-sonnet-4") ||
        lower.includes("claude-opus-4") ||
        lower.includes("claude-3"));
}
export function hasContentParts(parts) {
    if (!parts || parts.length === 0)
        return false;
    return parts.some((part) => isContentPartType(part.type));
}
export function startsWithThinkingBlock(parts) {
    if (!parts || parts.length === 0)
        return false;
    const firstPart = parts[0];
    return isThinkingPartType(firstPart.type);
}
export function findPreviousThinkingContent(messages, currentIndex) {
    for (let i = currentIndex - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.info.role !== "assistant")
            continue;
        if (!msg.parts)
            continue;
        for (const part of msg.parts) {
            if (isThinkingPartType(part.type)) {
                const thinking = part.thinking || part.text;
                if (thinking &&
                    typeof thinking === "string" &&
                    thinking.trim().length > 0) {
                    return thinking;
                }
            }
        }
    }
    return "";
}
export function prependThinkingBlock(message, thinkingContent) {
    if (!message.parts) {
        message.parts = [];
    }
    const thinkingPart = {
        type: "thinking",
        id: SYNTHETIC_THINKING_ID_PREFIX,
        sessionID: message.info.sessionID || "",
        messageID: message.info.id,
        thinking: thinkingContent,
        synthetic: true,
    };
    message.parts.unshift(thinkingPart);
}
export function validateMessage(message, messages, index, modelID) {
    if (message.info.role !== "assistant") {
        return { valid: true, fixed: false };
    }
    if (!isExtendedThinkingModel(modelID)) {
        return { valid: true, fixed: false };
    }
    if (hasContentParts(message.parts) &&
        !startsWithThinkingBlock(message.parts)) {
        const previousThinking = findPreviousThinkingContent(messages, index);
        const thinkingContent = previousThinking || DEFAULT_THINKING_CONTENT;
        prependThinkingBlock(message, thinkingContent);
        return {
            valid: false,
            fixed: true,
            issue: "Assistant message has content but no thinking block",
            action: `Prepended synthetic thinking block: "${thinkingContent.substring(0, 50)}..."`,
        };
    }
    return { valid: true, fixed: false };
}
export function createThinkingBlockValidatorHook() {
    return {
        "experimental.chat.messages.transform": async (_input, output) => {
            const { messages } = output;
            if (!messages || messages.length === 0) {
                return;
            }
            let lastUserMessage;
            for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].info.role === "user") {
                    lastUserMessage = messages[i];
                    break;
                }
            }
            const modelID = lastUserMessage?.info?.modelID || "";
            if (!isExtendedThinkingModel(modelID)) {
                return;
            }
            let fixedCount = 0;
            for (let i = 0; i < messages.length; i++) {
                const msg = messages[i];
                if (msg.info.role !== "assistant")
                    continue;
                if (hasContentParts(msg.parts) && !startsWithThinkingBlock(msg.parts)) {
                    const previousThinking = findPreviousThinkingContent(messages, i);
                    const thinkingContent = previousThinking || DEFAULT_THINKING_CONTENT;
                    prependThinkingBlock(msg, thinkingContent);
                    fixedCount++;
                }
            }
            if (fixedCount > 0 && process.env.DEBUG_THINKING_VALIDATOR) {
                console.log(`[${HOOK_NAME}] Fixed ${fixedCount} message(s) by prepending thinking blocks`);
            }
        },
    };
}
export function validateMessages(messages, modelID) {
    const results = [];
    for (let i = 0; i < messages.length; i++) {
        const result = validateMessage(messages[i], messages, i, modelID);
        results.push(result);
    }
    return results;
}
export function getValidationStats(results) {
    return {
        total: results.length,
        valid: results.filter((r) => r.valid && !r.fixed).length,
        fixed: results.filter((r) => r.fixed).length,
        issues: results.filter((r) => !r.valid).length,
    };
}
//# sourceMappingURL=index.js.map