# TwoPhase

TLC reached 76 states and 192 steps. The chart draws 10 states and 16 arrows.
The chart does not draw 59 steps that stay in one chart state.
The step RMPrepare changes only one of r1 and r2 at a time.
The step RMChooseToAbort changes only one of r1 and r2 at a time.
The step RMRcvAbortMsg changes only one of r1 and r2 at a time.
The step RMRcvCommitMsg changes only one of r1 and r2 at a time.

## TCConsistent breaks
The shortest path has 5 steps:
0. Manager init, r1 working, r2 working
1. RMChooseToAbort: Manager init, r1 working, r2 aborted
2. RMPrepare: Manager init, r1 prepared, r2 aborted
3. TMRcvPrepared: Manager init, r1 prepared, r2 aborted
4. TMCommit: Manager done, r1 prepared, r2 aborted
5. RMRcvCommitMsg: Manager done, r1 committed, r2 aborted

## Rules that hold
TPTypeOK, NoDeadlock
