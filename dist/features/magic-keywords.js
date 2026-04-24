/**
 * Magic Keywords Feature
 *
 * Detects special keywords in prompts and activates enhanced behaviors.
 * Patterns ported from oh-my-opencode.
 */
import { getUltraworkMessage } from '../hooks/keyword-detector/ultrawork/index.js';
/**
 * Code block pattern for stripping from detection
 */
const CODE_BLOCK_PATTERN = /```[\s\S]*?```/g;
const INLINE_CODE_PATTERN = /`[^`]+`/g;
/**
 * Remove code blocks from text for keyword detection
 */
function removeCodeBlocks(text) {
    return text.replace(CODE_BLOCK_PATTERN, '').replace(INLINE_CODE_PATTERN, '');
}
const INFORMATIONAL_INTENT_PATTERNS = [
    /\b(?:what(?:'s|\s+is)|what\s+are|how\s+(?:to|do\s+i)\s+use|explain|explanation|tell\s+me\s+about|describe)\b/i,
    /(?:뭐야|무엇(?:이야|인가요)?|어떻게|설명|사용법)/u,
    /(?:とは|って何|使い方|説明)/u,
    /(?:什么是|什麼是|怎(?:么|樣)用|如何使用|解释|說明|说明)/u,
];
const INFORMATIONAL_CONTEXT_WINDOW = 80;
function isInformationalKeywordContext(text, position, keywordLength) {
    const start = Math.max(0, position - INFORMATIONAL_CONTEXT_WINDOW);
    const end = Math.min(text.length, position + keywordLength + INFORMATIONAL_CONTEXT_WINDOW);
    const context = text.slice(start, end);
    return INFORMATIONAL_INTENT_PATTERNS.some(pattern => pattern.test(context));
}
/**
 * Escape regex metacharacters so a string matches literally inside new RegExp().
 */
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function hasActionableTrigger(text, trigger) {
    const pattern = new RegExp(`\\b${escapeRegExp(trigger)}\\b`, 'gi');
    for (const match of text.matchAll(pattern)) {
        if (match.index === undefined) {
            continue;
        }
        if (isInformationalKeywordContext(text, match.index, match[0].length)) {
            continue;
        }
        return true;
    }
    return false;
}
/**
 * Ultrawork mode enhancement
 * Activates maximum performance with parallel agent orchestration
 */
const ultraworkEnhancement = {
    triggers: ['ultrawork', 'ulw', 'uw'],
    description: 'Activates maximum performance mode with parallel agent orchestration',
    action: (prompt, agentName, modelId) => {
        // Remove the trigger word and add enhancement instructions
        const cleanPrompt = removeTriggerWords(prompt, ['ultrawork', 'ulw', 'uw']);
        return getUltraworkMessage(agentName, modelId) + cleanPrompt;
    }
};
/**
 * Search mode enhancement - multilingual support
 * Maximizes search effort and thoroughness
 */
const searchEnhancement = {
    triggers: ['search', 'find', 'locate', 'lookup', 'explore', 'discover', 'scan', 'grep', 'query', 'browse', 'detect', 'trace', 'seek', 'track', 'pinpoint', 'hunt'],
    description: 'Maximizes search effort and thoroughness',
    action: (prompt) => {
        // Multi-language search pattern
        const searchPattern = /\b(search|find|locate|lookup|look\s*up|explore|discover|scan|grep|query|browse|detect|trace|seek|track|pinpoint|hunt)\b|where\s+is|show\s+me|list\s+all|검색|찾아|탐색|조회|스캔|서치|뒤져|찾기|어디|추적|탐지|찾아봐|찾아내|보여줘|목록|検索|探して|見つけて|サーチ|探索|スキャン|どこ|発見|捜索|見つけ出す|一覧|搜索|查找|寻找|查询|检索|定位|扫描|发现|在哪里|找出来|列出|tìm kiếm|tra cứu|định vị|quét|phát hiện|truy tìm|tìm ra|ở đâu|liệt kê/i;
        const hasSearchCommand = searchPattern.test(removeCodeBlocks(prompt));
        if (!hasSearchCommand) {
            return prompt;
        }
        return `${prompt}

[search-mode]
MAXIMIZE SEARCH EFFORT. Launch multiple background agents IN PARALLEL:
- explore agents (codebase patterns, file structures, ast-grep)
- document-specialist agents (remote repos, official docs, GitHub examples)
Plus direct tools: Grep, ripgrep (rg), ast-grep (sg)
NEVER stop at first result - be exhaustive.`;
    }
};
/**
 * Analyze mode enhancement - multilingual support
 * Activates deep analysis and investigation mode
 */
const analyzeEnhancement = {
    triggers: ['analyze', 'analyse', 'investigate', 'examine', 'study', 'deep-dive', 'inspect', 'audit', 'evaluate', 'assess', 'review', 'diagnose', 'scrutinize', 'dissect', 'debug', 'comprehend', 'interpret', 'breakdown', 'understand'],
    description: 'Activates deep analysis and investigation mode',
    action: (prompt) => {
        // Multi-language analyze pattern
        const analyzePattern = /\b(analyze|analyse|investigate|examine|study|deep[\s-]?dive|inspect|audit|evaluate|assess|review|diagnose|scrutinize|dissect|debug|comprehend|interpret|breakdown|understand)\b|why\s+is|how\s+does|how\s+to|분석|조사|파악|연구|검토|진단|이해|설명|원인|이유|뜯어봐|따져봐|평가|해석|디버깅|디버그|어떻게|왜|살펴|分析|調査|解析|検討|研究|診断|理解|説明|検証|精査|究明|デバッグ|なぜ|どう|仕組み|调查|检查|剖析|深入|诊断|解释|调试|为什么|原理|搞清楚|弄明白|phân tích|điều tra|nghiên cứu|kiểm tra|xem xét|chẩn đoán|giải thích|tìm hiểu|gỡ lỗi|tại sao/i;
        const hasAnalyzeCommand = analyzePattern.test(removeCodeBlocks(prompt));
        if (!hasAnalyzeCommand) {
            return prompt;
        }
        return `${prompt}

