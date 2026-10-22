# Prompts

The prompts that drove the build. Prompts marked verbatim are unedited; the session 2 prompt is condensed. The AI's working prompts are summarised. The last section lists reusable patterns.

## 1. Kick-off (developer → Claude, Cowork)

Prompt (lightly edited):

> You have to build the project described in the brief. Do it as a complete professional following all software patterns and latest methods of optimization in speed and time.
>
> The brief is a PDF. Read it, understand it, research deeply about every aspect and the best methods/tools then ask me questions for closing gaps in product understanding.
>
> We have to build a high level design document and a low level design document.

**What the AI did with it:**

1. Extracted the PDF and read the text plus page renders.
2. Researched (see research.md), then asked round 1 of the questions.

## 2. Stack question → answer

> **Q:** Which language/stack should we build it in?
> **A:** (condensed) Look at a reference full-stack developer job posting and derive the stack from it.

The AI read the posting (TypeScript, React/Next.js, Node.js/Express, Python, PostgreSQL, AWS, Docker/K8s, GitHub Actions) and locked in TypeScript / Node 24 / Fastify / SSE / React.

## 3. Continue + package

Prompt (condensed):

> Ask me the questions, package everything in a zip for a follow-up Claude Code session, and give me the prompt for it. Continue from where you left off.

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
| **Orchestrator + workers** | "Review with parallel read-only agents; implement each fix with a worker that must show a failing test first." | Independent perspectives catch more; the orchestrator keeps judgement and reviews every diff |
| **Review loop** | Cold independent review → ranked fixes → parallel workers, each starting with a failing test → orchestrator reviews every diff → re-review | Sessions 4 and 5 (§8, §9) are this loop run twice; the second cold review checked the first round's fixes and found new defects |

## 6. Session 2: Claude Code (repository push)

The project archive from session 1 was attached to a Claude Code session (claude.ai/code) running against an empty repository. Prompt (condensed; environment details omitted):

````text
You're in an empty repository for a real-time notification system for a gaming platform. The attached
archive holds the complete, already-verified project (package.json, pnpm-lock.yaml, apps/, packages/,
docs/, scripts/, test/, CLAUDE.md, README.md).

GOAL: turn the archive into the repository's contents, re-verify it, and push a clean, reviewable
commit history. Do NOT change application behaviour, user-facing messages, tests or the golden file,
unless a check fails and a minimal fix is required. If that happens, explain each fix.

1. Unpack the archive into the repo root and remove the archive from the working tree.
   Read CLAUDE.md and follow it for the rest of the session.

2. Environment: Node.js >= 24 (22.18+ also works, with engine warnings) and pnpm 10.
   Install with `pnpm install --frozen-lockfile`.

3. Verify (all must pass before committing)
   - `pnpm verify`. Expect: Biome clean, typecheck clean, 134 tests passing, 8 architecture tests
     passing, build OK, "demo output matches golden file".
   - `pnpm demo`. Show me the first 12 lines: the brief's four example triggers and their messages.
   - Optional: `pnpm bench` (should print "performance budgets met").

4. Commit in logical steps using Conventional Commits (no node_modules/dist/coverage):
   a. docs: requirements, HLD, LLD, ADRs and AI-process record
   b. build: pnpm monorepo with TypeScript 7, Biome and Vitest
   c. feat(core): domain, ports, event bus, notification pipeline, adapters, simulators
   d. feat(server): Fastify SSE gateway, REST API, dev auth, metrics
   e. feat(demo): console walkthrough of the brief's triggers + golden test
   f. feat(web): React live-notifications client
   g. ci: GitHub Actions, Docker image, benchmark and SSE load scripts

5. Record this session (the process itself is part of the deliverable)
   - Append a section "## 6. Session 2: Claude Code (repository push)" to docs/ai-process/prompts.md
     with this prompt, plus 3-5 bullets on what you did, what you verified (with numbers) and any fixes.
   - Commit as `docs(ai-process): record Claude Code push session`.

6. Push. If this environment can only push to a feature branch, push the branch and open a PR.

7. CI: watch the GitHub Actions run (verify on Node 24 and 26, performance budgets, docker image).
   If a job fails for an environment reason, make the smallest fix, push, and re-check.
   Never loosen test assertions or performance budgets to make CI pass; ask me first.

8. Final reply: the commit list, CI status per job, the `pnpm demo` excerpt, any fixes and why, and
   the exact local run commands for a reviewer.

Do NOT add secrets or tokens to the repo, and do not rewrite the design docs beyond the ai-process note.
````

**What the AI did:**

- **Unpacked** the attached zip (137 files) into the empty repo. The archive was removed from the working tree in step 1, so it never entered a commit. No PDF or secrets were in the archive.
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
  - The latency badges are measured live, from the click in one browser to the toast in the other: **20 ms** and **14 ms** in the published take.
