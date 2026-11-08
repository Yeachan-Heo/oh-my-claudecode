---- MODULE UserNoDeadlock ----
EXTENDS Naturals
VARIABLE x
Init == x = 0
Next == x < 3 /\ x' = x + 1
Spec == Init /\ [][Next]_x
NoDeadlock == x # 1
====
