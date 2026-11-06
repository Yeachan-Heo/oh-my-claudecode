---- MODULE CounterTie ----
EXTENDS Naturals
VARIABLE x
Init == x = 0
Inc == x' = x + 1
Bump == x = 0 /\ x' = 3
Next == Inc \/ Bump
Spec == Init /\ [][Next]_x
Small == x < 5
NoBump == ~(x = 0 /\ x' = 3)
NotThree == x # 3
NotFive == x # 5
NotOdd == x % 2 = 0
====