- **Kept the app unchanged.** The server sends `X-Frame-Options: DENY`, so only the recording harness strips that header to place the two clients in frames. Muted notifications are stored without being pushed, so the video shows Aria reopening the app to find the entry marked silent.
- **Fixed problems found by reviewing frames between takes:**
  - Captions moved to the top when they covered toasts.
  - Highlight rings were timed to finish within the 5 s toast lifetime.
  - The app was scaled up to fill the browser windows.
- **Made the video play inline on GitHub**, which does not play repository MP4s inline in a README:
  - The README shows an animated WebP (1152 px, 12 fps, 19.3 MB, a keyframe every second) that links to the 1080p H.264 MP4 (21.5 MB, 2 min 12 s).
  - Animated GIF was rejected because it came out at 45–90 MB.
  - A first WebP encode was rejected because its frame-diff artifacts built up into visible blocks.

## 8. Session 4: Claude Code (independent review and hardening)

Sessions 4 and 5 are one **review loop**: cold review, ranked fixes, parallel workers writing a failing test first, orchestrator reviewing each diff, then a fresh re-review.

Prompt, lightly edited (file name shortened):

> Rank our project based on the brief. You can use subagents. Implementations and fixes should be through Sonnet subagents. Take advice whenever stuck.

Follow-up prompt, condensed:

> Do these in order.

The follow-up referred to the ranked fix list below.

**Workflow (orchestrator and workers):**

- An Opus orchestrator read the brief and fanned out three read-only reviewers in parallel:
  1. A clean-clone run check, acting as a reviewer who follows the README literally, on Node 20 and on Node 24.
  2. A requirement-by-requirement traceability check against the code, not the docs.
  3. A staff-engineer review of architecture, tests, docs and this AI-process record.
- It merged the three reports into a scorecard and a ranked fix list.
- Every fix was implemented by a Sonnet worker with a regression test that failed before the fix and passed after. The orchestrator reviewed each diff. Independent workers ran in parallel in a separate git worktree when they touched disjoint files.
- The gate did not change: `pnpm verify` green, `pnpm bench` budgets met, assertions and budgets never loosened.

**What was found and fixed:**

- **Wrong Node version failed late and confusingly.** On Node 20, `pnpm install` only warned, then `pnpm build` and `pnpm test` crashed with a rolldown "Cannot find native binding" error. Fix: `.npmrc` sets `engine-strict=true`, so install now fails with "Expected version: >=24 / Got: v20.18.1", and the README points to `docker compose up --build`.
- **Rate limiting ran before grouping, so held burst events spent tokens.** 25 new followers within 10 s used all 20 SOCIAL tokens and the next friend request was stored SILENT. Fix: the stage order is now idempotency, preferences, grouping, rate limit. Only the leading-edge notification and the digest spend tokens.
- **Group digests skipped the preference check.** Disabling a category during the 10 s window still pushed the digest live. Fix: preferences are re-evaluated when the digest is emitted (disabled: not created, muted: SILENT).
- **Shutdown race.** An event POSTed after the core had drained got 202 and was dropped. Fix: ingest returns 503 with Retry-After once shutdown starts.
- **Docs overstated the scale path.** HLD §12 called Postgres/Redis "an adapter swap", but the storage ports and the dispatcher are synchronous and the grouping, rate-limit and sequence state lives in process memory. HLD §12 and §16 and LLD §7 now match the code.
- **Record and demo.** The AI-process record gained a "Decisions the developer made" section and the demo video was re-recorded (2 min 12 s).

**Verification:**

- `pnpm verify` green: 138 tests in 17 files, 8 architecture tests and the golden demo check.
- `pnpm bench`: "performance budgets met" (216k events/s through the bus, worst p99 17.2 µs, level-up 4.34 µs, suppressed 0.95 µs).
- `docker compose build` OK.

## 9. Session 5: Claude Code (second review and hardening)

Prompts, verbatim:

> rank the project again now

> yes fix them all and push

**Workflow:**

Same loop as session 4:

- A fresh cold reviewer graded the public repo with no access to earlier findings. A second agent cloned it, ran it end to end (Node 20 fail-fast, Node 24 verify, bench, SSE load, Docker) and checked every earlier fix with file:line evidence.
- Two Sonnet workers (server; core and web) fixed the findings in parallel git worktrees, cherry-picked onto main and verified.

**What was found and fixed:**

