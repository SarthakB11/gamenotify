# CLAUDE.md — working agreement for AI coding sessions

This file is loaded into every AI session on this repo. Read it before changing code.

## Project
Real-time notification system for a gaming platform (GameNotify).
The design lives in `docs/HLD.md` and `docs/LLD.md`, and decisions in `docs/adr/`. **The docs are the spec.** If code and docs disagree, fix one of them in the same change.

## Commands
- `pnpm install` once. `pnpm build` compiles everything (tsc project references, then the Vite bundle).
- `pnpm test` runs Vitest. `pnpm test:arch` runs the layering rules. `pnpm typecheck` checks sources, tests and scripts.
- `pnpm verify` is the full CI gate. Run it before declaring any task done.
- `pnpm demo` is the console demo. `pnpm test:golden` diffs it against `test/golden/demo.txt`, and `node scripts/check-golden.ts --update` regenerates the golden file after an intentional change.
- `pnpm bench` checks performance budgets. Run it after touching anything in `packages/core/src/application/**` or the in-memory adapters.

## Architecture rules (enforced by `packages/core/test/architecture.test.ts`)
- `packages/core` is hexagonal: `domain` ← `ports` ← `application` ← `infrastructure` / `simulation` ← `composition.ts`.
- The core has **zero npm dependencies** and no Node I/O modules. Time, IDs, timers, logging and metrics come in through ports (`Clock`, `IdGenerator`, `Scheduler`, `Logger`, `Metrics`).
- Apps import `@gamenotify/core` (or `@gamenotify/core/testing` in tests), never core internals by relative path.
- To add an event type: add the event to `domain/events.ts` and `ALL_EVENT_KINDS`, a row to `TYPE_META`, a template to `EN_CATALOG`, a resolver registered in `composition.ts`, and the matching `event(...)` entry in `apps/server/src/http/schemas.ts`, plus tests. The compiler flags the `Record`-typed tables (`TYPE_META`, `EN_CATALOG`) and `resolvers.assertComplete` fails at boot for a missing resolver, but the REST ingestion schema is not checked, so a missing entry only shows up as `POST /v1/events` rejecting the new kind.

## TypeScript conventions
- TS 7, `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, **`erasableSyntaxOnly`**:
  - No `enum` (use an `as const` object plus a union type).
  - No `namespace`.
  - No constructor parameter properties.
  - Use `#private` fields.
- ESM only, and relative imports end in `.ts`.
- Domain objects are immutable. Expected failures are returned as `Result` values. Exceptions are for bugs and I/O faults.
- Hot-path code (dispatcher, stages, inbox, bus) is synchronous and allocation-conscious:
  - **Never** iterate a `Map` from its head after many deletions (V8 tombstones made that O(n); see ADR-010).
  - Use `RingBuffer` for FIFO eviction.

## Testing conventions
- Use `FakeClock`, `ManualScheduler`, `seqIds()`, `RecordingSender` and `MemoryMetrics` from `@gamenotify/core/testing`. No real timers in core tests.
- Prefer property tests (fast-check) for invariants: ordering, conservation, idempotency, rate bounds.
- Exact user-facing strings are asserted. Changing a message is a product change, so update the tests and the golden file deliberately.

## Product rules (confirmed up front, see README "Assumptions")
- Rare+ items only.
- Friend-accepted notifies the requester.
- A PvP defeat notifies both players.
- "Disabled" means never created. "Muted / quiet / rate-limited" means stored as SILENT.
- Grouping is leading-edge plus a digest, for NEW_FOLLOWER and PVP_ATTACKED only.

## Definition of done
`pnpm verify` is green, docs are updated if behaviour changed, and there are no new lint warnings.
