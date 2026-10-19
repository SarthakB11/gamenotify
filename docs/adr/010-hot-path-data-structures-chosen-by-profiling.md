# ADR-010: Hot-path data structures chosen by profiling

**Status:** Accepted · **Date:** 2026-10-18

## Context
The first benchmark showed 76 µs per event and 20k events/s, far off the budget. A CPU profile attributed **70%** of the time to the idempotency store. That store evicted by iterating a `Map` from its head. V8 keeps tombstones for deleted Map entries, so head-iteration after many deletions degraded to O(n) per call. Token buckets had the same pattern, and UUIDv7 called `getRandomValues` for every id.

## Decision
- The dedup store and the token buckets use a `RingBuffer` FIFO for O(1) eviction, alongside the `Map` for lookup.
- UUIDv7 draws entropy from a pooled 4 KB buffer.
- Default preferences share frozen sub-objects.
- `DeliveryRouter.deliver` returns `undefined` when every channel completes synchronously, so the common in-app path allocates no Promises.

## Consequences
Result: 5.4 µs per event, ≈128k events/s end to end (about 6× better). Budgets are enforced by `pnpm bench` in CI. Lesson recorded in `CLAUDE.md`.
