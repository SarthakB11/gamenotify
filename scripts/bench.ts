/**
 * Micro-benchmarks with budgets (NFR-1, NFR-2). Fails (exit 1) when a budget is breached.
 *   pnpm bench
 * Budgets are deliberately generous so shared CI runners don't flake; local numbers are far lower.
 */
import { buildCore, EventId, type NotificationSender, type PlatformEvent, PlayerId } from '@gamenotify/core';
import { bench, run, summary } from 'mitata';

const sink: NotificationSender = { name: 'sink', send: () => 'DELIVERED' };
const core = buildCore({ sender: sink }, { rateLimit: { capacity: 1e9 }, dedup: { maxKeys: 50_000 } });

let i = 0;
const levelUp = (): PlatformEvent => ({
  kind: 'game.player_leveled_up',
  eventId: EventId(`b${++i}`),
  occurredAt: 0,
  playerId: PlayerId((i % 10_000) + 1),
  newLevel: 2 + (i % 90),
});
const friend = (): PlatformEvent => ({
  kind: 'social.friend_request_sent',
  eventId: EventId(`f${++i}`),
  occurredAt: 0,
  senderId: PlayerId((i % 5) + 1),
  recipientId: PlayerId((i % 5) + 2),
});

summary(() => {
  bench('dispatcher.handle · level up (resolve → filters → render → inbox → send)', () => core.dispatcher.handle(levelUp()));
  bench('dispatcher.handle · friend request (name lookup)', () => core.dispatcher.handle(friend()));
  bench('dispatcher.handle · suppressed by category (render skipped)', function* () {
    core.preferences.patch(PlayerId(42), { categories: { GAME: false } });
    yield () =>
      core.dispatcher.handle({
        kind: 'game.player_leveled_up',
        eventId: EventId(`s${++i}`),
        occurredAt: 0,
        playerId: PlayerId(42),
        newLevel: 3,
      });
  });
});

const results = await run({ format: 'mitata', colors: !process.env.NO_COLOR });

// Throughput: publish N events through the bus and wait for the pipeline to drain.
const N = 200_000;
const t0 = performance.now();
for (let n = 0; n < N; n++) {
  if (core.bus.publish(levelUp()) === 'rejected') await core.bus.drain();
}
await core.settle();
const seconds = (performance.now() - t0) / 1000;
const throughput = Math.round(N / seconds);
console.log(`\nthroughput: ${throughput.toLocaleString()} events/s end-to-end through the bus (${N.toLocaleString()} events)`);

const p99 = Math.max(
  ...results.benchmarks.flatMap((b) => b.runs.map((r) => (r.stats?.p99 ?? 0) / 1e6)), // ns → ms
);
console.log(`worst p99 per event: ${(p99 * 1000).toFixed(1)} µs`);

const BUDGET_P99_MS = 1;
const BUDGET_THROUGHPUT = 50_000;
let ok = true;
if (p99 > BUDGET_P99_MS) {
  ok = false;
  console.error(`✗ p99 ${p99.toFixed(3)} ms exceeds budget ${BUDGET_P99_MS} ms`);
}
if (throughput < BUDGET_THROUGHPUT) {
  ok = false;
  console.error(`✗ throughput ${throughput} < budget ${BUDGET_THROUGHPUT}/s`);
}
console.log(ok ? '✔ performance budgets met' : '');
process.exit(ok ? 0 : 1);
