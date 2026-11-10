---- MODULE CounterInstance ----
EXTENDS Naturals
VARIABLE x
vars == <<x>>
C == INSTANCE CounterSteps
Init == x = 0
Next == C!Up \/ C!Back
Spec == Init /\ [][Next]_vars /\ WF_vars(Next)
ReachesThree == <>(x = 3)
====
