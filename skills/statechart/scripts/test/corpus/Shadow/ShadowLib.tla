---- MODULE ShadowLib ----
LOCAL Shadow == TRUE
LOCAL Shade == [](TRUE)
LOCAL I == INSTANCE ShadowSub WITH c <- Shadow
USE DEF Shadow, Shade
====
