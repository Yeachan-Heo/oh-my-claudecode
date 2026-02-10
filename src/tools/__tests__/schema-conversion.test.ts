/**
 * Schema Conversion Tests
 *
 * Tests the zodToJsonSchema and zodTypeToJsonSchema functions
 * used in src/tools/index.ts and src/mcp/standalone-server.ts.
 *
 * Verifies conversion of: string, number, boolean, optional, defaults,
 * enums, objects, arrays, nested objects, and edge cases.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { toSdkToolFormat, createZodSchema, GenericToolDefinition } from '../index.js';

/**
 * Helper: Create a minimal tool definition for testing schema conversion.
 */
function makeToolDef(schema: z.ZodRawShape): GenericToolDefinition {
  return {
    name: 'test_tool',
    description: 'Test tool for schema conversion',
    schema,
    handler: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
  };
}

/**
 * Helper: Convert a Zod schema shape to JSON Schema via toSdkToolFormat.
 */
function convertSchema(schema: z.ZodRawShape) {
  const tool = makeToolDef(schema);
  const sdkFormat = toSdkToolFormat(tool);
  return sdkFormat.inputSchema;
}

// ============================================================================
// Basic Type Conversions
// ============================================================================

describe('zodToJsonSchema - Basic Types', () => {
  it('should convert z.string() to { type: "string" }', () => {
    const result = convertSchema({ name: z.string() });
    expect(result.properties.name).toEqual({ type: 'string' });
    expect(result.required).toContain('name');
  });

  it('should convert z.number() to { type: "number" }', () => {
    const result = convertSchema({ count: z.number() });
    expect(result.properties.count).toEqual({ type: 'number' });
    expect(result.required).toContain('count');
  });

  it('should convert z.number().int() to { type: "integer" }', () => {
    const result = convertSchema({ count: z.number().int() });
    expect(result.properties.count).toEqual({ type: 'integer' });
  });

  it('should convert z.boolean() to { type: "boolean" }', () => {
    const result = convertSchema({ enabled: z.boolean() });
    expect(result.properties.enabled).toEqual({ type: 'boolean' });
    expect(result.required).toContain('enabled');
  });
});

// ============================================================================
// Optional and Default
// ============================================================================

describe('zodToJsonSchema - Optional & Default', () => {
  it('should not include optional fields in required', () => {
    const result = convertSchema({
      name: z.string(),
      nickname: z.string().optional(),
    });

    expect(result.required).toContain('name');
    expect(result.required).not.toContain('nickname');
  });

  it('should convert optional string to { type: "string" }', () => {
    const result = convertSchema({ label: z.string().optional() });
    expect(result.properties.label).toEqual({ type: 'string' });
    expect(result.required).not.toContain('label');
  });

  it('should handle default values', () => {
    const result = convertSchema({
      timeout: z.number().default(30),
    });

    const prop = result.properties.timeout as Record<string, unknown>;
    expect(prop.type).toBe('number');
    expect(prop.default).toBe(30);
    // Default fields are not required
    expect(result.required).not.toContain('timeout');
  });

  it('should handle default boolean', () => {
    const result = convertSchema({
      verbose: z.boolean().default(false),
    });

    const prop = result.properties.verbose as Record<string, unknown>;
    expect(prop.type).toBe('boolean');
    expect(prop.default).toBe(false);
  });
});

// ============================================================================
// Enums
// ============================================================================

describe('zodToJsonSchema - Enums', () => {
  it('should convert z.enum to string with enum values', () => {
    const result = convertSchema({
      severity: z.enum(['error', 'warning', 'info', 'hint']),
    });

    const prop = result.properties.severity as Record<string, unknown>;
    expect(prop.type).toBe('string');
    expect(prop.enum).toEqual(['error', 'warning', 'info', 'hint']);
  });

  it('should handle single-value enum', () => {
    const result = convertSchema({
      type: z.enum(['fixed']),
    });

    const prop = result.properties.type as Record<string, unknown>;
    expect(prop.enum).toEqual(['fixed']);
  });
});

// ============================================================================
// Arrays
// ============================================================================

describe('zodToJsonSchema - Arrays', () => {
  it('should convert z.array(z.string()) to array of strings', () => {
    const result = convertSchema({
      tags: z.array(z.string()),
    });

    const prop = result.properties.tags as Record<string, unknown>;
    expect(prop.type).toBe('array');
    expect(prop.items).toEqual({ type: 'string' });
  });

  it('should convert z.array(z.number()) to array of numbers', () => {
    const result = convertSchema({
      values: z.array(z.number()),
    });

    const prop = result.properties.values as Record<string, unknown>;
    expect(prop.type).toBe('array');
    expect(prop.items).toEqual({ type: 'number' });
  });

  it('should handle optional arrays', () => {
    const result = convertSchema({
      items: z.array(z.string()).optional(),
    });

    const prop = result.properties.items as Record<string, unknown>;
    expect(prop.type).toBe('array');
    expect(result.required).not.toContain('items');
  });
});