- **Session tokens leaked into logs.** The SSE query string was written to request logs. A log serializer now redacts it, and a test captures the logs.
- **Stale `read:false` on reconnect.** After read-all, replay sent frames cached with the old read flag. The cache is now keyed on read state.
- **Wrong PvP digest wording.** "Player 'Kael' attacked you 3 more times!" appeared when Kael was not the first attacker. "More" is now used only when the same attacker also triggered the leading notification.
- **Unsafe Docker defaults.** The image ran in development mode with an anonymous simulate endpoint and a public default internal key. It now defaults to production and refuses dev secrets, and docker compose opts into development for the local demo.
- **Timing-unsafe key check.** The internal key was compared with `!==`. It is now compared in constant time.
- **Dev simulate hid bus rejection.** It returned 202 when the bus rejected the event. It now returns 503.
- **Unbounded inbox logs.** Ingestion accepted any player id. Unknown players now get 422.
- **Inbox memory.** Rings grow on demand instead of preallocating 200 slots.
- **Banned constructor parameter property** in the web client removed.

**Verification:**

- `pnpm verify` green: 148 tests in 17 files, 8 architecture tests and the golden demo check.
- `pnpm bench`: "performance budgets met" (208k events/s through the bus, worst p99 18.8 µs).

**Follow-up prompt, verbatim:**

> fix three minor items too

Two Sonnet workers again ran in parallel worktrees. What was fixed:

- The long-lived session token no longer travels in the SSE URL: the client exchanges it (Bearer header) for a 30-second single-use stream ticket (`POST /v1/stream/ticket`), and reconnects fetch a fresh ticket and resume with `lastEventId`, so replay stays gapless. `?token=` on the stream is rejected.
- Idempotency no longer loses events: the key is released if dispatch throws before the inbox write, so a producer retry is delivered exactly once and the other recipients of a PvP fan-out still run.
- `InboxEntry` is immutable. Delivered and read state changes go through the inbox repository port.

**Verification:**

- `pnpm verify` green: 163 tests in 17 files, 8 architecture tests and the golden demo.
- `pnpm bench`: budgets met (210k events/s, worst p99 19.4 µs).

## 10. Session 6: Claude Code (third review: grader experience)

Prompts, verbatim:

> rank the project again with clear step to improve

> start with A. in order

**Workflow and findings:**

- A fresh cold reviewer and a clean-clone run produced a ranked plan focused on grader experience. Two Sonnet workers fixed it in parallel git worktrees (code; docs), and the orchestrator reviewed each diff.
- **Found and fixed in the code:**
  - Grouping digests double-counted the leading actor ("Player 'Kael' and 1 other" when Bram had already been shown), and a repeat follower produced a second "New Followers" digest. Both fixed, with a fast-check property.
  - A failed leading-edge event left its grouping window open. The window is now cancelled on failure.
  - The web client replaced the inbox on `hello`, so live frames could vanish, and it toasted replayed frames. It now merges on hello, replaces on resync, and suppresses toasts for the replay burst.
  - Dev tokens with extra segments were accepted. Exactly two segments are now required.
- **Grader experience:** README gained a "Start here" section (the core path in 6 files) and a "Core vs extras" table, one dated benchmark set, the memory target stated as missed, a BuildKit note and a sample `POST /v1/events`. The developer's own overrides of the AI were recovered from the original session transcripts and recorded in process.md ("Where the developer overrode or constrained the AI").

**Verification:**

- `pnpm verify` green: 173 tests in 17 files, 8 architecture tests and the golden demo.
- `pnpm bench`: budgets met (188k events/s through the bus, worst p99 21.1 µs).

## 11. Session 7: Claude Code (fourth review)

Prompts, verbatim:

> rank the project again

> yes do all steps

**Workflow and findings:**

- A fresh cold reviewer found no correctness bugs on the core path (8.3/10), and a clean-clone run found one intermittent failure. Two Sonnet workers fixed the findings in parallel git worktrees.
- **Found and fixed:**
  - A property test sized its idempotency store at 1e6 keys, which allocated a 2^20-slot ring on every run. Under parallel load it hit vitest's 5 s timeout and failed 1 of 8 fresh runs. It is now sized to its input bound and takes about 11 ms, with 200/200 runs and 10 consecutive full suites green.
  - A throw while emitting a timer-driven digest could crash the process. It is now contained, logged and counted.
  - One player could exhaust the global stream-ticket store. There is now a per-player cap of 5; the oldest ticket is evicted, so reconnect still works.
  - The SSE sender reported DELIVERED for frames that were only buffered. It now reports DELIVERED only when the frame was written to a socket, and otherwise leaves it for replay.
- **Docs:** ticket-based reconnect is described accurately (no "automatic reconnect for free"), the README has a full API table and concrete buildx and production `docker run` commands, bench numbers are labelled as quiet-machine with a loaded-machine figure, and line counts were re-measured.
- **A mistake worth recording:** the orchestrator's instruction to the docs worker wrongly claimed the dev simulate route needs a session token. The worker flagged the mismatch with the code, and the docs were corrected to match the code.

