# CounterGuard

TLC reached 2 states and 1 steps. The chart draws 2 states and 1 arrows.
TLC stopped the drawing run with exit 75, so the chart draws only the states that it reached before it stopped.

## TypeOK breaks
TLC found a counterexample. It is in tlc-TypeOK.out.

## Rules not checked
Lookup, NoDeadlock
TLC stopped with exit 75 before it checked these rules:
```
Error: Evaluating invariant Lookup failed.
Attempted to apply tuple
<<"zero", "one">>
to integer 3 which is out of domain.
Error: The behavior up to this point is:
State 1: <Initial predicate>
x = 0

State 2: <Next line 6, col 9 to line 6, col 18 of module CounterGuard>
x = 1

State 3: <Next line 6, col 9 to line 6, col 18 of module CounterGuard>
x = 2

Error: The error occurred when TLC was evaluating the nested
expressions at the following positions:
0. Line 12, column 11 to line 12, column 30 in CounterGuard
1. Line 12, column 11 to line 12, column 21 in CounterGuard
```
