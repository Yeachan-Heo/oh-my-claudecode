# Reviewer Lenses

The three independent review lenses for the reflect panel. Each reviewer
reads the session transcript through one lens and returns at most three
findings with citations. Adapted from pstack's reviewer definitions
(see docs/CREDITS.md).

## Tooling reviewer

Which commands, skills, and agents helped or wasted time?

- Were the right tools called for each step?
- Did any skill get invoked too late, too early, or not at all?
- Were there long stretches of unproductive tool calls?
- Was the context window spent efficiently?
- What script, automation, or skill would have prevented the biggest time
  sink?
- **Agent self-sufficiency**: flag every moment the user manually supplied
  context the agent could have fetched itself via an MCP tool (ticket
  tracker, chat, docs, observability, source control). Route to the skill
  that should have made the call.

## Judgment reviewer

Where were the calls wrong, late, or unverifiable?

- Decision points where the agent chose a direction without enough evidence
- Fixes that addressed a symptom rather than a root cause
- Verification that was inadequate for each claim
- Moments where the agent should have asked the user but proceeded (or
  vice versa)
- Which principle from the `principles` skill would have caught the
  biggest miss

## Divergent reviewer

The alternative approaches never tried. What would a fresh agent have done
differently?

- If the session started over, what would a different first step be?
- Were there simpler paths to the same outcome?
- What did the session do the hard way when an easier way existed?
- What did it NOT do that a thorough agent would have?
- What would the user's reaction be watching the full session at 10x?

## Output format

Each finding:

```
FINDING: <one sentence>
EVIDENCE: <transcript citation — approximate timestamp or tool call sequence>
RECURRENCE: every-session | sometimes | once
PROPOSED-EDIT: <which skill, which section, what change> (for recurring)
```
