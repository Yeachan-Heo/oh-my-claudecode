---- MODULE CounterJump ----
EXTENDS Naturals

VARIABLES x, jumps
vars == <<x, jumps>>

Init == x = 0 /\ jumps = 0

Step == x < 5 /\ x' = x + 1 /\ UNCHANGED jumps
Jump == x' = x + 3 /\ jumps' = jumps + 1

Next == Step \/ Jump

Spec == Init /\ [][Next]_vars

NoJumps == jumps = 0

NotThree == x # 3
====
