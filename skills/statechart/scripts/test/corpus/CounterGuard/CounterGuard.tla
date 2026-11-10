---- MODULE CounterGuard ----
EXTENDS Naturals
VARIABLE x

Init == x = 0
Next == x' = x + 1

Small == x < 2

TypeOK == x \in 0..1
Name == <<"zero", "one">>
Lookup == Name[x + 1] # "none"
====