**Verification:**

- `pnpm verify` green three times in a row: 178 tests, 8 architecture tests and the golden demo.
- `pnpm bench`: budgets met (~198k events/s through the bus, worst p99 13.8 µs).

## 12. Session 8: Claude Code (fifth review, final polish)

Prompts, verbatim:

> rank the project again

> yes

> rank the project again after this is done

**Workflow and findings:**

- A cold review scored 8.3/10 with no correctness bugs on the core path, and its verdict was that the remaining items were marginal.
- The clean-clone run found a second intermittent failure: the console demo waited out the real ~300 ms grouping window with wall-clock sleeps, so under load the digest printed after the window line (1 of 5 cold verify runs). The demo now drives the real pipeline on virtual time, and the golden output is byte-identical. 30/30 golden checks and 30/30 golden tests passed, including runs under concurrent load, and 3 cold verify runs were green.
- `PATCH /v1/preferences` accepts `application/merge-patch+json` as documented.
- `TYPE_META.groupable` was removed, so grouping has one source of truth, the resolvers' `groupKey`.
- Per-call dispatch state moved from instance fields to locals.
- HLD goals G2 (extensibility) and G3 (no lost notifications) were reworded to match the code.
- Coverage is stated precisely: core 99.6% lines, server 96.3%, combined 98.4%.
- The README gained a Node 25+ pnpm note.

**Verification:**

- `pnpm bench`: budgets met (~194k events/s, worst p99 22 µs).

## 13. Session 9: Claude Code (final fixes)

Prompts, verbatim:

> yes fix them all and push

**Workflow and findings:**

- The sixth cold review scored 8.4/10 and said to ship as is. An 8-run cold verify (3 of them under heavy load) found no flakiness. The remaining findings were fixed anyway.
- The web UI looped on "Reconnecting…" after a server restart: the per-process `AUTH_SECRET` invalidated the session stored in `sessionStorage`, and the ticket call retried forever. A 401 now surfaces as a distinct `UnauthorizedError`, retrying stops, the stored session is cleared and the player picker returns with "Session expired — pick a player again". Verified in a real browser (Playwright): without a fixed secret the picker came back 0.8 s after the restart, picking a player again reached "Live", and a Kael → Aria friend request showed a toast; with a fixed `AUTH_SECRET` a restart reconnected to "Live" without logging out.
- A digest stayed SILENT if a mute ended inside the grouping window, because the first silent held event latched the mode. The digest mode is now decided at emission from the preferences in force (disabled: not created, muted or quiet: SILENT, otherwise LIVE). New tests cover a mute that ends inside the window (LIVE) and one still active at emission (SILENT).
- `GET /v1/admin/dlq` honours `limit` (1 to 1000, default 100, validated), with a test, and the README and LLD API tables say so.
- Coverage figures were re-measured (core 99.6%, server 97.2%, combined 98.8%), the README dispatcher row now names `#store`, `#announce` and `#emitDigest`, and the line counts and test count (180) were refreshed.

**Verification:**

- `pnpm verify`: 3 of 3 cold runs green (`git clean -fdxq -e node_modules` before each), 180 tests, 15 to 16 s each.
- `pnpm bench`: budgets met (~155k events/s, worst p99 17 µs).

## 14. Session 10: Claude Code (pre-submit polish)

Prompts, verbatim:

> rank the project again

> yes

**Workflow and findings:**

- The seventh cold review scored 8.3/10 and said to ship after a short README and config pass. A parallel clean-clone run passed every check (6 of 6 cold verify runs, 2 under load; every README number, anchor and route reproduced; Docker compose and the production run behaved as documented).
- `GROUP_WINDOW_MS` above 60000 crashed boot with a raw `RangeError` from the grouping stage. The max window now follows the window when `GROUP_MAX_WINDOW_MS` is unset, and an explicit max below the window fails startup with a readable config error. Two config tests failed first.
- An unknown or missing event `kind` on `POST /v1/events` returned a 400 listing every `oneOf` branch's failures. A `preValidation` check against `ALL_EVENT_KINDS` now returns one clear message naming the accepted kinds; a known kind with a bad field still gets the field error. The test failed first.
- The README now says the production image serves the API only (no dev login for the bundled UI) and that compose uses a 5 s grouping window. The LLD scripts table and CI bullet were synced with `package.json` and `ci.yml`.
- The review's remaining items were kept as interview topics rather than code changes: a digest whose emit fails drops its held events, repeat attacks by the leading attacker in a mixed PvP burst are not counted, and the demo imports the core `testing` helpers for virtual time.

**Verification:**

- `pnpm verify`: green, 183 tests. Coverage re-measured: core 99.6%, server 97.3%, combined 98.8% (1,214 of 1,229 lines).
