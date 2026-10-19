# ADR-001: TypeScript on Node.js 24 LTS

**Status:** Accepted · **Date:** 2026-10-18

## Context
The brief does not fix a language. Its example API (`gameEngine.playerLeveledUp(1, 15)`) uses camelCase, which suggests Java or TypeScript. GameNotify's published Full Stack Software Developer role lists TypeScript, React/Next.js, Node.js/Express, Python, PostgreSQL, AWS, Docker/Kubernetes and GitHub Actions.

## Decision
Build in **TypeScript 7** (native compiler, strict mode, `erasableSyntaxOnly`) on **Node.js 24 LTS**. CI also tests Node 26, which becomes LTS in late October 2026.

## Consequences
+ Matches a common TypeScript full-stack setup and the brief's API verbatim.
+ TS 7 builds roughly 10× faster. `erasableSyntaxOnly` means sources also run directly under Node's type stripping (`pnpm dev`, `pnpm demo:dev`).
− Single-threaded runtime: the design must keep the event loop free (batching, no sync I/O). CPU-parallel work would need worker threads.
− TS 7 has no stable compiler API until 7.1, so typescript-eslint and dependency-cruiser cannot run on it. We use **Biome** for linting and an in-repo **architecture test** for layering (ADR-008).
