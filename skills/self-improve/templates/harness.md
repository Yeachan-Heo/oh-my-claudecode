# Harness Rules

## H001 — One Hypothesis Per Plan
Each plan must test exactly ONE hypothesis. Plans with zero or multiple hypotheses are rejected by the critic.

## H002 — No Approach Family Streak
The same `approach_family` must not appear as the winner for 3 or more consecutive iterations. This prevents the system from getting stuck in a local exploration loop.

## H003 — Intra-Round Diversity
Within a single round, no two plans may share the same `approach_family`. The critic rejects the later plan if a duplicate family is detected.

## Custom Rules
<!-- Add project-specific rules here -->

## Custom Approach Families
<!-- Add custom approach families here (one per line, prefixed with - or *) -->
<!-- Example: -->
<!-- - `prompt_engineering` -->
