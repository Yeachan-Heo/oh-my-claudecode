# CounterInstance

TLC reached 3 states and 3 steps. The chart draws 3 states and 3 arrows.

## ReachesThree breaks
TLC's counterexample is in tlc-ReachesThree.out. It has 3 steps:
0. 0
1. C!Up: 1
2. C!Up: 2
3. C!Back: 1
The run loops through "1" and "2" forever.

## Rules that hold
NoDeadlock
