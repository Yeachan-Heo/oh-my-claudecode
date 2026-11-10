---- MODULE TypeGuard ----
EXTENDS Naturals
VARIABLE x

Init == x = 0
Next == x < 2 /\ x' = x + 1

TypeOK == x \in 0..1
Name == <<"zero", "one">>
NeedsTypeOK == Name[x + 1] # "none"
====
