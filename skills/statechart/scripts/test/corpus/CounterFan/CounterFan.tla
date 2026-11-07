---- MODULE CounterFan ----
EXTENDS Naturals
VARIABLES x, done
Init == x = 0 /\ done = FALSE
Pick == ~done /\ x = 0 /\ x' \in 1..12 /\ UNCHANGED done
Finish == ~done /\ x > 0 /\ done' = TRUE /\ UNCHANGED x
Again == done /\ x' = 0 /\ done' = FALSE
Next == Pick \/ Finish \/ Again
Spec == Init /\ [][Next]_<<x, done>>
NotDone == ~done
====