// ============================================================================
// Descriptions
// ============================================================================

describe('zodToJsonSchema - Descriptions', () => {
  it('should include description from .describe()', () => {
    const result = convertSchema({
      file: z.string().describe('Path to the source file'),
    });

    const prop = result.properties.file as Record<string, unknown>;
    expect(prop.description).toBe('Path to the source file');
  });

  it('should include description on enum fields', () => {
    const result = convertSchema({
      mode: z.enum(['read', 'write']).describe('Access mode'),
    });

    const prop = result.properties.mode as Record<string, unknown>;
    expect(prop.description).toBe('Access mode');
  });
});

// ============================================================================
// Nested Objects
// ============================================================================

describe('zodToJsonSchema - Nested Objects', () => {
  it('should convert nested z.object', () => {
    const result = convertSchema({
      config: z.object({
        name: z.string(),
        port: z.number(),
      }),
    });

    const prop = result.properties.config as Record<string, unknown>;
    expect(prop).toBeDefined();
    // Nested object should have type: 'object' and properties
    expect((prop as Record<string, unknown>).type).toBe('object');
    const nestedProps = (prop as Record<string, unknown>).properties as Record<string, unknown>;
    expect(nestedProps.name).toEqual({ type: 'string' });
    expect(nestedProps.port).toEqual({ type: 'number' });
  });

  it('should handle deeply nested objects', () => {
    const result = convertSchema({
      outer: z.object({
        inner: z.object({
          value: z.string(),
        }),
      }),
    });

    const outer = result.properties.outer as Record<string, unknown>;
    expect(outer.type).toBe('object');
    const outerProps = outer.properties as Record<string, unknown>;
    const inner = outerProps.inner as Record<string, unknown>;
    expect(inner.type).toBe('object');
    const innerProps = inner.properties as Record<string, unknown>;
    expect(innerProps.value).toEqual({ type: 'string' });
  });
});

// ============================================================================
// Output Validity
// ============================================================================

describe('zodToJsonSchema - Output Validity', () => {
  it('should always produce type: "object" at top level', () => {
    const result = convertSchema({ x: z.string() });
    expect(result.type).toBe('object');
  });

  it('should always have a properties object', () => {
    const result = convertSchema({ x: z.string() });
    expect(typeof result.properties).toBe('object');
  });

  it('should always have a required array', () => {
    const result = convertSchema({ x: z.string() });
    expect(Array.isArray(result.required)).toBe(true);
  });

  it('should produce valid JSON Schema for complex tool', () => {
    const result = convertSchema({
      file: z.string().describe('Path to source file'),
      line: z.number().int().describe('Line number'),
      character: z.number().int().describe('Character offset'),
      includeDeclaration: z.boolean().optional(),
    });

    expect(result.type).toBe('object');
    expect(result.required).toEqual(['file', 'line', 'character']);
    expect(result.properties.file).toEqual({ type: 'string', description: 'Path to source file' });
    expect(result.properties.line).toEqual({ type: 'integer', description: 'Line number' });
    expect(result.properties.character).toEqual({ type: 'integer', description: 'Character offset' });
    expect(result.properties.includeDeclaration).toEqual({ type: 'boolean' });
  });

  it('should handle empty schema', () => {
    const result = convertSchema({});
    expect(result.type).toBe('object');
    expect(result.properties).toEqual({});
    expect(result.required).toEqual([]);
  });
});

// ============================================================================
// createZodSchema Helper
// ============================================================================

describe('createZodSchema', () => {
  it('should create a ZodObject from raw shape', () => {
    const schema = createZodSchema({
      name: z.string(),
      age: z.number(),
    });

    // Should be a valid Zod schema that can parse
    const result = schema.parse({ name: 'Alice', age: 30 });
    expect(result.name).toBe('Alice');
    expect(result.age).toBe(30);
  });

  it('should reject invalid input', () => {
    const schema = createZodSchema({
      name: z.string(),
    });

    expect(() => schema.parse({ name: 123 })).toThrow();
  });
});

// ============================================================================
// Documented Gaps
// ============================================================================

describe('zodToJsonSchema - Documented Gaps', () => {
  it('should fall back to string type for unsupported Zod types', () => {
    // z.any(), z.unknown(), z.union() etc. are not explicitly handled
    // The fallback is { type: 'string' }
    const result = convertSchema({
      // z.any() is not one of the handled types
      data: z.any(),
    });

    const prop = result.properties.data as Record<string, unknown>;
    // Fallback: unknown types become string
    expect(prop.type).toBe('string');
  });
});
