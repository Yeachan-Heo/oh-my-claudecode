---- MODULE CounterLoop ----
EXTENDS Naturals
VARIABLE x
vars == <<x>>
Init == x = 0
Up == x < 2 /\ x' = x + 1
Back == x = 2 /\ x' = 1
Next == Up \/ Back
Spec == Init /\ [][Next]_vars /\ WF_vars(Next)
ReachesThree == <>(x = 3)
====
