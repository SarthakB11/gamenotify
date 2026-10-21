# ADR-004: Reject early, render late (intent-first pipeline)

**Status:** Accepted · **Date:** 2026-10-18

## Context
The brief describes: determine the type → create the Notification → check preferences → send. Creating the notification first wastes work on anything that is then suppressed.

## Decision
Resolvers produce a light `NotificationIntent`. The filter chain (idempotency → preferences → grouping → rate limit) runs on intents. Rate limiting sits after grouping so that events held for a digest do not spend tokens. Only survivors are rendered into an immutable `Notification`.

## Consequences
+ Measured (`pnpm bench`, 2026-10-21, Linux x64 (WSL2), i7-12650H, Node 24.22.1): a suppressed event costs 1.2 µs against 4.9 µs for the full path.
+ Each stage is a small, synchronous, single-purpose Chain-of-Responsibility link that is easy to unit-test.
− Two models (intent and notification) instead of one.
