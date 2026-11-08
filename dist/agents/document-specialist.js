/**
 * Document Specialist Agent - Documentation and External Reference Finder
 *
 * Searches external resources: official docs, GitHub, Stack Overflow.
 * For internal codebase searches, use explore agent instead.
 *
 * Ported from oh-my-opencode's document specialist agent.
 */
import { loadAgentPrompt } from "./utils.js";
export const DOCUMENT_SPECIALIST_PROMPT_METADATA = {
    category: "exploration",
    cost: "CHEAP",
    promptAlias: "document-specialist",
    triggers: [
        {
            domain: "Project documentation",
            trigger: "README, docs/, migration guides, local references",
        },
        {
            domain: "External documentation",
            trigger: "API references, official docs",
        },
        {
            domain: "API/framework correctness",
            trigger: "Context Hub / chub first when available; curated backend fallback otherwise",
        },
        {
            domain: "OSS implementations",
            trigger: "GitHub examples, package source",
        },
        {
            domain: "Best practices",
            trigger: "Community patterns, recommendations",
        },
        {
            domain: "Literature and reference research",
            trigger: "Academic papers, manuals, reference databases",
        },
    ],
    useWhen: [
        "Checking README/docs/local reference files before broader research",
        "Looking up official documentation",
        "Using Context Hub / chub (or another curated docs backend) for external API/framework correctness when available",
        "Finding GitHub examples",
        "Researching npm/pip packages",
        "Stack Overflow solutions",
        "External API references",
        "Searching external literature or academic papers",
        "Looking up manuals, databases, or reference material outside the current project",
    ],
    avoidWhen: [
        "Internal codebase implementation search (use explore)",
        "Current project source files when the task is code discovery rather than documentation lookup (use explore)",
        "When you already have the information",
    ],
};
export const documentSpecialistAgent = {
    name: "document-specialist",
    description: "Document Specialist for documentation research and reference finding. Use for local repo docs, official docs, Context Hub / chub or other curated docs backends for API/framework correctness, GitHub examples, OSS implementations, external literature, academic papers, and reference/database lookups. Avoid internal implementation search; use explore for code discovery.",
    prompt: loadAgentPrompt("document-specialist"),
    model: "sonnet",
    defaultModel: "sonnet",
    metadata: DOCUMENT_SPECIALIST_PROMPT_METADATA,
};
//# sourceMappingURL=document-specialist.js.map