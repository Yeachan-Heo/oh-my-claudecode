---- MODULE FirstRule ----
EXTENDS Naturals
VARIABLE x

Init == x = 0
Next == x < 3 /\ x' = x + 1

NotOne == x # 1
NotOneOrThree == x \notin {1, 3}
AlsoNotOne == x # 1
====
