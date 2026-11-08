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

import { resolveSessionStatePaths, type ReadPath, type WritePath } from '../worktree-paths.js';

declare function writeTo(p: WritePath, data: string): void;
declare function readFrom(p: ReadPath): string;

const paths = resolveSessionStatePaths('foo', 'sid');

// Positive cases — these must compile cleanly.
writeTo(paths.effectiveWrite, 'x');
const _read: string = readFrom(paths.effectiveRead);
void _read;

// Negative case 1: ReadPath cannot be passed where WritePath is expected.
// @ts-expect-error — ReadPath is not assignable to WritePath
writeTo(paths.effectiveRead, 'x');

// Negative case 2: WritePath cannot be passed where ReadPath is expected.
// @ts-expect-error — WritePath is not assignable to ReadPath
readFrom(paths.effectiveWrite);

// Negative case 3: A plain `string` cannot be coerced to either brand.
const plain: string = 'some/path/foo.json';
// @ts-expect-error — plain string lacks the WritePath brand
writeTo(plain, 'x');
// @ts-expect-error — plain string lacks the ReadPath brand
readFrom(plain);
