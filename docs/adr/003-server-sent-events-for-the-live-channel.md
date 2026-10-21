# ADR-003: Server-Sent Events for the live channel

**Status:** Accepted · **Date:** 2026-10-18

## Context
In-app notifications flow server → client only. Client actions (read receipts, preferences) are ordinary request/response.

## Decision
Use **SSE**, implemented by hand on Fastify (`reply.hijack()`), with `id: <epoch>-<seq>` on every frame. Reads and writes from the client go over REST.

## Consequences
+ The browser's `EventSource` reconnects on its own and sends `Last-Event-ID`, which gives exact replay with no client protocol work.
+ Plain HTTP: works through proxies and load balancers, multiplexes over HTTP/2, easy to curl.
− No client → server messages on the same socket (not needed). `EventSource` cannot set headers, so the browser exchanges its Bearer token for a 30 s single-use ticket (`POST /v1/stream/ticket`) and opens `/v1/stream?ticket=`. A ticket cannot be replayed, so the client reconnects itself with a fresh ticket and `?lastEventId=`.
Alternatives: WebSocket (`ws` or uWebSockets.js) when bidirectional traffic is needed. It slots in behind the same `NotificationSender` port and connection registry. Socket.IO is heavier (~20 KB client, sticky sessions).
