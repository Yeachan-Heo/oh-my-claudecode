# Jev integration degrades to heuristics

Jev (TypeSafe System One) will replace OMC's heuristic judgment points: mode/skill triggering, model-tier routing, loop continuation, context pruning, and the fact-forcing gate. Per the product decision, Jev is opt-in via configuration: when `TYPESAFE_API_KEY` is absent, or the API is unavailable, timed out, or over budget, every Jev-powered judgment point runs its heuristic twin and the workflow never blocks on Jev. Rejected: fail-closed — blocking the orchestration on an external judgment API would make OMC hostage to one dependency.
