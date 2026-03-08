/**
 * Custom Integration Validation
 * 
 * Validates custom integration configurations for security and correctness.
 */

import type { CustomIntegration, WebhookIntegrationConfig, CliIntegrationConfig } from './types.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const VALID_HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const MIN_TIMEOUT = 1000; // 1 second
const MAX_TIMEOUT = 60000; // 60 seconds
const VALID_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate a custom integration configuration.
 */
export function validateCustomIntegration(integration: CustomIntegration): ValidationResult {
  const errors: string[] = [];

  // Validate ID format
  if (!integration.id) {
    errors.push('Integration ID is required');
  } else if (!VALID_ID_PATTERN.test(integration.id)) {
    errors.push('Integration ID must be alphanumeric with hyphens/underscores only');
  }

  // Validate type
  if (!integration.type || !['webhook', 'cli'].includes(integration.type)) {
    errors.push('Type must be either "webhook" or "cli"');
  }

  // Validate events
  if (!integration.events || integration.events.length === 0) {
    errors.push('At least one event must be selected');
  }

  // Type-specific validation
  if (integration.type === 'webhook') {
    const webhookErrors = validateWebhookIntegrationConfig(integration.config as WebhookIntegrationConfig);
    errors.push(...webhookErrors);
  } else if (integration.type === 'cli') {
    const cliErrors = validateCliIntegrationConfig(integration.config as CliIntegrationConfig);
    errors.push(...cliErrors);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate webhook configuration.
 */
function validateWebhookIntegrationConfig(config: WebhookIntegrationConfig): string[] {
  const errors: string[] = [];

  // URL validation
  if (!config.url) {
    errors.push('Webhook URL is required');
  } else {
    try {
      const url = new URL(config.url);
      
      // Require HTTPS for non-localhost URLs
      if (url.protocol !== 'https:' && 
          url.hostname !== 'localhost' && 
          url.hostname !== '127.0.0.1') {
        errors.push('Webhook URL must use HTTPS (except localhost for development)');
      }
      
      // Block file:// and other unsafe protocols
      if (url.protocol === 'file:' || url.protocol === 'ftp:' || url.protocol === 'sftp:') {
        errors.push(`Protocol "${url.protocol}" is not allowed`);
      }
    } catch {
      errors.push('Invalid webhook URL');
    }
  }

  // Method validation
  if (!config.method) {
    errors.push('HTTP method is required');
  } else if (!VALID_HTTP_METHODS.includes(config.method as typeof VALID_HTTP_METHODS[number])) {
    errors.push(`Invalid HTTP method. Must be one of: ${VALID_HTTP_METHODS.join(', ')}`);
  }

  // Timeout validation
  if (config.timeout !== undefined) {
    if (config.timeout < MIN_TIMEOUT || config.timeout > MAX_TIMEOUT) {
      errors.push(`Timeout must be between ${MIN_TIMEOUT}ms and ${MAX_TIMEOUT}ms`);
    }
  }

  // Header validation (prevent injection)
  if (config.headers) {
    for (const [key, value] of Object.entries(config.headers)) {
      // Check for CRLF injection
      if (/[\r\n]/.test(key)) {
        errors.push(`Header name contains invalid characters: "${key}"`);
      }
      if (/[\r\n]/.test(String(value))) {
        errors.push(`Header value contains invalid characters for key: "${key}"`);
      }
      
      // Check for null bytes
      if (/\0/.test(key) || /\0/.test(String(value))) {
        errors.push(`Header contains null bytes: "${key}"`);
      }
    }
  }

  return errors;
}

/**
 * Validate CLI configuration.
 */
function validateCliIntegrationConfig(config: CliIntegrationConfig): string[] {
  const errors: string[] = [];

  // Command validation
  if (!config.command) {
    errors.push('Command is required');
  } else {
    // Command must be a single executable, no spaces or shell metacharacters
    if (config.command.includes(' ')) {
      errors.push('Command must be a single executable path (no spaces or arguments)');
    }
    
    // Check for shell metacharacters
    const shellMetacharacters = /[;&|`$(){}[\]<>!#*?~]/;
    if (shellMetacharacters.test(config.command)) {
      errors.push('Command contains shell metacharacters');
    }
  }

  // Arguments validation
  if (config.args && Array.isArray(config.args)) {
    for (const arg of config.args) {
      // Check for shell metacharacters outside of template syntax
      const withoutTemplates = arg.replace(/\{\{[^}]+\}\}/g, '');
      const shellMetacharacters = /[;&|`$(){}[\]<>!#*?~]/;
      
      if (shellMetacharacters.test(withoutTemplates)) {
        errors.push(`Argument contains shell metacharacters: "${arg}"`);
      }
      
      // Check for null bytes
      if (/\0/.test(arg)) {
        errors.push(`Argument contains null bytes: "${arg}"`);
      }
    }
  }

  // Timeout validation
  if (config.timeout !== undefined) {
    if (config.timeout < MIN_TIMEOUT || config.timeout > MAX_TIMEOUT) {
      errors.push(`Timeout must be between ${MIN_TIMEOUT}ms and ${MAX_TIMEOUT}ms`);
    }
  }

  return errors;
}

/**
 * Check for duplicate integration IDs in a list.
 */
export function checkDuplicateIds(integrations: CustomIntegration[]): string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];

  for (const integration of integrations) {
    if (seen.has(integration.id)) {
      duplicates.push(integration.id);
    }
    seen.add(integration.id);
  }

  return duplicates;
}

/**
 * Sanitize a command argument to prevent injection.
 * This is a defensive measure - the primary defense is using execFile.
 */
export function sanitizeArgument(arg: string): string {
  // Remove null bytes
  let sanitized = arg.replace(/\0/g, '');
  
  // Remove control characters except common whitespace
  sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  
  return sanitized;
}
