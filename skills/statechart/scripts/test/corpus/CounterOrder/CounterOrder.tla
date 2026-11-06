---- MODULE CounterOrder ----
EXTENDS Naturals
VARIABLE x
Init == x = 0
A == x = 0 /\ x' = 1
B == x = 0 /\ x' = 9
Next == B \/ A
Spec == Init /\ [][Next]_x
Small == x < 5
Even == x % 2 = 0
====
