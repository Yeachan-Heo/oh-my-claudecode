---- MODULE SpacedNames ----
VARIABLES s, t
Init == s = "" /\ t = "z"
Go == s = "" /\ s' \in {"a", "a b"} /\ t' = IF s' = "a" THEN "z" ELSE "c"
Stop == s \in {"a", "a b"} /\ s' = "!" /\ t' = t
Next == Go \/ Stop
Spec == Init /\ [][Next]_<<s, t>>
Going == s # "!"
====
