---- MODULE CounterDeadlock ----
EXTENDS Naturals
VARIABLE x
Init == x = 0
Inc == x < 3 /\ x' = x + 1
Jump == x = 0 /\ x' = 3
Next == Inc \/ Jump
Spec == Init /\ [][Next]_x
NoJump == ~(x = 0 /\ x' = 3)
NotThree == x # 3
====
