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
export declare const TEMPLATE_VARIABLES: Record<string, TemplateVariable>;
export type TemplateVariableName = keyof typeof TEMPLATE_VARIABLES;
/**
 * Get all variable names available for a specific event type.
 */
export declare function getVariablesForEvent(event: string): TemplateVariableName[];
/**
 * Get variable documentation as formatted string.
 */
export declare function getVariableDocumentation(): string;
//# sourceMappingURL=template-variables.d.ts.map