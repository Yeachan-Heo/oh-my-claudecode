---- MODULE CounterStart ----
EXTENDS Naturals

VARIABLES x

Init == x \in {0, 7}

Inc == x < 3 /\ x' = x + 1

Spec == Init /\ [][Inc]_x

Small == x < 3

TypeOK == x \in 0..3
====
