---- MODULE CounterSteps ----
EXTENDS Naturals
VARIABLE x
Up == x < 2 /\ x' = x + 1
Back == x = 2 /\ x' = 1
====
