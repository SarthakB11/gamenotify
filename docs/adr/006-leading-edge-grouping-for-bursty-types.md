# ADR-006: Leading-edge grouping for bursty types

**Status:** Accepted · **Date:** 2026-10-18

## Context
A burst of followers or PvP hits would spam the player. Classic trailing-window batching delays every notification.

## Decision
For NEW_FOLLOWER and PVP_ATTACKED, the first event in a window is delivered immediately. Further events within a sliding 10 s window (capped at 60 s) are held and emitted once as a digest: *"Player 'Kael' and 3 others started following you."* or *"Player 'Zed' attacked you 3 more times!"*. Timers are re-armed lazily and `unref()`'d.

## Consequences
+ No added latency for the first notification. Bursts collapse to two messages.
+ Conservation (every event is counted exactly once) is checked by a property test.
− Two notifications rather than one for a burst (an accepted UX trade-off, confirmed with the product owner).
