# How this was built with AI

The challenge asks to see *"the prompts you used and the process you followed to go from requirements to a working solution."* This folder is that record.

| File | What it contains |
|---|---|
| [process.md](./process.md) | The workflow, step by step: requirements → clarification → research → design → test-first build → verification, with the corrections AI output needed |
| [prompts.md](./prompts.md) | The actual prompts used (verbatim where possible) and reusable prompt patterns |
| [research.md](./research.md) | What was researched, what was learned, and how it changed the design (with sources) |

**Tools:**

- **Claude (Anthropic) in Cowork mode** did:
  - The requirements extraction from the emailed PDF
  - The research and clarifying questions
  - The HLD and LLD
  - The implementation and tests
  - Profiling, Docker and browser verification
- **Claude Code** (claude.ai/code) did the final repository push and polish.
