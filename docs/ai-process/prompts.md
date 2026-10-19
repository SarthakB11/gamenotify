# Prompts

The prompts that drove the build, verbatim where they came from the developer. The AI's working prompts are summarised. The last section lists reusable patterns.

## 1. Kick-off (developer → Claude, Cowork)

> You have to build this project brief. Do it as a complete professional following all software patterns and latest methods of optimization in speed and time.
>
> Get the brief, understand it, research deeply about every aspect and the best methods/tools then ask me questions for closing gaps in product understanding.
>
> We have to build a high level design document and a low level design document.

**What the AI did with it:**

1. Took the project brief (PDF) as input.
2. Extracted the PDF and read the text plus page renders.
3. Researched (see research.md), then asked round 1 of the questions.

## 2. Stack question → answer

> **Q:** Which language/stack should we build it in?
> **A:** "See the reference full-stack job posting and find what you have to."

The AI found the posting (TypeScript, React/Next.js, Node.js/Express, Python, PostgreSQL, AWS, Docker/K8s, GitHub Actions) and locked in TypeScript / Node 24 / Fastify / SSE / React.

## 3. Continue + package

> Ask the questions to me, pack everything in a zip because I will continue in Claude Code to push it to the repo. Also give me prompt to do that. Continue from where you left off.

The AI asked round 2 (rarity, PvP, muted behaviour, grouping), then built, verified and packaged the repo.

## 4. Working prompts the AI used internally (summarised)

- **Requirements:** "Extract every functional and non-functional requirement from the brief into ID'd tables; mark what is explicit, implied and missing."
- **Gaps:** "List every decision the brief leaves open that would change the code; for each, propose a recommended default and alternatives; ask as multiple choice."
- **Design review:** "Re-read the LLD as a hostile reviewer: what blocks the event loop, what is unbounded, what is not deterministic in tests, what violates the TS compiler settings we chose?" This caught the awaited-delivery stall and the parameter-property violations.
- **Implementation, per layer:** "Implement `<component>` exactly per LLD §x; keep it synchronous and allocation-conscious; inject Clock/Scheduler/IdGenerator; write the tests in the same step, including a property test for its invariant."
- **Profiling:** "Profile `dispatcher.handle` with `--cpu-prof`; list the top self-time frames; explain each in terms of V8 behaviour; fix only what the profile shows."
- **Browser check:** "Drive two real browser contexts as two players; assert a cross-player toast appears and measure latency; collect console errors."

## 5. Reusable prompt patterns

| Pattern | Prompt shape | Why it works |
|---|---|---|
| **Spec first** | "Write the HLD/LLD and stop. I'll review before any code." | Keeps design decisions human-owned and reviewable |
| **Ask, don't guess** | "Before building, list the product ambiguities as multiple-choice questions with a recommended option." | Converts hidden assumptions into explicit, documented decisions |
| **Constraint injection** | "Conventions: erasableSyntaxOnly, no npm deps in core, ports for time/ids…" (CLAUDE.md) | Every session produces code that fits the architecture |
| **Gate-driven loop** | "Done means `pnpm verify` is green." | The AI self-corrects against objective checks |
| **Hostile review** | "Review this as a staff engineer looking for unbounded memory, event-loop stalls and flaky tests." | Finds design bugs before they are coded |
| **Measure, then optimise** | "Profile first; optimise only the top frames; re-measure." | Avoids speculative optimisation and produced a 6× win |
