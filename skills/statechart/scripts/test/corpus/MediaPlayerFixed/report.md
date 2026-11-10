# MediaPlayerFixed

TLC reached 11 states and 57 steps. The chart draws 7 states and 13 arrows.
The step a call comes in changes Playback and Volume at the same time.
The step you press stop changes Playback and Volume at the same time.
The step the track ends changes Playback and Volume at the same time.

## Rules that hold
TypeOK, LoudWhenStopped, NoDeadlock
