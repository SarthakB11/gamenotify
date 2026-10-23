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

  describe('idempotency is committed only when the notification was handled', () => {
    const levelUp: PlatformEvent = {
      kind: 'game.player_leveled_up',
      eventId: EventId('retry-1'),
      occurredAt: 0,
      playerId: PlayerId(1),
      newLevel: 9,
    };

    it('a retry after a mid-pipeline failure is delivered exactly once', async () => {
      const { core, sender, metrics } = makeCore();
      const inbox = core.inbox;
      const append = inbox.append.bind(inbox);
      let failures = 1;
      inbox.append = (...args) => {
        if (failures-- > 0) throw new Error('disk full');
        return append(...args);
      };
      core.bus.publish(levelUp);
      await core.settle();
      expect(sender.sent).toHaveLength(0);
      expect(metrics.count('dispatch_errors_total', { kind: levelUp.kind })).toBe(1);

      core.bus.publish(levelUp); // producer retry
      core.bus.publish(levelUp); // and a redelivery of the retry
      await core.settle();
      expect(sender.sent).toHaveLength(1);
      expect(core.inboxService.page(PlayerId(1), null, 10).entries).toHaveLength(1);
    });

    it('one recipient failing does not drop the other recipient of a PvP fan-out', async () => {
      const { core, sender } = makeCore();
      const inbox = core.inbox;
      const append = inbox.append.bind(inbox);
      let failures = 1;
      inbox.append = (n, m) => {
        if (failures-- > 0) throw new Error('boom');
        return append(n, m);
      };
      const defeat: PlatformEvent = {
        kind: 'game.pvp_defeated',
        eventId: EventId('pvp-1'),
        occurredAt: 0,
        winnerId: PlayerId(1),
        loserId: PlayerId(2),
      };
      core.bus.publish(defeat);
      await core.settle();
      expect(sender.sent).toHaveLength(1);
      core.bus.publish(defeat);
      await core.settle();
      expect(sender.sent).toHaveLength(2);
    });

    it('suppressed outcomes still dedupe retries', async () => {
      const { core, sender } = makeCore();
      core.preferences.patch(PlayerId(1), { muteForMinutes: 30 }); // stored SILENT
      core.bus.publish(levelUp);
      core.bus.publish(levelUp);
      await core.settle();
      expect(core.inboxService.page(PlayerId(1), null, 10).entries).toHaveLength(1);
      expect(sender.sent).toHaveLength(0);
    });

    it('property: any number of redeliveries of a set of events yields one notification per event', () => {
      fc.assert(
        fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 1, maxLength: 30 }), async (ids) => {
          const { core, sender } = makeCore({ rateLimit: { capacity: 1000 } });
          for (const id of ids) core.bus.publish({ ...levelUp, eventId: EventId(`e${id}`), newLevel: id });
          await core.settle();
          expect(sender.sent).toHaveLength(new Set(ids).size);
        }),
      );
    });
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

  it('a sender that carries the silent flag also receives muted notifications, marked SILENT', async () => {
    const { core, sender } = makeCore();
    sender.carriesSilent = true;
    core.gameEngine.playerLeveledUp(1, 19);
    await core.settle();
    core.preferences.patch(PlayerId(1), { muteForMinutes: 30 });
    core.gameEngine.playerLeveledUp(1, 20);
    await core.settle();
    expect(sender.sent.map((e) => [e.mode, e.notification.message])).toEqual([
      ['LIVE', "Congratulations! You've reached level 19!"],
      ['SILENT', "Congratulations! You've reached level 20!"],
    ]);
  });

  it('a silent digest is also delivered to a sender that carries the flag', async () => {
    const { core, sender, scheduler } = makeCore();
    sender.carriesSilent = true;
    for (const f of [2, 3, 4]) core.socialSystem.playerFollowed(f, 1);
    await core.settle();
    core.preferences.patch(PlayerId(1), { muteForMinutes: 30 });
    scheduler.advance(10_000);
    await core.settle();
    expect(sender.sent.map((e) => e.mode)).toEqual(['LIVE', 'SILENT']);
  });

  it('disabled categories are never delivered, even to a sender that carries the silent flag', async () => {
    const { core, sender } = makeCore();
    sender.carriesSilent = true;
    core.preferences.patch(PlayerId(1), { categories: { GAME: false } });
    core.gameEngine.playerLeveledUp(1, 20);
    await core.settle();
    expect(sender.sent).toHaveLength(0);
    expect(core.inboxService.page(PlayerId(1), null, 10).entries).toHaveLength(0);
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

  it('a digest that throws in the timer is contained: logged, counted, and later events still work', async () => {
    const { core, sender, scheduler, metrics } = makeCore({ grouping: { windowMs: 1_000, maxWindowMs: 5_000 } });
    const inbox = core.inbox;
    const append = inbox.append.bind(inbox);
    let failures = 0;
    for (const f of [2, 3, 4]) core.socialSystem.playerFollowed(f, 1);
    await core.settle();
    inbox.append = () => {
      failures++;
      throw new Error('disk full');
    };
    expect(() => scheduler.advance(1_000)).not.toThrow();
    await core.settle();
    expect(failures).toBe(1);
    expect(metrics.count('dispatch_errors_total', { kind: 'digest' })).toBe(1);
    expect(sender.messages()).toEqual(["Player 'Bram' started following you."]);

    inbox.append = append;
    core.gameEngine.playerLeveledUp(1, 20);
    await core.settle();
    expect(sender.messages()).toEqual(["Player 'Bram' started following you.", "Congratulations! You've reached level 20!"]);
  });

  it('a delivery that crashes inside the router is logged and does not break later events', async () => {
    const { core, metrics, logger, sender } = makeCore();
    const inc = metrics.inc.bind(metrics);
    let armed = true;
    metrics.inc = (name, labels, by) => {
      if (armed && name === 'notifications_delivered_total') {
        armed = false;
        throw new Error('metrics down');
      }
      inc(name, labels, by);
    };
    sender.send = (() => Promise.resolve('DELIVERED')) as unknown as typeof sender.send; // async channel: failure surfaces as a rejection
    core.gameEngine.playerLeveledUp(1, 20);
    await core.settle();
    expect(logger.lines.filter((l) => l.level === 'error')).toMatchObject([
      { fields: { err: { message: 'metrics down' } }, msg: 'delivery crashed' },
    ]);
    core.gameEngine.playerLeveledUp(1, 21);
    await core.settle();
    expect(core.inboxService.page(PlayerId(1), null, 10).entries).toHaveLength(2);
  });

  describe('digest never repeats the actor of the leading notification', () => {
    const burst = async (type: 'follow' | 'attack', actors: number[]) => {
      const { core, sender, scheduler } = makeCore({ grouping: { windowMs: 1_000, maxWindowMs: 5_000 } });
      for (const a of actors) {
        if (type === 'follow') core.socialSystem.playerFollowed(a, 1);
        else core.gameEngine.playerAttacked(a, 1);
      }
      await core.settle();
      scheduler.advance(1_000);
      await core.settle();
      return sender.messages();
    };

    it('the same follower three times yields one notification, no digest', async () => {
      expect(await burst('follow', [2, 2, 2])).toEqual(["Player 'Bram' started following you."]);
    });

    it('Bram, Kael, Bram: the digest names Kael alone', async () => {
      expect(await burst('follow', [2, 3, 2])).toEqual([
        "Player 'Bram' started following you.",
        "Player 'Kael' started following you.",
      ]);
    });

    it('Bram, Bram, Kael, Kael, Mira: the digest names the 2 distinct new followers', async () => {
      expect(await burst('follow', [2, 2, 3, 3, 4])).toEqual([
        "Player 'Bram' started following you.",
        "Player 'Kael' and 1 other started following you.",
      ]);
    });

    it('repeated attacks by the leading attacker say "more times"', async () => {
      expect(await burst('attack', [2, 2, 2])).toEqual([
        "You're under attack by Player 'Bram'!",
        "Player 'Bram' attacked you 2 more times!",
      ]);
    });

    it('Bram, Bram, Kael: the digest counts both held attacks and names both attackers', async () => {
      expect(await burst('attack', [2, 2, 3])).toEqual([
        "You're under attack by Player 'Bram'!",
        "You're under attack by Player 'Bram' and Player 'Kael'! (2 more attacks)",
      ]);
    });

    it('Bram, Kael, Kael: new attackers only, every held attack counted', async () => {
      expect(await burst('attack', [2, 3, 3])).toEqual([
        "You're under attack by Player 'Bram'!",
        "Player 'Kael' attacked you 2 times!",
      ]);
    });

    it('Bram, Kael, Mira, Mira: several new attackers, every held attack counted without "more"', async () => {
      expect(await burst('attack', [2, 3, 4, 4])).toEqual([
        "You're under attack by Player 'Bram'!",
        "You're under attack by Player 'Kael' and 1 other! (3 attacks)",
      ]);
    });

    it('property: a digest names the leading actor only when it repeated, and a follower digest never does', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('follow', 'attack'),
          fc.array(fc.integer({ min: 2, max: 6 }), { minLength: 2, maxLength: 12 }),
          async (type, actors) => {
            const messages = await burst(type, actors);
            const lead = /Player '(\w+)'/.exec(messages[0] ?? '')?.[1];
            expect(lead).toBeDefined();
            const digest = messages[1];
            if (digest === undefined) return;
            if (digest.includes(`'${lead}'`)) {
              expect(type).toBe('attack');
              expect(actors.slice(1)).toContain(actors[0]);
              if (new Set(actors).size === 1) expect(digest).toContain(' more ');
              else expect(digest).toMatch(/ \(\d+ more attacks?\)$/);
            } else if (type === 'attack') {
              expect(actors.slice(1)).not.toContain(actors[0]);
            }
          },
        ),
        { numRuns: 60 },
      );
    });
  });

  it('a failed leading-edge event does not hold the producer retry in a group', async () => {
    const { core, sender } = makeCore({ grouping: { windowMs: 10_000, maxWindowMs: 10_000 } });
    const inbox = core.inbox;
    const append = inbox.append.bind(inbox);
    let failures = 1;
    inbox.append = (...args) => {
      if (failures-- > 0) throw new Error('disk full');
      return append(...args);
    };
    core.socialSystem.playerFollowed(2, 1);
    await core.settle();
    expect(sender.sent).toHaveLength(0);
    core.socialSystem.playerFollowed(2, 1); // retry
    await core.settle();
    expect(sender.messages()).toEqual(["Player 'Bram' started following you."]);
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

  it('a digest respects preferences changed during the window: disabled category is never created', async () => {
    const { core, sender, scheduler, suppressed } = makeCore();
    for (const f of [2, 3, 4]) core.socialSystem.playerFollowed(f, 1);
    await core.settle();
    core.preferences.patch(PlayerId(1), { categories: { SOCIAL: false } });
    scheduler.advance(10_000);
    await core.settle();
    expect(sender.messages()).toEqual(["Player 'Bram' started following you."]);
    expect(core.inboxService.page(PlayerId(1), null, 10).entries).toHaveLength(1);
    expect(suppressed.map((s) => s.reason)).toContain('CATEGORY_DISABLED');
  });

  it('a digest respects a mute started during the window: stored SILENT, not pushed', async () => {
    const { core, sender, scheduler } = makeCore();
    for (const f of [2, 3, 4]) core.socialSystem.playerFollowed(f, 1);
    await core.settle();
    core.preferences.patch(PlayerId(1), { muteForMinutes: 30 });
    scheduler.advance(10_000);
    await core.settle();
    expect(sender.sent).toHaveLength(1);
    expect(core.inboxService.page(PlayerId(1), null, 10).entries.map((e) => e.mode)).toEqual(['SILENT', 'LIVE']);
  });

  it('a digest goes live when the mute ends inside the grouping window', async () => {
    const { core, sender, scheduler, clock } = makeCore();
    core.preferences.patch(PlayerId(1), { muteForMinutes: 0.05 }); // 3 s, ends inside the window
    for (const f of [2, 3, 4]) core.socialSystem.playerFollowed(f, 1);
    await core.settle();
    clock.advance(4_000); // mute is over; the window is still open
    core.socialSystem.playerFollowed(5, 1); // held while unmuted
    await core.settle();
    scheduler.advance(20_000);
    await core.settle();
    const entries = core.inboxService.page(PlayerId(1), null, 10).entries;
    expect(entries.map((e) => e.mode)).toEqual(['LIVE', 'SILENT']);
    expect(sender.sent).toHaveLength(1);
  });

  it('a digest stays SILENT when the mute is still active at emission', async () => {
    const { core, sender, scheduler } = makeCore();
    for (const f of [2, 3, 4]) core.socialSystem.playerFollowed(f, 1);
    await core.settle();
    core.preferences.patch(PlayerId(1), { muteForMinutes: 30 });
    scheduler.advance(10_000);
    await core.settle();
    expect(core.inboxService.page(PlayerId(1), null, 10).entries.map((e) => e.mode)).toEqual(['SILENT', 'LIVE']);
    expect(sender.sent).toHaveLength(1);
  });

  it('graceful shutdown flushes open groups', async () => {
    const { core, sender } = makeCore();
    core.socialSystem.playerFollowed(2, 1);
    core.socialSystem.playerFollowed(3, 1);
    await core.settle();
    await core.shutdown();
    expect(sender.messages()).toHaveLength(2);
  });

  it('a failing sender is counted and logged, keeps the entry in the inbox and does not block other players', async () => {
    const { core, sender, metrics, logger } = makeCore();
    const original = sender.send.bind(sender);
    sender.send = (entry) => (entry.notification.recipientId === 1 ? 'FAILED' : original(entry));
    core.gameEngine.playerLeveledUp(1, 2);
    core.gameEngine.playerLeveledUp(2, 2);
    await core.settle();
    expect(metrics.count('notifications_delivered_total', { channel: 'in_app', result: 'FAILED' })).toBe(1);
    expect(logger.lines.filter((l) => l.level === 'warn')).toMatchObject([{ fields: { playerId: 1, seq: 1 } }]);
    expect(core.inboxService.page(1 as never, null, 10).entries).toHaveLength(1);
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
