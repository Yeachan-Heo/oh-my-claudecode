/**
 * Template Interpolation Engine
 *
 * Lightweight {{variable}} interpolation with {{#if var}}...{{/if}} conditionals.
 * No external dependencies. Produces output matching current formatter.ts functions.
 */
import type { NotificationPayload, NotificationEvent } from "./types.js";
/**
 * Build the full variable map from a notification payload.
 * Includes raw payload fields (string-converted) and computed variables.
 */
export declare function computeTemplateVariables(payload: NotificationPayload): Record<string, string>;
/**
 * Interpolate a template string with payload values.
 *
 * 1. Process {{#if var}}...{{/if}} conditionals
 * 2. Replace {{variable}} placeholders
 * 3. Post-process to normalize blank lines
 */
export declare function interpolateTemplate(template: string, payload: NotificationPayload): string;
/** Interpolate JSON string values without injecting payload text into JSON syntax. */
export declare function interpolateJsonTemplate(template: string, payload: NotificationPayload): string;
/**
 * Validate a template string for unknown variables.
 * Returns { valid, unknownVars }.
 */
export declare function validateTemplate(template: string): {
    valid: boolean;
    unknownVars: string[];
};
/**
 * Get the default template for an event type.
 * When interpolated, produces output identical to formatter.ts functions.
 */
export declare function getDefaultTemplate(event: NotificationEvent): string;
//# sourceMappingURL=template-engine.d.ts.map