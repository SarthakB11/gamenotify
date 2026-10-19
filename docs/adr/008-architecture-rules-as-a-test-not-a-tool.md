# ADR-008: Architecture rules as a test, not a tool

**Status:** Accepted · **Date:** 2026-10-18

## Context
We wanted dependency-cruiser to enforce hexagonal layering, but it needs the TypeScript compiler API, which TS 7.0 does not expose yet.

## Decision
`packages/core/test/architecture.test.ts` statically scans imports and asserts the layer matrix, zero npm dependencies in the core, public-API-only imports from apps, and no cycles. A deliberate violation was introduced during development to prove the test fails.

## Consequences
+ No extra tooling. Runs in about 50 ms as part of `pnpm test`.
− Regex-based import extraction. It is guarded by a test that the scanned graph is non-trivial. Switch back to dependency-cruiser when TS 7.1 ships its API.
