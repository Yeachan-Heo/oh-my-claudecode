---- MODULE Counter ----
EXTENDS Naturals
VARIABLE x
vars == <<x>>
Init == x = 0
Inc == x < 3 /\ x' = x + 1
Spec == Init /\ [][Inc]_vars
Low == x \in 0..1
StaysSmall == [](x <= 3)
====
