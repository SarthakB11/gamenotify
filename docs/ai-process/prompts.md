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

## 6. Session 2: Claude Code (repository push)

The project zip from session 1 was attached to a Claude Code session (claude.ai/code) running against the empty GitHub repo. The prompt, verbatim (the attachment path is shortened):

````text
@gamenotify.zip You're in my public GitHub repo for GameNotify (a real-time notification
system for a gaming platform). The repo root contains `gamenotify.zip` (or I attached it to
this message). The zip holds the complete, already-verified project with files at the top level:
package.json, pnpm-lock.yaml, apps/, packages/, docs/, scripts/, test/, CLAUDE.md, README.md and so on.

GOAL: turn the zip into the repository's contents, re-verify it, and push a clean, reviewable commit
history to `main`. Do NOT change application behaviour, user-facing messages, tests or the golden file,
unless a check fails and a minimal fix is required. If that happens, explain each fix.

1. Unpack
   - Unzip `gamenotify.zip` into the repo root (overwrite nothing else; the repo is otherwise empty).
   - Remove the zip from the working tree (`git rm` it if it was committed).
   - Read CLAUDE.md and follow it for the rest of the session.

2. Environment
   - Need Node.js >= 24 (22.18+ also works, with engine warnings) and pnpm 10.
   - Run `corepack enable` (or `npm i -g pnpm@10.28.0`), then `pnpm install --frozen-lockfile`.

3. Verify (all must pass before committing)
   - `pnpm verify`. Expect:
     - Biome clean
     - typecheck clean
     - 134 tests passing
     - 8 architecture tests passing
     - build OK
     - "demo output matches golden file ✔"
   - `pnpm demo`. Show me the first 12 lines: the brief's four example triggers and their messages.
   - Optional: `pnpm bench` (should print "✔ performance budgets met").

4. Commit in logical steps (Conventional Commits; no node_modules/dist/coverage — .gitignore handles it):
   a. `docs: requirements, HLD, LLD, ADRs and AI-process record`     → docs/, README.md, CLAUDE.md
   b. `build: pnpm monorepo with TypeScript 7, Biome and Vitest`        → root configs, lockfile, .nvmrc, .env.example
   c. `feat(core): domain, ports, event bus, notification pipeline, adapters, simulators` → packages/core (src + tests)
   d. `feat(server): Fastify SSE gateway, REST API, dev auth, metrics`  → apps/server
   e. `feat(demo): console walkthrough of the brief's triggers + golden test` → apps/demo, test/golden, scripts/check-golden.ts
   f. `feat(web): React live-notifications client`                      → apps/web
   g. `ci: GitHub Actions, Docker image, benchmark and SSE load scripts` → .github/, Dockerfile, docker-compose.yml, .dockerignore, scripts/bench.ts, scripts/load-sse.ts
   h. `chore: remove upload archive` (only if the zip had been committed)

5. Record this session (the AI process is part of the deliverable)
   - Append a section "## 6. Session 2: Claude Code (repository push)" to docs/ai-process/prompts.md.
   - Paste this prompt verbatim in it, plus 3–5 bullets on what you did, what you verified (with numbers)
     and any fixes.
   - Also add one row to the tools list in docs/ai-process/README.md if needed.
   - Commit as `docs(ai-process): record Claude Code push session`.

6. Push to `main`. If this environment can only push to a feature branch, push the branch, open a PR
   into `main` titled "GameNotify: real-time notification system", and give me the link
   so I can merge it.

7. CI
   - Watch the GitHub Actions run (`gh run watch` or `gh run list`). Jobs:
     - verify on Node 24 and 26
     - performance budgets
     - docker image
   - If a job fails for an environment reason (runner differences, action versions), make the smallest
     fix, push, and re-check. Never loosen test assertions or performance budgets to make CI pass;
     ask me first.

8. Final reply to me:
   - the repo URL and the default-branch commit list
   - CI status per job
   - the `pnpm demo` excerpt
   - any fixes you made and why
   - the exact local run commands for the reviewer: `pnpm install && pnpm build && pnpm start` (open
     http://localhost:3000), `pnpm demo`, or `docker compose up --build`.

Do NOT:
- add secrets or tokens to the repo
- rewrite the design docs beyond the ai-process note above

````

**What the AI did:**

- **Unpacked** the attached zip (137 files) into the empty repo. The zip was never committed, so step h was not needed. No PDF or secrets were in the archive.
- **Verified before committing** on Node 22.22 with pnpm 10.28.0. Engine warnings were expected. `pnpm install --frozen-lockfile` resolved 139 packages. `pnpm verify` passed: Biome clean on 108 files, typecheck clean, **134/134 tests** in 17 files, **8/8 architecture tests**, build OK (web bundle 230 kB, 72 kB gzip) and "demo output matches golden file ✔".
- **Ran the extra CI steps locally**:
  - `pnpm test:coverage`: 97.2% statements, 90.2% branches, 98.6% lines.
  - `pnpm bench`: about 6.4 µs per dispatched event, 92.8k events/s end to end, worst p99 27.6 µs, "✔ performance budgets met".
  - `pnpm load:sse` with 2,000 connections at 1,000 events/s for 10 s: 9,850/9,850 delivered, p50 7 ms, p99 20 ms, 146 MB RSS.
- **Committed** in the seven Conventional Commit steps (a–g) above, with the developer as author. **No fixes were needed**: application code, messages, tests and the golden file are unchanged from the zip.

## 7. Session 3: Claude Code (demo video)

Prompt, verbatim:

> Record the complete working and make a professional demo video out of it full of animations and zoomed clickins and upload it inline into the readme in a playable format.

**What the AI did:**

- **Recorded the real system rather than a mock-up.** A Playwright script started the built server. It loaded two copies of the real React client (Aria and Kael) side by side on an HTML "stage". It drove the clients through the brief's triggers, cross-player delivery, grouping, PvP and preferences. Frames came from Chromium's screencast at about 28 fps.
- **Added the presentation layer only on the stage page:** intro and chapter cards, a scripted cursor with click ripples, camera zooms, captions, highlight rings and an outro.
  - The console scene types out the real `pnpm demo` output.
  - The latency badges are measured live, from the click in one browser to the toast in the other: **28 ms** and **26 ms** in the published take.
- **Kept the app unchanged.** The server sends `X-Frame-Options: DENY`, so only the recording harness strips that header to place the two clients in frames. Muted notifications are stored without being pushed, so the video shows Aria reopening the app to find the entry marked silent.
- **Fixed problems found by reviewing frames between takes:**
  - Captions moved to the top when they covered toasts.
  - Highlight rings were timed to finish within the 5 s toast lifetime.
  - The app was scaled up to fill the browser windows.
- **Made the video play inline on GitHub**, which does not play repository MP4s inline in a README:
  - The README shows an animated WebP (1152 px, 12 fps, 19.8 MB, a keyframe every second) that links to the 1080p H.264 MP4 (20.5 MB, 2 min 13 s).
  - Animated GIF was rejected because it came out at 45–90 MB.
  - A first WebP encode was rejected because its frame-diff artifacts built up into visible blocks.
