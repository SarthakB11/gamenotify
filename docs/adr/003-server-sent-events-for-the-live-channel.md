# ADR-003: Server-Sent Events for the live channel

**Status:** Accepted · **Date:** 2026-10-18

## Context
In-app notifications flow server → client only. Client actions (read receipts, preferences) are ordinary request/response.

## Decision
Use **SSE**, implemented by hand on Fastify (`reply.hijack()`), with `id: <epoch>-<seq>` on every frame. Reads and writes from the client go over REST.

## Consequences
+ The browser's `EventSource` reconnects on its own and sends `Last-Event-ID`, which gives exact replay with no client protocol work.
+ Plain HTTP: works through proxies and load balancers, multiplexes over HTTP/2, easy to curl.
− No client → server messages on the same socket (not needed). `EventSource` cannot set headers, so the stream also accepts `?token=`. Production would use a cookie or a short-lived stream ticket.
Alternatives: WebSocket (`ws` or uWebSockets.js) when bidirectional traffic is needed. It slots in behind the same `NotificationSender` port and connection registry. Socket.IO is heavier (~20 KB client, sticky sessions).
