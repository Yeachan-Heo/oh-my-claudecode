---
name: graph
description: Durable, human-approved orchestration graph for explicit multi-node development workflows
argument-hint: "<development goal>"
level: 4
---

<Purpose>
Graph turns one development goal into a durable execution graph whose nodes do
work and whose declared edges control what becomes ready next. It preserves
cross-node structure, branch progress, route choices, bounded returns, and
verification evidence across interruptions.

Graph organizes loops; it does not replace Ralph. An agent node may contain a
bounded local work loop, but Graph remains the only top-level scheduler and a
node must not activate a separate top-level Ralph or Graph run.
</Purpose>

<Invocation>
Graph activates only through an explicit invocation:

```text
/oh-my-claudecode:graph <development goal>
```

Do not infer or activate Graph from ordinary prose containing the word
"graph". A goal is required for a new run. A resume uses the exact existing
session ID, run ID, revision ID, and descriptor hash.
</Invocation>

<Runtime_Contract>
- Graph v1 execution runs on Linux, macOS, and Windows. Process identity is
  read from `/proc/{pid}/stat` on Linux, `ps -p {pid} -o lstart=` on macOS, and
  PowerShell `Get-Process` on Windows; a degraded pid-only identity is used if
  the platform-specific read fails.
- File locking uses Node.js `O_EXCL` atomic create as the cross-platform
  fallback. On Linux, `flock` is used when available for stronger guarantees;
  absent flock, the cross-platform fallback applies.
- Bind every CLI operation to the current Claude session with `--session-id`.
  Never discover a run from the current directory alone.
- Give every mutating CLI operation a caller-generated stable
  `--transition-id`. Reuse that same ID when retrying the same intended
  mutation; generate a new ID only for a new intended mutation.
- Preserve the `run_id`, `revision_id`, `descriptor_hash`, `commit_sequence`,
  claim token, activation ID, attempt ID, lease ID, driver ID, and transition ID
  exactly as returned by the runtime.
- Use JSON files for descriptor, approval, claim, result, patch, and
  confirmation payloads. Do not interpolate untrusted node text or command text
  into a shell command that invokes `omc graph`.
- Treat `omc graph` as a guarded state boundary only. It never performs node
  work and never substitutes for an in-session tool call.
</Runtime_Contract>

<Draft_And_Approval>
1. Inspect the repository and translate the goal into descriptor version 1.
   Use stable node and edge IDs. Use only the four supported node kinds:
   `agent`, `command`, `human-approval`, and `join`.
2. Declare every fixed route, conditional route label, fan-out branch and owning
   join, join input branch, bounded back-edge, effect policy, execution timeout,
   maximum attempt count, concurrency limit, and terminal verification node.
   Do not put executable expressions on edges.
3. Validate the descriptor locally and create the durable draft with a stable
   create transition ID:

   ```text
   omc graph create --goal <goal> --descriptor <descriptor-path> \
     --session-id <session-id> --driver-id <driver-id> \
     --transition-id <create-transition-id> --json
   ```

