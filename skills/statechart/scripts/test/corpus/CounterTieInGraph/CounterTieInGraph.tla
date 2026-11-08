---- MODULE CounterTieInGraph ----
EXTENDS Naturals
VARIABLE x
Init == x = 0
Inc == x < 3 /\ x' = x + 1
Alpha == x = 0 /\ x' = 3
Down == x > 0 /\ x' = x - 1
Next == Inc \/ Alpha \/ Down
Spec == Init /\ [][Next]_x
NoDownFromTwo == ~(x = 2 /\ x' = 1)
OneOrThree == x # 1 /\ x # 3
====
