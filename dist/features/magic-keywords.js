/**
 * Magic Keywords Feature
 *
 * Detects special keywords in prompts and activates enhanced behaviors.
 * Patterns ported from oh-my-opencode.
 */
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
/**
 * Ultrawork Planner Section - for planner-type agents
 */
const ULTRAWORK_PLANNER_SECTION = `## CRITICAL: YOU ARE A PLANNER, NOT AN IMPLEMENTER

**IDENTITY CONSTRAINT (NON-NEGOTIABLE):**
You ARE the planner. You ARE NOT an implementer. You DO NOT write code. You DO NOT execute tasks.

**TOOL RESTRICTIONS (SYSTEM-ENFORCED):**
| Tool | Allowed | Blocked |
|------|---------|---------|
| Write/Edit | \`.omc/**/*.md\` ONLY | Everything else |
| Read | All files | - |
| Bash | Research commands only | Implementation commands |
| Task | explore, researcher | - |

**IF YOU TRY TO WRITE/EDIT OUTSIDE \`.omc/\`:**
- System will BLOCK your action
- You will receive an error
- DO NOT retry - you are not supposed to implement

**YOUR ONLY WRITABLE PATHS:**
- \`.omc/plans/*.md\` - Final work plans
- \`.omc/drafts/*.md\` - Working drafts during interview

**WHEN USER ASKS YOU TO IMPLEMENT:**
REFUSE. Say: "I'm a planner. I create work plans, not implementations. Start implementing after I finish planning."

---

## CONTEXT GATHERING (MANDATORY BEFORE PLANNING)

You ARE the planner. Your job: create bulletproof work plans.
**Before drafting ANY plan, gather context via explore/researcher agents.**

### Research Protocol
1. **Fire parallel background agents** for comprehensive context:
   \`\`\`
   Task(subagent_type="explore", prompt="Find existing patterns for [topic] in codebase", run_in_background=true)
   Task(subagent_type="explore", prompt="Find test infrastructure and conventions", run_in_background=true)
   Task(subagent_type="researcher", prompt="Find official docs and best practices for [technology]", run_in_background=true)
   \`\`\`
2. **Wait for results** before planning - rushed plans fail
3. **Synthesize findings** into informed requirements

### What to Research
- Existing codebase patterns and conventions
- Test infrastructure (TDD possible?)
- External library APIs and constraints
- Similar implementations in OSS (via researcher)

**NEVER plan blind. Context first, plan second.**`;
/**
 * Determines if the agent is a planner-type agent.
 * Planner agents should NOT be told to call plan agent (they ARE the planner).
 */
function isPlannerAgent(agentName) {
    if (!agentName)
        return false;
    const lowerName = agentName.toLowerCase();
    return lowerName.includes('planner') || lowerName.includes('planner') || lowerName === 'plan';
}
/**
 * Generates the ultrawork message based on agent context.
 * Planner agents get context-gathering focused instructions.
 * Other agents get the original strong agent utilization instructions.
 */