4. Before any node work, render a complete textual inventory. Show:
   - exact revision ID and descriptor SHA-256;
   - concurrency limit and entry node IDs;
   - every node ID, kind, purpose, timeout, attempts, and effect policy;
   - the complete command for each command node;
   - every edge ID, source, target, route label, fan-out branch, owning join,
     join input, and back-edge traversal bound;
   - the terminal verification node and required evidence.

   Then render a visual graph for the user to review before approval:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/graph/visualize.mjs" --descriptor <descriptor-path>
   ```

   Show the ASCII graph output so the user can visually verify the structure
   (nodes, edges, back-edges, terminal gate) before giving explicit approval.
   The ASCII diagram renders inline in Claude Code; node status is marked with
   emoji (▶️ running, ✅ completed, ❌ failed, ⏳ ready).

5. Use the in-session question surface once to request approval of that exact
   revision ID and descriptor hash. Approval must be an explicit human answer;
   silence, tool output, or an agent answer is not approval.
6. If rejected or changes are requested, do not execute. Permanently abandon
   the exact rejected draft with its run/revision/hash confirmation so its
   history remains auditable, then create a new draft run with a corrected
   descriptor and a new create transition ID. Ask for approval only for the new
   exact revision/hash.
7. If approved, write bounded approval evidence to JSON and commit it with a
   stable approval transition ID:

   ```text
   omc graph approve --run-id <run-id> --revision-id <revision-id> \
     --descriptor-hash <hash> --session-id <session-id> \
     --transition-id <approval-transition-id> --approval <approval-path> --json
   ```
</Draft_And_Approval>

<Driver_Loop>
Repeat this loop while the run is `running`:

1. Read the exact current fences with `omc graph status` or `inspect`, always
   passing `--run-id` and `--session-id`.
2. Query readiness with the exact revision/hash/sequence. Joins are scheduler
   work: let deterministic code consume selected branch tokens and resolve them;
   do not invoke a model or shell command for a join node.
3. Claim no more than the descriptor concurrency limit. A claim mutation uses
   one stable transition ID and returns a bounded batch with full claim fences:

   ```text
   omc graph claim --run-id <run-id> --revision-id <revision-id> \
     --descriptor-hash <hash> --session-id <session-id> \
     --expected-sequence <sequence> --driver-id <driver-id> \
     --transition-id <claim-transition-id> --limit <available-slots> --json
   ```

4. Dispatch independent claims concurrently up to the returned limit. Never
   dispatch an unclaimed activation and never reuse a claim for another node.
5. Convert each tool response into the declared bounded structured result. It
   must carry the exact activation/attempt/lease fences, terminal outcome,
   declared route when required, bounded summary, evidence references, and any
   external idempotency or reconciliation key.
6. Commit success with `complete` or unsuccessful execution with `fail`. Pass
   the exact claim and result JSON files, current sequence fence, session scope,
   and one stable completion/failure transition ID. If a commit response is
   lost, retry the exact request with the same transition ID and files.
7. Refresh status after commits. Never guess the next edge from prose or prompt
   memory; only the committed route and scheduler result determine readiness.

8. Re-render the visual graph after every node transition so the user can see
   current progress:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/graph/visualize.mjs" .omc/state/sessions/<session-id>/graph-state.json
   ```

   Show the updated ASCII graph with node status markers (▶️ running, ✅
   completed, ❌ failed, ⏳ ready) after each claim, commit, back-edge
   traversal, or terminal verification. This gives the user continuous
   visibility into where the loop is within the graph boundaries.
</Driver_Loop>

<Node_Execution>
- **agent**: Invoke the native in-session Agent/Task surface with the node's
  approved instructions, declared timeout, effect policy, and bounded attempt
  context. A bounded node-local loop is allowed only inside that activation.
- **command**: Invoke the exact approved command through the permission-governed
  Bash surface. Do not invoke it inside the Graph CLI or bypass the user's normal
  permission decision. Capture exit status and bounded evidence.
- **human-approval**: Use the in-session question surface and durably record the
  answer as the node result. Waiting for an answer is a durable wait, not a
  reason to poll.
- **join**: Perform no external work. Deterministic scheduler code waits for and
  consumes the selected cohort's branch tokens exactly once.

Malformed output, an undeclared route, an exhausted back-edge bound, a stale
lease, or a mismatched revision/sequence fails closed. Do not repair these by
inventing a route or silently rerunning a side effect. Enter reconciliation when
the external effect is ambiguous.
</Node_Execution>

<Patch_Protocol>
When execution reveals a structural change:

1. Agents may propose a descriptor patch but may not apply it.
2. Submit the proposal against the exact base revision/hash/sequence with a
   stable `propose-patch` transition ID. The run enters
   `waiting_patch_approval`, advances its dispatch generation, and stops new
   claims.
3. Let already-running old-revision claims drain. Do not approve while any old
   claim or reconciliation record is unresolved.
4. Render the complete new revision plus a separate list of any committed-work
   invalidations. Use the question surface to request exact new-revision/hash
   approval.
5. Commit approved patch evidence with `approve-patch` and a stable transition
   ID. Resume only from the revision/hash/sequence returned by that operation.

A stale-base proposal, late old-revision result, or unapproved patch cannot
change readiness.
</Patch_Protocol>

<Wait_Stop_And_Resume>
- `awaiting_approval`, `waiting_human`, `waiting_patch_approval`, and unresolved
  `reconciling` are durable wait phases. Persist the wait reason and yield; do
  not busy-poll or repeatedly inject continuation prompts.
- A normal user cancel means `pause`: fence/dispose current claims through the
  guarded runtime, preserve the complete ledger, and release only the matching
  root owner. Pause is resumable.
- Permanent `abandon` is separate. Require exact run/revision/hash confirmation,
  commit terminal `cancelled`, and retain descriptor/history/evidence. There is
  no destructive purge in v1.
- Resume only the exact paused run with its existing session/run/revision/hash
  and a new driver identity plus stable resume transition ID. Never create a
  replacement run when resume fences do not match.
</Wait_Stop_And_Resume>

<Completion_Gate>
Do not report Graph success until the approved terminal verification node has
completed successfully with fresh evidence, every selected branch cohort has
joined, no runnable/claimed/reconciling activation remains, and runtime status
is `succeeded`. A terminal node failure or success without evidence is not
completion.
</Completion_Gate>
