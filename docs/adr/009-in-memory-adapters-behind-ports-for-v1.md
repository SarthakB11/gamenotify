# ADR-009: In-memory adapters behind ports for v1

**Status:** Accepted · **Date:** 2026-10-18

## Context
The brief explicitly allows a "simple dictionary or map" and scopes out real delivery infrastructure.

## Decision
Preferences, inbox, dedup store, DLQ and reference data are in-memory adapters behind ports. Every structure is bounded (ring buffers, capped maps, TTLs).

## Consequences
+ Zero infrastructure to run it: `pnpm start` or `docker compose up`.
− Not durable across restarts (handled by the epoch/resync protocol) and single-node.
Evolution: Postgres inbox (partitioned by player, UUIDv7 primary keys already index-friendly), Redis presence, and a NATS JetStream or Redis Streams bus partitioned by recipient. See HLD §12.

**Update (2026-10-22):** retry and the DLQ were removed because no shipped channel can fail; reintroduce them with the first channel that can (email/push).
