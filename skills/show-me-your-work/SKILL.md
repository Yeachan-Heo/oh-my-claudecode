---
name: show-me-your-work
description: "Append-only decision trail for long or autonomous work: one TSV row per non-obvious decision — what was chosen, what was rejected and why, the deciding evidence. For work a human will audit later."
aliases: []
metadata:
  credits:
    decision-trail: pstack
    author: Lauren Tan
    url: "https://github.com/cursor/plugins/tree/main/pstack"
    port: pstack-claude
    port-author: Michael Denyer
    port-url: "https://github.com/michael-denyer/pstack-claude"
---

# Show Me Your Work

For work a human will audit after the fact, the reply is not the record —
the trail is. One row per non-obvious decision, written as it is made.

## When to use

- long, autonomous, or multi-phase work ("run until done", overnight runs)
- any task the user steps away from and will trust on return
- multi-day programs where the trail is the post-mortem

## The trail

Append to `state/decision-trail-{task-slug}.tsv` under OMC's state root
(create with a header row on first write; one file per task slug when
sessions share a checkout). The task slug is lowercase kebab-case and is
part of the canonical path. Resolve the state root the way OMC's own scripts
do — the checkout's `.omc/` by default; when `OMC_STATE_DIR` is set or a
parent `.omc-workspace` redirects state, the root moves with it, so sibling
sessions on the shared root see the same trail. Sibling sessions sharing
that root also share the file: hold a lock around the header-exists check
and each append — the same file-lock the verification-ledger writer uses
(`withFileLock` on a `<trail>.lock` sidecar) — or concurrent first writes
duplicate the header and racing appends lose rows:

```
ts <TAB> task <TAB> decision <TAB> rejected <TAB> evidence
```

- **decision**: what you chose, one sentence.
- **rejected**: the real alternatives you weighed and the one-line reason
  each lost. "None considered" is a valid, damning entry.
- **evidence**: the command, output, or citation that decided it.

Cell guard: a cell starting with `=`, `+`, `-`, or `@` is prefixed with `'`
so spreadsheet readers cannot parse it as a formula; tabs and newlines
inside a cell become spaces. Append only — the trail is never rewritten.

The locked append is concrete, not a convention. Resolve the installed
package root as the verification-ledger writer does, then hold its
`withFileLock` (from `dist/lib/file-lock.js`) around the header check and
the `appendFileSync` call:

```sh
node --input-type=module -e "const {createRequire}=await import('node:module'); const path=await import('node:path'); const {pathToFileURL}=await import('node:url'); let root=process.env.CLAUDE_PLUGIN_ROOT||process.env.OMC_PLUGIN_ROOT; if(!root){ const req=createRequire(process.cwd()+'/package.json'); for (const name of ['oh-my-claude-sisyphus','oh-my-claudecode']) { try { root=path.dirname(req.resolve(name+'/package.json')); break; } catch {} } } const {withFileLock}=await import(pathToFileURL(root+'/dist/lib/file-lock.js').href); const trail='<state-root>/state/decision-trail-<project-id>-<task-slug>.tsv'; await withFileLock(trail+'.lock', async () => { const fs=await import('node:fs'); let header=''; try { header=fs.readFileSync(trail,'utf8').split('\n')[0]; } catch {} if (header !== 'ts\ttask\tdecision\trejected\tevidence') { fs.appendFileSync(trail, 'ts\ttask\tdecision\trejected\tevidence\n'); } fs.appendFileSync(trail, '<row>\n'); });"
```
The lock path is `<trail>.lock`, matching the ledger writer's sidecar
convention, so every writer that follows this skill serializes against the
same lock.

## Rules

- Log at decision time, not at recap time; a trail reconstructed at the end
  is fiction with a timestamp.
- Routine mechanical steps are not decisions; judgment calls, scope changes,
  and risk acceptances are.
- The final reply summarizes the trail and links it; the trail itself stays
  the auditable artifact. It is local runtime state under OMC's state root —
  by repository policy it is not committed; when stakes need an immutable
  record, quote the decisive rows into the PR description or the linked
  issue instead of force-adding runtime state.
