import { describe, expect, it } from 'vitest';
import { noopLogger, noopMetrics, PlayerId, toInboxEntryDto } from '../src/index.ts';
import { makeCore } from './helpers.ts';

describe('InboxService', () => {
  it('pages, marks read and marks all read', async () => {
    const { core } = makeCore();
    for (let lvl = 2; lvl <= 6; lvl++) core.gameEngine.playerLeveledUp(1, lvl);
    await core.settle();
    const p1 = core.inboxService.page(PlayerId(1), null, 2);
    expect(p1).toMatchObject({ epoch: 'test', nextBefore: 4, unread: 5 });
    expect(p1.entries.map((e) => e.seq)).toEqual([5, 4]);
    const p3 = core.inboxService.page(PlayerId(1), 2, 2);
    expect(p3.nextBefore).toBeNull();

    expect(core.inboxService.markRead(PlayerId(1), p1.entries[0]!.notification.id)).toBe(true);
    expect(core.inboxService.unread(PlayerId(1))).toBe(4);
    expect(core.inboxService.markAllRead(PlayerId(1), 2)).toBe(2);
    expect(core.inboxService.markAllRead(PlayerId(1))).toBe(2);
    expect(core.inboxService.unread(PlayerId(1))).toBe(0);
  });

  it('maps entries to wire DTOs', async () => {
    const { core } = makeCore();
    core.gameEngine.playerLeveledUp(1, 3);
    await core.settle();
    const [e] = core.inboxService.page(PlayerId(1), null, 1).entries;
    expect(toInboxEntryDto(e!)).toMatchObject({
      seq: 1,
      silent: false,
      read: false,
      notification: { type: 'LEVEL_UP', recipientId: 1 },
    });
  });
});

describe('simulators', () => {
  it('cover the full brief API surface', async () => {
    const { core, sender } = makeCore();
    expect(core.gameEngine.challengeCompleted(6, 'DragonsLair')).toBe('accepted');
    core.gameEngine.playerAttacked(5, 6);
    core.socialSystem.playerFollowed(2, 3);
    await core.settle();
    expect(sender.messages()).toEqual([
      "Challenge complete! You've conquered 'Dragon's Lair'.",
      "You're under attack by Player 'Zed'!",
      "Player 'Bram' started following you.",
    ]);
    expect(() => core.gameEngine.playerLeveledUp(1, 0)).toThrow(RangeError);
    expect(() => core.socialSystem.friendRequestSent(0, 1)).toThrow(RangeError);
  });

  it('report back-pressure to the producer', () => {
    const { core } = makeCore({ bus: { capacity: 2 } });
    const results = [1, 2, 3].map((l) => core.gameEngine.playerLeveledUp(1, l));
    expect(results).toEqual(['accepted', 'accepted', 'rejected']);
  });
});

describe('dispatcher observers', () => {
  it('can be detached', async () => {
    const { core } = makeCore();
    const seen: number[] = [];
    const off = core.dispatcher.observe({ onCreated: (e) => seen.push(e.seq) });
    core.gameEngine.playerLeveledUp(1, 2);
    await core.settle();
    off();
    core.gameEngine.playerLeveledUp(1, 3);
    await core.settle();
    expect(seen).toEqual([1]);
  });

  it('no-op adapters are safe to call', () => {
    noopLogger.debug({});
    noopLogger.info({});
    noopLogger.warn({});
    noopLogger.error({});
    noopMetrics.inc('x');
    noopMetrics.observe('x', 1);
    noopMetrics.gauge('x', 1);
    expect(true).toBe(true);
  });
});
