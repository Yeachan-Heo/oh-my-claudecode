---- MODULE Grid ----
EXTENDS Naturals
VARIABLES x, y
vars == <<x, y>>
Init == x = 0 /\ y = 0
IncX == x' = x + 1 /\ UNCHANGED y
IncY == y' = y + 1 /\ UNCHANGED x
Spec == Init /\ [][IncX \/ IncY]_vars
====
