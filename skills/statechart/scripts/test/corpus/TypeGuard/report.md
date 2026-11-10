# TypeGuard

TLC reached 3 states and 2 steps. The chart draws 3 states and 2 arrows.
TLC stopped the drawing run with exit 76, so the chart draws only the states that it reached before it stopped.

## TypeOK breaks
The shortest path has 2 steps:
0. 0
1. Next: 1
2. Next: 2

## Rules not checked
NeedsTypeOK, NoDeadlock
TLC stopped with exit 76 before it checked these rules:
```
Error: Evaluating invariant NeedsTypeOK failed.
Attempted to apply tuple
<<"zero", "one">>
to integer 3 which is out of domain.
Error: The behavior up to this point is:
State 1: <Initial predicate>
x = 0

State 2: <Next line 6, col 9 to line 6, col 27 of module TypeGuard>
x = 1

State 3: <Next line 6, col 9 to line 6, col 27 of module TypeGuard>
x = 2
```
