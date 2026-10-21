# Research log

| Topic | Finding | Design impact |
|---|---|---|
| **Riot Messaging Service** | Clients hold encrypted WebSockets to edge nodes. A router tier resolves recipients against a global session table and forwards only to edges holding them. Sessions turn "durable" on unexpected disconnect, so messages are cached in memory and delivered on reconnect. About 10M connections per edge in testing | Inbox + replay (`Last-Event-ID`), and the HLD v3 evolution (router/edge split, presence table) |
| **Discord gateway** | Streaming zstd plus delta "passive session" updates cut client bandwidth by about 40% | Recorded as the scale-path bandwidth strategy |
| **Xbox Real-Time Activity** | Subscription model over WebSocket, with caps per session and privacy checks | Per-player connection caps; privacy noted for future cross-player subscriptions |
| **Notification-system practice** | Check preferences before send. At-least-once delivery plus idempotency keys. Retries with backoff, then a DLQ. Per-channel queues. Centralised gateway dedup | Idempotency stage, retry/DLQ router, channel port |
| **Notification clustering** | Time-windowed clustering by source/target, extending the window on activity | Grouping stage (we chose leading edge plus a capped sliding window) |
| **SSE vs WebSocket vs Socket.IO** | SSE: native reconnect and Last-Event-ID, server→client only. `ws` is about 4× Socket.IO's throughput. uWS is fastest but has a different API and process-local pub/sub | SSE now (ADR-003). A WebSocket adapter is possible behind the same port |
| **Fastify vs Express (2026)** | Fastify is about 2–3× faster, with schema-compiled serialization and first-class TS | Fastify. A precompiled `fast-json-stringify` serializer for SSE frames |
| **TypeScript 7 (Aug 2026)** | Native Go compiler, 8–12× faster builds. No stable compiler API until 7.1, so typescript-eslint, dependency-cruiser and others are blocked | TS 7 plus Biome. Architecture rules as a test (ADR-008) |
| **Node.js releases** | Node 24 is Active LTS. Node 26 (May 2026) reaches LTS in late October 2026 | Runtime ≥ 24, CI matrix 24 and 26 |
| **MediatR / MassTransit** | Commercial since 2025 | Reinforced the hand-written, typed in-process bus |
| **V8 Map internals** (found by profiling) | Deleted entries leave tombstones, so head-iteration after many deletions degrades | Ring-buffer FIFO eviction (ADR-010) |

## Sources
- Riot Games: *Riot Messaging Service* (technology.riotgames.com/node/58)
- Discord: *How Discord Reduced WebSocket Traffic by 40%* (discord.com/blog)
- Microsoft Learn: *Xbox Live Real-Time Activity service overview*
- KodeKloud: *Notification System: Bottlenecks and the Real World*
- snarfed.org: *Clustering notifications*
- Milan Jovanović: *Server-Sent Events in ASP.NET Core and .NET 10*; *MediatR and MassTransit going commercial*
- pkgpulse: *Socket.IO vs ws vs uWebSockets.js (2026)*; *Express vs Fastify (2026)*
- InfoQ: *TypeScript 7 released* (Aug 2026)
- lilting.ch: *Node.js 26 Current* (LTS timing)