[analyze-mode]
ANALYSIS MODE. Gather context before diving deep:

CONTEXT GATHERING (parallel):
- 1-2 explore agents (codebase patterns, implementations)
- 1-2 document-specialist agents (if external library involved)
- Direct tools: Grep, AST-grep, LSP for targeted searches

IF COMPLEX (architecture, multi-system, debugging after 2+ failures):
- Consult architect for strategic guidance

SYNTHESIZE findings before proceeding.`;
    }
};
/**
 * Ultrathink mode enhancement
 * Activates extended thinking and deep reasoning
 */
const ultrathinkEnhancement = {
    triggers: ['ultrathink', 'think', 'reason', 'ponder'],
    description: 'Activates extended thinking mode for deep reasoning',
    action: (prompt) => {
        // Check if ultrathink-related triggers are present
        const hasThinkCommand = /\b(ultrathink|think|reason|ponder)\b/i.test(removeCodeBlocks(prompt));
        if (!hasThinkCommand) {
            return prompt;
        }
        const cleanPrompt = removeTriggerWords(prompt, ['ultrathink', 'think', 'reason', 'ponder']);
        return `[ULTRATHINK MODE - EXTENDED REASONING ACTIVATED]

${cleanPrompt}

## Deep Thinking Instructions
- Take your time to think through this problem thoroughly
- Consider multiple approaches before settling on a solution
- Identify edge cases, risks, and potential issues
- Think step-by-step through complex logic
- Question your assumptions
- Consider what could go wrong
- Evaluate trade-offs between different solutions
- Look for patterns from similar problems

IMPORTANT: Do not rush. Quality of reasoning matters more than speed.
Use maximum cognitive effort before responding.`;
    }
};
/**
 * Remove trigger words from a prompt
 */
function removeTriggerWords(prompt, triggers) {
    let result = prompt;
    for (const trigger of triggers) {
        const regex = new RegExp(`\\b${escapeRegExp(trigger)}\\b`, 'gi');
        result = result.replace(regex, '');
    }
    return result.trim();
}
/**
 * All built-in magic keyword definitions
 */
export const builtInMagicKeywords = [
    ultraworkEnhancement,
    searchEnhancement,
    analyzeEnhancement,
    ultrathinkEnhancement
];
/**
 * Create a magic keyword processor with custom triggers
 */
export function createMagicKeywordProcessor(config) {
    const keywords = builtInMagicKeywords.map(k => ({ ...k, triggers: [...k.triggers] }));
    // Override triggers from config
    if (config) {
        if (config.ultrawork) {
            const ultrawork = keywords.find(k => k.triggers.includes('ultrawork'));
            if (ultrawork) {
                ultrawork.triggers = config.ultrawork;
            }
        }
        if (config.search) {
            const search = keywords.find(k => k.triggers.includes('search'));
            if (search) {
                search.triggers = config.search;
            }
        }
        if (config.analyze) {
            const analyze = keywords.find(k => k.triggers.includes('analyze'));
            if (analyze) {
                analyze.triggers = config.analyze;
            }
        }
        if (config.ultrathink) {
            const ultrathink = keywords.find(k => k.triggers.includes('ultrathink'));
            if (ultrathink) {
                ultrathink.triggers = config.ultrathink;
            }
        }
    }
    return (prompt, agentName, modelId) => {
        let result = prompt;
        for (const keyword of keywords) {
            const hasKeyword = keyword.triggers.some(trigger => {
                return hasActionableTrigger(removeCodeBlocks(result), trigger);
            });
            if (hasKeyword) {
                result = keyword.action(result, agentName, modelId);
            }
        }
        return result;
    };
}
/**
 * Check if a prompt contains any magic keywords
 */
export function detectMagicKeywords(prompt, config) {
    const detected = [];
    const keywords = builtInMagicKeywords.map(k => ({ ...k, triggers: [...k.triggers] }));
    const cleanedPrompt = removeCodeBlocks(prompt);
    // Apply config overrides
    if (config) {
        if (config.ultrawork) {
            const ultrawork = keywords.find(k => k.triggers.includes('ultrawork'));
            if (ultrawork)
                ultrawork.triggers = config.ultrawork;
        }
        if (config.search) {
            const search = keywords.find(k => k.triggers.includes('search'));
            if (search)
                search.triggers = config.search;
        }
        if (config.analyze) {
            const analyze = keywords.find(k => k.triggers.includes('analyze'));
            if (analyze)
                analyze.triggers = config.analyze;
        }
        if (config.ultrathink) {
            const ultrathink = keywords.find(k => k.triggers.includes('ultrathink'));
            if (ultrathink)
                ultrathink.triggers = config.ultrathink;
        }
    }
    for (const keyword of keywords) {
        for (const trigger of keyword.triggers) {
            if (hasActionableTrigger(cleanedPrompt, trigger)) {
                detected.push(trigger);
                break;
            }
        }
    }
    return detected;
}
/**
 * Extract prompt text from message parts (for hook usage)
 */
export function extractPromptText(parts) {
    return parts
        .filter(p => p.type === 'text')
        .map(p => p.text ?? '')
        .join('\n');
}
//# sourceMappingURL=magic-keywords.js.map