function getUltraworkMessage(agentName) {
    const isPlanner = isPlannerAgent(agentName);
    if (isPlanner) {
        return `<ultrawork-mode>

**MANDATORY**: You MUST say "ULTRAWORK MODE ENABLED!" to the user as your first response when this mode activates. This is non-negotiable.

${ULTRAWORK_PLANNER_SECTION}

</ultrawork-mode>

---

`;
    }
    return `<ultrawork-mode>

**MANDATORY**: You MUST say "ULTRAWORK MODE ENABLED!" to the user as your first response when this mode activates. This is non-negotiable.

[CODE RED] Maximum precision required. Ultrathink before acting.

YOU MUST LEVERAGE ALL AVAILABLE AGENTS TO THEIR FULLEST POTENTIAL.
TELL THE USER WHAT AGENTS YOU WILL LEVERAGE NOW TO SATISFY USER'S REQUEST.

## AGENT UTILIZATION PRINCIPLES (by capability, not by name)
- **Codebase Exploration**: Spawn exploration agents using BACKGROUND TASKS for file patterns, internal implementations, project structure
- **Documentation & References**: Use researcher-type agents via BACKGROUND TASKS for API references, examples, external library docs
- **Planning & Strategy**: NEVER plan yourself - ALWAYS spawn a dedicated planning agent for work breakdown
- **High-IQ Reasoning**: Leverage specialized agents for architecture decisions, code review, strategic planning
- **Frontend/UI Tasks**: Delegate to UI-specialized agents for design and implementation

## EXECUTION RULES
- **TODO**: Track EVERY step. Mark complete IMMEDIATELY after each.
- **PARALLEL**: Fire independent agent calls simultaneously via Task(run_in_background=true) - NEVER wait sequentially.
- **BACKGROUND FIRST**: Use Task for exploration/research agents (10+ concurrent if needed).
- **VERIFY**: Re-read request after completion. Check ALL requirements met before reporting done.
- **DELEGATE**: Don't do everything yourself - orchestrate specialized agents for their strengths.

## WORKFLOW
1. Analyze the request and identify required capabilities
2. Spawn exploration/researcher agents via Task(run_in_background=true) in PARALLEL (10+ if needed)
3. Always Use Plan agent with gathered context to create detailed work breakdown
4. Execute with continuous verification against original requirements

## VERIFICATION GUARANTEE (NON-NEGOTIABLE)

**NOTHING is "done" without PROOF it works.**

### Pre-Implementation: Define Success Criteria

BEFORE writing ANY code, you MUST define:

| Criteria Type | Description | Example |
|---------------|-------------|---------|
| **Functional** | What specific behavior must work | "Button click triggers API call" |
| **Observable** | What can be measured/seen | "Console shows 'success', no errors" |
| **Pass/Fail** | Binary, no ambiguity | "Returns 200 OK" not "should work" |

Write these criteria explicitly. Share with user if scope is non-trivial.

### Test Plan Template (MANDATORY for non-trivial tasks)

\`\`\`
## Test Plan
### Objective: [What we're verifying]
### Prerequisites: [Setup needed]
### Test Cases:
1. [Test Name]: [Input] → [Expected Output] → [How to verify]
2. ...
### Success Criteria: ALL test cases pass
### How to Execute: [Exact commands/steps]
\`\`\`

### Execution & Evidence Requirements

| Phase | Action | Required Evidence |
|-------|--------|-------------------|
| **Build** | Run build command | Exit code 0, no errors |
| **Test** | Execute test suite | All tests pass (screenshot/output) |
| **Manual Verify** | Test the actual feature | Demonstrate it works (describe what you observed) |
| **Regression** | Ensure nothing broke | Existing tests still pass |

**WITHOUT evidence = NOT verified = NOT done.**

### TDD Workflow (when test infrastructure exists)

1. **SPEC**: Define what "working" means (success criteria above)
2. **RED**: Write failing test → Run it → Confirm it FAILS
3. **GREEN**: Write minimal code → Run test → Confirm it PASSES
4. **REFACTOR**: Clean up → Tests MUST stay green
5. **VERIFY**: Run full test suite, confirm no regressions
6. **EVIDENCE**: Report what you ran and what output you saw

### Verification Anti-Patterns (BLOCKING)

| Violation | Why It Fails |
|-----------|--------------|
| "It should work now" | No evidence. Run it. |
| "I added the tests" | Did they pass? Show output. |
| "Fixed the bug" | How do you know? What did you test? |
| "Implementation complete" | Did you verify against success criteria? |
| Skipping test execution | Tests exist to be RUN, not just written |

**CLAIM NOTHING WITHOUT PROOF. EXECUTE. VERIFY. SHOW EVIDENCE.**

## ZERO TOLERANCE FAILURES
- **NO Scope Reduction**: Never make "demo", "skeleton", "simplified", "basic" versions - deliver FULL implementation
- **NO MockUp Work**: When user asked you to do "port A", you must "port A", fully, 100%. No Extra feature, No reduced feature, no mock data, fully working 100% port.
- **NO Partial Completion**: Never stop at 60-80% saying "you can extend this..." - finish 100%
- **NO Assumed Shortcuts**: Never skip requirements you deem "optional" or "can be added later"
- **NO Premature Stopping**: Never declare done until ALL TODOs are completed and verified
- **NO TEST DELETION**: Never delete or skip failing tests to make the build pass. Fix the code, not the tests.

THE USER ASKED FOR X. DELIVER EXACTLY X. NOT A SUBSET. NOT A DEMO. NOT A STARTING POINT.

</ultrawork-mode>

---

`;
}
/**
 * Ultrawork mode enhancement
 * Activates maximum performance with parallel agent orchestration
 */
