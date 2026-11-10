# DieHard

TLC reached 16 states and 96 steps. The chart draws 16 states and 58 arrows.
The chart does not draw 38 steps that stay in one chart state.

## NotSolved breaks
The shortest path has 6 steps:
0. big=0 small=0
1. FillBig: big=5 small=0
2. BigToSmall: big=2 small=3
3. EmptySmall: big=2 small=0
4. BigToSmall: big=0 small=2
5. FillBig: big=5 small=2
6. BigToSmall: big=4 small=3

## Rules that hold
TypeOK, NoDeadlock
