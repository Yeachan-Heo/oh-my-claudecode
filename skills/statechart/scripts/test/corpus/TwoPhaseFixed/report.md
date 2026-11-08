# TwoPhaseFixed

TLC reached 56 states and 142 steps. The chart draws 10 states and 12 arrows.
The chart does not draw 45 steps that stay in one chart state.
The step RMPrepare changes only one of r1 and r2 at a time.
The step RMChooseToAbort changes only one of r1 and r2 at a time.
The step RMRcvAbortMsg changes only one of r1 and r2 at a time.
The step RMRcvCommitMsg changes only one of r1 and r2 at a time.

## Rules that hold
TPTypeOK, TCConsistent, NoDeadlock
