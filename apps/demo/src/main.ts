/**
 * Console walkthrough of the brief's "Example Event Triggers" plus the extras.
 * Uses only @gamenotify/core (no HTTP): the console sender stands in for the game client.
 *
 *   pnpm demo          (after pnpm build)
 *   pnpm demo:dev      (runs the TypeScript sources directly)
 */
import {
  buildCore,
  ConsoleNotificationSender,
  EventId,
  InMemoryPlayerDirectory,
  type PlatformEvent,
  PlayerId,
  SEED,
} from '@gamenotify/core';

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const out = (line = '') => process.stdout.write(`${line}\n`);
const dim = (s: string) => (color ? `\u001b[2m${s}\u001b[0m` : s);
const bold = (s: string) => (color ? `\u001b[1m${s}\u001b[0m` : s);
const red = (s: string) => (color ? `\u001b[31m${s}\u001b[0m` : s);

const windowMs = Number(process.env.DEMO_GROUP_WINDOW_MS ?? 1500);
const directory = new InMemoryPlayerDirectory(SEED.players);
const core = buildCore(
  { sender: new ConsoleNotificationSender({ write: out, directory, color }), directory },
  { grouping: { windowMs, maxWindowMs: windowMs * 4 } },
);

let published = 0;
let delivered = 0;
let suppressed = 0;
let held = 0;
core.dispatcher.observe({
  onCreated: (e) => {
    if (e.mode === 'LIVE') delivered++;
  },
  onSuppressed: (s) => {
    if (s.reason === 'GROUPED') {
      held++;
      return;
    }
    suppressed++;
    const who = `#${s.recipientId} ${directory.get(s.recipientId)?.displayName ?? '?'}`.padEnd(9);
    out(`${red('✗')} ${bold(who)} ${dim(`suppressed: ${s.reason} (${s.type})`)}`);
  },
});

const section = (title: string) => out(`\n${bold(`-- ${title} --`)}`);
const call = (label: string, fn: () => unknown) => {
  out(dim(label));
  fn();
  published++;
};
const settle = () => core.settle();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const { gameEngine, socialSystem } = core;

out(bold('=== GameNotify Notification System — demo ==='));

section('Brief example triggers');
call('gameEngine.playerLeveledUp(1, 15)', () => gameEngine.playerLeveledUp(1, 15));
await settle();
call('gameEngine.itemAcquired(2, "SwordOfAzeroth")', () => gameEngine.itemAcquired(2, 'SwordOfAzeroth'));
await settle();
call('socialSystem.friendRequestSent(3, 1)', () => socialSystem.friendRequestSent(3, 1));
await settle();
call('socialSystem.friendRequestAccepted(1, 3)', () => socialSystem.friendRequestAccepted(1, 3));
await settle();

section('Preferences: Mira (#4) disables SOCIAL');
core.preferences.patch(PlayerId(4), { categories: { SOCIAL: false } });
call('socialSystem.friendRequestSent(5, 4)', () => socialSystem.friendRequestSent(5, 4));
await settle();

section('Rarity gate: only rare and above notify');
call('gameEngine.itemAcquired(2, "RustyDagger")', () => gameEngine.itemAcquired(2, 'RustyDagger'));
await settle();

section('Challenge + PvP');
call('gameEngine.challengeCompleted(6, "DragonsLair")', () => gameEngine.challengeCompleted(6, 'DragonsLair'));
await settle();
call('gameEngine.playerDefeated(5, 4)   // Zed defeats Mira → both notified', () => gameEngine.playerDefeated(5, 4));
await settle();

section(`Follower burst: 5 players follow Aria within ${windowMs} ms`);
for (const follower of [2, 3, 4, 5, 6]) {
  call(`socialSystem.playerFollowed(${follower}, 1)`, () => socialSystem.playerFollowed(follower, 1));
}
await settle();
out(dim(`   … grouping window (${windowMs} ms) …`));
await sleep(windowMs + 200);
await settle();

section('Re-publish the first event (same eventId) — at-least-once producers');
const replay: PlatformEvent = {
  kind: 'game.player_leveled_up',
  eventId: EventId('demo-replay-1'),
  occurredAt: Date.now(),
  playerId: PlayerId(1),
  newLevel: 16,
};
call('bus.publish(levelUp #1 → 16)', () => core.bus.publish(replay));
await settle();
call('bus.publish(same event again)', () => core.bus.publish(replay));
await settle();

section("Aria's inbox (newest first)");
const page = core.inboxService.page(PlayerId(1), null, 10);
for (const e of page.entries) out(`  ${String(e.seq).padStart(2)}  ${e.notification.message}`);
out(dim(`  unread: ${page.unread}`));

await core.shutdown();
out(`\n${bold('Summary:')} ${published} published · ${delivered} delivered · ${suppressed} suppressed · ${held} held → grouped`);
