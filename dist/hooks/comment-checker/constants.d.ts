/**
 * Comment Checker Constants
 *
 * Keywords and patterns for comment detection and filtering.
 *
 * Adapted from oh-my-opencode's comment-checker hook.
 */
/**
 * BDD (Behavior-Driven Development) keywords that are acceptable in comments
 */
export declare const BDD_KEYWORDS: Set<string>;
/**
 * Prefixes for type checker and linter directives (acceptable comments)
 */
export declare const TYPE_CHECKER_PREFIXES: string[];
/**
 * Header message for comment detection
 */
export declare const HOOK_MESSAGE_HEADER = "COMMENT/DOCSTRING DETECTED - IMMEDIATE ACTION REQUIRED\n\nYour recent changes contain comments or docstrings, which triggered this hook.\nYou need to take immediate action. You must follow the conditions below.\n(Listed in priority order - you must always act according to this priority order)\n\nCRITICAL WARNING: This hook message MUST NEVER be ignored, even if you receive it multiple times.\nYou MUST provide corresponding explanation or action for EACH occurrence of this message.\nIgnoring this message or failing to respond appropriately is strictly prohibited.\n\nPRIORITY-BASED ACTION GUIDELINES:\n\n1. This is a comment/docstring that already existed before\n   -> Explain to the user that this is an existing comment/docstring and proceed (justify it)\n\n2. This is a newly written comment: but it's in given, when, then format\n   -> Tell the user it's a BDD comment and proceed (justify it)\n   -> Note: This applies to comments only, not docstrings\n\n3. This is a newly written comment/docstring: but it's a necessary comment/docstring\n   -> Tell the user why this comment/docstring is absolutely necessary and proceed (justify it)\n   -> Examples of necessary comments: complex algorithms, security-related, performance optimization, regex, mathematical formulas\n   -> Examples of necessary docstrings: public API documentation, complex module/class interfaces\n   -> IMPORTANT: Most docstrings are unnecessary if the code is self-explanatory. Only keep truly essential ones.\n\n4. This is a newly written comment/docstring: but it's an unnecessary comment/docstring\n   -> Apologize to the user and remove the comment/docstring.\n   -> Make the code itself clearer so it can be understood without comments/docstrings.\n   -> For verbose docstrings: refactor code to be self-documenting instead of adding lengthy explanations.\n\nCODE SMELL WARNING: Using comments as visual separators (e.g., \"// =========\", \"# ---\", \"// *** Section ***\")\nis a code smell. If you need separators, your file is too long or poorly organized.\nRefactor into smaller modules or use proper code organization instead of comment-based section dividers.\n\nMANDATORY REQUIREMENT: You must acknowledge this hook message and take one of the above actions.\nReview in the above priority order and take the corresponding action EVERY TIME this appears.\n\nDetected comments/docstrings:\n";
/**
 * Pattern for detecting line comments by language
 */
export declare const LINE_COMMENT_PATTERNS: Record<string, RegExp>;
/**
 * File extensions to language mapping
 */
export declare const EXTENSION_TO_LANGUAGE: Record<string, string>;
//# sourceMappingURL=constants.d.ts.map