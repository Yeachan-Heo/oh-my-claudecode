---- MODULE CounterInitPastHolds ----
EXTENDS Naturals
VARIABLE x
Init == x = 9
Inc == x' = x + 1
Next == Inc
Spec == Init /\ [][Next]_x
Small == x < 5
Pos == x >= 0
====
