---- MODULE MediaPlayerProps ----
EXTENDS MediaPlayer
EventuallyPlays == <>(playback = "Playing")
QuietWhenStopped == []LoudWhenStopped
StaysTyped == []TypeOK
====
