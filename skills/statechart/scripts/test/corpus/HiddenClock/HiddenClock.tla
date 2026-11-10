---- MODULE HiddenClock ----
EXTENDS Naturals
VARIABLES x, clock
vars == <<x, clock>>
Init == x = 0 /\ clock = 0
Tick == clock < 3 /\ clock' = clock + 1 /\ x' = IF clock = 2 THEN 0 ELSE 1
Next == Tick
Spec == Init /\ [][Next]_vars /\ WF_vars(Next)
OnlyX == x
EndsAtZero == <>[](x = 0)
====
