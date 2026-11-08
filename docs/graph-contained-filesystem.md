# Graph contained filesystem

Graph persistence uses synchronous operations bound to an open, identity-checked
directory descriptor. Child names are validated basenames. Linux uses
`/proc/self/fd`; Darwin uses a small Node-API 8 addon calling `openat`, `mkdirat`,
`fstatat`, `renameat`, `linkat`, and `unlinkat`. Darwin `/dev/fd/N/child` is not a
supported pathname interface (issue #4011).

`withContainedOperations()` keeps the directory descriptor open for its callback
and invalidates the operation object when the callback returns. Callbacks must
be synchronous. `F_GETPATH` is used only for directory containment checks, never
to recover a pathname for mutation. The old path-callback APIs remain Linux-only.

The operation interface covers run-directory creation, descriptor and snapshot
publication, journal appends, and ownership locks/epochs/tombstones. The shared
synchronous atomic writer accepts an optional operation backend, preserving its
existing inode checks, ownership hooks, backup links, rollback, and fsync ordering.
Unrelated pathname callers retain their existing behavior.

## Building and shipping

On macOS, `npm run build` compiles both arm64 and x64 addons using clang and Node
development headers. It checks the existing node-gyp header cache. Alternatively:

```sh
npm_config_nodedir=/absolute/path/to/node-v24.20.0 npm run build
# Or build just the addon with an explicit include directory:
node scripts/build-contained-fs.mjs --headers=/absolute/path/to/include/node
```

The build script does not download headers. CI downloads official Node headers
over HTTPS and verifies their SHA-256 before compiling. Outputs are
`native/contained-fs-darwin-{arm64,x64}.node`, targeting macOS 11 or newer. No npm
dependency, runtime compilation, or runtime download is added.

The graph CI job tests the actual macOS/Linux filesystems and a packed CLI.
Darwin binaries from that workflow run are included by the Linux package/release
jobs before creating the archive. Do not commit generated binaries. A local
Linux build alone does not produce Darwin binaries; assembling a cross-platform
release requires the same-source Darwin build artifacts.

If the native backend is absent or cannot load, graph commands fail before
creating persistence state. Other commands do not require loading the addon.
Install users do not need clang or Node headers when the archive contains it.

## Reproducing the acceptance checks

```sh
npm run build
npx vitest run src/graph src/lib/__tests__/atomic-write.test.ts
node scripts/verify-graph-contained-fs.mjs /absolute/installed/package/bin/oh-my-claudecode.js
```

Use the actual installed package entry for the final command. The harness runs
from an unrelated canonical temporary directory and checks fresh execution,
completed rerun without duplicated commands, SIGKILL/resume with increasing
epochs, and (on Darwin) rejection of a missing addon before persistence. The
missing-addon case modifies only an isolated package copy. It emits JSON evidence.

Graph test fixtures canonicalize their temporary roots because macOS `/var` and
`/tmp` can be symlink aliases. Deliberately supplied symlink ancestors remain
rejected; tests do not relax that protection.

## Scope of the guarantee

Directory pathname replacement must not redirect operations away from the opened
directory. Tests cover this during creation, ordinary operations, atomic
publication and rollback, as well as basename traversal, final symlinks,
hardlinks, special files, repeated directory enumeration, and expired operation
objects. Existing lock takeover and ownership-loss tests remain in force.

This change preserves the current ownership protocol; it does not claim atomic
protection against every possible malicious basename replacement inside an
already-open directory. Likewise, process-kill recovery does not establish
power-loss durability. Cross-compiling x64 is not x64 execution evidence, and a
locally packed candidate is not a published release. Record these verdicts
separately when reviewing a release.
