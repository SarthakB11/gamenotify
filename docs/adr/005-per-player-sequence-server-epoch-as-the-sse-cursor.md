# ADR-005: Per-player sequence + server epoch as the SSE cursor

**Status:** Accepted · **Date:** 2026-10-18

## Context
Clients disconnect (network changes, sleep, deploys). Notifications must not be lost or duplicated.

## Decision
The inbox assigns a contiguous per-player `seq`. Frames carry `id: <epoch>-<seq>`, where `epoch` changes on every restart of the in-memory inbox. On reconnect:
- Same epoch and the cursor still retained → replay `seq > cursor`.
- Otherwise → an explicit `resync` event, and the client refetches the inbox page.

The connection is registered before replay, and live frames are buffered then de-duplicated by `seq`, so the handoff has no gap.

## Consequences
+ Exact, O(1) replay (contiguous seq means array arithmetic, not search).
+ Restarts and retention limits are handled explicitly rather than silently.
− Requires a resync path in the client (about 3 lines).
