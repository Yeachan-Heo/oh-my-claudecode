---- MODULE Shadow ----
EXTENDS Naturals, ShadowLib
CONSTANT Hold
VARIABLE x
vars == <<x>>
Init == x = 0
Next == x < 3 /\ x' = x + 1
Spec == Init /\ [][Next]_vars /\ WF_vars(Next)
Shadow == <>(x = 3)
Shade == x \in 0..1
====
