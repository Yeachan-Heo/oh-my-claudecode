# LoginGuarded

TLC reached 8 states and 11 steps. The chart draws 7 states and 10 arrows.
The step ThePasswordIsRight changes Session and Tries at the same time.
The step ThePasswordIsWrong changes Session and Tries at the same time.

## Rules that hold
TypeOK, SignedInWhileLocked, NoDeadlock
