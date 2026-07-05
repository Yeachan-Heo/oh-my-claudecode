export const EXPECTED_CANONICAL_SKILL_NAMES = [
  'ai-slop-cleaner',
  'ask',
  'autopilot',
  'cancel',
  'ccg',
  'configure-notifications',
  'deep-dive',
  'deep-interview',
  'deepinit',
  'external-context',
  'hud',
  'learner',
  'mcp-setup',
  'omc-doctor',
  'omc-reference',
  'omc-setup',
  'omc-teams',
  'coding-agent-sessions',
  'comment-checker',
  'lcx-contribute-bug-fix',
  'lcx-doctor',
  'lcx-report-bug',
  'lsp',
  'rules',
  'start-work',
  'teammode',
  'ulw-loop',
  'ulw-plan',
  'omc-plan',
  'project-session-manager',
  'ralph',
  'ralplan',
  'release',
  'sciomc',
  'self-improve',
  'setup',
  'skill',
  'team',
  'trace',
  'ultraqa',
  'ultrawork',
  'visual-verdict',
  'wiki',
  'writer-memory',
] as const;

export const EXPECTED_SKILL_ALIASES = [
  'ulw',
  'psm',
] as const;

export const EXPECTED_BUILTIN_SKILL_NAMES = [
  ...EXPECTED_CANONICAL_SKILL_NAMES,
  ...EXPECTED_SKILL_ALIASES,
] as const;

export const REMOVED_SKILL_NAMES = [
  'swarm',
  'stuck',
  'lorem-ipsum',
] as const;

export const CC_NATIVE_COMMAND_NAMES = [
  'compact',
  'clear',
  'help',
  'config',
  'plan',
  'review',
  'doctor',
  'init',
  'memory',
] as const;

export const EXPECTED_LAZYCODEX_AGENT_NAMES = [
  'explorer',
  'plan',
  'lazycodex-executor',
  'lazycodex-code-reviewer',
  'metis',
  'momus',
  'lazycodex-qa-executor',
  'lazycodex-gate-reviewer',
] as const;

export const EXPECTED_AGENT_NAMES = [
  'explore',
  'analyst',
  'planner',
  'architect',
  'debugger',
  'executor',
  'verifier',
  'security-reviewer',
  'code-reviewer',
  'test-engineer',
  'designer',
  'writer',
  'qa-tester',
  'scientist',
  'tracer',
  'git-master',
  'code-simplifier',
  ...EXPECTED_LAZYCODEX_AGENT_NAMES,
  'critic',
  'document-specialist',
] as const;

export const REMOVED_AGENT_NAMES = [
  'frontend-engineer',
  'document-writer',
  'multimodal-looker',
  'coordinator',
  'quality-reviewer',
  'deep-executor',
  'build-fixer',
] as const;
