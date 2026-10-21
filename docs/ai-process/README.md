# How this was built with AI

This folder records how AI was used to go from a project brief to a working, verified system: the prompts used and the process followed.

| File | What it contains |
|---|---|
| [process.md](./process.md) | The workflow, step by step: requirements → clarification → research → design → core-first build with tests written alongside → verification, with the corrections AI output needed |
| [prompts.md](./prompts.md) | The actual prompts used (verbatim where unedited, otherwise marked as condensed) and reusable prompt patterns |
| [research.md](./research.md) | What was researched, what was learned, and how it changed the design (with sources) |

**Tools:**

- **Claude (Anthropic) in Cowork mode** did:
  - The requirements extraction from the project brief (a PDF spec)
  - The research and clarifying questions
  - The HLD and LLD
  - The implementation and tests
  - Profiling, Docker and browser verification
- **Claude Code** (claude.ai/code) did the final repository push and polish.
- **Claude Code** also ran an independent review and hardening session (session 4): an Opus orchestrator with parallel read-only reviewers, and Sonnet workers that fixed each finding behind a regression test.
