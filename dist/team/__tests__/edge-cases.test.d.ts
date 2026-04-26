/**
 * Edge Case Tests for MCP Team Workers
 *
 * Covers gaps not addressed by the existing 69 tests:
 * - Malformed input handling (bad JSON, unexpected types, missing fields)
 * - Boundary conditions (empty strings, long names, special characters)
 * - File system edge cases (missing files, corrupt data)
 * - Offset cursor behavior when inbox is truncated mid-line
 * - Outbox rotation boundary conditions
 * - Heartbeat with invalid/edge-case timestamps
 * - Task status transition edge cases
 * - Registration with corrupt backing files
 * - Sanitization edge cases (unicode, empty, path traversal)
 */
export {};
//# sourceMappingURL=edge-cases.test.d.ts.map