const ultraworkEnhancement = {
    triggers: ['ultrawork', 'ulw', 'uw'],
    description: 'Activates maximum performance mode with parallel agent orchestration',
    action: (prompt) => {
        // Remove the trigger word and add enhancement instructions
        const cleanPrompt = removeTriggerWords(prompt, ['ultrawork', 'ulw', 'uw']);
        return getUltraworkMessage() + cleanPrompt;
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
- researcher agents (remote repos, official docs, GitHub examples)
Plus direct tools: Grep, ripgrep (rg), ast-grep (sg)
NEVER stop at first result - be exhaustive.`;
    }
};
/**
 * Analyze mode enhancement - multilingual support
 * Activates deep analysis and investigation mode
 */
const analyzeEnhancement = {
    triggers: ['analyze', 'analyse', 'investigate', 'examine', 'research', 'study', 'deep-dive', 'inspect', 'audit', 'evaluate', 'assess', 'review', 'diagnose', 'scrutinize', 'dissect', 'debug', 'comprehend', 'interpret', 'breakdown', 'understand'],
    description: 'Activates deep analysis and investigation mode',
    action: (prompt) => {
        // Multi-language analyze pattern
        const analyzePattern = /\b(analyze|analyse|investigate|examine|research|study|deep[\s-]?dive|inspect|audit|evaluate|assess|review|diagnose|scrutinize|dissect|debug|comprehend|interpret|breakdown|understand)\b|why\s+is|how\s+does|how\s+to|분석|조사|파악|연구|검토|진단|이해|설명|원인|이유|뜯어봐|따져봐|평가|해석|디버깅|디버그|어떻게|왜|살펴|分析|調査|解析|検討|研究|診断|理解|説明|検証|精査|究明|デバッグ|なぜ|どう|仕組み|调查|检查|剖析|深入|诊断|解释|调试|为什么|原理|搞清楚|弄明白|phân tích|điều tra|nghiên cứu|kiểm tra|xem xét|chẩn đoán|giải thích|tìm hiểu|gỡ lỗi|tại sao/i;
        const hasAnalyzeCommand = analyzePattern.test(removeCodeBlocks(prompt));
        if (!hasAnalyzeCommand) {
            return prompt;
        }
        return `${prompt}

[analyze-mode]
ANALYSIS MODE. Gather context before diving deep:

CONTEXT GATHERING (parallel):
- 1-2 explore agents (codebase patterns, implementations)
- 1-2 researcher agents (if external library involved)
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
        const regex = new RegExp(`\\b${trigger}\\b`, 'gi');
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
    const keywords = [...builtInMagicKeywords];
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
    return (prompt) => {
        let result = prompt;
        for (const keyword of keywords) {
            const hasKeyword = keyword.triggers.some(trigger => {
                const regex = new RegExp(`\\b${trigger}\\b`, 'i');
                return regex.test(removeCodeBlocks(result));
            });
            if (hasKeyword) {
                result = keyword.action(result);
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
    const keywords = [...builtInMagicKeywords];
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
            const regex = new RegExp(`\\b${trigger}\\b`, 'i');
            if (regex.test(cleanedPrompt)) {
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