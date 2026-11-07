# MediaPlayer

TLC reached 12 states and 64 steps. The chart draws 7 states and 13 arrows.
The step a call comes in changes Playback and Volume at the same time.
The step the track ends changes Playback and Volume at the same time.
The step you press stop changes Playback and Volume at the same time.

## LoudWhenStopped breaks
The shortest path has 1 step:
0. Playback Stopped, Volume Normal volume
1. you turn it up: Playback Stopped, Volume Loud

## Rules that hold
TypeOK, NoDeadlock, EventuallyStops
