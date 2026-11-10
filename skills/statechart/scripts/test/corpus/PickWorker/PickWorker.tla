---- MODULE PickWorker ----
EXTENDS TLC
CONSTANTS Workers, First
VARIABLE picked
Init == picked = {}
Pick(w) == picked = {} /\ picked' = {w}
Next == \E w \in Workers : Pick(w)
Spec == Init /\ [][Next]_picked /\ WF_picked(Next)
Perms == Permutations(Workers)
PicksFirst == <>(First \in picked)
====
