---- MODULE DieHard ----
\* The classic jug puzzle from Die Hard 3: a 3-gallon jug, a 5-gallon jug,
\* and a fountain. Get exactly 4 gallons in the big jug.
EXTENDS Naturals

VARIABLES big, small
vars == <<big, small>>

Min(m, n) == IF m < n THEN m ELSE n

TypeOK == small \in 0..3 /\ big \in 0..5

Init == big = 0 /\ small = 0

FillSmall == small' = 3 /\ big' = big
FillBig == big' = 5 /\ small' = small
EmptySmall == small' = 0 /\ big' = big
EmptyBig == big' = 0 /\ small' = small

SmallToBig ==
  /\ big' = Min(big + small, 5)
  /\ small' = small - (big' - big)

BigToSmall ==
  /\ small' = Min(big + small, 3)
  /\ big' = big - (small' - small)

Next ==
  \/ FillSmall \/ FillBig
  \/ EmptySmall \/ EmptyBig
  \/ SmallToBig \/ BigToSmall

Spec == Init /\ [][Next]_vars

\* The puzzle's goal, written as a rule that should break: TLC's
\* counterexample is the solution.
NotSolved == big # 4
====
