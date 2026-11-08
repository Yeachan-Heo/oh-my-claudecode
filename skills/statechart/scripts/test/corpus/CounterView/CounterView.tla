---- MODULE CounterView ----
EXTENDS Naturals
VARIABLE x
Init == x = 0
Inc == x' = x + 1
Jump == x = 0 /\ x' = 3
Next == Inc \/ Jump
Spec == Init /\ [][Next]_x
Small == x < 5
NoJump == ~(x = 0 /\ x' = 3)
NotThree == x # 3
NotFive == x # 5
NotOdd == x % 2 = 0
====
