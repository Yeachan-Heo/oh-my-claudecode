# CounterView

TLC reached 5 states and 4 steps. The chart draws 4 states and 5 arrows.
1 state outside the constraints ends a rule's path, and the chart includes it. TLC checks the rules in a state outside the constraints, but it does not explore past it.
1 step that the constraints exclude ends a rule's path, and the chart includes it. TLC checks the rules after such a step, but it does not take the step.

## NotOdd breaks
The shortest path has 1 step:
0. 0
1. Inc: odd

## NotThree breaks
The shortest path has 1 step:
0. 0
1. Jump: odd

## NotFive breaks
The shortest path has 5 steps:
0. 0
1. Inc: odd
2. Inc: 2
3. Inc: odd
4. Inc: 4
5. Inc: odd

## Rules that hold
NoDeadlock
