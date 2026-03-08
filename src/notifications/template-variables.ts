/**
 * Template Variables for Notification System
 * 
 * Complete reference of all template variables available for custom
 * integrations (webhooks and CLI commands).
 */

export interface TemplateVariable {
  description: string;
  example: string;
  availableIn: string[];
}

/**
 * All available template variables for notification templates.
 * Variables use {{variableName}} syntax in templates.
 */
export const TEMPLATE_VARIABLES: Record<string, TemplateVariable> = {
  // Core session info
  sessionId: {
    description: 'Unique session identifier',
    example: 'sess_abc123def456',
    availableIn: ['session-start', 'session-end', 'session-stop', 'session-idle', 'ask-user-question']
  },
  projectPath: {
    description: 'Full path to project directory',
    example: '/home/user/projects/my-app',
    availableIn: ['*']
  },
  projectName: {
    description: 'Project directory name (basename)',
    example: 'my-app',
    availableIn: ['*']
  },
  timestamp: {
    description: 'ISO 8601 timestamp',
    example: '2026-03-05T14:30:00Z',
    availableIn: ['*']
  },
  event: {
    description: 'Hook event name',
    example: 'session-end',
    availableIn: ['*']
  },

  // Session metrics (session-end only)
  durationMs: {
    description: 'Session duration in milliseconds',
    example: '45000',
    availableIn: ['session-end']
  },
  duration: {
    description: 'Human-readable duration',
    example: '45s',
    availableIn: ['session-end']
  },
  agentsSpawned: {
    description: 'Number of agents spawned',
    example: '5',
    availableIn: ['session-end']
  },
  agentsCompleted: {
    description: 'Number of agents completed',
    example: '4',
    availableIn: ['session-end']
  },
  reason: {
    description: 'Session end reason',
    example: 'completed',
    availableIn: ['session-end', 'session-stop']
  },

  // Context info
  contextSummary: {
    description: 'Summary of session context',
    example: 'Task completed successfully',
    availableIn: ['session-end']
  },
  tmuxSession: {
    description: 'tmux session name',
    example: 'claude:my-project',
    availableIn: ['*']
  },
  tmuxPaneId: {
    description: 'tmux pane identifier',
    example: '%42',
    availableIn: ['*']
  },

  // Ask user question
  question: {
    description: 'Question text when input is needed',
    example: 'Which file should I edit?',
    availableIn: ['ask-user-question']
  },

  // Mode info
  activeMode: {
    description: 'Currently active OMC mode',
    example: 'ralph',
    availableIn: ['*']
  },
  modesUsed: {
    description: 'Comma-separated list of modes used',
    example: 'autopilot,ultrawork',
    availableIn: ['session-end']
  },

  // Computed/display helpers
  time: {
    description: 'Locale time string',
    example: '2:30 PM',
    availableIn: ['*']
  },
  footer: {
    description: 'tmux + project info line',
    example: 'tmux:my-session | project:my-app',
    availableIn: ['*']
  },
  projectDisplay: {
    description: 'Project name with fallbacks',
    example: 'my-app (~/projects)',
    availableIn: ['*']
  }
} as const;

export type TemplateVariableName = keyof typeof TEMPLATE_VARIABLES;

/**
 * Get all variable names available for a specific event type.
 */
export function getVariablesForEvent(event: string): TemplateVariableName[] {
  return Object.entries(TEMPLATE_VARIABLES)
    .filter(([_, variable]) => 
      variable.availableIn.includes('*') || variable.availableIn.includes(event)
    )
    .map(([name, _]) => name as TemplateVariableName);
}

/**
 * Get variable documentation as formatted string.
 */
export function getVariableDocumentation(): string {
  const lines: string[] = ['Available Template Variables:', ''];
  
  for (const [name, variable] of Object.entries(TEMPLATE_VARIABLES)) {
    const events = variable.availableIn.includes('*') 
      ? 'all events' 
      : variable.availableIn.join(', ');
    lines.push(`  {{${name}}}`);
    lines.push(`    ${variable.description}`);
    lines.push(`    Example: ${variable.example}`);
    lines.push(`    Available in: ${events}`);
    lines.push('');
  }
  
  return lines.join('\n');
}
