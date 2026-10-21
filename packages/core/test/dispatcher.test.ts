import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EventId, type PlatformEvent, PlayerId } from '../src/index.ts';
import { makeCore } from './helpers.ts';

describe('NotificationDispatcher end-to-end (in-process)', () => {
  it('suppresses duplicate deliveries of the same event (idempotency)', async () => {
    const { core, sender, suppressed } = makeCore();
    const event: PlatformEvent = {
      kind: 'game.player_leveled_up',
      eventId: EventId('dup-1'),
      occurredAt: 0,
      playerId: PlayerId(1),
      newLevel: 9,
    };
    core.bus.publish(event);
    core.bus.publish(event);
    await core.settle();
    expect(sender.sent).toHaveLength(1);
    expect(suppressed).toEqual([{ recipientId: 1, type: 'LEVEL_UP', reason: 'DUPLICATE' }]);
  });

  it('rarity gate and self-actions are reported as suppressed', async () => {
    const { core, sender, suppressed } = makeCore();
    core.gameEngine.itemAcquired(2, 'RustyDagger');
    core.socialSystem.playerFollowed(4, 4);
    await core.settle();
    expect(sender.sent).toHaveLength(0);
    expect(suppressed.map((s) => s.reason)).toEqual(['BELOW_RARITY_THRESHOLD', 'SELF_ACTION']);
  });

  it('muted notifications are stored silently, not pushed', async () => {
    const { core, sender } = makeCore();
    core.preferences.patch(PlayerId(1), { muteForMinutes: 30 });
    core.gameEngine.playerLeveledUp(1, 20);
    await core.settle();
    expect(sender.sent).toHaveLength(0);
    const [e] = core.inboxService.page(PlayerId(1), null, 10).entries;
    expect(e?.mode).toBe('SILENT');
    expect(e?.notification.message).toBe("Congratulations! You've reached level 20!");
  });

  it('groups a follower burst: first immediately, the rest as one digest', async () => {
    const { core, sender, scheduler } = makeCore({ grouping: { windowMs: 1_000, maxWindowMs: 5_000 } });
    for (const f of [2, 3, 4, 5, 6]) core.socialSystem.playerFollowed(f, 1);
    await core.settle();
    expect(sender.messages()).toEqual(["Player 'Bram' started following you."]);
    scheduler.advance(1_000);
    await core.settle();
    expect(sender.messages()).toEqual([
      "Player 'Bram' started following you.",
      "Player 'Kael' and 3 others started following you.",
    ]);
    expect(sender.sent[1]?.notification.groupCount).toBe(4);
  });

  it('PvP defeat notifies both players', async () => {
    const { core, sender } = makeCore();
    core.gameEngine.playerDefeated(5, 4);
    await core.settle();
    expect(sender.sent.map((e) => [e.notification.recipientId, e.notification.message])).toEqual([
      [4, "You were defeated by Player 'Zed'."],
      [5, "You defeated Player 'Mira'!"],
    ]);
  });

  it('rate limit downgrades the excess to SILENT; nothing is lost', async () => {
    const { core, sender } = makeCore({ rateLimit: { capacity: 2, windowMs: 60_000 } });
    for (let lvl = 2; lvl <= 6; lvl++) core.gameEngine.playerLeveledUp(1, lvl);
    await core.settle();
    expect(sender.sent).toHaveLength(2);
    expect(core.inboxService.page(PlayerId(1), null, 10).entries).toHaveLength(5);
  });

  it('held follower events do not consume rate-limit tokens: a friend request still goes out live', async () => {
    const { core, sender, clock, scheduler } = makeCore();
    for (let i = 0; i < 25; i++) {
      core.socialSystem.playerFollowed(2 + (i % 5), 1);
      clock.advance(100);
    }
    core.socialSystem.friendRequestSent(3, 1);
    await core.settle();
    expect(sender.messages()).toEqual(["Player 'Bram' started following you.", "Player 'Kael' has sent you a friend request."]);
    scheduler.advance(10_000);
    await core.settle();
    expect(core.inboxService.page(PlayerId(1), null, 10).entries.map((e) => e.mode)).toEqual(['LIVE', 'LIVE', 'LIVE']);
    expect(sender.sent).toHaveLength(3);
  });

  it('graceful shutdown flushes open groups', async () => {
    const { core, sender } = makeCore();
    core.socialSystem.playerFollowed(2, 1);
    core.socialSystem.playerFollowed(3, 1);
    await core.settle();
    await core.shutdown();
    expect(sender.messages()).toHaveLength(2);
  });

  it('a failing sender is retried then dead-lettered without blocking other players', async () => {
    const { core, sender } = makeCore();
    const original = sender.send.bind(sender);
    sender.send = (entry) => (entry.notification.recipientId === 1 ? 'FAILED' : original(entry));
    core.gameEngine.playerLeveledUp(1, 2);
    core.gameEngine.playerLeveledUp(2, 2);
    await core.settle();
    expect(core.dlq.size).toBe(1);
    expect(sender.sent.map((e) => e.notification.recipientId)).toEqual([2]);
  });

  it('records metrics for every stage', async () => {
    const { core, metrics } = makeCore();
    core.gameEngine.playerLeveledUp(1, 2);
    core.gameEngine.itemAcquired(1, 'RustyDagger');
    await core.settle();
    expect(metrics.count('events_received_total', { kind: 'game.player_leveled_up' })).toBe(1);
    expect(metrics.count('notifications_created_total', { mode: 'LIVE', type: 'LEVEL_UP' })).toBe(1);
    expect(metrics.count('notifications_suppressed_total', { reason: 'BELOW_RARITY_THRESHOLD', type: 'ITEM_ACQUIRED' })).toBe(1);
    expect(metrics.observations.get('dispatch_latency_seconds')?.length).toBe(2);
  });

  it('property: every player receives their notifications in strictly increasing seq order', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.integer({ min: 1, max: 6 }), fc.integer({ min: 1, max: 99 })), { maxLength: 80 }),
        async (evs) => {
          const { core, sender } = makeCore({ rateLimit: { capacity: 1_000 } });
          for (const [p, lvl] of evs) core.gameEngine.playerLeveledUp(p, lvl);
          await core.settle();
          const byPlayer = new Map<number, number[]>();
          for (const e of sender.sent) {
            const arr = byPlayer.get(e.notification.recipientId) ?? [];
            arr.push(e.seq);
            byPlayer.set(e.notification.recipientId, arr);
          }
          for (const seqs of byPlayer.values()) expect(seqs).toEqual(seqs.map((_, i) => i + 1));
          expect(sender.sent).toHaveLength(evs.length);
        },
      ),
      { numRuns: 50 },
    );
  });
});
