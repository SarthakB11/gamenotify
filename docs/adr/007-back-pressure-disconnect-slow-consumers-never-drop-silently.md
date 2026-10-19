# ADR-007: Back-pressure: disconnect slow consumers, never drop silently

**Status:** Accepted · **Date:** 2026-10-18

## Context
A stalled client socket must not grow server memory without bound or block other players.

## Decision
Each connection honours `writableNeedDrain`/`'drain'` and queues up to `SSE_MAX_BUFFERED_FRAMES` (1,000). Beyond that it is closed (`sse_evictions_total{reason="slow_consumer"}`). The client reconnects and replays from the inbox. The bus rejects publishes when full (the API returns 503 + `Retry-After`). The rate limiter downgrades to SILENT rather than dropping.

## Consequences
+ Bounded memory everywhere (NFR-4). No silent loss.
− Reconnect cost for pathological clients.
