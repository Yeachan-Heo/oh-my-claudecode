/**
 * Type-level test for branded ReadPath/WritePath enforcement (Wave A US-A6).
 *
 * This is a TYPE TEST, not a runtime test. It compiles-but-never-runs to
 * assert that the TypeScript compiler rejects misuse of the branded path
 * struct returned by `resolveSessionStatePaths`. The `@ts-expect-error`
 * directives are the assertions: if the compiler stops reporting the
 * expected error (e.g. because someone weakens the brand), tsc will fail
 * the build.
 *
 * Run via `npx tsc --noEmit` (covered by `npm run build`). This file is
 * skipped by vitest because it has no `describe`/`it` and no runtime
 * assertions.
 */
export {};
//# sourceMappingURL=session-state-paths.type-test.d.ts.map