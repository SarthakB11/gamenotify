# ADR-002: Hexagonal core with an in-process typed event bus

**Status:** Accepted · **Date:** 2026-10-18

## Context
The brief asks for "flexibility and maintainability as the system grows" and for a clear approach to hypothetical changes. Events come from several parts of the platform.

## Decision
`packages/core` is framework-free and dependency-free. Producers publish typed domain events to an `EventBus` port. The default implementation is `InProcessEventBus`, which is bounded, FIFO and batch-drained on `setImmediate`. The dispatcher subscribes and runs the pipeline. Adapters (SSE, console, memory stores) live outside the core.

## Consequences
+ Many "what-if" scenarios become "add an adapter": a Kafka/NATS bus, Postgres inbox, push channel or WebSocket gateway.
+ Fully deterministic tests through injected Clock, Scheduler and IdGenerator.
− A little indirection compared with calling the notifier directly.
Rejected: Node `EventEmitter`. It is synchronous (the producer pays the consumer's cost), untyped, has no back-pressure, and listener errors propagate into the producer. Also rejected: MediatR-style libraries, which add indirection and, in .NET's case, now carry commercial licences.
