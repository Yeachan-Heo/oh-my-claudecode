---- MODULE CounterRules ----
EXTENDS Naturals

VARIABLE x

M == INSTANCE Moves

Init == x = 0

Step == x' = x + 1
Jump == M!Jump(x, x')

Next == Step \/ Jump

Spec == Init /\ [][Next]_x

Small == x < 2

NotTwo == x # 2

NotThree == x # 3

AtMostTwo == x <= 2
====
